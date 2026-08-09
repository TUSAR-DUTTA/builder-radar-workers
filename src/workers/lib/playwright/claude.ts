import { launchSeededPersistentContext, captureDebug, fillAndVerifyComposer, firstVisibleLocator, type PlaywrightContextHandle } from './shared';
import { snapshotConversationDom, waitForTerminalCorrelatedTurn } from './conversation-dom';
import { CLAUDE_TURN_SPEC } from './provider-turn-specs';
import { type BrowserCapture, buildProvenance, type TerminalProof, type BrowserConnectionMetadata } from './capture-contract';

export let sharedClaudeBrowser: {
  runtime: PlaywrightContextHandle;
  page: import('playwright').Page;
  connectionMeta: BrowserConnectionMetadata;
} | null = null;

export async function closeClaudeBrowser() {
  if (sharedClaudeBrowser) {
    await sharedClaudeBrowser.runtime.close().catch(() => {});
    sharedClaudeBrowser = null;
  }
}

export async function scrapeClaudePrompt(
  prompt: string,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<BrowserCapture> {
  if (!sharedClaudeBrowser) {
    const runtime = await launchSeededPersistentContext('claude');
    try {
      const page = await runtime.context.newPage();
      await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      sharedClaudeBrowser = { runtime, page, connectionMeta: runtime.connectionMeta };
    } catch (error) {
      await runtime.close().catch(() => {});
      throw error;
    }
  }
  const { page, connectionMeta } = sharedClaudeBrowser;
  try {
    await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    let composer: import('playwright').Locator | null = null;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      if (signal?.aborted) throw new Error('provider_deadline_aborted');
      await page.locator('button:has-text("Accept All Cookies")').click({ timeout: 500 }).catch(() => {});
      composer = await firstVisibleLocator(page, '[contenteditable="true"][data-testid="chat-input"], [contenteditable="true"], textarea');
      if (composer) break;
      await page.waitForTimeout(1_000);
    }
    if (!composer) throw new Error('login_required:claude_missing_composer');

    const snapshot = await page.evaluate(snapshotConversationDom, CLAUDE_TURN_SPEC);
    const submittedUiPrompt = `Use web search and answer this buyer question with citations:\n\n${prompt}`;
    await fillAndVerifyComposer(composer, submittedUiPrompt, 'claude', { renderedBlockText: true });
    const submit = await firstVisibleLocator(page, 'button[aria-label="Send message"], button[data-testid="send-button"]');
    if (submit && !await submit.isDisabled().catch(() => true)) await submit.click();
    else await composer.press('Enter');

    const inspection = await waitForTerminalCorrelatedTurn(page, {
      spec: CLAUDE_TURN_SPEC,
      snapshot,
      expectedPrompt: submittedUiPrompt,
      provider: 'claude',
      timeoutMs: deadlineAt ? Math.max(1_000, deadlineAt - Date.now()) : 180_000,
      signal,
    });
    if (!inspection.userNodeId || !inspection.assistantNodeId || !inspection.answerNodeId || !inspection.terminalSignal) {
      throw new Error('provider_identity_missing:claude');
    }
    connectionMeta.actualLocale = await page.evaluate(() => document.documentElement.lang || 'en-US').catch(() => 'en-US');
    const terminalProof: TerminalProof = {
      providerState: 'complete',
      userTurnId: inspection.userNodeId,
      assistantTurnId: inspection.assistantNodeId,
      answerNodeId: inspection.answerNodeId,
      terminalSignal: inspection.terminalSignal,
      stableChecks: inspection.observedStableChecks,
    };
    await captureDebug(page, 'claude', 'terminal-success', {
      userTurnId: inspection.userNodeId, assistantTurnId: inspection.assistantNodeId,
      answerNodeId: inspection.answerNodeId, terminalSignal: inspection.terminalSignal,
      rawByteLength: Buffer.byteLength(inspection.rawAnswer, 'utf8'),
    });
    return {
      capturedPrompt: prompt,
      rawAnswer: inspection.rawAnswer,
      citations: inspection.links,
      provenance: buildProvenance('claude', { terminalProof }, connectionMeta),
    };
  } catch (error) {
    await captureDebug(page, 'claude', 'capture-rejected', {
      reason: error instanceof Error ? error.message.slice(0, 160) : 'unknown_error',
    });
    await closeClaudeBrowser();
    throw error;
  }
}
