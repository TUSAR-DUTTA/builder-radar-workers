import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

// Point sessions to local playwright_sessions dir
process.env.PLAYWRIGHT_SESSIONS_DIR = path.join(__dirname, 'playwright_sessions');
// Show browser window so we can see what's happening
process.env.PLAYWRIGHT_HEADLESS = '0';
// No proxy — testing on residential/local IP
delete process.env.PLAYWRIGHT_PROXY_SERVER;

const TEST_PROMPT = 'What are the top 3 best AI sales intelligence tools?';

async function test(name: string, fn: () => Promise<{ text: string; citations: any[] }>) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TESTING: ${name}`);
  console.log('='.repeat(60));
  try {
    const res = await fn();
    console.log(`✅ SUCCESS`);
    console.log(`Text (first 300 chars): ${res.text.slice(0, 300)}`);
    console.log(`Citations: ${res.citations.length}`);
  } catch (err: any) {
    console.log(`❌ FAILED: ${err.message}`);
  }
}

(async () => {
  const { scrapeChatGPTPrompt } = await import('./src/workers/lib/playwright/chatgpt');
  const { scrapeClaudePrompt } = await import('./src/workers/lib/playwright/claude');
  const { scrapePerplexityPrompt } = await import('./src/workers/lib/playwright/perplexity');
  const { scrapeGrokPrompt } = await import('./src/workers/lib/playwright/grok');

  await test('ChatGPT', () => scrapeChatGPTPrompt(TEST_PROMPT));
  await test('Claude', () => scrapeClaudePrompt(TEST_PROMPT));
  await test('Perplexity', () => scrapePerplexityPrompt(TEST_PROMPT));
  await test('Grok', () => scrapeGrokPrompt(TEST_PROMPT));

  process.exit(0);
})();
