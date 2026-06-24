import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getSessionsDir } from '@/lib/session-loader';
import type { AnswerModel } from '@/lib/geo/types';
import { stealthContext, stealthLaunchOptions, applyStealth } from '../stealth';

// Third-party analytics / ads / session-replay / error-telemetry hosts. None are required for an
// answer to render or for us to extract it, so aborting them trims proxy bandwidth on every page
// load without changing what any engine returns. Kept to DEDICATED tracker domains only (never an
// engine's own functional domain such as google.com / bing.com / openai.com), matched by exact host
// or sub-domain suffix, so no engine breaks.
const BLOCKED_TRACKER_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'analytics.google.com',
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'segment.io', 'segment.com', 'mixpanel.com', 'amplitude.com',
  'fullstory.com', 'heap.io', 'heapanalytics.com',
  'hotjar.com', 'clarity.ms',
  'sentry.io', 'browser.sentry-cdn.com',
  'datadoghq.com', 'datadoghq-browser-agent.com',
  'newrelic.com', 'nr-data.net',
  'intercom.io', 'intercomcdn.com',
  'connect.facebook.net', 'analytics.tiktok.com',
];

function isBlockedTrackerHost(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname; } catch { return false; }
  return BLOCKED_TRACKER_HOSTS.some((d) => host === d || host.endsWith('.' + d));
}

export type PlaywrightContextHandle = {
  context: import('playwright').BrowserContext;
  close: () => Promise<void>;
};

export function sessionPathFor(model: AnswerModel): string {
  const dir = getSessionsDir();
  if (model === 'claude') return path.join(dir, 'claude_auth_state.json');
  if (model === 'perplexity') return path.join(dir, 'perplexity_auth_state.json');
  if (model === 'google-aio') return path.join(dir, 'google_auth_state.json');
  if (model === 'deepseek') return path.join(dir, 'deepseek_auth_state.json');
  if (model === 'grok') return path.join(dir, 'grok_auth_state.json');
  return path.join(dir, 'chatgpt_auth_state.json');
}

export function isSessionAvailable(model: AnswerModel): boolean {
  return fs.existsSync(sessionPathFor(model));
}

type StoredOrigin = {
  origin: string;
  localStorage?: Array<{ name: string; value: string }>;
};

let sharedUserDataDir: Record<string, string> = {};

export async function launchSeededPersistentContext(model: AnswerModel): Promise<PlaywrightContextHandle> {
  // Use plain playwright (NOT playwright-extra) — the stealth plugin hooks into cookie APIs
  // and silently breaks addCookies() injection in persistent contexts.
  // Stealth is applied manually via applyStealth() after launch instead.
  const { chromium } = await import('playwright');
  const sessionPath = sessionPathFor(model);
  
  if (!sharedUserDataDir[model]) {
    sharedUserDataDir[model] = await fs.promises.mkdtemp(path.join(os.tmpdir(), `builderradar-${model.replace(/[^a-z0-9-]/gi, '-')}-`));
  }
  const userDataDir = sharedUserDataDir[model];
  const storageState = JSON.parse(await fs.promises.readFile(sessionPath, 'utf8')) as {
    cookies?: any[];
    origins?: StoredOrigin[];
  };
  const localStorageByOrigin = Object.fromEntries(
    (storageState.origins ?? [])
      .filter((entry) => entry.origin && entry.localStorage?.length)
      .map((entry) => [entry.origin, entry.localStorage ?? []]),
  );

  const proxyServer = process.env.PLAYWRIGHT_PROXY_SERVER?.trim();
  // We route these bots through residential IP because their anti-bot blocks datacenter ASNs
  // claude.ai: datacenter IPs are Cloudflare-blocked — needs proxy
  // perplexity: proxy IP triggers Turnstile; session was saved without proxy — use datacenter IP
  const useProxy = proxyServer && (model === 'deepseek' || model === 'grok' || model === 'claude' || model === 'openai-search');
  const proxy = useProxy ? {
    server: proxyServer,
    username: process.env.PLAYWRIGHT_PROXY_USERNAME?.trim(),
    password: process.env.PLAYWRIGHT_PROXY_PASSWORD?.trim(),
  } : undefined;
  
  if (useProxy) {
    console.log(`[stealth] routing Playwright through proxy ${proxyServer}`);
  } else if (proxyServer) {
    console.log(`[stealth] bypassing proxy for ${model} to save bandwidth`);
  }

  const noStealth = process.env.PLAYWRIGHT_NO_STEALTH === '1' || process.env.PLAYWRIGHT_NO_STEALTH === 'true';
  let context: import('playwright').BrowserContext;

  if (noStealth) {
    const headless = process.env.PLAYWRIGHT_HEADLESS === '1' || process.env.PLAYWRIGHT_HEADLESS === 'true';
    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      args: ['--no-sandbox', '--no-first-run'],
      proxy,
    });
  } else {
    const dummyBrowser = await chromium.launch();
    const actualVersion = dummyBrowser.version();
    await dummyBrowser.close();

    context = await chromium.launchPersistentContext(userDataDir, {
      ...stealthLaunchOptions(true, !!useProxy),
      ...stealthContext(undefined),
      proxy,
    });
    await applyStealth(context);
  }

  // addCookies works with plain playwright's persistent context.
  // NOTE: storageState in launchPersistentContext is silently ignored (0 cookies) — confirmed by diagnostic.
  if (storageState.cookies?.length) {
    await context.addCookies(storageState.cookies);
    // Verify cookies were actually set
    const allCookies = await context.cookies();
    console.log(`[session] ${model}: added ${storageState.cookies.length} cookies, verified ${allCookies.length} in context`);
  }

  await context.addInitScript((origins: Record<string, Array<{ name: string; value: string }>>) => {
    const items = origins[window.location.origin];
    if (!items?.length) return;
    for (const item of items) {
      try {
        window.localStorage.setItem(item.name, item.value);
      } catch {}
    }
  }, localStorageByOrigin);

  await context.route('**/*', (route) => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url();
    // Never block anything from Cloudflare challenge domains — Turnstile needs images/fonts to render
    if (url.includes('challenges.cloudflare.com') || url.includes('cf-turnstile')) {
      route.continue().catch(() => {});
      return;
    }
    if (['image', 'media', 'font'].includes(type) || isBlockedTrackerHost(url)) {
      route.abort().catch(() => {});
    } else {
      route.continue().catch(() => {});
    }
  });

  return {
    context,
    close: async () => {
      await context.close().catch(() => {});
      await fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export async function launchSeededContext(model: AnswerModel): Promise<PlaywrightContextHandle> {
  const { chromium } = await import('playwright');
  const sessionPath = sessionPathFor(model);
  
  const proxyServer = process.env.PLAYWRIGHT_PROXY_SERVER?.trim();
  const useProxy = proxyServer && (model === 'deepseek' || model === 'grok' || model === 'claude' || model === 'openai-search');
  const proxy = useProxy ? {
    server: proxyServer,
    username: process.env.PLAYWRIGHT_PROXY_USERNAME?.trim(),
    password: process.env.PLAYWRIGHT_PROXY_PASSWORD?.trim(),
  } : undefined;

  const noStealth = process.env.PLAYWRIGHT_NO_STEALTH === '1' || process.env.PLAYWRIGHT_NO_STEALTH === 'true';
  const hasSession = isSessionAvailable(model);
  const headless = process.env.PLAYWRIGHT_HEADLESS === '1' || process.env.PLAYWRIGHT_HEADLESS === 'true';

  let browser: import('playwright').Browser;
  let context: import('playwright').BrowserContext;

  const contextOptions: any = {};
  if (hasSession) {
    contextOptions.storageState = sessionPath;
  }

  if (noStealth) {
    browser = await chromium.launch({
      headless,
      args: ['--no-sandbox', '--no-first-run'],
      proxy,
    });
    console.log(`[no-stealth] Launching seeded context for ${model}. hasSession: ${hasSession}`);
    context = await browser.newContext(contextOptions);
  } else {
    browser = await chromium.launch({
      ...stealthLaunchOptions(true, !!useProxy),
      proxy,
    });
    const actualVersion = browser.version();
    console.log(`[stealth] Launching seeded context for ${model}. hasSession: ${hasSession}, path: ${sessionPath}`);
    context = await browser.newContext({
      ...stealthContext(actualVersion),
      ...contextOptions,
    });
  }

  if (!noStealth) {
    await applyStealth(context);
  }

  return {
    context,
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

export function debugDir(): string | null {
  const dir = process.env.PLAYWRIGHT_DEBUG_DIR?.trim();
  return dir ? dir : null;
}

export async function captureDebug(
  page: import('playwright').Page,
  model: string,
  stage: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const dir = debugDir();
  if (!dir) return;
  await fs.promises.mkdir(dir, { recursive: true });

  const safeStage = stage.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80);
  const prefix = path.join(dir, `${model}-${safeStage}`);
  const title = await page.title().catch(() => '');
  const url = page.url();
  const rawBodyText = ((await page.textContent('body').catch(() => '')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  const bodyText = rawBodyText
    .replace(/"accessToken":"[^"]+"/g, '"accessToken":"[redacted]"')
    .replace(/"sessionToken":"[^"]+"/g, '"sessionToken":"[redacted]"')
    .replace(/"email":"[^"]+"/g, '"email":"[redacted]"');

  const rawHtml = await page.innerHTML('body').catch(() => '');

  await page.screenshot({ path: `${prefix}.png`, fullPage: true }).catch(() => {});
  await fs.promises.writeFile(`${prefix}.json`, JSON.stringify({ model, stage, title, url, bodyText, rawHtml, extra }, null, 2), 'utf8').catch(() => {});
}

export async function firstVisibleLocator(
  page: import('playwright').Page,
  selector: string,
): Promise<import('playwright').Locator | null> {
  const locator = page.locator(selector);
  const count = await locator.count();
  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}
