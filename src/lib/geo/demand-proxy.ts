// Poor-man's prompt-demand proxy — "do buyers actually ASK this?". Profound's only real moat is
// real prompt-volume data; we approximate it cheaply from signals a tiny tool can get for free:
//   1. Google Autocomplete — if Google completes the prompt's key phrase, real people type it.
//   2. Our own social_mentions volume — how often the phrase shows up in real Reddit/HN/etc. chatter.
// Imperfect on purpose: it attacks the moat at the low end (the experiment funded incumbents skip),
// and it answers the "are these the questions my buyers really ask?" job behind prompt quality.

const STOPWORDS = new Set([
  'what', 'which', 'who', 'whats', 'whose', 'how', 'why', 'when', 'where', 'is', 'are', 'the', 'a', 'an',
  'to', 'for', 'of', 'in', 'on', 'do', 'does', 'i', 'my', 'me', 'should', 'can', 'could', 'best', 'top',
  'good', 'better', 'vs', 'or', 'and', 'with', 'use', 'using', 'there', 'any', 'some',
]);

/**
 * Reduce a buyer-question prompt to the searchable key phrase autocomplete responds to. We keep
 * "best"/"top" OUT (they're question framing, not the demand stem) but preserve the noun phrase and
 * comparison terms. Falls back to the raw prompt if stripping leaves nothing.
 */
export function demandKeyphrase(prompt: string): string {
  const cleaned = prompt
    .toLowerCase()
    .replace(/[?!.]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .join(' ')
    .trim();
  return cleaned.length >= 3 ? cleaned : prompt.toLowerCase().trim();
}

/**
 * Google Autocomplete suggestions for a query. client=firefox returns plain JSON
 * `[query, [suggestion, ...]]` (no JSONP wrapper). Fixed, trusted host — best-effort, never throws;
 * returns [] on any failure so a dead network can't break demand scoring.
 */
export async function fetchAutocomplete(query: string, timeoutMs = 4000): Promise<string[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const res = await fetch(
      `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(q)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BuilderRadar/1.0; +https://builderradar.pro)' }, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    const list = Array.isArray(data) && Array.isArray(data[1]) ? (data[1] as unknown[]) : [];
    return list.filter((s): s is string => typeof s === 'string');
  } catch {
    return [];
  }
}

export type DemandLevel = 'high' | 'med' | 'low' | 'none';

export interface DemandResult {
  keyphrase: string;
  suggestionsCount: number;
  sampleSuggestions: string[];
  socialHits: number;
  score: number;        // 0–100
  level: DemandLevel;
}

/**
 * Combine the cheap signals into a single 0–100 demand score. Autocomplete breadth is the primary
 * signal (a stem people actively type returns many completions); social chatter is corroborating
 * evidence. Both are capped so neither alone saturates the score. Deterministic for a given input.
 */
export function scoreDemand(keyphrase: string, suggestions: string[], socialHits: number): DemandResult {
  const suggestionsCount = suggestions.length;
  // Up to ~70 pts from autocomplete breadth (10 suggestions = full), up to ~30 from social volume.
  const autoPts = Math.min(70, suggestionsCount * 7);
  const socialPts = Math.min(30, socialHits * 6);
  const score = Math.min(100, Math.round(autoPts + socialPts));
  const level: DemandLevel =
    score >= 55 ? 'high' : score >= 25 ? 'med' : score > 0 ? 'low' : 'none';
  return { keyphrase, suggestionsCount, sampleSuggestions: suggestions.slice(0, 5), socialHits, score, level };
}

/** Count how many social mentions' text contains the keyphrase's distinctive terms. */
export function countSocialHits(keyphrase: string, texts: string[]): number {
  const terms = keyphrase.split(/\s+/).filter((t) => t.length >= 4);
  if (terms.length === 0) return 0;
  let hits = 0;
  for (const text of texts) {
    const lc = text.toLowerCase();
    // A mention counts if it contains the majority of the distinctive terms (avoids one common word
    // matching everything). For short phrases (1–2 terms) require all of them.
    const need = terms.length <= 2 ? terms.length : Math.ceil(terms.length * 0.6);
    const got = terms.filter((t) => lc.includes(t)).length;
    if (got >= need) hits++;
  }
  return hits;
}
