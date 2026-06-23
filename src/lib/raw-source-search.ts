export interface RawSourceResult {
  source: string;
  externalId: string;
  url: string;
  title: string | null;
  body: string | null;
  author: string | null;
  community: string | null;
  score: number;
  commentCount: number;
  createdAt: Date;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function rssItems(xml: string): string[] {
  return xml.match(/<item\b[\s\S]*?<\/item>/g) ?? [];
}

function rssTag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : null;
}

export function textMatchesKeyword(text: string, keyword: string): boolean {
  const normalizedKeyword = keyword.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const normalizedText = text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const alt = normalizedKeyword.match(/^(.+?)\s+alternatives?$/);
  if (alt?.[1]) {
    return normalizedText.includes(alt[1]) && normalizedText.includes('alternative');
  }
  const tokens = keyword.toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
  if (tokens.length === 0) return true;
  if (tokens.length === 1) return normalizedText.includes(tokens[0]);
  if (tokens.length <= 3) return normalizedText.includes(normalizedKeyword);
  return tokens.every((t) => normalizedText.includes(t));
}

export async function fetchRawReddit(keyword: string): Promise<RawSourceResult[]> {
  try {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(keyword)}&sort=new&t=month&limit=25&type=link`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'BuilderRadar/2.0 (+https://builderradar.pro; research)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json() as {
      data: { children: { data: {
        id: string; permalink: string; title: string; selftext: string;
        author: string; score: number; num_comments: number;
        created_utc: number; subreddit: string;
      }}[] }
    };
    return data.data.children.map(({ data: p }) => ({
      source: 'reddit',
      externalId: `reddit:${p.id}`,
      url: `https://reddit.com${p.permalink}`,
      title: p.title || null,
      body: p.selftext ? p.selftext.slice(0, 1500) : null,
      author: p.author || null,
      community: `r/${p.subreddit}`,
      score: p.score,
      commentCount: p.num_comments,
      createdAt: new Date(p.created_utc * 1000),
    }));
  } catch {
    return [];
  }
}

export async function fetchRawHN(keyword: string): Promise<RawSourceResult[]> {
  try {
    const oneMonthAgo = Math.floor(Date.now() / 1000 - 30 * 24 * 3600);
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(keyword)}&tags=(story,comment)&numericFilters=created_at_i>${oneMonthAgo}&hitsPerPage=25`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json() as {
      hits: Array<{
        objectID: string; url?: string; title?: string; story_title?: string; story_id?: number; story_text?: string;
        story_url?: string; comment_text?: string; author: string; points?: number;
        num_comments?: number; created_at: string; _tags?: string[];
      }>
    };
    return data.hits.map((h) => {
      const isComment = h._tags?.includes('comment') ?? false;
      return {
        source: 'hackernews',
        externalId: `hn:${h.objectID}`,
        url: h.url ?? h.story_url ?? `https://news.ycombinator.com/item?id=${isComment && h.story_id ? h.story_id : h.objectID}`,
        title: h.title ?? h.story_title ?? null,
        body: (h.story_text ?? h.comment_text ?? '').slice(0, 1500) || null,
        author: h.author || null,
        community: isComment ? 'HN Comment' : 'HN',
        score: h.points ?? 0,
        commentCount: h.num_comments ?? 0,
        createdAt: new Date(h.created_at),
      };
    });
  } catch {
    return [];
  }
}

export async function fetchRawBluesky(keyword: string): Promise<RawSourceResult[]> {
  try {
    const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(keyword)}&limit=20&sort=latest`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json() as {
      posts: Array<{
        uri: string; cid: string;
        author: { handle: string };
        record: { text: string; createdAt: string };
        likeCount?: number; replyCount?: number;
      }>
    };
    return data.posts.map((p) => ({
      source: 'bluesky',
      externalId: `bsky:${p.cid}`,
      url: `https://bsky.app/profile/${p.author.handle}/post/${p.uri.split('/').pop()}`,
      title: null,
      body: p.record.text.slice(0, 1500) || null,
      author: p.author.handle,
      community: null,
      score: p.likeCount ?? 0,
      commentCount: p.replyCount ?? 0,
      createdAt: new Date(p.record.createdAt),
    }));
  } catch {
    return [];
  }
}

export async function fetchRawStackExchange(keyword: string): Promise<RawSourceResult[]> {
  try {
    const params = new URLSearchParams({
      order: 'desc',
      sort: 'creation',
      q: keyword,
      site: 'stackoverflow',
      filter: 'withbody',
      pagesize: '15',
      fromdate: String(Math.floor(Date.now() / 1000 - 90 * 86400)),
    });
    if (process.env.STACKEXCHANGE_KEY) params.set('key', process.env.STACKEXCHANGE_KEY);
    const res = await fetch(`https://api.stackexchange.com/2.3/search/advanced?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json() as {
      items?: Array<{
        question_id: number; link: string; title: string; body?: string;
        owner?: { display_name?: string }; score: number; answer_count: number; creation_date: number;
      }>
    };
    return (data.items ?? []).map((q) => ({
      source: 'stackexchange',
      externalId: `se:stackoverflow:${q.question_id}`,
      url: q.link,
      title: q.title || null,
      body: q.body ? stripHtml(q.body).slice(0, 1500) : null,
      author: q.owner?.display_name ?? null,
      community: 'stackoverflow',
      score: q.score ?? 0,
      commentCount: q.answer_count ?? 0,
      createdAt: new Date(q.creation_date * 1000),
    }));
  } catch {
    return [];
  }
}

export async function fetchRawGitHub(keyword: string): Promise<RawSourceResult[]> {
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'BuilderRadar/2.0 (+https://builderradar.pro)',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const q = encodeURIComponent(`"${keyword}" in:title,body`);
    const res = await fetch(`https://api.github.com/search/issues?q=${q}&sort=created&order=desc&per_page=15`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json() as {
      items?: Array<{
        id: number; html_url: string; title: string; body?: string | null;
        user?: { login?: string }; comments: number; created_at: string; reactions?: { total_count?: number };
      }>
    };
    return (data.items ?? []).map((it) => ({
      source: 'github',
      externalId: `gh:${it.id}`,
      url: it.html_url,
      title: it.title || null,
      body: it.body ? it.body.slice(0, 1500) : null,
      author: it.user?.login ?? null,
      community: null,
      score: it.reactions?.total_count ?? 0,
      commentCount: it.comments ?? 0,
      createdAt: new Date(it.created_at),
    }));
  } catch {
    return [];
  }
}

export async function fetchRawLemmy(keyword: string): Promise<RawSourceResult[]> {
  try {
    const instance = 'lemmy.world';
    const params = new URLSearchParams({ q: keyword, type_: 'Posts', sort: 'New', limit: '15' });
    const res = await fetch(`https://${instance}/api/v3/search?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json() as {
      posts?: Array<{
        post: { id: number; name: string; body?: string; ap_id: string; published: string };
        creator: { name: string };
        counts: { score: number; comments: number };
        community: { name: string };
      }>
    };
    return (data.posts ?? [])
      .filter(({ post }) => (post.body ?? '').length >= 40 || post.name.length >= 40)
      .map(({ post, creator, counts, community }) => ({
        source: 'lemmy',
        externalId: `lemmy:${instance}:${post.id}`,
        url: post.ap_id,
        title: post.name || null,
        body: post.body ? post.body.slice(0, 1500) : null,
        author: creator.name,
        community: `!${community.name}`,
        score: counts.score ?? 0,
        commentCount: counts.comments ?? 0,
        createdAt: new Date(post.published),
      }));
  } catch {
    return [];
  }
}

export async function fetchRawYouTube(keyword: string): Promise<RawSourceResult[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];
  try {
    const params = new URLSearchParams({
      part: 'snippet',
      q: keyword,
      type: 'video',
      order: 'date',
      maxResults: '12',
      publishedAfter: new Date(Date.now() - 30 * 86400 * 1000).toISOString(),
      key: apiKey,
    });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json() as {
      items?: Array<{
        id?: { videoId?: string };
        snippet?: { title?: string; description?: string; channelTitle?: string; publishedAt?: string };
      }>
    };
    return (data.items ?? [])
      .filter((it) => it.id?.videoId)
      .map((it) => ({
        source: 'youtube',
        externalId: `yt:${it.id!.videoId}`,
        url: `https://www.youtube.com/watch?v=${it.id!.videoId}`,
        title: it.snippet?.title || null,
        body: it.snippet?.description ? it.snippet.description.slice(0, 1500) : null,
        author: it.snippet?.channelTitle ?? null,
        community: it.snippet?.channelTitle ?? null,
        score: 0,
        commentCount: 0,
        createdAt: it.snippet?.publishedAt ? new Date(it.snippet.publishedAt) : new Date(),
      }));
  } catch {
    return [];
  }
}

// dev.to (Forem). Its /search/feed_content endpoint returns {"result":[]} for anonymous callers
// (HTTP 200), so the only path that actually returns data is the tag-based /api/articles list. We
// derive a tag from the keyword's first significant word and keep articles whose text matches the
// keyword. Coverage is therefore tag-shaped (honest: dev.to only surfaces when the term is a tag).
export async function fetchRawDevto(keyword: string): Promise<RawSourceResult[]> {
  try {
    const tag = keyword.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, '')).find((w) => w.length >= 3);
    if (!tag) return [];
    const headers: Record<string, string> = { 'User-Agent': 'BuilderRadar/2.0 (+https://builderradar.pro)' };
    if (process.env.DEVTO_API_KEY) headers['api-key'] = process.env.DEVTO_API_KEY;
    const res = await fetch(`https://dev.to/api/articles?per_page=30&tag=${encodeURIComponent(tag)}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return []; // non-existent tag → 404, skip
    const data = await res.json() as Array<{
      id: number; title: string; description?: string; url: string;
      user?: { username?: string; name?: string }; public_reactions_count?: number;
      comments_count?: number; published_timestamp?: string; published_at?: string; tag_list?: string[];
    }>;
    if (!Array.isArray(data)) return [];
    return data.map((a) => ({
      source: 'devto',
      externalId: `devto:${a.id}`,
      url: a.url,
      title: a.title || null,
      body: a.description ? a.description.slice(0, 1500) : null,
      author: a.user?.username ?? a.user?.name ?? null,
      community: `DEV #${tag}`,
      score: a.public_reactions_count ?? 0,
      commentCount: a.comments_count ?? 0,
      createdAt: a.published_timestamp ? new Date(a.published_timestamp) : a.published_at ? new Date(a.published_at) : new Date(),
    }));
  } catch {
    return [];
  }
}

export async function fetchRawMedium(keyword: string): Promise<RawSourceResult[]> {
  try {
    const slug = keyword.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) return [];
    const res = await fetch(`https://medium.com/feed/tag/${slug}`, {
      headers: { 'User-Agent': 'BuilderRadar/2.0 (+https://builderradar.pro)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return rssItems(xml)
      .map((it) => {
        const link = rssTag(it, 'link');
        const body = stripHtml(rssTag(it, 'content:encoded') ?? rssTag(it, 'description') ?? '').slice(0, 1500);
        return {
          source: 'medium',
          externalId: `medium:${rssTag(it, 'guid') ?? link ?? ''}`,
          url: link ?? '',
          title: rssTag(it, 'title') || null,
          body: body || null,
          author: rssTag(it, 'dc:creator'),
          community: `Medium #${slug}`,
          score: 0,
          commentCount: 0,
          createdAt: rssTag(it, 'pubDate') ? new Date(rssTag(it, 'pubDate')!) : new Date(),
        };
      })
      .filter((r) => r.url && textMatchesKeyword(`${r.title ?? ''} ${r.body ?? ''}`, keyword));
  } catch {
    return [];
  }
}

export async function fetchRawNews(keyword: string): Promise<RawSourceResult[]> {
  try {
    const q = keyword.trim().includes(' ') ? `"${keyword.trim()}"` : keyword.trim();
    const res = await fetch(
      `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`,
      { headers: { 'User-Agent': 'BuilderRadar/2.0 (+https://builderradar.pro)' }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return [];
    const xml = await res.text();
    return rssItems(xml)
      .slice(0, 20)
      .map((it) => {
        const link = rssTag(it, 'link');
        const source = rssTag(it, 'source');
        const titleRaw = rssTag(it, 'title') ?? '';
        const title = source && titleRaw.endsWith(` - ${source}`)
          ? titleRaw.slice(0, -(source.length + 3))
          : titleRaw;
        const desc = stripHtml(rssTag(it, 'description') ?? '');
        return {
          source: 'news',
          externalId: `news:${rssTag(it, 'guid') ?? link ?? ''}`,
          url: link ?? '',
          title: title || null,
          body: desc ? desc.slice(0, 1500) : null,
          author: source ?? null,
          community: source ?? 'Google News',
          score: 0,
          commentCount: 0,
          createdAt: rssTag(it, 'pubDate') ? new Date(rssTag(it, 'pubDate')!) : new Date(),
        };
      })
      .filter((r) => r.url);
  } catch {
    return [];
  }
}

export async function fetchRawMastodon(keyword: string): Promise<RawSourceResult[]> {
  try {
    const instance = process.env.MASTODON_INSTANCE || 'mastodon.social';
    const firstWord = keyword.toLowerCase().split(/\s+/).find((w) => w.replace(/[^a-z0-9]/g, '').length >= 4);
    const tag = (firstWord ?? keyword).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!tag) return [];
    const res = await fetch(`https://${instance}/api/v1/timelines/tag/${tag}?limit=20`, {
      headers: { 'User-Agent': 'BuilderRadar/2.0 (+https://builderradar.pro)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json() as Array<{
      id: string; url?: string; uri: string; content: string; created_at: string;
      favourites_count?: number; replies_count?: number;
      account?: { acct?: string; username?: string };
    }>;
    if (!Array.isArray(data)) return [];
    return data
      .map((p) => {
        const body = stripHtml(p.content ?? '').slice(0, 1500);
        return {
          source: 'mastodon',
          externalId: `mastodon:${instance}:${p.id}`,
          url: p.url ?? p.uri,
          title: null,
          body: body || null,
          author: p.account?.acct ?? p.account?.username ?? null,
          community: `#${tag}`,
          score: p.favourites_count ?? 0,
          commentCount: p.replies_count ?? 0,
          createdAt: new Date(p.created_at),
        };
      })
      .filter((r) => r.url && r.body && r.body.length >= 40 && textMatchesKeyword(r.body, keyword));
  } catch {
    return [];
  }
}

export async function fetchRawSourceResults(keyword: string, limit = 120): Promise<RawSourceResult[]> {
  const results = await Promise.all([
    fetchRawReddit(keyword),
    fetchRawHN(keyword),
    fetchRawBluesky(keyword),
    fetchRawStackExchange(keyword),
    fetchRawGitHub(keyword),
    fetchRawLemmy(keyword),
    fetchRawYouTube(keyword),
    fetchRawMedium(keyword),
    fetchRawNews(keyword),
    fetchRawMastodon(keyword),
  ]);

  const seen = new Set<string>();
  return results
    .flat()
    .filter((r) => textMatchesKeyword(`${r.title ?? ''} ${r.body ?? ''} ${r.community ?? ''}`, keyword))
    .filter((r) => {
      const key = `${r.source}:${r.externalId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return !!r.url;
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}
