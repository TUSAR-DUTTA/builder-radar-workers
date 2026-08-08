import type { AnswerModel } from '@/lib/geo/types';

export const BROWSER_ADAPTER_VERSIONS: Record<string, string> = {
  'chatgpt-consumer': 'chatgpt_dom_v5',
  claude: 'claude_dom_v5',
  perplexity: 'perplexity_dom_v5',
  'google-aio': 'google_aio_state_v5',
  grok: 'grok_dom_v5',
  'gemini-grounded': 'not_browser_captured',
  kimi: 'not_browser_captured',
  mistral: 'not_browser_captured',
  'gpt-oss': 'not_browser_captured',
};

/** Factual connection metadata returned from the launcher — never inferred from env var existence. */
export interface BrowserConnectionMetadata {
  connectionMode: 'direct' | 'proxy';
  proxyRequested: boolean;
  proxyUsed: boolean;
  fallbackUsed: boolean;
  requestedMarket: string;
  actualRegion: string | null;
  regionVerified: boolean;
  regionVerificationStatus: 'verified' | 'unverified' | 'bypassed';
  locale: string;
  actualLocale: string;
  actualConnectionMode: 'direct' | 'proxy';
}

/** Evidence that the captured answer reached a genuine provider-specific terminal state. */
export interface TerminalProof {
  providerState: 'complete';
  userTurnId: string;
  assistantTurnId: string;
  answerNodeId: string;
  terminalSignal: string;
  stableChecks: number;
}

export interface CaptureProvenance {
  requestedMarket: string;
  actualRegion: string | null;
  regionVerificationStatus: 'verified' | 'unverified' | 'bypassed';
  requestedLocale: string;
  actualLocale: string;
  actualConnectionMode: 'proxy' | 'direct';
  fallbackOccurred: boolean;
  uiLocale: string;
  sessionType: string;
  adapterVersion: string;
  proxyRequested?: boolean;
  proxyUsed?: boolean;
  regionVerified?: boolean;
  providerTerminalSignal?: string;
  terminalProof?: TerminalProof;
  connectionMetadata?: BrowserConnectionMetadata;
}

export interface BrowserCapture {
  /** Untouched visible text from the answer node. Sanitization happens after this boundary. */
  rawAnswer: string;
  capturedPrompt: string;
  citations: { url: string; title?: string }[];
  provenance: CaptureProvenance;
}

export class BrowserNoAnswerError extends Error {
  readonly code = 'provider_no_answer';

  constructor(readonly provider: AnswerModel, reason = 'provider rendered no answer') {
    super(`${provider} no answer: ${reason}`);
    this.name = 'BrowserNoAnswerError';
  }
}

export function isBrowserNoAnswerError(error: unknown): error is BrowserNoAnswerError {
  return error instanceof BrowserNoAnswerError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'provider_no_answer');
}

export function buildProvenance(
  model: AnswerModel,
  overrides?: Partial<CaptureProvenance>,
  connectionMeta?: BrowserConnectionMetadata,
): CaptureProvenance {
  if (!connectionMeta) {
    throw new Error('connectionMeta is required to build provenance');
  }

  const base: CaptureProvenance = {
    requestedMarket: connectionMeta.requestedMarket,
    actualRegion: connectionMeta.actualRegion,
    regionVerificationStatus: connectionMeta.regionVerificationStatus,
    requestedLocale: connectionMeta.locale,
    actualLocale: connectionMeta.actualLocale,
    actualConnectionMode: connectionMeta.actualConnectionMode,
    fallbackOccurred: connectionMeta.fallbackUsed,
    uiLocale: connectionMeta.locale,
    sessionType: 'persistent',
    adapterVersion: BROWSER_ADAPTER_VERSIONS[model] || 'unknown',
    proxyRequested: connectionMeta.proxyRequested,
    proxyUsed: connectionMeta.proxyUsed,
    regionVerified: connectionMeta.regionVerified,
    providerTerminalSignal: overrides?.terminalProof?.terminalSignal,
    connectionMetadata: connectionMeta,
  };
  
  return { ...base, ...overrides };
}
