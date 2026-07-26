import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';

let sharedGrokBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page } | null = null;

const GROK_ASSISTANT_SELECTOR = '.grok-response, .message.assistant, [class*="message"][class*="assistant"], [data-message-author-role="assistant"], [data-role="assistant"], [data-testid*="assistant-message"], article .markdown';
const GROK_USER_SELECTOR = '.message.user, [class*="message"][class*="user"], [data-message-author-role="user"], [data-role="user"], [data-testid*="user-message"]';

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

    const turnSnapshot = await page.evaluate((assistantSelector) => {
      const turns = document.querySelectorAll<HTMLElement>(assistantSelector);
      const last = turns.length ? turns[turns.length - 1] : undefined;
      return {
        assistantCount: turns.length,
        lastAssistantText: (last?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      };
    }, GROK_ASSISTANT_SELECTOR);

    await composer.click({ timeout: 20_000, force: true }).catch(() => {});
    await composer.fill('');
    await page.keyboard.insertText(prompt);
    await composer.press('Enter');

    // Require a newly rendered assistant turn bound to the submitted user prompt. Never fall back
    // to page chrome or a previous response when the current turn cannot be proven.
    const deadline = Date.now() + 180_000;
    let stableChecks = 0;
    let previousText = '';
    let data: { text: string; links: { url: string; title?: string }[] } | null = null;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      const candidate = await page.evaluate(({ assistantSelector, userSelector, expectedPrompt, snapshot }) => {
        const assistantTurns = document.querySelectorAll<HTMLElement>(assistantSelector);
        const userTurns = document.querySelectorAll<HTMLElement>(userSelector);
        const lastAssistant = assistantTurns.length ? assistantTurns[assistantTurns.length - 1] : undefined;
        if (!lastAssistant) return null;

        let promptBound = false;
        const wanted = expectedPrompt.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
        for (let index = userTurns.length - 1; index >= 0; index -= 1) {
          const rendered = (userTurns[index].textContent ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
          if (rendered.includes(wanted)) {
            promptBound = true;
            break;
          }
        }

        const text = (lastAssistant.textContent ?? '').replace(/\s+/g, ' ').trim();
        const isNew = assistantTurns.length > snapshot.assistantCount || text !== snapshot.lastAssistantText;
        const busy = lastAssistant.querySelector('[aria-busy="true"], [class*="loading"], [class*="spinner"], [data-testid*="loading"]');
        if (!promptBound || !isNew || busy || text.length < 40) return null;

        const links: { url: string; title?: string }[] = [];
        const anchors = lastAssistant.querySelectorAll<HTMLAnchorElement>('a[href]');
        for (let index = 0; index < anchors.length && links.length < 12; index += 1) {
          const anchor = anchors[index];
          if (/^https?:\/\//i.test(anchor.href) && !anchor.href.includes('grok.com') && !anchor.href.includes('x.com')) {
            links.push({ url: anchor.href, title: (anchor.textContent ?? '').trim() || undefined });
          }
        }
        return { text, links };
      }, {
        assistantSelector: GROK_ASSISTANT_SELECTOR,
        userSelector: GROK_USER_SELECTOR,
        expectedPrompt: prompt,
        snapshot: turnSnapshot,
      });
      if (!candidate) continue;
      if (candidate.text === previousText) stableChecks += 1;
      else stableChecks = 0;
      previousText = candidate.text;
      data = candidate;
      if (stableChecks >= 2) break;
    }

    if (!data || stableChecks < 2) {
      await captureDebug(page, 'grok', 'prompt-binding-timeout');
      throw new Error('prompt_identity_unverified:new_grok_turn_not_bound_to_submitted_prompt');
    }

    return { text: data.text, citations: data.links };
  } catch (err) {
    await closeGrokBrowser();
    throw err;
  }
}
