// GEO engine — the reusable core shared by the daily cron and the concierge script.
// Provider-agnostic: takes an AIRouter, returns structured visibility data.
// See GEO_PIVOT_DESIGN.md. Honesty: this measures API-sampled AI answer visibility (consumer
// UIs can differ ~25%); a single call is one sample — weekly aggregation is what de-noises it.

import type { AIRouter, GroundedAnswer } from '@/lib/ai-router';
import { sanitizeCompetitorNames } from '@/lib/sanitize-competitors';
import type {
  UrlExtraction, AnswerSample, ShareRow, SourceRow, Verdict, AnswerModel, PromptIntent,
  BrandFact, AnswerClaim, AnswerAudit, ClaimStatus, AccuracyFlag, AccuracyAlertRow, Remediation, WinnerReason,
} from './types';

// ── URL → brand / category / competitors / prompt battery ─────────────────────

const EXTRACT_SYSTEM = `You are preparing an AI-search visibility audit for the company whose homepage copy is given.
Return ONLY a JSON object:
{
  "brand": "the product/company name",
  "category": "the category a buyer compares it in (e.g. 'uptime monitoring for SaaS')",
  "persona": "who has budget and urgency (e.g. 'founder of a small B2B SaaS')",
  "competitors": ["3-6 DIRECT competitors a buyer evaluates head-to-head; [] if unsure — never invent"],
  "prompts": [{"prompt": "buyer question", "intent": "category|competitor_alt|brand_direct|comparison|other"}]
}
Prompt rules (these decide audit quality):
- Phrase as a BUYER asks, not a marketer: "best [category] for [persona]", "[Competitor] alternatives", "is [brand] worth it", "[Competitor] vs [Competitor]".
- HIGH-INTENT FIRST: the MAJORITY of prompts must be category ("best [category] for [persona]", "how to [job]") and competitor discovery ("[Competitor] alternatives", "[Competitor] vs [Competitor]"). These are where being absent actually means lost demand.
- >=3 prompts must NOT name any brand (intent "category").
- >=2 must be "[Competitor] alternative(s)" using the competitors you listed (intent "competitor_alt"). If you listed NO competitors, leave these out — they'll be added once rivals are known.
- AT MOST 2 brand_direct prompts ("is [brand] worth it", "[brand] reviews"). A little-known brand is trivially absent from these, so they carry almost no signal — do not pad the battery with them.
- No marketing abstractions ("solutions", "leverage", "optimize") — concrete buyer language.`;

function extractJson<T>(text: string): T {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`No JSON object in response: ${text.slice(0, 160)}`);
  return JSON.parse(text.slice(start, end + 1)) as T;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse a competitor list from model output — a JSON array OR a comma/newline/semicolon list (grounded
// answers often reply in prose). Strips bullets/numbering, drops the brand itself, and runs the shared
// tool-trace sanitizer so agent-scratchpad junk never reaches the share-of-answers entities.
function parseCompetitorList(text: string, brand: string): string[] {
  let names: string[] = [];
  const s = text.indexOf('['), e = text.lastIndexOf(']');
  if (s >= 0 && e > s) {
    try { const arr = JSON.parse(text.slice(s, e + 1)); if (Array.isArray(arr)) names = arr.map((x) => String(x)); } catch { /* fall through to text split */ }
  }
  if (names.length === 0) {
    names = text
      .replace(/^[\s\S]*?:\s*/, '')                       // drop any "Here are the competitors:" preamble
      .split(/[,\n;]+/)
      .map((n) => n.replace(/^[\s\d.)*\-•]+/, '').replace(/[.\s]+$/, '').trim());
  }
  const brandLc = brand.trim().toLowerCase();
  return sanitizeCompetitorNames(names).filter((n) => n.toLowerCase() !== brandLc);
}

// Discover the REAL, same-category head-to-head competitors for a brand whose own homepage names none.
// Grounded web search first: it returns the products actually shipping in a new/niche category (the
// non-grounded base model instead reaches for the famous ADJACENT-category leaders — e.g. SEMrush/Ahrefs
// for an AI-answer-tracking tool — which are the wrong rivals and make the whole report useless). A
// non-grounded pass is the last resort; we return [] rather than guess, because a wrong rival is worse
// than no rival.
async function discoverCompetitors(router: AIRouter, brand: string, category: string): Promise<string[]> {
  const ask =
    `What products does a buyer compare head-to-head with "${brand}" in the category "${category}"? ` +
    `List ONLY real, currently-shipping products in THIS SAME category — never tools from a broader or adjacent ` +
    `category (for example, for an AI-answer / generative-engine-optimization tracker, do NOT list traditional SEO ` +
    `suites like SEMrush, Ahrefs, Moz or Surfer SEO). Exclude "${brand}". ` +
    `Answer with ONLY a comma-separated list of 3-6 product names.`;
  try {
    const res = await router.geminiGrounded(ask);
    const names = parseCompetitorList(res.text, brand);
    if (names.length >= 2) return names.slice(0, 6);
  } catch { /* grounding unavailable — fall back to the non-grounded pass */ }
  try {
    const raw = await router.geminiComplete({
      messages: [{ role: 'user', content: `${ask}\nReturn ONLY a JSON array of strings, e.g. ["Profound","Peec AI"].` }],
      jsonMode: true,
      maxTokens: 256,
    });
    const names = parseCompetitorList(raw, brand);
    if (names.length >= 2) return names.slice(0, 6);
  } catch { /* leave empty — better than a hallucinated head-to-head */ }
  return [];
}

const INTENT_PRIORITY: Record<PromptIntent, number> = {
  category: 0, competitor_alt: 1, comparison: 2, brand_direct: 3, other: 4,
};

// Rebalance the prompt battery toward HIGH-INTENT buyer discovery. An unknown brand is trivially
// "absent" from "is <brand> worth it?"-style brand_direct prompts (the AI has no data on it), so those
// carry no signal — the prompts that matter are category ("best X for Y"), "[Competitor] alternatives",
// and head-to-head comparisons. The model can only write competitor_alt prompts once the real rivals are
// known (and it returns none for a site that names no competitors), so we synthesize them here, cap the
// low-signal brand_direct prompts, de-dupe, and order high-intent first — so the free teaser, which only
// samples the first few, hits the prompts that actually reveal where the brand loses.
function rebalancePrompts(
  prompts: { prompt: string; intent: PromptIntent }[],
  competitors: string[],
  promptCount: number,
): { prompt: string; intent: PromptIntent }[] {
  const seen = new Set<string>();
  const out: { prompt: string; intent: PromptIntent }[] = [];
  const add = (p: { prompt: string; intent: PromptIntent }) => {
    const key = p.prompt.trim().toLowerCase();
    if (!p.prompt.trim() || seen.has(key)) return;
    seen.add(key); out.push(p);
  };
  // The comparison prompts the model couldn't write until we discovered the real rivals.
  for (const c of competitors.slice(0, 3)) add({ prompt: `${c} alternatives`, intent: 'competitor_alt' });
  let brandDirect = 0;
  for (const p of [...prompts].sort((a, b) => INTENT_PRIORITY[a.intent] - INTENT_PRIORITY[b.intent])) {
    if (p.intent === 'brand_direct' && ++brandDirect > 2) continue; // cap low-signal brand_direct
    add(p);
  }
  return out
    .sort((a, b) => INTENT_PRIORITY[a.intent] - INTENT_PRIORITY[b.intent])
    .slice(0, promptCount);
}

export async function extractFromCopy(
  router: AIRouter,
  siteCopy: string,
  opts?: { promptCount?: number; brand?: string; competitors?: string[] },
): Promise<UrlExtraction> {
  const promptCount = Math.min(25, Math.max(6, opts?.promptCount ?? 12));
  const raw = await router.geminiComplete({
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: `Produce ${promptCount} prompts.\n\nHOMEPAGE COPY:\n${siteCopy.slice(0, 4000)}` },
    ],
    jsonMode: true,
    maxTokens: 2048,
  });
  const ex = extractJson<{
    brand: string; category: string; persona: string;
    competitors?: string[];
    prompts?: Array<{ prompt: string; intent?: string }>;
  }>(raw);

  const intents: PromptIntent[] = ['category', 'competitor_alt', 'brand_direct', 'comparison', 'other'];
  const prompts = (ex.prompts ?? [])
    .filter((p) => p.prompt?.trim())
    .slice(0, promptCount)
    .map((p) => ({
      prompt: p.prompt.trim(),
      intent: (intents.includes(p.intent as PromptIntent) ? p.intent : 'other') as PromptIntent,
    }));

  const brandName = opts?.brand ?? ex.brand;
  let competitors = sanitizeCompetitorNames(opts?.competitors?.length ? opts.competitors : ex.competitors ?? [])
    .filter((c) => c.toLowerCase() !== brandName.trim().toLowerCase())
    .slice(0, 6);

  // The homepage extraction is deliberately strict ("never invent"), so a site that doesn't name
  // rivals yields []. Share-of-answers needs the REAL, same-category head-to-head products, so we
  // discover them with a grounded search (see discoverCompetitors — this is what fixes the old
  // "SEMrush/Ahrefs for a GEO tool" wrong-rival bug). Only when the caller didn't pin competitors.
  if (competitors.length === 0 && !opts?.competitors?.length) {
    competitors = await discoverCompetitors(router, brandName, ex.category);
  }

  // High-intent battery: now that we know the real competitors, synthesize the "[Competitor]
  // alternatives" prompts the model couldn't write earlier, cap low-signal brand_direct prompts, and
  // order the highest-intent prompts first (so the free teaser samples the ones that actually matter).
  const finalPrompts = rebalancePrompts(prompts, competitors, promptCount);

  const result: UrlExtraction = {
    brand: brandName,
    category: ex.category,
    persona: ex.persona,
    competitors,
    prompts: finalPrompts,
  };
  if (!result.brand || result.prompts.length < 5) {
    throw new Error(`Extraction too thin: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return result;
}

// ── Deterministic name-appearance gate ───────────────────────────────────────
// The single biggest precision lever: a product CANNOT be "recommended"/"named" if its name
// isn't actually in the answer. The LLM judge sometimes returns a positive verdict anyway — a
// hallucination, or a same-/similar-name collision ("Building Radar" scored as "BuilderRadar").
// This boundary-exact check vetoes those, for the brand AND every competitor, on every engine
// (the Playwright worker calls judgeAnswer too, so it's covered without touching worker code).

// Suffix tokens the judge is told to ignore (".com" / "HQ" / "App" / "AI"). Stripped from the
// TRAILING end of a name so "Otterly" still matches an answer that wrote "Otterly.AI".
const NAME_SUFFIX_TOKENS = new Set(['ai', 'io', 'com', 'app', 'hq', 'inc', 'co', 'net', 'org', 'labs', 'xyz', 'dev']);

/** Lowercase → alphanumeric word tokens (punctuation/spacing become boundaries). */
function nameTokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/**
 * Deterministic, boundary-exact "does this product name actually appear in `answer`?".
 * Reused by the judge gate (veto a hallucinated verdict) and the brand-confusion guard.
 *
 * Why not a naive substring: "Arc" must not match "search" and "Notion" must not match
 * "notional" — so we compare the name against WHOLE answer words and 2–4 consecutive-word
 * concatenations (so "Builder Radar" / "BuilderRadar" / "builder-radar" all match, but
 * "Building Radar" does NOT). Trailing suffix tokens the judge ignores are stripped so a name
 * stored as "Otterly.AI" still matches a bare "Otterly".
 */
export function entityAppears(answer: string, name: string): boolean {
  const nameToks = nameTokens(name);
  const full = nameToks.join('');
  if (full.length < 2) return false; // nothing distinctive enough to gate on
  const core = [...nameToks];
  while (core.length > 1 && NAME_SUFFIX_TOKENS.has(core[core.length - 1])) core.pop();
  const coreJoined = core.join('');

  const words = nameTokens(answer);
  for (let i = 0; i < words.length; i++) {
    let concat = '';
    for (let n = 0; n < 4 && i + n < words.length; n++) {
      concat += words[i + n];
      if (concat === full || concat === coreJoined) return true;
      if (concat.length > full.length) break; // only grows from here — can't become a match
    }
  }
  return false;
}

// ── Answer judging: recommended vs named vs absent ────────────────────────────

const JUDGE_SYSTEM = `You judge how an AI assistant's answer treats a list of products.
For EACH product name return one of:
- "recommended": endorsed, listed as a top/best option, or suggested to choose.
- "named": appears but not endorsed (passing mention, neutral comparison, or negative).
- "absent": does not appear (match case-insensitively, ignore suffixes like ".com"/"HQ"/"App").
Return ONLY JSON: {"<exact product name>": "recommended|named|absent", ...} with EXACTLY the given names as keys.`;

export async function judgeAnswer(
  router: AIRouter,
  answer: string,
  entities: string[],
): Promise<Record<string, Verdict>> {
  const raw = await router.geminiComplete({
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      // Judge the FULL stored answer (runs persist answer.slice(0, 8000)). A 6000-char cap here
      // hid tail entities from the judge: a grounded "best tools" answer mentioned "Peec AI" at
      // char 6597 and it was scored "absent". 8000 matches the storage cap so the judge never
      // sees more than what's saved/shown.
      { role: 'user', content: `PRODUCT NAMES: ${JSON.stringify(entities)}\n\nANSWER:\n${answer.slice(0, 8000)}` },
    ],
    jsonMode: true,
    maxTokens: 1024,
  });
  let parsed: Record<string, string> = {};
  try { parsed = extractJson<Record<string, string>>(raw); } catch { /* fall through → all absent */ }
  const out: Record<string, Verdict> = {};
  for (const e of entities) {
    const v = (parsed[e] ?? 'absent').toLowerCase();
    let verdict: Verdict = v === 'recommended' || v === 'named' ? (v as Verdict) : 'absent';
    // Deterministic precision gate: a product can't be recommended/named if its name isn't in the
    // answer. Veto any positive verdict the text doesn't literally support — kills judge
    // hallucinations and same-name collisions for the brand AND competitors (so phantom competitor
    // "wins" that fabricate losses disappear too). Only ever downgrades, never promotes.
    if (verdict !== 'absent' && !entityAppears(answer, e)) verdict = 'absent';
    out[e] = verdict;
  }
  return out;
}

// ── Brand-mention confusion guard ─────────────────────────────────────────────
// The LLM judge sometimes scores a DIFFERENT, similarly-named product as the brand: an answer
// about "Building Radar" (a construction-leads tool) gets counted as a win for "BuilderRadar".
// A brand "mention" only counts when the brand name LITERALLY appears (normalised) AND the
// accuracy audit didn't detect entity confusion; otherwise it's a different company, so we score
// it absent and surface it as a confusion alert rather than as visibility. Brand-only — competitors
// keep pure LLM judging, since requiring a literal match would mishandle generic competitor names.

/**
 * Case/space/punctuation-insensitive: does the brand name literally appear in the answer?
 * Delegates to the shared boundary-exact check so the brand guard and the judge gate agree
 * (and so the brand benefits from "Building Radar" ≠ "BuilderRadar" instead of naive substring,
 * which used to count "arc" inside "search").
 */
export function brandNameAppears(answer: string, brand: string): boolean {
  return entityAppears(answer, brand);
}

/** The audit fact-checked a "what category/industry is this" claim and it conflicts with the
 *  brand's known category — a strong, deterministic confusion signal (the answer is describing a
 *  different product). Catches the name-PRESENT-but-wrong-product case even when the LLM's own
 *  entityConfusion flag misfired (the failure mode seen on some engines). */
function categoryContradicted(audit: AnswerAudit | null | undefined): boolean {
  return !!audit?.claims?.some(
    (c) => c.status === 'contradicted' && (c.factKey === 'category' || /\bcategory\b|\bindustry\b/i.test(c.attribute)),
  );
}

/**
 * Resolve the brand's stored verdict, guarding against the judge fuzzy-matching a different
 * same-ish-named product. Returns absent (+ confused=true) when the brand name doesn't literally
 * appear OR the audit flagged entity confusion; otherwise the judge's verdict stands. The
 * deterministic name check robustly catches the name-absent class (e.g. "Building Radar"); the
 * audit's entityConfusion is the best-effort net for the name-present-but-wrong-product class.
 */
export function resolveBrandConfusion(
  answer: string,
  brand: string,
  rawVerdict: Verdict | undefined,
  audit: AnswerAudit | null | undefined,
): { verdict: Verdict; confused: boolean } {
  const v = rawVerdict ?? 'absent';
  if (v === 'absent') return { verdict: 'absent', confused: false };
  const confused = !brandNameAppears(answer, brand) || audit?.entityConfusion === true || categoryContradicted(audit);
  return confused ? { verdict: 'absent', confused: true } : { verdict: v, confused: false };
}

/**
 * Enforce the audit prompt's OWN contract — "if the brand is ABSENT from the answer, entityConfusion
 * MUST be false" — deterministically, because the judge LLM violates it. On plain category/competitor
 * answers where the brand simply doesn't appear, the judge sometimes still returns entityConfusion:true,
 * which surfaced as a false "AI confused you with another company" alert on answers that never mentioned
 * the brand (86% of confusion flags on a real project were this). We keep entityConfusion ONLY when it's
 * verifiable: either the brand verdict was a real mention the guard reclassified (`confused` — e.g. the
 * judge counted a "Building Radar" look-alike as a win) OR the brand name literally appears (name-present-
 * but-wrong-product). Otherwise it's an unverifiable flag on an absent brand, so we drop it. Single source
 * of truth for every answer_runs writer (cron, worker, kickoff) so they can't drift.
 */
export function gateConfusion(
  audit: AnswerAudit | null | undefined,
  answer: string,
  brand: string,
  confused: boolean,
): AnswerAudit | null {
  if (!audit) return null;
  if (audit.entityConfusion && !confused && !brandNameAppears(answer, brand)) {
    return { ...audit, entityConfusion: false };
  }
  return audit;
}

// ── Accuracy engine: fact sheet + answer fact-check ───────────────────────────
// Runs on the idle Groq pool (pure classification, no web). Detection is high-confidence;
// the FIX is slow (model refresh cycles take weeks–months), so the product surfaces this as
// "detected → here's the gap → we track if it closes", never as a fast fix.

const FACTS_SYSTEM = `You build a verifiable FACT SHEET for a company from its site copy, so AI assistants' claims about it can later be fact-checked.
Return ONLY JSON: {"facts":[{"key","value","verbatim","confidence"}]}
Rules:
- Emit a fact ONLY if the copy states it EXPLICITLY. Never infer, never guess. When unsure, omit it — a missing fact is correct, a guessed fact is harmful.
- Use stable dotted keys: security.soc2, security.gdpr, security.hipaa, security.sso, integration.<name>, feature.<name>, category, founded, ownership, platform.
- PRICING — do this precisely; tier confusion is the #1 cause of false alarms:
  • Emit ONE fact per NAMED plan, key pricing.<plan_slug> (pricing.free, pricing.pro, pricing.business, pricing.enterprise, …), value = the price EXACTLY as shown WITH period/unit ("$0/mo", "$30/mo", "$30/seat/mo", "Custom").
  • Scan the ENTIRE pricing section top to bottom and emit a price for EVERY plan shown — ESPECIALLY the lowest-priced paid tier. Missing a cheaper tier makes cheapest_paid wrong and triggers false alarms. Do not stop after the first one or two plans.
  • Then set pricing.cheapest_paid = the LOWEST non-free recurring price among the plans you found ("$24/mo"), and pricing.has_free_tier = "true" or "false".
  • NEVER collapse multiple plans into a single "entry" fact. If only one price is shown, still name its plan. If a plan's price is not shown, omit only that plan.
- value = short canonical string: "$30/mo", "true", "false", "uptime monitoring for SaaS".
- verbatim = the exact sentence/fragment from the copy supporting it.
- confidence 0-1 = how unambiguous the copy is.
- 6-25 facts. Prioritise pricing (per plan), security/compliance, key integrations, headline features, and category — what AI assistants most often get wrong.`;

/** Extract the brand's verifiable fact sheet from its own site copy. Best-effort: returns [] on failure. */
export async function extractFacts(router: AIRouter, siteCopy: string): Promise<BrandFact[]> {
  if (!siteCopy || siteCopy.trim().length < 80) return [];
  let raw: string;
  try {
    raw = await router.groqComplete({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: FACTS_SYSTEM },
        // 9000 chars: pricing comparison tables are long; 6000 truncated lower tiers (missed Dub's Pro $25).
        { role: 'user', content: `PAGE COPY:\n${siteCopy.slice(0, 9000)}` },
      ],
      jsonMode: true,
      maxTokens: 1800,
      costSensitiveFallback: true,
    });
  } catch { return []; }
  let parsed: { facts?: Array<Record<string, unknown>> };
  try { parsed = extractJson<{ facts?: Array<Record<string, unknown>> }>(raw); } catch { return []; }
  return (parsed.facts ?? [])
    .filter((f) => f && typeof f.key === 'string' && (f.key as string).trim() && f.value != null && String(f.value).trim())
    .slice(0, 25)
    .map((f) => ({
      key: (f.key as string).trim().slice(0, 80),
      value: String(f.value).trim().slice(0, 200),
      verbatim: typeof f.verbatim === 'string' ? f.verbatim.trim().slice(0, 400) : undefined,
      confidence: typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.7,
    }));
}

// Long pricing pages (Dub's is 229KB) push lower tiers past a naive first-N-chars slice, so the
// cheapest tier gets missed and cheapest_paid comes out wrong. Build a pricing-FOCUSED excerpt:
// the head (category/positioning) + a window around every price/plan signal anywhere on the page,
// so every priced tier reaches the extractor regardless of page length.
export function focusCopy(copy: string, cap = 9000): string {
  if (copy.length <= cap) return copy;
  const head = copy.slice(0, 3000);
  const re = /(\$\s?\d[\d,]*|\bper\s+(?:month|year|seat)\b|\/(?:mo|yr|month|seat)\b|\bplan\b|\bpricing\b|\bfree\b|\benterprise\b|\bcustom\b|\bper\s+user\b)/gi;
  const windows: string[] = [];
  const seenBuckets = new Set<number>();
  let used = head.length;
  let m: RegExpExecArray | null;
  while ((m = re.exec(copy)) !== null && used < cap) {
    const start = Math.max(0, m.index - 140);
    const bucket = Math.floor(start / 220); // dedupe overlapping windows
    if (seenBuckets.has(bucket)) continue;
    seenBuckets.add(bucket);
    const w = copy.slice(start, Math.min(copy.length, m.index + 180));
    windows.push(w);
    used += w.length + 3;
  }
  return `${head} … ${windows.join(' … ')}`.slice(0, cap);
}

/** Merge fact lists from multiple pages, deduping by key (highest-confidence value wins). */
export function mergeFacts(...lists: BrandFact[][]): BrandFact[] {
  const byKey = new Map<string, BrandFact>();
  for (const list of lists) {
    for (const f of list) {
      const existing = byKey.get(f.key);
      // Prefer a stated value over "Not stated", then higher confidence.
      const fStated = !/^not stated$/i.test(f.value);
      const eStated = existing ? !/^not stated$/i.test(existing.value) : false;
      if (!existing || (fStated && !eStated) || (fStated === eStated && (f.confidence ?? 0) > (existing.confidence ?? 0))) {
        byKey.set(f.key, f);
      }
    }
  }
  return [...byKey.values()].slice(0, 30);
}

// The pages that actually carry the contested facts. Homepage rarely states price/compliance;
// /pricing (or /plans) and /security do — exactly the axes AI assistants get wrong.
const FACT_PAGE_PATHS = ['/pricing', '/plans', '/security'];

/**
 * Build a richer fact sheet from homepage + /pricing + /security. `fetchHtml` is injected so the
 * caller keeps SSRF-safe fetching; extraction runs per page and merges (no truncation). Best-effort.
 */
export async function extractFactsFromSite(
  router: AIRouter,
  baseUrl: string,
  homepageCopy: string,
  fetchHtml: (url: string) => Promise<string | null>,
): Promise<BrandFact[]> {
  const base = baseUrl.replace(/\/+$/, '');
  const extraCopies = await Promise.all(
    FACT_PAGE_PATHS.map(async (p) => {
      try {
        const html = await fetchHtml(`${base}${p}`);
        // Pricing-focused excerpt so every priced tier reaches the extractor even on huge pages.
        return html ? focusCopy(stripHtml(html), 9000) : null;
      } catch { return null; }
    }),
  );
  const copies = [homepageCopy, ...extraCopies].filter((c): c is string => Boolean(c && c.length >= 80));
  const lists = await Promise.all(copies.map((c) => extractFacts(router, c)));
  return mergeFacts(...lists);
}

const AUDIT_SYSTEM = `You fact-check what an AI assistant claimed about ONE company against that company's KNOWN FACTS. You never guess.

You are given the company name, its KNOWN FACTS (a verified fact sheet from the company's own site), and an ANSWER an AI assistant gave a buyer.

Do ALL of the following for the company ONLY (ignore claims about other products):
1. Extract EVERY factual claim the ANSWER makes about the company — pricing, plans, features, integrations, security/compliance, founding, ownership, category/what it does.
2. Classify each claim against KNOWN FACTS:
   - "confirmed": agrees with a known fact (set factKey).
   - "contradicted": directly conflicts with a known fact (set factKey). THIS is the alert.
   - "unverifiable": no known fact covers it. NEVER mark such a claim wrong.
   confidence 0-1 = certainty of the classification.
3. entityConfusion: true if the answer is actually about a DIFFERENT product/company that merely shares or resembles the name — i.e. it attributes another product's identity, category, or features to the company. STRONGEST SIGNAL: the answer describes the company as being in a clearly DIFFERENT category/industry than its KNOWN FACTS "category" (e.g. known category is "AI answer tracking" but the answer describes construction project leads, contractors, or building-product sales). This name-collision case is the most common and most damaging — do not miss it. Do NOT set it merely because the answer mentions an adjacent use case or names a competitor.
4. brandRank: if the answer presents a ranked/numbered list of products, the company's 1-based position; else null.
5. sentiment toward the company: "positive" | "neutral" | "negative", or null if the company is not mentioned.

PRICING RULES (critical — a different tier is NOT a lie):
- A price claim is "contradicted" ONLY if it conflicts with the KNOWN price for the SAME plan (match pricing.<plan> by plan name), OR the AI explicitly calls it the starting/cheapest/"from" price AND it conflicts with pricing.cheapest_paid.
- RANGE RULE: if the AI states a price RANGE (e.g. "$49–75/mo") and the KNOWN price for that plan falls INSIDE the range, mark it "confirmed", NOT "contradicted". Only flag a range whose entire span is on the wrong side of the known price (e.g. AI "$19–25" when the known cheapest is "$75").
- If the AI gives a price for a plan/tier that is NOT in KNOWN FACTS, mark it "unverifiable" — you cannot know it's wrong.
- Normalise billing period before comparing (annual vs monthly). If you cannot tell, use "unverifiable".
- Free-tier usage limits (e.g. "3,000 emails/month") are "unverifiable" unless a KNOWN FACT states that exact limit.

Return ONLY JSON:
{"claims":[{"attribute","statedValue","quote","status","factKey","confidence"}],"entityConfusion":<bool>,"brandRank":<int|null>,"sentiment":<string|null>}
Keep quote to the verbatim span (<=200 chars). If the company is ABSENT from the ANSWER, return {"claims":[],"entityConfusion":false,"brandRank":null,"sentiment":null}.`;

/** Fact-check one AI answer against the brand fact sheet. Best-effort: returns an empty audit on failure. */
export async function auditAnswer(
  router: AIRouter,
  answer: string,
  brand: string,
  facts: BrandFact[],
  competitors: string[] = [],
): Promise<AnswerAudit> {
  const empty: AnswerAudit = { claims: [], entityConfusion: false, brandRank: null, sentiment: null };
  if (!answer?.trim()) return empty;

  const factSheet = facts.length
    ? facts.map((f) => `- ${f.key} = ${f.value}${f.verbatim ? ` ("${f.verbatim}")` : ''}`).join('\n')
    : '(none provided — every claim is unverifiable)';

  let raw: string;
  try {
    raw = await router.groqComplete({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: AUDIT_SYSTEM },
        // Same 8000 cap as judgeAnswer / storage — a 6000 cap dropped facts (and brand mentions)
        // that appear in the tail of long grounded answers from the accuracy check.
        { role: 'user', content: `COMPANY: ${brand}\nCOMPETITORS: ${competitors.join(', ') || '(none)'}\n\nKNOWN FACTS:\n${factSheet}\n\nANSWER:\n${answer.slice(0, 8000)}` },
      ],
      jsonMode: true,
      maxTokens: 1500,
      costSensitiveFallback: true,
    });
  } catch { return empty; }

  let parsed: { claims?: Array<Record<string, unknown>>; entityConfusion?: unknown; brandRank?: unknown; sentiment?: unknown };
  try { parsed = extractJson(raw); } catch { return empty; }

  const validStatus = new Set<ClaimStatus>(['confirmed', 'contradicted', 'unverifiable']);
  const factKeys = new Set(facts.map((f) => f.key));
  const claims: AnswerClaim[] = (parsed.claims ?? [])
    .map((c) => {
      const status = String(c.status ?? '').toLowerCase() as ClaimStatus;
      const factKey = typeof c.factKey === 'string' && factKeys.has(c.factKey) ? c.factKey : undefined;
      return {
        attribute: String(c.attribute ?? '').trim().slice(0, 80),
        statedValue: String(c.statedValue ?? '').trim().slice(0, 200),
        quote: String(c.quote ?? '').trim().slice(0, 200),
        status: validStatus.has(status) ? status : 'unverifiable',
        factKey,
        confidence: typeof c.confidence === 'number' ? Math.max(0, Math.min(1, c.confidence)) : 0.5,
      };
    })
    // Guardrail: a "contradicted" claim with no matching known fact is not trustworthy
    // (the model invented a conflict) — downgrade to unverifiable so we never falsely accuse.
    .map((c) => (c.status === 'contradicted' && !c.factKey ? { ...c, status: 'unverifiable' as ClaimStatus } : c))
    .filter((c) => c.attribute && c.statedValue)
    .slice(0, 40);

  const sentimentRaw = String(parsed.sentiment ?? '').toLowerCase();
  const sentiment = (['positive', 'neutral', 'negative'].includes(sentimentRaw) ? sentimentRaw : null) as AnswerAudit['sentiment'];
  const rank = Number(parsed.brandRank);
  const brandRank = Number.isInteger(rank) && rank > 0 && rank <= 50 ? rank : null;

  return { claims, entityConfusion: parsed.entityConfusion === true, brandRank, sentiment };
}

const WINNER_REASONS_SYSTEM = `You read one AI assistant ANSWER to a buyer's question, plus a list of COMPETITOR products the answer RECOMMENDS. For EACH listed competitor, extract the single most concrete reason the ANSWER ITSELF gives for recommending/praising it — the feature, strength, integration, pricing edge, or positioning it names — as a short phrase (<=90 chars) in the answer's own words.

Rules:
- Use ONLY what the answer states. NEVER invent a reason. If a competitor is named with no real stated reason, OMIT it.
- One entry per competitor: the strongest, most specific reason.
- Concrete, not vague: "largest prompt-volume dataset", "used by enterprise teams", "cheapest paid tier", "native Slack + HubSpot integrations" — NOT "good tool" / "popular".
- entity MUST be one of the provided competitor names, copied exactly.

Return ONLY JSON: {"winnerReasons":[{"entity","reason"}]}  (empty array if none have a stated reason).`;

/**
 * Extract WHY the answer recommends each competitor — the actionable "what they claim that you don't"
 * signal that powers the "Why AI Recommends Them" view. A DEDICATED call, NOT folded into auditAnswer:
 * the brand audit short-circuits to an empty result whenever the brand is ABSENT, which is the common
 * case here (rivals win, brand absent), so this extraction has to stand on its own. Best-effort —
 * returns [] on any failure. Only the provided competitors are kept, matched leniently ("Peec" ->
 * "Peec AI") so a shortened name still maps; deduped to one reason per competitor.
 */
export async function extractWinnerReasons(
  router: AIRouter,
  answer: string,
  recommendedCompetitors: string[],
): Promise<WinnerReason[]> {
  if (!answer?.trim() || recommendedCompetitors.length === 0) return [];
  let raw: string;
  try {
    raw = await router.groqComplete({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: WINNER_REASONS_SYSTEM },
        { role: 'user', content: `COMPETITORS (recommended in this answer): ${recommendedCompetitors.join(', ')}\n\nANSWER:\n${answer.slice(0, 8000)}` },
      ],
      jsonMode: true,
      maxTokens: 600,
      costSensitiveFallback: true,
    });
  } catch { return []; }

  let parsed: { winnerReasons?: unknown };
  try { parsed = extractJson(raw); } catch { return []; }

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const canon = recommendedCompetitors.map((c) => ({ c, n: norm(c) }));
  const matchEntity = (e: string): string | null => {
    const n = norm(e);
    if (!n) return null;
    const exact = canon.find((x) => x.n === n);
    if (exact) return exact.c;
    const sub = canon.find((x) => x.n && (x.n.includes(n) || n.includes(x.n)));
    return sub ? sub.c : null;
  };

  const seen = new Set<string>();
  const out: WinnerReason[] = [];
  for (const w of (Array.isArray(parsed.winnerReasons) ? parsed.winnerReasons : [])) {
    const obj = (w ?? {}) as Record<string, unknown>;
    const entity = matchEntity(String(obj.entity ?? '').trim());
    const reason = String(obj.reason ?? '').trim().slice(0, 90);
    if (!entity || !reason || seen.has(entity)) continue;
    seen.add(entity);
    out.push({ entity, reason });
  }
  return out.slice(0, 8);
}

/** One-word accuracy classification for an audited sample (denormalised onto answer_runs). */
export function accuracyFlag(audit: AnswerAudit | null | undefined): AccuracyFlag {
  if (!audit) return 'clean';
  if (audit.entityConfusion) return 'confusion';
  if (audit.claims.some((c) => c.status === 'contradicted')) return 'contradiction';
  return 'clean';
}

// Pricing / security / ownership errors lose deals → high severity; other contradictions → med.
const HIGH_SEVERITY_RE = /pric|cost|\$|free.tier|security|soc.?2|hipaa|gdpr|sso|compliance|ownership|owner|acquired|funding/i;

function severityFor(attribute: string, factKey?: string): AccuracyAlertRow['severity'] {
  return HIGH_SEVERITY_RE.test(`${attribute} ${factKey ?? ''}`) ? 'high' : 'med';
}

/**
 * Derive the deduped "what AI gets wrong about you" rows from one audited sample:
 * confirmed contradictions (with their factKey-backed truth value) + an entity-confusion row.
 * The runner upserts these into accuracy_alerts (occurrences/lastSeen build the trend).
 */
export function accuracyAlertRows(sample: AnswerSample, facts: BrandFact[]): AccuracyAlertRow[] {
  const audit = sample.audit;
  if (!audit) return [];
  const truthByKey = new Map(facts.map((f) => [f.key, f.value]));
  const rows: AccuracyAlertRow[] = [];
  for (const c of audit.claims) {
    if (c.status !== 'contradicted' || !c.factKey) continue; // only fact-backed contradictions become alerts
    const truth = truthByKey.get(c.factKey) ?? null;
    // Precision guardrails — never accuse the AI unless the KNOWN fact is solid:
    //  • cheapest/starting/entry are CROSS-TIER inferences; if we missed a cheaper plan (e.g. a
    //    comparison-table price we couldn't map), they read a correct AI answer as a lie. Skip them.
    //  • a pricing contradiction needs a CONCRETE known price ("$25/mo"), never "Custom"/"Not specified".
    if (/cheapest|starting|entry/i.test(c.factKey)) continue;
    if (/^pricing\./i.test(c.factKey) && !(truth && /\d/.test(truth))) continue;
    rows.push({
      kind: 'contradiction',
      attribute: c.attribute,
      statedValue: c.statedValue,
      truthValue: truth,
      severity: severityFor(c.attribute, c.factKey),
      quote: c.quote,
      model: sample.model,
    });
  }
  if (audit.entityConfusion) {
    rows.push({
      kind: 'confusion',
      attribute: 'identity',
      statedValue: 'confused with another product',
      truthValue: null,
      severity: 'high',
      quote: sample.answer.slice(0, 200),
      model: sample.model,
    });
  }
  return rows;
}

const REMEDIATE_SYSTEM = `You turn a detected AI-answer inaccuracy into an HONEST remediation plan for a B2B SaaS company.
You are given the company, the wrong thing the AI said, the correct fact, and the URLs the AI cited.

Hard honesty rules (do not break these):
- You CANNOT make the AI change quickly. Never imply the fix is instant. Model answers shift over WEEKS TO MONTHS, only as engines re-crawl/retrain.
- Only recommend actions on surfaces the company CONTROLS (their own pages/schema), plus flagging stale THIRD-PARTY sources to go ask for correction.

Produce:
1. correction: the exact, copy-pasteable text/snippet to publish on a company-controlled surface that states the correct fact unambiguously (machine-readable where useful, e.g. a one-line pricing statement or JSON-LD).
2. surface: the single best place to publish it ("pricing page", "homepage JSON-LD", "FAQ", "comparison page").
3. staleSources: from the CITED URLS, the third-party ones (NOT the company's own domain) most likely feeding the wrong answer — to go get corrected. [] if none.
4. note: one honest sentence on the realistic timeline (weeks–months) and that this improves the odds, not a guarantee.

Return ONLY JSON: {"correction","surface","staleSources":[...],"note"}`;

/** Draft an honest remediation for one alert: owned-surface correction + stale sources to chase. Best-effort. */
export async function draftRemediation(
  router: AIRouter,
  alert: { attribute: string; statedValue: string; truthValue: string | null; kind: string },
  brand: string,
  citedUrls: string[],
): Promise<Remediation | null> {
  let raw: string;
  try {
    raw = await router.groqComplete({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: REMEDIATE_SYSTEM },
        { role: 'user', content: `COMPANY: ${brand}\nWRONG (AI said): ${alert.statedValue}\nCORRECT (${alert.attribute}): ${alert.truthValue ?? '(see company site)'}\nISSUE TYPE: ${alert.kind}\nCITED URLS:\n${citedUrls.slice(0, 12).map((u) => `- ${u}`).join('\n') || '(none)'}` },
      ],
      jsonMode: true,
      maxTokens: 900,
      costSensitiveFallback: true,
    });
  } catch { return null; }
  let parsed: { correction?: unknown; surface?: unknown; staleSources?: unknown; note?: unknown };
  try { parsed = extractJson(raw); } catch { return null; }
  const correction = typeof parsed.correction === 'string' ? parsed.correction.trim() : '';
  if (!correction) return null;
  const stale = Array.isArray(parsed.staleSources)
    ? parsed.staleSources.filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 8)
    : [];
  return {
    correction: correction.slice(0, 1200),
    surface: typeof parsed.surface === 'string' ? parsed.surface.trim().slice(0, 120) : 'company site',
    staleSources: stale,
    note: typeof parsed.note === 'string' ? parsed.note.trim().slice(0, 300) : 'AI answers update over weeks–months as engines re-crawl; this improves the odds, not a guarantee.',
  };
}

// ── Citation resolution ───────────────────────────────────────────────────────
// Gemini grounding returns redirect wrappers (vertexaisearch.cloud.google.com/grounding-api-
// redirect/…) instead of the real source URL. Resolve them to the true destination so the
// citation-source graph shows reddit.com / g2.com / etc. Bounded, deduped, cached.
const _redirectCache = new Map<string, string>();

function needsResolve(url: string): boolean {
  return /vertexaisearch\.cloud\.google\.com|grounding-api-redirect/i.test(url);
}

async function resolveOne(url: string): Promise<string> {
  if (_redirectCache.has(url)) return _redirectCache.get(url)!;
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0 BuilderRadar' } });
    const final = res.url && !needsResolve(res.url) ? res.url : url;
    _redirectCache.set(url, final);
    return final;
  } catch {
    _redirectCache.set(url, url);
    return url;
  }
}

/** Resolve up to `cap` unique redirect citations to their real URLs (parallel, bounded). */
export async function resolveCitations(
  citations: { url: string; title?: string }[],
  cap = 8,
): Promise<{ url: string; title?: string }[]> {
  const toResolve = [...new Set(citations.filter((c) => needsResolve(c.url)).map((c) => c.url))].slice(0, cap);
  const resolved = await Promise.all(toResolve.map(async (u) => [u, await resolveOne(u)] as const));
  const map = new Map(resolved);
  // Keep only the top `cap` citations overall (dedup by final URL) to avoid 60+ noise rows.
  const seen = new Set<string>();
  const out: { url: string; title?: string }[] = [];
  for (const c of citations) {
    const url = map.get(c.url) ?? c.url;
    if (needsResolve(url) || seen.has(url)) continue; // drop still-unresolved wrappers + dupes
    seen.add(url);
    out.push({ url, title: c.title });
    if (out.length >= cap) break;
  }
  return out;
}

// ── Run one prompt across the chosen engines ──────────────────────────────────

export async function runPrompt(
  router: AIRouter,
  prompt: string,
  entities: string[],
  models: AnswerModel[],
  // When provided, each answer is fact-checked against the brand's fact sheet (accuracy engine).
  // Omit it and runPrompt behaves exactly as before (audit null, brandRank/sentiment null).
  audit?: { brand: string; facts: BrandFact[] },
): Promise<AnswerSample[]> {
  const samples: AnswerSample[] = [];
  for (const model of models) {
    let res: GroundedAnswer | null = null;
    try {
      if (model === 'gemini-grounded') {
        res = await router.geminiGrounded(prompt);

      } else if (model === 'openai-search') {
        res = await router.openaiSearch(prompt);
      }
    } catch (e) {
      console.warn(`[geo] ${model} failed for "${prompt.slice(0, 40)}": ${(e as Error).message}`);
      continue;
    }
    if (!res) continue;
    let verdicts: Record<string, Verdict>;
    try { verdicts = await judgeAnswer(router, res.text, entities); }
    catch { verdicts = Object.fromEntries(entities.map((x) => [x, 'absent' as Verdict])); }
    // Resolve grounding redirect wrappers → real source domains for the citation graph.
    const citations = await resolveCitations(res.citations);
    let answerAudit: AnswerAudit | null = null;
    if (audit?.brand) {
      answerAudit = await auditAnswer(router, res.text, audit.brand, audit.facts ?? [], entities.filter((e) => e !== audit.brand));
    }
    samples.push({
      prompt, model, answer: res.text, citations, verdicts,
      brandRank: answerAudit?.brandRank ?? null,
      sentiment: answerAudit?.sentiment ?? null,
      audit: answerAudit,
    });
  }
  return samples;
}

// ── Aggregation ───────────────────────────────────────────────────────────────

export function visibilityScore(samples: AnswerSample[], entity: string): number {
  if (samples.length === 0) return 0;
  const pts = samples.reduce(
    (a, s) => a + (s.verdicts[entity] === 'recommended' ? 1 : s.verdicts[entity] === 'named' ? 0.5 : 0),
    0,
  );
  return Math.round((pts / samples.length) * 100);
}

export function shareOfAnswers(samples: AnswerSample[], entities: string[]): ShareRow[] {
  return entities
    .map((name) => ({
      name,
      score: visibilityScore(samples, name),
      recommended: samples.filter((s) => s.verdicts[name] === 'recommended').length,
      named: samples.filter((s) => s.verdicts[name] === 'named').length,
      absent: samples.filter((s) => s.verdicts[name] === 'absent').length,
    }))
    .sort((a, b) => b.score - a.score);
}

// Classify a cited source into one of the 7 canonical buckets (reddit | g2 | youtube | docs |
// listicle | blog | other). Matches on BOTH the host AND the URL path: the path is what reveals
// the huge "buyer-discovery listicle on an otherwise-generic domain" class (e.g.
// `forbes.com/advisor/best-crm-software`, `anysite.com/blog/top-10-tools`) that a host-only check
// drops into "other". Word-boundary path matching avoids false hits ("/laptops" is not "top").
function classifyParts(host: string, path: string): string {
  const h = host.toLowerCase().replace(/^www\./, '');
  const p = path.toLowerCase();
  const both = `${h} ${p}`;

  if (/(^|\.)reddit\.com$/.test(h)) return 'reddit';
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(h)) return 'youtube';
  // Review/comparison aggregators — high-trust buyer sources worth their own bucket.
  if (/(^|\.)(g2|g2crowd|capterra|trustradius|getapp|softwareadvice|saasworthy|trustpilot|gartner|stackshare|producthunt|crozdesk|sourceforge|goodfirms|financesonline)\./.test(h)) return 'g2';
  // Docs / developer references / Q&A — answer often lifted from these verbatim.
  if (/(^|\.)(github|gitlab|stackoverflow|stackexchange|npmjs|pypi|readthedocs)\.|(^|\.)(docs|developer|developers|api|help|support|learn)\./.test(h) || /\/(docs|documentation|api-reference|reference)(\/|$)/.test(p)) return 'docs';
  // Listicles / comparison content — match the keyword in host OR path (the big "other" recovery).
  if (/(alternativeto|toolify|futurepedia|techradar|zapier|forbes|hubspot|geekflare|pickaxe|aitools|cybernews|pcmag|tech\.co|cloudwards|expertinsights|softwarepundit)/.test(h)
    || /\b(best|top|review|reviews|compare|comparison|comparisons|vs|versus|alternative|alternatives|roundup|guide|guides)\b/.test(both)) return 'listicle';
  // Blog/newsletter platforms or an obvious blog/article path.
  if (/(^|\.)(medium|substack|hashnode|wordpress|blogspot|beehiiv|ghost)\.|(^|\.)dev\.to$|(^|\.)blog\.|(^|\.)newsletter\./.test(h) || /\/(blog|posts?|articles?|news)(\/|$)/.test(p)) return 'blog';
  return 'other';
}

/** Classify a full cited URL (host + path). Preferred over classifyDomain — the path carries signal. */
export function classifySourceUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return classifyParts(u.hostname, u.pathname + u.search);
  } catch {
    return 'other';
  }
}

/** Back-compat: classify from a bare domain only (no path). Prefer classifySourceUrl when a URL is available. */
export function classifyDomain(domain: string): string {
  return classifyParts(domain, '');
}

export function citedSourceRows(samples: AnswerSample[]): SourceRow[] {
  const byUrl = new Map<string, SourceRow>();
  for (const s of samples) {
    for (const c of s.citations) {
      if (!c.url) continue;
      let domain: string;
      try { domain = new URL(c.url).hostname.replace(/^www\./, ''); } catch { continue; }
      // Classify on the FULL url (path included), not just the domain.
      const cur = byUrl.get(c.url) ?? { domain, url: c.url, count: 0, sourceType: classifySourceUrl(c.url) };
      cur.count++;
      byUrl.set(c.url, cur);
    }
  }
  return [...byUrl.values()].sort((a, b) => b.count - a.count);
}

/** Find the most painful "absent while competitors win" prompt — drives the outreach hook. */
export function specificLoss(
  samples: AnswerSample[],
  brand: string,
  competitors: string[],
): { prompt: string; winners: string[]; cite?: string } | null {
  const byPrompt = new Map<string, AnswerSample[]>();
  for (const s of samples) {
    const arr = byPrompt.get(s.prompt) ?? [];
    arr.push(s);
    byPrompt.set(s.prompt, arr);
  }
  let best: { prompt: string; winners: string[]; cite?: string } | null = null;
  for (const [prompt, rs] of byPrompt) {
    const brandAbsent = rs.every((r) => r.verdicts[brand] === 'absent');
    if (!brandAbsent) continue;
    const winners = competitors.filter((c) => rs.some((r) => r.verdicts[c] === 'recommended'));
    if (winners.length === 0) continue;
    if (!best || winners.length > best.winners.length) {
      best = { prompt, winners, cite: rs.flatMap((r) => r.citations)[0]?.url };
    }
  }
  return best;
}
