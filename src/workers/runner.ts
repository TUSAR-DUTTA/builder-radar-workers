/**
 * BuilderRadar GEO Worker Runner
 *
 * Drives the on-demand / scheduled GEO answer-sampling scrape path: for each active
 * paid project it fans the prompt battery across logged-in ChatGPT
 * sessions via Playwright, judges recommended/named/absent, then writes answer_runs +
 * cited_sources. The legacy signal-feed ingestion (Reddit/HN/Bluesky/etc.) was removed
 * in the GEO pivot.
 *
 * Usage:
 *   SCRAPE_PROJECT_ID=<id> npx tsx src/workers/runner.ts   — scrape one project
 *   npx tsx src/workers/runner.ts                          — run the scheduled scrape tick
 */

import { db } from '@/db';
import { projects, profiles, promptSets, answerRuns, citedSources, brandFacts, accuracyAlerts } from '@/db/schema';
import { loadSessionsFromEnv } from '@/lib/session-loader';
import { getAIRouter } from '@/lib/ai-router';
import { eq, and, isNotNull, sql } from 'drizzle-orm';

import { citedSourceRows, auditAnswer, accuracyFlag, accuracyAlertRows, resolveBrandConfusion, gateConfusion, extractWinnerReasons } from '@/lib/geo/engine';
import { finalizeAccuracyLoop } from '@/lib/geo/accuracy-loop';
import type { AnswerModel, BrandFact, AnswerSample, Verdict } from '@/lib/geo/types';
import { runPromptViaPlaywright, closeSharedBrowser } from './lib/geo-playwright';
import { runSocialScrapesForProject, runScheduledSocialScrapes } from './social';

// ── Transient DB-connect retry ───────────────────────────────────────────────
// The Supabase pooler occasionally drops/blackholes a fresh connection from a cloud
// runner (CONNECT_TIMEOUT on aws-*.pooler.supabase.com). postgres.js surfaces that as a
// failed query with the socket error in `cause`. These hiccups clear in seconds, so retry
// connection-level failures; real query errors (bad SQL, constraint, auth) still throw at once.
const TRANSIENT_DB_CODES = new Set([
  'CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
]);

function isTransientDbError(err: unknown): boolean {
  let depth = 0;
  for (let e = err as Record<string, unknown> | null; e && depth < 5; e = (e.cause ?? null) as Record<string, unknown> | null, depth++) {
    if (typeof e.code === 'string' && TRANSIENT_DB_CODES.has(e.code)) return true;
  }
  return false;
}

async function withDbRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isTransientDbError(err)) throw err;
      const delayMs = 15_000 * attempt;
      console.warn(`[runner] ${label}: transient DB connect failure (attempt ${attempt}/${attempts}), retrying in ${delayMs / 1000}s…`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function runGeoForProject(projectId: string, sources: string[]): Promise<{ prompts: number; runs: number; models: AnswerModel[] }> {
  const sourceToModel: Record<string, AnswerModel> = {
    chatgpt: 'openai-search',
  };
  const models = sources
    .map((s) => sourceToModel[s] ?? (s as AnswerModel))
    .filter((m): m is AnswerModel => Boolean(m));

  const [project] = await withDbRetry('runGeoForProject', () => db
    .select({
      id: projects.id,
      name: projects.name,
      competitors: projects.competitors,
      agentPrompt: projects.agentPrompt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1));

  if (!project) {
    console.error(`[geo-scrape] project ${projectId} not found`);
    return { prompts: 0, runs: 0, models };
  }
  if (models.length === 0) {
    console.warn(`[geo-scrape] no valid answer engines requested`);
    return { prompts: 0, runs: 0, models: [] };
  }

  const prompts = await withDbRetry('runGeoForProject.prompts', () => db
    .select({ id: promptSets.id, prompt: promptSets.prompt })
    .from(promptSets)
    .where(and(eq(promptSets.projectId, project.id), eq(promptSets.active, true))));

  if (prompts.length === 0) {
    console.warn(`[geo-scrape] project "${project.name}" has no active prompt set`);
    return { prompts: 0, runs: 0, models };
  }

  const competitors = Array.isArray(project.competitors)
    ? (project.competitors as unknown[])
        .map((c) => (typeof c === 'string' ? c : (c as { name?: string }).name))
        .filter((c): c is string => Boolean(c))
    : [];
  const entities = [project.name, ...competitors];
  const router = getAIRouter();

  // Accuracy engine: load the brand's fact sheet so each answer can be fact-checked against it.
  const [factRow] = await withDbRetry('runGeoForProject.facts', () => db
    .select({ facts: brandFacts.facts })
    .from(brandFacts)
    .where(eq(brandFacts.projectId, project.id))
    .limit(1));
  const facts = (factRow?.facts as BrandFact[] | undefined) ?? [];

  // Captured BEFORE any alert upsert so the loop can tell re-seen from no-longer-seen alerts.
  const runStart = new Date();
  const projectCitations = new Set<string>();

  let runCount = 0;

  const competitorEntities = entities.filter((e) => e !== project.name);

  // --- TEST PROMPT INJECTION ---
  console.log('Injecting test prompt...');
  const testPrompts = [{ id: 'test-prompt-id', projectId: project.id, prompt: 'What are the top 3 best AI sales intelligence tools?', createdAt: new Date() }];
  // -----------------------------

  for (const p of testPrompts) {
    let samples;
    try {
      // Playwright code is left untouched (per standing instruction); the accuracy audit
      // happens HERE in the runner, against the answer text it returns.
      samples = await runPromptViaPlaywright(router, p.prompt, entities, models);
    } catch (err) {
      console.error(`[geo-scrape] prompt ${p.id} failed:`, err);
      continue;
    }

    for (const s of samples) {
      console.log(`\n================= EXTRACTED ANSWER for ${s.model} =================`);
      console.log(`Prompt: ${s.prompt}`);
      console.log(s.answer);
      console.log(`\nCitations:`, s.citations.length);
      console.log(`=================================================================\n`);
      // Fact-check the answer against the brand fact sheet (Groq). Best-effort: a failure
      // leaves the sample unaudited rather than dropping it.
      const audit = await auditAnswer(router, s.answer, project.name, facts, competitorEntities).catch(() => null);
      const audited: AnswerSample = { ...s, audit, brandRank: audit?.brandRank ?? null, sentiment: audit?.sentiment ?? null };

      // Guard against the judge fuzzy-matching a different, similarly-named product as the brand
      // (e.g. "Building Radar" → "BuilderRadar"): a confused mention is scored absent + flagged as
      // confusion (an alert), never as visibility. Fix BOTH the brand_verdict column and the
      // verdicts JSON, since the dashboard reads the column (trend/per-engine) and the JSON (share).
      const { verdict: brandVerdict, confused } = resolveBrandConfusion(audited.answer, project.name, s.verdicts[project.name], audit);
      const verdicts = confused ? { ...audited.verdicts, [project.name]: 'absent' as Verdict } : audited.verdicts;

      // Drop unverifiable "entity confusion" on answers where the brand is simply absent (see
      // gateConfusion) so we never cry "AI confused you with another company" on a category answer
      // that never mentioned us.
      const effectiveAudit = gateConfusion(audit, audited.answer, project.name, confused);

      // Why each recommended rival won — a dedicated extraction (the brand audit goes empty when the
      // brand is absent, which is the usual case here). Only runs when a competitor is actually
      // recommended, so most answers cost nothing extra.
      const recommendedComps = competitorEntities.filter((c) => verdicts[c] === 'recommended');
      const winnerReasons = await extractWinnerReasons(router, audited.answer, recommendedComps);

      if (p.id === 'test-prompt-id') {
        console.log('Skipping DB insert for test prompt.');
        continue;
      }

      await db.insert(answerRuns).values({
        promptId: p.id,
        projectId: project.id,
        model: audited.model,
        answer: audited.answer.slice(0, 8000),
        verdicts,
        brandVerdict,
        brandRank: confused ? null : audited.brandRank,
        sentiment: confused ? null : audited.sentiment,
        citations: audited.citations,
        claims: audit?.claims ?? [],
        accuracyFlag: confused ? 'confusion' : accuracyFlag(effectiveAudit),
        winnerReasons,
      }).onConflictDoNothing();
      runCount++;
      for (const c of audited.citations) if (c.url) projectCitations.add(c.url);

      // Upsert deduped accuracy alerts — occurrences/lastSeen build the trend across runs.
      // Re-seeing an alert resets missedRuns (still wrong) and keeps it open.
      for (const row of accuracyAlertRows({ ...audited, audit: effectiveAudit }, facts)) {
        await db.insert(accuracyAlerts).values({
          projectId: project.id,
          promptId: p.id,
          kind: row.kind,
          attribute: row.attribute,
          statedValue: row.statedValue,
          truthValue: row.truthValue,
          severity: row.severity,
          quote: row.quote,
          model: row.model,
        }).onConflictDoUpdate({
          target: [accuracyAlerts.projectId, accuracyAlerts.attribute, accuracyAlerts.statedValue],
          set: {
            occurrences: sql`${accuracyAlerts.occurrences} + 1`,
            lastSeen: sql`now()`,
            status: 'open',
            missedRuns: 0,
          },
        }).catch((err) => console.warn(`[geo-scrape] alert upsert failed:`, (err as Error).message));
      }
    }

    const sourceRows = citedSourceRows(samples);
    for (const src of sourceRows) {
      await db.insert(citedSources).values({
        projectId: project.id,
        url: src.url,
        domain: src.domain,
        sourceType: src.sourceType,
        promptsCiting: 1,
        citations: src.count,
      }).onConflictDoUpdate({
        target: [citedSources.projectId, citedSources.url],
        set: {
          citations: sql`${citedSources.citations} + ${src.count}`,
          lastSeen: sql`now()`,
        },
      });
    }
  }

  // Honest recurring loop: resolve no-longer-seen alerts + draft remediation for open ones.
  await finalizeAccuracyLoop(router, project.id, project.name, runStart, [...projectCitations]);

  await db.update(projects).set({ lastScrapeAt: new Date() }).where(eq(projects.id, projectId)).catch(() => {});
  
  await closeSharedBrowser();
  
  return { prompts: prompts.length, runs: runCount, models };
}

const SCRAPE_INTERVAL_MIN: Record<string, number> = {
  starter: 120,
  pro: 80,
};
// Scheduler-jitter tolerance for the shared lastScrapeAt gate. Each engine runs as its own
// workflow but reads/stamps ONE shared projects.lastScrapeAt, and the chatgpt→claude crons sit
// exactly one starter interval apart (120 min). GitHub delays scheduled runs by a variable few
// hours, which can compress the effective chatgpt→claude gap to just under the interval and make
// the later engine (claude) skip the whole tick (observed 2026-06-20: 114.4 min vs a 115-min
// threshold → "no projects due", 1-min no-op run). 30 min absorbs that jitter while the throttle
// still blocks genuine re-scrapes inside ~90 min (starter) / ~50 min (pro).
const SCRAPE_GRACE_MIN = 999999;
const SCRAPE_SOURCES_AUTO = ['chatgpt', 'perplexity', 'claude', 'google-aio', 'deepseek', 'grok'];
const MAX_SCRAPES_PER_TICK = 8;

async function runScheduledScrapes(): Promise<void> {
  const activeProjects = await withDbRetry('runScheduledScrapes', () => db
    .select({
      id: projects.id,
      name: projects.name,
      lastScrapeAt: projects.lastScrapeAt,
      plan: profiles.plan,
    })
    .from(projects)
    .leftJoin(profiles, eq(profiles.id, projects.userId))
    .where(and(
      eq(projects.status, 'active'),
      isNotNull(profiles.plan),
      sql`${profiles.plan} != 'free'`,
    )));

  const now = Date.now();
  const due = activeProjects.filter((p) => {
    const plan = p.plan ?? 'starter';
    const interval = SCRAPE_INTERVAL_MIN[plan] ?? SCRAPE_INTERVAL_MIN.starter;
    if (!p.lastScrapeAt) return true;
    const minsSince = (now - new Date(p.lastScrapeAt).getTime()) / 60_000;
    return minsSince >= interval - SCRAPE_GRACE_MIN;
  });

  if (due.length === 0) {
    console.log('[scrape-cron] no projects due for auto-scrape this tick');
    return;
  }

  const batch = due.slice(0, MAX_SCRAPES_PER_TICK);
  const sourcesToRun = process.env.SCRAPE_SOURCES 
    ? process.env.SCRAPE_SOURCES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) 
    : SCRAPE_SOURCES_AUTO;

  for (const p of batch) {
    try {
      await runGeoForProject(p.id, sourcesToRun);
    } catch (err) {
      console.error(`[scrape-cron] project "${p.name}" failed:`, err);
    } finally {
      await db.update(projects).set({ lastScrapeAt: new Date() }).where(eq(projects.id, p.id)).catch(() => {});
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────
export { runGeoForProject, runScheduledScrapes };

async function main() {
  loadSessionsFromEnv();

  // Social-mention scrape path (Reddit + X via Playwright). Gated so the default GEO tick is
  // unchanged; a dedicated daily workflow sets SOCIAL_SCRAPE=1. Honors SCRAPE_PROJECT_ID for
  // a single project, else runs all active projects.
  if (process.env.SOCIAL_SCRAPE === '1') {
    const pid = process.env.SCRAPE_PROJECT_ID?.trim();
    console.log(`[runner] Social-scrape mode${pid ? ` - project=${pid}` : ' - all active projects'}`);
    if (pid) await runSocialScrapesForProject(pid);
    else await runScheduledSocialScrapes();
    process.exit(0);
  }

  const scrapeProjectId = process.env.SCRAPE_PROJECT_ID?.trim();
  if (scrapeProjectId) {
    const sources = (process.env.SCRAPE_SOURCES ?? 'chatgpt')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    console.log(`[runner] Scrape mode - project=${scrapeProjectId} sources=${sources.join(',')}`);
    await runGeoForProject(scrapeProjectId, sources);
    process.exit(0);
  }

  await runScheduledScrapes();
  process.exit(0);
}

// Only auto-run when invoked directly via CLI (not when imported by an API route).
const runningDirectly =
  process.argv[1]?.endsWith('runner.ts') || process.argv[1]?.endsWith('runner.js');

if (runningDirectly) {
  main().catch((err) => {
    console.error('[runner] Fatal:', err);
    process.exit(1);
  });
}
