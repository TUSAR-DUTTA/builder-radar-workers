import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';
import { inspectGoogleAioDom } from './google-aio-dom';
import { BrowserCapture, buildProvenance, BrowserNoAnswerError, type TerminalProof, type BrowserConnectionMetadata } from './capture-contract';
import { createHash } from 'node:crypto';

export let sharedGoogleAioBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page, connectionMeta: BrowserConnectionMetadata } | null = null;

export async function closeGoogleAioBrowser() {
  if (sharedGoogleAioBrowser) {
    await sharedGoogleAioBrowser.runtime.close().catch(() => {});
    sharedGoogleAioBrowser = null;
  }
}

export async function scrapeGoogleAioPrompt(
  prompt: string,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<BrowserCapture> {
  if (!sharedGoogleAioBrowser) {
    const runtime = await launchSeededPersistentContext('google-aio');
    const ctx = runtime.context;
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://www.google.com/ncr', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(2500);
    sharedGoogleAioBrowser = { runtime, page, connectionMeta: runtime.connectionMeta };
  }

  const { page } = sharedGoogleAioBrowser;

  try {
    if (signal?.aborted) throw new Error('provider_deadline_aborted');

    await page.goto('https://www.google.com/ncr', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1000);

    const composer = await firstVisibleLocator(page, 'textarea[name="q"], input[name="q"]');
    if (!composer) {
      await captureDebug(page, 'google-aio', 'missing-composer');
      throw new Error('Google search bar not found');
    }

    await composer.click({ timeout: 20_000, force: true }).catch(() => {});
    await composer.fill('');
    await page.keyboard.insertText(prompt);
    
    // Read back to verify
    const typedText = await composer.inputValue().catch(() => '');
    if (typedText.length < 5) {
      await captureDebug(page, 'google-aio', 'composer-failed-to-fill');
      throw new Error('Google search bar failed to accept input');
    }

    await page.keyboard.press('Enter');

    let stableCount = 0;
    let previousText = '';
    const deadline = deadlineAt || (Date.now() + 180_000);
    let finalInspection: any = null;
    let stableContainerIdentity: string | null = null;
    let noAioStableChecks = 0;
    
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('provider_deadline_aborted');
      await page.waitForTimeout(1000);
      
      let inspection;
      try {
        inspection = await page.evaluate(inspectGoogleAioDom, prompt);
      } catch {
        continue;
      }
      if (inspection.state === 'consent' || inspection.state === 'challenge') {
         await captureDebug(page, 'google-aio', inspection.state);
         throw new Error(`Google blocked by ${inspection.state}`);
      }
      if (inspection.state === 'login_required' || inspection.state === 'rate_limited'
        || inspection.state === 'interstitial' || inspection.state === 'duplicate_aio') {
        throw new Error(`${inspection.state}:google-aio`);
      }
      if (inspection.state === 'refusal') throw new Error('provider_refusal:google-aio');
      if (inspection.state === 'search_submitted') {
         continue;
      }
      
      if (inspection.state === 'aio_rendering' || inspection.state === 'aio_complete') {
        if (stableContainerIdentity === null && inspection.containerIdentity) {
          stableContainerIdentity = inspection.containerIdentity;
        } else if (stableContainerIdentity && inspection.containerIdentity && inspection.containerIdentity !== stableContainerIdentity) {
          stableCount = 0;
          previousText = '';
          stableContainerIdentity = inspection.containerIdentity;
          continue;
        }

        const generateBtn = await firstVisibleLocator(page, 'button:has-text("Generate")');
        if (generateBtn) {
          await generateBtn.click({ timeout: 5000 }).catch(() => {});
        }
        
        const showMoreBtn = await firstVisibleLocator(page, 'span:has-text("Show more"), div:has-text("Show more")');
        if (showMoreBtn) {
          await showMoreBtn.click({ timeout: 5000 }).catch(() => {});
        }
        
        if (inspection.rawAnswer === previousText && inspection.rawAnswer.length > 50) {
           stableCount++;
        } else {
           stableCount = 0;
        }
        previousText = inspection.rawAnswer;
        finalInspection = inspection;
        
        if (stableCount >= 3 && inspection.state === 'aio_complete') {
           break;
        }
      } else {
         finalInspection = inspection; // results_loaded
         noAioStableChecks = inspection.state === 'results_loaded' ? noAioStableChecks + 1 : 0;
         if (noAioStableChecks >= 5) break;
      }
    }

    if (!finalInspection || finalInspection.state !== 'aio_complete') {
      throw new BrowserNoAnswerError('google-aio', 'no AI overview triggered');
    }

    if (finalInspection.rawAnswer.length < 50) {
      await captureDebug(page, 'google-aio', 'bad-response');
      throw new Error('Google AIO did not render a real assistant answer');
    }

    const { connectionMeta } = sharedGoogleAioBrowser;
    const uiLocale = await page.evaluate(() => document.documentElement.lang || 'en-US').catch(() => 'en-US');
    connectionMeta.actualLocale = uiLocale;

    const captureBindingId = `local:sha256:${createHash('sha256').update(JSON.stringify({
      provider: 'google-aio', prompt, observedContainerIdentity: finalInspection.containerIdentity ?? null,
      rawHash: createHash('sha256').update(Buffer.from(finalInspection.rawAnswer, 'utf8')).digest('hex'),
    }), 'utf8').digest('hex')}`;

    const terminalProof: TerminalProof = {
      providerState: 'complete',
      turnBindingMethod: 'deterministic_dom',
      captureBindingId,
      userTurnId: null,
      assistantTurnId: null,
      answerNodeId: null,
      terminalSignal: finalInspection.state,
      stableChecks: stableCount,
    };

    await captureDebug(page, 'google-aio', 'terminal-success', {
      bindingMethod: 'deterministic_dom', captureBindingId, terminalSignal: finalInspection.state,
      rawByteLength: Buffer.byteLength(finalInspection.rawAnswer, 'utf8'),
      citationCount: finalInspection.links.length,
    });

    return { 
      capturedPrompt: prompt,
      rawAnswer: finalInspection.rawAnswer, 
      citations: finalInspection.links,
      provenance: buildProvenance('google-aio', { terminalProof }, connectionMeta)
    };
  } catch (err) {
    if (process.env.PLAYWRIGHT_HEADLESS !== '0') {
      await closeGoogleAioBrowser();
    }
    throw err;
  }
}
