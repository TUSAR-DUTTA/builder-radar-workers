// Citation sources — for a chosen competitor, the prompts where the AI recommends THEM and not you,
// and the exact off-site source feeding that answer. Each source is described DETERMINISTICALLY by
// its surface type (no LLM call): we name what the source is (a Reddit thread, a G2 page, a roundup),
// AND give one concrete recommended move for that surface.
//
// Honest by construction: `detail` is the OBSERVATION (the fact behind the answer); `action` is a
// SUGGESTED move, not a causation claim. We pair it with a "we re-sample this prompt and show you if
// the answer changes — we never claim we caused it" framing in the UI. The earlier pure-observation
// version was honest but answered "where is this coming from?" without "what do I do about it?" — the
// one thing a founder can't get from a cheaper scoreboard. This restores the move, keeping the honesty.

import { classifyDomain } from './engine';

export type SourceType = 'reddit' | 'g2' | 'listicle' | 'youtube' | 'blog' | 'docs' | 'owned' | 'other';

export interface MoveTemplate {
  /** Short label describing what kind of source this is. */
  label: string;
  /** A factual description of the source and why it carries weight in AI answers (the OBSERVATION). */
  detail: string;
  /** One concrete recommended move for this surface — a SUGGESTION, never a causation claim. */
  action: string;
  /** Rough prominence hint for sorting and UI. Higher = a more commonly-cited surface. */
  leverage: number;
}

// One description per surface. `{domain}` is interpolated so the text names the actual source.
const TEMPLATES: Record<SourceType, MoveTemplate> = {
  reddit: {
    label: 'Cited from a Reddit thread',
    detail: 'AI is drawing this recommendation from a Reddit discussion. Community threads like this get re-cited as the conversation grows, so they keep feeding the answer over time.',
    action: 'Join the thread as the founder — disclose who you are and leave a genuinely useful answer that mentions your product where it actually fits. Honest, on-topic replies here get re-cited; spam gets removed.',
    leverage: 9,
  },
  g2: {
    label: 'Cited from a review-site comparison',
    detail: 'AI is pulling this from {domain}, a review/comparison page. Review-site pages are among the most-cited B2B sources in AI answers.',
    action: 'Make sure your {domain} profile is complete and has recent reviews — a thin or missing listing is often why the answer skips you. Ask a few happy customers to review you there.',
    leverage: 8,
  },
  listicle: {
    label: 'Cited from a “best/top” roundup',
    detail: 'AI is citing a roundup on {domain}. Roundups are the single most-cited off-site source — one listing can feed several different answers.',
    action: 'Pitch the author of {domain} to add you to the roundup (a short, specific email with why you belong), or publish a stronger comparison of your own. One inclusion can feed several answers.',
    leverage: 10,
  },
  youtube: {
    label: 'Cited from a video',
    detail: 'AI is citing this video. Video descriptions and pinned links get crawled alongside the content, so the whole page feeds the answer.',
    action: 'Get your product credibly into a video on this topic — a demo, a walkthrough, or a creator collab — since the title, description, and transcript all get crawled with the content.',
    leverage: 6,
  },
  blog: {
    label: 'Cited from an editorial post',
    detail: 'AI is citing an article on {domain}. Earned editorial mentions on already-cited blogs carry real weight in how the answer is assembled.',
    action: 'Earn a mention in an editorial post on {domain} — a guest piece, an expert quote, or original data they’d want to cite. Earned mentions on an already-cited blog carry real weight.',
    leverage: 7,
  },
  docs: {
    label: 'Cited from a docs/repo page',
    detail: 'This is a docs, comparison, or GitHub page on {domain}. Developer-facing sources punch above their weight in AI answers.',
    action: 'Publish a developer-facing comparison of your own — a docs page, a GitHub README, or a /vs page — so there’s a credible source the AI can cite for you on this question.',
    leverage: 6,
  },
  owned: {
    label: 'Cited from the competitor’s own page',
    detail: 'AI is citing the competitor’s OWN page on {domain} — a page you can’t edit, only out-publish elsewhere.',
    action: 'You can’t edit {domain}, so out-publish it: create a stronger, more specific third-party comparison (a roundup pitch, a review-site listing, or your own /vs page) the AI can cite instead.',
    leverage: 5,
  },
  other: {
    label: 'Cited source',
    detail: 'AI is citing {domain} to assemble this answer.',
    action: 'Get your product credibly represented on {domain} — or on a comparable source for this question — so the AI has something to cite for you here, not just for the competitor.',
    leverage: 4,
  },
};

/**
 * Source type for a domain, with the extra `owned` class layered on top of classifyDomain:
 * if the cited domain belongs to the competitor (or, defensively, the brand), it's flagged as the
 * competitor's own page rather than a third-party source. `entityNames` are matched as tokens against
 * the registrable part of the domain.
 */
export function sourceTypeFor(domain: string, ownerNames: string[] = []): SourceType {
  const host = domain.toLowerCase();
  for (const n of ownerNames) {
    const slug = n.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (slug.length >= 3 && host.replace(/[^a-z0-9]/g, '').includes(slug)) return 'owned';
  }
  return classifyDomain(host) as SourceType;
}

/** The source description + recommended move for a source type, with the domain interpolated in. */
export function moveFor(sourceType: SourceType, domain: string): MoveTemplate {
  const t = TEMPLATES[sourceType] ?? TEMPLATES.other;
  return {
    ...t,
    detail: t.detail.replace(/\{domain\}/g, domain),
    action: t.action.replace(/\{domain\}/g, domain),
  };
}

export interface RankedSource {
  url: string;
  domain: string;
  sourceType: SourceType;
}

/**
 * From the citations behind a competitor's answer, rank the sources by prominence — off-site
 * community/review/roundup surfaces rank above the competitor's own page (which can only be
 * countered, not edited). Returns the ranked list (best first); the caller uses [0] as the primary
 * source and the rest as secondary ones.
 */
export function rankSources(
  citations: { url?: string | null }[],
  ownerNames: string[] = [],
): RankedSource[] {
  const byDomain = new Map<string, RankedSource>();
  for (const c of citations) {
    if (!c.url) continue;
    let domain: string;
    try { domain = new URL(c.url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (byDomain.has(domain)) continue; // one entry per domain, first URL wins
    byDomain.set(domain, { url: c.url, domain, sourceType: sourceTypeFor(domain, ownerNames) });
  }
  // Leverage-desc, so the most actionable off-site surface is the primary target.
  return [...byDomain.values()].sort((a, b) => moveFor(b.sourceType, b.domain).leverage - moveFor(a.sourceType, a.domain).leverage);
}
