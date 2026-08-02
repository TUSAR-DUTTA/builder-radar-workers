export interface ConversationDomSpec {
  userSelector: string;
  assistantSelector: string;
  streamingSelector: string;
  loginSelector: string;
  challengeSelector: string;
  rateLimitSelector: string;
  providerOrigin: string;
}

export interface ConversationTurnSnapshot {
  userNodeIds: string[];
  assistantNodeIds: string[];
}

export type CorrelatedTurnStatus =
  | 'waiting'
  | 'streaming'
  | 'ready'
  | 'login'
  | 'challenge'
  | 'rate_limit';

export interface CorrelatedTurnInspection {
  status: CorrelatedTurnStatus;
  rawAnswer: string;
  links: { url: string; title?: string }[];
  userNodeId: string | null;
  assistantNodeId: string | null;
  promptMatched: boolean;
  assistantFollowsUser: boolean;
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

/**
 * Browser callback: snapshot durable DOM node identities before submitting a prompt.
 * It deliberately assigns private data attributes when a provider does not expose an id.
 */
export function snapshotConversationDom(spec: ConversationDomSpec): ConversationTurnSnapshot {
  const root = document.documentElement;
  let counter = Number(root.getAttribute('data-builderradar-node-counter') ?? '0');
  const users = document.querySelectorAll<HTMLElement>(spec.userSelector);
  const assistants = document.querySelectorAll<HTMLElement>(spec.assistantSelector);
  const userNodeIds: string[] = [];
  const assistantNodeIds: string[] = [];

  for (let index = 0; index < users.length; index += 1) {
    const node = users[index];
    let identity = node.getAttribute('data-builderradar-node-id')
      || node.getAttribute('data-message-id')
      || node.id;
    if (!identity) {
      counter += 1;
      identity = `user-${counter}`;
      node.setAttribute('data-builderradar-node-id', identity);
    }
    userNodeIds.push(identity);
  }
  for (let index = 0; index < assistants.length; index += 1) {
    const node = assistants[index];
    let identity = node.getAttribute('data-builderradar-node-id')
      || node.getAttribute('data-message-id')
      || node.id;
    if (!identity) {
      counter += 1;
      identity = `assistant-${counter}`;
      node.setAttribute('data-builderradar-node-id', identity);
    }
    assistantNodeIds.push(identity);
  }
  root.setAttribute('data-builderradar-node-counter', String(counter));
  return { userNodeIds, assistantNodeIds };
}

/**
 * Browser callback: locate only a new assistant node following a new, prompt-matching user node.
 * Returned answer text is untouched; callers sanitize only after capture.
 */
export function inspectCorrelatedConversationTurn(input: {
  spec: ConversationDomSpec;
  snapshot: ConversationTurnSnapshot;
  expectedPrompt: string;
}): CorrelatedTurnInspection {
  const challengeNode = document.querySelector<HTMLElement>(input.spec.challengeSelector);
  if (challengeNode && challengeNode.getClientRects().length > 0) {
    return { status: 'challenge', rawAnswer: '', links: [], userNodeId: null, assistantNodeId: null, promptMatched: false, assistantFollowsUser: false };
  }
  const rateLimitNode = document.querySelector<HTMLElement>(input.spec.rateLimitSelector);
  if (rateLimitNode && rateLimitNode.getClientRects().length > 0) {
    return { status: 'rate_limit', rawAnswer: '', links: [], userNodeId: null, assistantNodeId: null, promptMatched: false, assistantFollowsUser: false };
  }
  const loginNode = document.querySelector<HTMLElement>(input.spec.loginSelector);
  if (loginNode && loginNode.getClientRects().length > 0) {
    return { status: 'login', rawAnswer: '', links: [], userNodeId: null, assistantNodeId: null, promptMatched: false, assistantFollowsUser: false };
  }

  const root = document.documentElement;
  let counter = Number(root.getAttribute('data-builderradar-node-counter') ?? '0');
  const users = document.querySelectorAll<HTMLElement>(input.spec.userSelector);
  const assistants = document.querySelectorAll<HTMLElement>(input.spec.assistantSelector);
  const oldUsers = new Set(input.snapshot.userNodeIds);
  const oldAssistants = new Set(input.snapshot.assistantNodeIds);
  const wanted = input.expectedPrompt.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  let matchingUser: HTMLElement | null = null;
  let matchingUserId: string | null = null;

  for (let index = 0; index < users.length; index += 1) {
    const node = users[index];
    let identity = node.getAttribute('data-builderradar-node-id')
      || node.getAttribute('data-message-id')
      || node.id;
    if (!identity) {
      counter += 1;
      identity = `user-${counter}`;
      node.setAttribute('data-builderradar-node-id', identity);
    }
    if (oldUsers.has(identity)) continue;
    const rendered = (node.innerText || node.textContent || '')
      .normalize('NFKC').toLocaleLowerCase('en-US')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (wanted && rendered.includes(wanted)) {
      matchingUser = node;
      matchingUserId = identity;
      break;
    }
  }

  if (!matchingUser) {
    root.setAttribute('data-builderradar-node-counter', String(counter));
    return { status: 'waiting', rawAnswer: '', links: [], userNodeId: null, assistantNodeId: null, promptMatched: false, assistantFollowsUser: false };
  }

  let matchingAssistant: HTMLElement | null = null;
  let matchingAssistantId: string | null = null;
  for (let index = 0; index < assistants.length; index += 1) {
    const node = assistants[index];
    let identity = node.getAttribute('data-builderradar-node-id')
      || node.getAttribute('data-message-id')
      || node.id;
    if (!identity) {
      counter += 1;
      identity = `assistant-${counter}`;
      node.setAttribute('data-builderradar-node-id', identity);
    }
    if (oldAssistants.has(identity)) continue;
    if (!(matchingUser.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    matchingAssistant = node;
    matchingAssistantId = identity;
    break;
  }
  root.setAttribute('data-builderradar-node-counter', String(counter));

  if (!matchingAssistant) {
    return {
      status: 'waiting',
      rawAnswer: '',
      links: [],
      userNodeId: matchingUserId,
      assistantNodeId: null,
      promptMatched: true,
      assistantFollowsUser: false,
    };
  }

  const streaming = matchingAssistant.matches(input.spec.streamingSelector)
    || Boolean(matchingAssistant.querySelector(input.spec.streamingSelector))
    || Boolean(matchingAssistant.closest(input.spec.streamingSelector));
  const rawAnswer = matchingAssistant.innerText || matchingAssistant.textContent || '';
  const links: { url: string; title?: string }[] = [];
  const anchors = matchingAssistant.querySelectorAll<HTMLAnchorElement>('a[href]');
  for (let index = 0; index < anchors.length && links.length < 12; index += 1) {
    const anchor = anchors[index];
    if (!/^https?:\/\//i.test(anchor.href)) continue;
    if (input.spec.providerOrigin && anchor.href.startsWith(input.spec.providerOrigin)) continue;
    links.push({ url: anchor.href, title: (anchor.textContent ?? '').trim() || undefined });
  }
  return {
    status: streaming ? 'streaming' : 'ready',
    rawAnswer,
    links,
    userNodeId: matchingUserId,
    assistantNodeId: matchingAssistantId,
    promptMatched: true,
    assistantFollowsUser: true,
  };
}

export async function waitForStableCorrelatedTurn(
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
): Promise<CorrelatedTurnInspection> {
  const deadline = Date.now() + (input.timeoutMs ?? 180_000);
  const requiredStableChecks = input.stableChecks ?? 3;
  const minimumChars = input.minimumChars ?? 40;
  let previousText: string | null = null;
  let stableCount = 0;
  let lastStatus: CorrelatedTurnStatus = 'waiting';

  while (Date.now() < deadline) {
    if (input.signal?.aborted) {
      throw new Error(`provider_deadline:${input.provider}_aborted`);
    }
    await page.waitForTimeout(1_000);
    const inspection = await page.evaluate(inspectCorrelatedConversationTurn, {
      spec: input.spec,
      snapshot: input.snapshot,
      expectedPrompt: input.expectedPrompt,
    });
    lastStatus = inspection.status;
    if (inspection.status === 'login') throw new Error(`${input.provider} authentication required`);
    if (inspection.status === 'challenge') throw new Error(`${input.provider} challenge page blocked acquisition`);
    if (inspection.status === 'rate_limit') throw Object.assign(new Error(`${input.provider} rate limit`), { status: 429 });
    if (inspection.status !== 'ready' || inspection.rawAnswer.trim().length < minimumChars) {
      previousText = null;
      stableCount = 0;
      continue;
    }
    if (inspection.rawAnswer === previousText) stableCount += 1;
    else stableCount = 1;
    previousText = inspection.rawAnswer;
    if (stableCount >= requiredStableChecks) return inspection;
  }
  const html = await page.evaluate(() => document.body.innerHTML);
  console.log(`[${input.provider}] Turn timeout. Body HTML snippet:`, html.substring(0, 5000));
  throw new Error(`prompt_identity_unverified:${input.provider}_turn_timeout:last_state_${lastStatus}`);
}
