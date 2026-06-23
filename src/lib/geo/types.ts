// GEO engine shared types. See GEO_PIVOT_DESIGN.md.

export type Verdict = 'recommended' | 'named' | 'absent';
// Stored in answer_runs.model. The display label / expected-set / grounded-ness for each lives in
// the engine registry (src/lib/geo/engines.ts) — add a new engine there. 'google-aio' (Google AI
// Overviews) is fed by the Playwright worker; the API cron only emits gemini-grounded + openai-search.
export type AnswerModel = 'gemini-grounded' | 'openai-search' | 'claude' | 'perplexity' | 'google-aio' | 'copilot' | 'deepseek' | 'grok';
export type PromptIntent = 'category' | 'competitor_alt' | 'brand_direct' | 'comparison' | 'other';

export interface UrlExtraction {
  brand: string;
  category: string;
  persona: string;
  competitors: string[];
  prompts: { prompt: string; intent: PromptIntent }[];
}

export interface AnswerSample {
  prompt: string;
  model: AnswerModel;
  answer: string;
  citations: { url: string; title?: string }[];
  verdicts: Record<string, Verdict>;
  brandRank: number | null;
  sentiment: string | null;
  // Accuracy engine: present when the sample was audited against a brand fact sheet.
  audit?: AnswerAudit | null;
}

// ── Accuracy engine ────────────────────────────────────────────────────────────

// One verifiable fact from the brand's own site copy. Only EXPLICIT statements become
// facts (never inferred), so a missing fact can never produce a false "the AI is wrong".
export interface BrandFact {
  key: string;        // stable dotted key: "pricing.entry", "security.soc2", "integration.slack", "category"
  value: string;      // canonical short value: "$29/mo", "true", "uptime monitoring for SaaS"
  verbatim?: string;  // the exact sentence/fragment from the copy that supports it
  confidence?: number; // 0–1: how unambiguous the copy is
}

export type ClaimStatus = 'confirmed' | 'contradicted' | 'unverifiable';

// A single factual claim an AI answer made about the brand, checked against the fact sheet.
export interface AnswerClaim {
  attribute: string;     // "pricing.entry", "security.soc2", "ownership"
  statedValue: string;   // what the AI said: "$99/mo"
  quote: string;         // verbatim span from the answer (≤200 chars)
  status: ClaimStatus;   // confirmed | contradicted (the alert) | unverifiable (never "wrong")
  factKey?: string;      // the brand_fact key it was checked against
  confidence: number;    // 0–1
}

// One reason the AI credits for recommending a competitor — the actionable "what they claim
// that you don't" signal, taken verbatim/paraphrased from the answer (never invented).
export interface WinnerReason {
  entity: string;  // the competitor the answer recommended
  reason: string;  // short phrase the answer credits ("largest prompt-volume dataset")
}

export interface AnswerAudit {
  claims: AnswerClaim[];
  entityConfusion: boolean;  // AI attributed another product's identity/features to the brand
  brandRank: number | null;  // 1-based position if the answer ranks products, else null
  sentiment: 'positive' | 'neutral' | 'negative' | null; // toward the brand
}

// A drafted fix for an accuracy alert. Honest by construction: it corrects a surface the
// company CONTROLS and flags stale third-party sources to chase — it never claims to "fix the AI".
export interface Remediation {
  correction: string;      // the exact copy/snippet to publish
  surface: string;         // where to publish it ("pricing page", "homepage JSON-LD", "FAQ")
  staleSources: string[];  // cited third-party URLs likely feeding the error, to go correct/chase
  note: string;            // honest caveat: AI answers shift over weeks–months, not instantly
}

export type AccuracyFlag = 'clean' | 'contradiction' | 'confusion';

// A deduped "what AI gets wrong about you" issue derived from an audited sample.
export interface AccuracyAlertRow {
  kind: 'contradiction' | 'confusion';
  attribute: string;
  statedValue: string;
  truthValue: string | null;
  severity: 'high' | 'med' | 'low';
  quote: string;
  model: string;
}

export interface ShareRow {
  name: string;
  score: number;       // 0–100 visibility
  recommended: number;
  named: number;
  absent: number;
}

export interface SourceRow {
  domain: string;
  url: string;
  count: number;
  sourceType: string;
}
