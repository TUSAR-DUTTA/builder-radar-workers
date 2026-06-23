// Share-link tokens for the white-label public report. A token is `<b64url(projectId)>.<sig>` where
// sig = HMAC-SHA256(projectId) truncated. This is STATELESS by design: no new DB column or migration
// (the live schema has drifted before — we avoid touching it), and the signature makes the token
// unguessable so only someone given the exact link can view the report.
//
// Trade-off: revocation is global (rotate SHARE_LINK_SECRET) rather than per-link. Acceptable for a
// share/PDF report; if per-link revoke is ever needed, add a token column + allowlist check here.

import { createHmac, timingSafeEqual } from 'crypto';

// Prefer a dedicated secret; fall back to the service role key (always present, never sent to the
// client) so share links work out of the box without new env config.
function secret(): string {
  return process.env.SHARE_LINK_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64url = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

function sign(projectId: string): string {
  return createHmac('sha256', secret()).update(projectId).digest('base64url').slice(0, 24);
}

export function makeShareToken(projectId: string): string {
  return `${b64url(projectId)}.${sign(projectId)}`;
}

/** Verify a share token and return its projectId, or null if malformed/forged. */
export function verifyShareToken(token: string): string | null {
  if (!secret()) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  let projectId: string;
  try { projectId = unb64url(token.slice(0, dot)); } catch { return null; }
  const sig = token.slice(dot + 1);
  const expected = sign(projectId);
  if (sig.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) return null;
  return projectId;
}
