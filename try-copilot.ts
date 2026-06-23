import { scrapeCopilotPrompt } from './src/workers/lib/playwright/copilot';
(async () => {
  try {
    console.log('Testing Copilot...');
    const result = await scrapeCopilotPrompt('What is 2+2?');
    console.log(result);
  } catch (e) {
    console.error('ERROR:', e);
  }
  process.exit(0);
})();
