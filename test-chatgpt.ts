import * as dotenv from 'dotenv';
dotenv.config();

import { scrapeChatGPTPrompt } from './src/workers/lib/playwright/chatgpt';

(async () => {
  try {
    console.log('Testing ChatGPT...');
    const result = await scrapeChatGPTPrompt('What is 2+2?');
    console.log('Test Result:', result);
  } catch (e) {
    console.error('ERROR:', e);
  }
  process.exit(0);
})();
