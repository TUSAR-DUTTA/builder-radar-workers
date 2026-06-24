import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';

const sessionsDir = path.join(process.cwd(), 'playwright_sessions');
const screenshotsDir = path.join(process.cwd(), 'playwright_screenshots');

if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

async function runTest(model: string, url: string, composerSelector: string, submitAction?: (page: any) => Promise<void>, checkResponse?: (page: any) => Promise<boolean>) {
  console.log(`\n========================================`);
  console.log(`STARTING TEST: ${model}`);
  console.log(`URL: ${url}`);
  console.log(`========================================`);

  const sessionPath = path.join(sessionsDir, `${model.toLowerCase()}_auth_state.json`);
  if (!fs.existsSync(sessionPath)) {
    console.error(`❌ Session file not found at: ${sessionPath}`);
    return;
  }

  console.log(`✔ Loaded session file: ${sessionPath}`);
  
  // Launch normal headed chromium with absolutely no stealth / proxies
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
    console.log(`Navigating to ${url}...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    
    console.log('Waiting 5 seconds for page to settle...');
    await page.waitForTimeout(5000);

    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => 'No Title');
    console.log(`Current URL: ${currentUrl}`);
    console.log(`Page Title: ${pageTitle}`);

    // Take screenshot of landing state
    const landingScreenshot = path.join(screenshotsDir, `${model.toLowerCase()}-landing.png`);
    await page.screenshot({ path: landingScreenshot, fullPage: true });
    console.log(`📸 Landing screenshot saved: ${landingScreenshot}`);

    // Check if composer is visible
    const composer = page.locator(composerSelector).first();
    const isComposerVisible = await composer.isVisible().catch(() => false);
    console.log(`Composer (${composerSelector}) visible: ${isComposerVisible}`);

    if (!isComposerVisible) {
      console.log(`❌ FAILED: Composer not found. Checking if blocked or showing login...`);
      const bodyText = await page.textContent('body').catch(() => '');
      if (bodyText.includes('Log in') || bodyText.includes('Sign in') || bodyText.includes('Welcome back')) {
        console.log(`❌ Page appears to be logged out (contains login/signin text).`);
      } else if (bodyText.includes('security verification') || bodyText.includes('Verifies you are not a bot')) {
        console.log(`❌ Page is blocked by Cloudflare / Turnstile.`);
      } else {
        console.log(`❌ Unknown failure. Body text length: ${bodyText.length}`);
      }
      return;
    }

    console.log(`✔ Composer is visible. Session seems to be INJECTED successfully!`);

    // Let's run a test prompt if submitAction is defined
    if (submitAction && checkResponse) {
      console.log(`Sending test query: "What is 2+2?"`);
      await composer.click({ force: true });
      await page.keyboard.insertText('What is 2+2?');
      await page.waitForTimeout(1000);
      await submitAction(page);
      console.log(`Query submitted. Waiting for response...`);

      let responseSuccess = false;
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(2000);
        if (await checkResponse(page)) {
          responseSuccess = true;
          break;
        }
      }

      const responseScreenshot = path.join(screenshotsDir, `${model.toLowerCase()}-response.png`);
      await page.screenshot({ path: responseScreenshot, fullPage: true });
      console.log(`📸 Response screenshot saved: ${responseScreenshot}`);

      if (responseSuccess) {
        console.log(`✅ SUCCESS: ${model} replied successfully to prompt!`);
      } else {
        console.log(`❌ FAILED: Did not detect a response from ${model} within timeout.`);
      }
    } else {
      console.log(`✅ Session verified successfully (composer present).`);
    }

  } catch (err: any) {
    console.error(`❌ ERROR during test:`, err.message);
  } finally {
    await browser.close().catch(() => {});
  }
}

(async () => {
  // 1. ChatGPT
  await runTest(
    'ChatGPT',
    'https://chatgpt.com/',
    '#prompt-textarea[role="textbox"], textarea[aria-label="Chat with ChatGPT"], div[contenteditable="true"][aria-label="Chat with ChatGPT"]',
    async (page) => {
      const submitButton = page.locator('#composer-submit-button, button[aria-label="Send prompt"]').first();
      if (await submitButton.isVisible() && !(await submitButton.isDisabled())) {
        await submitButton.click({ force: true });
      } else {
        await page.keyboard.press('Enter');
      }
    },
    async (page) => {
      return page.evaluate(() => {
        const turns = document.querySelectorAll('section[data-testid^="conversation-turn-"][data-turn="assistant"]');
        if (turns.length === 0) return false;
        const last = turns[turns.length - 1];
        const busy = last.querySelector('[aria-busy="true"]');
        if (busy) return false;
        const text = last.textContent || '';
        return text.includes('4') || text.length > 20;
      });
    }
  );

  // 2. Claude
  await runTest(
    'Claude',
    'https://claude.ai/new',
    '[contenteditable="true"][aria-label], [contenteditable="true"].ProseMirror, textarea, #prompt-textarea',
    async (page) => {
      await page.keyboard.press('Enter');
    },
    async (page) => {
      return page.evaluate(() => {
        const responseEls = document.querySelectorAll('.font-claude-response, .prose, [class*="response"]');
        if (responseEls.length === 0) return false;
        const last = responseEls[responseEls.length - 1];
        if (last.getAttribute('data-is-streaming') === 'true') return false;
        const text = last.textContent || '';
        return text.includes('4') || text.length > 20;
      });
    }
  );

  // 3. Perplexity
  await runTest(
    'Perplexity',
    'https://www.perplexity.ai/',
    '#ask-input, textarea, [contenteditable="true"], [placeholder*="Ask"]',
    async (page) => {
      await page.keyboard.press('Enter');
    },
    async (page) => {
      return page.evaluate(() => {
        const answers = document.querySelectorAll('.prose, div[dir="auto"], [data-testid="answer-text"]');
        if (answers.length === 0) return false;
        const last = answers[answers.length - 1];
        const text = last.textContent || '';
        return text.includes('4') || text.length > 20;
      });
    }
  );

  console.log('\n========================================');
  console.log('ALL TESTS COMPLETED');
  console.log('========================================\n');
})();
