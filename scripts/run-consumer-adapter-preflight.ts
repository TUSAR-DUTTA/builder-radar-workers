import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import type { AIRouter } from '../src/lib/ai-router';
import type { AnswerModel } from '../src/lib/geo/types';
import { loadSessionsFromEnv } from '../src/lib/session-loader';
import { validateWorkerAdapterEnvelope } from '../src/workers/lib/evidence-contract-boundary';
import { closeSharedBrowser, runPromptViaPlaywrightDetailed } from '../src/workers/lib/geo-playwright';
import { assertRuntimeCommitShas } from '../src/workers/lib/playwright/capture-contract';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const engineMap: Readonly<Record<string, AnswerModel>> = Object.freeze({
  chatgpt: 'chatgpt-consumer',
  claude: 'claude',
  perplexity: 'perplexity',
  grok: 'grok',
  'google-aio': 'google-aio',
});

const required = (name: string): string => {
  const value = process.env[name]?.trim() ?? '';
  if (!value) throw new Error(`${name.toLowerCase()}_missing`);
  return value;
};

async function main(): Promise<void> {
  const runtime = assertRuntimeCommitShas();
  const engineInput = required('PREFLIGHT_ENGINE');
  const model = engineMap[engineInput];
  if (!model) throw new Error('preflight_engine_invalid');
  const projectId = required('SCRAPE_PROJECT_ID');
  const promptId = required('SCRAPE_PROMPT_ID');
  if (!UUID.test(projectId) || !UUID.test(promptId)) throw new Error('preflight_binding_id_invalid');

  const sql = postgres(required('DATABASE_URL'), {
    prepare: false, max: 1, connect_timeout: 5, idle_timeout: 5, max_lifetime: 30,
    onnotice: () => undefined,
  });
  try {
    const [binding] = await sql<{
      project_id: string;
      project_name: string;
      prompt_id: string;
      prompt: string;
      baseline_id: string | null;
    }[]>`
      SELECT p.id::text AS project_id,p.name AS project_name,ps.id::text AS prompt_id,
        ps.prompt,p.measurement_baseline_version AS baseline_id
      FROM projects p JOIN prompt_sets ps ON ps.project_id=p.id
      WHERE p.id=${projectId} AND ps.id=${promptId} AND ps.active=true
    `;
    if (!binding || binding.project_id !== projectId || binding.prompt_id !== promptId || !binding.baseline_id) {
      throw new Error('preflight_prompt_binding_not_active');
    }

    loadSessionsFromEnv();
    const scanJobId = randomUUID();
    const scanCellId = randomUUID();
    const result = await runPromptViaPlaywrightDetailed(
      {} as AIRouter,
      binding.prompt,
      [binding.project_name],
      [model],
      {
        projectId,
        scanJobId,
        scanCellId,
        baselineId: binding.baseline_id,
        promptId,
        targetMarket: 'US',
      },
    );
    const adapter = result.adapterResults[0];
    if (!adapter) throw new Error('preflight_adapter_result_missing');
    const verified = validateWorkerAdapterEnvelope(adapter);
    const bytes = Buffer.from(verified.rawAnswer ?? '', 'utf8');
    const contentSha256 = createHash('sha256').update(bytes).digest('hex');
    if (verified.captureStatus !== 'accepted' || verified.promptBindingStatus !== 'verified'
      || verified.completionStatus !== 'terminal' || verified.rawReceipt.contentSha256 !== contentSha256) {
      throw new Error('preflight_evidence_not_accepted');
    }

    const safe = {
      mode: 'acquisition_only_preflight',
      claimable: false,
      workerSha: runtime.workerRuntimeSha,
      privateSha: runtime.privateIngestionCommit,
      engine: verified.engine,
      adapterVersion: verified.adapterVersion,
      contractVersion: verified.contractVersion,
      schemaVersion: verified.schemaVersion,
      projectId,
      promptId,
      promptSha256: createHash('sha256').update(binding.prompt, 'utf8').digest('hex'),
      scanJobId,
      scanCellId,
      userTurnId: verified.provenance.userTurnId,
      assistantTurnId: verified.provenance.assistantTurnId,
      answerNodeId: verified.provenance.answerNodeId,
      providerTerminalSignal: verified.provenance.providerTerminalSignal,
      captureStatus: verified.captureStatus,
      promptBindingStatus: verified.promptBindingStatus,
      completionStatus: verified.completionStatus,
      rawByteLength: bytes.length,
      contentSha256,
      citationCount: result.samples[0]?.citations.length ?? 0,
      acquisitionAttemptCount: 1,
      processingAttemptCount: 0,
      receiptId: null,
      answerCount: 0,
      linkCount: 0,
      usageCount: 0,
    };
    const debugDir = process.env.PLAYWRIGHT_DEBUG_DIR ?? '/tmp/playwright_debug';
    await mkdir(debugDir, { recursive: true });
    await writeFile(`${debugDir}/preflight-result.json`, `${JSON.stringify(safe, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    process.stdout.write(`${JSON.stringify(safe)}\n`);
  } finally {
    await closeSharedBrowser();
    await sql.end({ timeout: 2 });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message.slice(0, 160) : 'preflight_failed'}\n`);
  process.exitCode = 1;
});
