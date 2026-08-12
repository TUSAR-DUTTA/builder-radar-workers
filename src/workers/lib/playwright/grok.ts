import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, type PlaywrightContextHandle } from './shared';
import { snapshotConversationDom, waitForTerminalCorrelatedTurn } from './conversation-dom';
import { GROK_TURN_SPEC } from './provider-turn-specs';
import { type BrowserCapture, buildProvenance, type TerminalProof, type BrowserConnectionMetadata } from './capture-contract';

export let sharedGrokBrowser: {
  runtime: PlaywrightContextHandle;
  page: import('playwright').Page;
  connectionMeta: BrowserConnectionMetadata;
} | null = null;

export async function closeGrokBrowser() {
  if (sharedGrokBrowser) {
    await sharedGrokBrowser.runtime.close().catch(() => {});
    sharedGrokBrowser = null;
  }
}

export async function scrapeGrokPrompt(
  prompt: string,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<BrowserCapture> {
  if (!sharedGrokBrowser) {
    const runtime = await launchSeededPersistentContext('grok');
    try {
      const page = await runtime.context.newPage();
      await page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      sharedGrokBrowser = { runtime, page, connectionMeta: runtime.connectionMeta };
    } catch (error) {
      await runtime.close().catch(() => {});
      throw error;
    }
  }
  const { page, connectionMeta } = sharedGrokBrowser;
  try {
    await page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (page.url().includes('login') || await page.locator('text="Sign in"').isVisible().catch(() => false)) {
      throw new Error('login_required:grok');
    }
    let composer: import('playwright').Locator | null = null;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      if (signal?.aborted) throw new Error('provider_deadline_aborted');
      composer = await firstVisibleLocator(
        page,
        '#grok-input, [contenteditable="true"], textarea, [placeholder*="Ask" i], [placeholder*="What" i], [aria-label*="Ask" i], [aria-label*="prompt" i]',
      );
      if (composer) break;
      await page.waitForTimeout(1_000);
    }
    if (!composer) throw new Error('adapter_selector_missing:grok_composer');

    const snapshot = await page.evaluate(snapshotConversationDom, GROK_TURN_SPEC);
    await composer.click({ timeout: 20_000, force: true });
    await composer.fill('');
    await page.keyboard.insertText(prompt);
    const composerText = await composer.inputValue().catch(async () => composer!.innerText().catch(() => ''));
    if (composerText !== prompt) throw new Error('prompt_binding_unverified:grok_composer_round_trip');
    const submit = await firstVisibleLocator(
      page,
      'button[aria-label*="Send" i], button[aria-label*="Submit" i], button[aria-label*="Ask" i], button[type="submit"], button:has(svg.lucide-arrow-up), button:has(svg.lucide-send), [data-testid="send-button"]',
    );
    if (submit && !await submit.isDisabled().catch(() => true)) await submit.click();
    else await composer.press('Enter');

    // Check for rate limit / usage limit banner immediately after sending
    const rateLimitBanner = await firstVisibleLocator(
      page,
      '[role="alert"], [class*="rate-limit"], [class*="limit-reached"], text="You have reached your limit", text="Usage limit exceeded", text="Try again later"'
    );
    if (rateLimitBanner) {
      throw new Error('provider_rate_limit:grok_usage_cap');
    }

    const inspection = await waitForTerminalCorrelatedTurn(page, {
      spec: GROK_TURN_SPEC,
      snapshot,
      expectedPrompt: prompt,
      provider: 'grok',
      timeoutMs: deadlineAt ? Math.max(1_000, deadlineAt - Date.now()) : 180_000,
      minimumChars: 50,
      signal,
    });
    if (!inspection.terminalSignal || inspection.turnBindingMethod === 'unavailable'
      || (inspection.turnBindingMethod === 'deterministic_dom' && !inspection.captureBindingId)) {
      throw new Error('prompt_binding_unverified:grok');
    }
    connectionMeta.actualLocale = await page.evaluate(() => document.documentElement.lang || 'en-US').catch(() => 'en-US');
    const terminalProof: TerminalProof = {
      providerState: 'complete',
      turnBindingMethod: inspection.turnBindingMethod,
      captureBindingId: inspection.captureBindingId,
      userTurnId: inspection.userNodeId,
      assistantTurnId: inspection.assistantNodeId,
      answerNodeId: inspection.answerNodeId,
      terminalSignal: inspection.terminalSignal,
      stableChecks: inspection.observedStableChecks,
    };
    await captureDebug(page, 'grok', 'terminal-success', {
      userTurnId: inspection.userNodeId, assistantTurnId: inspection.assistantNodeId,
      answerNodeId: inspection.answerNodeId, terminalSignal: inspection.terminalSignal,
      bindingMethod: inspection.turnBindingMethod, captureBindingId: inspection.captureBindingId,
      submissionCount: 1,
      rawByteLength: Buffer.byteLength(inspection.rawAnswer, 'utf8'),
    });
    return {
      capturedPrompt: prompt,
      rawAnswer: inspection.rawAnswer,
      citations: inspection.links,
      provenance: buildProvenance('grok', { terminalProof }, connectionMeta),
    };
  } catch (error) {
    const visibleControls = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('button, textarea, [contenteditable="true"]'))
      .filter((node) => {
        const style = window.getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' && !node.hasAttribute('hidden');
      })
      .slice(0, 40)
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        ariaLabel: node.getAttribute('aria-label'),
        testId: node.getAttribute('data-testid'),
        placeholder: node.getAttribute('placeholder'),
        contentEditable: node.getAttribute('contenteditable'),
      }))).catch(() => []);
    await captureDebug(page, 'grok', 'capture-rejected', {
      reason: error instanceof Error ? error.message.slice(0, 160) : 'unknown_error',
      visibleControls,
    });
    await closeGrokBrowser();
    throw error;
  }
}
