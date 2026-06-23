'use client';

import { sendGAEvent } from '@next/third-parties/google';

/**
 * Fire a Google Analytics 4 event.
 *
 * Safe to call anywhere on the client: it no-ops when GA is not configured
 * (no NEXT_PUBLIC_GA_ID) or when the gtag script is blocked / not yet loaded,
 * so it never throws and never breaks the UI.
 *
 * Prefer GA4's recommended event names where one fits
 * (e.g. `sign_up`, `login`, `begin_checkout`, `purchase`) — GA understands
 * those natively and builds reports around them.
 *
 * @example trackEvent('sign_up', { method: 'email' })
 * @example trackEvent('begin_checkout', { plan: 'pro', value: 79, currency: 'USD' })
 */
export function trackEvent(
  name: string,
  params: Record<string, string | number | boolean> = {},
): void {
  if (!process.env.NEXT_PUBLIC_GA_ID) return;
  try {
    sendGAEvent('event', name, params);
  } catch {
    // GA blocked (ad blocker), not loaded yet, or running server-side — ignore.
  }
}
