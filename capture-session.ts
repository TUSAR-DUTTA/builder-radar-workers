import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { chromium } from 'playwright';

const sessionsDir = path.join(process.cwd(), 'playwright_sessions');
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

const MODEL_CONFIGS: Record<string, { url: string; file: string }> = {
  chatgpt: { url: 'https://chatgpt.com/', file: 'chatgpt_auth_state.json' },
  claude: { url: 'https://claude.ai/new', file: 'claude_auth_state.json' },
  perplexity: { url: 'https://www.perplexity.ai/', file: 'perplexity_auth_state.json' },
  grok: { url: 'https://grok.com/', file: 'grok_auth_state.json' },
};

function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans);
  }));
}

(async () => {
  const arg = process.argv[2]?.toLowerCase().trim();
  if (!arg || !MODEL_CONFIGS[arg]) {
    console.log('Usage: npx tsx capture-session.ts [chatgpt|claude|perplexity|grok]');
    process.exit(1);
  }

  const { url, file } = MODEL_CONFIGS[arg];
  const savePath = path.join(sessionsDir, file);

  console.log(`\n==================================================`);
  console.log(`CAPTURING SESSION FOR: ${arg.toUpperCase()}`);
  console.log(`URL to open: ${url}`);
  console.log(`Will save to: ${savePath}`);
  console.log(`==================================================\n`);

  console.log('Launching browser. Please wait...');
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--no-first-run']
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();
  await page.goto(url);

  console.log('\n👉 ACTION REQUIRED:');
  console.log('1. A browser window has opened.');
  console.log('2. Manually log in to your account in that window.');
  console.log('3. Once you are successfully logged in and can see the chat interface...');
  console.log('4. Come back to this terminal and press ENTER to save the session.');

  await askQuestion('\nPress [ENTER] here once you are logged in successfully: ');

  console.log('\nSaving session state...');
  const storageState = await context.storageState();
  fs.writeFileSync(savePath, JSON.stringify(storageState, null, 2), 'utf-8');

  console.log(`\n✅ SUCCESS: Session saved successfully!`);
  console.log(`File: ${savePath}`);
  console.log(`Cookie count: ${storageState.cookies.length}`);
  console.log(`Local storage origins: ${storageState.origins.length}`);

  await browser.close();
  process.exit(0);
})();
