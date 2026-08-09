export type PerplexityInspectionStatus =
  | 'waiting'
  | 'streaming'
  | 'terminal'
  | 'login_required'
  | 'provider_challenge'
  | 'rate_limited'
  | 'provider_interstitial'
  | 'provider_refusal'
  | 'provider_no_answer'
  | 'prompt_binding_unverified'
  | 'provider_identity_missing'
  | 'duplicate_current_turn'
  | 'terminal_signal_missing';

export interface PerplexityInspection {
  status: PerplexityInspectionStatus;
  rawAnswer: string;
  links: { url: string; title?: string }[];
  userTurnId: string | null;
  assistantTurnId: string | null;
  answerNodeId: string | null;
  terminalSignal: 'perplexity_answer_actions_complete' | null;
}

/** Browser callback. It binds one query and answer to the newly created provider thread. */
export function inspectPerplexityDom(input: {
  expectedPrompt: string;
  priorUrl: string;
  currentUrl: string;
}): PerplexityInspection {
  const empty = (status: PerplexityInspectionStatus): PerplexityInspection => ({
    status, rawAnswer: '', links: [], userTurnId: null, assistantTurnId: null, answerNodeId: null, terminalSignal: null,
  });
  const visible = (selector: string): boolean => Array.from(document.querySelectorAll<HTMLElement>(selector)).some((node) => {
    const style = window.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && !node.hasAttribute('hidden');
  });
  const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  if (visible('iframe[src*="challenge"], #challenge-running')) return empty('provider_challenge');
  if (visible('[data-testid="rate-limit-message"], [data-testid="usage-limit"]')) return empty('rate_limited');
  if (visible('form[action*="login"]')) return empty('login_required');
  if (visible('[data-testid="onboarding-modal"], [data-testid="account-interstitial"]')) return empty('provider_interstitial');

  let current: URL;
  let prior: URL;
  try {
    current = new URL(input.currentUrl);
    prior = new URL(input.priorUrl);
  } catch {
    return empty('provider_identity_missing');
  }
  if (current.hostname !== 'www.perplexity.ai' || current.href === prior.href) return empty('waiting');
  const threadSegment = current.pathname.split('/').filter(Boolean).at(-1) ?? '';
  if (!/^[-a-z0-9_]{8,}$/i.test(threadSegment)) return empty('provider_identity_missing');
  const threadIdentity = `perplexity-thread:${threadSegment}`;

  const expected = normalize(input.expectedPrompt);
  const panels = Array.from(document.querySelectorAll<HTMLElement>('[role="tabpanel"][id]'));
  const matchingPanels = panels.filter((panel) => {
    const queryHeadings = Array.from(panel.querySelectorAll<HTMLElement>('[role="heading"]'))
      .filter((node) => node.classList.contains('group/query'));
    return queryHeadings.length === 1
      && normalize(queryHeadings[0].innerText || queryHeadings[0].textContent || '') === expected;
  });
  if (matchingPanels.length !== 1) {
    return empty(matchingPanels.length > 1 ? 'duplicate_current_turn' : 'prompt_binding_unverified');
  }
  const tabPanel = matchingPanels[0];
  if (!tabPanel.id) return empty('provider_identity_missing');
  const answerNodes = Array.from(tabPanel.querySelectorAll<HTMLElement>('.prose'))
    .filter((node) => node.classList.contains('prose'));
  if (answerNodes.length === 0) {
    return visible('button[aria-label="Stop"], button[aria-label*="Stop generating" i], button[aria-label*="Cancel" i]')
      ? empty('streaming') : empty('waiting');
  }
  if (answerNodes.length !== 1) return empty('duplicate_current_turn');
  const answerNode = answerNodes[0];
  const rawAnswer = answerNode.innerText || answerNode.textContent || '';
  const normalizedAnswer = normalize(rawAnswer);
  if (/^(?:i (?:can(?:not|'t)|won't)|sorry[, ]|i'm sorry|unable to (?:help|comply))/i.test(normalizedAnswer)) {
    return { ...empty('provider_refusal'), rawAnswer };
  }
  if (!normalizedAnswer || /^(?:no answer|answer unavailable|something went wrong|try again)$/i.test(normalizedAnswer)) {
    return { ...empty('provider_no_answer'), rawAnswer };
  }
  if (visible('button[aria-label="Stop"], button[aria-label*="Stop generating" i], button[aria-label*="Cancel" i], [aria-busy="true"]')) {
    return { ...empty('streaming'), rawAnswer };
  }
  const links: { url: string; title?: string }[] = [];
  const seenLinks = new Set<string>();
  for (const anchor of Array.from(answerNode.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    if (links.length >= 12) break;
    if (!/^https?:\/\//i.test(anchor.href) || anchor.href === input.currentUrl || seenLinks.has(anchor.href)) continue;
    seenLinks.add(anchor.href);
    links.push({ url: anchor.href, title: (anchor.textContent ?? '').trim() || undefined });
  }
  const terminalControls = ['Copy', 'Rewrite Session', 'Share'].map((label) =>
    tabPanel.querySelectorAll(`button[aria-label="${label}"]`).length);
  const terminal = terminalControls.every((count) => count === 1);
  return {
    status: terminal ? 'terminal' : 'terminal_signal_missing',
    rawAnswer,
    links,
    userTurnId: `${threadIdentity}:query`,
    assistantTurnId: `${threadIdentity}:answer`,
    answerNodeId: `id:${tabPanel.id}`,
    terminalSignal: terminal ? 'perplexity_answer_actions_complete' : null,
  };
}
