import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';

let sharedClaudeBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page } | null = null;

const CLAUDE_ASSISTANT_SELECTOR = '.font-claude-response, [data-message-author-role="assistant"], [data-testid*="assistant-message"]';

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

    const turnSnapshot = await page.evaluate((assistantSelector) => document.querySelectorAll(assistantSelector).length, CLAUDE_ASSISTANT_SELECTOR);

    await composer.click({ timeout: 20_000, force: true }).catch(() => {});
    await composer.fill('');
    await page.keyboard.insertText(`Use web search and answer this buyer question with citations:\n\n${prompt}`);
    await composer.press('Enter');

    try {
      await page.waitForFunction(({ assistantSelector, previousCount, expectedPrompt }) => {
        const messages = document.querySelectorAll<HTMLElement>(assistantSelector);
        if (messages.length <= previousCount) return false;
        const last = messages[messages.length - 1];
        const container = last.closest('[data-is-streaming]');
        if (container?.getAttribute('data-is-streaming') === 'true') return false;
        const text = (last.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text.length < 40) return false;

        const wanted = expectedPrompt.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
        const nodes = document.querySelectorAll<HTMLElement>('main *, [role="main"] *');
        for (let index = 0; index < nodes.length; index += 1) {
          const rendered = (nodes[index].textContent ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
          if (rendered.includes(wanted)) return true;
        }
        return false;
      }, { assistantSelector: CLAUDE_ASSISTANT_SELECTOR, previousCount: turnSnapshot, expectedPrompt: prompt }, { timeout: 180_000 });
    } catch {
      await captureDebug(page, 'claude', 'prompt-binding-timeout');
      throw new Error('prompt_identity_unverified:new_claude_turn_not_bound_to_submitted_prompt');
    }
    await page.waitForTimeout(2000);

    const data = await page.evaluate(() => {
      const assistantTurns = document.querySelectorAll<HTMLElement>('.font-claude-response, [data-message-author-role="assistant"], [data-testid*="assistant-message"]');
      const last = assistantTurns.length ? assistantTurns[assistantTurns.length - 1] : undefined;
      if (!last) return { text: '', links: [] };
      const text = (last.textContent ?? '').replace(/\s+/g, ' ').trim();
      const links: { url: string; title?: string }[] = [];
      const anchors = last.querySelectorAll<HTMLAnchorElement>('a[href]');
      for (let index = 0; index < anchors.length && links.length < 12; index += 1) {
        const anchor = anchors[index];
        if (/^https?:\/\//i.test(anchor.href) && !anchor.href.includes('claude.ai')) {
          links.push({ url: anchor.href, title: (anchor.textContent ?? '').trim() || undefined });
        }
      }
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
