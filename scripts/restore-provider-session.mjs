import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { reconstructProviderSession } from './provider-session.mjs';

const provider = process.argv[2]?.trim();
const directory = resolve(process.argv[3] ?? '/tmp/playwright_sessions');
const debugDirectory = resolve(process.env.PLAYWRIGHT_DEBUG_DIR ?? '/tmp/playwright_debug');
let safeResult = { provider, status: 'failed', representation: null, reason: 'selected_provider_session_restore_failed' };
try {
  const restored = reconstructProviderSession(provider, process.env);
  await mkdir(directory, { recursive: true });
  const target = resolve(directory, restored.filename);
  if (!target.startsWith(`${directory}\\`) && !target.startsWith(`${directory}/`)) throw new Error('session_target_invalid');
  await writeFile(target, restored.bytes, { flag: 'wx', mode: 0o600 });
  await chmod(target, 0o600);
  safeResult = { provider, status: 'restored', representation: restored.representation, reason: null };
  process.stdout.write(`selected_provider_session_restored:${provider}:${restored.representation}\n`);
} catch (error) {
  safeResult.reason = error instanceof Error ? error.message : 'selected_provider_session_restore_failed';
  process.stderr.write(`${safeResult.reason}\n`);
  process.exitCode = 1;
} finally {
  await mkdir(debugDirectory, { recursive: true });
  await writeFile(resolve(debugDirectory, 'session-restore-result.json'), `${JSON.stringify(safeResult, null, 2)}\n`, { flag: 'w', mode: 0o600 });
}
