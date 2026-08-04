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
const { decrypt } = require('../utils/credentials');

const RESEND_URL = 'https://api.resend.com/emails';
const TERMII_URL = 'https://api.ng.termii.com/api/sms/send';
const SEND_TIMEOUT_MS = 15_000;

// ── Per-workspace credentials ────────────────────────────────────────────
// Same shape as paystackService.js's resolvePaystackSecretKey: a workspace
// that has configured its own Resend account sends receipts, portal links,
// document notifications and overdue alerts from ITS domain; one that never
// has keeps using the platform's, exactly as before this feature existed.
//
// Unlike the Paystack key, a decrypt failure here does not throw up to the
// caller — rule 1 above (a send must never fail the request that triggered
// it) still holds — but it also must not silently fall back to sending as
// "Archta" when a workspace's own key just failed to read; sendEmail below
// records that as a failed send instead, same as any other misconfiguration.
async function resolveResendCredentials(orgId) {
  const { data } = await supabaseAdmin
    .from('re_org_settings')
    .select('resend_api_key_encrypted, resend_from_email')
    .eq('organization_id', orgId)
    .maybeSingle();

  if (data?.resend_api_key_encrypted) {
    try {
      return { apiKey: decrypt(data.resend_api_key_encrypted), from: data.resend_from_email || env.resend.from, error: null };
    } catch (err) {
      console.error('[notify] could not decrypt org Resend key:', err.message);
      return { apiKey: null, from: null, error: "This workspace's email key could not be read." };
    }
  }
  return { apiKey: env.resend.apiKey || null, from: env.resend.from || null, error: null };
}

// Same shape again for Termii: a workspace's own account and sender ID send
// payment reminders and overdue texts as itself; absent, it keeps using the
// platform's, exactly as before this feature existed. Same non-throwing
// decrypt-failure handling as Resend above, for the same reason — sendSms
// below must never fail the request that triggered it.
async function resolveTermiiCredentials(orgId) {
  const { data } = await supabaseAdmin
    .from('re_org_settings')
    .select('termii_api_key_encrypted, termii_sender_id')
    .eq('organization_id', orgId)
    .maybeSingle();

  if (data?.termii_api_key_encrypted) {
    try {
      return {
        apiKey: decrypt(data.termii_api_key_encrypted),
        senderId: data.termii_sender_id || env.termii.senderId,
        error: null,
      };
    } catch (err) {
      console.error('[notify] could not decrypt org Termii key:', err.message);
      return { apiKey: null, senderId: null, error: "This workspace's SMS key could not be read." };
    }
  }
  return { apiKey: env.termii.apiKey || null, senderId: env.termii.senderId || null, error: null };
}

// ── Phone numbers ──────────────────────────────────────────────────────────
// Nigerian numbers are written locally as 0803… and internationally as
// 234803…. Termii wants the second form. Anything already in international
// form, with or without a +, is left alone.
function normalizeNigerianPhone(raw) {
  let digits = String(raw || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (!digits) return null;
  // "00" is the international dialing prefix used in place of "+" —
  // 00234803… is the same number as +234803…. Left unstripped this fell into
  // the "leading 0 = local trunk prefix" branch below and mangled it.
  if (digits.startsWith('00') && digits.length > 2) digits = digits.slice(2);
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

// Promise.race against a bare fetch() used to "time out" the CALLER while the
// request itself kept running to completion (or hanging) in the background —
// no signal ever told the socket to give up, so a slow provider still left a
// connection open for however long it felt like. AbortController actually
// stops the request.
async function fetchWithTimeout(url, options, ms, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${label} timed out after ${ms}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

  const { apiKey, from, error } = await resolveResendCredentials(orgId);

  if (error) {
    await record({ ...base, status: 'failed', error });
    return { status: 'failed', reason: error };
  }

  if (!apiKey || !from) {
    await record({ ...base, status: 'skipped', error: 'RESEND_API_KEY or RESEND_FROM not configured' });
    return { status: 'skipped', reason: 'email not configured' };
  }

  try {
    const payload = {
      from,
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

    const response = await fetchWithTimeout(
      RESEND_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
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

// The Settings "test these credentials" button. Unlike Paystack's key check,
// Resend has no read-only "am I valid" endpoint that doesn't cost a send — so
// this sends one real, small email to the workspace owner's own address,
// using the CANDIDATE key and from-address (not yet saved), exactly the same
// reasoning as verifyPaystackKey testing the form value rather than whatever
// is already persisted.
async function sendTestEmail({ apiKey, from, to }) {
  if (!apiKey || !from) return { valid: false, reason: 'Both an API key and a From address are required.' };
  if (!to) return { valid: false, reason: 'No recipient to send the test to.' };

  let response;
  try {
    response = await fetchWithTimeout(
      RESEND_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [String(to)],
          subject: 'Archta — test email',
          html: emailShell({
            heading: 'This is a test email',
            intro: "If you can read this, your Resend API key and From address are both working. Emails from this workspace will now be sent from this address instead of Archta's default.",
          }),
        }),
      },
      SEND_TIMEOUT_MS,
      'Resend'
    );
  } catch (err) {
    return { valid: false, reason: err.message || 'Resend is not responding right now. Try again shortly.' };
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { valid: false, reason: body.message || `Resend returned ${response.status}.` };
  }
  return { valid: true };
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

  const { apiKey, senderId, error } = await resolveTermiiCredentials(orgId);

  if (error) {
    await record({ ...base, status: 'failed', error });
    return { status: 'failed', reason: error };
  }

  if (!apiKey || !senderId) {
    await record({ ...base, status: 'skipped', error: 'TERMII_API_KEY not configured' });
    return { status: 'skipped', reason: 'sms not configured' };
  }

  try {
    const response = await fetchWithTimeout(
      TERMII_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: recipient,
          from: senderId,
          sms: String(body || ''),
          type: 'plain',
          channel: 'generic',
          api_key: apiKey,
        }),
      },
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

// The Settings "test these credentials" button. Same reasoning as
// sendTestEmail — Termii has no read-only "am I valid" check, and a sender ID
// only actually proves itself by getting a text delivered, so this sends one
// real, short text to a phone number the caller provides (there is no
// account-level "the workspace owner's own phone" the way there is an email
// address), using the CANDIDATE key and sender id, not whatever is saved.
async function sendTestSms({ apiKey, senderId, to }) {
  if (!apiKey || !senderId) return { valid: false, reason: 'Both an API key and a sender ID are required.' };
  const recipient = normalizeNigerianPhone(to);
  if (!recipient) return { valid: false, reason: 'Enter a valid Nigerian phone number to test.' };

  let response;
  try {
    response = await fetchWithTimeout(
      TERMII_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: recipient,
          from: senderId,
          sms: 'Archta: this is a test message. Your Termii sender ID is working.',
          type: 'plain',
          channel: 'generic',
          api_key: apiKey,
        }),
      },
      SEND_TIMEOUT_MS,
      'Termii'
    );
  } catch (err) {
    return { valid: false, reason: err.message || 'Termii is not responding right now. Try again shortly.' };
  }

  const json = await response.json().catch(() => ({}));
  const failed = !response.ok || /error|insufficient/i.test(json.message || '');
  if (failed) {
    return { valid: false, reason: json.message || `Termii returned ${response.status}.` };
  }
  return { valid: true };
}

// ── Presentation ───────────────────────────────────────────────────────────
const stripTags = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const naira = (amount) => {
  const n = Number(amount || 0);
  return (n < 0 ? '-' : '') + '₦' + Math.abs(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });
};

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
        <span style="color:#c9a45c;font-size:12px;letter-spacing:.22em;text-transform:uppercase;font-family:Helvetica,Arial,sans-serif">Archta</span>
      </td></tr>
      <tr><td style="padding:30px 28px;font-family:Helvetica,Arial,sans-serif;color:#111">
        <h1 style="margin:0 0 12px;font-size:20px;font-weight:600">${escapeHtml(heading)}</h1>
        ${intro ? `<p style="margin:0;font-size:15px;line-height:1.6;color:#3c3c3c">${escapeHtml(intro)}</p>` : ''}
        ${rowsHtml}
        ${body}
        ${ctaHtml}
      </td></tr>
      <tr><td style="padding:16px 28px;background:#fafafa;border-top:1px solid #ececec;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#8a8a8a">
        ${escapeHtml(footer || 'Sent by Archta on behalf of your property developer.')}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

module.exports = {
  sendEmail,
  sendSms,
  sendTestEmail,
  sendTestSms,
  resolveResendCredentials,
  resolveTermiiCredentials,
  emailShell,
  normalizeNigerianPhone,
  naira,
  stripTags,
};
