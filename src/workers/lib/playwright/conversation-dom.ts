import type { BrowserTerminalSignal } from './capture-contract';

export interface ConversationDomSpec {
  userSelector: string;
  assistantSelector: string;
  answerSelector: string;
  terminalSelector: string;
  streamingSelector: string;
  globalStopSelector: string;
  loginSelector: string;
  challengeSelector: string;
  rateLimitSelector: string;
  interstitialSelector: string;
  providerOrigin: string;
  userIdentityAttributes: string[];
  assistantIdentityAttributes: string[];
  terminalSignal: BrowserTerminalSignal;
}

export interface ConversationTurnSnapshot {
  userNodeIds: string[];
  assistantNodeIds: string[];
  userCount: number;
  assistantCount: number;
}

export type CorrelatedTurnStatus =
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

export interface CorrelatedTurnInspection {
  status: CorrelatedTurnStatus;
  rawAnswer: string;
  links: { url: string; title?: string }[];
  userNodeId: string | null;
  assistantNodeId: string | null;
  answerNodeId: string | null;
  promptMatched: boolean;
  assistantFollowsUser: boolean;
  terminalSignal: BrowserTerminalSignal | null;
}

export function renderedTextContainsPrompt(renderedText: string, expectedPrompt: string): boolean {
  const rendered = renderedText.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const expected = expectedPrompt.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Boolean(expected && rendered.includes(expected));
}

/** Browser callback. It records provider-emitted identities only and never invents DOM ids. */
export function snapshotConversationDom(spec: ConversationDomSpec): ConversationTurnSnapshot {
  const identity = (node: HTMLElement, attributes: string[]): string | null => {
    for (const attribute of attributes) {
      const value = attribute === 'id' ? node.id : node.getAttribute(attribute);
      if (value?.trim()) return `${attribute}:${value.trim()}`;
    }
    return null;
  };
  const users = Array.from(document.querySelectorAll<HTMLElement>(spec.userSelector));
  const assistants = Array.from(document.querySelectorAll<HTMLElement>(spec.assistantSelector));
  return {
    userNodeIds: users.map((node) => identity(node, spec.userIdentityAttributes)).filter((value): value is string => Boolean(value)),
    assistantNodeIds: assistants.map((node) => identity(node, spec.assistantIdentityAttributes)).filter((value): value is string => Boolean(value)),
    userCount: users.length,
    assistantCount: assistants.length,
  };
}

/** Browser callback. It selects exactly one new assistant immediately associated with one new prompt turn. */
export function inspectCorrelatedConversationTurn(input: {
  spec: ConversationDomSpec;
  snapshot: ConversationTurnSnapshot;
  expectedPrompt: string;
}): CorrelatedTurnInspection {
  const empty = (status: CorrelatedTurnStatus): CorrelatedTurnInspection => ({
    status,
    rawAnswer: '',
    links: [],
    userNodeId: null,
    assistantNodeId: null,
    answerNodeId: null,
    promptMatched: false,
    assistantFollowsUser: false,
    terminalSignal: null,
  });
  const visible = (selector: string): boolean => {
    if (!selector) return false;
    return Array.from(document.querySelectorAll<HTMLElement>(selector)).some((node) => {
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && !node.hasAttribute('hidden');
    });
  };
  const identity = (node: HTMLElement, attributes: string[]): string | null => {
    for (const attribute of attributes) {
      const value = attribute === 'id' ? node.id : node.getAttribute(attribute);
      if (value?.trim()) return `${attribute}:${value.trim()}`;
    }
    return null;
  };
  const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();

  if (visible(input.spec.challengeSelector)) return empty('provider_challenge');
  if (visible(input.spec.rateLimitSelector)) return empty('rate_limited');
  if (visible(input.spec.loginSelector)) return empty('login_required');
  if (visible(input.spec.interstitialSelector)) return empty('provider_interstitial');

  const users = Array.from(document.querySelectorAll<HTMLElement>(input.spec.userSelector));
  const assistants = Array.from(document.querySelectorAll<HTMLElement>(input.spec.assistantSelector));
  const oldUsers = new Set(input.snapshot.userNodeIds);
  const oldAssistants = new Set(input.snapshot.assistantNodeIds);
  const wanted = normalize(input.expectedPrompt);
  let matchingUser: HTMLElement | null = null;
  let matchingUserId: string | null = null;
  let matchingUserIndex = -1;

  for (let index = users.length - 1; index >= input.snapshot.userCount; index -= 1) {
    const node = users[index];
    const nodeIdentity = identity(node, input.spec.userIdentityAttributes);
    const rendered = normalize(node.innerText || node.textContent || '');
    if (wanted && rendered.includes(wanted)) {
      if (!nodeIdentity) return empty('provider_identity_missing');
      if (oldUsers.has(nodeIdentity)) continue;
      matchingUser = node;
      matchingUserId = nodeIdentity;
      matchingUserIndex = index;
      break;
    }
  }
  if (!matchingUser) return empty('prompt_binding_unverified');
  if (!matchingUserId) return empty('provider_identity_missing');

  const nextUser = users.slice(matchingUserIndex + 1).find((node) =>
    Boolean(matchingUser!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
  const candidates = assistants.filter((node, index) => {
    if (index < input.snapshot.assistantCount) return false;
    const nodeIdentity = identity(node, input.spec.assistantIdentityAttributes);
    if (!nodeIdentity || oldAssistants.has(nodeIdentity)) return false;
    if (!(matchingUser!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    return !nextUser || Boolean(node.compareDocumentPosition(nextUser) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  if (candidates.length === 0) {
    return { ...empty('waiting'), userNodeId: matchingUserId, promptMatched: true };
  }
  if (candidates.length !== 1) {
    return { ...empty('duplicate_current_turn'), userNodeId: matchingUserId, promptMatched: true };
  }

  const assistant = candidates[0];
  const assistantNodeId = identity(assistant, input.spec.assistantIdentityAttributes);
  if (!assistantNodeId) {
    return { ...empty('provider_identity_missing'), userNodeId: matchingUserId, promptMatched: true };
  }
  const answer = assistant.matches(input.spec.answerSelector)
    ? assistant
    : assistant.querySelector<HTMLElement>(input.spec.answerSelector);
  if (!answer) {
    return {
      ...empty('provider_no_answer'), userNodeId: matchingUserId, assistantNodeId,
      promptMatched: true, assistantFollowsUser: true,
    };
  }
  const answerNodeId = identity(answer, input.spec.assistantIdentityAttributes) ?? assistantNodeId;
  const rawAnswer = answer.innerText || answer.textContent || '';
  const normalizedAnswer = normalize(rawAnswer);
  const refused = /^(?:i (?:can(?:not|'t)|won't)|sorry[, ]|i'm sorry|i am sorry|this request (?:cannot|can't)|unable to (?:help|comply))/i.test(normalizedAnswer);
  if (refused) {
    return {
      ...empty('provider_refusal'), rawAnswer, userNodeId: matchingUserId, assistantNodeId, answerNodeId,
      promptMatched: true, assistantFollowsUser: true,
    };
  }
  if (!normalizedAnswer || /^(?:no answer|answer unavailable|something went wrong|try again)$/i.test(normalizedAnswer)) {
    return {
      ...empty('provider_no_answer'), rawAnswer, userNodeId: matchingUserId, assistantNodeId, answerNodeId,
      promptMatched: true, assistantFollowsUser: true,
    };
  }
  const streaming = assistant.matches(input.spec.streamingSelector)
    || Boolean(assistant.querySelector(input.spec.streamingSelector))
    || visible(input.spec.globalStopSelector);
  if (streaming) {
    return {
      ...empty('streaming'), rawAnswer, userNodeId: matchingUserId, assistantNodeId, answerNodeId,
      promptMatched: true, assistantFollowsUser: true,
    };
  }
  const terminal = assistant.matches(input.spec.terminalSelector)
    || Boolean(assistant.querySelector(input.spec.terminalSelector));
  const links: { url: string; title?: string }[] = [];
  for (const anchor of Array.from(answer.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    if (links.length >= 12) break;
    if (!/^https?:\/\//i.test(anchor.href) || anchor.href.startsWith(input.spec.providerOrigin)) continue;
    links.push({ url: anchor.href, title: (anchor.textContent ?? '').trim() || undefined });
  }
  return {
    status: terminal ? 'terminal' : 'terminal_signal_missing',
    rawAnswer,
    links,
    userNodeId: matchingUserId,
    assistantNodeId,
    answerNodeId,
    promptMatched: true,
    assistantFollowsUser: true,
    terminalSignal: terminal ? input.spec.terminalSignal : null,
  };
}

export async function waitForTerminalCorrelatedTurn(
  page: import('playwright').Page,
  input: {
    spec: ConversationDomSpec;
    snapshot: ConversationTurnSnapshot;
    expectedPrompt: string;
    provider: string;
    timeoutMs?: number;
    minimumChars?: number;
    stableChecks?: number;
    signal?: AbortSignal;
  },
): Promise<CorrelatedTurnInspection & { observedStableChecks: number }> {
  const deadline = Date.now() + (input.timeoutMs ?? 180_000);
  const requiredStableChecks = input.stableChecks ?? 3;
  const minimumChars = input.minimumChars ?? 40;
  let previousText: string | null = null;
  let stableCount = 0;
  let lastStatus: CorrelatedTurnStatus = 'waiting';

  while (Date.now() < deadline) {
    if (input.signal?.aborted) throw new Error(`provider_deadline:${input.provider}_aborted`);
    await page.waitForTimeout(1_000);
    const inspection = await page.evaluate(inspectCorrelatedConversationTurn, {
      spec: input.spec,
      snapshot: input.snapshot,
      expectedPrompt: input.expectedPrompt,
    });
    lastStatus = inspection.status;
    if (['login_required', 'provider_challenge', 'rate_limited', 'provider_interstitial',
      'provider_refusal', 'provider_no_answer', 'prompt_binding_unverified', 'provider_identity_missing',
      'duplicate_current_turn'].includes(inspection.status)) {
      throw new Error(`${inspection.status}:${input.provider}`);
    }
    if (inspection.status !== 'terminal' || inspection.rawAnswer.length < minimumChars) {
      previousText = null;
      stableCount = 0;
      continue;
    }
    stableCount = inspection.rawAnswer === previousText ? stableCount + 1 : 1;
    previousText = inspection.rawAnswer;
    if (stableCount >= requiredStableChecks) return { ...inspection, observedStableChecks: stableCount };
  }
  throw new Error(`provider_not_terminal:${input.provider}:last_state_${lastStatus}`);
}
