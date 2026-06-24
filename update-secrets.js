const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

const SESSIONS_DIR = path.join(__dirname, 'playwright_sessions');

const mappings = [
  { file: 'chatgpt_auth_state.json', secret: 'CHATGPT_SESSION_B64', gzSecret: 'CHATGPT_SESSION_GZ_B64' },
  { file: 'claude_auth_state.json', secret: 'CLAUDE_SESSION_B64', gzSecret: 'CLAUDE_SESSION_GZ_B64' },
  { file: 'perplexity_auth_state.json', secret: 'PERPLEXITY_SESSION_B64', gzSecret: 'PERPLEXITY_SESSION_GZ_B64' },
  { file: 'deepseek_auth_state.json', secret: 'DEEPSEEK_SESSION_B64' },
  { file: 'grok_auth_state.json', secret: 'GROK_SESSION_B64' },
  { file: 'google_auth_state.json', secret: 'GOOGLE_SESSION_B64' },
  { file: 'reddit_auth_state.json', secret: 'REDDIT_SESSION_B64' },
  { file: 'x_auth_state.json', secret: 'X_SESSION_B64' }
];

for (const { file, secret, gzSecret } of mappings) {
  const filePath = path.join(SESSIONS_DIR, file);
  if (!fs.existsSync(filePath)) {
    console.log(`Skipping ${file}: Local file not found.`);
    continue;
  }

  const content = fs.readFileSync(filePath);
  const base64Content = content.toString('base64');

  console.log(`Uploading ${secret} for ${file}...`);
  try {
    execSync(`gh secret set ${secret}`, { input: base64Content });
    console.log(`  Successfully set ${secret}`);
  } catch (err) {
    console.error(`  Failed to set ${secret}:`, err.message);
  }

  if (gzSecret) {
    console.log(`Compressing and uploading ${gzSecret}...`);
    try {
      const gzipped = zlib.gzipSync(content);
      const gzBase64 = gzipped.toString('base64');
      execSync(`gh secret set ${gzSecret}`, { input: gzBase64 });
      console.log(`  Successfully set ${gzSecret}`);
    } catch (err) {
      console.error(`  Failed to set ${gzSecret}:`, err.message);
    }
  }
}

console.log('\nAll secrets set successfully!');
