import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { sanitizeAnswerText } from '../src/lib/geo/sanitize-answer';
import {
  BROWSER_ADAPTER_VERSIONS,
  PROVIDER_TERMINAL_SIGNALS,
  assertRuntimeCommitShas,
  buildProvenance,
  type BrowserConnectionMetadata,
} from '../src/workers/lib/playwright/capture-contract';
import {
  inspectCorrelatedConversationTurn,
  snapshotConversationDom,
  type ConversationDomSpec,
  type CorrelatedTurnStatus,
} from '../src/workers/lib/playwright/conversation-dom';
import { CHATGPT_TURN_SPEC, CLAUDE_TURN_SPEC, GROK_TURN_SPEC } from '../src/workers/lib/playwright/provider-turn-specs';
import { inspectPerplexityDom, type PerplexityInspectionStatus } from '../src/workers/lib/playwright/perplexity-dom';
import { inspectGoogleAioDom, type GoogleAioState } from '../src/workers/lib/playwright/google-aio-dom';
import {
  closeChatGPTBrowser,
  configureChatGPTAdapterForTests,
  installChatGPTBrowserForTests,
  scrapeChatGPTPrompt,
} from '../src/workers/lib/playwright/chatgpt';
import {
  closeGrokBrowser,
  configureGrokAdapterForTests,
  installGrokBrowserForTests,
  scrapeGrokPrompt,
} from '../src/workers/lib/playwright/grok';
import { validateWorkerAdapterEnvelope } from '../src/workers/lib/evidence-contract-boundary';

const PROMPT = 'Which form builder is best for a small SaaS team?';
const ANSWER = 'Tally is a capable form builder for a small SaaS team, with a generous free tier and straightforward integrations.';

const connectionMeta: BrowserConnectionMetadata = {
  connectionMode: 'proxy', actualConnectionMode: 'proxy', proxyRequested: true, proxyUsed: true,
  fallbackUsed: false, requestedMarket: 'US', actualRegion: 'US', regionVerified: true,
  regionVerificationStatus: 'verified', locale: 'en-US', actualLocale: 'en-US',
};

type GenericProvider = 'chatgpt' | 'claude' | 'grok';
interface GenericFixture {
  provider: GenericProvider;
  model: 'chatgpt-consumer' | 'claude' | 'grok';
  spec: ConversationDomSpec;
  turn: (id: string, prompt: string, answer: string, options?: { terminal?: boolean; streaming?: boolean; omitUser?: boolean; omitUserId?: boolean; omitAssistantId?: boolean }) => string;
  interstitial: string;
}

const genericFixtures: GenericFixture[] = [
  {
    provider: 'chatgpt', model: 'chatgpt-consumer', spec: CHATGPT_TURN_SPEC,
    turn: (id, prompt, answer, options = {}) => `
      ${options.omitUser ? '' : `<section data-turn="user" data-testid="conversation-turn-${id}-u"><div>${prompt}</div></section>`}
      <section data-turn="assistant" data-testid="conversation-turn-${id}-a">
        <div data-message-author-role="assistant"><div class="markdown">${answer}</div></div>
        ${options.streaming ? '<span aria-busy="true"></span>' : ''}
        ${options.terminal === false ? '' : '<button data-testid="copy-turn-action-button">Copy</button>'}
      </section>`,
    interstitial: '<div data-testid="log-back-form">Choose an account</div>',
  },
  {
    provider: 'claude', model: 'claude', spec: CLAUDE_TURN_SPEC,
    turn: (id, prompt, answer, options = {}) => `
      ${options.omitUser ? '' : `<div data-testid="user-message" ${options.omitUserId ? '' : `data-message-id="claude-${id}-u"`}>${prompt}</div>`}
      <div data-testid="assistant-message" ${options.omitAssistantId ? '' : `data-message-id="claude-${id}-a"`}>
        <div data-testid="assistant-message-content">${answer}</div>
        ${options.streaming ? '<span aria-busy="true"></span>' : ''}
        ${options.terminal === false ? '' : '<button aria-label="Copy response">Copy</button>'}
      </div>`,
    interstitial: '<div data-testid="account-interstitial">Account setup</div>',
  },
  {
    provider: 'grok', model: 'grok', spec: GROK_TURN_SPEC,
    turn: (id, prompt, answer, options = {}) => `
      ${options.omitUser ? '' : `<div data-message-author-role="user" ${options.omitUserId ? '' : `data-message-id="grok-${id}-u"`}>${prompt}</div>`}
      <div data-message-author-role="assistant" ${options.omitAssistantId ? '' : `data-message-id="grok-${id}-a"`}>
        <div data-testid="message-content">${answer}</div>
        ${options.streaming ? '<span aria-busy="true"></span>' : ''}
        ${options.terminal === false ? '' : '<button aria-label="Copy response">Copy</button>'}
      </div>`,
    interstitial: '<div data-testid="account-interstitial">Account setup</div>',
  },
];

async function inspectGeneric(page: Page, fixture: GenericFixture, initial: string, current: string, expected = PROMPT) {
  await page.setContent(`<main>${initial}</main>`);
  const snapshot = await page.evaluate(snapshotConversationDom, fixture.spec);
  await page.setContent(`<main>${initial}${current}</main>`);
  return page.evaluate(inspectCorrelatedConversationTurn, { spec: fixture.spec, snapshot, expectedPrompt: expected });
}

async function assertGenericProviderMatrix(page: Page, fixture: GenericFixture): Promise<void> {
  const prior = fixture.turn('old', 'Previous unrelated prompt', 'A prior answer that must never be selected.');
  assert.equal((await inspectGeneric(page, fixture, prior, fixture.turn('new', PROMPT, ANSWER))).status, 'terminal');
  assert.equal((await inspectGeneric(page, fixture, prior, fixture.turn('new', PROMPT, ANSWER, { streaming: true }))).status, 'streaming');
  assert.equal((await inspectGeneric(page, fixture, prior, '')).status, 'waiting');
  assert.equal((await inspectGeneric(page, fixture, prior, fixture.turn('new', 'Wrong prompt', ANSWER))).status, 'prompt_binding_unverified');
  assert.equal((await inspectGeneric(page, fixture, prior, '<nav>Navigation only</nav>')).status, 'waiting');
  assert.equal((await inspectGeneric(page, fixture, prior, '<form action="/login">Login</form>')).status, 'login_required');
  assert.equal((await inspectGeneric(page, fixture, prior, '<div data-testid="rate-limit-message">Limit</div>')).status, 'rate_limited');
  if (fixture.provider === 'grok') {
    assert.equal((await inspectGeneric(page, fixture, prior,
      '<div>2 hours before limit is gone. Upgrade to SuperGrok for higher limits.</div>')).status, 'rate_limited');
  }
  assert.equal((await inspectGeneric(page, fixture, prior, fixture.turn('new', PROMPT, "I'm sorry, I can't help with that."))).status, 'provider_refusal');
  assert.equal((await inspectGeneric(page, fixture, prior, fixture.turn('new', PROMPT, 'No answer'))).status, 'provider_no_answer');
  assert.equal((await inspectGeneric(page, fixture, prior, fixture.interstitial)).status, 'provider_interstitial');
  const duplicate = fixture.turn('new', PROMPT, ANSWER)
    + fixture.turn('duplicate', PROMPT, `${ANSWER} Duplicate.`, { omitUser: true });
  const duplicateInspection = await inspectGeneric(page, fixture, prior, duplicate);
  assert.equal(duplicateInspection.status, 'duplicate_current_turn');
  const twoPrior = prior + fixture.turn('older', 'Another previous prompt', 'Another previous answer.');
  assert.equal((await inspectGeneric(page, fixture, twoPrior, fixture.turn('new', PROMPT, ANSWER))).status, 'terminal');
  assert.equal((await inspectGeneric(page, fixture, prior, '<article data-role="changed-selector">Drifted markup</article>')).status, 'waiting');
  assert.equal((await inspectGeneric(page, fixture, prior, fixture.turn('new', PROMPT, ANSWER, { terminal: false }))).status, 'terminal_signal_missing');
  const providerBound = await inspectGeneric(page, fixture, prior, fixture.turn('new', PROMPT, ANSWER));
  assert.equal(providerBound.turnBindingMethod, 'provider_id');
  const deterministicBound = await inspectGeneric(page, fixture, prior,
    fixture.turn('new', PROMPT, ANSWER, { omitUserId: true, omitAssistantId: true }));
  assert.equal(deterministicBound.status, 'terminal');
  assert.equal(deterministicBound.turnBindingMethod, fixture.provider === 'chatgpt' ? 'provider_id' : 'deterministic_dom');
  const timeoutState: CorrelatedTurnStatus = (await inspectGeneric(page, fixture, prior, '')).status;
  assert.equal(timeoutState, 'waiting');
}

function perplexityHtml(input: {
  prompt?: string;
  answer?: string;
  terminal?: boolean;
  streaming?: boolean;
  duplicate?: boolean;
  shell?: string;
} = {}): string {
  if (input.shell) return input.shell;
  const prompt = input.prompt ?? PROMPT;
  const answer = input.answer ?? ANSWER;
  const answerBlock = (id: string) => `<div role="tabpanel" id="perplexity-${id}">
    <div class="group relative flex items-end"><div role="heading" class="group/query">${prompt}</div><button aria-label="Copy query">Copy query</button></div>
    <div class="gap-y-2 flex flex-col"><div class="prose">${answer}${answer === 'No answer' ? '' : '<a href="https://tally.so/">Tally</a>'}</div>
      ${input.terminal === false ? '' : '<button aria-label="Copy">Copy</button><button aria-label="Rewrite Session">Rewrite</button><button aria-label="Share">Share</button>'}</div>
    ${input.streaming ? '<button aria-label="Stop">Stop</button>' : ''}
  </div>`;
  return answerBlock('current') + (input.duplicate ? answerBlock('duplicate') : '');
}

async function inspectPerplexity(page: Page, html: string, options: { prompt?: string; priorUrl?: string; currentUrl?: string } = {}) {
  await page.setContent(html);
  return page.evaluate(inspectPerplexityDom, {
    expectedPrompt: options.prompt ?? PROMPT,
    priorUrl: options.priorUrl ?? 'https://www.perplexity.ai/',
    currentUrl: options.currentUrl ?? 'https://www.perplexity.ai/search/tally-current-thread-12345678',
  });
}

async function assertPerplexityMatrix(page: Page): Promise<void> {
  assert.equal((await inspectPerplexity(page, perplexityHtml())).status, 'terminal');
  assert.equal((await inspectPerplexity(page, perplexityHtml({ streaming: true }))).status, 'streaming');
  assert.equal((await inspectPerplexity(page, perplexityHtml(), { currentUrl: 'https://www.perplexity.ai/' })).status, 'waiting');
  assert.equal((await inspectPerplexity(page, perplexityHtml({ prompt: 'Wrong prompt' }))).status, 'prompt_binding_unverified');
  assert.equal((await inspectPerplexity(page, '<nav>Shell only</nav>')).status, 'prompt_binding_unverified');
  assert.equal((await inspectPerplexity(page, '<form action="/login">Login</form>')).status, 'login_required');
  assert.equal((await inspectPerplexity(page, '<div data-testid="rate-limit-message">Limit</div>')).status, 'rate_limited');
  assert.equal((await inspectPerplexity(page, perplexityHtml({ answer: "I'm sorry, I can't help." }))).status, 'provider_refusal');
  assert.equal((await inspectPerplexity(page, perplexityHtml({ answer: 'No answer' }))).status, 'provider_no_answer');
  assert.equal((await inspectPerplexity(page, '<div data-testid="account-interstitial">Setup</div>')).status, 'provider_interstitial');
  assert.equal((await inspectPerplexity(page, perplexityHtml({ duplicate: true }))).status, 'duplicate_current_turn');
  assert.equal((await inspectPerplexity(page, `<div role="tabpanel" id="old"><div role="heading" class="group/query">Old prompt</div></div>${perplexityHtml()}`)).status, 'terminal');
  assert.equal((await inspectPerplexity(page, '<article>Selector drift</article>')).status, 'prompt_binding_unverified');
  assert.equal((await inspectPerplexity(page, perplexityHtml({ terminal: false }))).status, 'terminal_signal_missing');
  assert.equal((await inspectPerplexity(page, perplexityHtml(), { currentUrl: 'https://www.perplexity.ai/search/x' })).status, 'provider_identity_missing');
  const timeoutState: PerplexityInspectionStatus = (await inspectPerplexity(page, '')).status;
  assert.equal(timeoutState, 'prompt_binding_unverified');
}

function googleHtml(input: {
  prompt?: string;
  answer?: string;
  terminal?: boolean;
  streaming?: boolean;
  duplicate?: boolean;
  shell?: string;
} = {}): string {
  if (input.shell) return `<html><body>${input.shell}</body></html>`;
  const container = (id: string) => `<section data-attrid="ai_overview_${id}" id="aio-${id}" ${input.streaming ? 'aria-busy="true"' : ''}>
    <h2>AI Overview</h2><div>${input.answer ?? ANSWER}</div><a href="https://tally.so/">Tally</a>
    ${input.terminal === false ? '' : '<button aria-label="Copy">Copy</button>'}</section>`;
  return `<html><body><input name="q" value="${input.prompt ?? PROMPT}"><main id="search">${container('current')}${input.duplicate ? container('duplicate') : ''}</main></body></html>`;
}

async function inspectGoogle(page: Page, html: string, prompt = PROMPT) {
  await page.setContent(html);
  return page.evaluate(inspectGoogleAioDom, prompt);
}

async function assertGoogleMatrix(page: Page): Promise<void> {
  const positive = await inspectGoogle(page, googleHtml());
  assert.equal(positive.state, 'aio_complete');
  assert.equal(positive.links.length, 1, 'positive AIO retains only container-scoped sources');
  assert.equal((await inspectGoogle(page, googleHtml({ streaming: true }))).state, 'aio_rendering');
  assert.equal((await inspectGoogle(page, googleHtml({ prompt: 'Previous prompt' }))).state, 'search_submitted');
  assert.equal((await inspectGoogle(page, googleHtml({ prompt: 'Wrong prompt' }))).state, 'search_submitted');
  assert.equal((await inspectGoogle(page, googleHtml({ prompt: `${PROMPT} with extra terms` }))).state, 'search_submitted');
  assert.equal((await inspectGoogle(page, googleHtml({ shell: '<nav>Shell only</nav>' }))).state, 'search_submitted');
  assert.equal((await inspectGoogle(page, googleHtml({ shell: '<form action="/login">Login</form><input name="q" value="' + PROMPT + '">' }))).state, 'login_required');
  assert.equal((await inspectGoogle(page, googleHtml({ shell: '<div data-testid="rate-limit">Limit</div><input name="q" value="' + PROMPT + '">' }))).state, 'rate_limited');
  assert.equal((await inspectGoogle(page, googleHtml({ answer: "I'm sorry, I can't help." }))).state, 'refusal');
  assert.equal((await inspectGoogle(page, '<html><body><input name="q" value="' + PROMPT + '"><div id="search"><h3>Organic only</h3></div></body></html>')).state, 'results_loaded');
  assert.equal((await inspectGoogle(page, '<html><body><input name="q" value="' + PROMPT + '"><aside role="complementary"><h2>Knowledge panel</h2><p>Tally company facts</p></aside><div id="search"><h3>Organic result</h3></div></body></html>')).state, 'results_loaded');
  assert.equal((await inspectGoogle(page, '<html><body><input name="q" value="' + PROMPT + '"><div id="search"><div data-attrid="wa:/description"><p>Featured snippet answer</p><a href="https://example.com">Source</a></div><h3>Organic result</h3></div></body></html>')).state, 'results_loaded');
  assert.equal((await inspectGoogle(page, '<html><body><input name="q" value="' + PROMPT + '"><aside role="complementary"><section aria-label="AI Overview"><h2>AI Overview</h2><p>Knowledge panel text only</p><button aria-label="Copy">Copy</button></section></aside><div id="search"><h3>Organic result</h3></div></body></html>')).state, 'results_loaded');
  assert.equal((await inspectGoogle(page, googleHtml({ shell: '<form action="https://consent.google.com/save"><p>Before you continue</p></form><input name="q" value="' + PROMPT + '">' }))).state, 'consent');
  assert.equal((await inspectGoogle(page, googleHtml({ shell: '<div data-testid="account-interstitial">Setup</div><input name="q" value="' + PROMPT + '">' }))).state, 'interstitial');
  assert.equal((await inspectGoogle(page, googleHtml({ duplicate: true }))).state, 'duplicate_aio');
  assert.equal((await inspectGoogle(page, googleHtml())).state, 'aio_complete');
  assert.equal((await inspectGoogle(page, '<html><body><input name="q" value="' + PROMPT + '"><article>Drift</article></body></html>')).state, 'search_submitted');
  assert.equal((await inspectGoogle(page, googleHtml({ terminal: false }))).state, 'aio_rendering');
  const timeoutState: GoogleAioState = (await inspectGoogle(page, '<html><body><input name="q" value="' + PROMPT + '"></body></html>')).state;
  assert.equal(timeoutState, 'search_submitted');
  await page.setContent(`<html><body><input name="q" value="${PROMPT}"><main id="search"></main></body></html>`);
  const delayedContainer = googleHtml().match(/<section[\s\S]*<\/section>/)?.[0] ?? '';
  await page.evaluate((html) => {
    setTimeout(() => document.querySelector('main')?.insertAdjacentHTML('beforeend', html), 25);
  }, delayedContainer);
  await page.waitForTimeout(150);
  assert.equal((await page.evaluate(inspectGoogleAioDom, PROMPT)).state, 'aio_complete', 'lazy AIO is detected after it renders');
}

function chatGPTPage(kind: string): string {
  const composer = '<textarea id="prompt-textarea" aria-label="Chat with ChatGPT"></textarea>';
  const profile = '<button data-testid="accounts-profile-button" aria-label="Open profile menu">Profile</button>';
  if (kind === 'login') return '<a href="/auth/login">Log in</a>';
  if (kind === 'challenge') return '<div id="challenge-running">Security check</div>';
  if (kind === 'outage') return '<div>ChatGPT is currently unavailable.</div>';
  if (kind === 'chooser') return '<div data-testid="log-back-form"><button role="button">Choose account</button></div>';
  if (kind === 'missing_composer') return profile;
  if (kind === 'missing_profile') return composer;
  if (kind === 'normal') return `${profile}${composer}<div class="cf-unrelated">Connection restored</div>
    <button id="composer-submit-button" onclick="submitPrompt()">Send</button><main id="conversation"></main>
    <script>function submitPrompt(){const prompt=document.querySelector('#prompt-textarea').value;document.querySelector('#conversation').innerHTML=
      '<section data-turn="user" data-testid="conversation-turn-live-u"><div>'+prompt+'</div></section>'+
      '<section data-turn="assistant" data-testid="conversation-turn-live-a"><div data-message-author-role="assistant"><div class="markdown">${ANSWER}</div></div><button data-testid="copy-turn-action-button">Copy</button></section>';}</script>`;
  return '<main>Provider shell</main>';
}

async function withChatGPTFixture(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  retryKind: string,
  run: (forbidden: string[]) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext();
  await context.addInitScript({ content: 'Object.defineProperty(globalThis, "__name", { value: (target) => target, configurable: true });' });
  const page = await context.newPage();
  const forbidden: string[] = [];
  page.on('response', (response) => {
    if (response.status() === 403 && response.url().includes('chatgpt.com/')) forbidden.push(response.url());
  });
  await page.route('https://chatgpt.com/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/backend-api/me')) {
      await route.fulfill({ status: 403, contentType: 'application/json', body: '{}' });
      return;
    }
    const retry = url.includes('retry=1');
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: retry
        ? `${chatGPTPage(retryKind === 'backend_403' ? 'shell' : retryKind)}${retryKind === 'backend_403' ? '<script>fetch("/backend-api/me")</script>' : ''}`
        : chatGPTPage(retryKind === 'normal' ? 'normal' : 'shell'),
    });
  });
  await page.goto('https://chatgpt.com/');
  installChatGPTBrowserForTests({ runtime: { context, close: async () => context.close(), connectionMeta }, page, forbidden, connectionMeta: { ...connectionMeta } });
  configureChatGPTAdapterForTests({ authTimeoutMs: 35, authPollMs: 5, retryWaitMs: 20, chooserWaitMs: 5 });
  try {
    await run(forbidden);
  } finally {
    await closeChatGPTBrowser();
    configureChatGPTAdapterForTests(null);
  }
}

async function assertChatGPTWrapperMatrix(browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<void> {
  await withChatGPTFixture(browser, 'normal', async () => {
    const capture = await scrapeChatGPTPrompt(PROMPT, undefined, Date.now() + 10_000);
    assert.equal(capture.rawAnswer, ANSWER);
    assert.equal(capture.provenance.adapterVersion, 'chatgpt_dom_v11');
  });
  for (const [kind, code] of [
    ['login', 'session_expired:chatgpt_logged_out'],
    ['challenge', 'provider_challenge:chatgpt'],
    ['outage', 'provider_outage:chatgpt'],
    ['backend_403', 'provider_forbidden:chatgpt_backend_403'],
    ['chooser', 'provider_interstitial:chatgpt_account_chooser'],
    ['missing_composer', 'adapter_selector_missing:chatgpt_composer'],
    ['missing_profile', 'adapter_selector_missing:chatgpt_profile_control'],
  ] as const) {
    await withChatGPTFixture(browser, kind, async () => {
      await assert.rejects(() => scrapeChatGPTPrompt(PROMPT, undefined, Date.now() + 2_000), new RegExp(code));
    });
  }
  for (const [message, code] of [
    ['TimeoutError: Navigation timeout exceeded', 'provider_navigation_timeout:chatgpt'],
    ['net::ERR_TUNNEL_CONNECTION_FAILED', 'provider_proxy_failure:chatgpt'],
    ['net::ERR_NAME_NOT_RESOLVED', 'provider_network_failure:chatgpt_dns'],
    ['Target page, context or browser has been closed', 'provider_outage:chatgpt_browser_unavailable'],
  ] as const) {
    await withChatGPTFixture(browser, 'shell', async () => {
      configureChatGPTAdapterForTests({
        authTimeoutMs: 25, authPollMs: 5, retryWaitMs: 1,
        navigate: async () => { throw new Error(message); },
      });
      await assert.rejects(() => scrapeChatGPTPrompt(PROMPT, undefined, Date.now() + 2_000), new RegExp(code));
    });
  }
}

function grokPage(kind: 'normal' | 'unrelated' | 'immediate_quota' | 'delayed_quota'): string {
  const alert = kind === 'unrelated' ? '<div role="alert">Your draft was saved</div>' : '';
  return `<textarea id="grok-input"></textarea>${alert}<button type="submit" onclick="submitPrompt()">Send</button><main id="conversation"></main>
    <script>function submitPrompt(){const prompt=document.querySelector('#grok-input').value;
      ${kind === 'immediate_quota' ? "document.body.insertAdjacentHTML('beforeend','<div role=\"alert\">Usage limit exceeded.</div>');" : ''}
      ${kind === 'delayed_quota' ? "setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<div role=\"alert\">You have reached your limit.</div>'),60);" : ''}
      ${kind === 'normal' || kind === 'unrelated' ? `document.querySelector('#conversation').innerHTML='<div data-message-author-role="user" data-message-id="grok-live-u">'+prompt+'</div><div data-message-author-role="assistant" data-message-id="grok-live-a"><div data-testid="message-content">${ANSWER}</div><button aria-label="Copy response">Copy</button></div>';` : ''}
    }</script>`;
}

async function withGrokFixture(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  kind: Parameters<typeof grokPage>[0],
  run: () => Promise<void>,
): Promise<void> {
  const context = await browser.newContext();
  await context.addInitScript({ content: 'Object.defineProperty(globalThis, "__name", { value: (target) => target, configurable: true });' });
  const page = await context.newPage();
  await page.route('https://grok.com/**', (route) => route.fulfill({ contentType: 'text/html', body: grokPage(kind) }));
  installGrokBrowserForTests({ runtime: { context, close: async () => context.close(), connectionMeta }, page, connectionMeta: { ...connectionMeta } });
  configureGrokAdapterForTests({ quotaPollMs: 20, quotaTimeoutMs: 140 });
  try {
    await run();
  } finally {
    await closeGrokBrowser();
    configureGrokAdapterForTests(null);
  }
}

async function assertGrokWrapperMatrix(browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<void> {
  for (const kind of ['normal', 'unrelated'] as const) {
    await withGrokFixture(browser, kind, async () => {
      const capture = await scrapeGrokPrompt(PROMPT, undefined, Date.now() + 10_000);
      assert.equal(capture.rawAnswer, ANSWER);
      assert.equal(capture.provenance.adapterVersion, 'grok_dom_v10');
    });
  }
  for (const kind of ['immediate_quota', 'delayed_quota'] as const) {
    await withGrokFixture(browser, kind, async () => {
      await assert.rejects(() => scrapeGrokPrompt(PROMPT, undefined, Date.now() + 2_000), /provider_rate_limit:grok_usage_cap/);
    });
  }
}

async function runShutdownHarness(mode: 'graceful' | 'forced'): Promise<{ code: number | null; trace: string; elapsedMs: number }> {
  const directory = await mkdtemp(join(tmpdir(), 'builder-radar-shutdown-'));
  const tracePath = join(directory, `${mode}.log`);
  const started = Date.now();
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/shutdown-process-harness.ts', mode, tracePath], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`shutdown harness timed out: ${stderr}`)); }, 5_000);
      child.once('error', reject);
      child.once('exit', (exitCode) => { clearTimeout(timeout); resolve(exitCode); });
    });
    return { code, trace: await readFile(tracePath, 'utf8'), elapsedMs: Date.now() - started };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertShutdownProcessMatrix(): Promise<void> {
  const graceful = await runShutdownHarness('graceful');
  assert.equal(graceful.code, 1);
  assert.match(graceful.trace, /operation_aborted/);
  assert.match(graceful.trace, /fail:cell-exact:worker-exact:cancelled:false:worker_shutdown_cancelled/);
  assert.match(graceful.trace, /browsers_closed[\s\S]*job_refreshed:job-exact[\s\S]*exit_code:1/);
  assert.doesNotMatch(graceful.trace, /forced_exit/);
  const forced = await runShutdownHarness('forced');
  assert.equal(forced.code, 1);
  assert.match(forced.trace, /operation_aborted[\s\S]*forced_exit:1/);
  assert.doesNotMatch(forced.trace, /exit_code:1/);
  assert.ok(forced.elapsedMs < 3_000, `forced shutdown was not bounded: ${forced.elapsedMs}ms`);
}

function validEnvelope(engine: GenericFixture['model'] | 'perplexity' | 'google-aio') {
  const adapterVersion = BROWSER_ADAPTER_VERSIONS[engine];
  const signal = PROVIDER_TERMINAL_SIGNALS[adapterVersion as keyof typeof PROVIDER_TERMINAL_SIGNALS][0];
  const rawAnswer = `${ANSWER}\r\nExact raw spacing.\t`;
  const contentSha256 = createHash('sha256').update(Buffer.from(rawAnswer, 'utf8')).digest('hex');
  return {
    contractVersion: '1.1.0', schemaVersion: 'evidence_adapter_v1', engine, adapterVersion,
    projectId: 'project-123', scanJobId: 'job-123', scanCellId: 'cell-123', baselineId: 'baseline-123', promptId: 'prompt-123',
    submittedPrompt: PROMPT, capturedPrompt: PROMPT, rawAnswer,
    rawReceipt: { kind: 'database', uri: `urn:builder-radar:database-receipt:ingestion-pending:cell-123:${engine}:${contentSha256}`, contentSha256, mediaType: 'text/plain;charset=utf-8', immutable: true },
    capturedAt: new Date().toISOString(), captureStatus: 'accepted', promptBindingStatus: 'verified', completionStatus: 'terminal', primaryFailureCode: null,
    diagnostics: { durability: 'pending_private_database_ingestion' },
    provenance: {
      requestedMarket: 'US', actualRegion: 'US', regionVerificationStatus: 'verified', requestedLocale: 'en-US', actualLocale: 'en-US',
      actualConnectionMode: 'proxy', proxyRequested: true, proxyUsed: true, fallbackOccurred: false, adapterVersion,
      browserProviderMetadata: {}, turnBindingMethod: 'provider_id', captureBindingId: null,
      userTurnId: `${engine}:provider-user-id`, assistantTurnId: `${engine}:provider-assistant-id`,
      answerNodeId: `${engine}:provider-answer-id`, providerTerminalSignal: signal,
    },
  };
}

async function main() {
  console.log('=== Worker deterministic evidence tests ===');
  assert.deepEqual(BROWSER_ADAPTER_VERSIONS, {
    'chatgpt-consumer': 'chatgpt_dom_v11', claude: 'claude_dom_v11', perplexity: 'perplexity_dom_v9',
    'google-aio': 'google_aio_state_v8', grok: 'grok_dom_v10', 'gemini-grounded': 'not_browser_captured',
    kimi: 'not_browser_captured', mistral: 'not_browser_captured', 'gpt-oss': 'not_browser_captured',
  });
  assert.throws(() => assertRuntimeCommitShas({ GITHUB_ACTIONS: 'true', GITHUB_SHA: 'bad', PRIVATE_INGESTION_COMMIT: '2'.repeat(40) }));
  assert.deepEqual(assertRuntimeCommitShas({ GITHUB_ACTIONS: 'true', GITHUB_SHA: '1'.repeat(40), PRIVATE_INGESTION_COMMIT: '2'.repeat(40) }),
    { workerSha: '1'.repeat(40), privateSha: '2'.repeat(40) });
  assert.throws(() => buildProvenance('chatgpt-consumer', {
    terminalProof: {
      providerState: 'complete', turnBindingMethod: 'provider_id', captureBindingId: null,
      userTurnId: 'synthetic-user-1', assistantTurnId: 'provider-assistant-id',
      answerNodeId: 'provider-answer-id', terminalSignal: 'chatgpt_turn_actions_complete', stableChecks: 3,
    },
  }, connectionMeta));

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.evaluate(`globalThis.__name = (target) => target`);
  try {
    for (const fixture of genericFixtures) {
      await assertGenericProviderMatrix(page, fixture);
      console.log(`PASS ${fixture.provider}: exact-turn and rejection matrix`);
    }
    await assertPerplexityMatrix(page);
    console.log('PASS perplexity: narrow thread/query/answer/citation matrix');
    await assertGoogleMatrix(page);
    console.log('PASS google-aio: exact aio_complete/no-answer and rejection matrix');
    await assertChatGPTWrapperMatrix(browser);
    console.log('PASS chatgpt: exact adapter wrapper navigation/auth classification matrix');
    await assertGrokWrapperMatrix(browser);
    console.log('PASS grok: installed Playwright quota locator and normal-response matrix');
  } finally {
    await browser.close();
  }

  await assertShutdownProcessMatrix();
  console.log('PASS runner: process-level graceful and bounded forced shutdown matrix');

  for (const engine of ['chatgpt-consumer', 'claude', 'perplexity', 'grok', 'google-aio'] as const) {
    const envelope = validEnvelope(engine);
    assert.equal(validateWorkerAdapterEnvelope(envelope).success, true, `${engine} valid envelope`);
    const synthetic = structuredClone(envelope);
    synthetic.provenance.userTurnId = 'synthetic-user-1';
    assert.equal(validateWorkerAdapterEnvelope(synthetic).success, false, `${engine} synthetic identity rejected`);
    const deterministic = structuredClone(envelope);
    deterministic.provenance.turnBindingMethod = 'deterministic_dom';
    deterministic.provenance.captureBindingId = `local:sha256:${'a'.repeat(64)}`;
    deterministic.provenance.userTurnId = null;
    deterministic.provenance.assistantTurnId = null;
    deterministic.provenance.answerNodeId = null;
    assert.equal(validateWorkerAdapterEnvelope(deterministic).success, true, `${engine} deterministic DOM binding accepted`);
    const unavailable = structuredClone(deterministic);
    unavailable.provenance.turnBindingMethod = 'unavailable';
    unavailable.provenance.captureBindingId = null;
    assert.equal(validateWorkerAdapterEnvelope(unavailable).success, false, `${engine} unavailable binding rejected`);
    const invalidSignal = structuredClone(envelope);
    invalidSignal.provenance.providerTerminalSignal = 'complete';
    assert.equal(validateWorkerAdapterEnvelope(invalidSignal).success, false, `${engine} invalid terminal signal rejected`);
    const wrongVersion = structuredClone(envelope);
    wrongVersion.adapterVersion = 'obsolete_adapter_v0';
    wrongVersion.provenance.adapterVersion = wrongVersion.adapterVersion;
    assert.equal(validateWorkerAdapterEnvelope(wrongVersion).success, false, `${engine} wrong adapter version rejected`);
    const syntheticObjectStore = structuredClone(envelope);
    syntheticObjectStore.rawReceipt.kind = 'object_store';
    assert.equal(validateWorkerAdapterEnvelope(syntheticObjectStore).success, false, `${engine} synthetic object-store receipt rejected`);
    const wrongHash = structuredClone(envelope);
    wrongHash.rawReceipt.contentSha256 = 'f'.repeat(64);
    assert.equal(validateWorkerAdapterEnvelope(wrongHash).success, false, `${engine} raw-byte hash mismatch rejected`);
  }

  const raw = '  Exact\r\nraw\tanswer with  spacing  ';
  const before = Buffer.from(raw, 'utf8');
  const sanitized = sanitizeAnswerText(raw);
  assert.notEqual(sanitized, raw);
  assert.deepEqual(Buffer.from(raw, 'utf8'), before, 'sanitization must not mutate raw UTF-8 bytes');
  assert.equal(createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex'), createHash('sha256').update(before).digest('hex'));
  console.log('PASS boundary: versions, identities, signals, database receipt, raw bytes and SHA');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
