import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { loadSessionsFromEnv } from './src/lib/session-loader';
import { getAIRouter } from './src/lib/ai-router';
import { runPromptViaPlaywright, closeSharedBrowser } from './src/workers/lib/geo-playwright';

async function main() {
  process.env.PLAYWRIGHT_DEBUG_DIR = './playwright_debug';
  process.env.PLAYWRIGHT_HEADLESS = '0';
  process.env.PLAYWRIGHT_PREFER_EXISTING_SESSION_FILE = '0';
  loadSessionsFromEnv();
  const router = getAIRouter();
  console.log('Testing Google AIO...');
  try {
    const res = await runPromptViaPlaywright(router, 'What is the best CRM software?', ['Test Entity'], ['google-aio']);
    console.log(JSON.stringify(res, null, 2));
    console.log("Success! Browser will stay open...");
    await new Promise(() => {}); // Hang
  } catch (err) {
    console.error("Test failed:", err);
    console.log("Browser will stay open so you can inspect it or solve CAPTCHAs!");
    await new Promise(() => {}); // Hang
  }
}

main();
