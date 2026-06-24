import * as dotenv from 'dotenv';
dotenv.config();
import { scrapeChatGPTPrompt } from './src/workers/lib/playwright/chatgpt';
import { scrapeClaudePrompt } from './src/workers/lib/playwright/claude';
import { scrapePerplexityPrompt } from './src/workers/lib/playwright/perplexity';
import { scrapeGoogleAioPrompt } from './src/workers/lib/playwright/google-aio';
import { scrapeDeepseekPrompt } from './src/workers/lib/playwright/deepseek';
import { scrapeGrokPrompt } from './src/workers/lib/playwright/grok';
import { loadSessionsFromEnv } from './src/lib/session-loader';

async function testEngine(name: string, scrapeFn: (prompt: string) => Promise<any>) {
  console.log(`\n========================================`);
  console.log(`Testing ${name}...`);
  console.log(`========================================`);
  try {
    const res = await scrapeFn('What is 2+2?');
    console.log(`[${name}] SUCCESS! Output length: ${res.text?.length}`);
    console.log(`[${name}] Citations count: ${res.citations?.length}`);
    console.log(`[${name}] Snippet: ${res.text?.substring(0, 100)}...`);
  } catch (err) {
    console.error(`[${name}] FAILED:`, (err as Error).message);
  }
}

async function main() {
  process.env.PLAYWRIGHT_HEADLESS = '1';
  loadSessionsFromEnv();
  
  const args = process.argv.slice(2);
  const engines = args.length > 0 ? args : ['chatgpt', 'claude', 'perplexity', 'google-aio', 'deepseek', 'grok'];

  if (engines.includes('chatgpt')) await testEngine('ChatGPT', scrapeChatGPTPrompt);
  if (engines.includes('claude')) await testEngine('Claude', scrapeClaudePrompt);
  if (engines.includes('perplexity')) await testEngine('Perplexity', scrapePerplexityPrompt);
  if (engines.includes('google-aio')) await testEngine('Google AIO', scrapeGoogleAioPrompt);
  if (engines.includes('deepseek')) await testEngine('DeepSeek', scrapeDeepseekPrompt);
  if (engines.includes('grok')) await testEngine('xAI Grok', scrapeGrokPrompt);

  process.exit(0);
}

main();
