export const ICP_EXTRACT_SYSTEM = `You are a product analyst extracting audience intelligence from a software project description.
Analyze the project and return a structured ICP (Ideal Customer Profile) that will be used to:
1. Generate keyword search clusters for Reddit, HN, Stack Overflow, and GitHub
2. Match pain signals from social media
3. Build community targeting recommendations

Be specific. Vague ICPs produce garbage signal matching.
Output ONLY valid JSON.

CRITICAL — SOURCE OF TRUTH:
- The pasted PROJECT DESCRIPTION is the source of truth. Do NOT copy product names, competitors, categories, or keywords from examples in this prompt.
- If the PROJECT DESCRIPTION explicitly lists competitors, tools tried, or alternatives, use those names. Do not replace them with more famous adjacent tools.
- If competitors are not stated, infer cautiously and return [] when unsure. A missing competitor list is better than a hallucinated one.
- Never include demo/example competitors unless they appear verbatim in the PROJECT DESCRIPTION.

CRITICAL — PRODUCT MODEL:
- First identify what the product concretely DOES before deciding the ICP. The buyer is not always "SaaS founder" just because the site mentions SaaS.
- Distinguish:
  (1) product_category: the category a buyer would compare it in
  (2) product_does: the concrete workflow/job it performs
  (3) buyer_persona: who has budget and urgency
  (4) primary_use_cases: actual jobs users hire it for
  (5) non_icp: plausible but wrong audiences/use cases to reject
- Separate DIRECT COMPETITORS from ADJACENT ALTERNATIVES:
  - direct_competitors / competitor_names = products that do the same core job and would be evaluated head-to-head.
  - adjacent_alternatives = channels, marketplaces, agencies, spreadsheets, or partial substitutes that users may mention but that are NOT direct competitors.
  - Example pattern: if a product helps founders sell directly with zero platform fees, AppSumo may be an adjacent channel/marketplace, not necessarily a direct competitor. Do not turn every named channel into the ICP.
- If a named tool/channel is only an example of what users want to avoid, put it in adjacent_alternatives unless the PROJECT DESCRIPTION explicitly frames it as a direct rival.

CRITICAL — KEYWORD RULES (keywords drive Reddit/HN search, precision matters):
- FORBIDDEN single-word generic keywords: developer, saas, startup, build, api, cost, user, app, code, tool, platform
- REQUIRED: include BOTH short root terms (1-2 words, high recall) AND specific phrases (3-5 words, high precision)
  GOOD root: "changelog", "release notes", "investor update"  ← 1-2 words, high HN/Reddit recall
  GOOD phrase: "writing release notes manually", "non-technical founder changelog"
  BAD: "changelog tool" (the word 'tool' adds nothing), "product update tools" (too vague)
- ALWAYS include competitor comparison queries: "[CompetitorName] alternative" — NEVER use our own product name
  GOOD: "Canny alternative", "Beamer alternative", "Headway vs Canny"
  BAD: "Headway vs [project_name]" — our product isn't searchable yet
  These return the HIGHEST quality signals — people comparing tools ARE your ICP
- INCLUDE indirect pain phrases — what people say when they have the problem WITHOUT naming it:
  GOOD: "launched to crickets", "nobody using my product", "shipping in private"
  BAD: "launched", "users"

CRITICAL — search_queries RULES (used directly in Reddit/HN search bars):
- Must be 1-3 words maximum — shorter = higher recall on Reddit and HN Algolia
- 1-word domain-specific terms ARE allowed: "changelog", "Canny" — just not generic words
- Must be NOUN PHRASES, not questions: "release notes" YES, "how to write changelogs" NO
- Must be SPECIFIC to this problem domain — "founder tips" or "startup communication" are TOO GENERIC
- AVOID CROSS-DOMAIN COLLISION TERMS — this is the #1 cause of garbage signals. Reject any query that is ALSO common in unrelated high-volume contexts, even if it sounds on-topic. Two collision families to avoid:
  (a) Software/PM jargon: "action items", "meeting notes", "meeting minutes", "meeting summary", "standup notes", "sprint notes" — match dev tickets, working-group minutes, Kanban UIs, code menus.
  (b) Finance/trading/crypto vocabulary: "signals", "demand signals", "traction", "buy signals", "market signals", "momentum", "indicators" — these dominate Twitter/X and flood live search with $TICKER crypto and stock posts. A market-intelligence or analytics ICP is especially prone to this: "demand signals" reads on-topic but returns almost entirely crypto/finance noise.
  (c) Generic business/marketing abstractions: "customer pain", "pain points", "demand", "customers", "leads", "growth", "audience", "founders", "product market fit", "go to market" — these are the vocabulary of every marketing-guru thread on X/LinkedIn. They match advice/listicle/"here's how to find customer pain points 🧵" content (people SELLING the idea), almost never a real buyer IN the pain. A query made entirely of these abstraction words is NEVER acceptable as a search_query.
  Prefer terms UNIQUE to this product's category instead. (e.g. for a meeting-AI product: "meeting transcription", "AI notetaker", NOT "meeting notes"; for a customer-signal product: "find my first customers", "Reddit lead generation", "no one is signing up", a competitor's name + "alternative" — NOT "demand signals" or "customer pain".)
- META-PRODUCT WARNING: if the product description ITSELF is about marketing, signals, pain, customers, demand, finding users/leads, or social listening (i.e. its own pitch reuses the abstraction words above), you will be tempted to lift those words straight into search_queries. DO NOT. For this product class the search_queries MUST be the concrete, first-person way a BUYER phrases the moment of frustration: "nobody is using my app", "how do I get my first customers", "where do my users hang out", "launched but no signups", "struggling to find customers", "tired of manually searching Reddit for leads". CAUTION on competitor "[Name] alternative" queries here: for a meta-product (a tool whose buyers are themselves founders/makers/marketers) those threads are dominated by OTHER builders shipping rival tools, not buyers — so include AT MOST one or two competitor queries and make buyer-frustration phrases the majority. (For a normal vertical SaaS, by contrast, competitor "[Name] alternative" queries remain the highest-precision option — this caution applies only when the buyer and the competitor are the same kind of person.)
- Required: at least 2 root terms ("changelog", "release notes") + at least 2 competitor comparisons ("Canny alternative")
- FINAL SELF-CHECK (do this before returning): re-read every search_query you wrote. For each one, ask "would searching this exact phrase on Reddit/Twitter return mostly people in THIS product's specific problem — or mostly crypto, marketing advice, or unrelated chatter?" If it's the latter, DELETE it and replace with a competitor "[Name] alternative" or a concrete buyer-frustration phrase. A shorter list of precise queries beats a long list with collisions.

CRITICAL — pain_triggers & emotional_triggers (these directly power signal matching — invest the most effort here):
- Both arrays are matched VERBATIM, phrase-by-phrase, against every social post to detect real buyers and to rescue borderline posts that lack your category keywords. They are the single biggest driver of catching real signal, so they must be the LITERAL, first-person sentences a frustrated buyer actually types — NOT abstract descriptions of the problem.
- Provide 8-12 pain_triggers expressing the SAME core frustration phrased MANY different ways. Real buyers almost never use your product's category words ("changelog", "meeting notes"); they describe the raw situation. Variety of phrasing is what catches them — one canonical phrase matches almost nothing.
  GOOD (concrete, keyword-free, varied): "nobody wanted what I built", "I can't get a single user to stick around", "spent 6 months building and have zero traction", "launched to total silence", "how do people actually find their first customers", "tried everything and still no signups", "what did you build that no one used"
  BAD (abstract, matches no real post): "demand discovery", "customer acquisition pain", "lack of product-market fit", "user retention challenges"
- Cover the full emotional arc so different posts match: confusion ("where do I even start"), frustration ("why is this so hard"), resignation ("maybe nobody actually needs this"), and active search ("what do you all use for X", "[Competitor] is too expensive, what else").
- emotional_triggers = short stock openers ("I wish there was", "is there a tool that", "am I the only one who", "how do you handle"); pain_triggers = the fuller first-person situations above. Keep them DISTINCT, don't duplicate across the two.
- DO NOT reuse the product's own marketing words. Translate the polished pitch into the buyer's raw, unpolished, often keyword-free words at the moment of frustration.

CRITICAL — target_communities (subreddits) RULES:
- REQUIRED: list 5-8 subreddits, not 2-3
- Match subreddits to the ACTUAL BUYER PERSONA — not to you as the builder:
  - For NON-TECHNICAL OPERATORS (executive assistants, PMs, ops leads, legal, compliance, admin): MUST include r/productivity, r/projectmanagement, r/adminprofessionals, r/executiveassistant. These people complain about tools on these communities. DO NOT put them in r/buildinpublic.
  - For founder/indie-hacker tools (ICP is someone BUILDING a product): MUST include r/buildinpublic, r/SideProject, r/indiehackers, r/bootstrappers
  - For B2B SaaS tools: include r/SaaS, r/entrepreneur, r/smallbusiness
  - For dev tools: include r/programming, r/webdev, r/devops, r/ExperiencedDevs
  - For no-code/automation: include r/nocode, r/zapier, r/automation
  - For meeting/productivity/collaboration tools used by operators: include r/productivity, r/projectmanagement, r/remotework, r/WorkspaceDesign
- CRITICAL: r/buildinpublic and r/indiehackers are communities for BUILDERS (people making products). Do NOT list them unless the ICP is explicitly people building their own products.
- DO NOT include r/startups unless the ICP specifically targets early-stage startup founders — it is too broad
- Prefer communities where people post problems/questions, not just sharing`;

/**
 * Generic business/marketing abstraction tokens. A SEARCH QUERY (the literal string typed into a
 * Reddit/Twitter search bar) made entirely of these words can't be disambiguated by the search
 * engine — it returns marketing-guru threads and cross-domain noise regardless of how on-topic the
 * product is. This is true EVEN for a product whose core genuinely is "demand signals": searching
 * the bare phrase still returns crypto/finance, so it's a bad *search string* even when it's good
 * *vocabulary*. So we strip these from search_queries only — they stay in `keywords` (which feed the
 * scorer as context, not the search bar). Deliberately NOT domain terms ("changelog", "invoice
 * reconciliation", "API rate limit"): those are specific and survive.
 */
const ABSTRACTION_TOKENS = new Set([
  'pain', 'pains', 'painpoint', 'painpoints', 'signal', 'signals', 'demand', 'customer', 'customers',
  'lead', 'leads', 'growth', 'audience', 'audiences', 'founder', 'founders', 'traction', 'indicator',
  'indicators', 'insight', 'insights', 'feedback', 'sentiment', 'intent', 'revenue', 'churn', 'market',
  'marketing', 'conversion', 'conversions', 'point', 'points', 'user', 'users', 'startup', 'startups',
  'saas', 'product', 'products', 'business', 'opportunity', 'opportunities', 'problem', 'problems',
  // Added 2026-06-06: these completed real collisions that slipped the token check —
  // "product market FIT" (fit), "TARGET customer/audience" (target), "GO TO market"/"gtm",
  // plus the rest of the GTM-guru abstraction vocabulary that floods X/LinkedIn advice threads.
  'fit', 'target', 'targets', 'targeting', 'gtm', 'goto', 'positioning', 'pipeline', 'outbound',
  'reach', 'engagement', 'awareness', 'acquisition', 'retention', 'monetization', 'funnel',
  // Added 2026-06-07: generic business *modifier* nouns that paired with an abstraction head still
  // produce a pure cross-domain search string the prompt forbids but the LLM emits anyway. Live HN
  // retrieval proved "buyer intent" (buyer+intent), "competitor signals" (competitor+signals),
  // "community monitoring" (community+monitoring) return ~100% off-topic noise. These only trip the
  // all-words-generic check, so a query with ANY concrete word ("uptime monitoring", "demand
  // forecasting", "social listening", "price monitoring") still survives — only fully-generic
  // 1-3 word strings are dropped.
  'buyer', 'buyers', 'competitor', 'competitors', 'competition', 'community', 'communities',
  'monitoring', 'monitor',
]);

const STOPWORDS = new Set(['a', 'an', 'the', 'my', 'our', 'for', 'of', 'to', 'and', 'in', 'on', 'real', 'time', 'realtime', 'early', 'find', 'finding']);

/**
 * Exact multi-word collision phrases that are ALWAYS bad search strings regardless of token make-up.
 * The token-by-token `isBareAbstraction` check misses these when one word isn't individually generic
 * (e.g. "fit" in "product market fit") — so we also reject the whole normalized phrase outright. The
 * extraction prompt already forbids these, but the LLM emits them anyway, so this is the real guard.
 */
const COLLISION_PHRASES = new Set([
  'product market fit', 'product-market fit', 'market fit', 'product market',
  'target customer', 'target customers', 'target audience', 'target market', 'target user', 'target users',
  'go to market', 'gtm strategy', 'customer acquisition', 'lead generation', 'demand generation',
  'product led growth', 'ideal customer', 'ideal customer profile',
]);

const normalizePhrase = (q: string): string =>
  q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** Is this query a competitor comparison (always high-precision — never stripped)? */
function isCompetitorComparison(q: string): boolean {
  return /\balternative\b|\bvs\b|\bversus\b|\bbetter than\b/i.test(q);
}

/**
 * True if the query is a bare abstraction: ≤3 tokens and every SIGNIFICANT word (after dropping
 * stopwords) is a generic business/marketing abstraction. "customer pain", "demand signals",
 * "traction indicators" → true. "Reddit lead generation", "changelog", "Canny alternative" → false
 * (contains a concrete/proper word or a comparison).
 */
export function isBareAbstraction(q: string): boolean {
  if (isCompetitorComparison(q)) return false;
  // Whole-phrase collision blocklist — catches phrases the token check misses ("product market fit").
  if (COLLISION_PHRASES.has(normalizePhrase(q))) return true;
  const words = q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const significant = words.filter((w) => !STOPWORDS.has(w));
  if (significant.length === 0 || significant.length > 3) return false;
  return significant.every((w) => ABSTRACTION_TOKENS.has(w));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeCompetitorName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function splitCompetitorNames(value: string): string[] {
  return value
    .split(/\s+(?:\/|and|&)\s+|,\s*/i)
    .map((name) => normalizeCompetitorName(name.replace(/\s*\([^)]*\)\s*$/g, '')))
    .filter((name) => /^[A-Z0-9][A-Za-z0-9 .+-]{1,40}$/.test(name))
    .filter((name) => !/^(google|reddit|twitter|x|github|hacker news|youtube|stackoverflow)$/i.test(name));
}

/**
 * Deterministic rescue for descriptions that explicitly contain a "direct competitors" list.
 * The LLM often returns only the first 2-3 names, which silently drops the best retrieval queries
 * ("[Competitor] alternative"). We only read the explicit competitor section, then still require
 * the names to appear verbatim in the pasted project text before adding them to the ICP.
 */
function extractExplicitDirectCompetitors(projectMd: string): string[] {
  const lines = projectMd.split(/\r?\n/);
  const found: string[] = [];
  let inSection = false;
  let blanks = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/direct competitors|competitors \(real tools|real tools the buyer/i.test(line)) {
      inSection = true;
      blanks = 0;
      continue;
    }
    if (!inSection) continue;
    if (!line) {
      blanks += 1;
      if (blanks >= 2 && found.length > 0) break;
      continue;
    }
    blanks = 0;

    // Stop when a new prose section starts after we have collected at least one name.
    if (found.length > 0 && !/^[-*•]?\s*[A-Z0-9][A-Za-z0-9 .+/-]{1,60}(?:\s*\(|\s*[-–—:]|\s*$)/.test(line)) break;

    const cleaned = line.replace(/^[-*•\d.)\s]+/, '');
    const firstChunk = cleaned.split(/\s+[-–—:]\s+|\s*\(/)[0]?.trim() ?? '';
    for (const name of splitCompetitorNames(firstChunk)) found.push(name);
  }

  return [...new Set(found)].filter((name) => isProjectMention(projectMd, name));
}

function isProjectMention(projectMd: string, value: string): boolean {
  const normalized = normalizeCompetitorName(value);
  if (!normalized) return false;
  const escaped = normalized.split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(projectMd);
}

function competitorFromComparisonQuery(query: string): string | null {
  const trimmed = query.trim();
  const alt = trimmed.match(/^(.+?)\s+(?:alternative|alternatives)$/i);
  if (alt?.[1]) return normalizeCompetitorName(alt[1]);

  const better = trimmed.match(/^better\s+than\s+(.+?)$/i);
  if (better?.[1]) return normalizeCompetitorName(better[1]);

  const vs = trimmed.match(/^(.+?)\s+(?:vs|versus)\s+(.+?)$/i);
  if (vs?.[1] && vs?.[2]) return `${normalizeCompetitorName(vs[1])}|${normalizeCompetitorName(vs[2])}`;

  return null;
}

function comparisonMentionsProjectCompetitor(projectMd: string, query: string): boolean {
  const competitor = competitorFromComparisonQuery(query);
  if (!competitor) return true;
  return competitor.split('|').some((name) => isProjectMention(projectMd, name));
}

/**
 * True when a "[X] alternative"/"X vs Y" query targets a name the model classified as an ADJACENT
 * alternative (a marketplace/channel the product bypasses) rather than a DIRECT competitor. The
 * prompt tells the model not to emit these, but it does anyway (e.g. "AppSumo alternative" for a
 * zero-fee-checkout product that merely bypasses AppSumo) — so this is the deterministic guard that
 * actually honors the founder's "don't compare me to that platform". Direct comparisons win ties:
 * if the same name is also a direct competitor, the query is kept.
 */
function comparisonTargetsAdjacentNotDirect(query: string, directNames: string[], adjacentNames: string[]): boolean {
  const competitor = competitorFromComparisonQuery(query);
  if (!competitor) return false;
  const eq = (list: string[], n: string) =>
    list.some((x) => normalizeCompetitorName(x).toLowerCase() === normalizeCompetitorName(n).toLowerCase());
  const names = competitor.split('|');
  const isDirect = names.some((n) => eq(directNames, n));
  const isAdjacent = names.some((n) => eq(adjacentNames, n));
  return isAdjacent && !isDirect;
}

/**
 * The product's OWN name(s). A "[OwnProduct] alternative" or "X vs OwnProduct" query is worthless —
 * the product isn't searchable yet, so it returns zero/garbage and burns a high-rank retrieval slot
 * (and the extraction prompt explicitly forbids using the product's own name). We read the name from
 * the LLM's project_name/product_name fields and fall back to the project.md H1 title.
 */
export function productOwnNames(profile: { project_name?: unknown; product_name?: unknown; name?: unknown }, projectMd: string): string[] {
  const names = new Set<string>();
  for (const v of [profile?.project_name, profile?.product_name, profile?.name]) {
    if (typeof v === 'string' && v.trim()) names.add(normalizeCompetitorName(v));
  }
  const h1 = projectMd.match(/^\s*#\s+([^\n]+)/m)?.[1];
  if (h1) names.add(normalizeCompetitorName(h1.replace(/\s*[-–—:|].*$/, '')));
  return [...names].filter((n) => n.length >= 2);
}

/** True when a comparison query ("[X] alternative", "X vs Y") targets the product's own name. */
function comparisonTargetsOwnProduct(query: string, ownNames: string[]): boolean {
  if (ownNames.length === 0) return false;
  const competitor = competitorFromComparisonQuery(query);
  if (!competitor) return false;
  const targets = competitor.split('|').map((n) => normalizeCompetitorName(n).toLowerCase());
  return ownNames.some((own) => targets.includes(own.toLowerCase()));
}

/**
 * Deterministic backstop applied AFTER the LLM extraction (it ignores the prompt's anti-collision
 * rule for meta-products whose own pitch is saturated with abstraction words). Strips bare-abstraction
 * search_queries across ALL clusters, then applies a PROJECT-LEVEL safeguard: if stripping would leave
 * fewer than `minKept` total search_queries (e.g. a meta-product where every core query is an
 * abstraction), the strip is abandoned and the originals are kept with a warning, so a project is never
 * left unsearchable. Competitor "[X] alternative" queries are never abstractions, so a project with the
 * required ≥2 competitor comparisons always clears the safeguard and the noisy abstractions are dropped.
 * `keywords`, `emotional_triggers`, and competitor queries are left fully intact. Returns the sanitized
 * icp plus the list of dropped queries for logging.
 */
export function sanitizeIcpSearchQueries(icp: unknown, minKept = 2): { icp: unknown; dropped: string[] } {
  const profile = icp as { keyword_clusters?: Array<{ search_queries?: string[]; [k: string]: unknown }> };
  if (!profile || !Array.isArray(profile.keyword_clusters)) return { icp, dropped: [] };

  const dropped: string[] = [];
  let totalKept = 0;
  const clusters = profile.keyword_clusters.map((cluster) => {
    if (!Array.isArray(cluster.search_queries) || cluster.search_queries.length === 0) return cluster;
    const kept = cluster.search_queries.filter((q) => !isBareAbstraction(q));
    const removed = cluster.search_queries.filter((q) => isBareAbstraction(q));
    totalKept += kept.length;
    dropped.push(...removed);
    return { ...cluster, search_queries: kept };
  });

  // Project-level safeguard: abandon the strip entirely if it would leave the project barely searchable.
  if (totalKept < minKept) {
    console.warn(`[icp] sanitize would leave only ${totalKept} search_queries — keeping originals, hand-correction recommended (dropped would be: ${dropped.map((d) => `"${d}"`).join(', ')})`);
    return { icp, dropped: [] };
  }

  return { icp: { ...profile, keyword_clusters: clusters }, dropped };
}

/**
 * Whole-profile guardrail applied after LLM extraction. The prompt contains examples, and weaker
 * models sometimes copy example competitor names into real projects. When a competitor-comparison
 * query references a product that never appears in the user's project.md, drop that query. Likewise,
 * if some returned competitor_names are grounded in the project.md, keep only grounded names.
 */
export function sanitizeExtractedIcpProfile(icp: unknown, projectMd: string): { icp: unknown; dropped: string[]; droppedCompetitors: string[] } {
  const searchSanitized = sanitizeIcpSearchQueries(icp);
  const profile = searchSanitized.icp as {
    product_category?: unknown;
    product_does?: unknown;
    buyer_persona?: unknown;
    primary_use_cases?: unknown;
    non_icp?: unknown;
    direct_competitors?: unknown;
    adjacent_alternatives?: unknown;
    search_queries?: unknown;
    competitor_names?: unknown;
    competitors?: unknown;
    keyword_clusters?: Array<{ keywords?: string[]; search_queries?: string[]; [k: string]: unknown }>;
    category?: unknown;
    [k: string]: unknown;
  };
  if (!profile || typeof profile !== 'object') {
    return { icp: searchSanitized.icp, dropped: searchSanitized.dropped, droppedCompetitors: [] };
  }

  const dropped: string[] = [...searchSanitized.dropped];
  const droppedCompetitors: string[] = [];

  const explicitCompetitors = extractExplicitDirectCompetitors(projectMd);
  const directCompetitors = Array.isArray(profile.direct_competitors)
    ? profile.direct_competitors.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];
  const competitorNamesRaw = Array.isArray(profile.competitor_names)
    ? profile.competitor_names.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];
  const ownNames = productOwnNames(profile as { project_name?: unknown; product_name?: unknown; name?: unknown }, projectMd);
  const isOwnName = (n: string) => ownNames.some((own) => own.toLowerCase() === normalizeCompetitorName(n).toLowerCase());
  const competitorNames = [...new Set([...competitorNamesRaw, ...directCompetitors, ...explicitCompetitors].map(normalizeCompetitorName))]
    .filter((n) => !isOwnName(n)); // the product can't be its own competitor (LLM sometimes lists it)
  const groundedCompetitors = competitorNames.filter((name) => isProjectMention(projectMd, name));
  const hasGroundedCompetitors = groundedCompetitors.length > 0;

  // Names the model classified as ADJACENT (channels/marketplaces the product bypasses, not rivals).
  // Used to strip "[adjacent] alternative" comparison queries the model emits despite the prompt.
  const adjacentAlternatives = Array.isArray(profile.adjacent_alternatives)
    ? profile.adjacent_alternatives.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];

  const topLevelSearchQueries = Array.isArray(profile.search_queries)
    ? profile.search_queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
    : [];
  const keptTopLevelQueries = topLevelSearchQueries.filter((q) => !isBareAbstraction(q));
  dropped.push(...topLevelSearchQueries.filter((q) => isBareAbstraction(q)));
  const initialClusters = Array.isArray(profile.keyword_clusters)
    ? profile.keyword_clusters
    : [];
  const clustersWithTopLevelQueries = keptTopLevelQueries.length > 0
    ? mergeTopLevelSearchQueries(initialClusters, keptTopLevelQueries)
    : initialClusters;

  const nextClustersBase = Array.isArray(clustersWithTopLevelQueries)
    ? clustersWithTopLevelQueries.map((cluster) => {
        const keywords = Array.isArray(cluster.keywords)
          ? cluster.keywords.filter((kw) => {
              if (!isCompetitorComparison(kw)) return true;
              if (comparisonTargetsOwnProduct(kw, ownNames)) { dropped.push(kw); return false; }
              if (comparisonTargetsAdjacentNotDirect(kw, competitorNames, adjacentAlternatives)) { dropped.push(kw); return false; }
              const keep = comparisonMentionsProjectCompetitor(projectMd, kw);
              if (!keep) dropped.push(kw);
              return keep;
            })
          : cluster.keywords;
        const searchQueries = Array.isArray(cluster.search_queries)
          ? cluster.search_queries.filter((q) => {
              if (!isCompetitorComparison(q)) return true;
              if (comparisonTargetsOwnProduct(q, ownNames)) { dropped.push(q); return false; }
              if (comparisonTargetsAdjacentNotDirect(q, competitorNames, adjacentAlternatives)) { dropped.push(q); return false; }
              const keep = comparisonMentionsProjectCompetitor(projectMd, q);
              if (!keep) dropped.push(q);
              return keep;
            })
          : cluster.search_queries;
        return { ...cluster, keywords, search_queries: searchQueries };
      })
    : profile.keyword_clusters;

  // Do NOT auto-generate "[X] alternative" queries for ADJACENT tools (channels/marketplaces the
  // product merely bypasses, e.g. Mention/Brand24 for a Reddit-listening product). They get grounded
  // when the project.md lists them, but a "Mention alternative" search returns brand-PR/news-monitoring
  // people, not this product's buyers — the exact noise re-introduction this whole pass is removing.
  const groundedDirectOnly = groundedCompetitors.filter(
    (n) => !adjacentAlternatives.some((a) => normalizeCompetitorName(a).toLowerCase() === normalizeCompetitorName(n).toLowerCase()),
  );
  const nextClusters = Array.isArray(nextClustersBase)
    ? ensureCompetitorComparisonQueries(nextClustersBase, groundedDirectOnly)
    : nextClustersBase;

  let nextCompetitorNames = profile.competitor_names;
  let nextDirectCompetitors = profile.direct_competitors;
  if (hasGroundedCompetitors) {
    nextCompetitorNames = groundedCompetitors;
    nextDirectCompetitors = groundedCompetitors;
    droppedCompetitors.push(...competitorNames.filter((name) => !isProjectMention(projectMd, name)));
  } else if (competitorNames.length > 0) {
    // The prompt asks the model to infer cautiously, but weaker models still invent famous
    // adjacent tools. Keep those names out of direct competitor fields and surface them as warnings.
    nextCompetitorNames = [];
    nextDirectCompetitors = [];
    droppedCompetitors.push(...competitorNames);
  }

  let nextCompetitors = profile.competitors;
  if (hasGroundedCompetitors && Array.isArray(profile.competitors)) {
    const competitors = profile.competitors.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
    nextCompetitors = competitors.filter((name) => isProjectMention(projectMd, name));
    droppedCompetitors.push(...competitors.filter((name) => !isProjectMention(projectMd, name)));
  }

  return {
    icp: {
      ...profile,
      category: typeof profile.category === 'string' && profile.category.trim()
        ? profile.category
        : profile.product_category,
      direct_competitors: nextDirectCompetitors,
      competitor_names: nextCompetitorNames,
      competitors: nextCompetitors,
      keyword_clusters: nextClusters,
    },
    dropped: [...new Set(dropped)],
    droppedCompetitors: [...new Set(droppedCompetitors)],
  };
}

function ensureCompetitorComparisonQueries(
  clusters: Array<{ cluster_name?: string; search_queries?: string[]; keywords?: string[]; [k: string]: unknown }>,
  competitorNames: string[],
) {
  const comparisons = competitorNames
    .slice(0, 8)
    .map((name) => `${name} alternative`);
  if (comparisons.length === 0) return clusters;

  const idx = clusters.findIndex((c) => c.cluster_name === 'competitor_comparison');
  if (idx >= 0) {
    return clusters.map((cluster, i) => i === idx
      ? {
          ...cluster,
          keywords: [...new Set([...(cluster.keywords ?? []), ...comparisons])],
          search_queries: [...new Set([...(cluster.search_queries ?? []), ...comparisons])],
        }
      : cluster);
  }
  return [
    ...clusters,
    {
      cluster_name: 'competitor_comparison',
      intent: 'comparison',
      keywords: comparisons,
      search_queries: comparisons,
      community_queries: comparisons.map((q) => `site:reddit.com "${q}"`),
    },
  ];
}

function mergeTopLevelSearchQueries(
  clusters: Array<{ cluster_name?: string; search_queries?: string[]; keywords?: string[]; [k: string]: unknown }>,
  topLevelSearchQueries: string[],
) {
  const queries = [...new Set(topLevelSearchQueries.map((q) => q.trim()).filter(Boolean))];
  if (queries.length === 0) return clusters;
  const coreIdx = clusters.findIndex((c) => c.cluster_name === 'core_pain');
  if (coreIdx >= 0) {
    return clusters.map((cluster, idx) => idx === coreIdx
      ? { ...cluster, search_queries: [...new Set([...(cluster.search_queries ?? []), ...queries])] }
      : cluster);
  }
  return [
    ...clusters,
    { cluster_name: 'core_pain', intent: 'frustration', keywords: [], search_queries: queries },
  ];
}

export function assessIcpQuality(icp: unknown): string[] {
  const profile = icp as {
    problem_statement?: unknown;
    product_category?: unknown;
    product_does?: unknown;
    buyer_persona?: unknown;
    pain_before?: unknown;
    pain_triggers?: unknown;
    keyword_clusters?: Array<{ keywords?: string[]; search_queries?: string[] }>;
  };
  const warnings: string[] = [];
  const clusters = Array.isArray(profile?.keyword_clusters) ? profile.keyword_clusters : [];
  const allKeywords = clusters.flatMap((c) => c.keywords ?? []);
  const allQueries = clusters.flatMap((c) => c.search_queries ?? []);
  const multiWordKeywords = allKeywords.filter((kw) => typeof kw === 'string' && kw.trim().split(/\s+/).length >= 2);
  const painTriggers = Array.isArray(profile?.pain_triggers)
    ? profile.pain_triggers.filter((p) => typeof p === 'string' && p.trim().length > 0)
    : [];

  if (typeof profile.product_category !== 'string' || profile.product_category.trim().length < 3) {
    warnings.push('AI did not clearly identify the product category. Review before creating the project.');
  }
  if (typeof profile.product_does !== 'string' || profile.product_does.trim().length < 12) {
    warnings.push('AI did not clearly describe what the product does. Tighten this before sourcing.');
  }
  if (typeof profile.buyer_persona !== 'string' || profile.buyer_persona.trim().length < 5) {
    warnings.push('AI did not clearly identify the buyer persona. Check role/context before saving.');
  }
  if (typeof profile.problem_statement !== 'string' || profile.problem_statement.trim().length < 20) {
    warnings.push('Problem statement is thin. Make it specific to the exact buyer pain.');
  }
  if (typeof profile.pain_before !== 'string' || profile.pain_before.trim().length < 20) {
    warnings.push('Pain-before is thin. Add what the buyer does today without the product.');
  }
  if (multiWordKeywords.length < 4) {
    warnings.push('Keyword set is weak. Add at least four concrete multi-word phrases.');
  }
  if (allQueries.length < 3) {
    warnings.push('Search query set is sparse. Add concrete buyer searches before creating.');
  }
  if (painTriggers.length < 6) {
    warnings.push('Pain triggers are sparse. Add first-person buyer phrases for better matching.');
  }

  return warnings;
}

export function buildICPPrompt(projectMd: string): string {
  return `PROJECT DESCRIPTION:
${projectMd}

Extract and return this exact JSON structure:
{
  "project_name": "string",
  "product_category": "specific category buyers would compare this in, e.g. zero-fee digital commerce infrastructure",
  "product_does": "concrete workflow/job the product performs, not a slogan",
  "buyer_persona": "single sentence naming the buyer with budget and urgency",
  "primary_use_cases": ["3-5 specific jobs users hire the product for"],
  "non_icp": ["plausible but wrong users/use cases to reject"],
  "problem_statement": "one sentence, specific",
  "target_user": {
    "role": "e.g. solo founder, senior developer, non-technical builder",
    "context": "e.g. pre-revenue, just shipped v1, working nights",
    "technical_level": "non-technical | beginner | intermediate | expert",
    "company_size": "solo | 2-10 | 11-50 | 51-200 | enterprise"
  },
  "pain_before": "what they do TODAY without this tool — be specific",
  "alternatives_tried": ["list of specific tools/methods they've already tried"],
  "direct_competitors": ["ONLY products doing the same core job and named in the project description, otherwise []"],
  "adjacent_alternatives": ["marketplaces, channels, agencies, spreadsheets, or partial substitutes that are NOT direct competitors"],
  "emotional_triggers": ["I wish there was", "is there a tool that", "am I the only one who", "how do you all handle"],
  "pain_triggers": ["nobody wanted what I built", "can't get a single user to stick", "spent months building and have zero traction", "launched to crickets", "how do I find my first customers", "tried everything and still no signups", "what did you build that no one used", "where do my potential users even hang out"],
  "search_queries": ["top 6-10 concrete search strings, de-duped from keyword_clusters"],
  "keyword_clusters": [
    {
      "cluster_name": "core_pain",
      "intent": "frustration",
      "keywords": ["specific buyer phrase from this project", "another concrete phrase from this project"],
      "search_queries": ["short category term", "specific pain phrase"],
      "community_queries": ["site:reddit.com \"specific phrase from this project\""]
    },
    {
      "cluster_name": "competitor_comparison",
      "intent": "comparison",
      "keywords": ["[stated competitor] alternative", "better than [stated competitor]"],
      "search_queries": ["[stated competitor] alternative"],
      "community_queries": ["site:reddit.com \"[stated competitor] alternative\""]
    }
  ],
  "competitor_names": ["same as direct_competitors, direct rivals only"],
  "category": "dev-tool | b2b-saas | consumer | marketplace | api | productivity",
  "g2_categories": ["G2 category slug for competitor review mining"],
  "github_repos": ["ONLY list repos that ACTUALLY EXIST on GitHub with public issues. CLOSED-SOURCE COMMERCIAL SAAS PRODUCTS (Otter.ai, Fireflies.ai, Fathom, Grain, Gong, Notion, Zoom, Slack, HubSpot, Salesforce, etc.) have NO public GitHub repos — do NOT invent plausible-sounding org/repo paths for them. Only include repos for open-source tools or developer tools with verified public issue trackers (e.g. 'jitsi/jitsi-meet', 'bigbluebutton/bigbluebutton'). If there are no valid competitor repos, return []."],
  "target_communities": [
    { "subreddit": "indiehackers", "reason": "solo founders discuss shipping and communication" },
    { "subreddit": "buildinpublic", "reason": "founders sharing shipping updates publicly" },
    { "subreddit": "SideProject", "reason": "indie makers launching tools" },
    { "subreddit": "bootstrappers", "reason": "bootstrapped founders seeking growth" },
    { "subreddit": "microsaas", "reason": "micro-SaaS operators with tight communication needs" }
  ]
}

REMEMBER:
- Every value above is a schema placeholder. Replace it with project-specific content from the PROJECT DESCRIPTION.
- Do not include Canny, Beamer, Headway, ReleaseLog, changelog, release notes, or investor update unless the PROJECT DESCRIPTION itself mentions those terms.
- Keep direct_competitors and competitor_names STRICT. If a tool/channel is not explicitly named as a head-to-head product, put it in adjacent_alternatives or return [].
- App marketplaces, deal sites, app stores, agencies, and spreadsheets are often adjacent alternatives, not direct competitors. Do not let one adjacent channel become the whole ICP narrative.
- pain_triggers (8-12) AND emotional_triggers must be LITERAL first-person buyer sentences phrased many different ways, keyword-free — they are matched verbatim against posts and are the #1 driver of catching (and rescuing) real signal. Abstract phrases match nothing.
- keyword_clusters must include a "competitor_comparison" cluster with "[Competitor] alternative" queries
- search_queries must be SHORT (1-3 word) root terms and stated-competitor comparisons. Use phrases from this project, not prompt examples.
- target_communities must have 5-8 subreddits — match to the actual buyer persona (operators/PMs → productivity/projectmanagement; founders → buildinpublic/indiehackers)
- github_repos: ONLY include repos that actually exist on GitHub with public issues — closed-source SaaS competitors have no public repos, return [] for those
- Replace ALL example values above with project-specific content`;
}
