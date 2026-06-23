// Shared GEO report builder — the read-side aggregation behind the AI-visibility report, reused by
// the public white-label share page and the MCP server. It does NO auth (callers authorize first):
// it takes a project id and returns the headline numbers, trend, share-of-answers, top cited sources,
// and the tracked answers. Aggregation mirrors the GEO dashboard route so the share/MCP views never drift from it.

import { db } from '@/db';
import { projects, promptSets, answerRuns, citedSources, actionItems } from '@/db/schema';
import { and, eq, gte, desc } from 'drizzle-orm';

type Verdict = 'recommended' | 'named' | 'absent';
const pts = (v: Verdict | undefined) => (v === 'recommended' ? 1 : v === 'named' ? 0.5 : 0);

export interface ShareReport {
  brand: string;
  generatedAt: string;
  promptCount: number;
  sampleCount: number;
  visibilityScore: number;
  delta: number;
  trend: { week: string; score: number; samples: number }[];
  share: { name: string; score: number; isBrand: boolean }[];
  sources: { domain: string; url: string; sourceType: string | null; citations: number }[];
  moves: { title: string; detail: string | null; targetSourceUrl: string | null; outcomeVerdict: string | null; beforeScore: number | null; afterScore: number | null }[];
}

/** Build the report for a project. Returns null if the project doesn't exist. */
export async function buildShareReport(projectId: string): Promise<ShareReport | null> {
  const now = Date.now();
  const [[project], prompts, runs, sources, actions] = await Promise.all([
    db.select({ name: projects.name, competitors: projects.competitors }).from(projects).where(eq(projects.id, projectId)).limit(1),
    db.select({ id: promptSets.id }).from(promptSets).where(and(eq(promptSets.projectId, projectId), eq(promptSets.active, true))),
    db.select({ runAt: answerRuns.runAt, brandVerdict: answerRuns.brandVerdict, verdicts: answerRuns.verdicts })
      .from(answerRuns)
      .where(and(eq(answerRuns.projectId, projectId), gte(answerRuns.runAt, new Date(now - 56 * 864e5))))
      .orderBy(desc(answerRuns.runAt)),
    db.select({ domain: citedSources.domain, url: citedSources.url, sourceType: citedSources.sourceType, citations: citedSources.citations })
      .from(citedSources).where(eq(citedSources.projectId, projectId)).orderBy(desc(citedSources.citations)).limit(8),
    db.select({ title: actionItems.title, detail: actionItems.detail, targetSourceUrl: actionItems.targetSourceUrl, outcomeVerdict: actionItems.outcomeVerdict, beforeScore: actionItems.beforeScore, afterScore: actionItems.afterScore })
      .from(actionItems).where(eq(actionItems.projectId, projectId)).orderBy(desc(actionItems.weekStart)).limit(6),
  ]);
  if (!project) return null;

  const competitors = Array.isArray(project.competitors)
    ? (project.competitors as unknown[]).map((c) => (typeof c === 'string' ? c : (c as { name?: string }).name)).filter(Boolean) as string[]
    : [];
  const entities = [project.name, ...competitors];

  const buckets: { week: string; score: number; samples: number }[] = [];
  for (let w = 7; w >= 0; w--) {
    const lo = now - (w + 1) * 7 * 864e5;
    const hi = now - w * 7 * 864e5;
    const inWeek = runs.filter((r) => { const t = new Date(r.runAt).getTime(); return t >= lo && t < hi; });
    const score = inWeek.length ? Math.round((inWeek.reduce((a, r) => a + pts((r.brandVerdict ?? 'absent') as Verdict), 0) / inWeek.length) * 100) : 0;
    buckets.push({ week: new Date(lo).toISOString().slice(0, 10), score, samples: inWeek.length });
  }
  const latest = buckets[buckets.length - 1];
  const prev = buckets[buckets.length - 2];

  const recent = runs.filter((r) => new Date(r.runAt).getTime() >= now - 7 * 864e5);
  const arr = recent.length ? recent : runs;
  const share = entities.map((name) => {
    const v = arr.reduce((a, r) => a + pts((r.verdicts as Record<string, Verdict>)?.[name]), 0);
    return { name, score: arr.length ? Math.round((v / arr.length) * 100) : 0, isBrand: name === project.name };
  }).sort((a, b) => b.score - a.score);

  return {
    brand: project.name,
    generatedAt: new Date(now).toISOString(),
    promptCount: prompts.length,
    sampleCount: runs.length,
    visibilityScore: latest?.score ?? 0,
    delta: (latest?.score ?? 0) - (prev?.score ?? 0),
    trend: buckets,
    share,
    sources,
    moves: actions,
  };
}
