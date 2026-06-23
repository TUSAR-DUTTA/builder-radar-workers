// Recompute cited_sources.prompts_citing = the number of DISTINCT prompts whose answer_runs cited
// each source. This is DERIVED from answer_runs.citations — the cross-engine source of truth that
// EVERY writer already fills, including the Playwright-fed engines (claude / perplexity / google-aio
// all record their citations into answer_runs). The per-(project,url) upsert can't know whether a
// *new* prompt cited a source without a (source,prompt) link table, and the Playwright worker
// co-writes cited_sources — so rather than coordinate a write-time counter across every writer
// (which would mean editing the worker), we recompute the count from answer_runs after a run.
//
// Self-healing: rows the Playwright worker inserts with prompts_citing=1 get corrected on the next
// daily geo-run pass. Best-effort — never throws into the caller's pipeline.

import { db } from '@/db';
import { sql } from 'drizzle-orm';

export async function recomputePromptsCiting(projectId: string): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE cited_sources cs
      SET prompts_citing = sub.cnt
      FROM (
        SELECT cit->>'url' AS url, count(DISTINCT ar.prompt_id) AS cnt
        FROM answer_runs ar,
             jsonb_array_elements(COALESCE(ar.citations, '[]'::jsonb)) AS cit
        WHERE ar.project_id = ${projectId}
          AND cit->>'url' IS NOT NULL
        GROUP BY cit->>'url'
      ) sub
      WHERE cs.project_id = ${projectId} AND cs.url = sub.url
    `);
  } catch (e) {
    console.warn('[cited-sources] recompute prompts_citing failed:', (e as Error).message);
  }
}
