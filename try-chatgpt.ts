import { scrapeChatGPTPrompt } from './src/workers/lib/playwright/chatgpt';
(async () => {
  try {
    console.log('Testing ChatGPT...');
    const result = await scrapeChatGPTPrompt('What is 2+2?');
    console.log(result);
  } catch (e) {
    console.error('ERROR:', e);
  }
  process.exit(0);
})();
