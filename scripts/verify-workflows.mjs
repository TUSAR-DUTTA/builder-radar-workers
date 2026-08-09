import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { load: parseYaml } = require('js-yaml');

const engines = ['chatgpt', 'claude', 'perplexity', 'grok', 'google-aio'];
const providerWorkflows = engines.flatMap((engine) => [
  `.github/workflows/test-worker-${engine}.yml`,
  `.github/workflows/worker-${engine}.yml`,
]);
const allWorkflows = [
  '.github/workflows/ci.yml', '.github/workflows/social-worker.yml', '.github/workflows/test-single-prompt-all.yml',
  '.github/workflows/_consumer-canary.yml', '.github/workflows/diagnose-perplexity-structure.yml', ...providerWorkflows,
];
const failures = [];
for (const file of allWorkflows) {
  const text = readFileSync(file, 'utf8');
  try { parseYaml(text); } catch (error) { failures.push(`${file}: invalid YAML: ${error.message}`); }
  if (/PRIVATE_INGESTION_COMMIT\s*\|\||ref:\s*main\b/.test(text)) failures.push(`${file}: private checkout fallback`);
}

const action = readFileSync('.github/actions/stage-private-runtime/action.yml', 'utf8');
try { parseYaml(action); } catch (error) { failures.push(`stage-private-runtime action invalid YAML: ${error.message}`); }
for (const requirement of [
  /\^\[0-9a-fA-F\]\{40\}\$/,
  /GITHUB_SHA/,
  /ref:\s*\$\{\{ inputs\.private_commit \}\}/,
  /git -C _core rev-parse HEAD/,
  /test "\$actual" = "\$EXPECTED_PRIVATE_SHA"/,
  /persist-credentials:\s*false/,
]) {
  if (!requirement.test(action)) failures.push(`stage-private-runtime action missing ${requirement}`);
}

const reusable = readFileSync('.github/workflows/_consumer-canary.yml', 'utf8');
for (const requirement of [
  /PRIVATE_INGESTION_COMMIT:\s*\$\{\{ vars\.PRIVATE_INGESTION_COMMIT \}\}/,
  /\.github\/actions\/stage-private-runtime/,
  /SCRAPE_PROJECT_ID:/,
  /SCRAPE_PROMPT_ID:/,
  /SCRAPE_SOURCES:/,
  /EVIDENCE_CANARY:/,
  /upload-artifact@v4/,
  /retention-days:\s*3/,
  /timeout-minutes:\s*60/,
]) {
  if (!requirement.test(reusable)) failures.push(`reusable consumer workflow missing ${requirement}`);
}

for (const file of providerWorkflows) {
  const text = readFileSync(file, 'utf8');
  if (!/_consumer-canary\.yml/.test(text)) failures.push(`${file}: does not use runtime-gated reusable workflow`);
  if (!/project_id:[\s\S]*?required:\s*true/.test(text)) failures.push(`${file}: workflow_dispatch project_id is not required`);
  if (!/prompt_id:[\s\S]*?required:\s*true/.test(text)) failures.push(`${file}: workflow_dispatch prompt_id is not required`);
}

for (const file of ['.github/workflows/ci.yml', '.github/workflows/social-worker.yml']) {
  const text = readFileSync(file, 'utf8');
  if (!/PRIVATE_INGESTION_COMMIT/.test(text) || !/stage-private-runtime/.test(text)) {
    failures.push(`${file}: missing fail-closed private runtime gate`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Validated ${allWorkflows.length} workflows and the exact-SHA staging action.`);
