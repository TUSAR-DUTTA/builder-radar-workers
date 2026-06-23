// Outbound webhook delivery. Best-effort — never throws into the caller.
// Signs each payload with the webhook's own secret (HMAC-SHA256) so receivers
// can verify authenticity.

import { createHmac, randomBytes } from 'crypto';
import { db } from '@/db';
import { webhooks } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';

// The events a user can subscribe an outbound webhook to. These mirror the WebhookEvent union
// below and are emitted (alongside Slack) via emitEvent() from the GEO run/weekly pipelines.
export const WEBHOOK_EVENTS = [
  { id: 'accuracy_alert.created', label: 'AI states something wrong about you (new accuracy alert)' },
  { id: 'answer.changed', label: 'A tracked AI answer changed (up or down)' },
  { id: 'weekly_digest.ready', label: 'Weekly answer-recovery digest is ready' },
] as const;
export type WebhookEvent = 'accuracy_alert.created' | 'answer.changed' | 'weekly_digest.ready';

export function signPayload(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

// SSRF guard for outbound webhook targets. Requires https and rejects hosts that
// point at internal/link-local/private infrastructure (loopback, cloud metadata
// at 169.254.169.254, RFC1918 ranges, *.internal / *.local). Literal-IP targets
// are covered exactly; for DNS hostnames this blocks the obvious internal names
// but cannot defend against rebinding — acceptable for a blind, non-reflected
// outbound webhook. Used at create-time (fast feedback) and again at fire-time.
export function isSafeWebhookUrl(raw: string, opts: { allowHttp?: boolean } = {}): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (opts.allowHttp) {
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  } else if (u.protocol !== 'https:') {
    return false;
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  // Obvious internal hostnames
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.internal') || host.endsWith('.local')) return false;

  // IPv6 loopback / unique-local / link-local
  if (host === '::1') return false;
  if (host.startsWith('fc') || host.startsWith('fd')) return false; // fc00::/7
  if (host.startsWith('fe80')) return false; // link-local

  // IPv4 literal ranges
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return false;                       // loopback
    if (a === 10) return false;                        // 10.0.0.0/8
    if (a === 0) return false;                         // 0.0.0.0/8
    if (a === 169 && b === 254) return false;          // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
    if (a === 192 && b === 168) return false;          // 192.168.0.0/16
  }

  return true;
}

export function generateWebhookSecret(): string {
  return 'whsec_' + randomBytes(24).toString('hex');
}

async function bumpFailure(id: string): Promise<void> {
  try {
    // Auto-disable after 10 consecutive failures so a dead endpoint stops costing us.
    await db.update(webhooks)
      .set({ failureCount: sql`${webhooks.failureCount} + 1`, active: sql`(${webhooks.failureCount} + 1) < 10` })
      .where(eq(webhooks.id, id));
  } catch { /* ignore */ }
}

export async function fireWebhooks(
  userId: string,
  projectId: string | null,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const hooks = await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.userId, userId), eq(webhooks.active, true)));

    const matching = hooks.filter(
      (h) => h.events.includes(event) && (h.projectId === null || h.projectId === projectId),
    );
    if (matching.length === 0) return;

    const body = JSON.stringify({
      event,
      projectId,
      firedAt: new Date().toISOString(),
      data: payload,
    });

    await Promise.allSettled(
      matching.map(async (hook) => {
        // Defense-in-depth: skip any stored target that resolves to an internal
        // host (e.g. created before this guard, or a hostname that now points
        // somewhere unsafe). Counts as a failure so dead/blocked hooks auto-disable.
        if (!isSafeWebhookUrl(hook.url)) {
          await bumpFailure(hook.id);
          return;
        }
        try {
          const res = await fetch(hook.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-BuilderRadar-Event': event,
              'X-BuilderRadar-Signature': signPayload(hook.secret, body),
              'User-Agent': 'BuilderRadar-Webhooks/1.0',
            },
            body,
            signal: AbortSignal.timeout(8000),
          });
          if (res.ok) {
            await db.update(webhooks).set({ lastFiredAt: new Date(), failureCount: 0 }).where(eq(webhooks.id, hook.id));
          } else {
            await bumpFailure(hook.id);
          }
        } catch {
          await bumpFailure(hook.id);
        }
      }),
    );
  } catch (err) {
    console.error('[webhooks] fire failed:', err);
  }
}
