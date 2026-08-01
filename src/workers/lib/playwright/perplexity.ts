import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';
import { snapshotConversationDom, waitForStableCorrelatedTurn, ConversationDomSpec } from './conversation-dom';
import { BrowserCapture, buildProvenance } from './capture-contract';

export let sharedPerplexityBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page } | null = null;

export async function closePerplexityBrowser() {
  if (sharedPerplexityBrowser) {
    await sharedPerplexityBrowser.runtime.close().catch(() => {});
    sharedPerplexityBrowser = null;
  }
}

export async function scrapePerplexityPrompt(prompt: string): Promise<BrowserCapture> {
  if (!sharedPerplexityBrowser) {
    const runtime = await launchSeededPersistentContext('perplexity');
    try {
      const ctx = runtime.context;
      const page = await ctx.newPage();
      await page.goto('https://www.perplexity.ai/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(2500);
      sharedPerplexityBrowser = { runtime, page };
    } catch (err) {
      await runtime.close().catch(() => {});
      throw err;
    }
  }

  const { page } = sharedPerplexityBrowser;

  try {
    await page.goto('https://www.perplexity.ai/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1000);

    let composer = await firstVisibleLocator(page, '#ask-input, textarea, [contenteditable="true"], [placeholder="Ask anything..."]');
    if (!composer) {
      await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 15_000 }).catch(() => {});
      composer = await firstVisibleLocator(page, '#ask-input, textarea, [contenteditable="true"], [placeholder="Ask anything..."]');
    }
    if (!composer) {
      // Fallback: just grab the last contenteditable or ask-input
      const all = await page.locator('#ask-input, [contenteditable="true"]').all();
      if (all.length > 0) composer = all[all.length - 1];
    }
    if (!composer) {
      await captureDebug(page, 'perplexity', 'missing-composer');
      throw new Error(`Perplexity composer not found`);
    }

    const spec: ConversationDomSpec = {
      userSelector: '.prose, div[dir="auto"], .whitespace-pre-wrap, .text-foreground, span.select-text',
      assistantSelector: '.prose, div[dir="auto"], [data-testid="answer-text"]',
      streamingSelector: '[data-is-streaming="true"], [class*="streaming"]',
      loginSelector: 'form[action*="login"]',
      challengeSelector: '#challenge-running',
      rateLimitSelector: '[data-testid="rate-limit-message"]',
      providerOrigin: 'https://www.perplexity.ai',
    };

    const snapshot = await page.evaluate(snapshotConversationDom, spec);

    await composer.click({ timeout: 20_000, force: true }).catch(() => {});
    await composer.fill('');
    await page.keyboard.insertText(`Use web search and answer this buyer question with citations:\n\n${prompt}`);
    await page.keyboard.press('Enter');

    const inspection = await waitForStableCorrelatedTurn(page, {
      spec,
      snapshot,
      expectedPrompt: prompt,
      provider: 'perplexity',
      timeoutMs: 180_000,
    });

    if (!inspection.rawAnswer || inspection.rawAnswer.length < 10) {
      const html = await page.content().catch(() => '');
      require('fs').writeFileSync('perplexity_dump.html', html);
      throw new Error(`Perplexity did not render a real assistant answer`);
    }

    return { 
      rawAnswer: inspection.rawAnswer, 
      citations: inspection.links,
      provenance: buildProvenance('perplexity')
    };
  } catch (err) {
    await closePerplexityBrowser();
    throw err;
  }
}
