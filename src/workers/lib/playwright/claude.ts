import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';
import { snapshotConversationDom, waitForStableCorrelatedTurn, ConversationDomSpec } from './conversation-dom';
import { BrowserCapture, buildProvenance } from './capture-contract';

export let sharedClaudeBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page } | null = null;

export async function closeClaudeBrowser() {
  if (sharedClaudeBrowser) {
    await sharedClaudeBrowser.runtime.close().catch(() => {});
    sharedClaudeBrowser = null;
  }
}

export async function scrapeClaudePrompt(prompt: string): Promise<BrowserCapture> {
  if (!sharedClaudeBrowser) {
    const runtime = await launchSeededPersistentContext('claude');
    try {
      const ctx = runtime.context;
      const page = await ctx.newPage();
      await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(2500);
      sharedClaudeBrowser = { runtime, page };
    } catch (err) {
      await runtime.close().catch(() => {});
      throw err;
    }
  }

  const { page } = sharedClaudeBrowser;

  try {
    await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1000);

    // Attempt to dismiss cookie popups repeatedly
    let composer: import('playwright').Locator | null = null;
    for (let i = 0; i < 15; i++) {
      await page.locator('button:has-text("Accept All Cookies")').click({ timeout: 1000 }).catch(() => {});
      composer = await firstVisibleLocator(page, '[contenteditable="true"], textarea, #prompt-textarea');
      if (composer) break;
      await page.waitForTimeout(1000);
    }

    if (!composer) {
      await captureDebug(page, 'claude', 'missing-composer');
      throw new Error(`Claude composer not found`);
    }

    const spec: ConversationDomSpec = {
      userSelector: '.font-user-message, [data-is-user="true"]',
      assistantSelector: '.font-claude-response, [data-is-user="false"]',
      streamingSelector: '[data-is-streaming="true"]',
      loginSelector: 'form[action*="login"], [href*="/login"]',
      challengeSelector: 'iframe[src*="cloudflare"], #challenge-running',
      rateLimitSelector: '[data-testid="rate-limit-message"]',
      providerOrigin: 'https://claude.ai',
    };

    const snapshot = await page.evaluate(snapshotConversationDom, spec);

    await composer.click({ timeout: 20_000, force: true }).catch(() => {});
    await composer.fill('');
    await page.keyboard.insertText(`Use web search and answer this buyer question with citations:\n\n${prompt}`);
    await composer.press('Enter');

    const inspection = await waitForStableCorrelatedTurn(page, {
      spec,
      snapshot,
      expectedPrompt: prompt,
      provider: 'claude',
      timeoutMs: 180_000,
    });

    const isCloudflare = /Performing security verification|Verifies you are not a bot/i.test(inspection.rawAnswer);
    if (inspection.rawAnswer.length < 5 || isCloudflare) {
      await captureDebug(page, 'claude', 'bad-response', { isCloudflare });
      throw new Error(isCloudflare ? 'Claude blocked by Cloudflare' : 'Claude did not render a real assistant answer');
    }

    return { 
      rawAnswer: inspection.rawAnswer, 
      citations: inspection.links,
      provenance: buildProvenance('claude')
    };
  } catch (err) {
    await closeClaudeBrowser();
    throw err;
  }
}
