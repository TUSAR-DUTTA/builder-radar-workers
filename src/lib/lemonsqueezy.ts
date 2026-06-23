const LS_API_BASE = 'https://api.lemonsqueezy.com/v1';

function lsHeaders() {
  return {
    Authorization: `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`,
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
  };
}

// GEO pivot (2026-06-11): plans now describe AI-answer share-of-voice tracking, not the
// retired signal-feed scrapers. $29 Solo is a FOUNDING price (50%-off-forever for the first
// cohort); list moves to $39–49 once COGS is measured on real usage. See GEO_PIVOT_DESIGN.md §6.
// `starter` is kept as the internal key for the $29 tier so existing billing/webhook wiring
// (mapLSStatusToPlan, variant env vars) keeps working without a migration.
export const PLANS = {
  free: {
    name: 'Free',
    price: 0,
    priceLabel: '$0',
    period: 'month',
    variantId: null,
    features: [
      '1 free "How AI sees you" report',
      'AI visibility score + competitor share-of-answers',
      'The top sources AI engines cite for your category',
      'Snapshot only — no tracking',
    ],
    limits: { maxProjects: 1, maxPrompts: 15, signalsPerDay: 100, retentionDays: 7, emailDigest: false, realtime: false },
  },
  starter: {
    name: 'Solo',
    price: 29,
    priceLabel: '$29',
    period: 'month',
    variantId: process.env.LEMONSQUEEZY_STARTER_VARIANT_ID ?? '',
    features: [
      '1 brand tracked',
      '25 buyer prompts, sampled on scheduled runs',
      'ChatGPT · Perplexity · Claude · Gemini',
      'Weekly Monday email: what changed + the sources behind it',
      'Share of AI answers vs competitors',
      'Citation-source graph (which pages feed the answers)',
      'Movement alerts by email',
      'Founding rate — 50% off forever',
    ],
    limits: { maxProjects: 1, maxPrompts: 25, signalsPerDay: 1000, retentionDays: 30, emailDigest: true, realtime: false },
  },
  pro: {
    name: 'Growth',
    price: 79,
    priceLabel: '$79',
    period: 'month',
    variantId: process.env.LEMONSQUEEZY_PRO_VARIANT_ID ?? '',
    features: [
      '3 brands tracked',
      '75 buyer prompts, sampled on scheduled runs',
      'ChatGPT · Perplexity · Claude · Gemini',
      'Everything in Solo, plus:',
      'Per-competitor deep-dive + battlecards',
      'Answer-change tracking (the moat)',
      'Movement alerts by email + Slack',
      'Priority support',
    ],
    limits: { maxProjects: 3, maxPrompts: 75, signalsPerDay: -1, retentionDays: 60, emailDigest: true, realtime: true },
  },
} as const;

export type PlanKey = keyof typeof PLANS;

export async function createCheckoutUrl({
  variantId,
  userId,
  userEmail,
  redirectUrl,
  productName,
  priceCents,
}: {
  variantId: string;
  userId: string;
  userEmail: string;
  redirectUrl: string;
  // The LS store still holds the pre-pivot products ("Starter" $19 / "Pro" $79) and the
  // API can't rename or reprice them, so every checkout overrides name + price to match
  // what the billing page advertises (Solo $29 / Growth $79).
  productName: string;
  priceCents: number;
}): Promise<string> {
  if (!variantId) {
    throw new Error('Variant ID not configured. Check LEMONSQUEEZY_STARTER_VARIANT_ID / LEMONSQUEEZY_PRO_VARIANT_ID env vars.');
  }

  const storeId = process.env.LEMONSQUEEZY_STORE_ID!;

  const body = {
    data: {
      type: 'checkouts',
      attributes: {
        custom_price: priceCents,
        checkout_data: {
          email: userEmail,
          custom: { user_id: userId },
        },
        product_options: {
          name: productName,
          redirect_url: redirectUrl,
          receipt_button_text: 'Open Dashboard',
          receipt_thank_you_note: 'Thanks for subscribing to BuilderRadar!',
        },
        checkout_options: {
          embed: false,
          media: true,
          logo: true,
        },
      },
      relationships: {
        store: { data: { type: 'stores', id: String(storeId) } },
        variant: { data: { type: 'variants', id: String(variantId) } },
      },
    },
  };

  const res = await fetch(`${LS_API_BASE}/checkouts`, {
    method: 'POST',
    headers: lsHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LemonSqueezy checkout failed: ${err}`);
  }

  const json = (await res.json()) as { data: { attributes: { url: string } } };
  return json.data.attributes.url;
}

export async function getSubscription(subscriptionId: string) {
  const res = await fetch(`${LS_API_BASE}/subscriptions/${subscriptionId}`, {
    headers: lsHeaders(),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data: unknown };
  return json.data;
}

export async function cancelSubscription(subscriptionId: string) {
  const res = await fetch(`${LS_API_BASE}/subscriptions/${subscriptionId}`, {
    method: 'DELETE',
    headers: lsHeaders(),
  });
  return res.ok;
}

export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET!;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto') as typeof import('crypto');
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // timingSafeEqual throws if buffers differ in length — check first
  if (digest.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

export function mapLSStatusToPlan(eventName: string, variantId: string): { plan: PlanKey; status: string } {
  const starterVariantId = process.env.LEMONSQUEEZY_STARTER_VARIANT_ID;
  const proVariantId = process.env.LEMONSQUEEZY_PRO_VARIANT_ID;

  let plan: PlanKey;
  if (starterVariantId && variantId === starterVariantId) {
    plan = 'starter';
  } else if (proVariantId && variantId === proVariantId) {
    plan = 'pro';
  } else {
    // Variant ID unrecognised — env vars likely missing in production.
    // Default to free to avoid accidentally granting paid access.
    console.error(`[mapLSStatusToPlan] unknown variantId=${variantId} (starter=${starterVariantId} pro=${proVariantId}) — defaulting to free`);
    plan = 'free';
  }
  const statusMap: Record<string, string> = {
    subscription_created: 'active',
    subscription_updated: 'active',
    subscription_cancelled: 'cancelled',
    subscription_expired: 'expired',
    subscription_paused: 'paused',
    subscription_unpaused: 'active',
    subscription_payment_failed: 'past_due',
    subscription_payment_success: 'active',
    subscription_payment_recovered: 'active',
  };
  return { plan, status: statusMap[eventName] ?? 'active' };
}
