import { createHash } from 'node:crypto';
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
  rateLimitText?: string[];
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
  turnBindingMethod: 'provider_id' | 'deterministic_dom' | 'unavailable';
  captureBindingId: string | null;
  userOrdinal: number | null;
  assistantOrdinal: number | null;
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
  const outermost = (nodes: HTMLElement[]): HTMLElement[] => nodes.filter((node) =>
    !nodes.some((candidate) => candidate !== node && candidate.contains(node)));
  const users = outermost(Array.from(document.querySelectorAll<HTMLElement>(spec.userSelector)));
  const assistants = outermost(Array.from(document.querySelectorAll<HTMLElement>(spec.assistantSelector)))
    .filter((assistant) => !users.some((user) => user === assistant || user.contains(assistant)));
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
    turnBindingMethod: 'unavailable',
    captureBindingId: null,
    userOrdinal: null,
    assistantOrdinal: null,
  });
  const elementVisible = (node: HTMLElement): boolean => {
    const style = window.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && !node.hasAttribute('hidden');
  };
  const visible = (selector: string): boolean => Boolean(selector)
    && Array.from(document.querySelectorAll<HTMLElement>(selector)).some(elementVisible);
  const identity = (node: HTMLElement, attributes: string[]): string | null => {
    for (const attribute of attributes) {
      const value = attribute === 'id' ? node.id : node.getAttribute(attribute);
      if (value?.trim()) return `${attribute}:${value.trim()}`;
    }
    return null;
  };
  const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();

  const visibleBodyText = normalize(document.body?.innerText ?? '');
  if (visible(input.spec.challengeSelector)) return empty('provider_challenge');
  if (visible(input.spec.rateLimitSelector)
    || input.spec.rateLimitText?.some((text) => visibleBodyText.includes(normalize(text)))) {
    return empty('rate_limited');
  }
  if (visible(input.spec.loginSelector)) return empty('login_required');
  if (visible(input.spec.interstitialSelector)) return empty('provider_interstitial');

  const outermost = (nodes: HTMLElement[]): HTMLElement[] => nodes.filter((node) =>
    !nodes.some((candidate) => candidate !== node && candidate.contains(node)));
  const users = outermost(Array.from(document.querySelectorAll<HTMLElement>(input.spec.userSelector)));
  const assistants = outermost(Array.from(document.querySelectorAll<HTMLElement>(input.spec.assistantSelector)))
    .filter((assistant) => !users.some((user) => user === assistant || user.contains(assistant)));
  const wanted = normalize(input.expectedPrompt);
  const newUsers = users.slice(input.snapshot.userCount);
  if (newUsers.length === 0) return empty('waiting');
  const matchingUsers = newUsers.filter((node) => wanted && normalize(node.innerText || node.textContent || '').includes(wanted));
  if (matchingUsers.length === 0) return empty('prompt_binding_unverified');
  if (matchingUsers.length !== 1) return empty('duplicate_current_turn');
  const matchingUser = matchingUsers[0];
  const matchingUserId = identity(matchingUser, input.spec.userIdentityAttributes);
  const matchingUserIndex = users.indexOf(matchingUser);

  const nextUser = users.slice(matchingUserIndex + 1).find((node) =>
    Boolean(matchingUser!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
  const candidates = assistants.filter((node, index) => {
    if (index < input.snapshot.assistantCount) return false;
    if (!(matchingUser!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    return !nextUser || Boolean(node.compareDocumentPosition(nextUser) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  if (candidates.length === 0) {
    return { ...empty('waiting'), userNodeId: matchingUserId, promptMatched: true, userOrdinal: matchingUserIndex };
  }
  if (candidates.length !== 1) {
    return { ...empty('duplicate_current_turn'), userNodeId: matchingUserId, promptMatched: true, userOrdinal: matchingUserIndex };
  }

  const assistant = candidates[0];
  const assistantIndex = assistants.indexOf(assistant);
  const assistantNodeId = identity(assistant, input.spec.assistantIdentityAttributes);
  const assistantScope = assistant.closest<HTMLElement>('[data-testid*="message"], [data-is-user="false"], article') ?? assistant;
  const answer = assistant.matches(input.spec.answerSelector)
    ? assistant
    : assistantScope.querySelector<HTMLElement>(input.spec.answerSelector);
  if (!answer) {
    return {
      ...empty('provider_no_answer'), userNodeId: matchingUserId, assistantNodeId,
      promptMatched: true, assistantFollowsUser: true, userOrdinal: matchingUserIndex, assistantOrdinal: assistantIndex,
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
  const providerIdsAvailable = Boolean(matchingUserId && assistantNodeId && answerNodeId);
  const bindingMethod = providerIdsAvailable ? 'provider_id' as const : 'deterministic_dom' as const;
  const boundUserId = providerIdsAvailable ? matchingUserId : null;
  const boundAssistantId = providerIdsAvailable ? assistantNodeId : null;
  const boundAnswerId = providerIdsAvailable ? answerNodeId : null;
  const streaming = assistantScope.matches(input.spec.streamingSelector)
    || Boolean(assistantScope.querySelector(input.spec.streamingSelector))
    || visible(input.spec.globalStopSelector);
  if (streaming) {
    return {
      ...empty('streaming'), rawAnswer, userNodeId: boundUserId, assistantNodeId: boundAssistantId, answerNodeId: boundAnswerId,
      promptMatched: true, assistantFollowsUser: true, turnBindingMethod: bindingMethod,
      userOrdinal: matchingUserIndex, assistantOrdinal: assistantIndex,
    };
  }
  const followingTerminalControl = Array.from(document.querySelectorAll<HTMLElement>(input.spec.terminalSelector)).some((control) => {
    const followsAssistant = assistantScope.contains(control)
      || Boolean(assistant.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING);
    const precedesNextUser = !nextUser || Boolean(control.compareDocumentPosition(nextUser) & Node.DOCUMENT_POSITION_FOLLOWING);
    return followsAssistant && precedesNextUser && elementVisible(control);
  });
  const terminal = assistantScope.matches(input.spec.terminalSelector)
    || Boolean(assistantScope.querySelector(input.spec.terminalSelector))
    || followingTerminalControl;
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
    userNodeId: boundUserId,
    assistantNodeId: boundAssistantId,
    answerNodeId: boundAnswerId,
    promptMatched: true,
    assistantFollowsUser: true,
    terminalSignal: terminal ? input.spec.terminalSignal : null,
    turnBindingMethod: bindingMethod,
    captureBindingId: null,
    userOrdinal: matchingUserIndex,
    assistantOrdinal: assistantIndex,
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
  let previousHash: string | null = null;
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
      'provider_refusal', 'provider_no_answer', 'prompt_binding_unverified',
      'duplicate_current_turn'].includes(inspection.status)) {
      throw new Error(`${inspection.status}:${input.provider}`);
    }
    if (inspection.status !== 'terminal' || inspection.rawAnswer.length < minimumChars) {
      previousText = null;
      previousHash = null;
      stableCount = 0;
      continue;
    }
    const rawHash = createHash('sha256').update(Buffer.from(inspection.rawAnswer, 'utf8')).digest('hex');
    stableCount = inspection.rawAnswer === previousText && rawHash === previousHash ? stableCount + 1 : 1;
    previousText = inspection.rawAnswer;
    previousHash = rawHash;
    if (stableCount >= requiredStableChecks) {
      const captureBindingId = inspection.turnBindingMethod === 'deterministic_dom'
        ? `local:sha256:${createHash('sha256').update(JSON.stringify({
          provider: input.provider,
          prompt: input.expectedPrompt,
          userOrdinal: inspection.userOrdinal,
          assistantOrdinal: inspection.assistantOrdinal,
          rawHash,
        }), 'utf8').digest('hex')}`
        : null;
      return { ...inspection, captureBindingId, observedStableChecks: stableCount };
    }
  }
  throw new Error(`provider_not_terminal:${input.provider}:last_state_${lastStatus}`);
}
