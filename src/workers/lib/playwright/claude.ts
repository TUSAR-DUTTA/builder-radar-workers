import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';

export let sharedClaudeBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page } | null = null;

export async function closeClaudeBrowser() {
  if (sharedClaudeBrowser) {
    await sharedClaudeBrowser.runtime.close().catch(() => {});
    sharedClaudeBrowser = null;
  }
}

export async function scrapeClaudePrompt(prompt: string): Promise<{ text: string; citations: { url: string; title?: string }[] }> {
  if (!sharedClaudeBrowser) {
    const runtime = await launchSeededPersistentContext('claude');
    const ctx = runtime.context;
    const page = await ctx.newPage();
    await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(2500);
    sharedClaudeBrowser = { runtime, page };
  }

  const { page } = sharedClaudeBrowser;

  try {
    await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1000);

    // Detect Cloudflare block early before wasting retries
    const earlyBody = await page.textContent('body').catch(() => '');
    if (/Performing security verification|Verifies you are not a bot/i.test(earlyBody ?? '')) {
      await captureDebug(page, 'claude', 'cloudflare-block');
      throw new Error('Claude blocked by Cloudflare on initial load');
    }

    // Attempt to dismiss cookie popups repeatedly
    let composer: import('playwright').Locator | null = null;
    for (let i = 0; i < 15; i++) {
      await page.locator('button:has-text("Accept All Cookies")').click({ timeout: 1000 }).catch(() => {});
      // Broaden selector — Claude frequently changes CSS class names
      composer = await firstVisibleLocator(page,
        '[contenteditable="true"][aria-label], [contenteditable="true"].ProseMirror, ' +
        '[contenteditable="true"], textarea, #prompt-textarea'
      );
      if (composer) break;
      await page.waitForTimeout(1000);
    }

    if (!composer) {
      await captureDebug(page, 'claude', 'missing-composer');
      throw new Error(`Claude composer not found`);
    }

    await composer.click({ timeout: 20_000, force: true }).catch(() => {});
    await composer.fill('');
    await page.keyboard.insertText(`Use web search and answer this buyer question with citations:\n\n${prompt}`);
    await composer.press('Enter');

    console.log('[claude] Waiting for answer to complete...');
    let lastText = '';
    let stableCount = 0;
    const maxChecks = 120; // 2 minutes max
    for (let check = 0; check < maxChecks; check++) {
      const currentText = await page.evaluate(() => {
        const selectors = ['.font-claude-response', '.prose', '[data-is-streaming]', '[class*="response"]', '[class*="assistant"]'];
        let last: Element | null = null;
        for (const sel of selectors) {
          const els = Array.from(document.querySelectorAll(sel));
          if (els.length > 0) { last = els[els.length - 1]; break; }
        }
        if (!last) return '';
        return (last.textContent ?? '').replace(/\s+/g, ' ').trim();
      });

      if (!currentText) {
        await page.waitForTimeout(1000);
        continue;
      }

      // Check if it is only showing search status
      const isOnlySearching = /Working|Searching the web/i.test(currentText) && currentText.length < 150;

      if (currentText === lastText && !isOnlySearching) {
        stableCount++;
        if (stableCount >= 4) { // stable for 4 seconds
          console.log('[claude] Text stopped changing and is stable.');
          break;
        }
      } else {
        stableCount = 0;
        lastText = currentText;
      }

      await page.waitForTimeout(1000);
    }

    const data = await page.evaluate(() => {
      // Try selectors in priority order
      const selectors = ['.font-claude-response', '.prose', '[data-is-streaming]', '[class*="response"]'];
      let last: Element | null = null;
      for (const sel of selectors) {
        const els = Array.from(document.querySelectorAll(sel));
        if (els.length > 0) { last = els[els.length - 1]; break; }
      }
      if (!last) last = document.body;
      const text = (last.textContent ?? '').replace(/\s+/g, ' ').trim();
      const links = Array.from(last.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .map((a) => ({ url: a.href, title: (a.textContent ?? '').trim() || undefined }))
        .filter((a) => /^https?:\/\//i.test(a.url) && !a.url.includes('claude.ai'))
        .slice(0, 12);
      return { text, links };
    });

    const isCloudflare = /Performing security verification|Verifies you are not a bot/i.test(data.text);
    if (data.text.length < 5 || isCloudflare) {
      await captureDebug(page, 'claude', 'bad-response', { isCloudflare });
      throw new Error(isCloudflare ? 'Claude blocked by Cloudflare' : 'Claude did not render a real assistant answer');
    }

    return { text: data.text, citations: data.links };
  } catch (err) {
    await closeClaudeBrowser();
    throw err;
  }
}
