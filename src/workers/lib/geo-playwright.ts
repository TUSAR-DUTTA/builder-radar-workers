import type { AIRouter } from '@/lib/ai-router';
import type { AnswerModel, AnswerSample, Verdict } from '@/lib/geo/types';
import { judgeAnswer } from '@/lib/geo/engine';
import { isLowQualityAnswer, sanitizeAnswerText } from '@/lib/geo/sanitize-answer';
import { canonicalCitations } from '@/lib/geo/citation-url';
import { isSessionAvailable } from './playwright/shared';
import * as crypto from 'crypto';
import type { EvidenceProvenance } from '@builder-radar/evidence-contract';

import { scrapeChatGPTPrompt, closeChatGPTBrowser } from './playwright/chatgpt';
import { scrapeClaudePrompt, closeClaudeBrowser } from './playwright/claude';
import { scrapePerplexityPrompt, closePerplexityBrowser } from './playwright/perplexity';
import { scrapeGoogleAioPrompt, closeGoogleAioBrowser } from './playwright/google-aio';
import { scrapeGrokPrompt, closeGrokBrowser } from './playwright/grok';

import { isBrowserNoAnswerError, type BrowserCapture } from './playwright/capture-contract';
import { classifySamplingFailure, type FailureClassification } from '@/lib/scan-job-contract';
import type { AdapterResultV1, EvidenceFailureCode } from '@builder-radar/evidence-contract';

const observedBrowserAnswers = new Map<string, string>();

export class PromptIdentityError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PromptIdentityError';
  }
}

export function isPromptIdentityError(error: unknown): boolean {
  return error instanceof PromptIdentityError
    || (error instanceof Error && error.message.startsWith('prompt_identity_unverified:'));
}

function normalizedFingerprint(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Reject exact long browser answers rebound to a different submitted question in the same batch. */
export function registerPromptResponseBinding(model: AnswerModel, prompt: string, answer: string): boolean {
  const fingerprint = normalizedFingerprint(answer);
  if (fingerprint.length < 200) return true;
  const key = `${model}\0${fingerprint}`;
  const promptKey = normalizedFingerprint(prompt);
  const priorPrompt = observedBrowserAnswers.get(key);
  if (priorPrompt && priorPrompt !== promptKey) return false;
  observedBrowserAnswers.set(key, promptKey);
  return true;
}

export function resetPromptResponseBindings(): void {
  observedBrowserAnswers.clear();
}

export async function closeSharedBrowser() {
  await Promise.allSettled([
    closeChatGPTBrowser(),
    closeClaudeBrowser(),
    closePerplexityBrowser(),
    closeGoogleAioBrowser(),
    closeGrokBrowser(),
  ]);
  resetPromptResponseBindings();
}

export type PlaywrightAttemptStatus = 'succeeded' | 'skipped' | 'rejected' | 'failed';
export interface PlaywrightAttempt {
  model: AnswerModel;
  status: PlaywrightAttemptStatus;
  stage: 'session' | 'acquisition' | 'quality' | 'adjudication' | 'complete';
  failureReason: string | null;
  latencyMs: number;
}

export interface PlaywrightPromptResult {
  samples: AnswerSample[];
  attempts: PlaywrightAttempt[];
  outcomes: Partial<Record<AnswerModel, FailureClassification>>;
  adapterResults: AdapterResultV1[];
}

export interface PlaywrightRunContext {
  projectId: string;
  baselineId: string | null;
  scanJobId: string;
  scanCellId: string;
  promptId: string;
}

const PLAYWRIGHT_MODELS = new Set<AnswerModel>(['chatgpt-consumer', 'claude', 'perplexity', 'google-aio', 'grok']);

export function isPlaywrightAnswerModel(model: AnswerModel): boolean {
  return PLAYWRIGHT_MODELS.has(model);
}

function boundedFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown_error';
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 240) || 'unknown_error';
}

export async function runPromptViaPlaywrightDetailed(
  router: AIRouter,
  prompt: string,
  entities: string[],
  models: AnswerModel[],
  context: PlaywrightRunContext,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<PlaywrightPromptResult> {
  const samples: AnswerSample[] = [];
  const attempts: PlaywrightAttempt[] = [];
  const outcomes: Partial<Record<AnswerModel, FailureClassification>> = {};
  const adapterResults: AdapterResultV1[] = [];

  for (const model of models) {
    const started = Date.now();
    if (!isPlaywrightAnswerModel(model)) {
      attempts.push({ model, status: 'skipped', stage: 'session', failureReason: 'unsupported_playwright_engine', latencyMs: 0 });
      outcomes[model] = { category: 'acquisition_failure', retryable: false, code: 'unsupported_engine' };
      continue;
    }
    if (!isSessionAvailable(model)) {
      console.warn(`[geo-playwright] ${model} skipped - no session file`);
      attempts.push({ model, status: 'skipped', stage: 'session', failureReason: 'missing_session', latencyMs: Date.now() - started });
      outcomes[model] = { category: 'authentication_failure', retryable: false, code: 'missing_session' };
      continue;
    }

    try {
      let res: BrowserCapture;
      if (model === 'chatgpt-consumer') res = await scrapeChatGPTPrompt(prompt, signal, deadlineAt);
      else if (model === 'claude') res = await scrapeClaudePrompt(prompt, signal, deadlineAt);
      else if (model === 'perplexity') res = await scrapePerplexityPrompt(prompt, signal, deadlineAt);
      else if (model === 'google-aio') res = await scrapeGoogleAioPrompt(prompt, signal, deadlineAt);
      else res = await scrapeGrokPrompt(prompt, signal, deadlineAt);

      const answer = sanitizeAnswerText(res.rawAnswer);
      if (isLowQualityAnswer(answer)) {
        console.warn(`[geo-playwright] ${model} returned no valid answer - dropped`);
        attempts.push({ model, status: 'rejected', stage: 'quality', failureReason: 'low_quality_or_empty_answer', latencyMs: Date.now() - started });
        outcomes[model] = { category: 'no_answer', retryable: false, code: 'low_quality_or_empty_answer' };
        continue;
      }
      if (!registerPromptResponseBinding(model, prompt, answer)) {
        attempts.push({ model, status: 'rejected', stage: 'quality', failureReason: 'cross_prompt_duplicate_answer', latencyMs: Date.now() - started });
        outcomes[model] = { category: 'identity_binding_failure', retryable: false, code: 'cross_prompt_duplicate_answer' };
        throw new PromptIdentityError('prompt_identity_unverified:cross_prompt_duplicate_answer');
      }

      if (res.provenance.requestedMarket !== 'US' && res.provenance.regionVerificationStatus !== 'verified') {
        attempts.push({ model, status: 'rejected', stage: 'quality', failureReason: 'region_unverified', latencyMs: Date.now() - started });
        outcomes[model] = { category: 'acquisition_failure', retryable: false, code: 'region_unverified' as any };
        throw new Error('region_unverified');
      }

      let verdicts: Record<string, Verdict>;
      try {
        verdicts = await judgeAnswer(router, answer, entities);
      } catch (error) {
        console.warn(`[geo-playwright] ${model} adjudication failed - dropped`);
        attempts.push({ model, status: 'failed', stage: 'adjudication', failureReason: boundedFailureReason(error), latencyMs: Date.now() - started });
        outcomes[model] = classifySamplingFailure(error);
        continue;
      }

      samples.push({
        prompt,
        model,
        answer,
        citations: canonicalCitations(res.citations),
        verdicts,
        brandRank: null,
        sentiment: null,
        providerMetadata: {
          ...res.provenance,
          rawCapturePreserved: true,
        },
      });
      attempts.push({ model, status: 'succeeded', stage: 'complete', failureReason: null, latencyMs: Date.now() - started });

      const evidenceProvenance: EvidenceProvenance = {
        requestedMarket: res.provenance.requestedMarket,
        actualRegion: res.provenance.actualRegion,
        regionVerificationStatus: res.provenance.regionVerificationStatus === 'verified' ? 'verified' : (res.provenance.regionVerificationStatus === 'bypassed' ? 'unverified' : 'mismatch'),
        requestedLocale: res.provenance.requestedLocale || 'en-US',
        actualLocale: res.provenance.actualLocale || 'en-US',
        actualConnectionMode: res.provenance.actualConnectionMode,
        proxyRequested: !!res.provenance.proxyRequested,
        proxyUsed: res.provenance.proxyUsed ?? null,
        fallbackOccurred: res.provenance.fallbackOccurred,
        adapterVersion: res.provenance.adapterVersion,
        browserProviderMetadata: res.provenance.connectionMetadata as unknown as Record<string, import('@builder-radar/evidence-contract').JsonValue>,
        userTurnId: res.provenance.terminalProof?.userTurnId ?? null,
        assistantTurnId: res.provenance.terminalProof?.assistantTurnId ?? null,
        answerNodeId: res.provenance.terminalProof?.answerNodeId ?? null,
        providerTerminalSignal: res.provenance.providerTerminalSignal ?? null,
      };

      adapterResults.push({
        contractVersion: '1.0.1',
        schemaVersion: 'evidence_adapter_v1',
        engine: model,
        adapterVersion: res.provenance.adapterVersion,
        projectId: context.projectId,
        scanJobId: context.scanJobId,
        scanCellId: context.scanCellId,
        baselineId: context.baselineId ?? 'legacy_unversioned',
        promptId: context.promptId,
        submittedPrompt: prompt,
        capturedPrompt: res.capturedPrompt || prompt,
        rawAnswer: res.rawAnswer,
        rawReceipt: {
          kind: 'object_store',
          uri: `receipt://builder-radar/${context.scanJobId}/${model}/${Date.now()}`,
          contentSha256: crypto.createHash('sha256').update(res.rawAnswer).digest('hex'),
          mediaType: 'text/html',
          immutable: true,
        },
        capturedAt: new Date().toISOString(),
        captureStatus: 'accepted',
        promptBindingStatus: 'verified',
        completionStatus: 'terminal',
        provenance: evidenceProvenance,
        primaryFailureCode: null,
        diagnostics: {},
      });
    } catch (error) {
      const reason = boundedFailureReason(error);
      console.warn(`[geo-playwright] ${model} failed for "${prompt.slice(0, 40)}": ${reason}`);
      
      if (error instanceof Error && error.message?.includes('_aborted')) {
        outcomes[model] = { category: 'acquisition_failure', retryable: false, code: 'provider_deadline_aborted' };
        throw error;
      }
      
      const failureCode: EvidenceFailureCode = reason.includes('region_unverified') ? 'region_unverified' :
        reason.includes('prompt_identity_unverified') || reason.includes('prompt_binding_unverified') ? 'prompt_binding_unverified' :
        'capture_incomplete';
        
      attempts.push({ model, status: 'failed', stage: 'acquisition', failureReason: reason, latencyMs: Date.now() - started });
      
      const isBindingError = isPromptIdentityError(error) || reason.includes('prompt_binding_unverified');
      if (isBindingError) {
        outcomes[model] = { category: 'identity_binding_failure', retryable: false, code: 'prompt_identity_unverified' as any };
      } else {
        outcomes[model] = { category: 'acquisition_failure', retryable: false, code: 'capture_incomplete' as any };
      }

      adapterResults.push({
        contractVersion: '1.0.1',
        schemaVersion: 'evidence_adapter_v1',
        engine: model,
        adapterVersion: 'unknown',
        projectId: context.projectId,
        scanJobId: context.scanJobId,
        scanCellId: context.scanCellId,
        baselineId: context.baselineId ?? 'legacy_unversioned',
        promptId: context.promptId,
        submittedPrompt: prompt,
        capturedPrompt: prompt,
        rawAnswer: '',
        rawReceipt: {
          kind: 'object_store',
          uri: `receipt://builder-radar/${context.scanJobId}/${model}/${Date.now()}_error`,
          contentSha256: crypto.createHash('sha256').update(reason).digest('hex'),
          mediaType: 'text/plain',
          immutable: true,
        },
        capturedAt: new Date().toISOString(),
        captureStatus: 'rejected',
        promptBindingStatus: isBindingError ? 'unverified' : 'verified',
        completionStatus: 'terminal',
        provenance: {
          requestedMarket: 'US',
          actualRegion: null,
          regionVerificationStatus: 'unverified',
          requestedLocale: 'en-US',
          actualLocale: null,
          actualConnectionMode: 'unknown',
          proxyRequested: false,
          proxyUsed: null,
          fallbackOccurred: false,
          adapterVersion: 'unknown',
          browserProviderMetadata: {},
          userTurnId: null,
          assistantTurnId: null,
          answerNodeId: null,
          providerTerminalSignal: null,
        },
        primaryFailureCode: failureCode,
        diagnostics: {
          internalReason: reason,
        },
      });
    }
  }

  return { samples, attempts, outcomes, adapterResults };
}

export async function runPromptViaPlaywright(
  router: AIRouter,
  prompt: string,
  entities: string[],
  models: AnswerModel[],
): Promise<AnswerSample[]> {
  const dummyContext: PlaywrightRunContext = {
    projectId: 'dummy-project',
    baselineId: null,
    scanJobId: 'dummy-job',
    scanCellId: 'dummy-cell',
    promptId: 'dummy-prompt',
  };
  return (await runPromptViaPlaywrightDetailed(router, prompt, entities, models, dummyContext)).samples;
}
