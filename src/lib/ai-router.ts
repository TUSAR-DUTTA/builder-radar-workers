import Groq from 'groq-sdk';
import { CohereClient } from 'cohere-ai';
import { createHash } from 'crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

type Provider = 'groq-8b' | 'groq-70b' | 'gemini' | 'cohere-embed' | 'cohere-rerank' | 'hf-embed' | 'openrouter' | 'openai';

// ─── GEO answer-engine shape ───────────────────────────────────────────────────
// Grounded answer engines return both an answer and the sources they cited. The GEO
// scorer judges the answer; the citation graph powers the "which sources feed this answer" feature.
export interface GroundedAnswer {
  text: string;
  citations: { url: string; title?: string }[];
  model: string;
}

// Gate-capable Groq primary for bulk scoring. Scout is a SEPARATE Groq model-id from
// llama-3.3-70b-versatile, so on each of the 7 orgs it draws its OWN per-model rate-limit bucket —
// pointing the saturated bulk scorer at scout frees the 70B bucket to serve as a fallback tier
// (≈2x scoring headroom, no cost). Validated scout≈70B on the gold-referenced hard slice
// (scripts/model-sweep.ts): identical strong-recall, lower strong-tier junk-leak, and it applies the
// persona/intent/promoter gates the 8B collapses on. A safe CAPACITY swap, not an accuracy change.
const SCOUT_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

// ─── Key Pool ─────────────────────────────────────────────────────────────────

// The 7 Groq keys are API keys to 7 SEPARATE orgs, each with its own ~100k tokens/day budget.
// Any key can call any model, so the 70B pool deliberately includes ALL 7 keys (≈700k/day) — this
// is what keeps signal quality up: with 7x the daily budget, 70B scoring almost never has to
// degrade to 8B, which cannot apply the persona/intent/collision gates (it scores news/spam high).
const GROQ_8B_KEYS = [
  process.env.GROQ_8B_KEY_1,
  process.env.GROQ_8B_KEY_2,
  process.env.GROQ_8B_KEY_3,
  process.env.GROQ_8B_KEY_4,
].filter(Boolean) as string[];
const GROQ_70B_LABELED = [
  process.env.GROQ_70B_KEY_1,
  process.env.GROQ_70B_KEY_2,
  process.env.GROQ_70B_KEY_3,
].filter(Boolean) as string[];

// Gemini 2.5-flash is the FREE, gate-capable tier inserted between "all Groq 70B orgs
// rate-limited" and the dumb-8B degradation. It correctly applies the persona/intent/
// promoter gates that the 8B collapses on (verified: a "400+ signups cheat code" success-brag
// scores icp 1 on 2.5-flash, icp 7 on 8B/flash-lite). Each key is a separate Google AI Studio
// project with its own free-tier quota, so the 6-key pool multiplies daily budget the same way
// the 7 Groq orgs do. Free tier is thin and returns 429 (quota) / 503 (model overload) often —
// geminiComplete rotates across keys on those and the caller falls through, so an empty/exhausted
// pool reproduces today's exact behavior.
const GEMINI_KEYS = [
  process.env.GEMINI_KEY_1,
  process.env.GEMINI_KEY_2,
  process.env.GEMINI_KEY_3,
  process.env.GEMINI_KEY_4,
  process.env.GEMINI_KEY_5,
  process.env.GEMINI_KEY_6,
].filter(Boolean) as string[];

const KEY_POOLS: Record<Provider, string[]> = {
  'groq-8b': GROQ_8B_KEYS,
  // 70B model rotates across all 7 orgs (the 3 "70B" keys + the 4 "8B" keys).
  'groq-70b': [...GROQ_70B_LABELED, ...GROQ_8B_KEYS],
  'gemini': GEMINI_KEYS,
  'cohere-embed': [
    process.env.COHERE_KEY_1,
    process.env.COHERE_KEY_2,
    process.env.COHERE_KEY_3,
    process.env.COHERE_KEY_4,
  ].filter(Boolean) as string[],
  'cohere-rerank': [
    process.env.COHERE_KEY_5,
    process.env.COHERE_KEY_6,
    process.env.COHERE_KEY_7,
  ].filter(Boolean) as string[],
  'hf-embed': [
    process.env.HF_KEY_1,
    process.env.HF_KEY_2,
    process.env.HF_KEY_3,
    process.env.HF_KEY_4,
  ].filter(Boolean) as string[],
  'openrouter': [
    process.env.OPENROUTER_KEY_1,
    process.env.OPENROUTER_KEY_2,
    process.env.OPENROUTER_KEY_3,
    process.env.OPENROUTER_KEY_4,
    process.env.OPENROUTER_KEY_5,
    process.env.OPENROUTER_KEY_6,
    process.env.OPENROUTER_KEY_7,
  ].filter(Boolean) as string[],
  // GEO answer engine (paid, official API). Pooled so multiple keys can spread load,
  // but a single OPENAI_API_KEY is the common case.
  'openai': [
    process.env.OPENAI_API_KEY,
    process.env.OPENAI_API_KEY_2,
  ].filter(Boolean) as string[],
};

// In-memory round-robin per process (resets on cold start — fine for serverless)
const _rrIdx: Record<string, number> = {};

function pickKey(provider: Provider): string | null {
  const keys = KEY_POOLS[provider];
  if (!keys || keys.length === 0) return null;
  const idx = (_rrIdx[provider] ?? 0) % keys.length;
  _rrIdx[provider] = idx + 1;
  return keys[idx];
}

function usageKeyHash(provider: Provider, key: string): string {
  return createHash('sha256').update(`${provider}:${key}`).digest('hex');
}

// ─── Usage telemetry ──────────────────────────────────────────────────────────
// Best-effort, fire-and-forget. Records per-key request/token/error counts per day so AI
// spend is visible (api_key_usage was previously never written → cost leaks were invisible).
// db is dynamically imported and everything is wrapped in try/catch so it can NEVER affect or
// slow an AI call, and won't break in a runtime that can't load the pg driver.
function recordUsage(provider: Provider, key: string, tokens: number, isError: boolean): void {
  void (async () => {
    try {
      const [{ db }, { apiKeyUsage }, { sql }] = await Promise.all([
        import('@/db'), import('@/db/schema'), import('drizzle-orm'),
      ]);
      await db.insert(apiKeyUsage)
        .values({ provider, keyHash: usageKeyHash(provider, key), requests: 1, tokens, errors: isError ? 1 : 0 })
        .onConflictDoUpdate({
          target: [apiKeyUsage.provider, apiKeyUsage.keyHash, apiKeyUsage.date],
          set: {
            requests: sql`${apiKeyUsage.requests} + 1`,
            tokens: sql`${apiKeyUsage.tokens} + ${tokens}`,
            errors: sql`${apiKeyUsage.errors} + ${isError ? 1 : 0}`,
            lastUsed: sql`now()`,
          },
        });
    } catch { /* telemetry must never break the caller */ }
  })();
}

// ─── AIRouter Class ───────────────────────────────────────────────────────────

export class AIRouter {
  // ── Groq: LLM completion ─────────────────────────────────────────────────

  // Seam for testing: overridable client factory so tests can inject a fake Groq client
  // (e.g. one that always throws 429) and assert the fallback chain's behaviour without
  // real API traffic. Production always returns a real client.
  protected groqClient(key: string): Groq {
    return new Groq({ apiKey: key });
  }

  async groqComplete(params: {
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
    // Two gate-capable primaries (scout / 70B-versatile) + the gate-blind 8B. Scout and 70B share the
    // groq-70b key pool but have separate per-model rate buckets; the 429 cascade below treats both as
    // gate-capable and only excludes the 8B (callers degrade TO it, never fall back FROM it).
    model: 'llama-3.1-8b-instant' | 'llama-3.3-70b-versatile' | typeof SCOUT_MODEL;
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    // High-volume callers (bulk scoring) set this so a 70B rate-limit degrades to FREE 8B
    // instead of PAID OpenRouter. Low-volume quality tasks (ICP/agent/brief) leave it off
    // and keep the Claude-Haiku fallback. Caps the uncapped paid-spillover cost path.
    costSensitiveFallback?: boolean;
    // Quality-critical bulk scoring sets this. On 70B exhaustion it tries ONLY the gate-capable
    // tiers (rotate all 7 70B orgs → free Gemini 2.5-flash) and then THROWS — it never degrades
    // to the gate-blind 8B (which scores news/venting/off-topic at icp 8-10) nor to paid OpenRouter
    // (surprise prod cost). A thrown call leaves the signal unscored to be retried next run, so the
    // feed never receives 8B garbage. Correctness invariant of the scorer. Overrides costSensitiveFallback.
    gateCritical?: boolean;
  }, _attempt = 0): Promise<string> {
    const provider: Provider = params.model === 'llama-3.1-8b-instant' ? 'groq-8b' : 'groq-70b';
    const key = pickKey(provider);
    if (!key) throw new Error(`No Groq keys configured for ${params.model}`);

    const client = this.groqClient(key);

    // Groq's json_object response_format REJECTS (HTTP 400) any request whose messages don't contain
    // the literal word "json" somewhere. A 400 is not a rate-limit, so it is NOT retried/failed-over —
    // it just throws, and a JSON-mode caller whose prompt happens to omit the word silently fails EVERY
    // call. This bit the scorer's agent-prompt path (paid projects): the agent prompt replaced
    // SCORE_SYSTEM, the only text containing "JSON", so every scoring batch 400'd and all signals were
    // left unscored → empty feeds. Guarantee the word here so no caller can ever trip it again.
    const messages = (params.jsonMode && !params.messages.some((m) => /json/i.test(m.content)))
      ? [...params.messages, { role: 'system' as const, content: 'Respond with valid JSON only.' }]
      : params.messages;

    try {
      const res = await client.chat.completions.create({
        model: params.model,
        messages,
        temperature: params.temperature ?? 0.1,
        max_tokens: params.maxTokens ?? 1500,
        response_format: params.jsonMode ? { type: 'json_object' } : undefined,
        stream: false,
      });
      recordUsage(provider, key, res.usage?.total_tokens ?? 0, false);
      return res.choices[0]?.message?.content ?? '';
    } catch (err: unknown) {
      const apiErr = err as { status?: number; headers?: Record<string, string> };
      recordUsage(provider, key, 0, true);
      if (apiErr?.status === 429) {
        // Both gate-capable Groq primaries (70B-versatile and scout) share this cascade; only the
        // gate-blind 8B is excluded — callers degrade TO the 8B, never fall back FROM it.
        if (params.model !== 'llama-3.1-8b-instant') {
          // Rotate to the NEXT 70B org before degrading — each key is a separate org with its own
          // daily budget, so one org being rate-limited doesn't mean 70B is unavailable. But CAP the
          // rotation: measured in prod, retrying all 7 orgs (then 6 Gemini keys) turned one saturated
          // moment into ~13 calls/batch that mostly fail (94% error rate) and DEEPEN the per-minute
          // saturation they react to — a retry storm, not a budget wall (keys sat at ~30% of daily
          // tokens). At most 2 alternate orgs, then fall through; the cascade's volume cut + inter-batch
          // pacing are what actually keep 70B under its TPM ceiling, not brute-force retries.
          const poolSize = KEY_POOLS['groq-70b'].length;
          const maxRotations = Math.min(2, poolSize - 1);
          if (_attempt < maxRotations) {
            await new Promise((r) => setTimeout(r, 400 * (_attempt + 1)));
            return this.groqComplete(params, _attempt + 1);
          }
          // Scout's per-model bucket is exhausted across all orgs. Before paying latency on the thin
          // free Gemini pool, fall to llama-3.3-70b-versatile: a DIFFERENT model-id with its own
          // per-model rate bucket on the same orgs (untouched while scout was primary) and equally
          // gate-capable. Recurses with _attempt=0 so 70B runs its own rotation → Gemini → gate-critical
          // chain. This is the headroom the swap buys — both buckets are used before any degrade.
          if (params.model === SCOUT_MODEL) {
            console.warn('[groq] scout rate-limited → llama-3.3-70b-versatile (separate per-model bucket)');
            return this.groqComplete({ ...params, model: 'llama-3.3-70b-versatile' });
          }
          // Gate-capable FREE tier first (both cost-sensitive and quality paths). Gemini 2.5-flash
          // applies the persona/intent/promoter gates the 8B cannot, at no cost — so it closes the
          // "70B exhausted → dumb 8B re-injects false positives" hole. geminiComplete rotates its own
          // keys on 429/503 and throws only when the whole pool is exhausted or unconfigured; on throw
          // we fall through to the original behavior (8B for cost-sensitive, OpenRouter for quality).
          if (KEY_POOLS['gemini'].length > 0) {
            try {
              console.warn('[groq] 70B rate-limited → free gate-capable Gemini 2.5-flash');
              // `messages`, not params.messages: the fallback tiers must inherit the same
              // "json" guard injected above, or a jsonMode caller whose prompt omits the word
              // fails exactly when reliability matters most (the Groq-saturated path).
              return await this.geminiComplete({
                messages,
                temperature: params.temperature,
                maxTokens: params.maxTokens,
                jsonMode: params.jsonMode,
                // Cap the rotation: Gemini's free pool is ~88% rate-limited in practice, so trying
                // all 6 keys is mostly latency + failed calls that feed the same storm. Try at most 2.
                maxAttempts: 2,
              });
            } catch (gemErr) {
              console.warn('[gemini] pool exhausted/unavailable:', (gemErr as Error).message.slice(0, 80));
              // fall through to the pre-existing fallback chain below
            }
          }
          // Gate-critical (bulk scoring): the only acceptable scorers are 70B and Gemini, both of
          // which apply the persona/intent/collision gates. Both are now exhausted, so STOP — do not
          // degrade to the gate-blind 8B (it re-injects icp 8-10 false positives) or to paid
          // OpenRouter. Throwing leaves the signal unscored; the next run retries it. This is the
          // invariant that keeps 8B output out of the feed.
          if (params.gateCritical) {
            throw new Error('70B + Gemini exhausted (gate-critical: skipping, will retry next run)');
          }
          // Cost-sensitive (bulk scoring): skip paid OpenRouter, degrade to free 8B.
          if (params.costSensitiveFallback) {
            console.warn('[groq] 70B rate-limited (cost-sensitive) → free 8B');
            return this.groqComplete({ ...params, model: 'llama-3.1-8b-instant' });
          }
          // Quality tasks: prefer OpenRouter (Claude Haiku) over 8B — better classification,
          // no pain-phrase hallucination. Low volume, so the paid call is worth it.
          const orKey = pickKey('openrouter');
          if (orKey) {
            console.warn('[groq] 70B rate-limited, falling back to OpenRouter claude-haiku-4-5');
            // Claude via OpenRouter has no native json_object mode — the guarded `messages`
            // (with the injected "Respond with valid JSON only" line) are what keep jsonMode
            // callers parseable on this tier.
            return this.openrouterComplete({
              ...params,
              messages,
              model: 'anthropic/claude-haiku-4-5',
              _key: orKey,
            });
          }
          console.warn('[groq] 70B rate-limited, falling back to 8B (no OpenRouter keys configured — degraded quality)');
          return this.groqComplete({ ...params, model: 'llama-3.1-8b-instant' });
        }
        throw new Error('Groq rate-limited. Try again in a minute.');
      }
      throw err;
    }
  }

  // ── OpenRouter: multi-model fallback ─────────────────────────────────────

  async openrouterComplete(params: {
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
    model: string;
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    _key?: string; // pre-picked key (avoids a second pickKey call from groqComplete fallback)
  }): Promise<string> {
    const key = params._key ?? pickKey('openrouter');
    if (!key) throw new Error('No OpenRouter keys configured');

    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.1,
      max_tokens: params.maxTokens ?? 1500,
    };
    if (params.jsonMode) body.response_format = { type: 'json_object' };

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://builderradar.pro',
        'X-Title': 'BuilderRadar',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status === 429) throw Object.assign(new Error('OpenRouter rate-limited'), { status: 429 });
    if (!res.ok) throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
    recordUsage('openrouter', key, data.usage?.total_tokens ?? 0, false);
    return data.choices?.[0]?.message?.content ?? '';
  }

  // ── Gemini: free gate-capable fallback (OpenAI-compatible endpoint) ───────
  // Google AI Studio exposes an OpenAI-compatible chat endpoint, so this reuses the same
  // message/json shape as the rest of the router. Default model gemini-2.5-flash is a THINKING
  // model: reasoning tokens count toward max_tokens, so we (a) send reasoning_effort:'low' to cap
  // thinking and (b) floor max_tokens at 2048 so a batch of 4 scoring objects can't be truncated
  // (truncated JSON → the scorer silently drops the whole batch). On 429 (quota) / 503 (model
  // overload) / other 5xx it rotates to the next key up to the pool size, then throws so the
  // caller can fall through to the next tier.
  async geminiComplete(params: {
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    // Cap how many keys to rotate through on 429/503 before giving up. Defaults to the full pool
    // (standalone callers), but the 70B fallback passes a small value so a near-dead Gemini pool
    // can't amplify a retry storm. Bounded by the real pool size.
    maxAttempts?: number;
  }, _attempt = 0): Promise<string> {
    const key = pickKey('gemini');
    if (!key) throw new Error('No Gemini keys configured');
    const poolSize = Math.min(params.maxAttempts ?? KEY_POOLS['gemini'].length, KEY_POOLS['gemini'].length);
    const model = params.model ?? 'gemini-2.5-flash';

    const body: Record<string, unknown> = {
      model,
      messages: params.messages,
      temperature: params.temperature ?? 0,
      // Reasoning tokens count toward the output cap on 2.5 thinking models; give real headroom.
      max_tokens: Math.max(params.maxTokens ?? 1500, 2048),
      reasoning_effort: 'low',
    };
    if (params.jsonMode) body.response_format = { type: 'json_object' };

    let res: Response;
    try {
      res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (err) {
      // Network/timeout — rotate to next key, then give up so the caller falls through.
      if (_attempt < poolSize - 1) {
        await new Promise((r) => setTimeout(r, 300 * (_attempt + 1)));
        return this.geminiComplete(params, _attempt + 1);
      }
      throw err;
    }

    // 429 = free-tier quota, 503 = model overload, other 5xx = transient — rotate keys then fall through.
    if (res.status === 429 || res.status >= 500) {
      recordUsage('gemini', key, 0, true);
      if (_attempt < poolSize - 1) {
        await new Promise((r) => setTimeout(r, 400 * (_attempt + 1)));
        return this.geminiComplete(params, _attempt + 1);
      }
      throw new Error(`Gemini pool exhausted (last status ${res.status})`);
    }
    if (!res.ok) {
      recordUsage('gemini', key, 0, true);
      throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 120)}`);
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { total_tokens?: number };
    };
    recordUsage('gemini', key, data.usage?.total_tokens ?? 0, false);
    const choice = data.choices?.[0];
    // A 'length' finish on a thinking model means reasoning ate the budget before the JSON closed —
    // the content is truncated/empty and would fail to parse. Treat as failure so the caller falls
    // through rather than feeding the scorer a half-object it silently discards.
    if (choice?.finish_reason === 'length' && !(choice.message?.content ?? '').trim()) {
      throw new Error('Gemini truncated (finish_reason=length, empty content)');
    }
    return choice?.message?.content ?? '';
  }

  // ── Cohere: Embeddings ────────────────────────────────────────────────────

  async cohereEmbed(params: {
    texts: string[];
    inputType: 'search_document' | 'search_query' | 'classification';
    model?: 'embed-english-v3.0' | 'embed-multilingual-v3.0';
    truncate?: 'NONE' | 'START' | 'END';
  }, _attempt = 0): Promise<number[][]> {
    const key = pickKey('cohere-embed');
    if (!key) throw new Error('No Cohere embed keys configured');

    const client = new CohereClient({ token: key });

    try {
      const res = await client.v2.embed({
        texts: params.texts,
        model: params.model ?? 'embed-english-v3.0',
        inputType: params.inputType,
        embeddingTypes: ['float'],
        truncate: params.truncate ?? 'END',
      });
      const meta = res.meta as { billedUnits?: { inputTokens?: number } } | undefined;
      recordUsage('cohere-embed', key, meta?.billedUnits?.inputTokens ?? 0, false);
      const embeddings = res.embeddings as { float?: number[][] };
      return embeddings.float ?? [];
    } catch (err: unknown) {
      const apiErr = err as { statusCode?: number };
      recordUsage('cohere-embed', key, 0, true);
      // Bounded backoff — previously this recursed on every 429 with no delay or cap,
      // which becomes a tight infinite loop when the whole key pool is rate-limited.
      if (apiErr?.statusCode === 429 && _attempt < 3) {
        await new Promise((r) => setTimeout(r, 800 * (_attempt + 1)));
        return this.cohereEmbed(params, _attempt + 1);
      }
      throw err;
    }
  }

  // ── Cohere: Reranking ─────────────────────────────────────────────────────

  async cohereRerank(params: {
    query: string;
    documents: string[];
    topN?: number;
    model?: 'rerank-english-v3.0' | 'rerank-multilingual-v3.0';
  }, _attempt = 0): Promise<{ index: number; relevanceScore: number }[]> {
    const key = pickKey('cohere-rerank');
    if (!key) throw new Error('No Cohere rerank keys configured');

    const client = new CohereClient({ token: key });

    try {
      const res = await client.v2.rerank({
        query: params.query,
        documents: params.documents,
        topN: params.topN ?? 10,
        model: params.model ?? 'rerank-english-v3.0',
      });
      // Rerank bills in search units, not tokens — record the request so spend is at least visible.
      recordUsage('cohere-rerank', key, 0, false);
      return res.results as Array<{ index: number; relevanceScore: number }>;
    } catch (err: unknown) {
      const apiErr = err as { statusCode?: number };
      recordUsage('cohere-rerank', key, 0, true);
      if (apiErr?.statusCode === 429 && _attempt < 3) {
        await new Promise((r) => setTimeout(r, 800 * (_attempt + 1)));
        return this.cohereRerank(params, _attempt + 1);
      }
      throw err;
    }
  }

  // ── Hugging Face: Free embedding fallback ─────────────────────────────────

  async hfEmbed(texts: string[], model = 'BAAI/bge-m3', _attempt = 0): Promise<number[][]> {
    const key = pickKey('hf-embed');
    if (!key) throw new Error('No HuggingFace keys configured');

    const res = await fetch(`https://api-inference.huggingface.co/pipeline/feature-extraction/${model}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: texts, options: { wait_for_model: true, use_cache: true } }),
    });

    if (res.status === 429) {
      recordUsage('hf-embed', key, 0, true);
      if (_attempt >= 3) throw new Error('HF embed rate-limited after retries');
      await new Promise((r) => setTimeout(r, 800 * (_attempt + 1)));
      return this.hfEmbed(texts, model, _attempt + 1);
    }
    if (!res.ok) { recordUsage('hf-embed', key, 0, true); throw new Error(`HF embed failed: ${res.status}`); }
    recordUsage('hf-embed', key, 0, false);
    return res.json() as Promise<number[][]>;
  }

  // ── Unified embed: Cohere → HuggingFace ──────────────────────────────────

  // strict=true disables the HF fallback. The Qdrant 'signals' collection is a SINGLE Cohere-v3
  // vector space: bge-m3 vectors are the same dimension (1024) so the upsert/search SUCCEEDS, but
  // the two spaces are incompatible — an HF-embedded document is invisible (or noise) to every
  // Cohere-embedded query, and an HF query returns garbage against Cohere documents, silently and
  // untraceably. All paths that touch Qdrant must pass strict; the in-memory similarity callers
  // (e.g. MMF, which compares vectors from one call) keep the fallback for availability.
  async embed(texts: string[], type: 'query' | 'document' = 'document', opts?: { strict?: boolean }): Promise<number[][]> {
    try {
      return await this.cohereEmbed({
        texts,
        inputType: type === 'query' ? 'search_query' : 'search_document',
        model: 'embed-english-v3.0',
      });
    } catch (err) {
      if (opts?.strict) throw err; // Qdrant path: skip rather than poison the vector space
      console.warn('Cohere embed failed, falling back to HuggingFace');
      return this.hfEmbed(texts);
    }
  }

  // ── GEO: OpenAI Responses API + web search ────────────────────────────────
  // Asks the model a buyer question WITH web search on, so the answer reflects what an
  // AI assistant grounded in current web results would say. gpt-4.1-mini keeps the
  // fixed-8k-token search-content block cheap (~$0.004–0.005/call vs ~$0.025 on 4o).
  // Search-tool calls carry a per-request fee on top of tokens — recorded for COGS truth.
  async openaiSearch(prompt: string, opts?: { model?: string }): Promise<GroundedAnswer> {
    const key = pickKey('openai');
    if (!key) throw new Error('No OpenAI keys configured (OPENAI_API_KEY)');
    const model = opts?.model ?? 'gpt-4.1-mini';

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        tools: [{ type: 'web_search_preview' }],
        input: prompt,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      recordUsage('openai', key, 0, true);
      throw new Error(`OpenAI search error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json() as {
      output?: Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string; annotations?: Array<{ type?: string; url?: string; title?: string }> }>;
      }>;
      output_text?: string;
      usage?: { total_tokens?: number };
    };
    recordUsage('openai', key, data.usage?.total_tokens ?? 0, false);

    // The Responses API returns an array of output items; the message item holds text + annotations.
    let text = data.output_text ?? '';
    const citations: { url: string; title?: string }[] = [];
    for (const item of data.output ?? []) {
      for (const c of item.content ?? []) {
        if (c.text && !data.output_text) text += c.text;
        for (const a of c.annotations ?? []) {
          if ((a.type === 'url_citation' || a.url) && a.url) citations.push({ url: a.url, title: a.title });
        }
      }
    }
    if (!text.trim()) throw new Error('OpenAI search returned an empty answer');
    return { text: text.trim(), citations, model: 'openai-search' };
  }

  // ── GEO: Gemini + Google Search grounding (native REST) ───────────────────
  // The OpenAI-compatible geminiComplete cannot enable the google_search tool, so grounded
  // answers use the native generateContent endpoint. Free monthly grounding allowance applies
  // (Gemini 3: 5k/mo; 2.5: 1.5k/day) before per-request fees — recorded for COGS truth.
  //
  // gemini-2.5-flash is a THINKING model: reasoning + tool-use tokens count toward maxOutputTokens.
  // With the old 2048 cap, grounded buyer prompts routinely spent 1500+ tokens THINKING before
  // emitting the answer, so the response came back finish_reason=MAX_TOKENS with truncated/empty
  // text — which this method throws on ("returned empty") AFTER recording the call as a success.
  // That asymmetry (telemetry: gemini call OK / answer_runs: no gemini row) silently flatlined the
  // grounded engine for days while the per-engine catch in runPrompt swallowed it to a console.warn.
  // Fix mirrors geminiComplete's thinking-model handling: cap thinking (thinkingBudget) and give the
  // ANSWER real token headroom so reasoning can't starve it.
  async geminiGrounded(prompt: string, opts?: { model?: string }): Promise<GroundedAnswer> {
    const model = opts?.model ?? 'gemini-2.5-flash';
    let lastErr: Error | null = null;
    const pool = KEY_POOLS['gemini'];
    for (let attempt = 0; attempt < Math.max(1, pool.length); attempt++) {
      const key = pickKey('gemini');
      if (!key) throw new Error('No Gemini keys configured');
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              // thinkingBudget caps reasoning tokens (verified: keeps thoughts ~300-600 on grounded
              // buyer prompts); maxOutputTokens 4096 leaves room for a full grounded answer on top.
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4096,
                thinkingConfig: { thinkingBudget: 512 },
              },
              tools: [{ google_search: {} }],
            }),
            signal: AbortSignal.timeout(60_000),
          },
        );
        if (res.status === 429 || res.status >= 500) { lastErr = new Error(`Gemini ${res.status}`); recordUsage('gemini', key, 0, true); await new Promise((r) => setTimeout(r, 600 * (attempt + 1))); continue; }
        if (!res.ok) { recordUsage('gemini', key, 0, true); throw new Error(`Gemini grounded ${res.status}: ${(await res.text()).slice(0, 160)}`); }
        const json = await res.json() as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
            groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
          }>;
          usageMetadata?: { totalTokenCount?: number };
        };
        recordUsage('gemini', key, json.usageMetadata?.totalTokenCount ?? 0, false);
        const cand = json.candidates?.[0];
        const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
        if (!text) throw new Error('Gemini grounded returned empty');
        const citations = (cand?.groundingMetadata?.groundingChunks ?? [])
          .map((c) => ({ url: c.web?.uri ?? '', title: c.web?.title }))
          .filter((c) => c.url);
        return { text, citations, model: 'gemini-grounded' };
      } catch (e) {
        lastErr = e as Error;
      }
    }
    throw lastErr ?? new Error('Gemini grounded: all keys exhausted');
  }

}

// ── Singleton export ───────────────────────────────────────────────────────────

let _router: AIRouter | null = null;

export function getAIRouter(): AIRouter {
  if (!_router) _router = new AIRouter();
  return _router;
}
