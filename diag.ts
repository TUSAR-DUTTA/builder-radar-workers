import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const sessionFile = path.join(process.cwd(), 'playwright_sessions', 'chatgpt_auth_state.json');
const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
console.log('✔ Session file loaded. Cookie count:', session.cookies.length);
console.log('✔ Auth cookie present:', session.cookies.some((c: any) => c.name.includes('session-token')));

(async () => {
  const { chromium } = await import('playwright');

  // ---- TEST 1: plain newContext with storageState file path ----
  console.log('\n--- TEST 1: newContext + storageState file path ---');
  {
    const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--no-first-run'] });
    const ctx = await browser.newContext({ storageState: sessionFile });
    const cookies = await ctx.cookies('https://chatgpt.com/');
    const hasAuth = cookies.some(c => c.name.includes('session-token'));
    console.log('Cookies in context:', cookies.length, '| Has auth cookie:', hasAuth);
    const page = await ctx.newPage();
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);
    const loggedIn = await page.locator('text="Log in"').isVisible().catch(() => false);
    console.log('Shows "Log in" button:', loggedIn, '| URL:', page.url());
    await browser.close();
  }

  // ---- TEST 2: persistent context + storageState file path ----
  console.log('\n--- TEST 2: launchPersistentContext + storageState file path ---');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-diag-'));
    const ctx = await chromium.launchPersistentContext(tmpDir, {
      headless: false,
      args: ['--no-sandbox', '--no-first-run'],
      storageState: sessionFile,
    });
    const cookies = await ctx.cookies('https://chatgpt.com/');
    const hasAuth = cookies.some(c => c.name.includes('session-token'));
    console.log('Cookies in context:', cookies.length, '| Has auth cookie:', hasAuth);
    const page = await ctx.newPage();
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);
    const loggedIn = await page.locator('text="Log in"').isVisible().catch(() => false);
    console.log('Shows "Log in" button:', loggedIn, '| URL:', page.url());
    await ctx.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ---- TEST 3: persistent context + addCookies after launch ----
  console.log('\n--- TEST 3: launchPersistentContext + addCookies after launch ---');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-diag2-'));
    const ctx = await chromium.launchPersistentContext(tmpDir, {
      headless: false,
      args: ['--no-sandbox', '--no-first-run'],
    });
    await ctx.addCookies(session.cookies);
    const cookies = await ctx.cookies('https://chatgpt.com/');
    const hasAuth = cookies.some(c => c.name.includes('session-token'));
    console.log('Cookies in context:', cookies.length, '| Has auth cookie:', hasAuth);
    const page = await ctx.newPage();
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);
    const loggedIn = await page.locator('text="Log in"').isVisible().catch(() => false);
    console.log('Shows "Log in" button:', loggedIn, '| URL:', page.url());
    await ctx.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  process.exit(0);
})();
