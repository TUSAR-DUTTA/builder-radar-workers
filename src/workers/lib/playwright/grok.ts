import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';
import { isGrokTurnCorrelated, GrokTurnSnapshot, GrokTurnCandidate } from './grok-turn-binding';
import { BrowserCapture, buildProvenance } from './capture-contract';

export let sharedGrokBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page } | null = null;

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

    const snapshot = await page.evaluate(() => {
      const assistantTurns = Array.from(document.querySelectorAll('.markdown, .message.assistant, [class*="message"][class*="assistant"]'));
      const userTurns = Array.from(document.querySelectorAll('.message.user, [class*="message"][class*="user"]'));
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
    await composer.press('Enter');

    // Wait for response to stream and stabilize
    let stableCount = 0;
    let finalData = { text: '', links: [] as any[] };
    let previousText = '';
    
    for (let i = 0; i < 45; i++) {
      await page.waitForTimeout(1000);
      const data = await page.evaluate((expectedPrompt) => {
        const assistantTurns = Array.from(document.querySelectorAll('.markdown, .message.assistant, [class*="message"][class*="assistant"]'));
        const userTurns = Array.from(document.querySelectorAll('.message.user, [class*="message"][class*="user"]'));
        if (assistantTurns.length === 0) return null;
        
        let lastMatchingUserIndex = -1;
        let matchingUserNode = null;
        const normalizedWanted = expectedPrompt.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
        for (let j = userTurns.length - 1; j >= 0; j--) {
           const text = (userTurns[j].textContent || '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
           if (text.includes(normalizedWanted)) {
              lastMatchingUserIndex = j + 1; // 1-indexed to match count
              matchingUserNode = userTurns[j];
              break;
           }
        }
        
        const last = assistantTurns.at(-1)!;
        const assistantFollowsMatchingUser = matchingUserNode ? !!(matchingUserNode.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
        
        const busy = !!document.querySelector('[aria-busy="true"], [class*="streaming"], [class*="loading"]');
        
        let text = (last as HTMLElement).innerText || last.textContent || '';
        text = text.replace(/\s+/g, ' ').trim();

        const links = Array.from(last.querySelectorAll<HTMLAnchorElement>('a[href]'))
          .map((a) => ({ url: a.href, title: (a.textContent ?? '').trim() || undefined }))
          .filter((a) => /^https?:\/\//i.test(a.url) && !a.url.includes('grok.com') && !a.url.includes('x.com'))
          .slice(0, 12);
        
        return { 
          candidate: {
            assistantCount: assistantTurns.length,
            userCount: userTurns.length,
            lastMatchingUserIndex,
            assistantFollowsMatchingUser,
            text,
            busy,
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

      if (candidate.text.length > 5 && candidate.text === previousText) {
        stableCount++;
        finalData = { text: candidate.text, links };
        if (stableCount >= 3) break; // stable for 3 seconds
      } else {
        stableCount = 0;
        previousText = candidate.text;
      }
    }

    if (finalData.text.length < 5) {
      await captureDebug(page, 'grok', 'bad-response-or-unbound');
      throw new Error('prompt_identity_unverified:grok did not render a real assistant answer or failed to bind prompt');
    }

    return { 
      rawAnswer: finalData.text, 
      citations: finalData.links,
      provenance: buildProvenance('grok')
    };
  } catch (err) {
    await closeGrokBrowser();
    throw err;
  }
}
