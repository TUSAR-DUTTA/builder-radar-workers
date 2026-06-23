import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';

let sharedCopilotBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page } | null = null;

export async function closeCopilotBrowser() {
  if (sharedCopilotBrowser) {
    await sharedCopilotBrowser.runtime.close().catch(() => {});
    sharedCopilotBrowser = null;
  }
}

export async function scrapeCopilotPrompt(prompt: string): Promise<{ text: string; citations: { url: string; title?: string }[] }> {
  if (!sharedCopilotBrowser) {
    console.log('[copilot] Launching browser...');
    const runtime = await launchSeededPersistentContext('copilot');
    const ctx = runtime.context;
    const page = await ctx.newPage();
    console.log('[copilot] Navigating to copilot.microsoft.com...');
    await page.goto('https://copilot.microsoft.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(3000);
    console.log('[copilot] Page loaded, URL:', page.url());
    sharedCopilotBrowser = { runtime, page };
  }

  const { page } = sharedCopilotBrowser;

  try {
    console.log('[copilot] Current URL:', page.url());

    // Auth check
    if (page.url().includes('login') || await page.locator('text="Sign in"').isVisible().catch(() => false)) {
      await captureDebug(page, 'copilot', 'unauthenticated');
      throw new Error('Copilot session is unauthenticated.');
    }
    console.log('[copilot] Auth OK');

    // Click "New chat" to start fresh
    const newChatBtn = await firstVisibleLocator(page, '[aria-label="New chat"], a[href="/"], button:has-text("New chat"), [title="New chat"]');
    if (newChatBtn) {
      console.log('[copilot] Clicking New Chat...');
      await newChatBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
    } else {
      console.log('[copilot] No New Chat button found, continuing on current page');
    }

    // Find the composer — Copilot uses a textarea with placeholder "Message Copilot"
    console.log('[copilot] Looking for composer...');
    let composer: import('playwright').Locator | null = null;
    for (let i = 0; i < 15; i++) {
      composer = await firstVisibleLocator(
        page,
        'textarea[placeholder*="Message"], textarea[placeholder*="Ask"], [contenteditable="true"], textarea, #userInput'
      );
      if (composer) {
        console.log(`[copilot] Found composer on attempt ${i + 1}`);
        break;
      }
      console.log(`[copilot] Composer not found attempt ${i + 1}, waiting...`);
      await page.waitForTimeout(1000);
    }

    if (!composer) {
      // Log ALL interactive elements to see what's on the page
      const debugInfo = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('textarea, input, [contenteditable]'));
        return inputs.map(el => ({
          tag: el.tagName,
          id: el.id,
          placeholder: (el as any).placeholder || '',
          className: el.className?.slice(0, 80),
          visible: (el as HTMLElement).offsetParent !== null,
        }));
      });
      console.log('[copilot] DEBUG - all inputs/editables on page:', JSON.stringify(debugInfo, null, 2));
      await captureDebug(page, 'copilot', 'missing-composer');
      throw new Error(`Copilot composer not found`);
    }

    // Dismiss cookie banner
    await page.locator('button', { hasText: 'Accept' }).last().click({ timeout: 1000 }).catch(() => {});

    console.log('[copilot] Clicking composer and typing prompt...');
    await composer.click({ timeout: 20_000 }).catch(async (err) => {
      await captureDebug(page, 'copilot', 'composer-click-timeout');
      throw err;
    });
    await composer.fill('').catch(() => {});
    await page.keyboard.insertText(`Use web search and answer this buyer question with citations:\n\n${prompt}`);

    // Submit
    await page.waitForTimeout(500);
    const submitButton = await firstVisibleLocator(page, 'button[aria-label="Submit"], button[aria-label="Send"], button[type="submit"]');
    if (submitButton) {
      console.log('[copilot] Clicking submit button...');
      const disabled = await submitButton.isDisabled().catch(() => false);
      if (!disabled) {
        await submitButton.click({ force: true, timeout: 10_000 }).catch(() => page.keyboard.press('Enter'));
      } else {
        console.log('[copilot] Submit button disabled, pressing Enter');
        await page.keyboard.press('Enter');
      }
    } else {
      console.log('[copilot] No submit button found, pressing Enter');
      await page.keyboard.press('Enter');
    }

    console.log('[copilot] Prompt sent, polling for response...');

    let lastLength = 0;
    let stableCount = 0;
    let finalData = { text: '', links: [] as any[] };

    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(2000);

      // Handle Turnstile: look for the iframe Cloudflare JS injects inside #cf-turnstile
      const tsIframe = page.locator('#cf-turnstile iframe').first();
      if (await tsIframe.isVisible().catch(() => false)) {
        console.log('[copilot] Turnstile iframe detected, attempting click...');
        try {
          const tsFrame = page.frameLocator('#cf-turnstile iframe').first();
          const checkbox = tsFrame.locator('input[type="checkbox"], .ctp-checkbox-label, body').first();
          await checkbox.click({ force: true, timeout: 5000 });
          console.log('[copilot] Turnstile clicked, waiting for token...');
          await page.waitForFunction(
            () => {
              const el = document.querySelector<HTMLInputElement>('[id^="cf-chl-widget"][id$="_response"]');
              return el && el.value.length > 0;
            },
            { timeout: 15_000 }
          ).catch(() => console.log('[copilot] Turnstile token not received within 15s'));
        } catch (e) {
          console.log('[copilot] Turnstile click failed:', e);
        }
        await page.waitForTimeout(2000);
      }

      // Probe what's in the DOM to find the actual response selector
      const data = await page.evaluate(() => {
        // Try multiple selectors Copilot has used historically
        const selectors = [
          '[data-content="ai-message"]',
          '[class*="response"] p',
          '[class*="answer"] p', 
          '[class*="message"][class*="ai"] p',
          'cib-message-group[source="bot"] cib-message',
          '[data-testid="content-card"]',
          '.ac-textBlock p',
          '.content.content p',
          // Broad fallback: any paragraph inside the main content area
          'main p',
        ];

        for (const sel of selectors) {
          const items = Array.from(document.querySelectorAll(sel));
          if (items.length > 0) {
            const text = items.map(el => el.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
            if (text.length > 20) {
              return { text, sel, links: [] as any[] };
            }
          }
        }
        return null;
      });

      if (data) {
        console.log(`[copilot] iter ${i}: found "${data.sel}" len=${data.text.length}`);
        if (data.text.length > lastLength) {
          lastLength = data.text.length;
          stableCount = 0;
          finalData = data;
        } else if (data.text.length > 40) {
          stableCount++;
          if (stableCount >= 3) {
            console.log('[copilot] Response stable, done');
            break;
          }
        }
      } else {
        console.log(`[copilot] iter ${i}: no response yet`);
      }
    }

    const { text: answer, links } = finalData;

    // Capture DOM for debugging
    await captureDebug(page, 'copilot', 'dom-dump', { captured: answer.slice(0, 300) });

    const UI_CHROME = /message copilot|what should we dive into/i;
    if (answer.length < 20 || UI_CHROME.test(answer)) {
      await captureDebug(page, 'copilot', 'bad-response', { captured: answer.slice(0, 200) });
      throw new Error('Copilot did not render a real assistant answer');
    }

    console.log('[copilot] SUCCESS, answer length:', answer.length);
    return { text: answer, citations: links };
  } catch (err) {
    await closeCopilotBrowser();
    throw err;
  }
}
