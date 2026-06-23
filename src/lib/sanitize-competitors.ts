/**
 * Competitor-list hygiene.
 *
 * The ICP extraction step occasionally leaks agent/tool-trace strings into the competitor list —
 * e.g. "Read 1 file", "Edited 3 files", "12 results" — when the model echoes its own scratchpad
 * instead of a brand name. These are never real products, but they flow straight into
 * `"<name> alternative"` retrieval queries (concrete-query-generator) and the scorer's
 * satisfied-competitor penalty, where they waste a search slot and muddy scoring.
 *
 * We strip them at every CONSUMPTION point (not just at extraction) so the guard protects ICPs
 * that were stored before this shipped, with no re-extraction — the same defense-at-the-chokepoint
 * pattern icp-config.ts uses for collision/abstraction queries.
 *
 * Deliberately CONSERVATIVE so it never eats a real brand: a competitor name is treated as junk
 * only when it looks like a tool-trace, i.e. it pairs a count with a trace noun ("1 file",
 * "3 results", "12 lines") or is an empty/sentence-length blob. Real product names that merely
 * START with a trace-ish word ("ReadMe", "Read.cv", "Brand24", "Listed") are NOT matched, because
 * they lack the "<number> <trace-noun>" shape.
 */

// "Read 1 file", "Edited 3 files", "Found 12 results", "Updated 2 lines", "5 matches" …
// A digit immediately followed by a tool-trace noun is the tell. Brand names don't carry this.
const TOOL_TRACE_COUNT = /\b\d+\s+(files?|director(?:y|ies)|lines?|results?|matches?|items?|edits?|changes?|tool\s*calls?|commands?|snippets?|functions?|tokens?)\b/i;

// Bare tool-verb traces with no count ("Read file", "Edited file", "Ran tool", "Searched codebase").
const TOOL_TRACE_VERB = /^(read|edit(?:ed|ing)?|wrote|writing|creat(?:e|ed|ing)|search(?:ed|ing)?|list(?:ed|ing)?|view(?:ed|ing)?|ran|run|fetch(?:ed|ing)?|grep|glob|bash|updat(?:e|ed|ing)|delet(?:e|ed|ing)|inspect(?:ed|ing)?|analyz(?:e|ed|ing))\s+(the\s+)?(file|files|tool|tools|codebase|directory|command|repo|repository|snippet|function)\b/i;

/** Is this competitor-list entry an agent/tool-trace artifact rather than a real brand name? */
export function isJunkCompetitor(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  // A brand name is short; a leaked trace/sentence is long. 60 chars is generous for any product.
  if (n.length > 60) return true;
  if (TOOL_TRACE_COUNT.test(n)) return true;
  if (TOOL_TRACE_VERB.test(n)) return true;
  return false;
}

/**
 * Filter agent/tool-trace junk out of a competitor name list, trimming and de-duping (case-insensitive,
 * first spelling wins). Use at every point competitor names are read for retrieval or scoring.
 */
export function sanitizeCompetitorNames(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name || isJunkCompetitor(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
