import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';

(async () => {
  const sessionPath = path.join(process.cwd(), 'playwright_sessions', 'chatgpt_auth_state.json');
  console.log('Loading session...');
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: sessionPath });
  const page = await context.newPage();

  page.on('request', req => {
    if (req.url().includes('chatgpt.com/')) {
      console.log(`[Request] ${req.method()} ${req.url()}`);
      const headers = req.headers();
      console.log(`  Headers:`, JSON.stringify({
        cookie: headers['cookie'] ? `${headers['cookie'].slice(0, 100)}... (length: ${headers['cookie'].length})` : 'MISSING',
        'user-agent': headers['user-agent']
      }, null, 2));
    }
  });

  page.on('response', res => {
    if (res.url().includes('chatgpt.com/')) {
      console.log(`[Response] ${res.status()} ${res.url()}`);
      console.log(`  Headers:`, JSON.stringify(res.headers(), null, 2));
    }
  });

  try {
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
  } catch (err: any) {
    console.error('Error:', err.message);
  } finally {
    await browser.close();
  }
})();
