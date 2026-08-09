import { launchSeededPersistentContext, captureDebug, fillAndVerifyComposer, firstVisibleLocator, type PlaywrightContextHandle } from './shared';
import { inspectPerplexityDom, type PerplexityInspection } from './perplexity-dom';
import { type BrowserCapture, buildProvenance, type TerminalProof, type BrowserConnectionMetadata } from './capture-contract';

export let sharedPerplexityBrowser: {
  runtime: PlaywrightContextHandle;
  page: import('playwright').Page;
  connectionMeta: BrowserConnectionMetadata;
} | null = null;

export async function closePerplexityBrowser() {
  if (sharedPerplexityBrowser) {
    await sharedPerplexityBrowser.runtime.close().catch(() => {});
    sharedPerplexityBrowser = null;
  }
}

export async function scrapePerplexityPrompt(
  prompt: string,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<BrowserCapture> {
  if (!sharedPerplexityBrowser) {
    const runtime = await launchSeededPersistentContext('perplexity');
    try {
      const page = await runtime.context.newPage();
      await page.goto('https://www.perplexity.ai/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      sharedPerplexityBrowser = { runtime, page, connectionMeta: runtime.connectionMeta };
    } catch (error) {
      await runtime.close().catch(() => {});
      throw error;
    }
  }
  const { page, connectionMeta } = sharedPerplexityBrowser;
  try {
    await page.goto('https://www.perplexity.ai/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const priorUrl = page.url();
    let composer = await firstVisibleLocator(page, '#ask-input, textarea[placeholder*="Ask" i], [contenteditable="true"][data-lexical-editor="true"]');
    if (!composer) {
      await page.waitForSelector('#ask-input, textarea[placeholder*="Ask" i], [contenteditable="true"][data-lexical-editor="true"]', { timeout: 15_000 }).catch(() => {});
      composer = await firstVisibleLocator(page, '#ask-input, textarea[placeholder*="Ask" i], [contenteditable="true"][data-lexical-editor="true"]');
    }
    if (!composer) throw new Error('login_required:perplexity_missing_composer');
    const submittedUiPrompt = `Use web search and answer this buyer question with citations:\n\n${prompt}`;
    await fillAndVerifyComposer(composer, submittedUiPrompt, 'perplexity');
    const submit = await firstVisibleLocator(page, 'button[aria-label="Submit"], button[type="submit"]');
    if (submit && !await submit.isDisabled().catch(() => true)) await submit.click();
    else await composer.press('Enter');

    const deadline = deadlineAt ?? Date.now() + 180_000;
    let previousText: string | null = null;
    let stableChecks = 0;
    let inspection: PerplexityInspection | null = null;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('provider_deadline_aborted');
      await page.waitForTimeout(1_000);
      inspection = await page.evaluate(inspectPerplexityDom, { expectedPrompt: submittedUiPrompt, priorUrl, currentUrl: page.url() });
      if (['login_required', 'provider_challenge', 'rate_limited', 'provider_interstitial', 'provider_refusal',
        'provider_no_answer', 'prompt_binding_unverified', 'provider_identity_missing', 'duplicate_current_turn'].includes(inspection.status)) {
        throw new Error(`${inspection.status}:perplexity`);
      }
      if (inspection.status !== 'terminal' || inspection.rawAnswer.length < 40) {
        previousText = null;
        stableChecks = 0;
        continue;
      }
      stableChecks = inspection.rawAnswer === previousText ? stableChecks + 1 : 1;
      previousText = inspection.rawAnswer;
      if (stableChecks >= 3) break;
    }
    if (!inspection || inspection.status !== 'terminal' || stableChecks < 3) {
      throw new Error(`provider_not_terminal:perplexity:last_state_${inspection?.status ?? 'waiting'}`);
    }
    if (!inspection.userTurnId || !inspection.assistantTurnId || !inspection.answerNodeId || !inspection.terminalSignal) {
      throw new Error('provider_identity_missing:perplexity');
    }
    connectionMeta.actualLocale = await page.evaluate(() => document.documentElement.lang || 'en-US').catch(() => 'en-US');
    const terminalProof: TerminalProof = {
      providerState: 'complete',
      userTurnId: inspection.userTurnId,
      assistantTurnId: inspection.assistantTurnId,
      answerNodeId: inspection.answerNodeId,
      terminalSignal: inspection.terminalSignal,
      stableChecks,
    };
    await captureDebug(page, 'perplexity', 'terminal-success', {
      userTurnId: inspection.userTurnId, assistantTurnId: inspection.assistantTurnId,
      answerNodeId: inspection.answerNodeId, terminalSignal: inspection.terminalSignal,
      rawByteLength: Buffer.byteLength(inspection.rawAnswer, 'utf8'),
      citationCount: inspection.links.length,
    });
    return {
      capturedPrompt: prompt,
      rawAnswer: inspection.rawAnswer,
      citations: inspection.links,
      provenance: buildProvenance('perplexity', { terminalProof }, connectionMeta),
    };
  } catch (error) {
    await captureDebug(page, 'perplexity', 'capture-rejected', {
      reason: error instanceof Error ? error.message.slice(0, 160) : 'unknown_error',
    });
    await closePerplexityBrowser();
    throw error;
  }
}
