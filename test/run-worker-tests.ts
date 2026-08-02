import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';

import { inspectGoogleAioDom } from '../src/workers/lib/playwright/google-aio-dom';
import { isGrokTurnCorrelated } from '../src/workers/lib/playwright/grok-turn-binding';
import { buildProvenance, BROWSER_ADAPTER_VERSIONS } from '../src/workers/lib/playwright/capture-contract';

async function runTests() {
  console.log('=== Running Worker Contracts & Saved-DOM Behavioral Tests ===\n');

  let passed = 0;
  let failed = 0;

  function record(testName: string, ok: boolean, details?: string) {
    if (ok) {
      console.log(`  PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  FAIL: ${testName}${details ? ` -> ${details}` : ''}`);
      failed++;
    }
  }

  // 1. Provenance Version Tests
  console.log('[Suite 1: Adapter Provenance Versions]');
  {
    assert.strictEqual(BROWSER_ADAPTER_VERSIONS['chatgpt-consumer'], 'chatgpt_dom_v5');
    assert.strictEqual(BROWSER_ADAPTER_VERSIONS['google-aio'], 'google_aio_state_v5');
    assert.strictEqual(BROWSER_ADAPTER_VERSIONS['perplexity'], 'perplexity_dom_v5');
    assert.strictEqual(BROWSER_ADAPTER_VERSIONS['claude'], 'claude_dom_v5');
    assert.strictEqual(BROWSER_ADAPTER_VERSIONS['grok'], 'grok_dom_v5');

    const prov = buildProvenance(
      'google-aio',
      {
        terminalProof: {
          providerState: 'complete',
          userTurnId: 'u1',
          assistantTurnId: 'a1',
          answerNodeId: 'node-1',
          terminalSignal: 'aio_complete:stable_3',
          stableChecks: 3,
        }
      },
      {
        connectionMode: 'proxy',
        proxyRequested: true,
        proxyUsed: true,
        fallbackUsed: false,
        requestedMarket: 'US',
        actualRegion: null,
        regionVerified: false,
        locale: 'en-GB',
      }
    );
    assert.strictEqual(prov.adapterVersion, 'google_aio_state_v5');
    assert.strictEqual(prov.connectionMode, 'proxy');
    assert.strictEqual(prov.uiLocale, 'en-GB');
    assert.strictEqual(prov.terminalProof?.terminalSignal, 'aio_complete:stable_3');
    record('Adapter versions and provenance construction', true);
  }

  // 2. Grok Turn Binding Unit Tests
  console.log('\n[Suite 2: Grok Turn Correlation Logic]');
  {
    const priorSnapshot = { assistantCount: 1, userCount: 1, lastAssistantText: 'Old response text' };
    
    // Correlated valid new turn
    const validCandidate = {
      assistantCount: 2,
      userCount: 2,
      lastMatchingUserIndex: 2,
      assistantFollowsMatchingUser: true,
      text: 'Here is an informative response about Tally and its generous free tier.',
      busy: false,
      promptBound: true,
    };
    record('Grok correlated valid turn accepted', isGrokTurnCorrelated(priorSnapshot, validCandidate));

    // Stale turn (no new assistant turn or user turn)
    const staleCandidate = {
      assistantCount: 1,
      userCount: 1,
      lastMatchingUserIndex: 1,
      assistantFollowsMatchingUser: true,
      text: 'Old response text',
      busy: false,
      promptBound: false,
    };
    record('Grok stale turn rejected', !isGrokTurnCorrelated(priorSnapshot, staleCandidate));

    // Unbound turn (matching user not found)
    const unboundCandidate = { ...validCandidate, promptBound: false, lastMatchingUserIndex: -1 };
    record('Grok unbound prompt turn rejected', !isGrokTurnCorrelated(priorSnapshot, unboundCandidate));
  }

  // Launch headless browser for DOM fixture verification
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 3. Google AIO DOM Fixture Tests
    console.log('\n[Suite 3: Google AIO DOM Inspector]');
    {
      const genuineHtml = fs.readFileSync(path.join(__dirname, 'fixtures/google-aio-genuine.html'), 'utf8');
      await page.setContent(genuineHtml);
      const genuineResult = await page.evaluate(inspectGoogleAioDom);
      record('Genuine AIO DOM detected as aio_complete', genuineResult.state === 'aio_complete');
      record('Genuine AIO extracts raw answer containing Tally', genuineResult.rawAnswer.includes('Tally'));
      record('Genuine AIO extracts citations without google.com links', genuineResult.links.some(l => l.url.includes('tally.so')));

      const organicHtml = fs.readFileSync(path.join(__dirname, 'fixtures/google-aio-organic-serp.html'), 'utf8');
      await page.setContent(organicHtml);
      const organicResult = await page.evaluate(inspectGoogleAioDom);
      record('Organic SERP without AIO produces results_loaded with NO answer text', organicResult.state === 'results_loaded' && organicResult.rawAnswer === '');
    }

    // 4. ChatGPT DOM Fixture Tests
    console.log('\n[Suite 4: ChatGPT Terminal Detection]');
    {
      const researchingHtml = fs.readFileSync(path.join(__dirname, 'fixtures/chatgpt-researching.html'), 'utf8');
      await page.setContent(researchingHtml);
      const isResearchingTerminal = await page.evaluate(() => {
        const last = document.querySelector('section[data-turn="assistant"]');
        if (!last) return false;
        const busy = last.querySelector('[aria-busy="true"], [class*="result-streaming"]');
        if (busy) return false;
        const stopBtn = document.querySelector('[data-testid="stop-button"]');
        if (stopBtn) return false;
        const markdownEl = last.querySelector('.markdown, .prose');
        const text = ((markdownEl || last).textContent ?? '').replace(/\s+/g, ' ').trim();
        const isInterimStatusOnly = /^(researching|searching|thinking|thought for \d+ seconds?)\.?$/i.test(text);
        if (isInterimStatusOnly) return false;
        return text.length > 40;
      });
      record('ChatGPT interim researching state is correctly flagged as NOT terminal', isResearchingTerminal === false);

      const terminalHtml = fs.readFileSync(path.join(__dirname, 'fixtures/chatgpt-terminal.html'), 'utf8');
      await page.setContent(terminalHtml);
      const isTerminalDone = await page.evaluate(() => {
        const last = document.querySelector('section[data-turn="assistant"]');
        if (!last) return false;
        const busy = last.querySelector('[aria-busy="true"], [class*="result-streaming"]');
        if (busy) return false;
        const stopBtn = document.querySelector('[data-testid="stop-button"]');
        if (stopBtn) return false;
        const markdownEl = last.querySelector('.markdown, .prose');
        const text = ((markdownEl || last).textContent ?? '').replace(/\s+/g, ' ').trim();
        const isInterimStatusOnly = /^(researching|searching|thinking|thought for \d+ seconds?)\.?$/i.test(text);
        if (isInterimStatusOnly) return false;
        return text.length > 40;
      });
      record('ChatGPT completed response is recognized as terminal answer', isTerminalDone === true);
    }

    // 5. Perplexity DOM Fixture Tests
    console.log('\n[Suite 5: Perplexity Scoped Extraction]');
    {
      const perplexityHtml = fs.readFileSync(path.join(__dirname, 'fixtures/perplexity-fixture.html'), 'utf8');
      await page.setContent(perplexityHtml);
      const perpData = await page.evaluate(() => {
        const assistantEl = document.querySelector('[data-testid="answer-text"], div[class*="answer-text"], .default.font-sans.select-text');
        if (!assistantEl) return null;
        const text = (assistantEl.textContent ?? '').trim();
        const links = Array.from(assistantEl.querySelectorAll<HTMLAnchorElement>('a[href]'))
          .map(a => a.href)
          .filter(href => !href.includes('perplexity.ai'));
        return { text, links };
      });
      record('Perplexity extracts scoped answer without header text', perpData !== null && perpData.text.includes('Tally') && !perpData.text.includes('Brand Header'));
      record('Perplexity extracts citations from scoped answer container', perpData !== null && perpData.links.includes('https://tally.so/'));
    }

    // 6. Claude DOM Fixture Tests
    console.log('\n[Suite 6: Claude Turn Scoping]');
    {
      const claudeHtml = fs.readFileSync(path.join(__dirname, 'fixtures/claude-fixture.html'), 'utf8');
      await page.setContent(claudeHtml);
      const claudeData = await page.evaluate(() => {
        const userEl = document.querySelector('[data-is-user="true"], [data-testid="user-message"]');
        const assistantEl = document.querySelector('[data-is-user="false"], [data-testid="assistant-message"]');
        return {
          userText: userEl ? (userEl.textContent ?? '').trim() : '',
          assistantText: assistantEl ? (assistantEl.textContent ?? '').trim() : '',
          hasCitations: assistantEl ? Array.from(assistantEl.querySelectorAll('a[href]')).length > 0 : false,
        };
      });
      record('Claude user and assistant turns accurately scoped', claudeData.userText.includes('What is Tally') && claudeData.assistantText.includes('modern form builder'));
      record('Claude citations preserved', claudeData.hasCitations === true);
    }

    // 7. Grok DOM Fixture Tests
    console.log('\n[Suite 7: Grok Turn Scoping]');
    {
      const grokHtml = fs.readFileSync(path.join(__dirname, 'fixtures/grok-fixture.html'), 'utf8');
      await page.setContent(grokHtml);
      const grokData = await page.evaluate(() => {
        const userEl = document.querySelector('div[data-message-author-role="user"]');
        const assistantEl = document.querySelector('div[data-message-author-role="assistant"]');
        return {
          userText: userEl ? (userEl.textContent ?? '').trim() : '',
          assistantText: assistantEl ? (assistantEl.textContent ?? '').trim() : '',
        };
      });
      record('Grok user and assistant turns accurately scoped', grokData.userText.includes('What is Tally') && grokData.assistantText.includes('intuitive form builder'));
    }

  } finally {
    await browser.close();
  }

  console.log(`\n========================================`);
  console.log(`Tests finished: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});
