import type { AnswerModel } from '@/lib/geo/types';

export const BROWSER_ADAPTER_VERSIONS: Record<string, string> = {
  'chatgpt-consumer': 'chatgpt_dom_v8',
  claude: 'claude_dom_v8',
  perplexity: 'perplexity_dom_v8',
  'google-aio': 'google_aio_state_v7',
  grok: 'grok_dom_v6',
  'gemini-grounded': 'not_browser_captured',
  kimi: 'not_browser_captured',
  mistral: 'not_browser_captured',
  'gpt-oss': 'not_browser_captured',
};

export const PROVIDER_TERMINAL_SIGNALS = Object.freeze({
  chatgpt_dom_v6: ['chatgpt_turn_actions_complete'],
  claude_dom_v6: ['claude_response_actions_complete'],
  perplexity_dom_v6: ['perplexity_answer_actions_complete'],
  grok_dom_v6: ['grok_response_actions_complete'],
  google_aio_state_v5: ['aio_complete'],
  google_aio_state_v6: ['aio_complete'],
  chatgpt_dom_v7: ['chatgpt_turn_actions_complete'],
  claude_dom_v7: ['claude_response_actions_complete'],
  perplexity_dom_v7: ['perplexity_answer_actions_complete'],
  chatgpt_dom_v8: ['chatgpt_turn_actions_complete'],
  claude_dom_v8: ['claude_response_actions_complete'],
  perplexity_dom_v8: ['perplexity_answer_actions_complete'],
  google_aio_state_v7: ['aio_complete'],
} as const);

export type BrowserTerminalSignal =
  typeof PROVIDER_TERMINAL_SIGNALS[keyof typeof PROVIDER_TERMINAL_SIGNALS][number];

const SHA40 = /^[a-f0-9]{40}$/i;
const PLACEHOLDER_PROVIDER_ID = /^(?:(?:unknown|missing|none|null|dummy|synthetic|placeholder|n\/a)(?:[-_:].*)?|(?:chatgpt|claude|perplexity|grok|google)[-_](?:query|answer|user|assistant)[-_]\d+)$/i;

export function isRealProviderIdentity(value: string | null | undefined): value is string {
  const candidate = value?.trim() ?? '';
  return candidate.length >= 2 && candidate.length <= 500 && !PLACEHOLDER_PROVIDER_ID.test(candidate);
}

export function isTerminalSignalCompatible(adapterVersion: string, signal: string | null | undefined): signal is BrowserTerminalSignal {
  const accepted = PROVIDER_TERMINAL_SIGNALS[adapterVersion as keyof typeof PROVIDER_TERMINAL_SIGNALS] as readonly string[] | undefined;
  return Boolean(accepted?.includes(signal ?? ''));
}

export function assertRuntimeCommitShas(env: NodeJS.ProcessEnv = process.env): {
  workerSha: string;
  privateSha: string;
} {
  const workerSha = env.GITHUB_ACTIONS === 'true' ? env.GITHUB_SHA?.trim() : env.WORKER_RUNTIME_SHA?.trim();
  const privateSha = env.PRIVATE_INGESTION_COMMIT?.trim();
  if (!workerSha || !SHA40.test(workerSha)) throw new Error('runtime_compatibility:worker_sha_missing_or_invalid');
  if (!privateSha || !SHA40.test(privateSha)) throw new Error('runtime_compatibility:private_sha_missing_or_invalid');
  return { workerSha: workerSha.toLowerCase(), privateSha: privateSha.toLowerCase() };
}

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
  terminalSignal: BrowserTerminalSignal;
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

  if (overrides?.terminalProof) {
    const proof = overrides.terminalProof;
    if (!isRealProviderIdentity(proof.userTurnId)
      || !isRealProviderIdentity(proof.assistantTurnId)
      || !isRealProviderIdentity(proof.answerNodeId)) {
      throw new Error('capture_rejected:provider_turn_identity_missing_or_synthetic');
    }
    const adapterVersion = BROWSER_ADAPTER_VERSIONS[model] || 'unknown';
    if (!isTerminalSignalCompatible(adapterVersion, proof.terminalSignal)) {
      throw new Error('provider_not_terminal:signal_incompatible_with_adapter_version');
    }
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
