// Single source of truth for the answer engines BuilderRadar tracks. Adding a new engine
// (e.g. one fed by the Playwright worker) is a ONE-LINE change here: the dashboard labels,
// the per-plan "expected" set that drives the freshness/down badges, and the honest engine
// count all read from this registry — so a new engine lights up everywhere the moment its
// first answer_runs row lands, with no scattered edits.
//
// IMPORTANT — what counts as an engine: an engine must be WEB-GROUNDED (its answer reflects
// what a consumer assistant actually tells a buyer). We never pad the count with ungrounded
// model variants; the honest claim is the grounded set below.

import type { AnswerModel } from './types';

// Where the samples come from. Informational (drives copy/health framing), not behaviour.
//  - 'api'        : official provider API, sampled by the Vercel cron (src/app/api/cron/geo-run).
//  - 'playwright' : logged-in browser session, sampled by the worker (src/workers). Hands-off code.
export type EngineTransport = 'api' | 'playwright';

// Which plans should EXPECT this engine to report. This is what turns a silently-dead session
// into a loud "stale/down" badge instead of vanishing numbers.
//  - 'all'  : every plan expects it (free + paid).
//  - 'paid' : only paid plans expect it.
//  - 'none' : labelled-if-present only — shown as a first-class row once it has data, but never
//             forced as a red "not reporting" row before its feed exists. New Playwright engines
//             start here; flip to 'paid' once the worker reliably feeds them.
export type EngineExpectation = 'all' | 'paid' | 'none';

export interface EngineDef {
  id: AnswerModel;
  label: string;
  transport: EngineTransport;
  grounded: boolean;
  expectedFor: EngineExpectation;
}

// The registry. Order here is the canonical display order.
export const ENGINES: EngineDef[] = [
  // Official-API grounded engines (Vercel cron).
  { id: 'openai-search', label: 'ChatGPT', transport: 'api', grounded: true, expectedFor: 'paid' },
  { id: 'gemini-grounded', label: 'Gemini', transport: 'api', grounded: true, expectedFor: 'all' },
  // Logged-in browser engines (Playwright worker).
  { id: 'perplexity', label: 'Perplexity', transport: 'playwright', grounded: true, expectedFor: 'paid' },
  { id: 'claude', label: 'Claude', transport: 'playwright', grounded: true, expectedFor: 'paid' },
  { id: 'deepseek', label: 'DeepSeek', transport: 'playwright', grounded: true, expectedFor: 'paid' },
  { id: 'grok', label: 'xAI Grok', transport: 'playwright', grounded: true, expectedFor: 'paid' },
  // Google AI Overviews — fed by the Playwright worker (a SERP/AI-Overviews capture). Starts as
  // 'none' so paid dashboards don't show a red "not reporting" row before the worker ships its feed;
  // flip expectedFor to 'paid' once google-aio answer_runs land reliably.
  { id: 'google-aio', label: 'Google AI Overviews', transport: 'playwright', grounded: true, expectedFor: 'none' },
];

const BY_ID = new Map<string, EngineDef>(ENGINES.map((e) => [e.id, e]));

/** Human label for a stored model id; falls back to the raw id for legacy/unknown engines. */
export function engineLabel(model: string): string {
  return BY_ID.get(model)?.label ?? model;
}

/** model id → label map (the shape the dashboard route already consumed). */
export const MODEL_LABEL: Record<string, string> = Object.fromEntries(ENGINES.map((e) => [e.id, e.label]));

/** The engine ids a given plan should expect to see reporting (drives the freshness/down badges). */
export function expectedEngines(isPaid: boolean): string[] {
  return ENGINES.filter((e) => e.expectedFor === 'all' || (isPaid && e.expectedFor === 'paid')).map((e) => e.id);
}

/** True if `model` is a known engine in the registry (used to drop legacy/removed ids from the UI). */
export function isKnownEngine(model: string): boolean {
  return BY_ID.has(model);
}
