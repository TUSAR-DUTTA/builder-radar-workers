export type BlogPost = {
  slug: string;
  title: string;
  description: string;
  category: string;
  date: string;
  readTime: string;
  sections: Array<{
    heading: string;
    body: string[];
    bullets?: string[];
  }>;
};

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: 'why-chatgpt-recommends-your-competitor',
    title: 'Why ChatGPT Recommends Your Competitor (And What It Reads To Decide)',
    description: 'When a buyer asks ChatGPT for "the best tool for X", an answer comes back with names in it. If yours is not one of them, here is what is actually happening — and the sources behind it.',
    category: 'GEO',
    date: '2026-06-12',
    readTime: '6 min read',
    sections: [
      {
        heading: 'The answer is assembled, not retrieved',
        body: [
          'When someone asks ChatGPT or Gemini to recommend a tool, the model is not reading your homepage. It is assembling an answer from the pages it was trained on and the sources it retrieves at answer time — comparison posts, Reddit threads, G2 roundups, docs.',
          'So the question is never "is my site good enough". It is "do the sources the model trusts mention me, in the context of the buyer\'s question". Your competitor is winning because those sources name them and not you.',
        ],
      },
      {
        heading: 'See the sources, not just the score',
        body: [
          'Knowing you are absent is the alarm. Knowing which sources the answer pulled from is the explanation. For each buyer prompt where you lose, the citation-source graph shows the exact pages the answer leaned on.',
          'That turns a vague "we need more content" into a concrete picture: this listicle, that Reddit thread, this competitor\'s comparison page. You can see exactly where the recommendation is coming from.',
        ],
        bullets: [
          'Track the buyer prompts where you are absent.',
          'Read the sources those answers cite instead.',
          'See which source the answer leaned on.',
        ],
      },
      {
        heading: 'Then watch the answer change',
        body: [
          'Those same prompts keep getting re-sampled, so when the AI\'s answer on them changes — up or down — you see it. Model answers shift over weeks to months, so this is a change you watch over time, not an overnight scorecard.',
          'That makes it a continuous read on the answer, not a one-time audit — you see what changed and when, and draw your own conclusions.',
        ],
      },
    ],
  },
  {
    slug: 'ai-answer-visibility-is-the-new-seo',
    title: 'AI Answer Visibility Is The New SEO',
    description: 'Buyers increasingly start research inside ChatGPT and Gemini, not Google. Being the recommended answer is becoming more valuable than ranking #1.',
    category: 'Strategy',
    date: '2026-06-12',
    readTime: '5 min read',
    sections: [
      {
        heading: 'The funnel moved upstream',
        body: [
          'A growing share of B2B buyers now open an AI chatbot before they open Google. They ask for the shortlist directly — "what are the best options for X" — and act on the three names that come back.',
          'That shortlist is the new first page of search results. If you are not on it, you are not in the consideration set, no matter where you rank on Google.',
        ],
      },
      {
        heading: 'Visibility, not rankings',
        body: [
          'In classic SEO you track keyword positions. In AI answers there is no position — there is whether you are recommended, merely named, or absent across the questions your buyers actually ask.',
          'That is the metric to manage: your share of AI answers versus competitors, prompt by prompt.',
        ],
      },
      {
        heading: 'The work rhymes, the surface is new',
        body: [
          'The good news: the levers are familiar — earn citations on the pages models trust, publish the comparison the buyer is looking for, get into the roundups. The new part is measuring it where buyers now look.',
        ],
      },
    ],
  },
  {
    slug: 'a-single-ai-answer-is-noise',
    title: 'A Single ChatGPT Answer Is Noise — Measure The Week',
    description: 'Ask the same question twice and the brand list can change. Here is why single-run GEO checks mislead, and what to measure instead.',
    category: 'Methodology',
    date: '2026-06-12',
    readTime: '4 min read',
    sections: [
      {
        heading: 'The same prompt, different answers',
        body: [
          'Run the exact same buyer question through ChatGPT twice and you will often get a different set of recommended tools. The models are non-deterministic, and retrieved sources shift run to run.',
          'A single check that says "you are absent" might be luck — and so might one that says "you are recommended". Either way, you cannot make decisions on one sample.',
        ],
      },
      {
        heading: 'Aggregate to find the signal',
        body: [
          'The fix is replication: sample each prompt daily across engines, then aggregate over the week. A brand that shows up in 1 of 7 runs is genuinely weak; one in 6 of 7 is genuinely strong. The noise averages out.',
          'That is why a trustworthy visibility score is a weekly number, not a screenshot of a single chat.',
        ],
        bullets: [
          'Sample daily, across ChatGPT and Gemini.',
          'Aggregate weekly — the week is the unit of truth.',
          'Treat any single answer as one data point, never proof.',
        ],
      },
    ],
  },
  {
    slug: 'the-closed-loop-watch-the-answer-change',
    title: 'Watch the AI’s Answer Change Over Time',
    description: 'Monitoring tells you where you stand. The value is seeing the answer change over time — getting alerted the moment the AI’s answer on a prompt you track actually shifts.',
    category: 'GEO',
    date: '2026-06-12',
    readTime: '5 min read',
    sections: [
      {
        heading: 'Monitoring is table stakes',
        body: [
          'Plenty of tools will show you a visibility dashboard. A dashboard alone does not grow anything — but a thermometer you read once is very different from one you watch over time.',
          'The leverage is in watching it across the buyer questions that matter to you, run over run, so when an answer shifts you catch it — instead of finding out months later.',
        ],
      },
      {
        heading: 'Watch the answer over time',
        body: [
          'Each tracked prompt is a buyer question that matters to you — and the answer to it is what we keep watching, run over run.',
          'Those same prompts are re-sampled on every run, so when the AI’s answer changes you get alerted — tied to the exact prompt. Be honest about the horizon: model answers shift over weeks to months, not days, so this is a change signal you watch over time, not an overnight scorecard.',
        ],
        bullets: [
          'Track the buyer prompts that matter to you.',
          'Keep re-sampling those prompts run over run.',
          'Get alerted when the answer on them changes — up or down.',
        ],
      },
    ],
  },
];

export function getBlogPost(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((p) => p.slug === slug);
}
