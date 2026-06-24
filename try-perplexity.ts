import * as dotenv from 'dotenv';
dotenv.config();
import { scrapePerplexityPrompt } from './src/workers/lib/playwright/perplexity';


async function main() {
  process.env.PLAYWRIGHT_HEADLESS = '1';
  process.env.PLAYWRIGHT_DEBUG_DIR = './playwright_debug';
  
  
  console.log(`Testing Perplexity...`);
  try {
    const res = await scrapePerplexityPrompt('What is 2+2?');
    console.log(`SUCCESS! Output length: ${res.text?.length}`);
  } catch (err) {
    console.error(`FAILED:`, (err as Error).message);
  }
  process.exit(0);
}

main();
