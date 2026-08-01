export interface GrokTurnSnapshot {
  assistantCount: number;
  userCount: number;
  lastAssistantText: string;
}

export interface GrokTurnCandidate {
  assistantCount: number;
  userCount: number;
  lastMatchingUserIndex: number;
  assistantFollowsMatchingUser: boolean;
  text: string;
  busy: boolean;
}

/** Pure prompt-turn correlation shared by the scraper and adversarial DOM fixtures. */
export function isGrokTurnCorrelated(snapshot: GrokTurnSnapshot, candidate: GrokTurnCandidate): boolean {
  const newAssistant = candidate.assistantCount > snapshot.assistantCount
    || candidate.text !== snapshot.lastAssistantText;
  const newBoundUser = candidate.userCount > snapshot.userCount
    && candidate.lastMatchingUserIndex >= snapshot.userCount;
  return newAssistant
    && newBoundUser
    && candidate.assistantFollowsMatchingUser
    && !candidate.busy
    && candidate.text.trim().length >= 40;
}
