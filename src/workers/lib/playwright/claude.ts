import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';
import { snapshotConversationDom, waitForStableCorrelatedTurn, ConversationDomSpec } from './conversation-dom';
import { BrowserCapture, buildProvenance, type TerminalProof, type BrowserConnectionMetadata } from './capture-contract';

export let sharedClaudeBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page, connectionMeta: BrowserConnectionMetadata } | null = null;

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
      sharedClaudeBrowser = { runtime, page, connectionMeta: runtime.connectionMeta };
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
      userSelector: '[data-is-user="true"], [data-testid="user-message"], [class*="font-user-message"], .font-claude-message',
      assistantSelector: '[data-is-user="false"], [data-testid="assistant-message"], [class*="font-claude-response"], div.prose',
      streamingSelector: '[data-is-streaming="true"], [class*="streaming"], [class*="animate-pulse"]',
      loginSelector: 'form[action*="login"], [href*="/login"]',
      challengeSelector: 'iframe[src*="cloudflare"], #challenge-running',
      rateLimitSelector: '[data-testid="rate-limit-message"]',
      providerOrigin: 'https://claude.ai',
    };

    const snapshot = await page.evaluate(snapshotConversationDom, spec);

    await composer.click({ timeout: 20_000, force: true }).catch(() => {});
    await composer.fill('');
    await page.keyboard.insertText(`Use web search and answer this buyer question with citations:\n\n${prompt}`);
    await page.waitForTimeout(300);

    const submit = await firstVisibleLocator(page, 'button[aria-label*="Send" i], button[data-testid="send-button"]');
    if (submit) {
      const disabled = await submit.isDisabled().catch(() => false);
      if (!disabled) {
        await submit.click().catch(() => {});
      } else {
        await composer.press('Enter');
      }
    } else {
      await composer.press('Enter');
    }

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

    // Verify composer was cleared after submission
    const composerText = await page.evaluate(() => {
      const el = document.querySelector('[contenteditable="true"], textarea, #prompt-textarea') as HTMLElement;
      return el ? (el.textContent || (el as HTMLTextAreaElement).value || '').trim() : '';
    }).catch(() => '');
    if (composerText.length > 10) {
      console.warn('[claude] Composer not cleared after submission — possible stuck state');
    }

    const { connectionMeta } = sharedClaudeBrowser!;
    const uiLocale = await page.evaluate(() => document.documentElement.lang || 'en-US').catch(() => 'en-US');
    connectionMeta.locale = uiLocale;

    const terminalProof: TerminalProof = {
      providerState: 'complete',
      userTurnId: inspection.userNodeId || 'user-node',
      assistantTurnId: inspection.assistantNodeId || 'assistant-node',
      answerNodeId: inspection.assistantNodeId || 'answer-node',
      terminalSignal: `correlated_stable_turn`,
      stableChecks: 3,
    };

    return { 
      rawAnswer: inspection.rawAnswer, 
      citations: inspection.links,
      provenance: buildProvenance('claude', { terminalProof }, connectionMeta)
    };
  } catch (err) {
    await closeClaudeBrowser();
    throw err;
  }
}
