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
import { projects, profiles, promptSets, answerRuns, citedSources, brandFacts, accuracyAlerts, aiProcessingAttempts } from '@/db/schema';
import { loadSessionsFromEnv } from '@/lib/session-loader';
import { AI_MODELS, getAIRouter } from '@/lib/ai-router';
import { eq, and, sql, inArray } from 'drizzle-orm';

import { citedSourceRows, auditAnswerDetailed, accuracyFlag, accuracyAlertRows, gateConfusion, extractWinnerReasons, runPrompt } from '@/lib/geo/engine';
import { finalizeAccuracyLoop } from '@/lib/geo/accuracy-loop';
import type { AnswerModel, BrandFact, AnswerSample } from '@/lib/geo/types';
import { runPromptViaPlaywrightDetailed, closeSharedBrowser, isPlaywrightAnswerModel, isPromptIdentityError } from './lib/geo-playwright';
import { runSocialScrapesForProject, runScheduledSocialScrapes } from './social';
import { isLowQualityAnswer, sanitizeAnswerText } from '@/lib/geo/sanitize-answer';
import { reserveRunCapacity, settleRunReservation } from '@/lib/run-quota';
import { oldestAttemptFirst } from '@/lib/worker-scheduling';
import { detectAndStoreMovements } from '@/lib/geo/movement';
import { IDENTITY_CONTRACT_VERSION, identityFromTruthRow, type ProjectIdentityProfile } from '@/lib/geo/identity-contract';
import { ANSWER_SCHEMA_VERSION, EVIDENCE_CONTRACT_VERSION, JUDGE_PROMPT_VERSION, projectAnswerTruth, storedProjectionFields } from '@/lib/geo/truth-contract';
import { classifyProjectSource } from '@/lib/geo/source-ownership-contract';

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

// Source ids (the worker workflows + SCRAPE_SOURCES use these) → the model id stored in answer_runs.
// ChatGPT browser capture has its own provenance id; it must never be merged into official API rows.
// Shared by runGeoForProject (what it writes) and runScheduledScrapes (the per-engine due gate) so
// the two can never drift out of sync.
const SOURCE_TO_MODEL: Record<string, AnswerModel> = {
  chatgpt: 'chatgpt-consumer',
};
function sourcesToModels(sources: string[]): AnswerModel[] {
  return sources
    .map((s) => SOURCE_TO_MODEL[s] ?? (s as AnswerModel))
    .filter((m): m is AnswerModel => Boolean(m));
}

type GeoRunStatus = 'complete' | 'not_found' | 'no_models' | 'no_prompts' | 'quota_exhausted';
interface GeoRunResult { prompts: number; runs: number; models: AnswerModel[]; status: GeoRunStatus }

async function runGeoForProject(projectId: string, sources: string[]): Promise<GeoRunResult> {
  const models = sourcesToModels(sources);

  const [project] = await withDbRetry('runGeoForProject', () => db
    .select({
      id: projects.id,
      name: projects.name,
      userId: projects.userId,
      plan: profiles.plan,
      subscriptionPlan: profiles.subscriptionPlan,
      ltdTier: profiles.ltdTier,
      competitors: projects.competitors,
      agentPrompt: projects.agentPrompt,
    })
    .from(projects)
    .leftJoin(profiles, eq(profiles.id, projects.userId))
    .where(eq(projects.id, projectId))
    .limit(1));

  if (!project) {
    console.error(`[geo-scrape] project ${projectId} not found`);
    return { prompts: 0, runs: 0, models, status: 'not_found' };
  }
  if (models.length === 0) {
    console.warn(`[geo-scrape] no valid answer engines requested`);
    return { prompts: 0, runs: 0, models: [], status: 'no_models' };
  }

  const prompts = await withDbRetry('runGeoForProject.prompts', () => db
    .select({ id: promptSets.id, prompt: promptSets.prompt })
    .from(promptSets)
    .where(and(eq(promptSets.projectId, project.id), eq(promptSets.active, true))));

  if (prompts.length === 0) {
    console.warn(`[geo-scrape] project "${project.name}" has no active prompt set`);
    return { prompts: 0, runs: 0, models, status: 'no_prompts' };
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
    .select({
      facts: brandFacts.facts,
      verificationStatus: brandFacts.verificationStatus,
      identityVerificationStatus: brandFacts.identityVerificationStatus,
      canonicalName: brandFacts.canonicalName,
      canonicalDomain: brandFacts.canonicalDomain,
      aliases: brandFacts.aliases,
      domainAliases: brandFacts.domainAliases,
      ambiguousAliases: brandFacts.ambiguousAliases,
      identityProvenance: brandFacts.identityProvenance,
    })
    .from(brandFacts)
    .where(eq(brandFacts.projectId, project.id))
    .limit(1));
  const facts = factRow?.verificationStatus === 'user_approved'
    ? (factRow.facts as BrandFact[] | undefined) ?? []
    : [];
  const identity = identityFromTruthRow(project.name, factRow);
  const projectIdentity: ProjectIdentityProfile = {
    ...identity,
    competitors: competitors.map((canonicalName) => ({ canonicalName })),
    contractVersion: IDENTITY_CONTRACT_VERSION,
  };

  // Captured BEFORE any alert upsert so the loop can tell re-seen from no-longer-seen alerts.
  const runStart = new Date();
  const projectCitations = new Set<string>();

  let runCount = 0;
  const perEngine = new Map<string, number>();

  const reservation = await reserveRunCapacity(
    project.userId,
    { plan: project.plan, subscriptionPlan: project.subscriptionPlan, ltdTier: project.ltdTier },
    prompts.length * models.length,
  );
  const promptCapacity = Math.floor(reservation.granted / models.length);
  if (promptCapacity < 1) {
    await settleRunReservation(reservation.reservationId, perEngine);
    console.warn(`[geo-scrape] project "${project.name}" has no remaining monthly answer-check capacity`);
    return { prompts: 0, runs: 0, models, status: 'quota_exhausted' };
  }
  const promptsToRun = prompts.slice(0, promptCapacity);

  const competitorEntities = entities.filter((e) => e !== project.name);

  try {
  for (const p of promptsToRun) {
    const playwrightModels = models.filter(isPlaywrightAnswerModel);
    const apiModels = models.filter((m) => !isPlaywrightAnswerModel(m));

    const samples: AnswerSample[] = [];
    if (playwrightModels.length > 0) {
      try {
        const pwResult = await runPromptViaPlaywrightDetailed(router, p.prompt, entities, playwrightModels);
        samples.push(...pwResult.samples);
        // Diagnostics are best-effort and deliberately contain no prompt/answer/session text. A
        // diagnostics-table outage must never make a healthy browser capture fail.
        if (pwResult.attempts.length > 0) {
          await db.insert(aiProcessingAttempts).values(pwResult.attempts.map((attempt) => ({
            projectId: project.id,
            promptId: p.id,
            engine: attempt.model,
            acquisition: 'playwright',
            stage: attempt.stage,
            status: attempt.status,
            failureReason: attempt.failureReason,
            latencyMs: attempt.latencyMs,
            analysisVersion: EVIDENCE_CONTRACT_VERSION,
          }))).catch((error) => console.warn(`[geo-scrape] attempt diagnostics unavailable: ${(error as Error).message.slice(0, 120)}`));
        }
      } catch (err) {
        console.error(`[geo-scrape] Playwright prompt ${p.id} failed:`, err);
        // A stale/mismatched turn is a batch-integrity failure, not one provider miss. Continuing
        // would let a partly green workflow conceal prompt-answer corruption.
        if (isPromptIdentityError(err)) throw err;
      }
    }
    if (apiModels.length > 0) {
      try {
        const apiSamples = await runPrompt(router, p.prompt, entities, apiModels);
        samples.push(...apiSamples);
        const returned = new Set(apiSamples.map((sample) => sample.model));
        await db.insert(aiProcessingAttempts).values(apiModels.map((model) => ({
          projectId: project.id,
          promptId: p.id,
          engine: model,
          acquisition: 'api',
          stage: 'acquisition',
          status: returned.has(model) ? 'succeeded' : 'failed',
          failureReason: returned.has(model) ? null : 'provider_no_valid_answer',
          analysisVersion: EVIDENCE_CONTRACT_VERSION,
        }))).catch((error) => console.warn(`[geo-scrape] API attempt diagnostics unavailable: ${(error as Error).message.slice(0, 120)}`));
      } catch (err) {
        console.error(`[geo-scrape] API prompt ${p.id} failed:`, err);
      }
    }

    for (const s of samples) {
      const sanitizedAnswer = sanitizeAnswerText(s.answer);
      if (isLowQualityAnswer(sanitizedAnswer)) continue;
      // Fact-check the answer against the brand fact sheet (Groq). Best-effort: a failure
      // leaves the sample unaudited rather than dropping it.
      const auditOutcome = await auditAnswerDetailed(router, s.answer, project.name, facts, competitorEntities, identity);
      const audit = auditOutcome.audit;
      const audited: AnswerSample = { ...s, audit, brandRank: audit?.brandRank ?? null, sentiment: audit?.sentiment ?? null };

      // Guard against the judge fuzzy-matching a different, similarly-named product as the brand
      // (e.g. "Building Radar" → "BuilderRadar"): a confused mention is scored absent + flagged as
      // confusion (an alert), never as visibility. Fix BOTH the brand_verdict column and the
      // verdicts JSON, since the dashboard reads the column (trend/per-engine) and the JSON (share).
      const effectiveAudit = gateConfusion(audit);
      const truth = projectAnswerTruth(sanitizedAnswer, projectIdentity);
      const projection = storedProjectionFields(truth);

      // Keep "entity confusion" only when verifiable (a contradicted category claim — see
      // gateConfusion); otherwise drop it so we never cry "AI confused you with another company"
      // on a category answer that merely echoes the brand name.

      // Why each recommended rival won — a dedicated extraction (the brand audit goes empty when the
      // brand is absent, which is the usual case here). Only runs when a competitor is actually
      // recommended, so most answers cost nothing extra.
      const recommendedComps = truth.competitorWinners.map((competitor) => competitor.entity);
      const winnerReasons = await extractWinnerReasons(router, audited.answer, recommendedComps);

      const inserted = await db.insert(answerRuns).values({
        promptId: p.id,
        projectId: project.id,
        model: audited.model,
        answer: sanitizedAnswer.slice(0, 8000),
        sanitizedAnswer: sanitizedAnswer.slice(0, 8000),
        verdicts: projection?.verdicts ?? {},
        brandVerdict: projection?.brandVerdict ?? null,
        brandRank: audited.brandRank,
        sentiment: audited.sentiment,
        citations: audited.citations,
        claims: effectiveAudit?.claims ?? [],
        accuracyFlag: accuracyFlag(effectiveAudit),
        winnerReasons,
        analysisVersion: EVIDENCE_CONTRACT_VERSION,
        schemaVersion: ANSWER_SCHEMA_VERSION,
        promptVersion: JUDGE_PROMPT_VERSION,
        identityVersion: IDENTITY_CONTRACT_VERSION,
        factsVersion: facts.length > 0 ? 'user_approved_brand_facts_v1' : null,
        analysisStatus: projection ? auditOutcome.status : 'low_confidence',
        analysisConfidence: projection && auditOutcome.status === 'confident' ? 'confident' : 'low_confidence',
        entityEvidence: truth.entities,
        providerMetadata: { answerEngine: audited.model, acquisition: isPlaywrightAnswerModel(audited.model) ? 'playwright' : 'api', judgeModel: AI_MODELS.structuredHighRisk, auditModel: AI_MODELS.structuredHighRisk, schemaMode: 'strict_json_schema', auditStatus: auditOutcome.status },
        failureReason: projection ? auditOutcome.failureReason : 'identity_ambiguity',
      }).onConflictDoNothing().returning({ id: answerRuns.id });
      const evidenceRunId = inserted[0]?.id ?? null;
      runCount += inserted.length;
      if (inserted.length > 0) perEngine.set(audited.model, (perEngine.get(audited.model) ?? 0) + inserted.length);
      for (const c of audited.citations) if (c.url) projectCitations.add(c.url);

      // Upsert deduped accuracy alerts — occurrences/lastSeen build the trend across runs.
      // Re-seeing an alert resets missedRuns (still wrong) and keeps it open.
      // A duplicate delivery is not another occurrence. Only a newly persisted answer can prove and
      // advance an accuracy alert.
      for (const row of evidenceRunId ? accuracyAlertRows({ ...audited, audit: effectiveAudit }, facts, project.name) : []) {
        await db.insert(accuracyAlerts).values({
          projectId: project.id,
          promptId: p.id,
          evidenceRunId,
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
            promptId: p.id,
            evidenceRunId,
            kind: row.kind,
            truthValue: row.truthValue,
            severity: row.severity,
            quote: row.quote,
            model: row.model,
            occurrences: sql`${accuracyAlerts.occurrences} + 1`,
            lastSeen: sql`now()`,
            status: 'open',
            missedRuns: 0,
            resolvedAt: null,
            remediation: null,
          },
        }).catch((err) => console.warn(`[geo-scrape] alert upsert failed:`, (err as Error).message));
      }
    }

    const sourceRows = citedSourceRows(samples);
    for (const src of sourceRows) {
      const classified = classifyProjectSource(src.url, projectIdentity);
      await db.insert(citedSources).values({
        projectId: project.id,
        url: src.url,
        domain: src.domain,
        sourceType: classified.legacySourceType,
        sourceControlLevel: classified.controlLevel,
        ownership: classified.ownership,
        ownerEntity: classified.ownerEntity,
        ownershipVersion: IDENTITY_CONTRACT_VERSION,
        promptsCiting: 1,
        citations: src.count,
      }).onConflictDoUpdate({
        target: [citedSources.projectId, citedSources.url],
        set: {
          citations: sql`${citedSources.citations} + ${src.count}`,
          sourceType: classified.legacySourceType,
          sourceControlLevel: classified.controlLevel,
          ownership: classified.ownership,
          ownerEntity: classified.ownerEntity,
          ownershipVersion: IDENTITY_CONTRACT_VERSION,
          lastSeen: sql`now()`,
        },
      });
    }
  }
  } finally {
    await settleRunReservation(reservation.reservationId, perEngine);
    await closeSharedBrowser();
  }

  // Honest recurring loop: resolve no-longer-seen alerts + draft remediation for open ones.
  await finalizeAccuracyLoop(router, project.id, project.name, runStart, [...projectCitations]);
  // Derived movement belongs to successful ingestion, never a GET request. The detector applies the
  // same claimability contract, so review-required or cross-prompt duplicate captures cannot move.
  await detectAndStoreMovements(project.id, { brand: project.name, competitors });

  await db.update(projects).set({ lastScrapeAt: new Date() }).where(eq(projects.id, projectId)).catch(() => {});
  
  return { prompts: promptsToRun.length, runs: runCount, models, status: 'complete' };
}

const SCRAPE_INTERVAL_MIN: Record<string, number> = {
  starter: 120,
  pro: 80,
};
// Re-scrape throttle. Each engine runs as its own DAILY workflow, so the gap between two runs of
// the SAME engine is normally ~24h and this is a no-op; it only stops a same-engine double-run
// (e.g. the daily cron overlapping an on-demand dispatch) from re-sampling inside the window. The
// grace just softens the edge so a slightly-early re-run isn't blocked.
const SCRAPE_GRACE_MIN = 30;
const SCRAPE_SOURCES_AUTO = ['chatgpt', 'perplexity', 'claude', 'google-aio', 'grok'];
const MAX_SCRAPES_PER_TICK = 8;

async function runScheduledScrapes(): Promise<void> {
  // Which engines THIS run handles. Each per-engine workflow passes a single SCRAPE_SOURCES (e.g.
  // 'claude'); an unset value means a full local/manual run across every engine.
  const sourcesToRun = process.env.SCRAPE_SOURCES
    ? process.env.SCRAPE_SOURCES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : SCRAPE_SOURCES_AUTO;
  const targetModels = sourcesToModels(sourcesToRun);
  if (targetModels.length === 0) {
    console.log('[scrape-cron] no valid engines in SCRAPE_SOURCES — nothing to do');
    return;
  }

  const activeProjects = await withDbRetry('runScheduledScrapes', () => db
    .select({
      id: projects.id,
      name: projects.name,
      plan: profiles.plan,
      subscriptionPlan: profiles.subscriptionPlan,
      ltdTier: profiles.ltdTier,
      lastAttemptAt: projects.lastScrapeAt,
    })
    .from(projects)
    .leftJoin(profiles, eq(profiles.id, projects.userId))
    .where(and(
      eq(projects.status, 'active'),
      // Browser-session autopilot is a monthly subscription feature. LTD contracts are manual-first
      // with a weekly Gemini heartbeat/BYOK path and must not inherit a hidden Starter fallback.
      inArray(profiles.subscriptionPlan, ['starter', 'pro']),
    )));

  if (activeProjects.length === 0) {
    console.log('[scrape-cron] no active paid projects this tick');
    return;
  }

  // Per-engine due gate. A project is due when ANY engine this run handles hasn't written an
  // answer_run within the interval. Keying on per-(project,engine) freshness — NOT one shared
  // projects.lastScrapeAt — is what stops engines from starving each other: previously whichever
  // engine scraped first stamped the shared timestamp, so every engine that fired within the window
  // saw "no projects due" and no-op'd, and the later daily engines (claude, grok) silently went
  // stale for days behind green, "successful" runs. answer_runs.run_at is the very same per-engine
  // freshness the dashboard badges read, so the gate and the UI can never disagree.
  const projectIds = activeProjects.map((p) => p.id);
  const lastRuns = await withDbRetry('runScheduledScrapes.lastRuns', () => db
    .select({
      projectId: answerRuns.projectId,
      model: answerRuns.model,
      lastRunAt: sql<string | null>`max(${answerRuns.runAt})`,
    })
    .from(answerRuns)
    .where(and(
      inArray(answerRuns.projectId, projectIds),
      inArray(answerRuns.model, targetModels),
    ))
    .groupBy(answerRuns.projectId, answerRuns.model));

  const lastRunAtFor = new Map<string, number>();
  for (const r of lastRuns) {
    if (r.lastRunAt) lastRunAtFor.set(`${r.projectId}:${r.model}`, new Date(r.lastRunAt).getTime());
  }

  const now = Date.now();
  const due = activeProjects.filter((p) => {
    const plan = p.subscriptionPlan ?? 'starter';
    const interval = SCRAPE_INTERVAL_MIN[plan] ?? SCRAPE_INTERVAL_MIN.starter;
    return targetModels.some((m) => {
      const last = lastRunAtFor.get(`${p.id}:${m}`);
      if (last === undefined) return true; // this engine has never sampled this project → due
      return (now - last) / 60_000 >= interval - SCRAPE_GRACE_MIN;
    });
  });

  if (due.length === 0) {
    console.log('[scrape-cron] no projects due for auto-scrape this tick');
    return;
  }

  const batch = oldestAttemptFirst(due).slice(0, MAX_SCRAPES_PER_TICK);
  const failedProjects: string[] = [];
  for (const p of batch) {
    try {
      const result = await runGeoForProject(p.id, sourcesToRun);
      if (result.status === 'complete' && result.prompts > 0 && result.runs === 0) {
        failedProjects.push(p.id);
        console.error(`[scrape-cron] project "${p.name}" produced no valid stored answers`);
      } else if (result.status === 'not_found' || result.status === 'no_models') {
        failedProjects.push(p.id);
      }
    } catch (err) {
      failedProjects.push(p.id);
      console.error(`[scrape-cron] project "${p.name}" failed:`, err);
    } finally {
      // Keep stamping the legacy "project last touched" timestamp for anything that still reads it;
      // the due gate above no longer depends on it.
      await db.update(projects).set({ lastScrapeAt: new Date() }).where(eq(projects.id, p.id)).catch(() => {});
    }
  }
  if (failedProjects.length > 0) {
    throw new Error(`${failedProjects.length}/${batch.length} browser-sampling project attempts failed`);
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
    const result = await runGeoForProject(scrapeProjectId, sources);
    if (result.status === 'complete' && result.prompts > 0 && result.runs === 0) {
      throw new Error('Browser sampling produced no valid stored answers');
    }
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
