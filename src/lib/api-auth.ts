// Public API key auth. Keys are `br_<hex>`; we store only the sha256 hash.
// Gated to Pro. Keys are revocable and lastUsedAt is tracked.
//
// Rate limiting: a best-effort in-memory sliding-window per key (see
// checkRateLimit). NOTE: on Vercel serverless this is per-warm-instance, so it
// blunts a tight abuse loop against one instance but is NOT a global guarantee.
// Redis was removed; when traffic warrants a hard global cap, back this with a
// Postgres counter or a shared store. The window is deliberately generous so it
// never trips legitimate Pro usage.

import { createHash, randomBytes } from 'crypto';
import { db } from '@/db';
import { apiKeys, profiles } from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

const RATE_LIMIT_MAX = 120;        // requests per key
const RATE_LIMIT_WINDOW_MS = 60_000; // per rolling 60s
const rateBuckets = new Map<string, number[]>();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

// Best-effort sliding-window limiter. Keeps only in-window timestamps per key.
export function checkRateLimit(keyId: string, now = Date.now()): RateLimitResult {
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const hits = (rateBuckets.get(keyId) ?? []).filter((t) => t > windowStart);

  if (hits.length >= RATE_LIMIT_MAX) {
    const retryAfterSeconds = Math.max(1, Math.ceil((hits[0] + RATE_LIMIT_WINDOW_MS - now) / 1000));
    rateBuckets.set(keyId, hits);
    return { ok: false, remaining: 0, retryAfterSeconds };
  }

  hits.push(now);
  rateBuckets.set(keyId, hits);

  // Opportunistic cleanup so the Map can't grow unbounded across many keys.
  if (rateBuckets.size > 5_000) {
    for (const [k, ts] of rateBuckets) {
      const live = ts.filter((t) => t > windowStart);
      if (live.length === 0) rateBuckets.delete(k);
      else rateBuckets.set(k, live);
    }
  }

  return { ok: true, remaining: RATE_LIMIT_MAX - hits.length, retryAfterSeconds: 0 };
}

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = 'br_' + randomBytes(24).toString('hex');
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 11) };
}

export interface ApiAuthResult {
  userId: string;
  plan: string;
  keyId: string;
}

export async function authenticateApiKey(req: Request): Promise<ApiAuthResult | null> {
  const auth = req.headers.get('authorization') ?? '';
  const raw = auth.replace(/^Bearer\s+/i, '').trim();
  if (!raw.startsWith('br_')) return null;

  const hash = hashApiKey(raw);
  const [key] = await db
    .select({ id: apiKeys.id, userId: apiKeys.userId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!key) return null;

  const [profile] = await db.select({ plan: profiles.plan }).from(profiles).where(eq(profiles.id, key.userId)).limit(1);

  // Best-effort last-used tracking (don't block the response).
  void (async () => {
    try {
      await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id));
    } catch { /* ignore */ }
  })();

  return { userId: key.userId, plan: profile?.plan ?? 'free', keyId: key.id };
}
