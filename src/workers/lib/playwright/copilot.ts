import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';

let sharedCopilotBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page } | null = null;
let copilotDomDumped = false;

export async function closeCopilotBrowser() {
  if (sharedCopilotBrowser) {
    await sharedCopilotBrowser.runtime.close().catch(() => {});
    sharedCopilotBrowser = null;
  }
}

export async function scrapeCopilotPrompt(prompt: string): Promise<{ text: string; citations: { url: string; title?: string }[] }> {
  if (!sharedCopilotBrowser) {
    const runtime = await launchSeededPersistentContext('copilot');
    const ctx = runtime.context;
    const page = await ctx.newPage();
    await page.goto('https://copilot.microsoft.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(2500);
    sharedCopilotBrowser = { runtime, page };
  }

  const { page } = sharedCopilotBrowser;

  try {
    await page.goto('https://copilot.microsoft.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1000);

    if (page.url().includes('login') || await page.locator('text="Sign in"').isVisible().catch(() => false)) {
      await captureDebug(page, 'copilot', 'unauthenticated');
      throw new Error('Copilot session is unauthenticated (redirected to login page).');
    }

    let composer: import('playwright').Locator | null = null;
    for (let i = 0; i < 15; i++) {
      composer = await firstVisibleLocator(page, '[contenteditable="true"], textarea, #searchbox, [aria-label*="Ask"], [placeholder*="Ask"]');
      if (composer) break;
      await page.waitForTimeout(1000);
    }

    if (!composer) {
      await captureDebug(page, 'copilot', 'missing-composer');
      throw new Error(`Copilot composer not found`);
    }

    await composer.click({ timeout: 20_000, force: true }).catch(() => {});
    // Dismiss cookie banner which steals focus
    await page.locator('button:has-text("Accept")').click({ timeout: 1000 }).catch(() => {});
    await composer.fill('');
    await page.keyboard.insertText(prompt);
    await composer.press('Enter');
    // Fallback: click the send button if Enter didn't work
    await page.locator('button[aria-label="Submit"], button[title="Submit"], button[aria-label="Send"], button[title="Send"]').click({ timeout: 2000 }).catch(() => {});

    // Copilot streams its reply. Poll until a real assistant message appears AND stops growing 
    // (streaming finished), pick the best message-like block, and reject the UI-chrome shell
    // so a bad grab fails loudly (captureDebug) instead of silently saving junk.
    const UI_CHROME = /message copilot|what should we dive into/i;

    let answer = '';
    let stableTicks = 0;
    for (let i = 0; i < 60; i++) {            // up to ~120s of streaming
      await page.waitForTimeout(2000);

      // Fail fast if unauthenticated popup appears
      if (await page.locator('text="Sign in to ask more questions"').isVisible().catch(() => false) || await page.locator('text="Sign in"').isVisible().catch(() => false)) {
        await captureDebug(page, 'copilot', 'unauthenticated-during-chat');
        throw new Error('Copilot session is unauthenticated (redirected to login page).');
      }
      const text = await page.evaluate(() => {
        // Priority 1: Explicitly bot-authored blocks (new and old UI variants)
        const botBlocks = Array.from(document.querySelectorAll(
          '[data-content="ai-message"], [data-author="bot"], [data-author="copilot"], '
          + '[data-message-author="bot"], [data-message-author="copilot"]'
        ));
        if (botBlocks.length > 0) {
          // Get the very last bot block in the page
          const lastBotBlock = botBlocks[botBlocks.length - 1];
          return (lastBotBlock.textContent ?? '').replace(/\s+/g, ' ').trim();
        }

        // Priority 2: Fallback to generic message containers, explicitly excluding user-prompt echo
        const candidates = Array.from(document.querySelectorAll(
          '.response-message, [class*="responseMessage"], [class*="message-body"], '
          + '[class*="markdown"], .markdown, [role="article"]'
        ));
        const texts = candidates
          .map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim())
          .filter((t) => t.length > 0 && !/^you said/i.test(t) && !/^message copilot/i.test(t));
        return texts.sort((a, b) => b.length - a.length)[0] ?? '';
      });
      if (text && !UI_CHROME.test(text)) {
        if (text === answer) {
          stableTicks += 1;
          if (stableTicks >= 2) break;        // unchanged twice → streaming done
        } else {
          answer = text;
          stableTicks = 0;
        }
      }
    }

    // One-time diagnostic: dump the full answer-area DOM so the assistant-message selector can be
    // pinned from real markup instead of guessed.
    if (!copilotDomDumped) {
      copilotDomDumped = true;
      await captureDebug(page, 'copilot', 'dom-dump', { captured: answer.slice(0, 300) });
    }

    const links = await page.evaluate(() => {
      const scope = document.querySelector('[data-content="ai-message"], .response-message, [class*="message-body"]') || document.body;
      return Array.from(scope.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .map((a) => ({ url: a.href, title: (a.textContent ?? '').trim() || undefined }))
        .filter((a) => /^https?:\/\//i.test(a.url) && !a.url.includes('microsoft.com') && !a.url.includes('bing.com'))
        .slice(0, 12);
    });

    if (answer.length < 20 || UI_CHROME.test(answer)) {
      await captureDebug(page, 'copilot', 'bad-response', { captured: answer.slice(0, 200) });
      throw new Error('Copilot did not render a real assistant answer');
    }

    return { text: answer, citations: links };
  } catch (err) {
    await closeCopilotBrowser();
    throw err;
  }
}
