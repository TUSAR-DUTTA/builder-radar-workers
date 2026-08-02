import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';
import { isGrokTurnCorrelated } from './grok-turn-binding';
import { BrowserCapture, buildProvenance, type TerminalProof, type BrowserConnectionMetadata } from './capture-contract';

export let sharedGrokBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page, connectionMeta: BrowserConnectionMetadata } | null = null;

export async function closeGrokBrowser() {
  if (sharedGrokBrowser) {
    await sharedGrokBrowser.runtime.close().catch(() => {});
    sharedGrokBrowser = null;
  }
}

export async function scrapeGrokPrompt(prompt: string): Promise<BrowserCapture> {
  if (!sharedGrokBrowser) {
    const runtime = await launchSeededPersistentContext('grok');
    const ctx = runtime.context;
    const page = await ctx.newPage();
    await page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(2500);
    sharedGrokBrowser = { runtime, page, connectionMeta: runtime.connectionMeta };
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
      composer = await firstVisibleLocator(
        page,
        '#grok-input, [contenteditable="true"], textarea, [placeholder*="Ask"], [placeholder*="What"], [aria-label*="Ask"], [aria-label*="prompt"]'
      );
      if (composer) break;
      await page.waitForTimeout(1000);
    }

    if (!composer) {
      await captureDebug(page, 'grok', 'missing-composer');
      throw new Error(`Grok composer not found`);
    }

    const snapshot = await page.evaluate(() => {
      const userSelector = [
        'div[data-testid*="user"]',
        'div[data-message-author-role="user"]',
        '.message.user',
        '[class*="message"][class*="user"]',
        '.query-text',
      ].join(', ');

      const assistantSelector = [
        'div[data-testid*="assistant"]',
        'div[data-message-author-role="assistant"]',
        'div[data-testid*="response"]',
        'div.response-content',
        'div.response-body',
        '.message.assistant',
        '[class*="message"][class*="assistant"]',
      ].join(', ');

      const userTurns = Array.from(document.querySelectorAll<HTMLElement>(userSelector));
      let assistantTurns = Array.from(document.querySelectorAll<HTMLElement>(assistantSelector));
      assistantTurns = assistantTurns.filter(a => !userTurns.some(u => u.contains(a) || u === a));
      const lastAssistant = assistantTurns.at(-1);
      return {
        assistantCount: assistantTurns.length,
        userCount: userTurns.length,
        lastAssistantText: lastAssistant ? (lastAssistant.textContent ?? '') : ''
      };
    });

    await composer.click({ timeout: 20_000, force: true }).catch(() => {});
    await composer.fill('');
    await page.keyboard.insertText(prompt);
    await page.waitForTimeout(300);

    const submitBtn = await firstVisibleLocator(
      page,
      'button[aria-label*="Send"], button[aria-label*="Submit"], button[aria-label*="Ask"], button[type="submit"], button:has(svg.lucide-arrow-up), button:has(svg.lucide-send), button.bg-white, [data-testid="send-button"]'
    );
    if (submitBtn) {
      const disabled = await submitBtn.isDisabled().catch(() => false);
      if (!disabled) {
        await submitBtn.click().catch(() => {});
      } else {
        await composer.press('Enter');
      }
    } else {
      await composer.press('Enter');
    }
    await page.waitForTimeout(500);

    // Wait for response to stream and stabilize
    let stableCount = 0;
    let finalData = { text: '', links: [] as any[] };
    let previousText = '';
    const maxIterations = 90; // 90 seconds max
    
    for (let i = 0; i < maxIterations; i++) {
      await page.waitForTimeout(1000);

      // If at 5s/10s the composer still contains text and no assistant response is found, re-trigger submission
      if ((i === 4 || i === 9) && !finalData.text) {
        // Check if a user turn with the prompt already exists before retrying
        const hasExistingUserTurn = await page.evaluate((expectedPrompt) => {
          const normalizedWanted = expectedPrompt.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
          const userEls = document.querySelectorAll<HTMLElement>('div[data-testid*="user"], div[data-message-author-role="user"], .message.user, [class*="message"][class*="user"], .query-text');
          return Array.from(userEls).some(el => {
            const text = (el.innerText || el.textContent || '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
            return text.includes(normalizedWanted);
          });
        }, prompt).catch(() => false);

        if (!hasExistingUserTurn) {
          const composerText = await composer.inputValue().catch(() => '') || await composer.innerText().catch(() => '');
          if (composerText && composerText.trim().length > 0) {
            const retryBtn = await firstVisibleLocator(page, 'button[aria-label*="Send"], button[aria-label*="Submit"], button[type="submit"]');
            if (retryBtn) await retryBtn.click().catch(() => {});
            await composer.press('Enter').catch(() => {});
          }
        }
      }

      const data = await page.evaluate((expectedPrompt) => {
        const userSelector = [
          'div[data-testid*="user"]',
          'div[data-message-author-role="user"]',
          '.message.user',
          '[class*="message"][class*="user"]',
          '.query-text',
        ].join(', ');

        const assistantSelector = [
          'div[data-testid*="assistant"]',
          'div[data-message-author-role="assistant"]',
          'div[data-testid*="response"]',
          'div.response-content',
          'div.response-body',
          '.message.assistant',
          '[class*="message"][class*="assistant"]',
        ].join(', ');

        const userTurns = Array.from(document.querySelectorAll<HTMLElement>(userSelector));
        const normalizedWanted = expectedPrompt.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();

        let matchingUserNode: HTMLElement | null = null;
        let lastMatchingUserIndex = -1;

        if (normalizedWanted) {
          for (let j = userTurns.length - 1; j >= 0; j--) {
            const text = (userTurns[j].innerText || userTurns[j].textContent || '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
            if (text.includes(normalizedWanted)) {
              lastMatchingUserIndex = j + 1; // 1-indexed to match count
              matchingUserNode = userTurns[j];
              break;
            }
          }


        }

        let assistantTurns = Array.from(document.querySelectorAll<HTMLElement>(assistantSelector));
        assistantTurns = assistantTurns.filter(a => !userTurns.some(u => u.contains(a) || u === a));

        // If matchingUserNode is found, find following elements that could be the assistant turn
        let targetAssistant: HTMLElement | null = null;
        if (matchingUserNode) {
          const followingAssistantTurns = assistantTurns.filter(a => 
            !!(matchingUserNode!.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)
          );
          if (followingAssistantTurns.length > 0) {
            targetAssistant = followingAssistantTurns.reduce((prev, curr) => 
              ((curr.innerText || curr.textContent || '').length > (prev.innerText || prev.textContent || '').length) ? curr : prev
            );
          }
        } else if (assistantTurns.length > 0) {
          targetAssistant = assistantTurns.at(-1)!;
        }

        if (!targetAssistant) return null;

        const assistantFollowsMatchingUser = matchingUserNode
          ? !!(matchingUserNode.compareDocumentPosition(targetAssistant) & Node.DOCUMENT_POSITION_FOLLOWING)
          : false;

        const busy = !!document.querySelector('[aria-busy="true"], [class*="streaming"], [class*="loading"], button[aria-label*="Stop"], button[aria-label*="stop"], [data-testid="stop-button"], [class*="animate-spin"], [class*="animate-pulse"]')
          || Array.from(document.querySelectorAll<HTMLButtonElement>('button')).some(b => (b.textContent || '').trim().toLowerCase() === 'stop');

        let text = (targetAssistant as HTMLElement).innerText || targetAssistant.textContent || '';
        text = text.replace(/\s+/g, ' ').trim();

        const links = Array.from(targetAssistant.querySelectorAll<HTMLAnchorElement>('a[href]'))
          .map((a) => ({ url: a.href, title: (a.textContent ?? '').trim() || undefined }))
          .filter((a) => /^https?:\/\//i.test(a.url) && !a.url.includes('grok.com') && !a.url.includes('x.com'))
          .slice(0, 12);

        return {
          candidate: {
            assistantCount: assistantTurns.length || 1,
            userCount: userTurns.length,
            lastMatchingUserIndex,
            assistantFollowsMatchingUser,
            text,
            busy,
            promptBound: matchingUserNode !== null,
          },
          links
        };
      }, prompt);

      if (!data) continue;

      const { candidate, links } = data;
      // Note: isGrokTurnCorrelated runs in node context
      if (!isGrokTurnCorrelated(snapshot, candidate)) {
        continue;
      }

      if (candidate.text.length >= 80 && candidate.text === previousText && !candidate.busy) {
        stableCount++;
        finalData = { text: candidate.text, links };
        if (stableCount >= 3) break; // stable for 3 seconds
      } else {
        stableCount = 0;
        previousText = candidate.text;
      }
    }

    if (finalData.text.length < 50) {
      await captureDebug(page, 'grok', 'bad-response-or-unbound');
      throw new Error('prompt_identity_unverified:grok did not render a real assistant answer or failed to bind prompt');
    }

    const { connectionMeta } = sharedGrokBrowser!;
    const uiLocale = await page.evaluate(() => document.documentElement.lang || 'en-US').catch(() => 'en-US');
    connectionMeta.locale = uiLocale;

    const terminalProof: TerminalProof = {
      providerState: 'complete',
      userTurnId: 'grok-user-turn',
      assistantTurnId: 'grok-assistant-turn',
      answerNodeId: 'grok-answer-node',
      terminalSignal: `stable_text:${stableCount}`,
      stableChecks: stableCount,
    };

    return { 
      rawAnswer: finalData.text, 
      citations: finalData.links,
      provenance: buildProvenance('grok', { terminalProof }, connectionMeta)
    };
  } catch (err) {
    await closeGrokBrowser();
    throw err;
  }
}
