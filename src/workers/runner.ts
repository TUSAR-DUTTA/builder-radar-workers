/**
 * BuilderRadar GEO Worker Runner
 *
 * Drives the on-demand / scheduled GEO answer-sampling scrape path.
 */

import { db } from '@/db';
import { projects, profiles, promptSets, scanJobs } from '@/db/schema';
import { loadSessionsFromEnv } from '@/lib/session-loader';
import { getAIRouter } from '@/lib/ai-router';
import { eq, and, inArray, sql } from 'drizzle-orm';

import type { AnswerModel, BrandFact } from '@/lib/geo/types';
import { runPromptViaPlaywrightDetailed, closeSharedBrowser, isPlaywrightAnswerModel } from './lib/geo-playwright';
import { runSocialScrapesForProject, runScheduledSocialScrapes } from './social';
import { oldestAttemptFirst } from '@/lib/worker-scheduling';

import { 
  claimNextScanCell, completeScanCell, failScanCell, 
  initializeScanJobCells, refreshScanJob, resumeCandidate,
} from '@/lib/scan-job-store';
import { sampleProjectPrompts } from '@/lib/geo/sample-run';
import { SCAN_JOB_CONTRACT_VERSION, withProviderDeadline } from '@/lib/scan-job-contract';
import type { EvidenceFailureCode } from '@builder-radar/evidence-contract';
import {
  blockedIdentityCode,
  completeIdentityToLegacyPrivateProfile,
  validateWorkerIdentityBeforePaidAcquisition,
  workerSourcesToEngines,
} from './lib/evidence-contract-boundary';

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

function sourcesToModels(sources: string[]): AnswerModel[] {
  return workerSourcesToEngines(sources);
}

type GeoRunStatus = 'complete' | 'not_found' | 'no_models' | 'no_prompts' | 'quota_exhausted' | 'identity_blocked';
interface GeoRunResult {
  prompts: number;
  runs: number;
  models: AnswerModel[];
  status: GeoRunStatus;
  primaryFailureCode: EvidenceFailureCode | null;
}

const CELL_LEASE_MS = 120_000;
const PROVIDER_DEADLINE_MS = 240_000;

async function runGeoForProject(projectId: string, sources: string[]): Promise<GeoRunResult> {
  const models = sourcesToModels(sources).filter(isPlaywrightAnswerModel);
  if (models.length === 0) return { prompts: 0, runs: 0, models: [], status: 'no_models', primaryFailureCode: null };

  const [project] = await withDbRetry('runGeoForProject', () => db
    .select({
      id: projects.id,
      name: projects.name,
      userId: projects.userId,
      plan: profiles.plan,
      subscriptionPlan: profiles.subscriptionPlan,
      ltdTier: profiles.ltdTier,
    })
    .from(projects)
    .leftJoin(profiles, eq(profiles.id, projects.userId))
    .where(eq(projects.id, projectId))
    .limit(1));

  if (!project) return { prompts: 0, runs: 0, models, status: 'not_found', primaryFailureCode: null };

  const prompts = await withDbRetry('runGeoForProject.prompts', () => db
    .select({ id: promptSets.id, prompt: promptSets.prompt })
    .from(promptSets)
    .where(and(eq(promptSets.projectId, project.id), eq(promptSets.active, true))));

  if (prompts.length === 0) return { prompts: 0, runs: 0, models, status: 'no_prompts', primaryFailureCode: null };
  
  // Raw SQL is deliberate at this boundary: public workers compile against staged private runtime
  // sources of different ages, while the database contract must load every current identity field.
  const identityRows = await withDbRetry('runGeoForProject.identity', () => db.execute(sql`
    SELECT
      bf.facts AS "facts",
      bf.verification_status AS "verificationStatus",
      bf.canonical_name AS "canonicalName",
      bf.canonical_domain AS "canonicalDomain",
      bf.category AS "category",
      bf.aliases AS "aliases",
      bf.domain_aliases AS "domainAliases",
      bf.ambiguous_aliases AS "ambiguousAliases",
      bf.negative_meanings AS "negativeMeanings",
      bf.geography AS "geography",
      bf.competitor_identities AS "competitorIdentities",
      bf.identity_provenance AS "identityProvenance",
      bf.identity_version AS "identityVersion",
      bf.identity_verification_status AS "identityVerificationStatus",
      bf.verified_at AS "verifiedAt",
      p.measurement_baseline_version AS "measurementBaselineVersion",
      p.market_profile AS "marketProfile"
    FROM projects p
    LEFT JOIN brand_facts bf ON bf.project_id = p.id
    WHERE p.id = ${project.id}
    LIMIT 1
  `));
  const factRow = identityRows[0] as unknown as {
    facts: unknown;
    verificationStatus: unknown;
    canonicalName: unknown;
    canonicalDomain: unknown;
    category: unknown;
    aliases: unknown;
    domainAliases: unknown;
    ambiguousAliases: unknown;
    negativeMeanings: unknown;
    geography: unknown;
    competitorIdentities: unknown;
    identityProvenance: unknown;
    identityVersion: unknown;
    identityVerificationStatus: unknown;
    verifiedAt: unknown;
    measurementBaselineVersion: unknown;
    marketProfile: unknown;
  } | undefined;
    
  const facts = factRow?.verificationStatus === 'user_approved'
    ? (factRow.facts as BrandFact[] | undefined) ?? []
    : [];
  const identityResult = validateWorkerIdentityBeforePaidAcquisition(factRow ? {
    projectId: project.id,
    baselineId: factRow.measurementBaselineVersion,
    canonicalName: factRow.canonicalName,
    canonicalDomain: factRow.canonicalDomain,
    category: factRow.category,
    aliases: factRow.aliases,
    domainAliases: factRow.domainAliases,
    ambiguousAliases: factRow.ambiguousAliases,
    negativeMeanings: factRow.negativeMeanings,
    geography: factRow.geography,
    identityVersion: factRow.identityVersion,
    identityVerificationStatus: factRow.identityVerificationStatus,
    identityProvenance: factRow.identityProvenance,
    identityVerifiedAt: factRow.verifiedAt,
    competitorIdentities: factRow.competitorIdentities,
    marketProfile: factRow.marketProfile,
  } : null);
  if (!identityResult.success) {
    const primaryFailureCode = blockedIdentityCode(identityResult);
    console.error(`[runner] project ${project.id} blocked before paid acquisition: ${primaryFailureCode}`);
    return { prompts: prompts.length, runs: 0, models, status: 'identity_blocked', primaryFailureCode };
  }
  const completeIdentity = identityResult.value;
  const identity = completeIdentityToLegacyPrivateProfile(completeIdentity);
  const competitors = completeIdentity.competitors.map((competitor) => competitor.canonicalName);

  const router = getAIRouter();
  const jobKind = `worker:playwright:${[...models].sort().join(',')}`;
  
  const existingJob = await resumeCandidate(project.id, jobKind);
  const insertedJob = existingJob ? null : await db.insert(scanJobs).values({
    projectId: project.id, status: 'queued', kind: jobKind,
    contractVersion: SCAN_JOB_CONTRACT_VERSION,
    deadlineAt: new Date(Date.now() + 3600_000),
    metadata: { models, promptCount: prompts.length },
  }).returning({ id: scanJobs.id }).then((r) => r[0]).catch((e) => {
    if ((e as any).code === '23505') return null;
    throw e;
  });
  
  const job = existingJob ?? insertedJob;
  if (!job) return { prompts: prompts.length, runs: 0, models, status: 'quota_exhausted', primaryFailureCode: null };

  await initializeScanJobCells({ jobId: job.id, projectId: project.id, prompts, models });
  const promptById = new Map(prompts.map(p => [p.id, p]));
  const scanWorkerId = `worker:pw:${job.id}`;
  
  try {
    while (true) {
      const cell = await claimNextScanCell(job.id, scanWorkerId, CELL_LEASE_MS);
      if (!cell) break;
      const prompt = cell.prompt_id ? promptById.get(cell.prompt_id) : undefined;
      if (!prompt) {
        await failScanCell(cell.id, scanWorkerId, new Error('prompt changed after scheduled scan was queued'));
        continue;
      }

      const controller = new AbortController();
      const deadlineAt = Date.now() + PROVIDER_DEADLINE_MS;
      const timer = setTimeout(() => controller.abort(new Error("provider_deadline_aborted")), PROVIDER_DEADLINE_MS);

      try {
        const sampled = await sampleProjectPrompts({
          router, projectId: project.id, brand: project.name, competitors,
          prompts: [prompt], models: [cell.engine], facts, identity,
          userId: project.userId ?? undefined, 
          plan: { plan: project.plan, subscriptionPlan: project.subscriptionPlan, ltdTier: project.ltdTier },
          maxRuns: 1,
          scanCellId: cell.id,
          scanCellClaimedBy: scanWorkerId,
          acquirePrompt: async (input) => {
            const res = await runPromptViaPlaywrightDetailed(
              router, input.prompt.prompt, input.entities, input.models, controller.signal, deadlineAt
            );
            return {
              samples: res.samples,
              failures: res.outcomes,
              acquisition: 'playwright'
            };
          }
        });

        if (sampled.runCount > 0 && await completeScanCell(cell.id, scanWorkerId)) {
          // Success
        } else {
          await failScanCell(cell.id, scanWorkerId, new Error('provider_no_valid_answer'), sampled.failures[cell.engine]);
        }
      } catch (cellError: any) {
        if (cellError.message && cellError.message.includes('_aborted')) {
          await failScanCell(cell.id, scanWorkerId, new Error('provider_deadline_exceeded_after_240000ms'));
        } else {
          await failScanCell(cell.id, scanWorkerId, cellError);
        }
      } finally {
        clearTimeout(timer);
        if (controller.signal.aborted) {
          await closeSharedBrowser();
        }
      }
    }
  } finally {
    await closeSharedBrowser();
  }

  const lifecycle = await refreshScanJob(job.id);
  if (['complete', 'terminal_failed', 'retryable_failed'].includes(lifecycle.status)) {
    await db.update(projects).set({ lastScrapeAt: new Date() }).where(eq(projects.id, project.id)).catch(() => {});
  }

  return { prompts: prompts.length, runs: lifecycle.successful, models, status: 'complete', primaryFailureCode: null };
}

const SCRAPE_INTERVAL_MIN: Record<string, number> = {
  starter: 120,
  pro: 80,
};
const SCRAPE_GRACE_MIN = 30;
const SCRAPE_SOURCES_AUTO = ['chatgpt', 'perplexity', 'claude', 'google-aio', 'grok'];
const MAX_SCRAPES_PER_TICK = 8;

async function runScheduledScrapes(): Promise<void> {
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
      inArray(profiles.subscriptionPlan, ['starter', 'pro']),
    )));

  if (activeProjects.length === 0) {
    console.log('[scrape-cron] no active paid projects this tick');
    return;
  }

  const jobKind = `worker:playwright:${[...targetModels].sort().join(',')}`;
  
  // Fetch recent scan jobs for this jobKind to determine per-engine/cell freshness
  const recentJobs = await withDbRetry('runScheduledScrapes.recentJobs', () => db
    .select({
      projectId: scanJobs.projectId,
      completedAt: scanJobs.completedAt,
      status: scanJobs.status,
    })
    .from(scanJobs)
    .where(and(
      inArray(scanJobs.projectId, activeProjects.map(p => p.id)),
      eq(scanJobs.kind, jobKind),
    )));

  const jobMap = new Map<string, { completedAt: Date | null, status: string }>();
  for (const j of recentJobs) {
    const existing = jobMap.get(j.projectId);
    if (!existing || (j.completedAt && (!existing.completedAt || j.completedAt > existing.completedAt))) {
      jobMap.set(j.projectId, j);
    }
  }

  const now = Date.now();
  const due = activeProjects.filter((p) => {
    const plan = p.subscriptionPlan ?? 'starter';
    const interval = SCRAPE_INTERVAL_MIN[plan] ?? SCRAPE_INTERVAL_MIN.starter;
    const projectLast = p.lastAttemptAt ? new Date(p.lastAttemptAt).getTime() : 0;
    
    const engineJob = jobMap.get(p.id);
    const engineLast = engineJob?.completedAt ? new Date(engineJob.completedAt).getTime() : 0;

    // If this engine job has never run or is incomplete, it's due
    if (!engineJob || !engineJob.completedAt) return true;

    // Check per-engine/cell freshness
    const engineDue = (now - engineLast) / 60_000 >= interval - SCRAPE_GRACE_MIN;
    const projectDue = (now - projectLast) / 60_000 >= interval - SCRAPE_GRACE_MIN;
    return engineDue || projectDue;
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
      } else if (result.status === 'identity_blocked') {
        console.warn(`[scrape-cron] project "${p.name}" skipped (identity verification incomplete: ${result.primaryFailureCode})`);
      }
    } catch (err) {
      failedProjects.push(p.id);
      console.error(`[scrape-cron] project "${p.name}" failed:`, err);
    }
  }
  if (failedProjects.length > 0) {
    throw new Error(`${failedProjects.length}/${batch.length} browser-sampling project attempts failed`);
  }
}

export { runGeoForProject, runScheduledScrapes };

async function main() {
  loadSessionsFromEnv();

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
    if (result.status === 'identity_blocked') {
      throw new Error(`Paid acquisition blocked: ${result.primaryFailureCode ?? 'identity_incomplete'}`);
    }
    if (result.status === 'complete' && result.prompts > 0 && result.runs === 0) {
      throw new Error('Browser sampling produced no valid stored answers');
    }
    process.exit(0);
  }

  await runScheduledScrapes();
  process.exit(0);
}

const runningDirectly =
  process.argv[1]?.endsWith('runner.ts') || process.argv[1]?.endsWith('runner.js');

if (runningDirectly) {
  main().catch((err) => {
    console.error('[runner] Fatal:', err);
    process.exit(1);
  });
}
