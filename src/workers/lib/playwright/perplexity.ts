import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';

let sharedPerplexityBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page } | null = null;

export async function closePerplexityBrowser() {
  if (sharedPerplexityBrowser) {
    await sharedPerplexityBrowser.runtime.close().catch(() => {});
    sharedPerplexityBrowser = null;
  }
}

export async function scrapePerplexityPrompt(prompt: string): Promise<{ text: string; citations: { url: string; title?: string }[] }> {
  if (!sharedPerplexityBrowser) {
    const runtime = await launchSeededPersistentContext('perplexity');
    const ctx = runtime.context;
    const page = await ctx.newPage();
    await page.goto('https://www.perplexity.ai/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(2500);
    sharedPerplexityBrowser = { runtime, page };
  }

  const { page } = sharedPerplexityBrowser;

  try {
    await page.goto('https://www.perplexity.ai/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1000);

    let composer = await firstVisibleLocator(page, '#ask-input, textarea, [contenteditable="true"], [placeholder*="Ask"], [aria-label*="Ask"]');
    if (!composer) {
      const all = await page.locator('textarea, [contenteditable="true"]').all();
      for (const el of all) {
        if (await el.isVisible().catch(() => false)) {
          composer = el;
          break;
        }
      }
    }
    if (!composer) {
      const html = await page.evaluate(() => document.body.innerHTML);
      console.log('[perplexity] Missing composer! Page HTML (first 2000 chars):', html.substring(0, 2000));
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
      const last = answers[answers.length - 1];
      const text = (last.textContent || '').replace(/\s+/g, ' ').trim();
      return text.length > 0;
    }, { timeout: 180_000 }).catch(() => {});
    await page.waitForTimeout(6000);

    const data = await page.evaluate(() => {
      const answers = Array.from(document.querySelectorAll('.prose, div[dir="auto"], [data-testid="answer-text"]'));
      const last = answers.at(-1) || document.body;
      const text = (last.textContent || '').replace(/\s+/g, ' ').trim();
      const links = Array.from(last.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .map((a) => ({ url: a.href, title: (a.textContent ?? '').trim() || undefined }))
        .filter((a) => /^https?:\/\//i.test(a.url) && !a.url.includes('perplexity.ai'))
        .slice(0, 12);
      return { text, links };
    });

    if (data.text.length < 5) {
      await captureDebug(page, 'perplexity', 'bad-response');
      throw new Error('Perplexity did not render a real assistant answer');
    }

    return { text: data.text, citations: data.links };
  } catch (err) {
    await closePerplexityBrowser();
    throw err;
  }
}
