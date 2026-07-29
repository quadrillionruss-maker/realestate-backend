// notificationService.js — the product stops being silent.
//
// Two channels, both optional:
//   email → Resend  (RESEND_API_KEY + RESEND_FROM)
//   sms   → Termii  (TERMII_API_KEY) — Nigerian provider, local support,
//                    materially cheaper than Twilio for +234 traffic
//
// THREE RULES, all of them about not making things worse:
//
// 1. A send NEVER fails the request that triggered it. Recording a ₦5m bank
//    transfer must not 500 because Resend is having an afternoon. Every entry
//    point resolves; failures are written down, not thrown.
//
// 2. Every attempt is logged to re_notifications with an outcome of 'sent',
//    'failed' or 'skipped'. Without the row, "the buyer never got their
//    receipt" is unanswerable, and a missing API key looks exactly like a
//    delivered email.
//
// 3. No provider is contacted without a configured key. Absent key → 'skipped',
//    which is a different thing from 'failed' and reads differently in the log.

const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');
const { escapeHtml } = require('../utils/escapeHtml');

const RESEND_URL = 'https://api.resend.com/emails';
const TERMII_URL = 'https://api.ng.termii.com/api/sms/send';
const SEND_TIMEOUT_MS = 15_000;

// ── Phone numbers ──────────────────────────────────────────────────────────
// Nigerian numbers are written locally as 0803… and internationally as
// 234803…. Termii wants the second form. Anything already in international
// form, with or without a +, is left alone.
function normalizeNigerianPhone(raw) {
  const digits = String(raw || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (!digits) return null;
  if (digits.startsWith('234')) return digits;
  if (digits.startsWith('0')) return `234${digits.slice(1)}`;
  // 10 digits with no leading zero is the local form with the zero dropped.
  if (digits.length === 10) return `234${digits}`;
  return digits;
}

async function record(entry) {
  try {
    await supabaseAdmin.from('re_notifications').insert(entry);
  } catch (err) {
    // The log failing must not take the caller down with it.
    console.warn('[notify] could not write notification log:', err.message);
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.()
    ),
  ]);
}

// ── Email ──────────────────────────────────────────────────────────────────
async function sendEmail({
  orgId,
  to,
  subject,
  html,
  text,
  template = null,
  replyTo = null,
  attachments = null,
  relatedType = null,
  relatedId = null,
}) {
  const base = {
    organization_id: orgId,
    channel: 'email',
    recipient: String(to || ''),
    subject: subject || null,
    body: text || stripTags(html || ''),
    template,
    related_type: relatedType,
    related_id: relatedId,
    provider: 'resend',
  };

  if (!to) return { status: 'skipped', reason: 'no recipient' };

  if (!env.resend.apiKey || !env.resend.from) {
    await record({ ...base, status: 'skipped', error: 'RESEND_API_KEY or RESEND_FROM not configured' });
    return { status: 'skipped', reason: 'email not configured' };
  }

  try {
    const payload = {
      from: env.resend.from,
      to: [String(to)],
      subject: subject || '(no subject)',
      html: html || undefined,
      text: text || undefined,
    };
    if (replyTo) payload.reply_to = replyTo;
    // Resend takes base64 content, which is how a freshly rendered receipt PDF
    // reaches the buyer without ever being given a public URL.
    if (attachments?.length) {
      payload.attachments = attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
      }));
    }

    const response = await withTimeout(
      fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.resend.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }),
      SEND_TIMEOUT_MS,
      'Resend'
    );

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body.message || `Resend returned ${response.status}`;
      await record({ ...base, status: 'failed', error: message });
      return { status: 'failed', reason: message };
    }

    await record({ ...base, status: 'sent', provider_id: body.id || null });
    return { status: 'sent', id: body.id || null };
  } catch (err) {
    await record({ ...base, status: 'failed', error: err.message });
    return { status: 'failed', reason: err.message };
  }
}

// ── SMS ────────────────────────────────────────────────────────────────────
async function sendSms({ orgId, to, body, template = null, relatedType = null, relatedId = null }) {
  const recipient = normalizeNigerianPhone(to);
  const base = {
    organization_id: orgId,
    channel: 'sms',
    recipient: recipient || String(to || ''),
    body: String(body || ''),
    template,
    related_type: relatedType,
    related_id: relatedId,
    provider: 'termii',
  };

  if (!recipient) return { status: 'skipped', reason: 'no recipient' };

  if (!env.termii.apiKey) {
    await record({ ...base, status: 'skipped', error: 'TERMII_API_KEY not configured' });
    return { status: 'skipped', reason: 'sms not configured' };
  }

  try {
    const response = await withTimeout(
      fetch(TERMII_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: recipient,
          from: env.termii.senderId,
          sms: String(body || ''),
          type: 'plain',
          channel: 'generic',
          api_key: env.termii.apiKey,
        }),
      }),
      SEND_TIMEOUT_MS,
      'Termii'
    );

    const json = await response.json().catch(() => ({}));
    // Termii answers 200 with a body describing the failure, so the status
    // code alone is not the outcome.
    const failed = !response.ok || /error|insufficient/i.test(json.message || '');
    if (failed) {
      const message = json.message || `Termii returned ${response.status}`;
      await record({ ...base, status: 'failed', error: message });
      return { status: 'failed', reason: message };
    }

    await record({ ...base, status: 'sent', provider_id: json.message_id || null });
    return { status: 'sent', id: json.message_id || null };
  } catch (err) {
    await record({ ...base, status: 'failed', error: err.message });
    return { status: 'failed', reason: err.message };
  }
}

// ── Presentation ───────────────────────────────────────────────────────────
const stripTags = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const naira = (amount) =>
  '₦' + Number(amount || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });

// One shell for every transactional email, so a receipt and a reset link look
// like they came from the same company. Inline styles only — Gmail strips
// <style> blocks, and a receipt that renders as unstyled text reads as a scam.
function emailShell({ heading, intro, rows = [], body = '', ctaLabel, ctaUrl, footer }) {
  const rowsHtml = rows.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">${
        rows.map(([label, value]) => `
          <tr>
            <td style="padding:9px 0;color:#6b6b6b;border-bottom:1px solid #ececec">${escapeHtml(label)}</td>
            <td style="padding:9px 0;text-align:right;color:#111;font-weight:600;border-bottom:1px solid #ececec">${escapeHtml(value)}</td>
          </tr>`).join('')
      }</table>`
    : '';

  const ctaHtml = ctaUrl
    ? `<p style="margin:26px 0"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#0b0b0b;color:#c9a45c;text-decoration:none;padding:13px 24px;border-radius:4px;font-weight:600;font-size:14px;letter-spacing:.02em">${escapeHtml(ctaLabel || 'Open')}</a></p>
       <p style="margin:0;font-size:12px;color:#8a8a8a;word-break:break-all">Or paste this into your browser:<br>${escapeHtml(ctaUrl)}</p>`
    : '';

  return `<!doctype html><html><body style="margin:0;padding:0;background:#f5f3ef">
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#f5f3ef;padding:32px 12px">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border:1px solid #e4e0d8;border-radius:8px;overflow:hidden">
      <tr><td style="background:#0b0b0b;padding:18px 28px">
        <span style="color:#c9a45c;font-size:12px;letter-spacing:.22em;text-transform:uppercase;font-family:Helvetica,Arial,sans-serif">Realtika</span>
      </td></tr>
      <tr><td style="padding:30px 28px;font-family:Helvetica,Arial,sans-serif;color:#111">
        <h1 style="margin:0 0 12px;font-size:20px;font-weight:600">${escapeHtml(heading)}</h1>
        ${intro ? `<p style="margin:0;font-size:15px;line-height:1.6;color:#3c3c3c">${escapeHtml(intro)}</p>` : ''}
        ${rowsHtml}
        ${body}
        ${ctaHtml}
      </td></tr>
      <tr><td style="padding:16px 28px;background:#fafafa;border-top:1px solid #ececec;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#8a8a8a">
        ${escapeHtml(footer || 'Sent by Realtika on behalf of your property developer.')}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

module.exports = {
  sendEmail,
  sendSms,
  emailShell,
  normalizeNigerianPhone,
  naira,
  stripTags,
};
