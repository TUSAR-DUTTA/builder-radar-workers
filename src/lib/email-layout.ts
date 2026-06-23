// Shared, email-client-safe layout primitives for every BuilderRadar email.
//
// Why this exists: each transactional email used to hand-roll its own <html>
// shell, header, footer and button — which drifted (invite had a plain-blue
// logo, the spike alert had no logo/footer at all) and repeated the same bugs.
// Funnel every email through `emailShell` + these helpers so the chrome (logo,
// footer, button, card, fonts, background) is identical everywhere, while each
// template still passes its own accent colour for semantic urgency.
//
// Email-client rules baked in here:
//  - Tables for layout, never `display:flex`/`gap` (both fail in Outlook/Gmail).
//  - All styles inline.
//  - Gradient headings declare a solid `color` FIRST so clients that don't
//    support `background-clip:text` (Outlook, some Gmail) degrade to solid blue
//    instead of rendering the logo invisible.

export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://builderradar.pro';
export const EMAIL_FROM = process.env.RESEND_FROM_EMAIL ?? 'BuilderRadar <noreply@builderradar.pro>';

// Brand palette — mirrors the in-app --color-tk-* tokens in globals.css.
export const BRAND = {
  bg: '#0f172a', // slate-900 page background
  surface: '#1e293b', // slate-800 card surface
  surfaceBorder: 'rgba(255,255,255,0.08)',
  divider: 'rgba(255,255,255,0.06)',
  text: '#f8fafc',
  textMuted: '#94a3b8',
  textDim: '#64748b',
  textFaint: '#475569',
  textFainter: '#334155',
  blue: '#3b82f6', // primary accent
  indigo: '#6366f1', // gradient end
  green: '#10b981', // positive / metrics
  red: '#ef4444', // urgency / alerts
  font: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
} as const;

const DEFAULT_TAGLINE = 'Market intelligence for founders';

/** HTML-escape user-controlled text used in chrome (preheader, taglines). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function brandHeader(tagline: string): string {
  // `color` is the Outlook/legacy fallback; the webkit props upgrade it to a
  // gradient where supported. Order matters — color must come before the fill.
  return `
  <h1 style="margin:0 0 4px 0;font-size:26px;font-weight:900;letter-spacing:-0.5px;color:${BRAND.blue};background:linear-gradient(135deg,${BRAND.blue},${BRAND.indigo});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;">BuilderRadar</h1>
  <p style="margin:0;color:${BRAND.textFaint};font-size:13px;">${escapeHtml(tagline)}</p>`;
}

function brandFooter(footerNote?: string): string {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${BRAND.divider};">
    <tr><td style="padding:20px 0 0 0;text-align:center;">
      <p style="margin:0 0 6px 0;color:${BRAND.textFainter};font-size:12px;line-height:1.7;">
        <a href="${APP_URL}" style="color:${BRAND.blue};text-decoration:none;font-weight:700;">BuilderRadar</a>&nbsp;·&nbsp;<a href="${APP_URL}/billing" style="color:${BRAND.textFaint};text-decoration:none;">Manage subscription</a>${footerNote ? `&nbsp;·&nbsp;${footerNote}` : ''}
      </p>
      <p style="margin:0;color:${BRAND.textFainter};font-size:11px;">You're receiving this because you have a BuilderRadar account.</p>
    </td></tr>
  </table>`;
}

/**
 * Wrap body HTML in the full branded email document: hidden preheader (inbox
 * preview text), gradient logo + tagline header, the body, and the footer.
 */
export function emailShell(opts: {
  preheader: string;
  bodyHtml: string;
  tagline?: string;
  footerNote?: string;
}): string {
  const { preheader, bodyHtml, tagline = DEFAULT_TAGLINE, footerNote } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;font-family:${BRAND.font};">
        <tr><td style="padding:0 8px 28px 8px;">${brandHeader(tagline)}</td></tr>
        <tr><td style="padding:0 8px;color:${BRAND.text};">${bodyHtml}</td></tr>
        <tr><td style="padding:32px 8px 8px 8px;">${brandFooter(footerNote)}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Inline-block CTA. `variant: 'ghost'` is the secondary (surface) style.
 * Styled bold/on-brand to match the app's identity: UPPERCASE, 900 weight,
 * wide letter-spacing.
 */
export function brandButton(
  href: string,
  label: string,
  opts: { accent?: string; variant?: 'solid' | 'ghost' } = {},
): string {
  const { accent = BRAND.blue, variant = 'solid' } = opts;
  const bg = variant === 'ghost' ? BRAND.surface : accent;
  const color = variant === 'ghost' ? BRAND.textMuted : '#ffffff';
  const border = variant === 'ghost' ? `border:1px solid ${BRAND.surfaceBorder};` : '';
  return `<a href="${href}" style="display:inline-block;background:${bg};color:${color};font-weight:900;font-size:13px;text-decoration:none;padding:14px 28px;border-radius:8px;text-transform:uppercase;letter-spacing:1px;${border}">${label}</a>`;
}

/** Surface card. Pass `accent` for a coloured left border (urgency cue). */
export function card(innerHtml: string, opts: { accent?: string } = {}): string {
  const leftBorder = opts.accent ? `border-left:4px solid ${opts.accent};` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.surface};border:1px solid ${BRAND.surfaceBorder};${leftBorder}border-radius:12px;margin:0 0 24px 0;">
    <tr><td style="padding:24px;">${innerHtml}</td></tr>
  </table>`;
}

/** Equal-width metric boxes, laid out with a table (flex-free for Outlook). */
export function metricGrid(cells: Array<{ value: string | number; label: string; color?: string }>): string {
  if (cells.length === 0) return '';
  const width = `${Math.floor(100 / cells.length)}%`;
  const tds = cells
    .map((c, i) => {
      const padLeft = i === 0 ? 0 : 6;
      const padRight = i === cells.length - 1 ? 0 : 6;
      return `<td width="${width}" style="padding:0 ${padRight}px 0 ${padLeft}px;vertical-align:top;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.surface};border:1px solid ${BRAND.surfaceBorder};border-radius:12px;">
          <tr><td style="padding:20px 12px;text-align:center;">
            <div style="color:${c.color ?? BRAND.blue};font-size:30px;font-weight:900;line-height:1;">${c.value}</div>
            <div style="color:${BRAND.textFaint};font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-top:8px;">${escapeHtml(c.label)}</div>
          </td></tr>
        </table>
      </td>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;"><tr>${tds}</tr></table>`;
}

/** Small uppercase section label (e.g. "TOP PAINS") — bold/on-brand. */
export function sectionLabel(text: string, color: string = BRAND.green): string {
  return `<p style="margin:0 0 12px 0;color:${color};font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:2px;">${escapeHtml(text)}</p>`;
}

/** Centered CTA wrapper with consistent vertical rhythm. */
export function ctaRow(buttonsHtml: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 8px 0;"><tr><td align="center">${buttonsHtml}</td></tr></table>`;
}
