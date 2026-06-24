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

    // Detect Cloudflare Turnstile early — means proxy IP is being challenged
    const bodyText = await page.textContent('body').catch(() => '');
    if (/Performing security verification|Verifies you are not a bot|cf-turnstile/i.test(bodyText ?? '')) {
      await captureDebug(page, 'perplexity', 'cloudflare-turnstile');
      throw new Error('Perplexity blocked by Cloudflare Turnstile — proxy IP is flagged. Session needs refresh from proxy IP.');
    }

    // Perplexity has changed their input selector multiple times — try all known variants
    let composer = await firstVisibleLocator(page,
      'textarea[placeholder], textarea, #ask-input, [contenteditable="true"][aria-label], ' +
      '[contenteditable="true"][placeholder], [placeholder*="Ask"], [placeholder*="Search"]'
    );
    if (!composer) {
      const all = await page.locator('textarea, #ask-input, [contenteditable="true"]').all();
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

    console.log('[perplexity] Waiting for answer to complete...');
    let lastText = '';
    let stableCount = 0;
    const maxChecks = 120; // 2 minutes max
    for (let check = 0; check < maxChecks; check++) {
      const currentText = await page.evaluate(() => {
        const answers = Array.from(document.querySelectorAll('.prose, div[dir="auto"], [data-testid="answer-text"], [class*="answer"]'));
        const last = answers.at(-1);
        if (!last) return '';
        return (last.textContent ?? '').replace(/\s+/g, ' ').trim();
      });

      if (!currentText) {
        await page.waitForTimeout(1000);
        continue;
      }

      // Check if it is only showing search/source status
      const isOnlySearching = /Searching|Thinking|sources/i.test(currentText) && currentText.length < 150;

      if (currentText === lastText && !isOnlySearching) {
        stableCount++;
        if (stableCount >= 4) { // stable for 4 seconds
          console.log('[perplexity] Text stopped changing and is stable.');
          break;
        }
      } else {
        stableCount = 0;
        lastText = currentText;
      }

      await page.waitForTimeout(1000);
    }

    const data = await page.evaluate(() => {
      const answers = Array.from(document.querySelectorAll('.prose, div[dir="auto"], [data-testid="answer-text"], [class*="answer"]'));
      const last = answers.at(-1) || document.body;
      const text = (last.textContent || '').replace(/\s+/g, ' ').trim();
      const container = last.closest('[class*="thread"], [class*="group"]') || last.parentElement || document.body;
      
      const extracted: Array<{ url: string; title?: string }> = [];
      
      // 1. Extract from custom data-pplx-citation-url elements
      container.querySelectorAll('[data-pplx-citation-url]').forEach((el) => {
        const url = el.getAttribute('data-pplx-citation-url');
        if (url) {
          extracted.push({
            url,
            title: el.textContent?.trim() || undefined
          });
        }
      });
      
      // 2. Extract from standard anchors (with optional perplexity redirect decoding)
      container.querySelectorAll('a[href]').forEach((a) => {
        let href = (a as HTMLAnchorElement).href;
        if (href.includes('perplexity.ai/search/redirect?url=')) {
          try {
            const parsed = new URL(href);
            const target = parsed.searchParams.get('url');
            if (target) href = target;
          } catch (e) {}
        }
        extracted.push({
          url: href,
          title: a.textContent?.trim() || undefined
        });
      });
      
      // 3. Filter and de-duplicate
      const seen = new Set<string>();
      const links = extracted
        .filter((a) => {
          if (!/^https?:\/\//i.test(a.url)) return false;
          if (a.url.includes('perplexity.ai')) return false;
          if (seen.has(a.url)) return false;
          seen.add(a.url);
          return true;
        })
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
