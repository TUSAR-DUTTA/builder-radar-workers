import type { ConversationDomSpec } from './conversation-dom';

export const CHATGPT_TURN_SPEC: ConversationDomSpec = Object.freeze({
  userSelector: 'section[data-turn="user"][data-testid^="conversation-turn-"]',
  assistantSelector: 'section[data-turn="assistant"][data-testid^="conversation-turn-"]',
  answerSelector: '[data-message-author-role="assistant"] .markdown, [data-message-author-role="assistant"] .prose, [data-message-author-role="assistant"]',
  terminalSelector: 'button[data-testid="copy-turn-action-button"]',
  streamingSelector: '[aria-busy="true"], [class*="result-streaming"]',
  globalStopSelector: '[data-testid="stop-button"], button[aria-label="Stop generating"]',
  loginSelector: 'form[action*="login"], [data-testid="login-button"]',
  challengeSelector: 'iframe[src*="challenge"], #challenge-running',
  rateLimitSelector: '[data-testid="rate-limit-message"]',
  interstitialSelector: '[data-testid="log-back-form"], [data-dd-action-name="Select existing session"]',
  providerOrigin: 'https://chatgpt.com',
  userIdentityAttributes: ['data-message-id', 'data-testid', 'id'],
  assistantIdentityAttributes: ['data-message-id', 'data-testid', 'id'],
  terminalSignal: 'chatgpt_turn_actions_complete',
});

export const CLAUDE_TURN_SPEC: ConversationDomSpec = Object.freeze({
  userSelector: '[data-is-user="true"], [data-testid="user-message"], [class*="font-user-message"]',
  assistantSelector: '[data-is-user="false"], [data-testid="assistant-message"], [class*="font-claude-response"]',
  answerSelector: '[data-testid="assistant-message-content"], [class*="font-claude-response"], .font-claude-response',
  terminalSelector: 'button[aria-label="Copy response"], button[aria-label*="Copy response" i], button[aria-label="Copy"], button[data-testid="copy-response-button"], button[data-testid*="copy" i]',
  streamingSelector: '[data-is-streaming="true"], [aria-busy="true"], [class*="streaming"], [class*="animate-spin"], [class*="animate-pulse"]',
  globalStopSelector: 'button[aria-label="Stop response"], button[aria-label*="Stop generating" i]',
  loginSelector: 'form[action*="login"], button[data-testid="login-button"]',
  challengeSelector: 'iframe[src*="cloudflare"], #challenge-running',
  rateLimitSelector: '[data-testid="rate-limit-message"], [data-testid="usage-limit"]',
  interstitialSelector: '[data-testid="onboarding-modal"], [data-testid="account-interstitial"]',
  providerOrigin: 'https://claude.ai',
  userIdentityAttributes: ['data-message-id', 'id'],
  assistantIdentityAttributes: ['data-message-id', 'id'],
  terminalSignal: 'claude_response_actions_complete',
});

export const GROK_TURN_SPEC: ConversationDomSpec = Object.freeze({
  userSelector: 'div[data-testid*="user"], [data-message-author-role="user"], .message.user, [class*="message"][class*="user"], .query-text',
  assistantSelector: 'div[data-testid*="assistant"], [data-message-author-role="assistant"], div[data-testid*="response"], div.response-content, div.response-body, .message.assistant, [class*="message"][class*="assistant"]',
  answerSelector: '[data-testid="message-content"], .response-content, .response-body, [class*="prose"]',
  terminalSelector: 'button[aria-label="Copy response"], button[aria-label="Copy"], button[data-testid="copy-button"]',
  streamingSelector: '[data-is-streaming="true"], [aria-busy="true"], [class*="streaming"]',
  globalStopSelector: 'button[aria-label="Stop"], button[aria-label="Stop generating"], [data-testid="stop-button"]',
  loginSelector: 'form[action*="login"], a[href*="/login"]',
  challengeSelector: 'iframe[src*="challenge"], #challenge-running',
  rateLimitSelector: '[data-testid="rate-limit-message"], [data-testid="usage-limit"]',
  interstitialSelector: '[data-testid="account-interstitial"], [data-testid="onboarding-modal"]',
  providerOrigin: 'https://grok.com',
  userIdentityAttributes: ['data-message-id', 'id'],
  assistantIdentityAttributes: ['data-message-id', 'id'],
  terminalSignal: 'grok_response_actions_complete',
});
