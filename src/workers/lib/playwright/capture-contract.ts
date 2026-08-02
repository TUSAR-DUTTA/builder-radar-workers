import type { AnswerModel } from '@/lib/geo/types';

export const BROWSER_ADAPTER_VERSIONS: Record<string, string> = {
  'chatgpt-consumer': 'chatgpt_dom_v4',
  claude: 'claude_dom_v4',
  perplexity: 'perplexity_dom_v4',
  'google-aio': 'google_aio_state_v4',
  grok: 'grok_dom_v4',
  'gemini-grounded': 'not_browser_captured',
  kimi: 'not_browser_captured',
  mistral: 'not_browser_captured',
  'gpt-oss': 'not_browser_captured',
};

export interface CaptureProvenance {
  requestedMarket: string;
  actualEgressRegion: string | null;
  connectionMode: 'proxy' | 'direct';
  fallbackOccurred: boolean;
  uiLocale: string;
  sessionType: string;
  adapterVersion: string;
}

export interface BrowserCapture {
  /** Untouched visible text from the answer node. Sanitization happens after this boundary. */
  rawAnswer: string;
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

export function buildProvenance(model: AnswerModel, overrides?: Partial<CaptureProvenance>): CaptureProvenance {
  return {
    requestedMarket: 'US',
    actualEgressRegion: null,
    connectionMode: 'direct',
    fallbackOccurred: false,
    uiLocale: 'en-US',
    sessionType: 'persistent',
    adapterVersion: BROWSER_ADAPTER_VERSIONS[model] || 'unknown',
    ...overrides,
  };
}
