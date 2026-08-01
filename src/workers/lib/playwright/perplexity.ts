import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';

export let sharedPerplexityBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page } | null = null;

export async function closePerplexityBrowser() {
  if (sharedPerplexityBrowser) {
    await sharedPerplexityBrowser.runtime.close().catch(() => {});
    sharedPerplexityBrowser = null;
  }
}

export async function scrapePerplexityPrompt(prompt: string): Promise<{ text: string; citations: { url: string; title?: string }[] }> {
  if (!sharedPerplexityBrowser) {
    const runtime = await launchSeededPersistentContext('perplexity');
    try {
      const ctx = runtime.context;
      const page = await ctx.newPage();
      await page.goto('https://www.perplexity.ai/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(2500);
      sharedPerplexityBrowser = { runtime, page };
    } catch (err) {
      await runtime.close().catch(() => {});
      throw err;
    }
  }

  const { page } = sharedPerplexityBrowser;

  try {
    await page.goto('https://www.perplexity.ai/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1000);

    let composer = await firstVisibleLocator(page, '#ask-input, textarea, [contenteditable="true"], [placeholder="Ask anything..."]');
    if (!composer) {
      // Fallback: just grab the last contenteditable or ask-input
      const all = await page.locator('#ask-input, [contenteditable="true"]').all();
      if (all.length > 0) composer = all[all.length - 1];
    }
    if (!composer) {
      await captureDebug(page, 'perplexity', 'missing-composer');
      throw new Error(`Perplexity composer not found`);
    }

    await composer.click({ timeout: 20_000, force: true }).catch(() => {});
    await composer.fill('');
    await page.keyboard.insertText(`Use web search and answer this buyer question with citations:\n\n${prompt}`);
    await page.keyboard.press('Enter');

    await page.waitForFunction(() => {
      const answers = document.querySelectorAll('.prose, div[dir="auto"], [data-testid="answer-text"]');
      if (answers.length === 0) return false;
      for (let i = answers.length - 1; i >= 0; i--) {
        const text = (answers[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length > 0) return true;
      }
      return false;
    }, { timeout: 180_000 }).catch(() => {});
    await page.waitForTimeout(6000);

    const data = await page.evaluate(() => {
      const answers = document.querySelectorAll('.prose, div[dir="auto"], [data-testid="answer-text"]');
      let targetNode: Element | null = null;
      for (let i = answers.length - 1; i >= 0; i--) {
        if ((answers[i].textContent || '').trim().length > 0) {
          targetNode = answers[i];
          break;
        }
      }
      const last = targetNode || document.body;
      const text = (last.textContent || '').replace(/\s+/g, ' ').trim();
      
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .map((a) => ({ url: a.href, title: (a.textContent ?? '').trim() || undefined }))
        .filter((a) => /^https?:\/\//i.test(a.url) && !a.url.includes('perplexity.ai'))
        .slice(0, 12);
        
      return { text, links };
    });

    if (!data || !data.text || data.text.length < 10) {
      const html = await page.content().catch(() => '');
      require('fs').writeFileSync('perplexity_dump.html', html);
      throw new Error(`Perplexity did not render a real assistant answer`);
    }

    return { text: data.text, citations: data.links };
  } catch (err) {
    await closePerplexityBrowser();
    throw err;
  }
}
