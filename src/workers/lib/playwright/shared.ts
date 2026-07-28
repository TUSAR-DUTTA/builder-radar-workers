import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getSessionsDir } from '@/lib/session-loader';
import type { AnswerModel } from '@/lib/geo/types';
import { stealthContext, stealthLaunchOptions, applyStealth } from '../stealth';

export type PlaywrightContextHandle = {
  context: import('playwright').BrowserContext;
  close: () => Promise<void>;
};

export function sessionPathFor(model: AnswerModel): string {
  const dir = getSessionsDir();
  if (model === 'claude') return path.join(dir, 'claude_auth_state.json');
  if (model === 'perplexity') return path.join(dir, 'perplexity_auth_state.json');
  if (model === 'google-aio') return path.join(dir, 'google_auth_state.json');
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

const sharedUserDataDir: Record<string, string> = {};

type StoredSession = {
  cookies?: Parameters<import('playwright').BrowserContext['addCookies']>[0];
  origins?: StoredOrigin[];
};

export async function launchSeededPersistentContext(model: AnswerModel): Promise<PlaywrightContextHandle> {
  const { chromium } = await import('playwright-extra');
  const stealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
  chromium.use(stealthPlugin());
  const browserType = chromium;
  const sessionPath = sessionPathFor(model);
  
  if (!sharedUserDataDir[model]) {
    if (model === 'google-aio') {
      sharedUserDataDir[model] = path.join(process.cwd(), 'playwright_google_profile');
    } else {
      sharedUserDataDir[model] = await fs.promises.mkdtemp(path.join(os.tmpdir(), `builderradar-${model.replace(/[^a-z0-9-]/gi, '-')}-`));
    }
  }
  const userDataDir = sharedUserDataDir[model];
  const storageState = JSON.parse(await fs.promises.readFile(sessionPath, 'utf8')) as StoredSession;
  console.log(`[stealth] loading session file from ${sessionPath}, found ${storageState.cookies?.length ?? 0} cookies`);
  const localStorageByOrigin = Object.fromEntries(
    (storageState.origins ?? [])
      .filter((entry) => entry.origin && entry.localStorage?.length)
      .map((entry) => [entry.origin, entry.localStorage ?? []]),
  );

  const proxyServer = process.env.PLAYWRIGHT_PROXY_SERVER?.trim();
  // We only route these specific bots through residential IP because their anti-bot blocks datacenter ASNs
  const useProxy = proxyServer && (model === 'chatgpt-consumer');
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

  const isGoogleAio = model === 'google-aio';
  const googleOptions = isGoogleAio ? {
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL?.trim() || 'chrome',
    ignoreDefaultArgs: ['--enable-automation', '--no-sandbox', '--disable-setuid-sandbox'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--window-size=1440,960',
      '--lang=en-US',
    ],
  } : {};
  const launchOptions: Parameters<typeof browserType.launchPersistentContext>[1] = {
    ...stealthLaunchOptions(true, !!useProxy),
    ...stealthContext(undefined),
    proxy,
    ...googleOptions,
  };

  const context = await browserType.launchPersistentContext(userDataDir, launchOptions);
  if (model === 'google-aio') {
    await applyStealth(context);
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
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) {
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
      if (model !== 'google-aio') {
        await fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

export async function launchSeededContext(model: AnswerModel): Promise<PlaywrightContextHandle> {
  const { chromium } = await import('playwright');
  const sessionPath = sessionPathFor(model);
  
  const proxyServer = process.env.PLAYWRIGHT_PROXY_SERVER?.trim();
  const useProxy = proxyServer && (model === 'chatgpt-consumer');
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
    const storageState = JSON.parse(await fs.promises.readFile(sessionPath, 'utf8')) as StoredSession;
    if (storageState.cookies && storageState.cookies.length > 0) {
      await context.addCookies(storageState.cookies);
    }
    const localStorageByOrigin = Object.fromEntries(
      (storageState.origins ?? [])
        .filter((entry) => entry.origin && entry.localStorage?.length)
        .map((entry) => [entry.origin, entry.localStorage ?? []]),
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

export interface SafeDebugMetadata {
  model: string;
  stage: string;
  origin: string | null;
  bodyTextLength: number;
  extraKeys: string[];
}

/**
 * Build the only diagnostic payload workers may persist. Page text, HTML, screenshots, query
 * strings, path identifiers and arbitrary `extra` values can all contain customer/session data,
 * so diagnostics retain only bounded type/health metadata.
 */
export function safeDebugMetadata(input: {
  model: string;
  stage: string;
  url: string;
  bodyTextLength: number;
  extra?: Record<string, unknown>;
}): SafeDebugMetadata {
  let origin: string | null = null;
  try {
    const parsed = new URL(input.url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = parsed.origin;
  } catch { /* malformed/browser-internal URL stays null */ }
  return {
    model: input.model.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40),
    stage: input.stage.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80),
    origin,
    bodyTextLength: Math.max(0, Math.min(Math.trunc(input.bodyTextLength), 10_000_000)),
    extraKeys: Object.keys(input.extra ?? {})
      .map((key) => key.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40))
      .filter(Boolean)
      .slice(0, 20),
  };
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

  const bodyTextLength = ((await page.textContent('body').catch(() => '')) ?? '').length;
  const metadata = safeDebugMetadata({ model, stage, url: page.url(), bodyTextLength, extra });
  const prefix = path.join(dir, `${metadata.model}-${metadata.stage}`);
  console.log(`[DEBUG-INFO] ${JSON.stringify(metadata)}`);
  await fs.promises.writeFile(`${prefix}.json`, JSON.stringify(metadata, null, 2), 'utf8').catch(() => {});
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
