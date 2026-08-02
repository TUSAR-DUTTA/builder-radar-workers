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

export function isGrokTurnCorrelated(snapshot: GrokTurnSnapshot, candidate: GrokTurnCandidate): boolean {
  const newAssistant = candidate.assistantCount > snapshot.assistantCount
    || (candidate.text.length >= 50 && candidate.text !== snapshot.lastAssistantText);
  
  const hasMatchingUser = candidate.promptBound === true || candidate.lastMatchingUserIndex > 0;
  const isNewTurnSequence = candidate.userCount > snapshot.userCount || candidate.assistantCount > snapshot.assistantCount;

  return Boolean(
    newAssistant
    && hasMatchingUser
    && isNewTurnSequence
    && (candidate.assistantFollowsMatchingUser || candidate.promptBound === true)
    && !candidate.busy
    && candidate.text.trim().length >= 50
  );
}

