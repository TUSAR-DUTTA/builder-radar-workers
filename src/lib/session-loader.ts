import * as fs from 'fs';
import * as path from 'path';

const SESSIONS = [
  { envKey: 'CHATGPT_SESSION_B64', filename: 'chatgpt_auth_state.json', label: 'ChatGPT' },
  { envKey: 'CLAUDE_SESSION_B64', filename: 'claude_auth_state.json', label: 'Claude' },
  { envKey: 'PERPLEXITY_SESSION_B64', filename: 'perplexity_auth_state.json', label: 'Perplexity' },
  { envKey: 'COPILOT_SESSION_B64', filename: 'copilot_auth_state.json', label: 'Copilot' },
  { envKey: 'DEEPSEEK_SESSION_B64', filename: 'deepseek_auth_state.json', label: 'DeepSeek' },
  { envKey: 'GROK_SESSION_B64', filename: 'grok_auth_state.json', label: 'xAI Grok' },
  // Google AI Overviews (src/workers/lib/geo-playwright.ts → scrapeGoogleAioPrompt). worker.yml also
  // writes this file directly from GOOGLE_SESSION_B64; this entry materializes it for local runs too.
  { envKey: 'GOOGLE_SESSION_B64', filename: 'google_auth_state.json', label: 'Google AIO' },
  // Social-mention scraper (src/workers/social.ts): Reddit is optional (anonymous works locally,
  // a session helps from datacenter IPs); X requires a logged-in session or it no-ops.
  { envKey: 'REDDIT_SESSION_B64', filename: 'reddit_auth_state.json', label: 'Reddit' },
  { envKey: 'X_SESSION_B64', filename: 'x_auth_state.json', label: 'X' },
];

export function getSessionsDir(): string {
  return process.env.PLAYWRIGHT_SESSIONS_DIR ?? path.join(process.cwd(), 'playwright_sessions');
}

export function loadSessionsFromEnv(): void {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let loaded = 0;
  let reused = 0;
  for (const { envKey, filename, label } of SESSIONS) {
    const target = path.join(dir, filename);
    const preferExistingFile = process.env.PLAYWRIGHT_PREFER_EXISTING_SESSION_FILE !== '0';
    if (preferExistingFile && fs.existsSync(target) && fs.statSync(target).size > 0) {
      console.log(`[session-loader] Using existing ${label} session file at ${target}`);
      reused++;
      continue;
    }

    const b64 = process.env[envKey]?.trim();
    if (!b64) continue;
    try {
      const buffer = Buffer.from(b64, 'base64');
      let json = '';
      try {
        json = require('zlib').unzipSync(buffer).toString('utf-8');
      } catch (e) {
        json = buffer.toString('utf-8');
      }
      
      JSON.parse(json);
      fs.writeFileSync(target, json, { encoding: 'utf-8' });
      console.log(`[session-loader] ✓ ${label} session loaded from ${envKey}`);
      loaded++;
    } catch (err) {
      console.error(`[session-loader] ✗ ${envKey} decode failed:`, err);
    }
  }

  if (loaded === 0 && reused === 0) {
    console.log('[session-loader] No session env vars set - Playwright will use local files if present');
  }
}
