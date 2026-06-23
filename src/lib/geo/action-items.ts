// Shared "tracked answers / action items" generator — the core of the honest weekly loop, extracted
// so it can run on the FIRST sample too (not only on the Monday cron). For each buyer prompt the
// brand is ABSENT from this week, it records the competitor the AI named instead and the source it
// cited, with a deterministic next action limited to source/owned-page cleanup (never a fabricated
// claim). Idempotent per (project, week_start, title) via a unique index, so kickoff + daily run +
// weekly cron can all call it without creating duplicates.
//
// Called from:
//   - src/app/api/projects/[id]/kickoff/route.ts  (first run — so "what to fix" isn't empty)
//   - src/app/api/cron/geo-run/route.ts           (paid daily — keeps it fresh)
//   - src/app/api/cron/geo-weekly/route.ts        (the Monday email uses the returned list)

import { db } from '@/db';
import { projects, promptSets, answerRuns, actionItems } from '@/db/schema';
import { and, eq, gte } from 'drizzle-orm';

type Verdict = 'recommended' | 'named' | 'absent';

export interface TrackedAnswer {
  title: string;
  detail: string;
  nextAction: string;
  targetPrompts: string[];
  targetSourceUrl?: string;
  beforeScore: number;
}

interface RunRow {
  promptId: string;
  brandVerdict: string | null;
  verdicts: Record<string, Verdict>;
  citations: { url: string; title?: string }[];
}

export function verdictPoints(v: Verdict | undefined): number {
  return v === 'recommended' ? 1 : v === 'named' ? 0.5 : 0;
}

/** Brand visibility (0–100) across runs, optionally restricted to certain promptIds. */
export function brandVisibility(runs: RunRow[], promptIds?: Set<string>): number {
  const subset = promptIds ? runs.filter((r) => promptIds.has(r.promptId)) : runs;
  if (subset.length === 0) return 0;
  const pts = subset.reduce((a, r) => a + verdictPoints((r.brandVerdict ?? 'absent') as Verdict), 0);
  return Math.round((pts / subset.length) * 100);
}

/** ISO date (YYYY-MM-DD) of the Monday that starts the UTC week containing `d`. */
export function weekStartUTC(d = new Date()): string {
  const x = new Date(d);
  const day = x.getUTCDay();
  x.setUTCDate(x.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return x.toISOString().slice(0, 10);
}

/**
 * Compute this week's tracked answers (max `limit`) for a project from its recent answer_runs,
 * persist them as action_items (idempotent), and return them for display/email. Best-effort: any
 * failure returns [] rather than throwing into the caller's pipeline.
 */
export async function generateTrackedAnswers(projectId: string, limit = 3): Promise<TrackedAnswer[]> {
  try {
    const [project] = await db
      .select({ name: projects.name, userId: projects.userId, competitors: projects.competitors })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) return [];

    const competitors = Array.isArray(project.competitors)
      ? (project.competitors as unknown[]).map((c) => (typeof c === 'string' ? c : (c as { name?: string }).name)).filter(Boolean) as string[]
      : [];

    const promptRows = await db
      .select({ id: promptSets.id, prompt: promptSets.prompt })
      .from(promptSets)
      .where(and(eq(promptSets.projectId, projectId), eq(promptSets.active, true)));
    if (promptRows.length === 0) return [];
    const promptText = new Map(promptRows.map((p) => [p.id, p.prompt]));

    const weekAgo = new Date(Date.now() - 7 * 864e5);
    const runs = (await db
      .select({ promptId: answerRuns.promptId, brandVerdict: answerRuns.brandVerdict, verdicts: answerRuns.verdicts, citations: answerRuns.citations })
      .from(answerRuns)
      .where(and(eq(answerRuns.projectId, projectId), gte(answerRuns.runAt, weekAgo)))) as RunRow[];
    if (runs.length === 0) return [];

    // Group by prompt; a prompt is "absent" only when the brand is absent across ALL its runs.
    const byPrompt = new Map<string, RunRow[]>();
    for (const r of runs) { const arr = byPrompt.get(r.promptId) ?? []; arr.push(r); byPrompt.set(r.promptId, arr); }

    const tracked: TrackedAnswer[] = [];
    for (const [pid, rs] of byPrompt) {
      if (tracked.length >= limit) break;
      if (!rs.every((r) => (r.brandVerdict ?? 'absent') === 'absent')) continue;
      const prompt = promptText.get(pid);
      if (!prompt) continue;

      // Top competitor named on this prompt.
      let topComp: string | null = null; let topScore = 0;
      for (const name of competitors) {
        const s = rs.reduce((a, r) => a + verdictPoints((r.verdicts?.[name] ?? 'absent') as Verdict), 0);
        if (s > topScore) { topScore = s; topComp = name; }
      }
      // First cited source on this prompt, if any.
      let citeUrl: string | undefined; let citeDomain: string | undefined;
      for (const r of rs) {
        const c = Array.isArray(r.citations) ? r.citations.find((x) => x?.url) : undefined;
        if (c?.url) { citeUrl = c.url; try { citeDomain = new URL(c.url).hostname.replace(/^www\./, ''); } catch { /* keep url, drop domain */ } break; }
      }
      tracked.push({
        title: (topComp ? `AI names ${topComp} for “${prompt}”, not you` : `AI leaves you out of “${prompt}”`).slice(0, 300),
        detail: `${topComp ? `AI recommends ${topComp} here, not you.` : `You're absent from this answer.`}${citeDomain ? ` It cited ${citeDomain} to answer.` : ''}`,
        nextAction: citeDomain
          ? `Check ${citeDomain} and your own comparison/category page for a clear, current answer to this exact buyer question.`
          : 'Add or clarify a short owned-page answer for this buyer question, then track whether future AI answers change.',
        targetPrompts: [prompt],
        targetSourceUrl: citeUrl,
        beforeScore: brandVisibility(runs, new Set([pid])),
      });
    }

    const weekStart = weekStartUTC();
    for (const t of tracked) {
      await db.insert(actionItems).values({
        projectId,
        userId: project.userId,
        weekStart,
        title: t.title,
        detail: t.detail,
        targetSourceUrl: t.targetSourceUrl || null,
        targetPrompts: t.targetPrompts,
        status: 'suggested',
        beforeScore: t.beforeScore,
        outcomeVerdict: 'pending',
      }).onConflictDoNothing({ target: [actionItems.projectId, actionItems.weekStart, actionItems.title] });
    }

    return tracked;
  } catch (e) {
    console.warn('[action-items] generate failed:', (e as Error).message);
    return [];
  }
}
