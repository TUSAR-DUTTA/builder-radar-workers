import { launchSeededPersistentContext, captureDebug, fillAndVerifyComposer, firstVisibleLocator, type PlaywrightContextHandle } from './shared';
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

type ChatGPTAdapterTestOptions = {
  authTimeoutMs?: number;
  authPollMs?: number;
  retryWaitMs?: number;
  chooserWaitMs?: number;
  navigate?: (page: import('playwright').Page, url: string, timeoutMs: number) => Promise<unknown>;
};

let chatGPTAdapterTestOptions: ChatGPTAdapterTestOptions = {};

/** Narrow test seam: deterministic fixtures still execute the exported adapter wrapper. */
export function configureChatGPTAdapterForTests(options: ChatGPTAdapterTestOptions | null): void {
  chatGPTAdapterTestOptions = options ?? {};
}

export function installChatGPTBrowserForTests(browser: NonNullable<typeof sharedChatGPTBrowser>): void {
  sharedChatGPTBrowser = browser;
}

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
  await page.waitForTimeout(chatGPTAdapterTestOptions.chooserWaitMs ?? 2_000);
  return true;
}

function classifiedNavigationError(error: unknown): Error {
  const raw = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const normalized = raw.toLowerCase().slice(0, 600);
  if (/timeout|timed out|timeouterror/.test(normalized)) {
    return new Error('provider_navigation_timeout:chatgpt');
  }
  if (/err_proxy|err_tunnel|proxy[_ ]connection|tunnel[_ ]connection|proxy[_ ]authentication|http 407/.test(normalized)) {
    return new Error('provider_proxy_failure:chatgpt');
  }
  if (/err_name_not_resolved|enotfound|eai_again|dns/.test(normalized)) {
    return new Error('provider_network_failure:chatgpt_dns');
  }
  if (/target page, context or browser has been closed|browser.*closed|page crashed|target crashed/.test(normalized)) {
    return new Error('provider_outage:chatgpt_browser_unavailable');
  }
  return new Error('provider_network_failure:chatgpt_navigation');
}

async function navigateChatGPT(page: import('playwright').Page, url: string, timeoutMs: number): Promise<void> {
  try {
    if (chatGPTAdapterTestOptions.navigate) {
      await chatGPTAdapterTestOptions.navigate(page, url, timeoutMs);
    } else {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    }
  } catch (error) {
    throw classifiedNavigationError(error);
  }
}

async function firstVisibleText(
  page: import('playwright').Page,
  patterns: readonly RegExp[],
): Promise<import('playwright').Locator | null> {
  for (const pattern of patterns) {
    const matches = page.getByText(pattern, { exact: true });
    for (let index = 0; index < await matches.count(); index += 1) {
      const match = matches.nth(index);
      if (await match.isVisible().catch(() => false)) return match;
    }
  }
  return null;
}

async function inspectChatGPTAuthUi(page: import('playwright').Page) {
  const [composer, profile, loggedOut, chooser, challengeNode, challengeText, outageText] = await Promise.all([
    firstVisibleLocator(page, '#prompt-textarea, div[contenteditable="true"][aria-label="Chat with ChatGPT"]'),
    firstVisibleLocator(page, '[data-testid="accounts-profile-button"], [aria-label*="profile menu" i]'),
    firstVisibleLocator(page, 'a[href*="/auth/login"], button[data-testid="login-button"], button:has-text("Log in")'),
    firstVisibleLocator(page, '[data-testid="log-back-form"], button[name="session_id"], button[data-dd-action-name="Select existing session"]'),
    firstVisibleLocator(page, 'iframe[src*="challenges.cloudflare.com"], iframe[src*="/challenge-platform/"], #challenge-running, [data-testid="challenge-page"], [name="cf-turnstile-response"]'),
    firstVisibleText(page, [
      /^verify you are human[.!]?$/i,
      /^checking (?:if the site connection is secure|your browser)[.!…]?$/i,
      /^performing security verification[.!…]?$/i,
    ]),
    firstVisibleText(page, [
      /^chatgpt is currently unavailable[.!]?$/i,
      /^we are experiencing (?:exceptionally )?high demand[.!]?$/i,
      /^service temporarily unavailable[.!]?$/i,
      /^something went wrong(?: while loading chatgpt)?[.!]?$/i,
    ]),
  ]);
  return {
    composer,
    profile,
    loggedOut,
    chooser,
    challenge: challengeNode ?? challengeText,
    outage: outageText,
  };
}

function assertChatGPTAuthState(
  state: Awaited<ReturnType<typeof inspectChatGPTAuthUi>>,
  forbidden: string[],
): asserts state is Awaited<ReturnType<typeof inspectChatGPTAuthUi>> & {
  composer: import('playwright').Locator;
  profile: import('playwright').Locator;
} {
  if (chatGPTForbiddenUrls(forbidden).length) throw new Error('provider_forbidden:chatgpt_backend_403');
  if (state.challenge) throw new Error('provider_challenge:chatgpt');
  if (state.outage) throw new Error('provider_outage:chatgpt');
  if (state.loggedOut) throw new Error('session_expired:chatgpt_logged_out');
  if (state.chooser) throw new Error('provider_interstitial:chatgpt_account_chooser');
  if (!state.composer) throw new Error('adapter_selector_missing:chatgpt_composer');
  if (!state.profile) throw new Error('adapter_selector_missing:chatgpt_profile_control');
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
      await navigateChatGPT(page, 'https://chatgpt.com/', 45_000);
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
      await navigateChatGPT(page, 'https://chatgpt.com/', 45_000);
    }
    const authTimeoutMs = chatGPTAdapterTestOptions.authTimeoutMs ?? 45_000;
    const authPollMs = chatGPTAdapterTestOptions.authPollMs ?? 1_000;
    const authDeadline = Math.min(deadlineAt ?? Date.now() + authTimeoutMs, Date.now() + authTimeoutMs);
    let composer: import('playwright').Locator | null = null;
    let profile: import('playwright').Locator | null = null;
    let authState: Awaited<ReturnType<typeof inspectChatGPTAuthUi>> | null = null;
    while (Date.now() < authDeadline) {
      if (signal?.aborted) throw new Error('provider_deadline_aborted');
      if (await dismissAccountChooser(page).catch(() => false)) continue;
      authState = await inspectChatGPTAuthUi(page);
      composer = authState.composer;
      profile = authState.profile;
      if (composer && profile) break;
      if (authState.loggedOut || authState.challenge || authState.outage) break;
      await page.waitForTimeout(authPollMs);
    }
    if (!composer || !profile || authState?.loggedOut || authState?.challenge || authState?.outage) {
      await navigateChatGPT(page, 'https://chatgpt.com/?retry=1', 30_000);
      await page.waitForTimeout(chatGPTAdapterTestOptions.retryWaitMs ?? 5_000);
      authState = await inspectChatGPTAuthUi(page);
      await captureDebug(page, 'chatgpt', 'auth-state-rejected', {
        composerVisible: Boolean(authState.composer),
        profileVisible: Boolean(authState.profile),
        classification: authState.challenge ? 'challenge' : authState.outage ? 'outage'
          : authState.loggedOut ? 'logged_out' : authState.chooser ? 'account_chooser'
            : !authState.composer ? 'missing_composer' : 'missing_profile',
      });
      assertChatGPTAuthState(authState, forbidden);
      composer = authState.composer;
      profile = authState.profile;
    }
    const authFailures = chatGPTForbiddenUrls(forbidden);
    if (authFailures.length) {
      await captureDebug(page, 'chatgpt', 'auth-403-before-send', { count: authFailures.length });
      throw new Error('provider_forbidden:chatgpt_backend_403');
    }

    const snapshot = await page.evaluate(snapshotConversationDom, CHATGPT_TURN_SPEC);
    const submittedUiPrompt = `Use web search and answer this buyer question with citations:\n\n${prompt}`;
    await fillAndVerifyComposer(composer, submittedUiPrompt, 'chatgpt');

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
    if (chatGPTForbiddenUrls(forbidden).length) throw new Error('provider_forbidden:chatgpt_backend_403_after_send');
    if (!inspection.terminalSignal || inspection.turnBindingMethod === 'unavailable'
      || (inspection.turnBindingMethod === 'deterministic_dom' && !inspection.captureBindingId)) {
      throw new Error('prompt_binding_unverified:chatgpt');
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
    await captureDebug(page, 'chatgpt', 'terminal-success', {
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
