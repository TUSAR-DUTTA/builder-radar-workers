import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, type PlaywrightContextHandle } from './shared';
import { snapshotConversationDom, waitForTerminalCorrelatedTurn } from './conversation-dom';
import { CHATGPT_TURN_SPEC } from './provider-turn-specs';
import { type BrowserCapture, buildProvenance, type TerminalProof, type BrowserConnectionMetadata } from './capture-contract';

function isBadChatGPTResponse(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return !normalized
    || normalized.length < 40
    || /window\.__oai_/i.test(normalized)
    || /Something went wrong while generating the response/i.test(normalized)
    || /If this issue persists.*help\.openai\.com/i.test(normalized);
}

function chatGPTForbiddenUrls(urls: string[]): string[] {
  const patterns = ['/backend-api/me', '/backend-api/conversation/init', '/backend-api/f/conversation/prepare',
    '/backend-api/sentinel/chat-requirements/prepare', 'account_bootstrap_forbidden'];
  return urls.filter((url) => patterns.some((pattern) => url.includes(pattern)));
}

export let sharedChatGPTBrowser: {
  runtime: PlaywrightContextHandle;
  page: import('playwright').Page;
  forbidden: string[];
  connectionMeta: BrowserConnectionMetadata;
} | null = null;

export async function closeChatGPTBrowser() {
  if (sharedChatGPTBrowser) {
    await sharedChatGPTBrowser.runtime.close().catch(() => {});
    sharedChatGPTBrowser = null;
  }
}

async function dismissAccountChooser(page: import('playwright').Page): Promise<boolean> {
  const chooser = await firstVisibleLocator(
    page,
    '[data-testid="log-back-form"] [role="button"], button[name="session_id"], button[data-dd-action-name="Select existing session"]',
  );
  if (!chooser) return false;
  await chooser.click({ timeout: 10_000 });
  await page.waitForTimeout(2_000);
  return true;
}

export async function scrapeChatGPTPrompt(
  prompt: string,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<BrowserCapture> {
  if (!sharedChatGPTBrowser) {
    const runtime = await launchSeededPersistentContext('chatgpt-consumer');
    try {
      const page = await runtime.context.newPage();
      const forbidden: string[] = [];
      page.on('response', (response) => {
        if (response.status() === 403 && response.url().includes('chatgpt.com/')) forbidden.push(response.url());
      });
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      sharedChatGPTBrowser = { runtime, page, forbidden, connectionMeta: runtime.connectionMeta };
    } catch (error) {
      await runtime.close().catch(() => {});
      throw error;
    }
  }

  const { page, forbidden, connectionMeta } = sharedChatGPTBrowser;
  forbidden.length = 0;
  try {
    if (!page.url().includes('chatgpt.com') || page.url().includes('/c/')) {
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    }
    const authDeadline = Math.min(deadlineAt ?? Date.now() + 45_000, Date.now() + 45_000);
    let composer: import('playwright').Locator | null = null;
    while (Date.now() < authDeadline) {
      if (signal?.aborted) throw new Error('provider_deadline_aborted');
      if (await dismissAccountChooser(page).catch(() => false)) continue;
      composer = await firstVisibleLocator(page, '#prompt-textarea, div[contenteditable="true"][aria-label="Chat with ChatGPT"]');
      const profile = await firstVisibleLocator(page, '[data-testid="accounts-profile-button"], [aria-label*="profile menu" i]');
      if (composer && profile) break;
      await page.waitForTimeout(1_000);
    }
    if (!composer) {
      await captureDebug(page, 'chatgpt', 'login-required');
      throw new Error('login_required:chatgpt');
    }
    const authFailures = chatGPTForbiddenUrls(forbidden);
    if (authFailures.length) {
      await captureDebug(page, 'chatgpt', 'auth-403-before-send', { count: authFailures.length });
      throw new Error('login_required:chatgpt_backend_403');
    }

    const snapshot = await page.evaluate(snapshotConversationDom, CHATGPT_TURN_SPEC);
    const submittedUiPrompt = `Use web search and answer this buyer question with citations:\n\n${prompt}`;
    await composer.click({ timeout: 20_000, force: true });
    await composer.fill('');
    await page.keyboard.insertText(submittedUiPrompt);
    const composerText = await composer.inputValue().catch(async () => composer!.innerText().catch(() => ''));
    if (composerText !== submittedUiPrompt) throw new Error('prompt_binding_unverified:chatgpt_composer_round_trip');

    const submit = await firstVisibleLocator(page, 'button[data-testid="send-button"], #composer-submit-button');
    if (submit && !await submit.isDisabled().catch(() => true)) await submit.click({ timeout: 10_000 });
    else await composer.press('Enter');

    const inspection = await waitForTerminalCorrelatedTurn(page, {
      spec: CHATGPT_TURN_SPEC,
      snapshot,
      expectedPrompt: submittedUiPrompt,
      provider: 'chatgpt',
      timeoutMs: deadlineAt ? Math.max(1_000, deadlineAt - Date.now()) : 180_000,
      signal,
    });
    if (isBadChatGPTResponse(inspection.rawAnswer)) throw new Error('provider_no_answer:chatgpt');
    if (chatGPTForbiddenUrls(forbidden).length) throw new Error('login_required:chatgpt_backend_403_after_send');
    if (!inspection.userNodeId || !inspection.assistantNodeId || !inspection.answerNodeId || !inspection.terminalSignal) {
      throw new Error('provider_identity_missing:chatgpt');
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
    await captureDebug(page, 'chatgpt', 'terminal-success', {
      userTurnId: inspection.userNodeId, assistantTurnId: inspection.assistantNodeId,
      answerNodeId: inspection.answerNodeId, terminalSignal: inspection.terminalSignal,
      rawByteLength: Buffer.byteLength(inspection.rawAnswer, 'utf8'),
    });
    return {
      capturedPrompt: prompt,
      rawAnswer: inspection.rawAnswer,
      citations: inspection.links,
      provenance: buildProvenance('chatgpt-consumer', { terminalProof }, connectionMeta),
    };
  } catch (error) {
    await captureDebug(page, 'chatgpt', 'capture-rejected', {
      reason: error instanceof Error ? error.message.slice(0, 160) : 'unknown_error',
    });
    await closeChatGPTBrowser();
    throw error;
  }
}
