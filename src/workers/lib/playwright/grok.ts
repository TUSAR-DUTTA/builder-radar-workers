import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';

let sharedGrokBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page } | null = null;

export async function closeGrokBrowser() {
  if (sharedGrokBrowser) {
    await sharedGrokBrowser.runtime.close().catch(() => {});
    sharedGrokBrowser = null;
  }
}

export async function scrapeGrokPrompt(prompt: string): Promise<{ text: string; citations: { url: string; title?: string }[] }> {
  if (!sharedGrokBrowser) {
    const runtime = await launchSeededPersistentContext('grok');
    const ctx = runtime.context;
    const page = await ctx.newPage();
    await page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(2500);
    sharedGrokBrowser = { runtime, page };
  }

  const { page } = sharedGrokBrowser;

  try {
    await page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1000);

    if (page.url().includes('login') || await page.locator('text="Sign in"').isVisible().catch(() => false)) {
      await captureDebug(page, 'grok', 'unauthenticated');
      throw new Error('Grok session is unauthenticated (redirected to login page).');
    }

    let composer: import('playwright').Locator | null = null;
    for (let i = 0; i < 15; i++) {
      composer = await firstVisibleLocator(page, '[contenteditable="true"], textarea, #grok-input, [placeholder*="Ask"]');
      if (composer) break;
      await page.waitForTimeout(1000);
    }

    if (!composer) {
      await captureDebug(page, 'grok', 'missing-composer');
      throw new Error(`Grok composer not found`);
    }

    await composer.click({ timeout: 20_000, force: true }).catch(() => {});
    await composer.fill('');
    await page.keyboard.insertText(prompt);
    await composer.press('Enter');

    await page.waitForTimeout(5000);

    const data = await page.evaluate(() => {
      const assistantTurns = Array.from(document.querySelectorAll('.grok-response, .message.assistant, [class*="message-content"], .markdown'));
      
      // Filter out navigation/footer links by preferring main content
      const mainContainer = document.querySelector('main') || document.body;
      const last = assistantTurns.at(-1) || mainContainer;
      
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
        .filter((a) => /^https?:\/\//i.test(a.url) && !a.url.includes('grok.com') && !a.url.includes('x.com'))
        .slice(0, 12);
      return { text, links };
    });

    if (data.text.length < 5) {
      await captureDebug(page, 'grok', 'bad-response');
      throw new Error('Grok did not render a real assistant answer');
    }

    return { text: data.text, citations: data.links };
  } catch (err) {
    await closeGrokBrowser();
    throw err;
  }
}
