export type GoogleAioState =
  | 'search_submitted'
  | 'results_loaded'
  | 'aio_rendering'
  | 'no_aio'
  | 'consent'
  | 'challenge'
  | 'timeout'
  | 'aio_complete'
  | 'raw_capture';

export interface GoogleAioInspection {
  state: Exclude<GoogleAioState, 'no_aio' | 'timeout' | 'raw_capture'>;
  rawAnswer: string;
  links: { url: string; title?: string }[];
  containerIdentity: string | null;
  pageSignals?: {
    pathname: string;
    searchInputs: number;
    headingCount: number;
    legacyResults: boolean;
    currentResults: boolean;
    consentCopy: boolean;
    challengeCopy: boolean;
    javascriptRequired: boolean;
  };
}

/** Browser callback. It never returns page/body text; evidence is scoped to one AIO container. */
export function inspectGoogleAioDom(expectedPrompt?: string): GoogleAioInspection {
  if (expectedPrompt) {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('textarea[name="q"], input[name="q"]');
    const currentValue = (input?.value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    const expected = expectedPrompt.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!input || !currentValue.includes(expected)) {
      return { state: 'search_submitted', rawAnswer: '', links: [], containerIdentity: null };
    }
  }
  if (location.hostname.includes('consent.google.com')) {
    return { state: 'consent', rawAnswer: '', links: [], containerIdentity: null };
  }
  const consentNode = document.querySelector<HTMLElement>('form[action*="consent"], #consent-bump, [aria-label*="consent" i]');
  if (consentNode && (consentNode.getClientRects().length > 0 || (consentNode as any).offsetHeight > 0)) {
    return { state: 'consent', rawAnswer: '', links: [], containerIdentity: null };
  }
  const challengeNode = document.querySelector<HTMLElement>('#captcha-form, iframe[src*="recaptcha"], [class*="g-recaptcha"], [data-testid*="challenge"]');
  if (challengeNode && challengeNode.getClientRects().length > 0) {
    return { state: 'challenge', rawAnswer: '', links: [], containerIdentity: null };
  }

  const explicit = document.querySelectorAll<HTMLElement>(
    '[data-attrid*="SGE"], [data-attrid*="ai_overview"], [data-testid*="ai-overview"], [class*="ai-overview"], [aria-label*="AI Overview" i]',
  );
  let container: HTMLElement | null = null;
  for (let i = explicit.length - 1; i >= 0; i--) {
    const el = explicit[i];
    const style = window.getComputedStyle(el);
    if (style.display !== 'none' && el.getClientRects().length > 0) {
      container = el;
      break;
    }
  }
  if (!container) {
    const candidates = document.querySelectorAll<HTMLElement>('section, [role="region"], div.MjjYud, div');
    let shortest = Number.POSITIVE_INFINITY;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate.id === 'rso' || candidate.id === 'search' || candidate.id === 'rcnt' || candidate.tagName === 'BODY' || candidate.tagName === 'MAIN') continue;
      if (candidate.closest('[data-attrid="PAA"], [class*="related-questions"], [role="complementary"], #kp-wp-tab-overview')) continue;
      const text = candidate.innerText || candidate.textContent || '';
      if (!/(^|\n)\s*AI Overview\s*(\n|$)/i.test(text)) continue;
      if (text.length < 80 || text.length > 25_000 || text.length >= shortest) continue;
      const style = window.getComputedStyle(candidate);
      if (style.display === 'none' || candidate.getClientRects().length === 0) continue;
      shortest = text.length;
      container = candidate;
    }
  }

  if (!container) {
    const explicitResults = document.querySelector(
      '#search, #rso, main[role="main"], [data-testid="search-results"]',
    );
    const currentResults = document.querySelector('#rcnt, #center_col');
    const organicResult = document.querySelector('a h3, [data-snhf]');
    const bodyText = (document.body?.innerText || '').normalize('NFKC').toLowerCase();
    const pageSignals = {
      pathname: location.pathname.replace(/[^a-z0-9_:/.-]+/gi, '-').slice(0, 100),
      searchInputs: document.querySelectorAll('textarea[name="q"], input[name="q"]').length,
      headingCount: document.querySelectorAll('h3').length,
      legacyResults: Boolean(explicitResults),
      currentResults: Boolean(currentResults),
      consentCopy: /\b(before you continue|choose what data|accept all cookies|reject all cookies)\b/.test(bodyText),
      challengeCopy: /\b(unusual traffic|not a robot|verify you are human|automated queries)\b/.test(bodyText),
      javascriptRequired: /\b(enable javascript|javascript is disabled|turn on javascript)\b/.test(bodyText),
    };
    if (pageSignals.consentCopy) {
      return { state: 'consent', rawAnswer: '', links: [], containerIdentity: null, pageSignals };
    }
    if (pageSignals.challengeCopy) {
      return { state: 'challenge', rawAnswer: '', links: [], containerIdentity: null, pageSignals };
    }
    return {
      state: explicitResults || (currentResults && organicResult) || pageSignals.headingCount > 0
        ? 'results_loaded'
        : 'search_submitted',
      rawAnswer: '',
      links: [],
      containerIdentity: null,
      pageSignals,
    };
  }
  const identity = container.getAttribute('data-builderradar-node-id')
    || container.getAttribute('data-attrid')
    || container.getAttribute('data-testid')
    || container.id
    || null;
  const streaming = container.matches('[aria-busy="true"], [data-is-streaming="true"], [class*="loading"], [class*="generating"]')
    || Boolean(container.querySelector('[aria-busy="true"], [data-is-streaming="true"], [class*="loading"], [class*="generating"], [role="progressbar"]'));
    
  const terminalIndicator = container.matches('[data-is-streaming="false"]')
    || Boolean(container.querySelector('button[aria-label*="thumbs" i], button[aria-label*="Thumbs" i], button[aria-label*="copy" i], button[aria-label*="Copy" i], button[aria-label*="listen" i], button[aria-label*="Listen" i]'));
    
  const isComplete = !streaming && terminalIndicator;
  const rawAnswer = container.innerText || container.textContent || '';
  const links: { url: string; title?: string }[] = [];
  const anchors = container.querySelectorAll<HTMLAnchorElement>('a[href]');
  for (let index = 0; index < anchors.length && links.length < 12; index += 1) {
    const anchor = anchors[index];
    if (!/^https?:\/\//i.test(anchor.href) || anchor.href.includes('google.com')) continue;
    links.push({ url: anchor.href, title: (anchor.textContent ?? '').trim() || undefined });
  }
  return {
    state: isComplete ? 'aio_complete' : 'aio_rendering',
    rawAnswer,
    links,
    containerIdentity: identity,
  };
}
