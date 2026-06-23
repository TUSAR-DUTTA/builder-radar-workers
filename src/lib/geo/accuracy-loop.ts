// The honest recurring loop for the accuracy engine. Called once per project at the END of a run
// (cron/geo-run + workers/runner), AFTER alerts have been upserted. Two jobs:
//   1. Resolution — alerts not re-seen this run advance toward 'resolved' (2-strike, to ignore
//      single-run answer noise). That flip is the honest "the AI finally stopped saying it" proof,
//      tracked over the real weeks-to-months refresh horizon — NOT a 48h promise.
//   2. Remediation — draft an owned-surface correction + stale-source list for open alerts that
//      don't have one yet (capped, best-effort, free Groq). Detection → drafted fix is the
//      free→paid converter; it never claims to fix the AI.
import { db } from '@/db';
import { accuracyAlerts } from '@/db/schema';
import { and, eq, isNull, lt, inArray, sql } from 'drizzle-orm';
import { draftRemediation } from './engine';
import type { AIRouter } from '@/lib/ai-router';

export async function finalizeAccuracyLoop(
  router: AIRouter,
  projectId: string,
  brand: string,
  runStart: Date,
  citationUrls: string[],
): Promise<void> {
  // 1. Resolution. Alerts re-seen this run had last_seen bumped to now() (>= runStart); ones not
  //    re-seen kept an older last_seen (< runStart). Increment their miss counter, then flip to
  //    resolved on the 2nd consecutive miss.
  try {
    await db.update(accuracyAlerts)
      .set({ missedRuns: sql`${accuracyAlerts.missedRuns} + 1` })
      .where(and(
        eq(accuracyAlerts.projectId, projectId),
        inArray(accuracyAlerts.status, ['open', 'monitoring']),
        lt(accuracyAlerts.lastSeen, runStart),
      ));
    await db.update(accuracyAlerts)
      .set({ status: 'resolved', resolvedAt: new Date() })
      .where(and(
        eq(accuracyAlerts.projectId, projectId),
        inArray(accuracyAlerts.status, ['open', 'monitoring']),
        lt(accuracyAlerts.lastSeen, runStart),
        sql`${accuracyAlerts.missedRuns} >= 2`,
      ));
  } catch (e) {
    console.warn('[accuracy-loop] resolution failed:', (e as Error).message);
  }

  // 2. Remediation drafts for open alerts that lack one (cap to bound cost; free Groq pool).
  try {
    const open = await db.select().from(accuracyAlerts)
      .where(and(
        eq(accuracyAlerts.projectId, projectId),
        eq(accuracyAlerts.status, 'open'),
        isNull(accuracyAlerts.remediation),
      ))
      .limit(5);
    for (const a of open) {
      const rem = await draftRemediation(
        router,
        { attribute: a.attribute, statedValue: a.statedValue, truthValue: a.truthValue, kind: a.kind },
        brand,
        citationUrls,
      ).catch(() => null);
      if (rem) {
        await db.update(accuracyAlerts).set({ remediation: rem }).where(eq(accuracyAlerts.id, a.id));
      }
    }
  } catch (e) {
    console.warn('[accuracy-loop] remediation failed:', (e as Error).message);
  }
}
