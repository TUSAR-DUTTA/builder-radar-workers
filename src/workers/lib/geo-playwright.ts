import type { AIRouter } from '@/lib/ai-router';
import type { AnswerModel, AnswerSample, Verdict } from '@/lib/geo/types';
import { judgeAnswer } from '@/lib/geo/engine';
import { isSessionAvailable } from './playwright/shared';

import { scrapeChatGPTPrompt, closeChatGPTBrowser } from './playwright/chatgpt';
import { scrapeClaudePrompt, closeClaudeBrowser } from './playwright/claude';
import { scrapePerplexityPrompt, closePerplexityBrowser } from './playwright/perplexity';
import { scrapeGoogleAioPrompt, closeGoogleAioBrowser } from './playwright/google-aio';
import { scrapeGrokPrompt, closeGrokBrowser } from './playwright/grok';

export async function closeSharedBrowser() {
  await closeChatGPTBrowser();
  await closeClaudeBrowser();
  await closePerplexityBrowser();
  await closeGoogleAioBrowser();
  await closeGrokBrowser();
}

export async function runPromptViaPlaywright(
  router: AIRouter,
  prompt: string,
  entities: string[],
  models: AnswerModel[],
): Promise<AnswerSample[]> {
  const samples: AnswerSample[] = [];

  for (const model of models) {
    if (!isSessionAvailable(model)) {
      console.warn(`[geo-playwright] ${model} skipped - no session file`);
      continue;
    }

    try {
      let res;
      if (model === 'openai-search') res = await scrapeChatGPTPrompt(prompt);
      else if (model === 'claude') res = await scrapeClaudePrompt(prompt);
      else if (model === 'perplexity') res = await scrapePerplexityPrompt(prompt);
      else if (model === 'google-aio') res = await scrapeGoogleAioPrompt(prompt);
      else if (model === 'grok') res = await scrapeGrokPrompt(prompt);
      else continue;

      if (!res.text.trim()) continue;

      let verdicts: Record<string, Verdict>;
      try {
        verdicts = await judgeAnswer(router, res.text, entities);
      } catch {
        verdicts = Object.fromEntries(entities.map((x) => [x, 'absent' as Verdict]));
      }

      samples.push({
        prompt,
        model,
        answer: res.text,
        citations: res.citations,
        verdicts,
        brandRank: null,
        sentiment: null,
      });
    } catch (err) {
      console.warn(`[geo-playwright] ${model} failed for "${prompt.slice(0, 40)}": ${(err as Error).message}`);
    }
  }

  return samples;
}