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
  promptBound?: boolean;
}

/** Pure prompt-turn correlation shared by the scraper and adversarial DOM fixtures. */
export function isGrokTurnCorrelated(snapshot: GrokTurnSnapshot, candidate: GrokTurnCandidate): boolean {
  const newAssistant = candidate.assistantCount > snapshot.assistantCount
    || (candidate.text.length >= 50 && candidate.text !== snapshot.lastAssistantText);
  
  const newBoundUser = candidate.promptBound === true
    || (candidate.userCount > snapshot.userCount && candidate.lastMatchingUserIndex >= 0)
    || (candidate.lastMatchingUserIndex >= 0 && candidate.lastMatchingUserIndex >= snapshot.userCount);

  return newAssistant
    && newBoundUser
    && (candidate.assistantFollowsMatchingUser || candidate.promptBound === true)
    && !candidate.busy
    && candidate.text.trim().length >= 50;
}

