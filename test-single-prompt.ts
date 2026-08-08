import { runPromptViaPlaywrightDetailed } from './src/workers/lib/geo-playwright';
import { loadSessionsFromEnv } from './src/lib/session-loader';
import { AnswerModel } from './src/lib/geo/types';
import * as dotenv from 'dotenv';
import path from 'path';

// Load .env.local
dotenv.config({ path: path.resolve(__dirname, '.env.local') });
loadSessionsFromEnv();

async function run() {
  const prompt = 'What are the best web form builders like Notion?';
  const models: AnswerModel[] = [
    'chatgpt-consumer',
    'claude',
    'perplexity',
    'google-aio',
    'grok'
  ];

  console.log(`Testing all workers with a single prompt: "${prompt}"\n`);
  
  // Try to test them all concurrently or sequentially.
  // Sequence might be safer for memory/proxy stability.
  for (const model of models) {
    console.log(`\n========================================`);
    console.log(`▶️ RUNNING WORKER: ${model}`);
    console.log(`========================================`);
    try {
      const start = Date.now();
      const results = await runPromptViaPlaywrightDetailed(
        {} as any, // router
        prompt,
        ['Notion'], // entities
        [model], // models
        {
          projectId: 'test-proj-1',
          scanJobId: 'test-job-1',
          scanCellId: 'test-cell-1',
          baselineId: 'test-baseline-1',
          promptId: 'test-prompt-1',
          targetMarket: 'US'
        }
      );
      console.log(`\n✅ Finished ${model} in ${((Date.now() - start)/1000).toFixed(1)}s`);
      console.log(`Results payload:`);
      console.log(JSON.stringify(results.adapterResults[0], null, 2));
    } catch (err) {
      console.error(`\n❌ Fatal error running ${model}:`, err);
    }
  }
  
  console.log(`\nAll single prompt tests completed. Check outputs above.`);
  process.exit(0);
}

run();
