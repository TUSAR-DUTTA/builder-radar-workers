import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { reconstructProviderSession } from './provider-session.mjs';
import { assertExactCommitSha } from './validate-runtime-sha.mjs';

const require = createRequire(import.meta.url);
const { load: parseYaml } = require('js-yaml');

const engines = ['chatgpt', 'claude', 'perplexity', 'grok', 'google-aio'];
const providerWorkflows = engines.flatMap((engine) => [
  `.github/workflows/test-worker-${engine}.yml`,
  `.github/workflows/worker-${engine}.yml`,
]);
const allWorkflows = [
  '.github/workflows/ci.yml', '.github/workflows/_compatibility-ci.yml', '.github/workflows/social-worker.yml', '.github/workflows/test-single-prompt-all.yml',
  '.github/workflows/_consumer-canary.yml', '.github/workflows/diagnose-perplexity-structure.yml', ...providerWorkflows,
];
const failures = [];
for (const file of allWorkflows) {
  const text = readFileSync(file, 'utf8');
  try { parseYaml(text); } catch (error) { failures.push(`${file}: invalid YAML: ${error.message}`); }
  if (/PRIVATE_INGESTION_COMMIT\s*\|\||ref:\s*main\b/.test(text)) failures.push(`${file}: private checkout fallback`);
  if (/vars\.PRIVATE_INGESTION_COMMIT/.test(text)) failures.push(`${file}: legacy mutable private SHA variable`);
}

const action = readFileSync('.github/actions/stage-private-runtime/action.yml', 'utf8');
try { parseYaml(action); } catch (error) { failures.push(`stage-private-runtime action invalid YAML: ${error.message}`); }
for (const requirement of [
  /validate-runtime-sha\.mjs "\$EXPECTED_PRIVATE_SHA"/,
  /validate-runtime-sha\.mjs "\$GITHUB_SHA"/,
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
  /private_commit:[\s\S]*?required:\s*true/,
  /PRIVATE_INGESTION_COMMIT:\s*\$\{\{ inputs\.private_commit \}\}/,
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
if (/vars\.PRODUCTION_PRIVATE_INGESTION_COMMIT/.test(reusable)) {
  failures.push('reusable consumer workflow must not depend on the production SHA variable');
}

const liveHarness = readFileSync('.github/workflows/test-single-prompt-all.yml', 'utf8');
for (const requirement of [
  /worker_commit:[\s\S]*?required:\s*true/,
  /canary_private_commit:[\s\S]*?required:\s*true/,
  /prompt:[\s\S]*?required:\s*true/,
  /acceptance_mode:[\s\S]*?expected_answer[\s\S]*?expected_terminal_no_answer[\s\S]*?diagnostic_only/,
  /ref:\s*\$\{\{ inputs\.worker_commit \}\}/,
  /ref:\s*\$\{\{ inputs\.canary_private_commit \}\}/,
  /run-consumer-live-harness\.ts/,
  /if-no-files-found:\s*error/,
  /retention-days:\s*3/,
]) if (!requirement.test(liveHarness)) failures.push(`live A/B harness missing ${requirement}`);
if (/vars\.(?:PRODUCTION_)?PRIVATE_INGESTION_COMMIT/.test(liveHarness)) {
  failures.push('live A/B harness depends on a repository private SHA variable');
}

for (const file of providerWorkflows) {
  const text = readFileSync(file, 'utf8');
  if (!/_consumer-canary\.yml/.test(text)) failures.push(`${file}: does not use runtime-gated reusable workflow`);
  if (!/project_id:[\s\S]*?required:\s*true/.test(text)) failures.push(`${file}: workflow_dispatch project_id is not required`);
  if (!/prompt_id:[\s\S]*?required:\s*true/.test(text)) failures.push(`${file}: workflow_dispatch prompt_id is not required`);
  if (!/canary_private_commit:[\s\S]*?required:\s*true/.test(text)) failures.push(`${file}: explicit canary private SHA is not required`);
  if (/test-worker-/.test(file)) {
    if (!/private_commit:\s*\$\{\{ inputs\.canary_private_commit \}\}/.test(text)) failures.push(`${file}: canary does not use its explicit SHA`);
    if (/PRODUCTION_PRIVATE_INGESTION_COMMIT/.test(text)) failures.push(`${file}: canary depends on the production SHA variable`);
  } else {
    for (const requirement of [
      /production:[\s\S]*?if:\s*github\.event_name != 'workflow_dispatch'/,
      /production:[\s\S]*?private_commit:\s*\$\{\{ vars\.PRODUCTION_PRIVATE_INGESTION_COMMIT \}\}/,
      /canary:[\s\S]*?if:\s*github\.event_name == 'workflow_dispatch'/,
      /canary:[\s\S]*?private_commit:\s*\$\{\{ inputs\.canary_private_commit \}\}/,
    ]) if (!requirement.test(text)) failures.push(`${file}: production/canary SHA isolation missing ${requirement}`);
  }
}

const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
for (const requirement of [
  /canary_private_commit:[\s\S]*?required:\s*true/,
  /production-compatibility:[\s\S]*?if:\s*github\.event_name != 'workflow_dispatch'/,
  /production-compatibility:[\s\S]*?private_commit:\s*\$\{\{ vars\.PRODUCTION_PRIVATE_INGESTION_COMMIT \}\}/,
  /canary-compatibility:[\s\S]*?if:\s*github\.event_name == 'workflow_dispatch'/,
  /canary-compatibility:[\s\S]*?private_commit:\s*\$\{\{ inputs\.canary_private_commit \}\}/,
]) if (!requirement.test(ci)) failures.push(`worker CI production/canary SHA isolation missing ${requirement}`);

const reusableCi = readFileSync('.github/workflows/_compatibility-ci.yml', 'utf8');
if (!/stage-private-runtime/.test(reusableCi) || !/inputs\.private_commit/.test(reusableCi)) {
  failures.push('reusable worker CI is missing its exact private runtime gate');
}
if (/vars\.(?:PRODUCTION_)?PRIVATE_INGESTION_COMMIT/.test(reusableCi)) {
  failures.push('reusable worker CI must not depend on a repository private SHA variable');
}

const social = readFileSync('.github/workflows/social-worker.yml', 'utf8');
if (!/PRODUCTION_PRIVATE_INGESTION_COMMIT/.test(social) || !/stage-private-runtime/.test(social)) {
  failures.push('social-worker workflow is missing its fail-closed production private runtime gate');
}

for (const value of ['main', 'codex/feature', 'v1.2.3', '5255eed74e04', '', 'A'.repeat(40), 'g'.repeat(40)]) {
  try {
    assertExactCommitSha(value, 'test SHA');
    failures.push(`runtime SHA validator accepted forbidden ref: ${value || '[empty]'}`);
  } catch { /* expected */ }
}
try { assertExactCommitSha('5'.repeat(40), 'test SHA'); }
catch { failures.push('runtime SHA validator rejected an exact lowercase 40-hex SHA'); }

const fakeSession = Buffer.from(JSON.stringify({ cookies: [], origins: [] }), 'utf8');
const fakeBase64 = fakeSession.toString('base64');
const split = [fakeBase64.slice(0, 8), fakeBase64.slice(8, 16), fakeBase64.slice(16)];
const sessionCases = [
  ['one-part', { GROK_SESSION_B64_1: fakeBase64 }, false],
  ['multi-part', { GROK_SESSION_B64_1: split[0], GROK_SESSION_B64_2: split[1], GROK_SESSION_B64_3: split[2] }, false],
  ['missing-middle', { GROK_SESSION_B64_1: split[0], GROK_SESSION_B64_3: split[2] }, true],
  ['malformed', { GROK_SESSION_B64_1: 'not-base64%%%' }, true],
  ['compressed', { GROK_SESSION_GZ_B64: gzipSync(fakeSession).toString('base64') }, false],
];
for (const [name, env, shouldFail] of sessionCases) {
  try {
    const restored = reconstructProviderSession('grok', env);
    if (shouldFail) failures.push(`Grok ${name} session representation was accepted unexpectedly`);
    else if (!restored.bytes.equals(fakeSession)) failures.push(`Grok ${name} session bytes changed during reconstruction`);
  } catch {
    if (!shouldFail) failures.push(`Grok ${name} session representation was rejected unexpectedly`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Validated ${allWorkflows.length} workflows and the exact-SHA staging action.`);
