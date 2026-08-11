import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSessionsFromEnv } from '../src/lib/session-loader';

type Provider = 'chatgpt' | 'claude' | 'perplexity' | 'grok' | 'google-aio';
type AcceptanceMode = 'expected_answer' | 'expected_terminal_no_answer' | 'diagnostic_only';
type Capture = {
  rawAnswer: string;
  capturedPrompt: string;
  citations: { url: string; title?: string }[];
  provenance?: Record<string, unknown> & {
    adapterVersion?: string;
    providerTerminalSignal?: string;
    terminalProof?: Record<string, unknown>;
    turnBindingMethod?: string;
    captureBindingId?: string;
  };
};

const SHA40 = /^[0-9a-f]{40}$/;
const providers = new Set<Provider>(['chatgpt', 'claude', 'perplexity', 'grok', 'google-aio']);
const modes = new Set<AcceptanceMode>(['expected_answer', 'expected_terminal_no_answer', 'diagnostic_only']);
const required = (name: string): string => {
  const value = process.env[name]?.trim() ?? '';
  if (!value) throw new Error(`${name.toLowerCase()}_missing`);
  return value;
};
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const bounded = (value: string, maximum = 100_000): string => value.length > maximum
  ? `${value.slice(0, maximum)}\n[bounded capture truncated]`
  : value;
const citationLabel = (citation: { url: string; title?: string }): string => {
  if (citation.title?.trim()) return citation.title.trim();
  try { return new URL(citation.url).hostname; }
  catch { return '[invalid citation URL omitted]'; }
};

async function adapter(provider: Provider): Promise<{
  scrape: (prompt: string) => Promise<Capture>;
  page: () => import('playwright').Page | null;
  close: () => Promise<void>;
}> {
  switch (provider) {
    case 'chatgpt': {
      const mod = await import('../src/workers/lib/playwright/chatgpt');
      return { scrape: mod.scrapeChatGPTPrompt, page: () => mod.sharedChatGPTBrowser?.page ?? null, close: mod.closeChatGPTBrowser };
    }
    case 'claude': {
      const mod = await import('../src/workers/lib/playwright/claude');
      return { scrape: mod.scrapeClaudePrompt, page: () => mod.sharedClaudeBrowser?.page ?? null, close: mod.closeClaudeBrowser };
    }
    case 'perplexity': {
      const mod = await import('../src/workers/lib/playwright/perplexity');
      return { scrape: mod.scrapePerplexityPrompt, page: () => mod.sharedPerplexityBrowser?.page ?? null, close: mod.closePerplexityBrowser };
    }
    case 'grok': {
      const mod = await import('../src/workers/lib/playwright/grok');
      return { scrape: mod.scrapeGrokPrompt, page: () => mod.sharedGrokBrowser?.page ?? null, close: mod.closeGrokBrowser };
    }
    case 'google-aio': {
      const mod = await import('../src/workers/lib/playwright/google-aio');
      return { scrape: mod.scrapeGoogleAioPrompt, page: () => mod.sharedGoogleAioBrowser?.page ?? null, close: mod.closeGoogleAioBrowser };
    }
  }
}

async function runtimeAdapterVersion(provider: Provider): Promise<string> {
  const { BROWSER_ADAPTER_VERSIONS } = await import('../src/workers/lib/playwright/capture-contract');
  const engine = provider === 'chatgpt' ? 'chatgpt-consumer' : provider;
  return BROWSER_ADAPTER_VERSIONS[engine] ?? 'unavailable';
}

async function writeDerivedEvidence(
  page: import('playwright').Page | null,
  debugDirectory: string,
  provider: Provider,
  prompt: string,
  answer: string,
  citations: Capture['citations'],
  outcome: string,
): Promise<void> {
  const citationHtml = citations.slice(0, 12).map((citation) => `<li>${escapeHtml(citationLabel(citation))}</li>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Redacted provider capture</title>`
    + `<style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:0 24px;line-height:1.5}pre{white-space:pre-wrap}`
    + `.label{font-size:12px;text-transform:uppercase;color:#666}section{border:1px solid #ddd;border-radius:12px;padding:18px;margin:16px 0}</style></head>`
    + `<body data-derived-redacted-capture="true"><h1>${escapeHtml(provider)} capture</h1><p class="label">outcome</p><p>${escapeHtml(outcome)}</p>`
    + `<section><p class="label">submitted prompt</p><pre>${escapeHtml(bounded(prompt, 10_000))}</pre></section>`
    + `<section><p class="label">captured answer</p><pre>${escapeHtml(bounded(answer || '[terminal no answer]'))}</pre></section>`
    + `<section><p class="label">citation titles or hosts</p><ol>${citationHtml}</ol></section></body></html>`;
  await writeFile(resolve(debugDirectory, 'redacted-capture.html'), html, { encoding: 'utf8', flag: 'w' });
  if (page && !page.isClosed()) {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: resolve(debugDirectory, 'redacted-capture.png'), fullPage: true });
  }
}

async function main(): Promise<void> {
  const providerInput = required('HARNESS_PROVIDER') as Provider;
  const mode = required('HARNESS_ACCEPTANCE_MODE') as AcceptanceMode;
  const prompt = required('HARNESS_PROMPT');
  const workerSha = required('WORKER_RUNTIME_SHA').toLowerCase();
  const privateSha = required('PRIVATE_INGESTION_COMMIT').toLowerCase();
  if (!providers.has(providerInput)) throw new Error('harness_provider_invalid');
  if (!modes.has(mode)) throw new Error('harness_acceptance_mode_invalid');
  if (!SHA40.test(workerSha) || !SHA40.test(privateSha)) throw new Error('harness_runtime_sha_invalid');

  const debugDirectory = resolve(process.env.PLAYWRIGHT_DEBUG_DIR ?? '/tmp/playwright_debug');
  await mkdir(debugDirectory, { recursive: true });
  loadSessionsFromEnv();
  const selected = await adapter(providerInput);
  const selectedAdapterVersion = await runtimeAdapterVersion(providerInput);
  let capture: Capture | null = null;
  let thrown: unknown = null;
  try { capture = await selected.scrape(prompt); }
  catch (error) { thrown = error; }

  const noAnswer = Boolean(thrown && typeof thrown === 'object' && (
    (thrown as { code?: unknown }).code === 'provider_no_answer'
    || (providerInput === 'google-aio' && /no AI overview triggered/i.test((thrown as Error).message ?? ''))
  ));
  const rawAnswer = capture?.rawAnswer ?? '';
  const rawBytes = Buffer.from(rawAnswer, 'utf8');
  const citations = capture?.citations ?? [];
  const exactPrompt = capture ? normalize(capture.capturedPrompt) === normalize(prompt) : noAnswer && providerInput === 'google-aio';
  const answerAccepted = !thrown && exactPrompt && rawBytes.length >= 40;
  const terminalNoAnswerAccepted = noAnswer;
  const expectationPassed = mode === 'expected_answer' ? answerAccepted
    : mode === 'expected_terminal_no_answer' ? terminalNoAnswerAccepted
      : !thrown;
  const terminalProof = capture?.provenance?.terminalProof ?? {};
  const outcome = answerAccepted ? 'answer_captured' : terminalNoAnswerAccepted ? 'no_answer_terminal' : 'acquisition_failed';
  const diagnosticReason = thrown instanceof Error ? thrown.message.slice(0, 240) : thrown ? 'non_error_exception' : null;
  const manifest = {
    schemaVersion: 'consumer_live_harness_v2',
    provider: providerInput,
    acceptanceMode: mode,
    expectationPassed,
    acquisitionLimit: 1,
    acquisitionAttemptCount: 1,
    outcome,
    promptSha256: sha256(Buffer.from(prompt, 'utf8')),
    promptUtf8ByteLength: Buffer.byteLength(prompt, 'utf8'),
    capturedPromptExact: exactPrompt,
    rawUtf8ByteLength: rawBytes.length,
    rawSha256: sha256(rawBytes),
    citationCount: citations.length,
    bindingMethod: capture?.provenance?.turnBindingMethod ?? 'unavailable',
    captureBindingId: capture?.provenance?.captureBindingId ?? null,
    providerTerminalSignal: capture?.provenance?.providerTerminalSignal
      ?? terminalProof.terminalSignal
      ?? (terminalNoAnswerAccepted ? 'no_answer_terminal' : null),
    stableChecks: terminalProof.stableChecks ?? null,
    adapterVersion: capture?.provenance?.adapterVersion ?? selectedAdapterVersion,
    workerRuntimeSha: workerSha,
    privateRuntimeSha: privateSha,
    diagnosticReason,
  };
  await writeFile(resolve(debugDirectory, 'capture-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
  await writeFile(resolve(debugDirectory, 'safe-diagnostics.json'), `${JSON.stringify({
    provider: providerInput, outcome, diagnosticReason, pageAvailable: Boolean(selected.page()),
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
  await writeDerivedEvidence(selected.page(), debugDirectory, providerInput, prompt, rawAnswer, citations, outcome);
  await selected.close();
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
  if (!expectationPassed) throw new Error(`harness_acceptance_failed:${mode}:${outcome}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message.slice(0, 240) : 'consumer_live_harness_failed'}\n`);
  process.exitCode = 1;
});
