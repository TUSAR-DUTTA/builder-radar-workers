import { config } from 'dotenv';
config({ path: '.env.local' });
import { loadSessionsFromEnv } from './src/lib/session-loader';
import { getAIRouter } from './src/lib/ai-router';
import { runPromptViaPlaywright, closeSharedBrowser } from './src/workers/lib/geo-playwright';

async function main() {
  loadSessionsFromEnv();
  const router = getAIRouter();
  
  const prompts = [
    'What is 2+2?',
    'What is the capital of France?',
  ];

  for (const prompt of prompts) {
    console.log(`\n=== Testing prompt: "${prompt}" ===`);
    
    // console.log('\nTesting Perplexity...');
    // const resP = await runPromptViaPlaywright(router, prompt, ['Test Entity'], ['perplexity']);
    // console.log(JSON.stringify(resP, null, 2));

    // console.log('\nTesting Claude...');
    // const resC = await runPromptViaPlaywright(router, prompt, ['Test Entity'], ['claude']);
    // console.log(JSON.stringify(resC, null, 2));

    console.log('\nTesting ChatGPT...');
    const resG = await runPromptViaPlaywright(router, prompt, ['Test Entity'], ['openai-search']);
    console.log(JSON.stringify(resG, null, 2));
  }

  await closeSharedBrowser();
}

main().catch(console.error);
