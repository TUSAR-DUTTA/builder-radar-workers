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

    // Dismiss cookie banner which steals focus
    for (let i = 0; i < 3; i++) {
      await page.locator('button', { hasText: 'Accept' }).last().click({ timeout: 1000 }).catch(() => {});
    }

    await composer.click({ timeout: 20_000 }).catch(async (err) => {
      await captureDebug(page, 'copilot', 'composer-click-timeout');
      throw err;
    });
    await composer.fill('').catch(() => {});
    await page.keyboard.insertText(`Use web search and answer this buyer question with citations:\n\n${prompt}`);
    
    // Use the same tech that chatgpt is using: click the submit button if available
    await page.waitForTimeout(500);
    const submitButton = await firstVisibleLocator(page, 'button[title="Submit"], button[aria-label*="Submit"], button[aria-label*="Send"]');
    if (submitButton) {
      const disabled = await submitButton.isDisabled().catch(() => false);
      if (!disabled) {
        await submitButton.click({ force: true, timeout: 10_000 }).catch(() => page.keyboard.press('Enter'));
      } else {
        await page.keyboard.press('Enter');
      }
    } else {
      await page.keyboard.press('Enter');
    }

    let lastLength = 0;
    let stableCount = 0;
    let finalData = { text: '', links: [] as any[] };

    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(2000);

      // Check and click Cloudflare Turnstile if it appears
      const turnstileFrame = page.frameLocator('iframe[src*="cloudflare.com"]');
      if (await turnstileFrame.locator('body').count().catch(() => 0) > 0) {
        const tsWidget = turnstileFrame.locator('body');
        // If we see the red error (Verification failed), reload the page and try again?
        // But for now, let's just try a simple standard Playwright click which fires trusted events.
        await tsWidget.click({ delay: Math.random() * 50 + 50, force: true }).catch(() => {});
        await page.waitForTimeout(2000);
      }

      const data = await page.evaluate(() => {
        // Check if generation has stopped
        const stops = Array.from(document.querySelectorAll('button[aria-label="Stop responding"]'));
        const isGenerating = stops.length > 0;

        const items = Array.from(document.querySelectorAll('[data-content="ai-message"]'));
        const last = items.at(-1);
        if (!last) return { text: '', links: [], isGenerating };

        const text = (last.textContent ?? '').replace(/\s+/g, ' ').trim();
        const links = Array.from(last.querySelectorAll<HTMLAnchorElement>('a[href]'))
          .map((a) => ({ url: a.href, title: (a.textContent ?? '').trim() || undefined }))
          .filter((a) => /^https?:\/\//i.test(a.url) && !a.url.includes('bing.com') && !a.url.includes('microsoft.com'))
          .slice(0, 12);
          
        return { text, links, isGenerating };
      });

      if (data && data.text.length > 40) {
        if (!data.isGenerating) {
          if (data.text.length > lastLength) {
            lastLength = data.text.length;
            stableCount = 0;
            finalData = data;
          } else {
            stableCount++;
            if (stableCount >= 2) break; // stable for 4 seconds without "Stop responding"
          }
        } else {
          // It is generating, update final data but don't increment stableCount
          finalData = data;
          lastLength = data.text.length;
          stableCount = 0;
        }
      }
    }

    const { text: answer, links } = finalData;

    // One-time diagnostic: dump the full answer-area DOM so the assistant-message selector can be
    // pinned from real markup instead of guessed.
    if (!copilotDomDumped) {
      copilotDomDumped = true;
      await captureDebug(page, 'copilot', 'dom-dump', { captured: answer.slice(0, 300) });
    }


    const UI_CHROME = /message copilot|what should we dive into/i;
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
