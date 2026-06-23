/**
 * Deterministic concrete-query generator.
 *
 * The LLM reliably FAILS to produce concrete buyer-language search queries — it emits abstractions
 * ("buyer intent", "target customer") that the filters then strip, leaving a project with only a few
 * low-volume competitor "[X] alternative" queries and a thin feed. Cleaning can't create what the
 * model never wrote, so this builds concrete queries deterministically from sources the model
 * ignores: the platform names + domain phrasing in the raw project description, and the grounded
 * competitor list. It then prunes any junk against a live sample (the same HN probe the validator
 * uses) so a bad synthesized phrase can't add noise.
 *
 * Three deterministic sources, in precision order:
 *   1. Competitor "[X] alternative" — highest intent, always kept.
 *   2. Platform-intent templates — for a monitoring/listening product, the platforms named in the
 *      description ("watches Reddit, Hacker News, GitHub…") become "reddit monitoring",
 *      "track reddit mentions" etc. This is exactly how that buyer searches.
 *   3. Distinctive domain n-grams mined from the description — the general fallback for products with
 *      no platforms/competitors (e.g. "invoice reconciliation", "changelog tool").
 */
import { fetchRawHN } from './raw-source-search';
import { isBareAbstraction, productOwnNames } from './prompts/icp-extract';
import { isDistinctiveWord, validateSearchQueries, type SampleFetcher } from './query-validation';
import { sanitizeCompetitorNames } from './sanitize-competitors';

export interface GeneratedQueries {
  queries: string[];
  /** OR-combined competitor query — one search that catches a mention of ANY competitor. */
  combinedCompetitorQuery: string | null;
  sources: { competitor: string[]; platform: string[]; ngram: string[] };
  dropped: string[];
}

// Canonical platform search terms + how to detect them in free text. Order = prominence priority.
const PLATFORMS: { match: RegExp; term: string }[] = [
  { match: /\breddit\b|\bsubreddits?\b/i, term: 'reddit' },
  { match: /\bhacker ?news\b|\bhn\b/i, term: 'hacker news' },
  { match: /\b(?:twitter|tweets?)\b|\bx \(twitter\)/i, term: 'twitter' },
  { match: /\bgithub\b/i, term: 'github' },
  { match: /\bstack ?overflow\b/i, term: 'stack overflow' },
  { match: /\bproduct ?hunt\b/i, term: 'product hunt' },
  { match: /\blinkedin\b/i, term: 'linkedin' },
  { match: /\bdiscord\b/i, term: 'discord' },
  { match: /\bslack\b/i, term: 'slack' },
  { match: /\byoutube\b/i, term: 'youtube' },
  { match: /\bquora\b/i, term: 'quora' },
];

// The product is a monitoring/listening/alerting type → platform-intent templates make sense.
const MONITORING_INTENT = /\bmonitor|\btrack(?:ing|s)?\b|\balert|\blisten|\bwatch|\bmention|\bscan|\bnotif|\bsignals?\b|\bscrape|\bcrawl/i;

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
const tokens = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

const PHRASE_EDGE_STOPWORDS = new Set([
  'the', 'a', 'an', 'my', 'our', 'your', 'their', 'for', 'of', 'to', 'and', 'or', 'in', 'on', 'at',
  'with', 'from', 'by', 'as', 'is', 'are', 'be', 'so', 'that', 'this', 'it', 'they', 'we', 'i',
  'across', 'into', 'how', 'what', 'when', 'where', 'which', 'who', 'can', 'cant', 'still', 'every',
]);

function detectPlatforms(text: string): string[] {
  const found: string[] = [];
  for (const p of PLATFORMS) if (p.match.test(text)) found.push(p.term);
  return found;
}

function competitorNames(icp: unknown): string[] {
  const p = (icp ?? {}) as Record<string, unknown>;
  // sanitizeCompetitorNames strips agent/tool-trace leaks ("Read 1 file") so they never become
  // "<name> alternative" retrieval queries; the length>=2 guard drops single-char fragments.
  const names = sanitizeCompetitorNames([
    ...(Array.isArray(p.competitor_names) ? p.competitor_names : []),
    ...(Array.isArray(p.direct_competitors) ? p.direct_competitors : []),
  ]).filter((c) => c.trim().length >= 2);
  // Honor the adjacent_alternatives exclusion: never emit "[X] alternative" for a channel/marketplace
  // the product merely bypasses (Mention/Brand24 for a Reddit-listening tool) even when the project.md
  // promoted it into competitor_names — a "Mention alternative" search returns brand-PR/news people.
  const adjacent = new Set(
    (Array.isArray(p.adjacent_alternatives) ? p.adjacent_alternatives : [])
      .filter((c): c is string => typeof c === 'string')
      .map((c) => c.toLowerCase().trim()),
  );
  return [...new Set(names.map((c) => c.trim()))].filter((c) => !adjacent.has(c.toLowerCase()));
}

/**
 * Mine 2-3 word noun phrases from the description that read like a real domain term: no stopword at
 * either edge, not a bare abstraction, and at least one DISTINCTIVE word (so "customer pain" /
 * "the tool" are rejected but "invoice reconciliation" / "changelog tool" survive). Ranked by how
 * often the phrase recurs in the text.
 */
function distinctiveNgrams(text: string, limit: number, exclude: Set<string>): string[] {
  const counts = new Map<string, number>();
  for (const sentence of text.split(/[.!?\n]+/)) {
    const ws = tokens(sentence);
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= ws.length; i++) {
        const slice = ws.slice(i, i + n);
        if (PHRASE_EDGE_STOPWORDS.has(slice[0]) || PHRASE_EDGE_STOPWORDS.has(slice[n - 1])) continue;
        const phrase = slice.join(' ');
        if (isBareAbstraction(phrase)) continue;
        // Require a distinctive word that ISN'T already a platform/competitor token — otherwise the
        // n-gram is just a list fragment ("reddit hacker") or a competitor name ("google alerts")
        // already covered by the template/alternative queries, and adds only noise.
        if (!slice.some((w) => isDistinctiveWord(w) && !exclude.has(w))) continue;
        counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([phrase]) => phrase)
    .slice(0, limit);
}

/** One OR-combined query catching any competitor mention in a single search (multi-keyword). */
export function buildCombinedCompetitorQuery(names: string[]): string | null {
  const picked = names.slice(0, 6);
  if (picked.length < 2) return null;
  return picked.map((n) => (n.includes(' ') ? `"${n}"` : n)).join(' OR ');
}

/**
 * Generate concrete search queries deterministically, then prune live-noise magnets. `fetcher`
 * defaults to HN Algolia (works on serverless; Reddit JSON 403s there) and is injectable for tests.
 */
export async function generateConcreteQueries(
  rawMd: string,
  icp: unknown,
  opts: { fetcher?: SampleFetcher; max?: number } = {},
): Promise<GeneratedQueries> {
  const fetcher = opts.fetcher ?? fetchRawHN;
  const max = opts.max ?? 14;

  const comps = competitorNames(icp);
  const competitor = comps.slice(0, 8).map((n) => `${n} alternative`);

  // Detect platforms + monitoring intent from the human-written description ONLY — NOT the serialized
  // ICP. Including JSON.stringify(icp) here leaked BuilderRadar's own category into every project:
  // target_communities always embed "reddit"/"hacker news", and MONITORING_INTENT matches the
  // ubiquitous word "track" ("error tracking", "track expenses", "track decisions"), so unrelated
  // products (a dental scheduler, a freelancer budgeting app) were handed "reddit monitoring" /
  // "track reddit mentions" queries. A genuine monitoring product still fires — its rawMd says so
  // ("watches Reddit, Hacker News, and X").
  const platformTerms = detectPlatforms(rawMd).slice(0, 4);
  const isMonitoring = MONITORING_INTENT.test(rawMd);
  const platform = isMonitoring
    ? platformTerms.flatMap((p) => [`${p} monitoring`, `track ${p} mentions`])
    : [];

  // Exclude platform + competitor + own-product tokens from n-gram "novelty" so fragments like
  // "reddit hacker" (both platforms), "google alerts" (a competitor), or "leadhunt watches reddit"
  // (the product's own name) don't masquerade as new domain phrases.
  const ownNames = productOwnNames(icp as { project_name?: unknown; product_name?: unknown }, rawMd);
  const ownTokens = new Set(ownNames.flatMap((n) => tokens(n)).filter((w) => w.length >= 4));
  const excludeTokens = new Set<string>([
    ...platformTerms.flatMap((p) => tokens(p)),
    ...comps.flatMap((c) => tokens(c)),
    ...ownTokens,
  ]);
  const ngram = distinctiveNgrams(rawMd, 12, excludeTokens);

  // Assemble in precision order, de-duped (case-insensitive). Drop any query that still carries the
  // product's own name (belt-and-suspenders for the n-gram exclusion above).
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const q of [...competitor, ...platform, ...ngram]) {
    const key = norm(q);
    if (!key || seen.has(key)) continue;
    if (ownTokens.size && tokens(q).some((w) => ownTokens.has(w))) continue;
    seen.add(key);
    ordered.push(q);
  }

  // Prune live-noise magnets. Feed an ICP whose anchors include platform terms + distinctive ngram
  // words so the validator can recognise on-topic results for the generated queries (not just the
  // original competitor names). Competitor "[X] alternative" stays exempt inside the validator.
  const anchorKeywords = [...platformTerms, ...ngram];
  const syntheticIcp = {
    ...(icp as Record<string, unknown>),
    keyword_clusters: [
      { cluster_name: 'generated', keywords: anchorKeywords, search_queries: ordered },
    ],
  };
  const { dropped } = await validateSearchQueries(syntheticIcp, { fetcher });
  const dropSet = new Set(dropped);

  const queries = ordered.filter((q) => !dropSet.has(q)).slice(0, max);

  return {
    queries,
    combinedCompetitorQuery: buildCombinedCompetitorQuery(comps),
    sources: { competitor, platform, ngram },
    dropped,
  };
}
