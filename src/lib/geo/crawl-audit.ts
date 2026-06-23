// GEO technical audit — "can AI engines crawl, parse, and answer FROM your site?"
//
// This is the table-stakes layer competitors ship: a DETERMINISTIC, no-LLM-cost check of the
// signals that decide whether generative engines can use your pages as a source. It goes beyond a
// classic SEO audit by checking the GEO-native surface specifically:
//   • AI crawler access (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, …) in robots.txt
//   • llms.txt / llms-full.txt (the emerging "feed for AI answer engines" standard)
//   • schema.org structured data the answer engines lift facts from (Organization, FAQPage, Product)
//   • answer-readiness on the page itself (title/description, single H1, content depth, JS-rendering)
//
// HYBRID: on top of the deterministic score, an optional best-effort LLM pass rates how extractable a
// direct buyer answer is from the copy and names concrete GEO content gaps. The LLM NEVER moves the
// hard score (kept deterministic so it's stable run-to-run); it's advisory only.
//
// Pure + injectable: takes a `fetchText` (the caller keeps SSRF-safe fetching) and an AIRouter, so it
// runs identically from the cron, an on-demand API call, or a script. Best-effort throughout.

import type { AIRouter } from '@/lib/ai-router';
import { stripHtml } from './engine';

export type CrawlStatus = 'pass' | 'warn' | 'fail';

export interface CrawlCheck {
  id: string;
  label: string;
  category: string;
  status: CrawlStatus;
  weight: number;       // relative importance in the 0–100 score
  detail: string;       // what we actually found
  fix?: string;         // concrete remediation (only when not a pass)
}

export interface CrawlAuditResult {
  url: string;
  score: number;                 // 0–100, deterministic
  checks: CrawlCheck[];
  llmsTxt: boolean;              // llms.txt present
  aiCrawlersBlocked: string[];  // AI bots explicitly disallowed in robots.txt
  schemaTypes: string[];        // schema.org @types found in JSON-LD
  // Hybrid LLM layer (advisory; does not affect `score`).
  aiReadiness: { score: number; notes: string[] } | null;
  fetchedAt: string;
}

export type FetchText = (url: string) => Promise<{ status: number; text: string } | null>;

/**
 * Best-effort: find a project's site URL from the pieces we store. Preference order: the fact-sheet
 * source URL (set at onboarding), then icpProfile.siteUrl, then a "Source: <url>" line in rawMd.
 * Returns null if none is a valid http(s) URL — the caller then skips the audit rather than guessing.
 */
export function resolveProjectUrl(opts: {
  sourceUrl?: string | null;
  icpProfile?: unknown;
  rawMd?: string | null;
}): string | null {
  const candidates: (string | undefined)[] = [];
  if (opts.sourceUrl) candidates.push(opts.sourceUrl);
  const icp = opts.icpProfile as { siteUrl?: unknown; site_url?: unknown } | null | undefined;
  if (icp && typeof icp === 'object') {
    if (typeof icp.siteUrl === 'string') candidates.push(icp.siteUrl);
    if (typeof icp.site_url === 'string') candidates.push(icp.site_url);
  }
  const fromMd = opts.rawMd?.match(/^\s*Source:\s*(\S+)/im)?.[1];
  if (fromMd) candidates.push(fromMd);
  for (const c of candidates) {
    const v = (c ?? '').trim();
    if (/^https?:\/\//i.test(v)) return v;
  }
  return null;
}

// The AI crawlers whose access actually decides GEO reach. Blocking these is fatal: the engine
// literally cannot read your site to cite it. Google-Extended / Applebot-Extended / OAI-SearchBot
// gate the AI-answer surfaces specifically (separate from classic search indexing).
const AI_BOTS = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-Web', 'anthropic-ai',
  'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'Amazonbot',
  'Bytespider', 'CCBot', 'cohere-ai', 'Meta-ExternalAgent', 'Meta-ExternalFetcher',
];

// Parse robots.txt into per-user-agent disallow lists. Good enough for the "is this bot blocked
// from the whole site?" question without pulling a full robots parser.
function parseRobots(robots: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  let current: string[] = [];
  for (const rawLine of robots.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      // Consecutive user-agent lines share the following rules.
      const ua = value.toLowerCase();
      if (!groups.has(ua)) groups.set(ua, []);
      current = groups.get(ua)!;
    } else if (field === 'disallow' && current) {
      current.push(value);
    }
  }
  return groups;
}

// A bot is "blocked" if its own group — or the catch-all '*' — disallows the site root.
function botBlocked(groups: Map<string, string[]>, bot: string): boolean {
  const disallowsRoot = (rules: string[] | undefined) =>
    Array.isArray(rules) && rules.some((r) => r === '/' || r === '/*');
  return disallowsRoot(groups.get(bot.toLowerCase())) || disallowsRoot(groups.get('*'));
}

// Pull schema.org @type values out of every JSON-LD block (handles arrays, @graph, nested).
function extractSchemaTypes(html: string): string[] {
  const types = new Set<string>();
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  const collect = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      const t = obj['@type'];
      if (typeof t === 'string') types.add(t);
      else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.add(x));
      if (Array.isArray(obj['@graph'])) collect(obj['@graph']);
    }
  };
  while ((m = re.exec(html)) !== null) {
    try { collect(JSON.parse(m[1].trim())); } catch { /* malformed block — skip */ }
  }
  return [...types];
}

function has(html: string, re: RegExp): boolean { return re.test(html); }

const AI_READINESS_SYSTEM = `You assess how easily an AI answer engine (ChatGPT, Perplexity, Google AI Overviews) can lift a DIRECT, citable buyer answer from a company's homepage copy. You are pragmatic and specific.
Return ONLY JSON: {"score": <0-100 integer>, "notes": ["..."]}
- score: 0-100 how answer-ready the copy is — does it state, in plain extractable text, what the product is, who it's for, what it costs, and how it compares? Vague marketing ("supercharge your workflow") scores low; concrete, factual, scannable copy scores high.
- notes: 2-4 SHORT, concrete GEO content gaps to fix (e.g. "Add a plain-text pricing line — prices are only in an image/table", "No FAQ section answering 'is X worth it'", "No comparison vs named competitors"). Name the specific missing asset, never generic advice like "improve content".`;

// Best-effort hybrid layer. Returns null on any failure so the deterministic audit always stands.
async function assessAiReadiness(router: AIRouter, copy: string): Promise<{ score: number; notes: string[] } | null> {
  if (copy.trim().length < 120) return null;
  let raw: string;
  try {
    raw = await router.groqComplete({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: AI_READINESS_SYSTEM },
        { role: 'user', content: `HOMEPAGE COPY:\n${copy.slice(0, 6000)}` },
      ],
      jsonMode: true,
      maxTokens: 600,
      costSensitiveFallback: true,
    });
  } catch { return null; }
  try {
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { score?: unknown; notes?: unknown };
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
    const notes = Array.isArray(parsed.notes)
      ? parsed.notes.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).map((n) => n.trim().slice(0, 220)).slice(0, 4)
      : [];
    return { score, notes };
  } catch { return null; }
}

/**
 * Run the GEO technical audit for a site. `fetchText` must be SSRF-safe (the caller owns fetching);
 * it returns { status, text } or null on failure. Set opts.hybrid to add the advisory LLM layer.
 */
export async function runCrawlAudit(
  router: AIRouter,
  siteUrl: string,
  fetchText: FetchText,
  opts?: { hybrid?: boolean },
): Promise<CrawlAuditResult> {
  let base: URL;
  try { base = new URL(siteUrl); } catch { base = new URL(`https://${siteUrl}`); }
  const origin = base.origin;
  const at = (p: string) => `${origin}${p}`;

  const [home, robotsRes, llmsRes, llmsFullRes, sitemapRes] = await Promise.all([
    fetchText(base.toString()).catch(() => null),
    fetchText(at('/robots.txt')).catch(() => null),
    fetchText(at('/llms.txt')).catch(() => null),
    fetchText(at('/llms-full.txt')).catch(() => null),
    fetchText(at('/sitemap.xml')).catch(() => null),
  ]);

  const html = home?.text ?? '';
  const robots = robotsRes && robotsRes.status < 400 ? robotsRes.text : '';
  const robotsGroups = parseRobots(robots);
  const aiCrawlersBlocked = robots ? AI_BOTS.filter((b) => botBlocked(robotsGroups, b)) : [];
  const llmsTxt = Boolean(llmsRes && llmsRes.status < 400 && llmsRes.text.trim().length > 0);
  const llmsFull = Boolean(llmsFullRes && llmsFullRes.status < 400 && llmsFullRes.text.trim().length > 0);
  const sitemapOk = Boolean(sitemapRes && sitemapRes.status < 400 && /<urlset|<sitemapindex/i.test(sitemapRes.text));
  const schemaTypes = extractSchemaTypes(html);
  const lc = (t: string) => t.toLowerCase();
  const schemaLc = schemaTypes.map(lc);

  const copy = stripHtml(html);
  const wordCount = copy ? copy.split(/\s+/).filter(Boolean).length : 0;
  const textRatio = html.length ? copy.length / html.length : 0;

  const checks: CrawlCheck[] = [];
  const add = (c: CrawlCheck) => checks.push(c);

  // ── AI crawler access (the highest-stakes GEO checks) ──
  add(robots
    ? { id: 'robots', label: 'robots.txt present', category: 'AI crawler access', weight: 1, status: 'pass', detail: 'robots.txt is reachable.' }
    : { id: 'robots', label: 'robots.txt present', category: 'AI crawler access', weight: 1, status: 'warn', detail: 'No robots.txt found.', fix: 'Add a robots.txt — without one, crawler directives are ambiguous and some AI bots default to caution.' });
  add(aiCrawlersBlocked.length === 0
    ? { id: 'ai-bots', label: 'AI crawlers allowed', category: 'AI crawler access', weight: 4, status: 'pass', detail: robots ? 'No AI answer-engine crawlers are blocked in robots.txt.' : 'No robots.txt blocking AI crawlers.' }
    : { id: 'ai-bots', label: 'AI crawlers allowed', category: 'AI crawler access', weight: 4, status: 'fail', detail: `Blocked in robots.txt: ${aiCrawlersBlocked.join(', ')}. These engines cannot read your site to cite it.`, fix: `Remove the Disallow rules for ${aiCrawlersBlocked.join(', ')} so AI answer engines can crawl and cite your pages.` });

  // ── GEO-native feed files ──
  add(llmsTxt
    ? { id: 'llms-txt', label: 'llms.txt feed', category: 'GEO feed files', weight: 3, status: 'pass', detail: 'llms.txt is published — a clean, AI-readable map of your key pages.' }
    : { id: 'llms-txt', label: 'llms.txt feed', category: 'GEO feed files', weight: 3, status: 'warn', detail: 'No llms.txt found.', fix: 'Publish /llms.txt: a markdown index of your most important pages (product, pricing, docs, FAQ) so AI engines ingest the canonical version. This is the GEO-native equivalent of a sitemap.' });
  add(llmsFull
    ? { id: 'llms-full', label: 'llms-full.txt', category: 'GEO feed files', weight: 1, status: 'pass', detail: 'llms-full.txt is published (full-text corpus for AI ingestion).' }
    : { id: 'llms-full', label: 'llms-full.txt', category: 'GEO feed files', weight: 1, status: 'warn', detail: 'No llms-full.txt found (optional).', fix: 'Optionally publish /llms-full.txt with the full text of your key pages for engines that ingest it directly.' });

  // ── Discoverability ──
  add(sitemapOk
    ? { id: 'sitemap', label: 'XML sitemap', category: 'Discoverability', weight: 1, status: 'pass', detail: 'A valid sitemap.xml is reachable.' }
    : { id: 'sitemap', label: 'XML sitemap', category: 'Discoverability', weight: 1, status: 'warn', detail: 'No valid sitemap.xml found.', fix: 'Publish /sitemap.xml listing your indexable URLs so crawlers discover every page.' });
  add(/sitemap\s*:/i.test(robots)
    ? { id: 'sitemap-ref', label: 'Sitemap linked in robots.txt', category: 'Discoverability', weight: 0.5, status: 'pass', detail: 'robots.txt references the sitemap.' }
    : { id: 'sitemap-ref', label: 'Sitemap linked in robots.txt', category: 'Discoverability', weight: 0.5, status: 'warn', detail: 'robots.txt does not reference a sitemap.', fix: 'Add a "Sitemap: https://…/sitemap.xml" line to robots.txt.' });

  // ── Structured data (what engines lift facts from) ──
  add(schemaTypes.length > 0
    ? { id: 'jsonld', label: 'schema.org structured data', category: 'Structured data', weight: 2, status: 'pass', detail: `JSON-LD present: ${schemaTypes.join(', ')}.` }
    : { id: 'jsonld', label: 'schema.org structured data', category: 'Structured data', weight: 2, status: 'fail', detail: 'No schema.org JSON-LD found.', fix: 'Add JSON-LD structured data (Organization + Product/SoftwareApplication) — engines extract canonical facts (name, category, pricing) straight from it.' });
  add(schemaLc.some((t) => t === 'organization' || t === 'corporation' || t === 'localbusiness')
    ? { id: 'schema-org', label: 'Organization schema', category: 'Structured data', weight: 1, status: 'pass', detail: 'Organization schema present.' }
    : { id: 'schema-org', label: 'Organization schema', category: 'Structured data', weight: 1, status: 'warn', detail: 'No Organization schema.', fix: 'Add Organization JSON-LD (name, url, logo, sameAs) so engines attribute facts to your brand correctly.' });
  add(schemaLc.includes('faqpage')
    ? { id: 'schema-faq', label: 'FAQ schema', category: 'Structured data', weight: 1.5, status: 'pass', detail: 'FAQPage schema present — highly answer-extractable.' }
    : { id: 'schema-faq', label: 'FAQ schema', category: 'Structured data', weight: 1.5, status: 'warn', detail: 'No FAQPage schema.', fix: 'Publish an FAQ with FAQPage JSON-LD answering real buyer questions ("is X worth it", "X vs Y") — this is among the most-cited formats in AI answers.' });

  // ── Answer-readiness on the page ──
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '';
  add(title.length >= 10
    ? { id: 'title', label: 'Title tag', category: 'Answer readiness', weight: 1, status: 'pass', detail: `Title: "${title.slice(0, 80)}".` }
    : { id: 'title', label: 'Title tag', category: 'Answer readiness', weight: 1, status: 'fail', detail: 'Missing or too-short <title>.', fix: 'Add a descriptive <title> naming the product and category.' });
  add(has(html, /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{30,}/i)
    ? { id: 'meta-desc', label: 'Meta description', category: 'Answer readiness', weight: 1, status: 'pass', detail: 'A substantive meta description is present.' }
    : { id: 'meta-desc', label: 'Meta description', category: 'Answer readiness', weight: 1, status: 'warn', detail: 'Missing or thin meta description.', fix: 'Add a 1–2 sentence meta description that states what the product does and for whom.' });
  const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length;
  add(h1Count === 1
    ? { id: 'h1', label: 'Single H1', category: 'Answer readiness', weight: 1, status: 'pass', detail: 'Exactly one H1 — a clear page topic.' }
    : { id: 'h1', label: 'Single H1', category: 'Answer readiness', weight: 1, status: 'warn', detail: h1Count === 0 ? 'No H1 heading found.' : `${h1Count} H1 headings (ambiguous topic).`, fix: 'Use exactly one H1 that states the page topic in buyer language.' });
  add(has(html, /<meta[^>]+property=["']og:(title|description)["']/i)
    ? { id: 'og', label: 'Open Graph tags', category: 'Answer readiness', weight: 0.5, status: 'pass', detail: 'Open Graph metadata present.' }
    : { id: 'og', label: 'Open Graph tags', category: 'Answer readiness', weight: 0.5, status: 'warn', detail: 'No Open Graph tags.', fix: 'Add og:title/og:description for cleaner link unfurls and richer crawl metadata.' });
  add(has(html, /<link[^>]+rel=["']canonical["']/i)
    ? { id: 'canonical', label: 'Canonical URL', category: 'Answer readiness', weight: 0.5, status: 'pass', detail: 'Canonical link present.' }
    : { id: 'canonical', label: 'Canonical URL', category: 'Answer readiness', weight: 0.5, status: 'warn', detail: 'No canonical link.', fix: 'Add <link rel="canonical"> so engines consolidate signals on one URL.' });
  add(wordCount >= 300
    ? { id: 'depth', label: 'Content depth', category: 'Answer readiness', weight: 1, status: 'pass', detail: `~${wordCount} words of crawlable text.` }
    : { id: 'depth', label: 'Content depth', category: 'Answer readiness', weight: 1, status: 'warn', detail: `Only ~${wordCount} words of crawlable text.`, fix: 'Add substantive plain-text content (what it does, who it’s for, pricing, comparisons) — thin pages give engines nothing to cite.' });
  // JS-rendering heuristic: lots of HTML but almost no extractable text → content needs JS, which
  // most AI crawlers do NOT execute, so they see an empty page. This is a GEO-specific trap.
  add(!(html.length > 4000 && wordCount < 200 && textRatio < 0.04)
    ? { id: 'js-render', label: 'Server-rendered content', category: 'Answer readiness', weight: 2, status: 'pass', detail: 'Meaningful text is present in the raw HTML.' }
    : { id: 'js-render', label: 'Server-rendered content', category: 'Answer readiness', weight: 2, status: 'fail', detail: 'Page returns markup but almost no text without JavaScript — most AI crawlers don’t run JS, so they may see an empty page.', fix: 'Server-render or pre-render your key content so it’s in the initial HTML, not injected client-side.' });

  // Deterministic weighted score (pass = full, warn = half, fail = 0).
  const factor = (s: CrawlStatus) => (s === 'pass' ? 1 : s === 'warn' ? 0.5 : 0);
  const totalWeight = checks.reduce((a, c) => a + c.weight, 0);
  const earned = checks.reduce((a, c) => a + c.weight * factor(c.status), 0);
  const score = totalWeight ? Math.round((earned / totalWeight) * 100) : 0;

  const aiReadiness = opts?.hybrid ? await assessAiReadiness(router, copy).catch(() => null) : null;

  return {
    url: base.toString(),
    score,
    checks,
    llmsTxt,
    aiCrawlersBlocked,
    schemaTypes,
    aiReadiness,
    fetchedAt: new Date().toISOString(),
  };
}
