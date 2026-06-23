// Unified event emission: Slack (respecting per-user toggles) + outbound webhooks.
// Best-effort — never throws into the caller. Wire this into anywhere an
// answer-recovery event is actually implemented.

import { db } from '@/db';
import { profiles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { sendSlackMessage } from '@/lib/slack';
import { fireWebhooks, type WebhookEvent } from '@/lib/webhooks';

// Which profile notification toggle gates the Slack message for each event.
// null = always send (no per-category toggle).
const SLACK_TOGGLE: Partial<Record<WebhookEvent, 'notifRealtimeSignals' | 'notifWeeklyBrief' | null>> = {
  'accuracy_alert.created': 'notifRealtimeSignals',
  'answer.changed': 'notifRealtimeSignals',
  'weekly_digest.ready': 'notifWeeklyBrief',
};

export async function emitEvent(
  userId: string,
  projectId: string | null,
  event: WebhookEvent,
  opts: { slackText?: string; payload?: Record<string, unknown> },
): Promise<void> {
  // Outbound webhooks fire regardless of Slack toggles.
  const webhookPromise = fireWebhooks(userId, projectId, event, opts.payload ?? {});

  // Profile is shared by the Slack and email channels — fetch it once.
  const profilePromise = db
    .select({
      email: profiles.email,
      plan: profiles.plan,
      slackWebhookUrl: profiles.slackWebhookUrl,
      notifRealtimeSignals: profiles.notifRealtimeSignals,
      notifWeeklyBrief: profiles.notifWeeklyBrief,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1)
    .then((rows) => rows[0]);

  const slackPromise = (async () => {
    if (!opts.slackText) return;
    try {
      const profile = await profilePromise;
      if (!profile?.slackWebhookUrl) return;

      const toggle = SLACK_TOGGLE[event];
      if (toggle && !profile[toggle]) return; // user disabled this Slack category

      await sendSlackMessage(profile.slackWebhookUrl, opts.slackText);
    } catch (err) {
      console.error('[notify] slack failed:', err);
    }
  })();

  await Promise.allSettled([webhookPromise, slackPromise]);
}
