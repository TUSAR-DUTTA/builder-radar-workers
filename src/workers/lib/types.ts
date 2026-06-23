export interface RawSignal {
  id: string;
  projectId: string;
  source: string;
  platform: string;
  community?: string;
  url: string;
  title?: string;
  body?: string;
  author?: string;
  score?: number;
  commentCount?: number;
  createdAt: string; // ISO 8601
  metadata?: Record<string, unknown>;
}

export interface WorkerConfig {
  projectId: string;
  /** Structured search keywords (no agent_anchor phrases) — used by GitHub, SO, indexed sources. */
  keywords: string[];
  /**
   * High-precision queries for live-firehose sources (Twitter, LinkedIn, Bluesky) that have no
   * server-side relevance ranking. Excludes short generic noun phrases that flood unranked search
   * with cross-domain noise. When unset, those workers fall back to `keywords`.
   */
  liveSearchKeywords?: string[];
  /** Full-text/semantic keywords including agent_anchor phrases — used only by Reddit and HN */
  phraseKeywords?: string[];
  /** Subreddits to poll. If empty, falls back to keyword search across all of Reddit. */
  subreddits?: string[];
  /** GitHub repos to monitor for issues */
  githubRepos?: string[];
  /** Stack Exchange sites to search (e.g. ["stackoverflow", "softwareengineering"]) */
  stackSites?: string[];
  /** Lemmy instance hostname (default: lemmy.world) */
  lemmyInstance?: string;
  /** YouTube channel IDs or search terms */
  youtubeSearchTerms?: string[];
  /** Twitter/X search query override (optional — keywords are used by default) */
  twitterQuery?: string;
}

export type IngestResult = { ingested: number; skipped: number; errors: number };
