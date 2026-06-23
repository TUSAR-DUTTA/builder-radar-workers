import { launchSeededPersistentContext, captureDebug, firstVisibleLocator, PlaywrightContextHandle } from './shared';

function isBadChatGPTResponse(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return (
    !normalized ||
    normalized === 'ChatGPT said:' ||
    /window\.__oai_/i.test(normalized) ||
    normalized.length < 5 ||
    normalized === 'ChatGPT can make mistakes. Check important info.' ||
    /Something went wrong while generating the response/i.test(normalized) ||
    /If this issue persists.*help\.openai\.com/i.test(normalized)
  );
}

function chatGPTForbiddenUrls(urls: string[]): string[] {
  const patterns = [
    '/backend-api/me',
    '/backend-api/conversation/init',
    '/backend-api/f/conversation/prepare',
    '/backend-api/sentinel/chat-requirements/prepare',
    'account_bootstrap_forbidden',
  ];
  return urls.filter((url) => patterns.some((pattern) => url.includes(pattern)));
}

let sharedChatGPTBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page, forbidden: string[] } | null = null;

export async function closeChatGPTBrowser() {
  if (sharedChatGPTBrowser) {
    await sharedChatGPTBrowser.runtime.close().catch(() => {});
    sharedChatGPTBrowser = null;
  }
}

export async function scrapeChatGPTPrompt(prompt: string): Promise<{ text: string; citations: { url: string; title?: string }[] }> {
  if (!sharedChatGPTBrowser) {
    const runtime = await launchSeededPersistentContext('openai-search');
    const ctx = runtime.context;
    const page = await ctx.newPage();
    const forbidden: string[] = [];
    page.on('response', (res) => {
      if (res.status() === 403 && res.url().includes('chatgpt.com/')) forbidden.push(res.url());
    });

    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(2500);

    const authFailures = chatGPTForbiddenUrls(forbidden);
    if (authFailures.length) {
      await captureDebug(page, 'chatgpt', 'auth-403-before-send', { forbidden: authFailures.slice(0, 12) });
      throw new Error('ChatGPT session rejected browser automation: backend API returned 403 before send');
    }
    sharedChatGPTBrowser = { runtime, page, forbidden };
  }

  const { page, forbidden } = sharedChatGPTBrowser;
  forbidden.length = 0; // Clear previous errors

  try {
    const composer = await firstVisibleLocator(
      page,
      '#prompt-textarea[role="textbox"], div[contenteditable="true"][aria-label="Chat with ChatGPT"], textarea[aria-label="Chat with ChatGPT"]',
    );
    if (!composer) {
      await captureDebug(page, 'chatgpt', 'missing-composer');
      throw new Error(`ChatGPT composer not found at ${page.url()} title="${await page.title().catch(() => '')}"`);
    }
    await composer.click({ timeout: 20_000, force: true }).catch(async (err) => {
      await captureDebug(page, 'chatgpt', 'composer-click-timeout');
      throw err;
    });
    await composer.fill('', { force: true }).catch(() => {});
    await page.keyboard.insertText(`Use web search and answer this buyer question with citations:\n\n${prompt}`);
    const submitButton = await firstVisibleLocator(page, '#composer-submit-button, button[aria-label="Send prompt"]');
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

    await page.waitForFunction(() => {
      const turns = Array.from(document.querySelectorAll('section[data-testid^="conversation-turn-"][data-turn="assistant"]'));
      const last = turns.at(-1);
      if (!last) return false;
      const busy = last.querySelector('[aria-busy="true"]');
      if (busy) return false;
      const text = (last.textContent ?? '').replace(/\s+/g, ' ').trim();
      return text.length > 'ChatGPT said:'.length + 40;
    }, { timeout: 180_000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const data = await page.evaluate(() => {
      const assistantTurns = Array.from(document.querySelectorAll<HTMLElement>(
        'section[data-testid^="conversation-turn-"][data-turn="assistant"], [data-message-author="assistant"], .markdown, .agent-turn, article'
      ));
      const last = assistantTurns.at(-1);

      if (!last) {
        return { text: '', links: [] };
      }

      // Strip screenreader labels and footer/disclaimer noise from the captured answer text.
      const text = (last.textContent ?? '')
        .replace(/\bChatGPT said:\b/gi, ' ')
        .replace(/\bChatGPT can make mistakes\. Check important info\.\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const links = Array.from(last.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .map((a) => ({ url: a.href, title: (a.textContent ?? '').trim() || undefined }))
        .filter((a) => /^https?:\/\//i.test(a.url))
        .slice(0, 12);
      return { text, links };
    });

    const postSendAuthFailures = chatGPTForbiddenUrls(forbidden);
    if (postSendAuthFailures.length) {
      await captureDebug(page, 'chatgpt', 'auth-403-after-send', { forbidden: postSendAuthFailures.slice(0, 12) });
      throw new Error('ChatGPT session rejected browser automation during generation: backend API returned 403');
    }
    if (isBadChatGPTResponse(data.text)) {
      await captureDebug(page, 'chatgpt', 'bad-response', { forbidden: forbidden.slice(0, 12) });
      console.error(`[DEBUG] ChatGPT data.text was: ${JSON.stringify(data.text)}`);
      throw new Error('ChatGPT did not render a real assistant answer; likely blocked or unauthenticated in browser automation');
    }

    return { text: data.text, citations: data.links };
  } catch (err) {
    await closeChatGPTBrowser();
    throw err;
  }
}
