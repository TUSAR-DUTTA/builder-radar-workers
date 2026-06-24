import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';

const sessionsDir = path.join(process.cwd(), 'playwright_sessions');
const screenshotsDir = path.join(process.cwd(), 'playwright_screenshots');

if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

async function runCleanTest(model: string, url: string, composerSelector: string, submitAction: (page: any) => Promise<void>, checkResponse: (page: any) => Promise<boolean>) {
  console.log(`\n========================================`);
  console.log(`RUNNING PLAIN TEST FOR: ${model}`);
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
    console.log(`Navigating...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    
    console.log('Waiting 6 seconds for page to settle and bypass any redirects...');
    await page.waitForTimeout(6000);

    const currentUrl = page.url();
    console.log(`Current URL: ${currentUrl}`);

    const composer = page.locator(composerSelector).first();
    const isComposerVisible = await composer.isVisible().catch(() => false);
    console.log(`Composer visible: ${isComposerVisible}`);

    if (!isComposerVisible) {
      console.log(`❌ FAILED: Composer not found. Capture debug screenshot.`);
      await page.screenshot({ path: path.join(screenshotsDir, `${model.toLowerCase()}-failed.png`), fullPage: true });
      return;
    }

    console.log(`✔ Logged in successfully! Submitting prompt...`);
    await composer.click({ force: true });
    await page.keyboard.insertText('What is 2+2?');
    await page.waitForTimeout(1000);
    await submitAction(page);

    console.log(`Prompt sent. Waiting up to 60 seconds for response...`);
    let answered = false;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(2000);
      if (await checkResponse(page)) {
        answered = true;
        break;
      }
    }

    await page.screenshot({ path: path.join(screenshotsDir, `${model.toLowerCase()}-success.png`), fullPage: true });

    if (answered) {
      console.log(`✅ SUCCESS: ${model} replied successfully!`);
    } else {
      console.log(`❌ FAILED: Timeout waiting for response.`);
    }

  } catch (err: any) {
    console.error(`❌ ERROR:`, err.message);
  } finally {
    await browser.close().catch(() => {});
  }
}

(async () => {
  // 1. Claude
  await runCleanTest(
    'Claude',
    'https://claude.ai/new',
    '[contenteditable="true"][aria-label], [contenteditable="true"].ProseMirror, textarea, #prompt-textarea',
    async (page) => {
      // Find and click the send button on Claude
      const sendButton = page.locator('button[aria-label="Send Message"], button:has-text("Send"), button[class*="send"]').first();
      if (await sendButton.isVisible()) {
        await sendButton.click({ force: true });
      } else {
        await page.keyboard.press('Enter');
      }
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

  // 2. Perplexity
  await runCleanTest(
    'Perplexity',
    'https://www.perplexity.ai/',
    '#ask-input, textarea, [contenteditable="true"], [placeholder*="Ask"]',
    async (page) => {
      const sendButton = page.locator('button[aria-label="Submit"], button[class*="submit"], button:has(svg)').first();
      if (await sendButton.isVisible() && !(await sendButton.isDisabled())) {
        await sendButton.click({ force: true });
      } else {
        await page.keyboard.press('Enter');
      }
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

  console.log('\nAll tests finished.');
})();
