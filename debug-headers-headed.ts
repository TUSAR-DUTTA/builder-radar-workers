import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';

(async () => {
  const sessionPath = path.join(process.cwd(), 'playwright_sessions', 'chatgpt_auth_state.json');
  console.log('Loading session...');
  
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: sessionPath });
  const page = await context.newPage();

  page.on('request', req => {
    if (req.url() === 'https://chatgpt.com/' || req.url().includes('/backend-api/')) {
      console.log(`[Request] ${req.method()} ${req.url()}`);
    }
  });

  page.on('response', res => {
    if (res.url() === 'https://chatgpt.com/' || res.url().includes('/backend-api/')) {
      console.log(`[Response] ${res.status()} ${res.url()}`);
    }
  });

  try {
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
  } catch (err: any) {
    console.error('Error:', err.message);
  } finally {
    await browser.close();
  }
})();
