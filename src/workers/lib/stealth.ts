import type { BrowserContext, LaunchOptions } from 'playwright';

const STEALTH_INIT_SCRIPT = `
  (() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });

    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { filename: 'internal-pdf-viewer', description: 'Portable Document Format', name: 'Chrome PDF Plugin' },
          { filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', name: 'Chrome PDF Viewer' },
          { filename: 'internal-nacl-plugin', description: '', name: 'Native Client' },
        ];
        Object.setPrototypeOf(arr, PluginArray.prototype);
        return arr;
      },
    });

    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => {
        const arr = [{ type: 'application/pdf', description: '', suffixes: 'pdf' }];
        Object.setPrototypeOf(arr, MimeTypeArray.prototype);
        return arr;
      },
    });

    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        value: {
          app: { isInstalled: false, InstallState: {}, RunningState: {} },
          runtime: {
            PlatformOs: {}, PlatformArch: {}, PlatformNaclArch: {},
            RequestUpdateCheckStatus: {}, OnInstalledReason: {}, OnRestartRequiredReason: {},
          },
          loadTimes: function() {},
          csi: function() { return { startE: Date.now(), onloadT: Date.now(), pageT: 1, tran: 15 }; },
        },
        configurable: true,
        writable: true,
      });
    }

    const props = [
      '__webdriver_evaluate', '__selenium_evaluate', '__fxdriver_evaluate',
      '__driver_unwrapped', '__webdriver_unwrapped', '__selenium_unwrapped',
      '__fxdriver_unwrapped', '__webdriver_script_fn', '__webdriver_script_func',
      '__webdriver_script_function', '__driver_evaluate', '__selenium_web_driver',
      'domAutomation', 'domAutomationController',
    ];
    for (const p of props) {
      try { delete window[p]; } catch {}
    }

    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

    if (navigator.permissions) {
      const originalQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (params) => {
        if (params.name === 'notifications') {
          return Promise.resolve({ state: 'default', name: 'notifications' });
        }
        return originalQuery(params);
      };
    }
  })();
`;

export const STEALTH_LAUNCH_ARGS: string[] = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-infobars',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
  '--window-size=1440,960',
  '--lang=en-US',
];

function chromeUa(version?: string): string {
  const normalized = /^\d+(\.\d+){1,3}$/.test(version ?? '') ? version! : '137.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${normalized} Safari/537.36`;
}

export function stealthContext(browserVersion?: string): Parameters<import('playwright').Browser['newContext']>[0] {
  return {
    userAgent: chromeUa(browserVersion),
    viewport: { width: 1440, height: 960 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  };
}

export async function applyStealth(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(STEALTH_INIT_SCRIPT);
}

export function stealthLaunchOptions(headless = true, useProxy = true): LaunchOptions {
  const envHeadless = process.env.PLAYWRIGHT_HEADLESS?.trim().toLowerCase();
  if (envHeadless === '0' || envHeadless === 'false' || envHeadless === 'no') headless = false;
  if (envHeadless === '1' || envHeadless === 'true' || envHeadless === 'yes') headless = true;
  const opts: LaunchOptions = { headless, args: STEALTH_LAUNCH_ARGS };
  const channel = process.env.PLAYWRIGHT_BROWSER_CHANNEL?.trim();
  if (channel) opts.channel = channel;
  const server = useProxy ? process.env.PLAYWRIGHT_PROXY_SERVER?.trim() : undefined;
  if (server) {
    opts.proxy = {
      server,
      username: process.env.PLAYWRIGHT_PROXY_USERNAME?.trim() || undefined,
      password: process.env.PLAYWRIGHT_PROXY_PASSWORD?.trim() || undefined,
    };
    console.log(`[stealth] routing Playwright through proxy ${server.replace(/\/\/.*@/, '//')}`);
  }
  return opts;
}