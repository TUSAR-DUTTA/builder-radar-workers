// Public "AI visibility leaderboard" data — who the AI engines recommend in a given niche, and the
// sources behind it. This is a zero-budget marketing engine: it's linkable, shareable, and lures the
// exact founders we want into the tool ("you're #6 — see why, and the sources behind each ranking").
//
// STATIC snapshot by design (same rationale as /api/demo/geo): it costs nothing to serve, never 404s
// after a DB change, and renders identically every load. REFRESH WEEKLY by re-running a tracked
// project for the niche and pasting its share-of-answers + top cited sources into the entries below —
// then bump `updatedAt`. Add a niche by appending another object; the index + detail pages pick it up.

export interface LeaderboardSource {
  domain: string;
  url: string;
  sourceType: 'reddit' | 'g2' | 'listicle' | 'youtube' | 'blog' | 'docs' | 'other';
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  /** Share-of-AI-answers score, 0–100 (how often AI recommends this tool on the niche's prompts). */
  score: number;
  /** The off-site sources most feeding this tool's recommendations. */
  sources: LeaderboardSource[];
}

export interface Niche {
  slug: string;
  title: string;
  /** The buyer question category this leaderboard answers. */
  tagline: string;
  /** ISO date of the last refresh. */
  updatedAt: string;
  /** Number of buyer prompts sampled across engines to build the ranking. */
  promptCount: number;
  engines: string[];
  entries: LeaderboardEntry[];
}

export const NICHES: Niche[] = [
  {
    slug: 'project-management-tools',
    title: 'Project Management Tools',
    tagline: 'Which project management tools AI assistants recommend when buyers ask — and the sources behind each.',
    updatedAt: '2026-06-18',
    promptCount: 8,
    engines: ['ChatGPT', 'Perplexity', 'Claude', 'Gemini'],
    entries: [
      {
        rank: 1, name: 'Notion', score: 83,
        sources: [
          { domain: 'reddit.com', url: 'https://www.reddit.com/r/automation/comments/1qidbt0/strategies_for_identifying_and_automating/', sourceType: 'reddit' },
          { domain: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Notion_(productivity_software)', sourceType: 'other' },
          { domain: 'notion.com', url: 'https://www.notion.com/teams', sourceType: 'docs' },
        ],
      },
      {
        rank: 2, name: 'Monday.com', score: 65,
        sources: [
          { domain: 'teamwork.com', url: 'https://www.teamwork.com/blog/ai-project-management-tools/', sourceType: 'listicle' },
          { domain: 'salesforce.com', url: 'https://www.salesforce.com/artificial-intelligence/ai-for-small-business/best-ai-tools/', sourceType: 'listicle' },
        ],
      },
      {
        rank: 3, name: 'Asana', score: 60,
        sources: [
          { domain: 'rippling.com', url: 'https://www.rippling.com/blog/ai-tools-for-small-businesses', sourceType: 'listicle' },
          { domain: 'slack.com', url: 'https://slack.com/intl/en-in/blog/productivity/the-best-ai-productivity-tools-to-transform-your-workday', sourceType: 'blog' },
        ],
      },
      {
        rank: 4, name: 'ClickUp', score: 54,
        sources: [
          { domain: 'teamwork.com', url: 'https://www.teamwork.com/blog/ai-project-management-tools/', sourceType: 'listicle' },
        ],
      },
      {
        rank: 5, name: 'Confluence', score: 19,
        sources: [
          { domain: 'atlassian.com', url: 'https://www.atlassian.com/agile/project-management/task-automation', sourceType: 'docs' },
        ],
      },
      {
        rank: 6, name: 'Coda', score: 6,
        sources: [
          { domain: 'thedigitalprojectmanager.com', url: 'https://thedigitalprojectmanager.com/tools/best-coda-alternatives/', sourceType: 'listicle' },
          { domain: 'getgrist.com', url: 'https://www.getgrist.com/lookup/coda-alternative/', sourceType: 'other' },
        ],
      },
    ],
  },
];

export function listNiches(): Niche[] {
  return NICHES;
}

export function getNiche(slug: string): Niche | null {
  return NICHES.find((n) => n.slug === slug) ?? null;
}
