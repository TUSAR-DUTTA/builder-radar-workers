import { Resend, type CreateEmailOptions } from 'resend';
import {
  APP_URL,
  EMAIL_FROM,
  BRAND,
  emailShell,
  brandButton,
  card,
  metricGrid,
  sectionLabel,
  ctaRow,
  escapeHtml,
} from './email-layout';

// Lazily construct the Resend client. The Resend SDK now THROWS in its
// constructor when the API key is missing/empty, so eager construction at
// module load crashed every importer (e.g. the worker via notify.ts) in any
// environment without RESEND_API_KEY — before doing any work. Defer it to the
// first actual send so a missing key only fails the send, not the process.
let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      throw new Error('RESEND_API_KEY is not set — cannot send email.');
    }
    _resend = new Resend(key);
  }
  return _resend;
}

/**
 * Test-only seam: inject a fake Resend client so the email-preview harness
 * (scripts/render-emails.ts) can capture the rendered HTML without sending
 * real mail or needing a RESEND_API_KEY. Not used by the app at runtime.
 */
export function __setResendClientForTesting(client: Pick<Resend, 'emails'>): void {
  _resend = client as Resend;
}

const FROM = EMAIL_FROM;

/**
 * Sends an email via Resend and THROWS when Resend reports a failure.
 *
 * The Resend SDK resolves (it does NOT reject) with `{ data, error }` on a
 * failed send — e.g. an unverified from-domain returns a 403 inside `error`
 * while the promise still fulfils. Callers that only `try/catch` around the
 * send therefore treat a failed send as success. Funnel every send through
 * this wrapper so a failed send becomes a real thrown error that callers'
 * existing try/catch can surface (sent:false / 500), instead of being swallowed.
 */
export async function sendEmail(payload: CreateEmailOptions) {
  const { data, error } = await getResend().emails.send(payload);
  if (error) {
    throw new Error(`Resend send failed: ${error.message ?? JSON.stringify(error)}`);
  }
  return data;
}

/**
 * Operational alert to the BuilderRadar admin (NOT a customer email). Used by the
 * health checks when a scrape source goes silently dark. No-ops when ADMIN_ALERT_EMAIL
 * is unset so it never crashes a cron run in an environment without it configured.
 */
export async function sendAdminAlert({ subject, lines }: { subject: string; lines: string[] }) {
  const to = process.env.ADMIN_ALERT_EMAIL;
  if (!to) {
    console.warn('[admin-alert] ADMIN_ALERT_EMAIL not set — skipping:', subject);
    return;
  }
  const body = `
    <h2 style="font-size:20px;font-weight:800;color:${BRAND.text};margin:0 0 16px 0;">⚠️ ${escapeHtml(subject)}</h2>
    ${card(
      lines
        .map((l) => `<p style="color:${BRAND.text};font-size:14px;line-height:1.7;margin:0 0 8px 0;">${escapeHtml(l)}</p>`)
        .join(''),
      { accent: BRAND.red },
    )}
    <p style="color:${BRAND.textFaint};font-size:12px;line-height:1.6;margin:20px 0 0 0;">
      Automated BuilderRadar health check. Most likely a Playwright session expired — re-run the
      relevant save-session script and update the GitHub secret.
    </p>`;
  return sendEmail({
    from: FROM,
    to,
    subject: `⚠️ BuilderRadar health: ${subject}`,
    html: emailShell({ preheader: subject, bodyHtml: body }),
  });
}

export async function sendWelcomeEmail({ email, name }: { email: string; name?: string }) {
  const displayName = escapeHtml(name ?? email.split('@')[0]);
  const body = `
    <h2 style="font-size:22px;font-weight:800;color:${BRAND.text};margin:0 0 16px 0;">Welcome aboard, ${displayName}.</h2>
    <p style="color:${BRAND.textMuted};font-size:15px;line-height:1.7;margin:0 0 24px 0;">
      Your account is ready. Paste your <code style="background:${BRAND.surface};padding:2px 6px;border-radius:4px;color:${BRAND.blue};">project.md</code> and BuilderRadar will start surfacing where your ICP is voicing the exact problem you solve.
    </p>
    ${card(`
      ${sectionLabel('Your first three steps')}
      <ol style="color:${BRAND.text};font-size:15px;line-height:2;margin:0;padding-left:20px;">
        <li>Create your first project — paste your <strong>project.md</strong>.</li>
        <li>Give it ~2 minutes for ICP extraction and signal discovery.</li>
        <li>Explore Live Pain Signals, Pain Vocabulary, and the Community Atlas.</li>
      </ol>
    `)}
    ${ctaRow(brandButton(`${APP_URL}/projects`, 'Open your dashboard →'))}
    <p style="color:${BRAND.textFaint};font-size:13px;line-height:1.6;margin:28px 0 0 0;">
      You're on the Free plan. <a href="${APP_URL}/billing" style="color:${BRAND.indigo};text-decoration:none;">Upgrade to Starter or Pro</a> for more projects and real-time signals.
    </p>`;

  return sendEmail({
    from: FROM,
    to: email,
    subject: 'Welcome to BuilderRadar — your ICP radar is ready',
    html: emailShell({
      preheader: 'Your ICP radar is ready. Create your first project to start surfacing pain signals.',
      bodyHtml: body,
    }),
  });
}

export async function sendWeeklyDigest({
  email,
  name,
  projectName,
  topSignals,
  totalSignalsThisWeek,
  topPainScore,
}: {
  email: string;
  name?: string;
  projectName: string;
  topSignals: Array<{ title: string; source: string; painIntensity: number; url: string }>;
  totalSignalsThisWeek: number;
  topPainScore: number;
}) {
  const displayName = escapeHtml(name ?? email.split('@')[0]);
  const safeProjectName = escapeHtml(projectName);
  const signalRows = topSignals
    .map(
      (s) => `
    <tr>
      <td style="padding:14px 16px;border-top:1px solid ${BRAND.divider};">
        <span style="background:${BRAND.bg};color:${BRAND.textMuted};font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(s.source)}</span>
        <p style="color:${BRAND.text};font-size:14px;font-weight:600;line-height:1.5;margin:8px 0 0 0;"><a href="${s.url}" style="color:${BRAND.text};text-decoration:none;">${escapeHtml(s.title)}</a></p>
      </td>
      <td style="padding:14px 16px;border-top:1px solid ${BRAND.divider};text-align:right;vertical-align:top;white-space:nowrap;">
        <span style="color:${BRAND.green};font-weight:900;font-size:18px;">${s.painIntensity}</span>
        <div style="color:${BRAND.textFaint};font-size:10px;margin-top:2px;text-transform:uppercase;letter-spacing:0.5px;">pain</div>
      </td>
    </tr>`,
    )
    .join('');

  const body = `
    <p style="color:${BRAND.textMuted};font-size:15px;margin:0 0 24px 0;">Here's how the market moved for <strong style="color:${BRAND.text};">${safeProjectName}</strong> this week, ${displayName}.</p>
    ${metricGrid([
      { value: totalSignalsThisWeek, label: 'Signals this week', color: BRAND.blue },
      { value: topPainScore, label: 'Highest pain score', color: BRAND.green },
    ])}
    ${sectionLabel(`Top signals · ${safeProjectName}`, BRAND.textMuted)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.surface};border:1px solid ${BRAND.surfaceBorder};border-radius:12px;margin:0 0 24px 0;">
      ${signalRows}
    </table>
    ${ctaRow(brandButton(`${APP_URL}/projects`, 'View all signals →'))}`;

  return sendEmail({
    from: FROM,
    to: email,
    subject: `BuilderRadar weekly: ${totalSignalsThisWeek} signals for ${projectName}`,
    html: emailShell({
      preheader: `${totalSignalsThisWeek} new signals for ${projectName} — top pain score ${topPainScore}/10.`,
      bodyHtml: body,
    }),
  });
}

export async function sendMarketBriefEmail({
  email,
  projectName,
  month,
  summary,
  topPains,
  topFeatureAsk,
}: {
  email: string;
  projectName: string;
  month: string;
  summary: string | null;
  topPains: string[];
  topFeatureAsk: string | null;
}) {
  const safeProjectName = escapeHtml(projectName);
  const painRows = topPains
    .slice(0, 5)
    .map((p) => `<li style="color:${BRAND.text};font-size:14px;line-height:1.9;">${escapeHtml(p)}</li>`)
    .join('');

  const body = `
    <p style="color:${BRAND.textFaint};font-size:13px;margin:0 0 20px 0;">Monthly market brief · ${safeProjectName} · ${escapeHtml(month)}</p>
    ${summary ? `<p style="color:#cbd5e1;font-size:16px;line-height:1.7;margin:0 0 24px 0;">${escapeHtml(summary)}</p>` : ''}
    ${sectionLabel('Top pains this month', BRAND.textMuted)}
    <ul style="margin:0 0 24px 0;padding-left:20px;">${painRows}</ul>
    ${
      topFeatureAsk
        ? card(`
      ${sectionLabel('#1 feature the market wants')}
      <p style="color:${BRAND.text};font-size:15px;line-height:1.6;margin:0;">${escapeHtml(topFeatureAsk)}</p>
    `)
        : ''
    }
    ${ctaRow(brandButton(`${APP_URL}/projects`, 'Read the full brief →'))}`;

  return sendEmail({
    from: FROM,
    to: email,
    subject: `📊 ${projectName} — Market Brief (${month})`,
    html: emailShell({
      preheader: `Your ${month} market brief for ${projectName}: top pains and the #1 requested feature.`,
      bodyHtml: body,
    }),
  });
}

