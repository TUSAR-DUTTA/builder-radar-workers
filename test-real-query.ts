import * as fs from 'fs';
import * as path from 'path';
import { launchSeededContext } from './src/workers/lib/playwright/shared';

const screenshotsDir = path.join(process.cwd(), 'playwright_screenshots');

async function testRealQueryClaude(prompt: string) {
  console.log(`\n========================================`);
  console.log(`CLAUDE: Submitting real query: "${prompt}"`);
  console.log(`========================================`);

  const runtime = await launchSeededContext('claude');
  const page = await runtime.context.newPage();

  try {
    await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded', timeout: 45000 });
    
    // Wait for the cookie acceptance popup if any, or wait for the page to settle
    await page.waitForTimeout(6000);

    // Accept cookies if visible
    await page.locator('button:has-text("Accept All Cookies")').click({ timeout: 2000 }).catch(() => {});

    const composerSelector = '[contenteditable="true"][aria-label], [contenteditable="true"].ProseMirror, textarea, #prompt-textarea';
    await page.waitForSelector(composerSelector, { state: 'visible', timeout: 30000 });
    const composer = page.locator(composerSelector).first();
    
    await composer.click({ force: true });
    await page.keyboard.insertText(prompt);
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');

    console.log('Query sent. Waiting for response to stream and complete (up to 45 seconds)...');
    
    // Wait for streaming to finish (ProseMirror response container stops having data-is-streaming)
    await page.waitForFunction(() => {
      const responseEls = document.querySelectorAll('.font-claude-response, .prose, [class*="response"]');
      if (responseEls.length === 0) return false;
      const last = responseEls[responseEls.length - 1];
      return last.getAttribute('data-is-streaming') !== 'true' && (last.textContent || '').trim().length > 50;
    }, { timeout: 45000 }).catch(() => {
      console.log('Timeout waiting for streaming to end. Proceeding to extract text.');
    });

    await page.waitForTimeout(2000);

    const data = await page.evaluate(() => {
      const responseEls = Array.from(document.querySelectorAll('.font-claude-response, .prose, [class*="response"]'));
      const last = responseEls.at(-1) || document.body;
      const text = (last.textContent ?? '').replace(/\s+/g, ' ').trim();
      const links = Array.from(last.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .map((a) => ({ url: a.href, title: (a.textContent ?? '').trim() || undefined }))
        .filter((a) => /^https?:\/\//i.test(a.url) && !a.url.includes('claude.ai'))
        .slice(0, 10);
      return { text, links };
    });

    console.log(`✅ CLAUDE RESPONSE SUCCESS!`);
    console.log(`Text Length: ${data.text.length}`);
    console.log(`Snippet: ${data.text.slice(0, 400)}...`);
    console.log(`Citations Found: ${data.links.length}`);
    data.links.forEach((link, idx) => {
      console.log(`  [${idx + 1}] ${link.title || 'Link'}: ${link.url}`);
    });

    await page.screenshot({ path: path.join(screenshotsDir, 'claude-real-success.png'), fullPage: true });

  } catch (err: any) {
    console.error(`❌ CLAUDE TEST ERROR:`, err.message);
    await page.screenshot({ path: path.join(screenshotsDir, 'claude-real-failed.png'), fullPage: true });
  } finally {
    await runtime.close();
  }
}

async function testRealQueryPerplexity(prompt: string) {
  console.log(`\n========================================`);
  console.log(`PERPLEXITY: Submitting real query: "${prompt}"`);
  console.log(`========================================`);

  const runtime = await launchSeededContext('perplexity');
  const page = await runtime.context.newPage();

  try {
    await page.goto('https://www.perplexity.ai/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(6000);

    const composerSelector = '#ask-input, textarea, [contenteditable="true"], [placeholder*="Ask"]';
    await page.waitForSelector(composerSelector, { state: 'visible', timeout: 30000 });
    const composer = page.locator(composerSelector).first();

    await composer.click({ force: true });
    await page.keyboard.insertText(prompt);
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');

    console.log('Query sent. Waiting for response to complete (up to 45 seconds)...');

    // Wait for the answer box to appear and settle
    await page.waitForFunction(() => {
      const answers = document.querySelectorAll('.prose, div[dir="auto"], [data-testid="answer-text"]');
      if (answers.length === 0) return false;
      const last = answers[answers.length - 1];
      const text = (last.textContent || '').trim();
      return text.length > 50;
    }, { timeout: 45000 }).catch(() => {});

    await page.waitForTimeout(5000); // Give extra time to ensure streaming is completely done

    const data = await page.evaluate(() => {
      const answers = Array.from(document.querySelectorAll('.prose, div[dir="auto"], [data-testid="answer-text"]'));
      const last = answers.at(-1) || document.body;
      const text = (last.textContent ?? '').replace(/\s+/g, ' ').trim();
      const links = Array.from(last.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .map((a) => ({ url: a.href, title: (a.textContent ?? '').trim() || undefined }))
        .filter((a) => /^https?:\/\//i.test(a.url) && !a.url.includes('perplexity.ai'))
        .slice(0, 10);
      return { text, links };
    });

    console.log(`✅ PERPLEXITY RESPONSE SUCCESS!`);
    console.log(`Text Length: ${data.text.length}`);
    console.log(`Snippet: ${data.text.slice(0, 400)}...`);
    console.log(`Citations Found: ${data.links.length}`);
    data.links.forEach((link, idx) => {
      console.log(`  [${idx + 1}] ${link.title || 'Link'}: ${link.url}`);
    });

    await page.screenshot({ path: path.join(screenshotsDir, 'perplexity-real-success.png'), fullPage: true });

  } catch (err: any) {
    console.error(`❌ PERPLEXITY TEST ERROR:`, err.message);
    await page.screenshot({ path: path.join(screenshotsDir, 'perplexity-real-failed.png'), fullPage: true });
  } finally {
    await runtime.close();
  }
}

(async () => {
  // Use local headed browser, no proxy, no stealth
  process.env.PLAYWRIGHT_HEADLESS = '0';
  process.env.PLAYWRIGHT_NO_STEALTH = '1';
  delete process.env.PLAYWRIGHT_PROXY_SERVER;

  const prompt = 'What are the top 3 best AI sales intelligence tools?';
  
  await testRealQueryClaude(prompt);
  await testRealQueryPerplexity(prompt);

  console.log('\nAll real query tests finished.');
})();
