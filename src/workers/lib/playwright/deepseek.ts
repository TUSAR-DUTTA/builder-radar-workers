import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';

let sharedDeepseekBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page } | null = null;

export async function closeDeepseekBrowser() {
  if (sharedDeepseekBrowser) {
    await sharedDeepseekBrowser.runtime.close().catch(() => {});
    sharedDeepseekBrowser = null;
  }
}

export async function scrapeDeepseekPrompt(prompt: string): Promise<{ text: string; citations: { url: string; title?: string }[] }> {
  if (!sharedDeepseekBrowser) {
    const runtime = await launchSeededPersistentContext('deepseek');
    const ctx = runtime.context;
    const page = await ctx.newPage();
    await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(2500);
    sharedDeepseekBrowser = { runtime, page };
  }

  const { page } = sharedDeepseekBrowser;

  try {
    await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1000);

    if (page.url().includes('sign_in') || await page.locator('text="Log in"').isVisible().catch(() => false)) {
      await captureDebug(page, 'deepseek', 'unauthenticated');
      throw new Error('DeepSeek session is unauthenticated (redirected to login page).');
    }

    let composer: import('playwright').Locator | null = null;
    for (let i = 0; i < 15; i++) {
      composer = await firstVisibleLocator(page, '[contenteditable="true"], textarea, #chat-input, #chat-textarea');
      if (composer) break;
      await page.waitForTimeout(1000);
    }

    if (!composer) {
      await captureDebug(page, 'deepseek', 'missing-composer');
      throw new Error(`DeepSeek composer not found`);
    }

    await composer.click({ timeout: 20_000, force: true }).catch(() => {});
    await composer.fill('');
    await page.keyboard.insertText(prompt);
    await composer.press('Enter');

    await page.waitForTimeout(5000);

    const data = await page.evaluate(() => {
      // Look for the typical markdown body class used by DeepSeek
      const assistantTurns = Array.from(document.querySelectorAll('.ds-markdown, .markdown-body, .message-content, [class*="markdown"]'));
      const last = assistantTurns.at(-1) || document.querySelector('main') || document.body;
      
      let text = '';
      const paragraphs = last.querySelectorAll('p, li');
      if (paragraphs.length > 0) {
        text = Array.from(paragraphs).map(p => p.textContent).join('\n');
      } else {
        text = last.textContent ?? '';
      }
      text = text.replace(/\s+/g, ' ').trim();

      const links = Array.from(last.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .map((a) => ({ url: a.href, title: (a.textContent ?? '').trim() || undefined }))
        .filter((a) => /^https?:\/\//i.test(a.url) && !a.url.includes('deepseek.com'))
        .slice(0, 12);
      return { text, links };
    });

    const isCloudflare = /One more step before you proceed|Performing security verification|Verifies you are not a bot/i.test(data.text);
    if (data.text.length < 5 || isCloudflare) {
      await captureDebug(page, 'deepseek', 'bad-response', { isCloudflare });
      throw new Error(isCloudflare ? 'DeepSeek blocked by Cloudflare' : 'DeepSeek did not render a real assistant answer');
    }

    return { text: data.text, citations: data.links };
  } catch (err) {
    await closeDeepseekBrowser();
    throw err;
  }
}
