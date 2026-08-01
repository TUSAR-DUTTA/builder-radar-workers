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

export let sharedChatGPTBrowser: { runtime: PlaywrightContextHandle, page: import('playwright').Page, forbidden: string[] } | null = null;

export async function closeChatGPTBrowser() {
  if (sharedChatGPTBrowser) {
    await sharedChatGPTBrowser.runtime.close().catch(() => {});
    sharedChatGPTBrowser = null;
  }
}

export async function scrapeChatGPTPrompt(prompt: string): Promise<{ text: string; citations: { url: string; title?: string }[] }> {
  if (!sharedChatGPTBrowser) {
    const runtime = await launchSeededPersistentContext('chatgpt-consumer');
    try {
      const ctx = runtime.context;
      const page = await ctx.newPage();
      const forbidden: string[] = [];
      page.on('response', (res) => {
        if (res.status() === 403 && res.url().includes('chatgpt.com/')) forbidden.push(res.url());
      });

      let clickedChooser = false;
      page.on('framenavigated', async (frame) => {
        if (frame === page.mainFrame()) {
          const url = page.url();
          if (url.includes('choose-an-account')) {
            console.log('[chatgpt-listener] Account chooser page navigated! Clicking existing session...');
            try {
              const chooserBtn = page.locator('button[name="session_id"], button[data-dd-action-name="Select existing session"]');
              await chooserBtn.waitFor({ state: 'visible', timeout: 10000 });
              await chooserBtn.click();
              console.log('[chatgpt-listener] Selected existing session successfully.');
              clickedChooser = true;
            } catch (e) {
              console.error('[chatgpt-listener] Failed to auto-click session button:', (e as Error).message);
            }
          } else if (url.includes('chatgpt.com') && clickedChooser) {
            console.log('[chatgpt-listener] Successfully redirected back to chatgpt.com after chooser. Clearing auth warnings.');
            forbidden.length = 0;
            clickedChooser = false;
          }
        }
      });

      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(12000); // Wait for initial loads and any redirects to trigger

      const authFailures = chatGPTForbiddenUrls(forbidden);
      if (authFailures.length) {
        // If we just clicked chooser and are redirecting, let's give it a moment to clear
        if (clickedChooser) {
          await page.waitForTimeout(4000);
          forbidden.length = 0;
        } else {
          await captureDebug(page, 'chatgpt', 'auth-403-before-send', { forbidden: authFailures.slice(0, 12) });
          throw new Error('ChatGPT session rejected browser automation: backend API returned 403 before send');
        }
      }
      sharedChatGPTBrowser = { runtime, page, forbidden };
    } catch (err) {
      await runtime.close().catch(() => {});
      throw err;
    }
  }

  const { page, forbidden } = sharedChatGPTBrowser;
  forbidden.length = 0; // Clear previous errors

  try {
    // Wait until we are fully landed and stabilized on chatgpt.com workspace page
    console.log('[chatgpt] Waiting for workspace page to be loaded and stable...');
    let stabilized = false;
    const startTime = Date.now();
    const timeout = 45000; // 45 seconds max wait for login/chooser redirects
    
    while (Date.now() - startTime < timeout) {
      const url = page.url();
      
      if (url.includes('choose-an-account') || url.includes('login') || url.includes('log-in')) {
        console.log('[chatgpt-wait] Detected auth/chooser page, waiting for redirect back...');
        await page.waitForTimeout(1000);
        continue;
      }
      
      if (url.includes('chatgpt.com')) {
        // Check if the inline account chooser modal is present
        const chooserBtn = page.locator('[data-testid="log-back-form"] div[role="button"], button[name="session_id"], button[data-dd-action-name="Select existing session"]');
        if (await chooserBtn.first().isVisible().catch(() => false)) {
          console.log('[chatgpt-wait] Detected inline account chooser modal! Clicking select session...');
          await chooserBtn.first().click().catch(() => {});
          await page.waitForTimeout(3000);
          continue;
        }

        const profileBtn = page.locator('[data-testid="accounts-profile-button"], [aria-label*="profile menu"], [aria-label*="Open profile"]').first();
        const hasComposer = await page.locator('#prompt-textarea').isVisible().catch(() => false);
        const hasProfileBtn = await profileBtn.isVisible().catch(() => false);
        
        console.log('[chatgpt-wait] Loop check:', { url, hasComposer, hasProfileBtn });

        if (hasComposer && hasProfileBtn) {
          console.log('[chatgpt-wait] Logged-in workspace detected. Verifying stability...');
          await page.waitForTimeout(3000);
          
          const finalUrl = page.url();
          const finalHasProfileBtn = await profileBtn.isVisible().catch(() => false);
          
          if (finalUrl.includes('chatgpt.com') && finalHasProfileBtn) {
            stabilized = true;
            break;
          } else {
            console.log('[chatgpt-wait] State changed during stability delay, continuing wait...');
          }
        }
      }
      
      await page.waitForTimeout(1000);
    }
    
    console.log(`[chatgpt] Workspace page stabilization status: ${stabilized}, URL: ${page.url()}`);
    if (!stabilized) {
      await captureDebug(page, 'chatgpt', 'unauthenticated');
      throw new Error('ChatGPT failed to load or stabilize in a logged-in state.');
    }
    await page.waitForTimeout(2000);

    const composer = await firstVisibleLocator(
      page,
      '#prompt-textarea, div[contenteditable="true"][aria-label="Chat with ChatGPT"], textarea[aria-label="Chat with ChatGPT"]',
    );
    if (!composer) {
      await captureDebug(page, 'chatgpt', 'missing-composer');
      throw new Error(`ChatGPT composer not found at ${page.url()} title="${await page.title().catch(() => '')}"`);
    }
    const turnSnapshot = await page.evaluate(() => {
      const assistants = Array.from(document.querySelectorAll<HTMLElement>('section[data-testid^="conversation-turn-"][data-turn="assistant"]'));
      const users = Array.from(document.querySelectorAll<HTMLElement>('section[data-testid^="conversation-turn-"][data-turn="user"]'));
      return {
        assistantCount: assistants.length,
        userCount: users.length,
        lastAssistantId: assistants.length > 0 ? (assistants[assistants.length - 1].getAttribute('data-testid') || assistants[assistants.length - 1].id || null) : null,
        lastUserId: users.length > 0 ? (users[users.length - 1].getAttribute('data-testid') || users[users.length - 1].id || null) : null,
      };
    });
    await composer.click({ timeout: 20_000, force: true }).catch(() => {});
    await composer.fill('');
    await page.keyboard.insertText(`Use web search and answer this buyer question with citations:\n\n${prompt}`);
    await page.waitForTimeout(500);

    const submitButton = await firstVisibleLocator(
      page,
      'button[data-testid="send-button"], button[aria-label="Send prompt"], #composer-submit-button'
    );
    if (submitButton) {
      const disabled = await submitButton.isDisabled().catch(() => false);
      if (!disabled) {
        await submitButton.click({ timeout: 10_000 });
      } else {
        await page.keyboard.press('Enter');
      }
    } else {
      await page.keyboard.press('Enter');
    }

    try {
      await page.waitForFunction(({ snapshot, expectedPrompt }) => {
      const assistants = Array.from(document.querySelectorAll<HTMLElement>('section[data-testid^="conversation-turn-"][data-turn="assistant"]'));
      const users = Array.from(document.querySelectorAll<HTMLElement>('section[data-testid^="conversation-turn-"][data-turn="user"]'));
      const last = assistants.at(-1);
      const lastUser = users.at(-1);
      if (!last || !lastUser) return false;
      const assistantId = last.getAttribute('data-testid') || last.id || null;
      const userId = lastUser.getAttribute('data-testid') || lastUser.id || null;
      const newAssistant = assistants.length > snapshot.assistantCount || assistantId !== snapshot.lastAssistantId;
      const newUser = users.length > snapshot.userCount || userId !== snapshot.lastUserId;
      
      const userText = (lastUser.textContent ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
      const expPrompt = expectedPrompt.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
      const promptBound = userText.includes(expPrompt);
      
      if (!newAssistant || !newUser || !promptBound) return false;
      const busy = last.querySelector('[aria-busy="true"]');
      if (busy) return false;
      const text = (last.textContent ?? '').replace(/\s+/g, ' ').trim();
      return text.length > 'ChatGPT said:'.length + 40;
      }, { snapshot: turnSnapshot, expectedPrompt: prompt }, { timeout: 180_000 });
    } catch {
      await captureDebug(page, 'chatgpt', 'prompt-binding-timeout');
      throw new Error('prompt_identity_unverified:new_chatgpt_turn_not_bound_to_submitted_prompt');
    }
    await page.waitForTimeout(3000);

    const data = await page.evaluate(() => {
      const assistantTurns = Array.from(document.querySelectorAll<HTMLElement>('section[data-testid^="conversation-turn-"][data-turn="assistant"]'));
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
      return { text, links, assistantTurnId: last.getAttribute('data-testid') || last.id || null };
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
    if (!data.assistantTurnId || data.assistantTurnId === turnSnapshot.lastAssistantId) {
      await captureDebug(page, 'chatgpt', 'stale-assistant-turn');
      throw new Error('prompt_identity_unverified:stale_chatgpt_assistant_turn');
    }

    return { text: data.text, citations: data.links };
  } catch (err) {
    await closeChatGPTBrowser();
    throw err;
  }
}
