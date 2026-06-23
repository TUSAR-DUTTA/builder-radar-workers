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
  if (model === 'copilot') return path.join(dir, 'copilot_auth_state.json');
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
  const { chromium } = await import('playwright-extra');
  const stealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
  chromium.use(stealthPlugin());
  const browserType = chromium;
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
  // We only route these specific bots through residential IP because their anti-bot blocks datacenter ASNs
  // copilot removed from proxy — residential proxy IPs get flagged by Cloudflare Turnstile; testing direct IP
  const useProxy = proxyServer && (model === 'perplexity' || model === 'deepseek' || model === 'grok');
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

  const dummyBrowser = await browserType.launch();
  const actualVersion = dummyBrowser.version();
  await dummyBrowser.close();

  const context = await browserType.launchPersistentContext(userDataDir, {
    ...stealthLaunchOptions(true, !!useProxy),
    ...stealthContext(undefined),
    proxy,
  });
  await applyStealth(context);

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
    if (['image', 'media', 'font'].includes(type) || isBlockedTrackerHost(req.url())) {
      route.abort().catch(() => {});
    } else {
      route.continue().catch(() => {});
    }
  });

  if (storageState.cookies?.length) {
    await context.addCookies(storageState.cookies);
  }

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
  const useProxy = proxyServer && (model === 'perplexity' || model === 'deepseek' || model === 'copilot');
  const proxy = useProxy ? {
    server: proxyServer,
    username: process.env.PLAYWRIGHT_PROXY_USERNAME?.trim(),
    password: process.env.PLAYWRIGHT_PROXY_PASSWORD?.trim(),
  } : undefined;

  const browser = await chromium.launch({
    ...stealthLaunchOptions(true, !!useProxy),
    proxy,
  });

  const actualVersion = browser.version();
  const hasSession = isSessionAvailable(model);

  console.log(`[stealth] Launching seeded context for ${model}. hasSession: ${hasSession}, path: ${sessionPath}`);

  const context = await browser.newContext({
    ...stealthContext(actualVersion),
  });

  if (hasSession) {
    const storageState = JSON.parse(await fs.promises.readFile(sessionPath, 'utf8')) as any;
    if (storageState.cookies && storageState.cookies.length > 0) {
      await context.addCookies(storageState.cookies);
    }
    const localStorageByOrigin = Object.fromEntries(
      (storageState.origins ?? [])
        .filter((entry: any) => entry.origin && entry.localStorage?.length)
        .map((entry: any) => [entry.origin, entry.localStorage ?? []]),
    );
    await context.addInitScript((origins: Record<string, Array<{ name: string; value: string }>>) => {
      const items = origins[window.location.origin];
      if (!items?.length) return;
      for (const item of items) {
        try {
          window.localStorage.setItem(item.name, item.value);
        } catch {}
      }
    }, localStorageByOrigin);
  }

  await applyStealth(context);

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
