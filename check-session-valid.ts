import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';

(async () => {
  const sessionPath = path.join(process.cwd(), 'playwright_sessions', 'chatgpt_auth_state.json');
  console.log('Loading ChatGPT session...');
  
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: sessionPath });
  const page = await context.newPage();

  try {
    console.log('Navigating directly to backend-api/me...');
    const response = await page.goto('https://chatgpt.com/backend-api/me', { waitUntil: 'networkidle', timeout: 30000 });
    
    if (response) {
      console.log(`Response Status: ${response.status()}`);
      console.log(`Response Headers:`, JSON.stringify(response.headers(), null, 2));
      const body = await response.text();
      console.log(`Response Body (first 1000 chars):`, body.slice(0, 1000));
    } else {
      console.log('No response received.');
    }
  } catch (err: any) {
    console.error('Error:', err.message);
  } finally {
    await browser.close();
  }
})();
