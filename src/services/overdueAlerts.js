// overdueAlerts.js — telling the humans, on the morning it happens.
//
// The product used to be entirely silent. A buyer missed a payment and nobody
// heard about it until someone happened to read the 7am brief, which the rep
// responsible for that buyer usually is not the person reading.
//
// ── Why this is a "what changed" alert and not a daily digest ──────────────
// A rep with eleven buyers in arrears does not need eleven reminders every
// morning for eleven weeks; that is how an alert becomes a filter rule. So the
// email covers what is NEW today — installments that flipped to overdue this
// morning, and promises that broke — with the standing arrears total as
// context rather than as the subject. On a day when nothing new went wrong,
// nothing is sent.
//
// Runs inside the 07:00 job, after markOverdue and the promise sweep, so
// "became overdue today" is a fact rather than a guess.

const { supabaseAdmin } = require('../middleware/orgContext');
const { lagosToday, describeDue } = require('./overdueService');
const { describeStage } = require('./escalationService');
const notify = require('./notificationService');
const { mapWithConcurrency } = require('../utils/concurrency');

// Termii calls, one per buyer — a developer with a couple hundred buyers
// three days from due plus a couple hundred who just missed used to send
// these one at a time, each waiting out its own network round trip before
// the next buyer's text even started.
const SMS_CONCURRENCY = 5;

const naira = (amount) => {
  const n = Number(amount || 0);
  return (n < 0 ? '-' : '') + '₦' + Math.abs(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });
};

const formatDate = (value) =>
  new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// markOverdue flips everything with due_date < today, so the rows that changed
// state this morning are exactly the ones due yesterday.
const yesterdayOf = (today) =>
  new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10);

async function notifyOverdue(orgId) {
  const { data: settings } = await supabaseAdmin
    .from('re_org_settings')
    .select('company_name, notify_on_overdue, notify_md_email, reply_to_email')
    .eq('organization_id', orgId)
    .maybeSingle();

  if (settings && settings.notify_on_overdue === false) return { sent: 0, reason: 'disabled' };

  const today = lagosToday();
  const yesterday = yesterdayOf(today);
  const company = settings?.company_name || 'Your developer';

  const { data: rows, error } = await supabaseAdmin
    .from('re_installment_schedule')
    .select(`
      id, installment_number, due_date, amount_due,
      re_installment_plans!inner(
        re_reservations!inner(
          id, escalation_stage,
          re_customers(full_name, phone),
          re_units(unit_number, re_projects(name)),
          re_sales_reps(id, users(full_name, email))
        )
      )`)
    .eq('organization_id', orgId)
    .eq('status', 'overdue')
    .eq('due_date', yesterday);
  if (error) throw error;

  if (!rows?.length) return { sent: 0, reason: 'nothing new became overdue' };

  // Group by rep. Unassigned buyers fall to the MD — an unassigned overdue
  // buyer is a management problem rather than a rep's.
  const byRep = new Map();
  const unassigned = [];

  for (const row of rows) {
    const reservation = row.re_installment_plans?.re_reservations;
    if (!reservation) continue;

    const item = {
      customer: reservation.re_customers?.full_name || 'Unknown buyer',
      phone: reservation.re_customers?.phone || null,
      unit: reservation.re_units?.unit_number || null,
      project: reservation.re_units?.re_projects?.name || null,
      installment: row.installment_number,
      amount: Number(row.amount_due || 0),
      due_date: row.due_date,
      stage: describeStage(reservation.escalation_stage).label,
    };

    const rep = reservation.re_sales_reps;
    if (rep?.users?.email) {
      const entry = byRep.get(rep.id) || { email: rep.users.email, name: rep.users.full_name || 'there', items: [] };
      entry.items.push(item);
      byRep.set(rep.id, entry);
    } else {
      unassigned.push(item);
    }
  }

  let sent = 0;

  for (const rep of byRep.values()) {
    const total = rep.items.reduce((sum, item) => sum + item.amount, 0);
    const result = await notify.sendEmail({
      orgId,
      to: rep.email,
      subject: rep.items.length === 1
        ? `${rep.items[0].customer} missed a payment`
        : `${rep.items.length} of your buyers missed a payment`,
      html: notify.emailShell({
        heading: 'Missed payments on your portfolio',
        intro: `${rep.items.length === 1 ? 'One buyer' : `${rep.items.length} buyers`} on your list did not pay yesterday — ${naira(total)} in total.`,
        body: itemsTable(rep.items),
        footer: `${company} · You are receiving this because these buyers are assigned to you.`,
      }),
      text: rep.items.map((i) => `${i.customer} — ${naira(i.amount)} due ${formatDate(i.due_date)}`).join('\n'),
      template: 'overdue_rep_alert',
      replyTo: settings?.reply_to_email || null,
    });
    if (result.status === 'sent') sent += 1;
  }

  // ── The MD ────────────────────────────────────────────────────────────────
  // Not a copy of every rep's email. The MD hears about the two things a rep
  // cannot fix on their own: buyers far enough gone to be a legal question,
  // and buyers with nobody assigned to them.
  const mdEmail = settings?.notify_md_email;
  if (mdEmail) {
    const serious = rows
      .map((row) => row.re_installment_plans?.re_reservations)
      .filter((r) => r && ['final_notice', 'legal'].includes(r.escalation_stage));

    if (serious.length || unassigned.length) {
      const sections = [];
      if (serious.length) {
        sections.push(`<p style="margin:16px 0 6px;font-weight:600">${serious.length} buyer(s) at final notice or legal stage</p>`
          + itemsTable(serious.map((r) => ({
            customer: r.re_customers?.full_name || 'Unknown buyer',
            unit: r.re_units?.unit_number || null,
            project: r.re_units?.re_projects?.name || null,
            amount: 0,
            stage: describeStage(r.escalation_stage).label,
          })), { showAmount: false }));
      }
      if (unassigned.length) {
        sections.push('<p style="margin:16px 0 6px;font-weight:600">No sales rep assigned</p>'
          + itemsTable(unassigned));
      }

      const result = await notify.sendEmail({
        orgId,
        to: mdEmail,
        subject: 'Collections needing your attention',
        html: notify.emailShell({
          heading: 'Escalations this morning',
          intro: 'These are the arrears a sales rep cannot resolve on their own.',
          body: sections.join(''),
          footer: `${company} · Change who receives this in Settings.`,
        }),
        text: `${serious.length} buyers at final notice or legal stage; ${unassigned.length} overdue buyers with no rep assigned.`,
        template: 'overdue_md_alert',
      });
      if (result.status === 'sent') sent += 1;
    }
  }

  return { sent, new_overdue: rows.length, reps_notified: byRep.size, unassigned: unassigned.length };
}

// ── Reminders to the BUYER ────────────────────────────────────────────────
//
// The brief drafts a WhatsApp message per overdue buyer and a human copies and
// sends each one. For a developer with fifty buyers in arrears that is fifty
// copy-pastes every morning, which is the point at which "saves admin time"
// stops being true.
//
// This sends the routine ones automatically by SMS: three days before a due
// date, and the morning after one is missed. Two deliberate limits:
//
//   * OFF BY DEFAULT (notify_payment_reminders). Every other notification in
//     this product goes to the developer's own staff. This one messages their
//     customers and costs money per message, so it is a decision somebody
//     makes rather than one they discover.
//
//   * NOTHING PAST 'reminder' STAGE. A buyer three installments down is having
//     a conversation, not receiving a nudge, and an automated text in the
//     middle of it is worse than silence. Those stay with the drafts, where a
//     human reads them before they go.
//
// Every send is logged to re_notifications, so "did the reminder go out" has
// an answer and so does "how many paid within 48 hours".
async function remindUpcoming(orgId) {
  const { data: settings } = await supabaseAdmin
    .from('re_org_settings')
    .select('company_name, notify_payment_reminders')
    .eq('organization_id', orgId)
    .maybeSingle();

  if (!settings?.notify_payment_reminders) return { sent: 0, reason: 'reminders are off' };

  const today = lagosToday();
  const inThree = new Date(Date.parse(today) + 3 * 86_400_000).toISOString().slice(0, 10);
  const yesterday = yesterdayOf(today);
  const company = settings.company_name || 'Your developer';

  const select = `
    id, due_date, amount_due, status,
    re_installment_plans!inner(
      re_reservations!inner(
        escalation_stage,
        re_customers(full_name, phone),
        re_units(unit_number, re_projects(name))
      )
    )`;

  const [upcoming, justMissed] = await Promise.all([
    supabaseAdmin.from('re_installment_schedule').select(select)
      .eq('organization_id', orgId).eq('status', 'pending').eq('due_date', inThree),
    supabaseAdmin.from('re_installment_schedule').select(select)
      .eq('organization_id', orgId).eq('status', 'overdue').eq('due_date', yesterday),
  ]);

  if (upcoming.error) throw upcoming.error;
  if (justMissed.error) throw justMissed.error;

  let sent = 0;

  const send = async (row, kind) => {
    const reservation = row.re_installment_plans?.re_reservations;
    const customer = reservation?.re_customers;
    if (!customer?.phone) return;

    // Anything past a gentle reminder is a conversation a person should be
    // having, not a text message.
    if (!['none', 'reminder'].includes(reservation.escalation_stage || 'none')) return;

    const where = reservation.re_units?.unit_number
      ? `Unit ${reservation.re_units.unit_number}`
      : 'your unit';

    // The deadline is stated the way the system applies it — "30 Jul 2026 by
    // 6pm" — so a buyer is never held to a cutoff nobody told them about.
    const body = kind === 'upcoming'
      ? `${company}: a friendly reminder that ${naira(row.amount_due)} for ${where} is due `
        + `${describeDue(row.due_date)}. Thank you.`
      : `${company}: we have not yet received ${naira(row.amount_due)} for ${where}, which was due `
        + `${describeDue(row.due_date)}. If you have already paid, please ignore this message.`;

    const result = await notify.sendSms({
      orgId,
      to: customer.phone,
      body,
      template: kind === 'upcoming' ? 'reminder_before_due' : 'reminder_after_missed',
      relatedType: 're_installment_schedule',
      relatedId: row.id,
    });
    if (result.status === 'sent') sent += 1;
  };

  await mapWithConcurrency(upcoming.data || [], SMS_CONCURRENCY, (row) => send(row, 'upcoming'));
  await mapWithConcurrency(justMissed.data || [], SMS_CONCURRENCY, (row) => send(row, 'missed'));

  return { sent, upcoming: (upcoming.data || []).length, missed: (justMissed.data || []).length };
}

// Inline styles only — Gmail strips <style> blocks, and an alert that renders
// as a wall of unformatted text gets skimmed past.
function itemsTable(items, { showAmount = true } = {}) {
  const rows = items.map((item) => {
    const where = [item.project, item.unit && `Unit ${item.unit}`].filter(Boolean).join(' · ');
    return `<tr>
      <td style="padding:9px 0;border-bottom:1px solid #ececec">
        <strong style="color:#111">${escape(item.customer)}</strong>
        ${where ? `<br><span style="color:#8a8a8a;font-size:12px">${escape(where)}</span>` : ''}
      </td>
      <td style="padding:9px 0;text-align:right;border-bottom:1px solid #ececec;white-space:nowrap">
        ${showAmount ? `<strong style="color:#b3402a">${escape(naira(item.amount))}</strong><br>` : ''}
        <span style="color:#8a8a8a;font-size:12px">${escape(item.stage || '')}</span>
      </td>
    </tr>`;
  }).join('');

  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px">${rows}</table>`;
}

// Buyer names arrive from a form and end up in an HTML email.
const escape = (value) => String(value == null ? '' : value)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { notifyOverdue, remindUpcoming };
