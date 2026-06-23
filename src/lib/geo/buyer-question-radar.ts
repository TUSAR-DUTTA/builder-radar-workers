// Buyer Question Radar — the retention engine. A fixed prompt battery goes stale: once a founder has
// seen the dashboard, nothing changes unless the AI answers change. But buyer LANGUAGE changes
// constantly (new competitors, new comparison pages, new "alternative to X" searches, new cited
// sources). Founders never track this by hand. This module discovers NEW buyer questions every week
// from the substrate the product already collects, scores them cheaply, samples the best across the
// answer engines to learn who AI already recommends, and promotes the strongest into the tracked
// battery — demoting only stale *discovered* prompts to make room (never the founder's own).
//
// Honest high bar (the spec's explicit "what NOT to build" list): a candidate only surfaces if it has
// real demand evidence + is genuinely novel vs the tracked set + buyer intent. No keyword database, no
// fabricated demand, no prompt spam. Discovery sources are all REAL signals:
//   1. Google Autocomplete   — if Google completes it, real people type it (concrete buyer language).
//   2. Cited sources         — the off-site roundups/reviews AI already cites (their slugs are questions).
//   3. Social mentions       — buyer questions surfacing in Reddit/HN/etc. chatter we already collect.
//   4. Competitor head-to-heads — "[X] alternatives", "[X] vs [Y]" for the tracked rivals.
//
// Called from:
//   - src/app/api/projects/[id]/radar/route.ts  (GET view, POST on-demand run, PATCH promote/dismiss)
//   - src/app/api/cron/geo-weekly/route.ts        (the Monday loop — discovers + emails the new queue)

import { db } from '@/db';
import { projects, profiles, promptSets, promptCandidates, answerRuns, citedSources, socialMentions } from '@/db/schema';
import { and, eq, gte, lt, inArray, desc, sql } from 'drizzle-orm';
import { getAIRouter } from '@/lib/ai-router';
import { runPrompt, resolveBrandConfusion } from '@/lib/geo/engine';
import { fetchAutocomplete, countSocialHits } from '@/lib/geo/demand-proxy';
import { weekStartUTC } from '@/lib/geo/action-items';
import { PLANS, type PlanKey } from '@/lib/lemonsqueezy';
import type { PromptIntent, Verdict } from '@/lib/geo/types';

type CandidateOrigin = 'autocomplete' | 'cited_source' | 'social' | 'competitor';

interface RawCandidate {
  question: string;
  qkey: string;
  intent: PromptIntent;
  origin: CandidateOrigin;
  evidenceUrl: string | null;
  evidenceDomain: string | null;
  evidenceLabel: string;
  evidenceWeight: number; // 0–100 prior on how strong the source signal is
  socialHits: number;
}

// ── Text normalization + intent ────────────────────────────────────────────────

/** Canonical dedup key: lowercase, punctuation→space, collapse whitespace. */
export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'to', 'for', 'of', 'in', 'on', 'and', 'or', 'with', 'best', 'top',
  'my', 'your', 'how', 'what', 'which', 'who', 'do', 'does', 'can', 'should', 'i', 'me', 'vs', 'versus',
]);

// Generic buyer/product nouns that are NOT distinctive to any one category — excluded from the
// domain-vocabulary anchor so "software"/"tools"/"alternative" alone can't make an off-topic
// autocomplete suggestion look on-topic.
const GENERIC = new Set([
  'tools', 'tool', 'software', 'app', 'apps', 'platform', 'platforms', 'service', 'services',
  'solution', 'solutions', 'alternative', 'alternatives', 'review', 'reviews', 'compare', 'comparison',
  'comparisons', 'guide', 'guides', 'pricing', 'price', 'best', 'top', 'vs', 'versus', 'free', 'paid',
  'cheap', 'cheapest', 'company', 'companies', 'product', 'products', 'options', 'list', 'reddit',
]);

/** Distinctive domain vocabulary for a project (category + existing battery), minus generic nouns. */
function buildDomainTokens(category: string, prompts: string[], competitorTokens: Set<string>): Set<string> {
  const out = new Set<string>();
  const add = (text: string) => {
    for (const t of contentTokens(text)) {
      if (t.length >= 3 && !GENERIC.has(t) && !competitorTokens.has(t)) out.add(t);
    }
  };
  add(category);
  for (const p of prompts) add(p);
  return out;
}

function contentTokens(s: string): Set<string> {
  return new Set(normalizeQuestion(s).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Buyer-signal vocabulary — a candidate must read like a buyer evaluating/comparing, not chatter.
const BUYER_SIGNAL = /\b(best|top|alternatives?|vs|versus|compare|comparison|review|reviews|pricing|software|tool|tools|app|apps|platform|service|solution|for)\b/;

/** Deterministic intent. Mirrors the battery's intent vocabulary; never returns brand_direct/other. */
function classifyIntent(q: string, brand: string, competitors: string[]): PromptIntent | null {
  const lc = ` ${normalizeQuestion(q)} `;
  // Drop questions about our OWN brand — the radar finds questions we DON'T already own.
  if (brand && lc.includes(` ${normalizeQuestion(brand)} `)) return null;
  if (/\b(vs|versus)\b/.test(lc)) return 'comparison';
  if (/\balternatives?\b/.test(lc)) return 'competitor_alt';
  if (competitors.some((c) => c && lc.includes(` ${normalizeQuestion(c)} `))) return 'comparison';
  if (BUYER_SIGNAL.test(lc)) return 'category';
  return null;
}

// ── Candidate sources ──────────────────────────────────────────────────────────

/** Turn a URL slug AI cites into a buyer question: ".../best-crm-software" → "best crm software". */
function questionFromSlug(rawUrl: string): string | null {
  let seg: string;
  try {
    const u = new URL(rawUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    seg = parts[parts.length - 1] ?? '';
  } catch {
    return null;
  }
  const words = seg.replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_]+/g, ' ').replace(/\d+/g, ' ').trim();
  // Only slugs that read like a buyer query (best/top/vs/alternative/review/compare/guide).
  if (!/\b(best|top|vs|versus|alternatives?|review|reviews|compare|comparison|guide)\b/i.test(words)) return null;
  const cleaned = words.split(/\s+/).filter((w) => w.length >= 2).slice(0, 9).join(' ').trim();
  return cleaned.length >= 8 ? cleaned : null;
}

const EVIDENCE_WEIGHT_BY_TYPE: Record<string, number> = {
  g2: 100, listicle: 92, reddit: 78, youtube: 66, docs: 64, blog: 70, other: 50,
};

/** Project category string from the ICP profile (falls back to ""). */
function categoryOf(icp: unknown): string {
  const p = (icp ?? {}) as Record<string, unknown>;
  const c = p.category;
  return typeof c === 'string' ? c.trim() : '';
}

/**
 * Build the raw candidate pool from every source, deterministically. Autocomplete is the one
 * network-bound step and is bounded to a handful of seed phrases run in parallel.
 */
async function buildRawCandidates(
  brand: string,
  competitors: string[],
  category: string,
  domainTokens: Set<string>,
  citedRows: { url: string; domain: string; sourceType: string | null }[],
  socialTexts: string[],
  socialRows: { title: string | null; body: string | null; url: string }[],
): Promise<RawCandidate[]> {
  const out: RawCandidate[] = [];
  const seenKeys = new Set<string>();

  const push = (
    question: string,
    origin: CandidateOrigin,
    intent: PromptIntent,
    evidenceLabel: string,
    evidenceWeight: number,
    evidenceUrl: string | null,
    evidenceDomain: string | null,
  ) => {
    const q = question.trim().replace(/\s+/g, ' ');
    if (q.length < 8 || q.split(' ').length < 2) return;
    const qkey = normalizeQuestion(q);
    if (!qkey || seenKeys.has(qkey)) return;
    seenKeys.add(qkey);
    out.push({
      question: q.slice(0, 200),
      qkey,
      intent,
      origin,
      evidenceUrl,
      evidenceDomain,
      evidenceLabel,
      evidenceWeight,
      socialHits: countSocialHits(qkey, socialTexts),
    });
  };

  const addClassified = (
    raw: string,
    origin: CandidateOrigin,
    label: string,
    weight: number,
    url: string | null,
    domain: string | null,
  ) => {
    const intent = classifyIntent(raw, brand, competitors);
    if (!intent) return;
    push(raw, origin, intent, label, weight, url, domain);
  };

  // 1. Autocomplete expansion — the demand truth. Seeds: category stem, "best <category>", and
  //    competitor-specific stems ("<X> alternative", "<X> vs") which avoid the bare-name adjective
  //    noise ("profound meaning") that a lone competitor token would pull in.
  const seeds = [
    category && `best ${category}`,
    category,
    category && `${category} for`,
    ...competitors.slice(0, 4).flatMap((c) => [`${c} alternative`, `${c} vs`]),
  ].filter((s): s is string => Boolean(s && s.trim().length >= 3)).slice(0, 11);

  const compKeys = competitors.map((c) => normalizeQuestion(c)).filter(Boolean);
  const suggestionSets = await Promise.all([...new Set(seeds)].map((s) => fetchAutocomplete(s)));
  for (const suggestions of suggestionSets) {
    for (const s of suggestions) {
      const k = ` ${normalizeQuestion(s)} `;
      // Precision gate (autocomplete is the noisy source): a suggestion is on-topic ONLY if it carries
      // a DOMAIN term from this product's own category/battery, or pits two tracked competitors against
      // each other. This kills the classic single-word-competitor collisions WITHOUT a dictionary — a
      // competitor that is also a common English word ("Profound") otherwise drags in "profound vs deep",
      // "different words for profound", "profound vs severe hearing loss". A bare buyer-signal word
      // ("alternative"/"vs") is deliberately NOT enough; the deterministic competitor templates already
      // cover "[X] alternatives" for every rival, so dropping un-anchored autocomplete variants loses
      // nothing real while keeping the bar high.
      const hasDomain = [...domainTokens].some((t) => k.includes(` ${t} `));
      const compMentions = compKeys.filter((c) => k.includes(c)).length;
      if (!hasDomain && compMentions < 2) continue;
      addClassified(s, 'autocomplete', 'A real Google search people type', 80, null, null);
    }
  }

  // 2. Cited sources — the off-site roundups/reviews AI already cites. Their slugs ARE buyer queries,
  //    and the evidence is strongest (the answer engine is already pulling from this page).
  for (const cs of citedRows) {
    const q = questionFromSlug(cs.url);
    if (!q) continue;
    const type = cs.sourceType ?? 'other';
    const weight = EVIDENCE_WEIGHT_BY_TYPE[type] ?? EVIDENCE_WEIGHT_BY_TYPE.other;
    addClassified(q, 'cited_source', `AI already cites this ${type === 'g2' ? 'review page' : type === 'listicle' ? 'roundup' : 'page'}`, weight, cs.url, cs.domain);
  }

  // 3. Social mentions — buyer questions appearing in the chatter we already collect.
  for (const sm of socialRows) {
    const title = (sm.title ?? '').trim();
    if (!title) continue;
    const looksLikeQuery = title.endsWith('?') || /\b(best|top|alternatives?|vs|versus|recommend|recommendations?)\b/i.test(title);
    if (!looksLikeQuery) continue;
    let domain: string | null = null;
    try { domain = new URL(sm.url).hostname.replace(/^www\./, ''); } catch { /* keep null */ }
    addClassified(title, 'social', 'Buyers are asking this in public threads', 60, sm.url, domain);
  }

  // 4. Competitor head-to-heads — high-intent templates for the tracked rivals.
  for (const c of competitors.slice(0, 6)) {
    addClassified(`${c} alternatives`, 'competitor', 'Head-to-head buyer comparison', 65, null, null);
  }
  const top = competitors.slice(0, 4);
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      addClassified(`${top[i]} vs ${top[j]}`, 'competitor', 'Head-to-head buyer comparison', 65, null, null);
    }
  }

  return out;
}

function demandScoreFor(c: RawCandidate): number {
  // Autocomplete candidates are real typed searches → high base; others lean on social corroboration
  // plus their evidence prior. Social hits are strong corroboration regardless of origin.
  const base = c.origin === 'autocomplete' ? 70 : c.origin === 'cited_source' ? 40 : c.origin === 'social' ? 35 : 30;
  return Math.min(100, Math.round(base + Math.min(36, c.socialHits * 6)));
}

// ── Discovery: persist new, novel, high-bar candidates ──────────────────────────

export interface DiscoverResult {
  inserted: number;
  considered: number;
}

/**
 * Discover candidates for a project and persist genuinely-new, novel, buyer-intent ones as
 * status='candidate'. Idempotent: existing (project, qkey) rows are left untouched (so dismissed
 * candidates never resurrect). Best-effort — returns zeros on failure rather than throwing.
 */
export async function discoverCandidates(projectId: string): Promise<DiscoverResult> {
  try {
    const [project] = await db
      .select({ name: projects.name, competitors: projects.competitors, icpProfile: projects.icpProfile })
      .from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return { inserted: 0, considered: 0 };

    const brand = project.name;
    const competitors = Array.isArray(project.competitors)
      ? (project.competitors as unknown[]).map((c) => (typeof c === 'string' ? c : (c as { name?: string }).name)).filter(Boolean) as string[]
      : [];
    const category = categoryOf(project.icpProfile);

    const [activePrompts, citedRows, socialRows, existingCands] = await Promise.all([
      db.select({ prompt: promptSets.prompt }).from(promptSets)
        .where(and(eq(promptSets.projectId, projectId), eq(promptSets.active, true))),
      db.select({ url: citedSources.url, domain: citedSources.domain, sourceType: citedSources.sourceType })
        .from(citedSources).where(eq(citedSources.projectId, projectId)).orderBy(desc(citedSources.citations)).limit(200),
      db.select({ title: socialMentions.title, body: socialMentions.body, url: socialMentions.url })
        .from(socialMentions).where(eq(socialMentions.projectId, projectId)).orderBy(desc(socialMentions.postedAt)).limit(400),
      db.select({ qkey: promptCandidates.qkey }).from(promptCandidates).where(eq(promptCandidates.projectId, projectId)),
    ]);

    const existingPromptTokens = activePrompts.map((p) => contentTokens(p.prompt));
    const existingPromptKeys = new Set(activePrompts.map((p) => normalizeQuestion(p.prompt)));
    const existingCandKeys = new Set(existingCands.map((c) => c.qkey));
    const socialTexts = socialRows.map((s) => `${s.title ?? ''} ${s.body ?? ''}`).filter((t) => t.trim().length > 0);

    const competitorTokens = new Set(competitors.flatMap((c) => [...contentTokens(c)]));
    const domainTokens = buildDomainTokens(category, activePrompts.map((p) => p.prompt), competitorTokens);

    const raw = await buildRawCandidates(brand, competitors, category, domainTokens, citedRows, socialTexts, socialRows);

    const rows: (typeof promptCandidates.$inferInsert)[] = [];
    const weekStart = weekStartUTC();
    for (const c of raw) {
      if (existingPromptKeys.has(c.qkey) || existingCandKeys.has(c.qkey)) continue; // already tracked / known
      // Novelty vs the tracked battery: drop near-duplicates of prompts we already sample.
      const toks = contentTokens(c.question);
      const maxOverlap = existingPromptTokens.reduce((m, t) => Math.max(m, jaccard(toks, t)), 0);
      if (maxOverlap >= 0.72) continue;
      const novelty = Math.round((1 - maxOverlap) * 100);
      const demand = demandScoreFor(c);
      const cheap = Math.round(0.45 * demand + 0.3 * c.evidenceWeight + 0.25 * novelty);
      rows.push({
        projectId,
        question: c.question,
        qkey: c.qkey,
        intent: c.intent,
        origin: c.origin,
        evidenceUrl: c.evidenceUrl,
        evidenceDomain: c.evidenceDomain,
        evidenceLabel: c.evidenceLabel,
        demandScore: demand,
        noveltyScore: novelty,
        cheapScore: cheap,
        status: 'candidate',
        weekStart,
      });
    }

    let inserted = 0;
    // Insert one-by-one with onConflictDoNothing so a concurrent run can't double-insert a qkey.
    for (const r of rows) {
      const res = await db.insert(promptCandidates).values(r).onConflictDoNothing({ target: [promptCandidates.projectId, promptCandidates.qkey] }).returning({ id: promptCandidates.id });
      if (res.length) inserted++;
    }
    return { inserted, considered: raw.length };
  } catch (e) {
    console.warn('[radar] discover failed:', (e as Error).message);
    return { inserted: 0, considered: 0 };
  }
}

// ── Sampling: learn who AI already recommends for the top candidates ─────────────

const VERDICT_PTS: Record<Verdict, number> = { recommended: 1, named: 0.5, absent: 0 };

/**
 * Sample the highest cheap-scored un-sampled candidates across the answer engines (free grounded
 * engine only — no paid COGS), recording the brand verdict, the competitor AI named instead, and the
 * source it cited. Bounded by `limit`. Best-effort per candidate.
 */
export async function sampleCandidates(projectId: string, limit: number): Promise<number> {
  const [project] = await db
    .select({ name: projects.name, competitors: projects.competitors })
    .from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return 0;

  const brand = project.name;
  const competitors = Array.isArray(project.competitors)
    ? (project.competitors as unknown[]).map((c) => (typeof c === 'string' ? c : (c as { name?: string }).name)).filter(Boolean) as string[]
    : [];
  const entities = [brand, ...competitors];

  const candidates = await db
    .select({ id: promptCandidates.id, question: promptCandidates.question })
    .from(promptCandidates)
    .where(and(eq(promptCandidates.projectId, projectId), eq(promptCandidates.status, 'candidate')))
    .orderBy(desc(promptCandidates.cheapScore))
    .limit(limit);
  if (candidates.length === 0) return 0;

  const router = getAIRouter();
  let sampled = 0;

  const sampleOne = async (c: { id: string; question: string }) => {
    let samples;
    try { samples = await runPrompt(router, c.question, entities, ['gemini-grounded']); }
    catch (e) { console.warn(`[radar] sample failed for "${c.question.slice(0, 40)}":`, (e as Error).message); return; }
    if (!samples.length) return;

    // Aggregate across samples. Brand verdict uses the confusion guard (a "Building Radar" look-alike
    // must not count as a win); competitor verdict is the best the AI gave any tracked rival.
    let brandBest: Verdict = 'absent';
    const compPts = new Map<string, number>();
    let citedUrl: string | null = null;
    let citedDomain: string | null = null;
    for (const s of samples) {
      const { verdict } = resolveBrandConfusion(s.answer, brand, s.verdicts[brand], s.audit ?? null);
      if (VERDICT_PTS[verdict] > VERDICT_PTS[brandBest]) brandBest = verdict;
      for (const comp of competitors) {
        const v = (s.verdicts[comp] ?? 'absent') as Verdict;
        compPts.set(comp, (compPts.get(comp) ?? 0) + VERDICT_PTS[v]);
      }
      if (!citedUrl) {
        const first = Array.isArray(s.citations) ? s.citations.find((x) => x?.url) : undefined;
        if (first?.url) { citedUrl = first.url; try { citedDomain = new URL(first.url).hostname.replace(/^www\./, ''); } catch { /* keep url */ } }
      }
    }
    let topCompetitor: string | null = null; let topPts = 0;
    for (const [name, pts] of compPts) if (pts > topPts) { topPts = pts; topCompetitor = name; }
    const competitorVerdict = topPts >= 1 ? 'recommended' : topPts > 0 ? 'named' : null;

    await db.update(promptCandidates).set({
      status: 'sampled',
      brandVerdict: brandBest,
      topCompetitor: topCompetitor && competitorVerdict ? topCompetitor : null,
      competitorVerdict,
      citedUrl,
      citedDomain,
      sampleCount: samples.length,
      sampledAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(promptCandidates.id, c.id));
    sampled++;
  };

  // Bounded concurrency keeps the interactive run inside its time budget.
  const CONCURRENCY = 3;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    await Promise.all(candidates.slice(i, i + CONCURRENCY).map(sampleOne));
  }
  return sampled;
}

// ── Promotion / demotion ─────────────────────────────────────────────────────────

/** A sampled candidate qualifies for the queue/promotion when the brand is ABSENT and a competitor wins. */
function qualifies(c: { brandVerdict: string | null; topCompetitor: string | null }): boolean {
  return (c.brandVerdict ?? 'absent') === 'absent' && !!c.topCompetitor;
}

/**
 * Find stale DISCOVERED prompts safe to demote to make room: discovered (never seed/manual), older
 * than 21 days, and with no brand visibility (recommended/named) in the last 21 days of runs. Oldest
 * first. Returns at most `need`.
 */
async function staleDiscoveredPrompts(projectId: string, need: number): Promise<string[]> {
  if (need <= 0) return [];
  const cutoff = new Date(Date.now() - 21 * 864e5);
  const discovered = await db
    .select({ id: promptSets.id, createdAt: promptSets.createdAt })
    .from(promptSets)
    .where(and(eq(promptSets.projectId, projectId), eq(promptSets.active, true), eq(promptSets.origin, 'discovered'), lt(promptSets.createdAt, cutoff)))
    .orderBy(promptSets.createdAt);
  if (discovered.length === 0) return [];

  const ids = discovered.map((d) => d.id);
  const runs = await db
    .select({ promptId: answerRuns.promptId, brandVerdict: answerRuns.brandVerdict })
    .from(answerRuns)
    .where(and(eq(answerRuns.projectId, projectId), inArray(answerRuns.promptId, ids), gte(answerRuns.runAt, cutoff)));
  const alive = new Set(runs.filter((r) => (r.brandVerdict ?? 'absent') !== 'absent').map((r) => r.promptId));

  return discovered.filter((d) => !alive.has(d.id)).slice(0, need).map((d) => d.id);
}

export interface PromoteResult { promoted: number; demoted: number }

/**
 * Promote qualifying sampled candidates into the tracked battery (origin='discovered'), respecting the
 * plan's prompt cap. When the battery is full, demote stale *discovered* prompts to make room — never
 * the founder's seed/manual prompts. Marks promoted candidates and links the new prompt row.
 */
export async function promoteQualifying(projectId: string, userId: string, plan: string): Promise<PromoteResult> {
  const planKey = ((plan in PLANS ? plan : 'free') as PlanKey);
  const maxPrompts = PLANS[planKey].limits.maxPrompts;

  const qualifying = (await db
    .select({ id: promptCandidates.id, question: promptCandidates.question, intent: promptCandidates.intent, brandVerdict: promptCandidates.brandVerdict, topCompetitor: promptCandidates.topCompetitor, cheapScore: promptCandidates.cheapScore })
    .from(promptCandidates)
    .where(and(eq(promptCandidates.projectId, projectId), eq(promptCandidates.status, 'sampled')))
    .orderBy(desc(promptCandidates.cheapScore)))
    .filter(qualifies);
  if (qualifying.length === 0) return { promoted: 0, demoted: 0 };

  const [{ value: activeCount }] = await db
    .select({ value: sql<number>`count(*)` })
    .from(promptSets)
    .where(and(eq(promptSets.projectId, projectId), eq(promptSets.active, true)));
  let room = maxPrompts - Number(activeCount);

  let demoted = 0;
  if (room < qualifying.length) {
    const stale = await staleDiscoveredPrompts(projectId, qualifying.length - room);
    if (stale.length) {
      await db.update(promptSets).set({ active: false }).where(inArray(promptSets.id, stale));
      demoted = stale.length;
      room += stale.length;
    }
  }

  const toPromote = qualifying.slice(0, Math.max(0, room));
  let promoted = 0;
  for (const c of toPromote) {
    const ins = await db.insert(promptSets)
      .values({ projectId, prompt: c.question, intent: c.intent, active: true, origin: 'discovered' })
      .onConflictDoNothing()
      .returning({ id: promptSets.id });
    await db.update(promptCandidates).set({
      status: 'promoted',
      promotedAt: new Date(),
      promotedPromptId: ins[0]?.id ?? null,
      updatedAt: new Date(),
    }).where(eq(promptCandidates.id, c.id));
    promoted++;
  }
  return { promoted, demoted };
}

// ── Top-level orchestration ──────────────────────────────────────────────────────

export interface SurfacedQuestion {
  question: string;
  intent: string;
  topCompetitor: string | null;
  competitorVerdict: string | null;
  citedDomain: string | null;
  evidenceDomain: string | null;
  evidenceLabel: string | null;
}

export interface RadarRunResult {
  discovered: number;
  sampled: number;
  promoted: number;
  demoted: number;
  surfaced: SurfacedQuestion[];
}

/**
 * Full weekly pass: discover → sample the best → promote qualifying (paid only) → return the surfaced
 * queue (brand absent + a competitor recommended) for the dashboard and the Monday email. Best-effort:
 * any stage failing degrades the result instead of throwing into the caller.
 */
export async function runRadar(
  projectId: string,
  opts: { sampleLimit?: number; promote?: boolean; plan?: string; userId?: string } = {},
): Promise<RadarRunResult> {
  const sampleLimit = opts.sampleLimit ?? 6;
  const result: RadarRunResult = { discovered: 0, sampled: 0, promoted: 0, demoted: 0, surfaced: [] };
  try {
    result.discovered = (await discoverCandidates(projectId)).inserted;
    result.sampled = await sampleCandidates(projectId, sampleLimit);
    if (opts.promote && opts.userId) {
      const pr = await promoteQualifying(projectId, opts.userId, opts.plan ?? 'free');
      result.promoted = pr.promoted;
      result.demoted = pr.demoted;
    }
    result.surfaced = await surfacedThisWeek(projectId);
  } catch (e) {
    console.warn('[radar] run failed:', (e as Error).message);
  }
  return result;
}

/** The week's surfaced queue: sampled candidates where the brand is absent and a competitor wins. */
export async function surfacedThisWeek(projectId: string, limit = 8): Promise<SurfacedQuestion[]> {
  const weekStart = weekStartUTC();
  const rows = await db
    .select({
      question: promptCandidates.question, intent: promptCandidates.intent,
      topCompetitor: promptCandidates.topCompetitor, competitorVerdict: promptCandidates.competitorVerdict,
      citedDomain: promptCandidates.citedDomain, evidenceDomain: promptCandidates.evidenceDomain,
      evidenceLabel: promptCandidates.evidenceLabel, brandVerdict: promptCandidates.brandVerdict,
      cheapScore: promptCandidates.cheapScore,
    })
    .from(promptCandidates)
    .where(and(
      eq(promptCandidates.projectId, projectId),
      eq(promptCandidates.weekStart, weekStart),
      inArray(promptCandidates.status, ['sampled', 'promoted']),
    ))
    .orderBy(desc(promptCandidates.cheapScore))
    .limit(40);
  return rows
    .filter((r) => qualifies(r))
    .slice(0, limit)
    .map((r) => ({
      question: r.question, intent: r.intent,
      topCompetitor: r.topCompetitor, competitorVerdict: r.competitorVerdict,
      citedDomain: r.citedDomain, evidenceDomain: r.evidenceDomain, evidenceLabel: r.evidenceLabel,
    }));
}
