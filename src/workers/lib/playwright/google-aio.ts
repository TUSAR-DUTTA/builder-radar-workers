import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';

let sharedGoogleAioBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page } | null = null;

export async function closeGoogleAioBrowser() {
  if (sharedGoogleAioBrowser) {
    await sharedGoogleAioBrowser.runtime.close().catch(() => {});
    sharedGoogleAioBrowser = null;
  }
}

export async function scrapeGoogleAioPrompt(prompt: string): Promise<{ text: string; citations: { url: string; title?: string }[] }> {
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
    await page.keyboard.insertText(`Use web search and answer this buyer question with citations:\n\n${prompt}`);
    await page.keyboard.press('Enter');

    // Sometimes AIO has a generate button
    const generateBtn = await firstVisibleLocator(page, 'button:has-text("Generate")');
    if (generateBtn) {
      await generateBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(4000);
    }

    // Wait for the AI Overview container or text to appear
    await page.waitForFunction(() => {
      const text = document.body.innerText;
      return text.includes('AI Overview') || text.includes('Generative AI is experimental');
    }, { timeout: 20_000 }).catch(() => {});
    
    // Sometimes AIO has a Show more button
    const showMoreBtn = await firstVisibleLocator(page, 'span:has-text("Show more"), div:has-text("Show more")');
    if (showMoreBtn) {
      await showMoreBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    const data = await page.evaluate(() => {
      // Find the main AIO container. Google usually puts it in a div that contains "AI Overview"
      // We will look for the highest level block that has the AI Overview and is likely the answer container.
      const allDivs = Array.from(document.querySelectorAll('div'));
      const aioContainer = allDivs.find(div => {
         const text = div.innerText;
         // Check if this div is a major block containing the AIO
         return text && text.includes('AI Overview') && text.length > 100 && !text.includes('Related searches');
      });

      if (!aioContainer) {
        return { text: '', links: [] };
      }

      // Remove noise from the container text
      const text = aioContainer.innerText
        .replace(/AI Overview/g, '')
        .replace(/Show more/g, '')
        .replace(/Generative AI is experimental/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      const links = Array.from(aioContainer.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .map(a => ({ url: a.href, title: (a.textContent ?? '').trim() || undefined }))
        .filter(a => /^https?:\/\//i.test(a.url) && !a.url.includes('google.com'))
        .slice(0, 12);

      return { text, links };
    });

    if (data.text.length < 50) {
      await captureDebug(page, 'google-aio', 'bad-response');
      throw new Error('Google AIO did not render a real assistant answer');
    }

    return { text: data.text, citations: data.links };
  } catch (err) {
    if (process.env.PLAYWRIGHT_HEADLESS !== '0') {
      await closeGoogleAioBrowser();
    }
    throw err;
  }
}
