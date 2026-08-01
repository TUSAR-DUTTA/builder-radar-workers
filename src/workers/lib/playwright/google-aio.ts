import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';
import { inspectGoogleAioDom } from './google-aio-dom';
import { BrowserCapture, buildProvenance, BrowserNoAnswerError } from './capture-contract';

export let sharedGoogleAioBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page } | null = null;

export async function closeGoogleAioBrowser() {
  if (sharedGoogleAioBrowser) {
    await sharedGoogleAioBrowser.runtime.close().catch(() => {});
    sharedGoogleAioBrowser = null;
  }
}

export async function scrapeGoogleAioPrompt(prompt: string): Promise<BrowserCapture> {
  if (!sharedGoogleAioBrowser) {
    const runtime = await launchSeededPersistentContext('google-aio');
    const ctx = runtime.context;
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://www.google.com/ncr', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    console.log(`[google-aio] Final URL after goto: ${page.url()}`);
    const cookies = await ctx.cookies(page.url());
    console.log(`[google-aio] Found ${cookies.length} cookies on ${page.url()}`);
    const has1PSID = cookies.some(c => c.name === '__Secure-1PSID');
    console.log(`[google-aio] __Secure-1PSID present: ${has1PSID}`);
    await page.waitForTimeout(2500);
    sharedGoogleAioBrowser = { runtime, page };
  }

  const { page } = sharedGoogleAioBrowser;

  try {
    await page.goto('https://www.google.com/ncr', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1000);

    const composer = await firstVisibleLocator(page, 'textarea[name="q"], input[name="q"]');
    if (!composer) {
      await captureDebug(page, 'google-aio', 'missing-composer');
      throw new Error('Google search bar not found');
    }

    await composer.click({ timeout: 20_000, force: true }).catch(() => {});
    await composer.fill('');
    await page.keyboard.insertText(prompt);
    await page.keyboard.press('Enter');

    let stableCount = 0;
    let finalInspection: any = null;
    let previousText = '';
    
    for (let i = 0; i < 45; i++) {
      await page.waitForTimeout(1000);
      
      const inspection = await page.evaluate(inspectGoogleAioDom);
      if (inspection.state === 'consent' || inspection.state === 'challenge') {
         await captureDebug(page, 'google-aio', inspection.state);
         throw new Error(`Google blocked by ${inspection.state}`);
      }
      if (inspection.state === 'search_submitted') {
         continue;
      }
      
      if (inspection.state === 'aio_rendering' || inspection.state === 'aio_complete') {
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
      }
    }

    if (!finalInspection || finalInspection.state === 'results_loaded' || (finalInspection.state !== 'aio_complete' && finalInspection.state !== 'aio_rendering')) {
      throw new BrowserNoAnswerError('google-aio', 'no AI overview triggered');
    }

    if (finalInspection.rawAnswer.length < 50) {
      await captureDebug(page, 'google-aio', 'bad-response');
      throw new Error('Google AIO did not render a real assistant answer');
    }

    return { 
      rawAnswer: finalInspection.rawAnswer, 
      citations: finalInspection.links,
      provenance: buildProvenance('google-aio')
    };
  } catch (err) {
    if (process.env.PLAYWRIGHT_HEADLESS !== '0') {
      await closeGoogleAioBrowser();
    }
    throw err;
  }
}
