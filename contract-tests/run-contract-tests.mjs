import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.cwd();
const testRoot = join(root, 'contract-tests');
const tests = readdirSync(testRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
  .map((entry) => relative(root, join(testRoot, entry.name)).split(sep).join('/'))
  .sort();

if (tests.length === 0) throw new Error('No non-Playwright worker contract tests were found.');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
