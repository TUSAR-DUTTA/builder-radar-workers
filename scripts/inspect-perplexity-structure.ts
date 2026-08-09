import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { loadSessionsFromEnv } from '../src/lib/session-loader';
import { assertRuntimeCommitShas } from '../src/workers/lib/playwright/capture-contract';
import { launchSeededPersistentContext } from '../src/workers/lib/playwright/shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THREAD_URL = /^https:\/\/www\.perplexity\.ai\/search\/[0-9a-f-]{36}$/i;

const required = (name: string): string => {
  const value = process.env[name]?.trim() ?? '';
  if (!value) throw new Error(`${name.toLowerCase()}_missing`);
  return value;
};

async function main(): Promise<void> {
  const runtime = assertRuntimeCommitShas();
  const projectId = required('SCRAPE_PROJECT_ID');
  const promptId = required('SCRAPE_PROMPT_ID');
  const threadUrl = required('PERPLEXITY_DIAGNOSTIC_URL');
  if (!UUID.test(projectId) || !UUID.test(promptId)) throw new Error('diagnostic_binding_id_invalid');
  if (!THREAD_URL.test(threadUrl)) throw new Error('diagnostic_thread_url_invalid');

  const sql = postgres(required('DATABASE_URL'), {
    prepare: false, max: 1, connect_timeout: 5, idle_timeout: 5, max_lifetime: 30,
    onnotice: () => undefined,
  });
  let closeRuntime: (() => Promise<void>) | null = null;
  try {
    const [binding] = await sql<{ project_id: string; prompt_id: string; prompt: string }[]>`
      SELECT p.id::text AS project_id,ps.id::text AS prompt_id,ps.prompt
      FROM projects p JOIN prompt_sets ps ON ps.project_id=p.id
      WHERE p.id=${projectId} AND ps.id=${promptId} AND ps.active=true
    `;
    if (!binding || binding.project_id !== projectId || binding.prompt_id !== promptId) {
      throw new Error('diagnostic_prompt_binding_not_active');
    }

    loadSessionsFromEnv();
    const browserRuntime = await launchSeededPersistentContext('perplexity');
    closeRuntime = browserRuntime.close;
    const page = await browserRuntime.context.newPage();
    await page.goto(threadUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(8_000);
    if (page.url() !== threadUrl) throw new Error('diagnostic_thread_redirected');

    const expectedUiPrompt = `Use web search and answer this buyer question with citations:\n\n${binding.prompt}`;
    const dom = await page.evaluate((expectedPrompt) => {
      const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('en-US')
        .replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
      const hash = async (value: string): Promise<string> => {
        const bytes = new TextEncoder().encode(value);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
      };
      const signature = (node: Element | null) => {
        if (!(node instanceof HTMLElement)) return null;
        return {
          tag: node.tagName.toLowerCase(),
          id: node.id || null,
          role: node.getAttribute('role'),
          testid: node.getAttribute('data-testid'),
          ariaLabel: node.getAttribute('aria-label'),
          classTokens: Array.from(node.classList).slice(0, 12),
          childCount: node.children.length,
          textLength: (node.innerText || node.textContent || '').length,
        };
      };
      const path = (node: Element | null) => {
        const nodes: Element[] = [];
        let current = node;
        while (current && nodes.length < 7) {
          nodes.push(current);
          current = current.parentElement;
        }
        return nodes.map(signature);
      };
      const expected = normalize(expectedPrompt);
      const all = Array.from(document.querySelectorAll<HTMLElement>('main *'));
      const promptMatches = all.filter((node) => {
        const text = normalize(node.innerText || node.textContent || '');
        return text === expected || (text.includes(expected) && text.length <= expected.length + 120);
      }).slice(0, 12);
      const relevantControls = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
        .filter((node) => /copy|share|rewrite|export|more|stop|cancel|retry/i.test([
          node.getAttribute('aria-label'), node.getAttribute('title'), node.textContent,
        ].filter(Boolean).join(' ')))
        .slice(0, 40);
      const answerCandidates = Array.from(document.querySelectorAll<HTMLElement>(
        'article, [role="tabpanel"], [data-testid*="answer" i], [class*="prose"], [class*="markdown"]',
      )).filter((node) => (node.innerText || node.textContent || '').length >= 80).slice(0, 30);
      const answerProseRoots = Array.from(document.querySelectorAll<HTMLElement>('[role="tabpanel"][id] .prose'))
        .filter((node) => node.classList.contains('prose'));
      const citationCandidates = answerProseRoots.flatMap((root) => Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')))
        .slice(0, 40).map((anchor) => {
          let hostname: string | null = null;
          let pathDepth = 0;
          let providerOwned = false;
          try {
            const parsed = new URL(anchor.href);
            hostname = parsed.hostname;
            pathDepth = parsed.pathname.split('/').filter(Boolean).length;
            providerOwned = parsed.hostname === 'www.perplexity.ai' || parsed.hostname === 'perplexity.ai';
          } catch {}
          return {
            signature: signature(anchor), hostname, pathDepth, providerOwned,
            rel: anchor.rel || null, target: anchor.target || null,
          };
        });
      const completed = all.find((node) => /^Completed \d+ steps$/i.test((node.textContent || '').trim())) ?? null;
      const sources = all.find((node) => /^Sources(?:\s+\d+)?$/i.test((node.textContent || '').trim())) ?? null;
      return Promise.all(relevantControls.map(async (node) => ({
        signature: signature(node),
        titleHash: await hash(node.getAttribute('title') ?? ''),
        controlTextHash: await hash((node.textContent ?? '').trim()),
        path: path(node),
      }))).then((controls) => ({
        promptMatches: promptMatches.map((node) => ({ signature: signature(node), path: path(node) })),
        controls,
        answerCandidates: answerCandidates.map((node) => ({ signature: signature(node), path: path(node) })),
        answerProseCount: answerProseRoots.length,
        citationCandidates,
        completedPath: path(completed),
        sourcesPath: path(sources),
        stopVisible: Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')).some((node) => {
          const label = [node.getAttribute('aria-label'), node.getAttribute('title'), node.textContent].filter(Boolean).join(' ');
          return /stop|cancel generating/i.test(label) && node.offsetParent !== null;
        }),
      }));
    }, expectedUiPrompt);

    const safe = {
      mode: 'existing_thread_selector_diagnostic',
      workerSha: runtime.workerSha,
      privateSha: runtime.privateSha,
      projectId,
      promptId,
      promptSha256: createHash('sha256').update(binding.prompt, 'utf8').digest('hex'),
      threadPathSha256: createHash('sha256').update(new URL(threadUrl).pathname, 'utf8').digest('hex'),
      ...dom,
    };
    const debugDir = process.env.PLAYWRIGHT_DEBUG_DIR ?? '/tmp/playwright_debug';
    await mkdir(debugDir, { recursive: true });
    await writeFile(`${debugDir}/perplexity-selector-diagnostic.json`, `${JSON.stringify(safe, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx',
    });
    process.stdout.write(`selector_diagnostic_complete prompt_matches=${dom.promptMatches.length} controls=${dom.controls.length} answer_candidates=${dom.answerCandidates.length}\n`);
  } finally {
    if (closeRuntime) await closeRuntime().catch(() => {});
    await sql.end({ timeout: 2 });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message.slice(0, 160) : 'selector_diagnostic_failed'}\n`);
  process.exitCode = 1;
});
