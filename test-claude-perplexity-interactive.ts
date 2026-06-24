import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';

const sessionsDir = path.join(process.cwd(), 'playwright_sessions');
const screenshotsDir = path.join(process.cwd(), 'playwright_screenshots');

if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

async function runInteractiveTest(model: string, url: string, composerSelector: string) {
  console.log(`\n========================================`);
  console.log(`RUNNING INTERACTIVE TEST FOR: ${model}`);
  console.log(`URL: ${url}`);
  console.log(`========================================`);

  const sessionPath = path.join(sessionsDir, `${model.toLowerCase()}_auth_state.json`);
  if (!fs.existsSync(sessionPath)) {
    console.error(`❌ Session file not found: ${sessionPath}`);
    return;
  }

  // 100% normal vanilla headed chromium browser — no proxy, no stealth
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--no-first-run']
  });

  try {
    const context = await browser.newContext({
      storageState: sessionPath,
      viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();
    console.log(`Navigating to page...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    
    console.log('Waiting up to 30 seconds for composer to appear (solve Turnstile if prompted)...');
    
    // Dynamically wait for the composer selector to be visible
    let composerVisible = false;
    try {
      await page.waitForSelector(composerSelector, { state: 'visible', timeout: 30000 });
      composerVisible = true;
    } catch (e: any) {
      console.log(`Composer not visible within timeout: ${e.message}`);
    }

    // Take screenshot of landing state
    await page.screenshot({ path: path.join(screenshotsDir, `${model.toLowerCase()}-interactive-landing.png`), fullPage: true });

    if (!composerVisible) {
      console.log(`❌ FAILED: Composer not found. Check playwright_screenshots/${model.toLowerCase()}-interactive-landing.png`);
      return;
    }

    console.log(`✔ Composer is visible. Session is INJECTED successfully!`);
    console.log(`Typing prompt and pressing Enter...`);

    const composer = page.locator(composerSelector).first();
    await composer.click({ force: true });
    await page.keyboard.insertText('What is 2+2?');
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');

    console.log(`Prompt sent. Waiting up to 30 seconds for response...`);
    
    // Wait to let response generate
    await page.waitForTimeout(15000);

    await page.screenshot({ path: path.join(screenshotsDir, `${model.toLowerCase()}-interactive-response.png`), fullPage: true });
    console.log(`📸 Screenshot of response saved: playwright_screenshots/${model.toLowerCase()}-interactive-response.png`);
    console.log(`✅ SUCCESS: Completed test for ${model}`);

  } catch (err: any) {
    console.error(`❌ ERROR:`, err.message);
  } finally {
    await browser.close().catch(() => {});
  }
}

(async () => {
  // 1. Claude
  await runInteractiveTest(
    'Claude',
    'https://claude.ai/new',
    '[contenteditable="true"][aria-label], [contenteditable="true"].ProseMirror, textarea, #prompt-textarea'
  );

  // 2. Perplexity
  await runInteractiveTest(
    'Perplexity',
    'https://www.perplexity.ai/',
    '#ask-input, textarea, [contenteditable="true"], [placeholder*="Ask"]'
  );

  console.log('\nAll tests finished.');
})();
