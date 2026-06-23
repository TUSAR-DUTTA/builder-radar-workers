// Social mention filter — DETERMINISTIC, NO AI. This is what keeps the raw share-of-voice
// honest without a model in the loop. Four layers, each targeting a documented BuilderRadar
// noise failure mode:
//   1. Entity match (word-boundary)  → kills substring collisions ("Arc" in "search", "Linear"
//      in "linear regression"). A blunt `includes` was the old leakage bug; we match whole tokens.
//   2. Context gate                  → for short/common-word brand names, require a category/
//      context term to co-occur, so a generic name doesn't match unrelated chatter.
//   3. Noise / chrome / spam drop    → strips boilerplate ("cookie policy", "sign in"), link-spam,
//      job posts, and too-short fragments (the "LinkedIn chrome" failure mode).
//   4. Dedup                         → per-source id + normalized URL + near-duplicate title
//      (the "dedup drift" failure mode), across sources too.
//
// All layers are tunable constants below — no provider, no API key, no model call.

import type { RawSourceResult } from '@/lib/raw-source-search';

// ── normalization ──────────────────────────────────────────────────────────────
// Lowercase, collapse every non-alphanumeric run to a single space, and pad with spaces so a
// phrase test (` token `) is a true word-boundary match at string edges too.
function norm(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

// A brand name is "ambiguous" (needs the context gate) when it's a SINGLE token. Single-word
// names collide with ordinary English ("Profound" the adjective), other products of the same
// name ("GrowthOS" the Web3 launchpad), or @handles — regardless of length, so a blunt length
// threshold let "Profound"/"GrowthOS" (8 chars) bypass the gate and flood share-of-voice with
// noise. Share-of-voice wants precision over recall: a single-token name only counts inside a
// product/category context. Multi-word names ("Peec AI", "Builder Radar") are specific enough
// on their own and skip the gate.
function isAmbiguous(entity: string): boolean {
  const tokens = norm(entity).trim().split(' ').filter(Boolean);
  return tokens.length === 1;
}

// Generic "this is a software/product discussion" words. They satisfy the context gate for an
// ambiguous brand name even when the project has no category data and no sibling competitor is
// named — so "Notion app", "Notion vs Obsidian", "Notion pricing" all count, while "a notion of
// fairness" (no product word) is still dropped. Deterministic; no AI.
const PRODUCT_CONTEXT = [
  'app', 'apps', 'tool', 'tools', 'software', 'platform', 'saas', 'startup', 'product',
  'workspace', 'note', 'notes', 'notetaking', 'doc', 'docs', 'document', 'wiki', 'database',
  'productivity', 'project', 'task', 'crm', 'dashboard', 'integration', 'integrations',
  'alternative', 'alternatives', 'vs', 'versus', 'pricing', 'plan', 'plans', 'subscription',
  'freemium', 'selfhosted', 'opensource', 'plugin', 'api', 'feature', 'features', 'review', 'reviews',
];

// Wrong-namesake markers: strong signals that a single-token name belongs to a DIFFERENT product
// in another industry that happens to share the name (the documented "GrowthOS the Web3 launchpad"
// collision). When one of these sits next to an ambiguous name AND no project-specific term does,
// the mention is the wrong product and is dropped. Self-correcting: if the project's OWN category
// is one of these (a real crypto SaaS), that term becomes a SPECIFIC gate and wins first.
const NEGATIVE_NAMESAKE = [
  'web3', 'crypto', 'cryptocurrency', 'blockchain', 'nft', 'nfts', 'defi', 'dao', 'token', 'tokens',
  'tokenomics', 'launchpad', 'presale', 'staking', 'airdrop', 'memecoin', 'solana', 'ethereum', 'bitcoin',
];

// ── Layer 1 + 2: entity match with context gate ─────────────────────────────────
/**
 * Does `text` genuinely mention `entity` (word-boundary), and — for ambiguous names — within the
 * project's `contextTerms`? Pass an empty contextTerms to skip the gate (degrades gracefully when
 * the project has no category signal).
 */
// How close (chars) a context term must sit to the entity mention to satisfy the gate. A term
// merely co-occurring somewhere in a long post isn't enough — "a profound idea … [long post] …
// my app" must NOT count. ~60 chars ≈ the same clause/sentence as the name.
const PROXIMITY_WINDOW = 60;

export function matchesEntity(
  text: string,
  entity: string,
  contextTerms: string[] = [],
  // Set when an out-of-band disambiguator already proved this is the right product (e.g. the post
  // links the brand's own domain or @handle). The name still has to appear, but the ambiguity gate
  // below is skipped so a genuine on-domain mention is never dropped for lacking a nearby keyword.
  skipAmbiguityGate = false,
): boolean {
  const phrase = norm(entity).trim();
  if (!phrase) return false;
  const haystack = norm(text);
  const needle = ` ${phrase} `;
  if (!haystack.includes(needle)) return false; // whole-token / whole-phrase boundary match

  // Distinctive multi-word names (most competitors) are specific enough and skip the gate; so do
  // mentions an external disambiguator already confirmed.
  if (!isAmbiguous(entity) || skipAmbiguityGate) return true;

  // Ambiguous (single-token) names must appear NEAR a context term, or they're dropped as collisions
  // ("Profound" the adjective, "GrowthOS" the unrelated product). We rank the nearby evidence:
  //   • SPECIFIC term (the project's category or a sibling competitor) → the real product → keep.
  //   • GENERIC product word ("app", "pricing", "vs") → keep, UNLESS a wrong-namesake marker
  //     (web3/crypto/…) is also near, which means a different same-named product → drop.
  // This separation is what fixes the same-name/different-product collisions that a flat keyword
  // gate let through, without dropping genuine "Notion app / Notion vs Obsidian" chatter.
  const specific = contextTerms.map((c) => norm(c).trim()).filter(Boolean);
  const generic = PRODUCT_CONTEXT.map((c) => norm(c).trim()).filter(Boolean);
  if (specific.length === 0 && generic.length === 0) return false;
  const near = (window: string, terms: string[]) => terms.some((c) => window.includes(` ${c} `));
  for (let idx = haystack.indexOf(needle); idx !== -1; idx = haystack.indexOf(needle, idx + needle.length)) {
    const start = Math.max(0, idx - PROXIMITY_WINDOW);
    const end = Math.min(haystack.length, idx + needle.length + PROXIMITY_WINDOW);
    const window = ` ${haystack.slice(start, end)} `;
    if (near(window, specific)) return true;                                   // project-specific → real product
    if (near(window, generic) && !near(window, NEGATIVE_NAMESAKE)) return true; // generic, no wrong-namesake marker
  }
  return false;
}

// ── Layer 3: noise / chrome / spam ──────────────────────────────────────────────
const CHROME_FRAGMENTS = [
  'cookie policy', 'accept cookies', 'sign in', 'log in to', 'create an account',
  'subscribe to our newsletter', 'privacy policy', 'terms of service', 'all rights reserved',
  'enable javascript', 'your browser', 'skip to content',
];
const JOB_MARKERS = ['we are hiring', 'we re hiring', 'now hiring', 'apply now', 'job opening', 'job posting', 'full time remote'];
// Floor for a meaningful mention. Kept low so short-form posts (tweets like "love Notion") still
// count — the chrome/spam gates below are length-independent and do the real noise removal, so this
// only drops near-empty matches, not genuine short mentions.
const MIN_TEXT_LEN = 12;

/** True if this result is boilerplate/spam/too-thin and should NOT count as a mention. */
export function isNoise(r: RawSourceResult): boolean {
  const title = (r.title ?? '').trim();
  const body = (r.body ?? '').trim();
  const combined = `${title} ${body}`.trim();
  if (combined.replace(/\s+/g, ' ').length < MIN_TEXT_LEN && title.length < MIN_TEXT_LEN) return true;

  const low = norm(combined);
  if (CHROME_FRAGMENTS.some((f) => low.includes(` ${f} `))) return true;
  if (JOB_MARKERS.some((f) => low.includes(` ${f} `))) return true;

  // Link-spam: body is mostly URLs (few words once links are stripped).
  if (body) {
    const noLinks = body.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
    const urlCount = (body.match(/https?:\/\/\S+/g) ?? []).length;
    if (urlCount >= 3 && noLinks.split(' ').filter(Boolean).length < 12) return true;
  }
  return false;
}

// ── Layer 4: dedup ──────────────────────────────────────────────────────────────
function normUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
function titleKey(title: string | null): string {
  return norm(title ?? '').trim().slice(0, 80);
}

/** Drop duplicates by (source:externalId), by normalized URL, and by near-identical title. */
export function dedupe(results: RawSourceResult[]): RawSourceResult[] {
  const seenId = new Set<string>();
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  const out: RawSourceResult[] = [];
  for (const r of results) {
    const id = `${r.source}:${r.externalId}`;
    const u = normUrl(r.url);
    const tk = titleKey(r.title);
    if (seenId.has(id) || seenUrl.has(u) || (tk.length >= 24 && seenTitle.has(tk))) continue;
    seenId.add(id);
    seenUrl.add(u);
    if (tk.length >= 24) seenTitle.add(tk);
    out.push(r);
  }
  return out;
}

/** A post is unambiguously about the brand when it links the brand's own domain or names its
 *  @handle — a deterministic disambiguator for single-token names ("is this GrowthOS the right
 *  one? yes — it links growthos's own site / names @growthos"). Only ever CONFIRMS, never drops. */
function referencesSelf(r: RawSourceResult, selfDomain?: string, selfHandle?: string): boolean {
  const hay = `${r.title ?? ''} ${r.body ?? ''} ${r.url ?? ''}`.toLowerCase();
  if (selfDomain) {
    const d = selfDomain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (d && hay.includes(d)) return true;
    try { if (d && new URL(r.url).hostname.replace(/^www\./, '').toLowerCase().endsWith(d)) return true; } catch { /* bad url */ }
  }
  if (selfHandle) {
    const h = selfHandle.toLowerCase().replace(/^@/, '');
    if (h && (r.author?.toLowerCase().replace(/^@/, '') === h || hay.includes(`@${h}`))) return true;
  }
  return false;
}

/**
 * Full filter pass for ONE entity's raw results: keep only genuine, in-context, non-noise,
 * deduped mentions. `contextTerms` come from the project's category/keywords. `opts.selfDomain`
 * / `opts.selfHandle` (brand only) let an on-domain / @handle mention bypass the ambiguity gate.
 */
export function filterMentions(
  results: RawSourceResult[],
  entity: string,
  contextTerms: string[] = [],
  opts: { selfDomain?: string; selfHandle?: string } = {},
): RawSourceResult[] {
  const kept = results.filter((r) => {
    if (isNoise(r)) return false;
    const text = `${r.title ?? ''} ${r.body ?? ''} ${r.community ?? ''}`;
    const confirmed = referencesSelf(r, opts.selfDomain, opts.selfHandle);
    return matchesEntity(text, entity, contextTerms, confirmed);
  });
  return dedupe(kept);
}
