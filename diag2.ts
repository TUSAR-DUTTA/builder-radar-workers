/**
 * Isolates EXACTLY what the diagnostic proved works vs what the worker does,
 * to find the one flag that breaks authentication.
 */
import * as path from 'path';
const sessionFile = path.join(process.cwd(), 'playwright_sessions', 'chatgpt_auth_state.json');

process.env.PLAYWRIGHT_HEADLESS = '0';
delete process.env.PLAYWRIGHT_PROXY_SERVER;

async function tryLogin(label: string, opts: any) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: false, ...opts.launch });
  const ctx = opts.persistent
    ? await (chromium as any).launchPersistentContext(require('os').tmpdir() + '/br-iso-' + Date.now(), {
        headless: false,
        ...opts.launch,
      })
    : await browser.newContext({ storageState: sessionFile, ...opts.ctx });

  if (!opts.persistent) {
    // addCookies not needed — storageState handles it
  } else {
    const session = require('fs').readFileSync(sessionFile, 'utf8');
    const cookies = JSON.parse(session).cookies;
    await ctx.addCookies(cookies);
  }

  const page = opts.persistent ? await ctx.newPage() : await ctx.newPage();
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  const loggedIn = !(await page.locator('text="Log in"').isVisible().catch(() => true));
  const url = page.url();
  console.log(`[${label}] logged_in=${loggedIn} url=${url}`);
  try { opts.persistent ? await ctx.close() : await browser.close(); } catch {}
}

(async () => {
  // Test 1: newContext, storageState, NO stealth (baseline — known to work)
  await tryLogin('1-newCtx-noStealth', {
    persistent: false,
    launch: { args: ['--no-sandbox', '--no-first-run'] },
    ctx: {},
  });

  // Test 2: newContext, storageState, WITH stealth args
  await tryLogin('2-newCtx-stealthArgs', {
    persistent: false,
    launch: {
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-infobars', '--no-first-run', '--window-size=1440,960', '--lang=en-US',
      ],
    },
    ctx: {},
  });

  // Test 3: newContext, storageState, WITH stealth args + custom userAgent
  await tryLogin('3-newCtx-stealthArgs+UA', {
    persistent: false,
    launch: {
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-infobars', '--no-first-run', '--window-size=1440,960', '--lang=en-US',
      ],
    },
    ctx: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 960 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    },
  });

  // Test 4: persistentContext + addCookies + NO stealth
  await tryLogin('4-persistent-noStealth', {
    persistent: true,
    launch: { args: ['--no-sandbox', '--no-first-run'] },
    ctx: {},
  });

  // Test 5: persistentContext + addCookies + WITH stealth args
  await tryLogin('5-persistent-stealthArgs', {
    persistent: true,
    launch: {
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-infobars', '--no-first-run', '--window-size=1440,960', '--lang=en-US',
      ],
    },
    ctx: {},
  });

  process.exit(0);
})();
