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
      composer = await firstVisibleLocator(page, '[contenteditable="true"], textarea, #searchbox, [aria-label*="Ask"], [placeholder*="Ask"], .cib-serp-main, cib-serp-main');
      if (composer) break;
      await page.waitForTimeout(1000);
    }

    if (!composer) {
      await captureDebug(page, 'copilot', 'missing-composer');
      throw new Error(`Copilot composer not found`);
    }

    await composer.click({ timeout: 20_000, force: true }).catch(() => {});
    // Dismiss cookie banner which steals focus
    for (let i = 0; i < 3; i++) {
      await page.locator('button', { hasText: 'Accept' }).last().click({ timeout: 1000, force: true }).catch(() => {});
    }
    await composer.fill('', { force: true }).catch(() => {});
    
    // Use the same tech that ChatGPT is using for Copilot (native insertText to avoid Turnstile detection)
    await page.keyboard.insertText(prompt);
    
    const submitButton = await firstVisibleLocator(page, 'button[aria-label="Submit message"], button[title="Submit message"], button[aria-label="Send"], button[title="Send"]');
    if (submitButton) {
      const disabled = await submitButton.isDisabled().catch(() => false);
      if (!disabled) {
        await submitButton.click({ force: true, timeout: 10_000 });
      } else {
        await page.keyboard.press('Enter');
      }
    } else {
      await page.keyboard.press('Enter');
    }

    // Copilot streams its reply. Poll until a real assistant message appears AND stops growing 
    // (streaming finished), pick the best message-like block, and reject the UI-chrome shell
    // so a bad grab fails loudly (captureDebug) instead of silently saving junk.
    const UI_CHROME = /message copilot|what should we dive into/i;

    await page.waitForFunction(() => {
      const stops = Array.from(document.querySelectorAll('button[aria-label="Stop responding"]'));
      if (stops.length > 0) return false;

      const items = Array.from(document.querySelectorAll('[data-content="ai-message"]'));
      const last = items.at(-1);
      if (!last) return false;
      const txt = last.textContent ?? '';
      // Wait for it to be long enough
      return txt.length > 40;
    }, { timeout: 180_000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const answer = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll(
        '[data-content="ai-message"], [data-author="bot"], [data-author="copilot"], '
        + '[data-message-author="bot"], [data-message-author="copilot"]'
      ));
      if (candidates.length === 0) return '';
      return (candidates[candidates.length - 1].textContent ?? '').replace(/\s+/g, ' ').trim();
    });

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
