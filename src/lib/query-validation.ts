/**
 * Empirical search-query validation.
 *
 * The icp-extract prompt + `isBareAbstraction` filter strip queries that are *lexically* generic
 * ("buyer intent", "competitor signals"). But some queries pass those static checks and STILL return
 * pure cross-domain noise for a given product — collisions no fixed wordlist can enumerate ("price
 * tracking", "deal alerts", "signal processing" for the wrong domain). The only reliable way to tell
 * is to actually search and look at what comes back — which is exactly what a human does.
 *
 * This module does that automatically at ICP-creation time: it test-fetches a small sample for each
 * candidate query and drops the ones that return volume but ZERO topical overlap with the product.
 * It is deliberately CONSERVATIVE — a query is only dropped when it returns several results and not
 * one of them mentions any of the product's concrete anchor words (a clear "magnet for an unrelated
 * high-volume domain"). Competitor "[X] alternative" comparisons are never validated away (highest
 * intent, legitimately low volume), and zero/low-volume queries are kept (low volume ≠ noise; the
 * query may have volume on a source we didn't probe).
 *
 * Source: HN Algolia by default — it needs no auth and is not IP-blocked (Reddit's JSON API 403s
 * from datacenter/serverless IPs), so it works as a universal noise probe in prod and in tests. The
 * fetcher is injectable so tests can run fully offline.
 */
import { fetchRawHN, textMatchesKeyword, type RawSourceResult } from './raw-source-search';
import { isBareAbstraction } from './prompts/icp-extract';

export type SampleFetcher = (query: string) => Promise<RawSourceResult[]>;

export interface QueryVerdict {
  query: string;
  verdict: 'keep-competitor' | 'keep-lowvolume' | 'keep-ontopic' | 'drop-noise' | 'demote-competitor-zerohit';
  fetched: number;
  onTopic: number;
}

export interface ValidationResult {
  icp: unknown;
  dropped: string[];
  /** Competitor "[X] alternative" queries with ZERO live matches — kept but demoted to the
   *  retrieval tail (written to icp.zero_volume_queries, read by icp-config's balancedSearchOrder). */
  demoted: string[];
  report: QueryVerdict[];
}

// A query returning at least this many results with ZERO topical overlap is a cross-domain magnet.
const MIN_VOLUME_TO_JUDGE = 6;
// Anchor words shorter than this are too generic to be a reliable topical signal.
const MIN_ANCHOR_LEN = 4;

const ANCHOR_STOPWORDS = new Set([
  'using', 'would', 'could', 'should', 'people', 'thing', 'things', 'really', 'actually',
  'about', 'their', 'there', 'these', 'those', 'where', 'which', 'while', 'every', 'into',
  'your', 'with', 'from', 'that', 'this', 'they', 'them', 'have', 'need', 'want', 'looking',
]);

/**
 * Generic SaaS/business vocabulary that is NOT already in `isBareAbstraction`'s token list but is
 * still too common to be trustworthy topical evidence. Without this, an abstraction-saturated ICP
 * (e.g. a meta-monitoring product whose category is literally "monitoring alert tool") yields
 * anchors like "tool"/"posts"/"alerts"/"surface" that match almost any tech post, so noise queries
 * falsely read as on-topic. A word here only disqualifies it as an ANCHOR — it does not affect what
 * we search for. Competitor names (proper nouns) are matched as full phrases and bypass this set.
 */
const GENERIC_PRODUCT_WORDS = new Set([
  'tool', 'tools', 'app', 'apps', 'application', 'platform', 'platforms', 'software', 'system',
  'systems', 'service', 'services', 'solution', 'solutions', 'website', 'site', 'sites', 'online',
  'digital', 'data', 'content', 'manager', 'management', 'feature', 'features', 'link', 'links',
  'hours', 'week', 'weekly', 'daily', 'manually', 'scanning', 'scan', 'miss', 'missing', 'surface',
  'multiple', 'multi', 'source', 'sources', 'monitor', 'track', 'tracking', 'post', 'posts',
  'thread', 'threads', 'alert', 'alerts', 'score', 'scores', 'scoring', 'head', 'high', 'early',
  'late', 'prove', 'evidence', 'prioritize', 'replying', 'wasting', 'spend', 'spending', 'right',
  'wrong', 'team', 'teams', 'community', 'communities', 'developer', 'developers', 'work', 'working',
]);

const isCompetitorComparison = (q: string): boolean =>
  /\balternative\b|\bvs\b|\bversus\b|\bbetter than\b/i.test(q);

const words = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

/**
 * Is a single word "distinctive" — specific enough that its presence is a real topical signal
 * (and specific enough to belong in a search query)? Shared by the anchor lexicon and the concrete-
 * query generator so both use the same notion of "this word actually means something". A word is
 * distinctive when it is long enough and is neither a stopword, a generic SaaS word, nor an
 * abstraction token. "reddit"/"changelog"/"invoice" → true; "tool"/"signals"/"the" → false.
 */
export function isDistinctiveWord(w: string): boolean {
  const x = w.toLowerCase();
  if (x.length < MIN_ANCHOR_LEN) return false;
  if (ANCHOR_STOPWORDS.has(x) || GENERIC_PRODUCT_WORDS.has(x)) return false;
  if (isBareAbstraction(x)) return false;
  return true;
}

export interface AnchorLexicon {
  /** Distinctive single words — a result containing any one is on-topic. */
  terms: Set<string>;
  /** Competitor names matched as whole phrases (e.g. "google alerts") — strongest signal. */
  phrases: string[];
}

/**
 * Build the topical anchor lexicon — the *distinctive* signals that, if present in a search RESULT,
 * mean the result is genuinely about this product's domain.
 *
 * Two kinds:
 *  - `phrases`: competitor names (proper nouns) matched as whole strings — the strongest, lowest-
 *    false-positive anchor a result can carry ("gummysearch", "google alerts").
 *  - `terms`: single words from the product's vocabulary, AFTER stripping (a) `isBareAbstraction`
 *    tokens and (b) generic SaaS words. What survives is the product-specific lexicon ("changelog",
 *    "invoice", "reddit", "spreadsheet") — words rare enough that their presence really means
 *    on-topic. For an abstraction-saturated ICP almost nothing survives, so `terms` is small and the
 *    validator leans on competitor phrases (and stays conservative — see validateSearchQueries).
 */
export function buildAnchorLexicon(icp: unknown): AnchorLexicon {
  const p = (icp ?? {}) as Record<string, unknown>;
  const competitorNames = [
    ...(Array.isArray(p.competitor_names) ? p.competitor_names : []),
    ...(Array.isArray(p.direct_competitors) ? p.direct_competitors : []),
  ].filter((c): c is string => typeof c === 'string' && c.trim().length >= 3);

  // Only CURATED fields feed the term anchors — product_category and the cluster keywords. Free-text
  // prose (pain_triggers, product_does, primary_use_cases) is first-person sentences full of common
  // English words ("time", "still", "used", "relevant") that match generic posts and inflate false
  // on-topic hits. The curated fields hold the product-specific lexicon ("changelog", "invoice").
  const buckets: unknown[] = [
    p.product_category, p.category,
    ...(Array.isArray(p.keywords) ? p.keywords : []),
  ];
  const clusters = Array.isArray(p.keyword_clusters) ? p.keyword_clusters as Array<Record<string, unknown>> : [];
  for (const c of clusters) {
    if (c.cluster_name === 'competitor_comparison') continue; // "[X] alternative" → "alternative" is not an anchor
    if (Array.isArray(c.keywords)) buckets.push(...c.keywords);
  }

  const terms = new Set<string>();
  for (const b of buckets) {
    if (typeof b !== 'string') continue;
    for (const w of words(b)) {
      if (isDistinctiveWord(w)) terms.add(w);
    }
  }
  return { terms, phrases: [...new Set(competitorNames.map((c) => c.toLowerCase().trim()))] };
}

function resultIsOnTopic(r: RawSourceResult, anchors: AnchorLexicon): boolean {
  const hay = `${r.title ?? ''} ${r.body ?? ''} ${r.community ?? ''}`.toLowerCase();
  for (const ph of anchors.phrases) if (hay.includes(ph)) return true;
  for (const a of anchors.terms) if (hay.includes(a)) return true;
  return false;
}

async function judgeQuery(query: string, anchors: AnchorLexicon, fetcher: SampleFetcher): Promise<QueryVerdict> {
  if (isCompetitorComparison(query)) {
    // Competitor comparisons are never DROPPED (highest intent, legitimately low volume) — but a
    // micro-competitor nobody has ever mentioned ("PRDKit alternative" → 0 matches anywhere) burns
    // a front-loaded retrieval slot on every source for nothing. Probe it: zero matched results →
    // demote to the retrieval tail (it still gets searched, just after queries that return things).
    // The match test is textMatchesKeyword, not raw volume — the probe source word-OR-matches, so
    // "ChatPRD alternative" can fetch loose hits that never mention ChatPRD; those don't count.
    let results: RawSourceResult[] = [];
    try {
      results = await fetcher(query);
    } catch {
      // Inconclusive probe — keep the front-loaded slot.
      return { query, verdict: 'keep-competitor', fetched: 0, onTopic: 0 };
    }
    const matched = results.filter((r) => textMatchesKeyword(`${r.title ?? ''} ${r.body ?? ''}`, query)).length;
    if (matched === 0) {
      return { query, verdict: 'demote-competitor-zerohit', fetched: results.length, onTopic: 0 };
    }
    return { query, verdict: 'keep-competitor', fetched: results.length, onTopic: matched };
  }
  let results: RawSourceResult[] = [];
  try {
    results = await fetcher(query);
  } catch {
    // Probe failed (network/timeout) — never drop on an inconclusive probe.
    return { query, verdict: 'keep-lowvolume', fetched: 0, onTopic: 0 };
  }
  const fetched = results.length;
  const onTopic = results.filter((r) => resultIsOnTopic(r, anchors)).length;

  if (fetched >= MIN_VOLUME_TO_JUDGE && onTopic === 0) {
    return { query, verdict: 'drop-noise', fetched, onTopic };
  }
  return { query, verdict: onTopic > 0 ? 'keep-ontopic' : 'keep-lowvolume', fetched, onTopic };
}

/**
 * Validate every search_query in the ICP's keyword_clusters against a live sample and drop proven
 * noise magnets. Best-effort and conservative: anchors come from the product's own vocabulary, only
 * high-volume/zero-overlap queries are dropped, and a project-level safeguard refuses to strip a
 * cluster down to nothing. Returns the cleaned ICP, the dropped queries, and a per-query report.
 */
export async function validateSearchQueries(
  icp: unknown,
  opts: { fetcher?: SampleFetcher; timeoutMs?: number } = {},
): Promise<ValidationResult> {
  const fetcher = opts.fetcher ?? fetchRawHN;
  const profile = icp as { keyword_clusters?: Array<Record<string, unknown>> };
  if (!profile || !Array.isArray(profile.keyword_clusters)) {
    return { icp, dropped: [], demoted: [], report: [] };
  }

  const anchors = buildAnchorLexicon(icp);
  // Anchors are how we recognise a *real* hit; with none we can't judge, so don't drop anything.
  if (anchors.terms.size === 0 && anchors.phrases.length === 0) return { icp, dropped: [], demoted: [], report: [] };

  // Collect every distinct query once (a query can repeat across clusters).
  const allQueries = new Set<string>();
  for (const c of profile.keyword_clusters) {
    if (Array.isArray(c.search_queries)) for (const q of c.search_queries) if (typeof q === 'string') allQueries.add(q);
  }

  const report = await Promise.all([...allQueries].map((q) => judgeQuery(q, anchors, fetcher)));
  const dropSet = new Set(report.filter((r) => r.verdict === 'drop-noise').map((r) => r.query));
  const demoted = report.filter((r) => r.verdict === 'demote-competitor-zerohit').map((r) => r.query);

  const clusters = dropSet.size === 0 ? profile.keyword_clusters : profile.keyword_clusters.map((c) => {
    if (!Array.isArray(c.search_queries)) return c;
    const kept = (c.search_queries as string[]).filter((q) => !dropSet.has(q));
    // Safeguard: never strip a cluster to zero queries.
    if (kept.length === 0) return c;
    return { ...c, search_queries: kept };
  });

  return {
    // zero_volume_queries persists the demotion so retrieval (icp-config balancedSearchOrder) can
    // push these to the tail on every future fetch without re-probing.
    icp: { ...profile, keyword_clusters: clusters, ...(demoted.length ? { zero_volume_queries: demoted } : {}) },
    dropped: [...dropSet],
    demoted,
    report,
  };
}
