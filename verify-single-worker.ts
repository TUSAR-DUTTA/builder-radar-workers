import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import path from 'path';
process.env.PLAYWRIGHT_SESSIONS_DIR = path.resolve(__dirname, 'playwright_sessions');
import { loadSessionsFromEnv } from './src/lib/session-loader';

import { scrapeChatGPTPrompt, sharedChatGPTBrowser } from './src/workers/lib/playwright/chatgpt';
import { scrapeClaudePrompt, sharedClaudeBrowser } from './src/workers/lib/playwright/claude';
import { scrapeGrokPrompt, sharedGrokBrowser } from './src/workers/lib/playwright/grok';
import { scrapePerplexityPrompt, sharedPerplexityBrowser } from './src/workers/lib/playwright/perplexity';
import { scrapeGoogleAioPrompt, sharedGoogleAioBrowser } from './src/workers/lib/playwright/google-aio';
import { closeSharedBrowser } from './src/workers/lib/geo-playwright';

async function main() {
  loadSessionsFromEnv();
  
  const worker = process.env.TEST_WORKER || 'chatgpt';
  const prompt = process.env.TEST_PROMPT || 'What is the capital of France? Answer with one sentence.';
  
  console.log(`\n\n--- Testing ${worker} on GitHub Actions ---`);
  
  let fn: any;
  let browserVar: () => any;
  
  switch (worker) {
    case 'chatgpt':
      fn = scrapeChatGPTPrompt;
      browserVar = () => sharedChatGPTBrowser;
      break;
    case 'claude':
      fn = scrapeClaudePrompt;
      browserVar = () => sharedClaudeBrowser;
      break;
    case 'grok':
      fn = scrapeGrokPrompt;
      browserVar = () => sharedGrokBrowser;
      break;
    case 'perplexity':
      fn = scrapePerplexityPrompt;
      browserVar = () => sharedPerplexityBrowser;
      break;
    case 'google-aio':
      fn = scrapeGoogleAioPrompt;
      browserVar = () => sharedGoogleAioBrowser;
      break;
    default:
      console.error(`Unknown worker: ${worker}`);
      process.exit(1);
  }
  
  try {
    const res = await fn(prompt);
    console.log(`✅ ${worker} Output:`, res.rawAnswer.substring(0, 500));
    console.log(`✅ ${worker} Citations:`, res.citations.length);
  } catch (err: any) {
    console.log(`❌ ${worker} Failed:`, err?.message || err);
  } finally {
    await closeSharedBrowser();
  }
}

main().catch(console.error);
