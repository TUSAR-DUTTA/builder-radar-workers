import { scrapeDeepseekPrompt } from './src/workers/lib/playwright/deepseek';
(async () => {
  try {
    console.log('Testing DeepSeek...');
    const result = await scrapeDeepseekPrompt('What is 2+2?');
    console.log(result);
  } catch (e) {
    console.error('ERROR:', e);
  }
  process.exit(0);
})();
