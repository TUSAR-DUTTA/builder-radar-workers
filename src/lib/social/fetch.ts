// Social mentions orchestrator — fetch RAW mentions per tracked entity across the public-API
// sources, run the deterministic multi-layer filter (see ./filter.ts), and store them.
//
// Reddit and X are DELIBERATELY excluded here: a separate Playwright worker writes those rows
// into the same social_mentions table (source='reddit'/'x'), so the aggregation + UI pick them
// up automatically. Everything below uses official / public HTTP APIs only — no scraping.

import { db } from '@/db';
import { socialMentions } from '@/db/schema';
import {
  fetchRawHN, fetchRawBluesky, fetchRawStackExchange, fetchRawGitHub, fetchRawLemmy,
  fetchRawYouTube, fetchRawDevto, fetchRawMedium, fetchRawNews, fetchRawMastodon,
  type RawSourceResult,
} from '@/lib/raw-source-search';
import { filterMentions } from './filter';

// The public-API source set. Reddit + X are intentionally absent (Playwright handles them).
const SOURCE_FETCHERS: Array<(kw: string) => Promise<RawSourceResult[]>> = [
  fetchRawHN, fetchRawBluesky, fetchRawStackExchange, fetchRawGitHub, fetchRawLemmy,
  fetchRawYouTube, fetchRawDevto, fetchRawMedium, fetchRawNews, fetchRawMastodon,
];

const MAX_COMPETITORS = 5;        // brand + up to 5 rivals = 6 tracked entities
const MAX_ROWS_PER_ENTITY = 80;   // cap stored rows per entity per run

/** Fetch + filter raw mentions for ONE entity across all public sources. `disambig` (brand only)
 *  lets an on-domain / @handle mention bypass the single-token ambiguity gate. */
export async function fetchEntityMentions(
  entity: string,
  contextTerms: string[],
  disambig: { selfDomain?: string; selfHandle?: string } = {},
): Promise<RawSourceResult[]> {
  const perSource = await Promise.all(
    SOURCE_FETCHERS.map((f) => f(entity).catch(() => [] as RawSourceResult[])),
  );
  return filterMentions(perSource.flat(), entity, contextTerms, disambig).slice(0, MAX_ROWS_PER_ENTITY);
}

/** Parse the project's competitors jsonb into clean string names (mirrors the GEO routes). */
export function parseCompetitors(competitors: unknown): string[] {
  return Array.isArray(competitors)
    ? (competitors as unknown[]).map((c) => (typeof c === 'string' ? c : (c as { name?: string }).name)).filter(Boolean) as string[]
    : [];
}

/** Best-effort category/context tokens from the project's ICP profile (drives the context gate). */
export function contextTermsFromIcp(icpProfile: unknown): string[] {
  const raw: string[] = [];
  if (icpProfile && typeof icpProfile === 'object') {
    const p = icpProfile as Record<string, unknown>;
    for (const key of ['category', 'niche', 'industry', 'segment', 'productType']) {
      if (typeof p[key] === 'string') raw.push(p[key] as string);
    }
  }
  return [...new Set(raw.flatMap((t) => t.split(/[^a-zA-Z0-9]+/)).map((w) => w.toLowerCase()).filter((w) => w.length >= 4))].slice(0, 8);
}

/** Best-effort brand domain + social @handle from the ICP profile, used to disambiguate the brand's
 *  own single-token mentions (an on-domain / @handle post is unambiguously the right product).
 *  Returns {} when the profile carries neither — the bypass is then simply inert. */
export function disambiguatorsFromIcp(icpProfile: unknown): { selfDomain?: string; selfHandle?: string } {
  if (!icpProfile || typeof icpProfile !== 'object') return {};
  const p = icpProfile as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string).trim() : '');
  const rawDomain = str('domain') || str('website') || str('url') || str('homepage') || str('site');
  const selfDomain = rawDomain
    ? rawDomain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || undefined
    : undefined;
  const rawHandle = str('handle') || str('twitter') || str('x') || str('xHandle') || str('twitterHandle');
  const selfHandle = rawHandle ? rawHandle.replace(/^@/, '') || undefined : undefined;
  return { selfDomain, selfHandle };
}

export interface SocialRunResult { entities: number; fetched: number; stored: number }

/**
 * Run a full social-mention pass for a project and upsert the results. Entities are fetched
 * sequentially (sources parallel within each) to stay under the rate-limited APIs' ceilings.
 * Idempotent: the unique index makes re-runs onConflictDoNothing, so history accumulates cleanly.
 */
export async function runSocialForProject(
  projectId: string,
  brand: string,
  competitors: string[],
  contextTerms: string[],
  // Brand domain/@handle (from the ICP) used to confirm the brand's own ambiguous mentions.
  disambig: { selfDomain?: string; selfHandle?: string } = {},
): Promise<SocialRunResult> {
  const entities = [brand, ...competitors.slice(0, MAX_COMPETITORS)].filter((e) => e && e.trim());
  let fetched = 0;
  let stored = 0;

  for (const entity of entities) {
    // The other tracked names are strong on-topic context: an ambiguous brand ("Arc") co-occurring
    // with the category OR a sibling competitor is almost certainly the real product, not chatter.
    const ctx = [...contextTerms, ...entities.filter((e) => e !== entity)];
    // Domain/@handle disambiguation only applies to the brand (we don't know competitors' domains).
    const entityDisambig = entity === brand ? disambig : {};
    let mentions: RawSourceResult[];
    try {
      mentions = await fetchEntityMentions(entity, ctx, entityDisambig);
    } catch {
      continue;
    }
    fetched += mentions.length;
    if (mentions.length === 0) continue;

    const rows = mentions.map((m) => ({
      projectId,
      entity,
      source: m.source,
      externalId: m.externalId,
      url: m.url,
      title: m.title,
      body: m.body,
      author: m.author,
      community: m.community,
      score: m.score ?? 0,
      commentCount: m.commentCount ?? 0,
      postedAt: m.createdAt,
    }));

    try {
      // .returning() yields only the rows actually inserted (conflicts excluded), which is the
      // reliable inserted-count across drivers — postgres-js doesn't expose .rowCount.
      const inserted = await db.insert(socialMentions).values(rows).onConflictDoNothing().returning({ id: socialMentions.id });
      stored += inserted.length;
    } catch (e) {
      console.warn(`[social] insert failed for entity="${entity}":`, (e as Error).message);
    }
  }

  return { entities: entities.length, fetched, stored };
}

// ── Pure aggregation (used by the project API; no DB/network) ────────────────────

export interface MentionRow {
  entity: string; source: string; url: string; title: string | null; body: string | null;
  author: string | null; community: string | null; score: number; commentCount: number; postedAt: Date | string;
}

const ms = (d: Date | string) => new Date(d).getTime();

/** Raw counts + normalized share-of-voice % per entity over the given window (days). */
export function shareOfVoice(rows: MentionRow[], entities: string[], windowDays = 30) {
  const since = Date.now() - windowDays * 864e5;
  const counts = new Map<string, number>(entities.map((e) => [e, 0]));
  for (const r of rows) {
    if (ms(r.postedAt) < since) continue;
    if (counts.has(r.entity)) counts.set(r.entity, (counts.get(r.entity) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return entities
    .map((name, i) => {
      const mentions = counts.get(name) ?? 0;
      return { name, mentions, share: total ? Math.round((mentions / total) * 100) : 0, isBrand: i === 0 };
    })
    .sort((a, b) => b.mentions - a.mentions);
}

/** Per-week mention counts for the brand and the top competitor, last `weeks` weeks. */
export function trend(rows: MentionRow[], brand: string, weeks = 8) {
  const now = Date.now();
  const out: { week: string; brand: number; competitors: number }[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const lo = now - (w + 1) * 7 * 864e5;
    const hi = now - w * 7 * 864e5;
    let b = 0, c = 0;
    for (const r of rows) {
      const t = ms(r.postedAt);
      if (t < lo || t >= hi) continue;
      if (r.entity === brand) b++; else c++;
    }
    out.push({ week: new Date(lo).toISOString().slice(0, 10), brand: b, competitors: c });
  }
  return out;
}

/** Mention counts per source over the window (days). */
export function bySource(rows: MentionRow[], windowDays = 30) {
  const since = Date.now() - windowDays * 864e5;
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (ms(r.postedAt) < since) continue;
    counts.set(r.source, (counts.get(r.source) ?? 0) + 1);
  }
  return [...counts.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count);
}
