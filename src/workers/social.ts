// Social-mention scraper (Reddit + X via Playwright). Writes into the SAME social_mentions table
// the API-source cron (/api/cron/social) fills, so both surface together in the Social tab.
//
// IMPORTANT — every scraped row goes through the SAME deterministic multi-layer filter the API
// sources use (src/lib/social/filter.ts) BEFORE insert: word-boundary entity match + context gate
// (category terms + sibling competitor names) + noise/chrome drop + dedup. Without this, raw
// scraped counts would be apples-to-oranges with the filtered API counts and inflate Reddit/X.

import { db } from '@/db';
import { projects, socialMentions, brandFacts } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { stealthLaunchOptions, applyStealth, stealthContext } from './lib/stealth';
import { getSessionsDir, loadSessionsFromEnv } from '@/lib/session-loader';
import { assessMentionEntity, filterMentions, type EntityMatchOptions } from '@/lib/social/filter';
import { parseCompetitors, contextTermsFromIcp, disambiguatorsFromIcp } from '@/lib/social/fetch';
import type { RawSourceResult } from '@/lib/raw-source-search';
import * as path from 'path';
import * as fs from 'fs';

// ── Transient DB-connect retry ───────────────────────────────────────────────
const TRANSIENT_DB_CODES = new Set([
  'CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
]);

function isTransientDbError(err: unknown): boolean {
  let depth = 0;
  for (let e = err as Record<string, unknown> | null; e && depth < 5; e = (e.cause ?? null) as Record<string, unknown> | null, depth++) {
    if (typeof e.code === 'string' && TRANSIENT_DB_CODES.has(e.code)) return true;
  }
  return false;
}

async function withDbRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isTransientDbError(err)) throw err;
      const delayMs = 15_000 * attempt;
      console.warn(`[social-runner] ${label}: transient DB connect failure (attempt ${attempt}/${attempts}), retrying in ${delayMs / 1000}s…`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// ── Shared: filter + store ───────────────────────────────────────────────────
// Run a source's raw results through the multi-layer filter for `entity`, then upsert. Returns the
// number of rows actually inserted (onConflictDoNothing makes re-runs idempotent against the
// unique index, so history accumulates without dupes).
async function filterAndStore(
  projectId: string,
  entity: string,
  contextTerms: string[],
  raw: RawSourceResult[],
  identity: EntityMatchOptions = {},
): Promise<number> {
  const kept = filterMentions(raw, entity, contextTerms, identity);
  console.log(`[debug] filterAndStore for ${entity}: ${raw.length} raw -> ${kept.length} kept`);
  if (kept.length === 0) return 0;
  const rows = kept.map((m) => {
    const decision = assessMentionEntity(m, entity, contextTerms, identity);
    return ({
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
    entityStatus: 'verified',
    entityConfidence: decision.confidence,
    entityEvidence: { reason: decision.reason, matchedName: decision.matchedName },
    postedAt: m.createdAt,
    });
  });
  try {
    // .returning() yields only the rows actually inserted (conflicts excluded) — the reliable
    // inserted-count across drivers; postgres-js doesn't expose .rowCount.
    const inserted = await withDbRetry('filterAndStore', () => db.insert(socialMentions).values(rows).onConflictDoNothing().returning({ id: socialMentions.id }));
    return inserted.length;
  } catch (e) {
    console.warn(`[social] insert failed for entity="${entity}" source="${raw[0]?.source}":`, (e as Error).message);
    return 0;
  }
}

// Per-entity context: the project's category tokens PLUS the other tracked names — an ambiguous
// brand ("Arc") co-occurring with the category or a sibling competitor is almost certainly the
// real product, not unrelated chatter.
function contextFor(entity: string, entities: string[], baseContext: string[]): string[] {
  return [...baseContext, ...entities.filter((e) => e !== entity)];
}

// ── X / Twitter ──────────────────────────────────────────────────────────────

function extractTweetsFromGQL(json: unknown): Array<{
  id: string; text: string; createdAt: string; author: string;
  likes: number; retweets: number; replies: number;
}> {
  const tweets: ReturnType<typeof extractTweetsFromGQL> = [];
  try {
    const instructions: unknown[] = (json as any)?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];

    for (const instr of instructions) {
      const entries: unknown[] = (instr as any)?.entries ?? [];
      for (const entry of entries) {
        const result = (entry as any)?.content?.itemContent?.tweet_results?.result;
        if (!result) continue;

        const core = result.tweet ?? result;
        const legacy = core?.legacy;
        const username = core?.core?.user_results?.result?.legacy?.screen_name;
        const tweetId: string = core?.rest_id ?? result?.rest_id;

        if (!legacy?.full_text || !tweetId) continue;
        tweets.push({
          id: tweetId,
          text: legacy.full_text,
          createdAt: legacy.created_at ?? new Date().toUTCString(),
          author: username ?? 'unknown',
          likes: legacy.favorite_count ?? 0,
          retweets: legacy.retweet_count ?? 0,
          replies: legacy.reply_count ?? 0,
        });
      }
    }
  } catch { /* malformed payload — skip */ }
  return tweets;
}

async function scrapeTwitter(projectId: string, entities: string[], baseContext: string[], brandIdentity: EntityMatchOptions): Promise<number> {
  const sessionPath = path.join(getSessionsDir(), 'x_auth_state.json');
  if (!fs.existsSync(sessionPath)) {
    console.warn('[twitter] No session at', sessionPath, '— skipping X (set X_SESSION_B64)');
    return 0;
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch(stealthLaunchOptions(true));
  let stored = 0;
  try {
    const ctx = await browser.newContext({ storageState: sessionPath, ...stealthContext() });
    await applyStealth(ctx);
    const page = await ctx.newPage();

    for (const entity of entities) {
      // Each entity gets its OWN buffer + listener so a late SearchTimeline response can never be
      // misattributed to the next entity (the old shared-mutable-currentEntity race).
      const raw: RawSourceResult[] = [];
      const handler = async (response: import('playwright').Response) => {
        if (!response.url().includes('SearchTimeline')) return;
        try {
          const json = await response.json();
          for (const t of extractTweetsFromGQL(json)) {
            raw.push({
              source: 'x',
              externalId: `twitter:${t.id}`,
              url: `https://x.com/i/web/status/${t.id}`,
              title: null,
              body: t.text.slice(0, 2000),
              author: t.author,
              community: 'Twitter / X',
              score: t.likes + t.retweets,
              commentCount: t.replies,
              createdAt: new Date(t.createdAt),
            });
          }
        } catch { /* non-JSON / closed — skip */ }
      };
      page.on('response', handler);

      const q = encodeURIComponent(`${entity} -is:retweet lang:en`);
      try {
        await page.goto(`https://x.com/search?q=${q}&f=live&src=typed_query`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(2500);
        for (let s = 0; s < 3; s++) {
          await page.evaluate(() => window.scrollBy(0, 2000)).catch(() => {});
          await page.waitForTimeout(1500);
        }
      } catch (e) {
        console.error('[twitter] goto/scroll failed for', entity, e);
      }
      await page.waitForTimeout(1000); // let in-flight responses settle before detaching
      page.off('response', handler);

      stored += await filterAndStore(projectId, entity, contextFor(entity, entities, baseContext), raw, entity === entities[0] ? brandIdentity : {});
    }

    console.log(`[twitter] stored ${stored} filtered mentions for project ${projectId}`);
    await ctx.close();
  } finally {
    await browser.close();
  }
  return stored;
}

// ── Reddit ───────────────────────────────────────────────────────────────────
// Use Reddit's JSON search endpoint THROUGH the browser context (carries the proxy + real UA +
// cookies), which avoids the datacenter 403 that blocks a plain server fetch — and returns clean
// title / selftext / subreddit / score with no fragile DOM scraping. (DOM-scraping the logged-in
// shreddit layout returned page-level recommended posts, not the actual search results.)

interface RedditChild {
  data: {
    id: string; permalink: string; title: string; selftext: string; author: string;
    score: number; num_comments: number; created_utc: number; subreddit: string;
  };
}

async function scrapeReddit(projectId: string, entities: string[], baseContext: string[], brandIdentity: EntityMatchOptions): Promise<number> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch(stealthLaunchOptions(true));
  let stored = 0;
  try {
    const sessionPath = path.join(getSessionsDir(), 'reddit_auth_state.json');
    const hasSession = fs.existsSync(sessionPath);
    const ctx = await browser.newContext({
      ...(hasSession ? { storageState: sessionPath } : {}),
      ...stealthContext(),
    });
    await applyStealth(ctx);
    const page = await ctx.newPage();

    for (const entity of entities) {
      const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(entity)}&sort=new&t=year&limit=25&type=link`;
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (!resp || !resp.ok()) { console.warn(`[reddit] ${entity}: HTTP ${resp?.status() ?? 'no-response'}`); continue; }
        const text = await page.evaluate(() => document.body.innerText);
        let children: RedditChild[] = [];
        try {
          children = (JSON.parse(text)?.data?.children ?? []) as RedditChild[];
        } catch {
          console.warn(`[reddit] ${entity}: non-JSON response (login / anti-bot wall)`);
          continue;
        }
        const raw: RawSourceResult[] = children
          .filter((c) => c?.data?.id)
          .map(({ data: p }) => ({
            source: 'reddit',
            externalId: `reddit:${p.id}`,
            url: `https://reddit.com${p.permalink}`,
            title: p.title || null,
            body: p.selftext ? p.selftext.slice(0, 2000) : null,
            author: p.author || null,
            community: `r/${p.subreddit}`,
            score: p.score ?? 0,
            commentCount: p.num_comments ?? 0,
            createdAt: new Date((p.created_utc ?? 0) * 1000),
          }));
        stored += await filterAndStore(projectId, entity, contextFor(entity, entities, baseContext), raw, entity === entities[0] ? brandIdentity : {});
        await page.waitForTimeout(1500); // be polite to the JSON endpoint between entities
      } catch (e) {
        console.error(`[reddit] search failed for ${entity}`, e);
      }
    }

    console.log(`[reddit] stored ${stored} filtered mentions for project ${projectId}`);
    await ctx.close();
  } finally {
    await browser.close();
  }
  return stored;
}

// ── Runner ───────────────────────────────────────────────────────────────────

export async function runSocialScrapesForProject(projectId: string) {
  const [project] = await withDbRetry('runSocialScrapesForProject', () => db.select({
    id: projects.id,
    name: projects.name,
    competitors: projects.competitors,
    icpProfile: projects.icpProfile,
  }).from(projects).where(eq(projects.id, projectId)));
  if (!project) return;

  const competitors = parseCompetitors(project.competitors).slice(0, 5);
  const entities = [project.name, ...competitors].filter((e) => e && e.trim());
  const baseContext = contextTermsFromIcp(project.icpProfile);
  const [identity] = await withDbRetry('runSocialScrapesForProject.identity', () => db.select({ aliases: brandFacts.aliases, ambiguousAliases: brandFacts.ambiguousAliases })
    .from(brandFacts).where(eq(brandFacts.projectId, projectId)).limit(1));
  const brandIdentity: EntityMatchOptions = {
    ...disambiguatorsFromIcp(project.icpProfile),
    aliases: Array.isArray(identity?.aliases) ? identity.aliases.filter((value): value is string => typeof value === 'string') : [],
    ambiguousAliases: Array.isArray(identity?.ambiguousAliases) ? identity.ambiguousAliases.filter((value): value is string => typeof value === 'string') : [],
  };

  console.log(`[social] Scraping Reddit + X for project ${projectId} (entities: ${entities.join(', ')})`);

  await scrapeReddit(projectId, entities, baseContext, brandIdentity);
  await scrapeTwitter(projectId, entities, baseContext, brandIdentity);
}

export async function runScheduledSocialScrapes() {
  const activeProjects = await withDbRetry('runScheduledSocialScrapes', () => db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.status, 'active')));

  for (const p of activeProjects) {
    try {
      await runSocialScrapesForProject(p.id);
    } catch (err) {
      console.error(`[social-cron] project "${p.id}" failed:`, err);
    }
  }
}

// Support direct execution: `SCRAPE_PROJECT_ID=xyz npx tsx src/workers/social.ts`
const runningDirectly = process.argv[1]?.endsWith('social.ts') || process.argv[1]?.endsWith('social.js');
if (runningDirectly) {
  loadSessionsFromEnv(); // materialize reddit_auth_state.json / x_auth_state.json from *_SESSION_B64
  const projectId = process.env.SCRAPE_PROJECT_ID?.trim();
  const task = projectId ? runSocialScrapesForProject(projectId) : runScheduledSocialScrapes();
  task.then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
