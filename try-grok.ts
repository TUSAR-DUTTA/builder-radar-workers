import { loadSessionsFromEnv } from './src/lib/session-loader';
loadSessionsFromEnv();
import { scrapeGrokPrompt } from './src/workers/lib/playwright/grok';
(async () => {
  try {
    console.log('Testing Grok...');
    const result = await scrapeGrokPrompt('What is 2+2?');
    console.log(result);
  } catch (e) {
    console.error('ERROR:', e);
  }
  process.exit(0);
})();
