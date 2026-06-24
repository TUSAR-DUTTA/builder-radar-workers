import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';

let sharedClaudeBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page } | null = null;

export async function closeClaudeBrowser() {
  if (sharedClaudeBrowser) {
    await sharedClaudeBrowser.runtime.close().catch(() => {});
    sharedClaudeBrowser = null;
  }
}

export async function scrapeClaudePrompt(prompt: string): Promise<{ text: string; citations: { url: string; title?: string }[] }> {
  if (!sharedClaudeBrowser) {
    const runtime = await launchSeededPersistentContext('claude');
    try {
      const ctx = runtime.context;
      const page = await ctx.newPage();
      await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(2500);
      sharedClaudeBrowser = { runtime, page };
    } catch (err) {
      await runtime.close().catch(() => {});
      throw err;
    }
  }

  const { page } = sharedClaudeBrowser;

  try {
    await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1000);

    // Attempt to dismiss cookie popups repeatedly
    let composer: import('playwright').Locator | null = null;
    for (let i = 0; i < 15; i++) {
      await page.locator('button:has-text("Accept All Cookies")').click({ timeout: 1000 }).catch(() => {});
      composer = await firstVisibleLocator(page, '[contenteditable="true"], textarea, #prompt-textarea');
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

    await page.waitForFunction(() => {
      const msgs = document.querySelectorAll('.font-claude-response');
      if (msgs.length === 0) return false;
      const last = msgs[msgs.length - 1];
      const container = last.closest('[data-is-streaming]');
      if (container && container.getAttribute('data-is-streaming') === 'true') return false;
      const text = (last.textContent || '').replace(/\s+/g, ' ').trim();
      return text.length > 0;
    }, { timeout: 180_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const data = await page.evaluate(() => {
      const assistantTurns = Array.from(document.querySelectorAll('.font-claude-response'));
      const last = assistantTurns.at(-1) || document.body;
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
