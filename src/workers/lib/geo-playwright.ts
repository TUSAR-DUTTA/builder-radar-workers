import type { AIRouter } from '@/lib/ai-router';
import type { AnswerModel, AnswerSample, Verdict } from '@/lib/geo/types';
import { judgeAnswer } from '@/lib/geo/engine';
import { isLowQualityAnswer, sanitizeAnswerText } from '@/lib/geo/sanitize-answer';
import { canonicalCitations } from '@/lib/geo/citation-url';
import { isSessionAvailable } from './playwright/shared';

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

      adapterResults.push({
        contractVersion: '1.0.1',
        schemaVersion: 'evidence_adapter_v1',
        engine: model as any,
        adapterVersion: res.provenance.adapterVersion,
        projectId: context.projectId,
        scanJobId: context.scanJobId,
        scanCellId: context.scanCellId,
        baselineId: context.baselineId ?? 'legacy_unversioned',
        promptId: context.promptId,
        submittedPrompt: prompt,
        capturedPrompt: null,
        rawAnswer: res.rawAnswer,
        rawReceipt: { kind: 'object_store', uri: 'n/a', contentSha256: 'n/a', mediaType: 'text/html', immutable: true },
        capturedAt: new Date().toISOString(),
        captureStatus: 'accepted',
        promptBindingStatus: 'verified',
        completionStatus: 'terminal',
        provenance: res.provenance as any,
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

      if (isPromptIdentityError(error)) {
        outcomes[model] = { category: 'identity_binding_failure', retryable: false, code: reason };
        throw error;
      }
      if (isBrowserNoAnswerError(error)) {
        outcomes[model] = { category: 'no_answer', retryable: false, code: reason };
      } else {
        outcomes[model] = classifySamplingFailure(error);
      }
      attempts.push({ model, status: 'failed', stage: 'acquisition', failureReason: reason, latencyMs: Date.now() - started });
      
      adapterResults.push({
        contractVersion: '1.0.1',
        schemaVersion: 'evidence_adapter_v1',
        engine: model as any,
        adapterVersion: 'unknown',
        projectId: context.projectId,
        scanJobId: context.scanJobId,
        scanCellId: context.scanCellId,
        baselineId: context.baselineId ?? 'legacy_unversioned',
        promptId: context.promptId,
        submittedPrompt: prompt,
        capturedPrompt: null,
        rawAnswer: null,
        rawReceipt: { kind: 'object_store', uri: 'n/a', contentSha256: 'n/a', mediaType: 'text/html', immutable: true },
        capturedAt: new Date().toISOString(),
        captureStatus: 'rejected',
        promptBindingStatus: isPromptIdentityError(error) ? 'mismatch' : 'unverified',
        completionStatus: 'incomplete',
        provenance: {} as any,
        primaryFailureCode: (outcomes[model]?.code as EvidenceFailureCode) || null,
        diagnostics: { error: String(error) },
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
