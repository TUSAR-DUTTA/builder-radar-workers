import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getSessionsDir } from '@/lib/session-loader';
import type { AnswerModel } from '@/lib/geo/types';
import { stealthContext, stealthLaunchOptions, applyStealth } from '../stealth';
import type { BrowserConnectionMetadata } from './capture-contract';

export type PlaywrightContextHandle = {
  context: import('playwright').BrowserContext;
  close: () => Promise<void>;
  connectionMeta: BrowserConnectionMetadata;
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

type ValidatedStorageState = {
  cookies: Parameters<import('playwright').BrowserContext['addCookies']>[0];
  origins: StoredOrigin[];
};

async function readValidatedStorageState(model: AnswerModel, sessionPath: string): Promise<ValidatedStorageState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.promises.readFile(sessionPath, 'utf8'));
  } catch {
    throw new Error(`session_contract_invalid:${model}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`session_contract_invalid:${model}`);
  }
  const candidate = parsed as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(candidate.cookies) || !Array.isArray(candidate.origins)) {
    throw new Error(`session_contract_invalid:${model}`);
  }
  return candidate as ValidatedStorageState;
}

/** Fill an input/editor and prove the browser DOM reflects the exact submitted text before sending. */
export async function fillAndVerifyComposer(
  composer: import('playwright').Locator,
  submittedText: string,
  provider: string,
): Promise<void> {
  await composer.click({ timeout: 20_000, force: true });
  await composer.fill('');
  await composer.fill(submittedText);
  const reflected = await composer.evaluate((node) => {
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) return node.value;
    return node.textContent ?? '';
  });
  const browserCanonical = (value: string): string => value.replace(/\r\n?/g, '\n');
  if (browserCanonical(reflected) !== browserCanonical(submittedText)) {
    throw new Error(`prompt_binding_unverified:${provider}_composer_round_trip`);
  }
}

const sharedUserDataDir: Record<string, string> = {};

export async function launchSeededPersistentContext(model: AnswerModel): Promise<PlaywrightContextHandle> {
  const proxyServer = process.env.PLAYWRIGHT_PROXY_SERVER?.trim();
  // We only route these specific bots through residential IP because their anti-bot blocks datacenter ASNs
  const proxyRequested = !!proxyServer;
  const proxyUsed = !!(proxyServer && (model as string === 'chatgpt-consumer' || model as string === 'openai-search' || model as string === 'google-aio'));
  const requestedMarket = process.env.PLAYWRIGHT_MARKET?.trim() || 'US';
  const { chromium } = await import('playwright-extra');
  const stealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
  chromium.use(stealthPlugin());
  const sessionPath = sessionPathFor(model);
  
  if (!sharedUserDataDir[model]) {
    if (model === 'google-aio') {
      sharedUserDataDir[model] = path.join(process.cwd(), 'playwright_google_profile');
    } else {
      sharedUserDataDir[model] = await fs.promises.mkdtemp(path.join(os.tmpdir(), `builderradar-${model.replace(/[^a-z0-9-]/gi, '-')}-`));
    }
  }
  const userDataDir = sharedUserDataDir[model];
  const storageState = await readValidatedStorageState(model, sessionPath);
  console.log(`[stealth] loading configured ${model} session state`);
  const localStorageByOrigin = Object.fromEntries(
    storageState.origins
      .filter((entry) => entry.origin && entry.localStorage?.length)
      .map((entry) => [entry.origin, entry.localStorage ?? []]),
  );

  const proxy = proxyUsed ? {
    server: proxyServer!,
    username: process.env.PLAYWRIGHT_PROXY_USERNAME?.trim(),
    password: process.env.PLAYWRIGHT_PROXY_PASSWORD?.trim(),
  } : undefined;
  
  if (proxyUsed) {
    console.log(`[stealth] routing ${model} through configured proxy`);
  } else if (proxyRequested) {
    console.log(`[stealth] bypassing proxy for ${model} to save bandwidth`);
  }

  const isGoogleAio = model === 'google-aio';
  const launchOptions: any = {
    ...stealthLaunchOptions(true, proxyUsed),
    ...stealthContext(undefined),
    proxy,
  };

  if (isGoogleAio) {
    launchOptions.channel = process.env.PLAYWRIGHT_BROWSER_CHANNEL?.trim() || 'chrome';
    launchOptions.ignoreDefaultArgs = ['--enable-automation', '--no-sandbox', '--disable-setuid-sandbox'];
    launchOptions.args = [
      '--disable-blink-features=AutomationControlled',
      '--window-size=1440,960',
      '--lang=en-US',
    ];
  }

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  await context.addInitScript({
    content: `Object.defineProperty(globalThis, '__name', { value: (target) => target, configurable: true });`,
  });
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

  await context.route('**/*', (route: import('playwright').Route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) {
      route.abort().catch(() => {});
    } else {
      route.continue().catch(() => {});
    }
  });

  if (storageState.cookies.length) {
    await context.addCookies(storageState.cookies);
  }

  const connectionMeta: BrowserConnectionMetadata = {
    connectionMode: proxyUsed ? 'proxy' : 'direct',
    actualConnectionMode: proxyUsed ? 'proxy' : 'direct',
    proxyRequested,
    proxyUsed,
    fallbackUsed: false,
    requestedMarket,
    actualRegion: null,
    regionVerified: false,
    regionVerificationStatus: 'unverified',
    locale: 'en-US',
    actualLocale: 'en-US',
  };

  // Perform egress region verification for regional proxies
  if (proxyUsed) {
    try {
      const resp = await context.request.get('https://1.1.1.1/cdn-cgi/trace', { timeout: 3000 });
      if (resp.ok()) {
        const text = await resp.text();
        const locMatch = text.match(/loc=([A-Z]{2})/i);
        if (locMatch) {
          connectionMeta.actualRegion = locMatch[1].toUpperCase();
          connectionMeta.regionVerified = true;
          connectionMeta.regionVerificationStatus = 'verified';
        }
      }
    } catch {
      // Ignored
    }
  } else {
    connectionMeta.regionVerificationStatus = 'bypassed';
  }

  return {
    context,
    connectionMeta,
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
  const proxyRequested = !!proxyServer;
  const proxyUsed = !!(proxyServer && (model as string === 'chatgpt-consumer' || model as string === 'openai-search' || model as string === 'google-aio'));
  const requestedMarket = process.env.PLAYWRIGHT_MARKET?.trim() || 'US';
  const proxy = proxyUsed ? {
    server: proxyServer!,
    username: process.env.PLAYWRIGHT_PROXY_USERNAME?.trim(),
    password: process.env.PLAYWRIGHT_PROXY_PASSWORD?.trim(),
  } : undefined;

  const browser = await chromium.launch({
    ...stealthLaunchOptions(true, proxyUsed),
    proxy,
  });

  const actualVersion = browser.version();
  const hasSession = isSessionAvailable(model);

  console.log(`[stealth] launching seeded context for ${model}; session_available=${hasSession}`);

  const context = await browser.newContext({
    ...stealthContext(actualVersion),
  });
  await context.addInitScript({
    content: `Object.defineProperty(globalThis, '__name', { value: (target) => target, configurable: true });`,
  });

  if (hasSession) {
    const storageState = await readValidatedStorageState(model, sessionPath);
    if (storageState.cookies.length > 0) {
      await context.addCookies(storageState.cookies);
    }
    const localStorageByOrigin = Object.fromEntries(
      storageState.origins
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

  const connectionMeta: BrowserConnectionMetadata = {
    connectionMode: proxyUsed ? 'proxy' : 'direct',
    actualConnectionMode: proxyUsed ? 'proxy' : 'direct',
    proxyRequested,
    proxyUsed,
    fallbackUsed: false,
    requestedMarket,
    actualRegion: null,
    regionVerified: false,
    regionVerificationStatus: 'unverified',
    locale: 'en-US',
    actualLocale: 'en-US',
  };

  if (proxyUsed) {
    try {
      const resp = await context.request.get('https://1.1.1.1/cdn-cgi/trace', { timeout: 3000 });
      if (resp.ok()) {
        const text = await resp.text();
        const locMatch = text.match(/loc=([A-Z]{2})/i);
        if (locMatch) {
          connectionMeta.actualRegion = locMatch[1].toUpperCase();
          connectionMeta.regionVerified = true;
          connectionMeta.regionVerificationStatus = 'verified';
        }
      }
    } catch {
      // Ignored
    }
  } else {
    connectionMeta.regionVerificationStatus = 'bypassed';
  }

  return {
    context,
    connectionMeta,
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
  const redactText = (value: string): string => value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/(?:bearer|token|cookie|session|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 240);
  const safeExtra = Object.fromEntries(Object.entries(extra)
    .filter(([key]) => !/(?:authorization|cookie|credential|password|secret|session|token|storage|proxy)/i.test(key))
    .slice(0, 20)
    .map(([key, value]) => [key, redactText(typeof value === 'string' ? value : JSON.stringify(value).slice(0, 240))]));
  const title = redactText(await page.title().catch(() => ''));
  let safeUrl = 'unavailable';
  try {
    const parsed = new URL(page.url());
    safeUrl = `${parsed.origin}${parsed.pathname}`.slice(0, 300);
  } catch {}

  console.log(`[DEBUG-INFO] ${model} at ${stage}: URL=${safeUrl} (bounded debug files saved)`);
  const redactionStyle = await page.addStyleTag({ content: `
    aside, nav, input, textarea, [contenteditable="true"],
    [data-testid*="account" i], [data-testid*="profile" i],
    [aria-label*="profile" i], [aria-label*="account" i], [href*="/settings"] {
      visibility: hidden !important;
    }
  ` }).catch(() => null);
  const screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
  await redactionStyle?.evaluate((node) => (node as Element).remove()).catch(() => {});

  if (screenshotBuffer) {
    await fs.promises.writeFile(`${prefix}.png`, screenshotBuffer).catch(() => {});
  }
  await fs.promises.writeFile(`${prefix}.json`, JSON.stringify({ model, stage: safeStage, title, url: safeUrl, extra: safeExtra }, null, 2), 'utf8').catch(() => {});
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
