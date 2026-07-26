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
  const key = `${model}\u0000${fingerprint}`;
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
): Promise<PlaywrightPromptResult> {
  const samples: AnswerSample[] = [];
  const attempts: PlaywrightAttempt[] = [];

  for (const model of models) {
    const started = Date.now();
    if (!isPlaywrightAnswerModel(model)) {
      attempts.push({ model, status: 'skipped', stage: 'session', failureReason: 'unsupported_playwright_engine', latencyMs: 0 });
      continue;
    }
    if (!isSessionAvailable(model)) {
      console.warn(`[geo-playwright] ${model} skipped - no session file`);
      attempts.push({ model, status: 'skipped', stage: 'session', failureReason: 'missing_session', latencyMs: Date.now() - started });
      continue;
    }

    try {
      let res;
      if (model === 'chatgpt-consumer') res = await scrapeChatGPTPrompt(prompt);
      else if (model === 'claude') res = await scrapeClaudePrompt(prompt);
      else if (model === 'perplexity') res = await scrapePerplexityPrompt(prompt);
      else if (model === 'google-aio') res = await scrapeGoogleAioPrompt(prompt);
      else res = await scrapeGrokPrompt(prompt);

      let answer = sanitizeAnswerText(res.text);
      // Retry one prompt-bound low-quality ChatGPT turn once. The scraper moves the retry to a fresh
      // conversation while retaining the authenticated persistent browser; identity failures remain
      // fatal and are never retried here.
      if (model === 'chatgpt-consumer' && isLowQualityAnswer(answer)) {
        console.warn('[geo-playwright] chatgpt-consumer returned low-quality text — retrying once in a fresh conversation');
        res = await scrapeChatGPTPrompt(prompt);
        answer = sanitizeAnswerText(res.text);
      }
      if (isLowQualityAnswer(answer)) {
        console.warn(`[geo-playwright] ${model} returned no valid answer — dropped`);
        attempts.push({ model, status: 'rejected', stage: 'quality', failureReason: 'low_quality_or_empty_answer', latencyMs: Date.now() - started });
        continue;
      }
      if (!registerPromptResponseBinding(model, prompt, answer)) {
        attempts.push({ model, status: 'rejected', stage: 'quality', failureReason: 'cross_prompt_duplicate_answer', latencyMs: Date.now() - started });
        throw new PromptIdentityError('prompt_identity_unverified:cross_prompt_duplicate_answer');
      }

      let verdicts: Record<string, Verdict>;
      try {
        verdicts = await judgeAnswer(router, answer, entities);
      } catch (error) {
        console.warn(`[geo-playwright] ${model} adjudication failed — dropped`);
        attempts.push({ model, status: 'failed', stage: 'adjudication', failureReason: boundedFailureReason(error), latencyMs: Date.now() - started });
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
      });
      attempts.push({ model, status: 'succeeded', stage: 'complete', failureReason: null, latencyMs: Date.now() - started });
    } catch (error) {
      const reason = boundedFailureReason(error);
      console.warn(`[geo-playwright] ${model} failed for "${prompt.slice(0, 40)}": ${reason}`);
      if (isPromptIdentityError(error)) throw error;
      attempts.push({ model, status: 'failed', stage: 'acquisition', failureReason: reason, latencyMs: Date.now() - started });
    }
  }

  return { samples, attempts };
}

export async function runPromptViaPlaywright(
  router: AIRouter,
  prompt: string,
  entities: string[],
  models: AnswerModel[],
): Promise<AnswerSample[]> {
  return (await runPromptViaPlaywrightDetailed(router, prompt, entities, models)).samples;
}
