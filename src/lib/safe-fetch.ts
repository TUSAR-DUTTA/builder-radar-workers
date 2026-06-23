// SSRF-safe text fetch, shared by the GEO crawl audit (cron + on-demand API). Same posture as the
// analyze-url onboarding fetch: every hop (including redirects) is re-validated against
// isSafeWebhookUrl so a redirect can't be used to reach an internal address. Returns { status, text }
// — status is meaningful (the crawl audit treats a 404 on /robots.txt or /llms.txt as "absent").

import { isSafeWebhookUrl } from '@/lib/webhooks';

export async function fetchTextSafe(
  initialUrl: string,
  opts?: { timeoutMs?: number; maxBytes?: number },
): Promise<{ status: number; text: string } | null> {
  const timeoutMs = opts?.timeoutMs ?? 12_000;
  const maxBytes = opts?.maxBytes ?? 2_000_000;
  let url = initialUrl;
  for (let hop = 0; hop < 5; hop++) {
    if (!isSafeWebhookUrl(url, { allowHttp: true })) return null;
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'BuilderRadar/1.0 (+https://builderradar.pro)' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch { return null; }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { status: res.status, text: '' };
      try { url = new URL(loc, url).toString(); } catch { return null; }
      continue;
    }
    const text = (await res.text().catch(() => '')).slice(0, maxBytes);
    return { status: res.status, text };
  }
  return null;
}
