// jointSaleService.js — SECTION 10 (feature expansion): co-selling a unit
// and splitting the commission on it.
//
// DELIBERATELY DOES NOT WRITE TO re_commissions. "One commission accrual
// per payment" (unique on payment_id, migrations/003) is one of CLAUDE.md's
// seven database-enforced rules, and a joint sale still accrues exactly one
// row per payment, to the reservation's own sales_rep_id, exactly as before
// — see commissionService.js's own header for why the accrual model is
// payment-by-payment in the first place. What this file adds is a DERIVED
// split of that same row's amount across co-sellers, computed on read, so
// "how much commission has this rep actually earned in total" (
// commissionService.summaryByRep/leaderboard) never has to reconcile two
// competing sources of truth for the same money.
const { supabaseAdmin } = require('../middleware/orgContext');
const { renderHtmlToPdf } = require('./pdfAdapter');
const notify = require('./notificationService');
const { escapeHtml } = require('../utils/escapeHtml');

const PARTY_TYPES = ['internal_rep', 'external_agent'];
const round2 = (value) => Math.round(Number(value) * 100) / 100;
// AUDIT FIX (F15) — matches receiptService.js/documentService.js's own
// naira() exactly (whole naira, sign before the symbol) rather than a
// third, diverging convention: the external-party commission statement PDF
// used to be able to show kobo-level decimals and a trailing minus sign
// ("₦-1,234") for the same payment the buyer's own receipt renders as
// whole naira with a leading one ("-₦1,234").
const naira = (amount) => {
  const n = Number(amount || 0);
  return (n < 0 ? '-' : '') + '₦' + Math.abs(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });
};

async function getForReservation(orgId, reservationId) {
  const { data: sale, error } = await supabaseAdmin
    .from('re_joint_sales')
    .select('id, reservation_id, created_at')
    .eq('organization_id', orgId)
    .eq('reservation_id', reservationId)
    .maybeSingle();
  if (error) throw error;
  if (!sale) return null;

  // AUDIT FIX (D4) — a separate query rather than the embedded
  // `re_joint_sale_parties(*)` this used to select: an embedded resource is
  // not covered by orgContext.js's SOFT_DELETABLE-style auto-filtering (see
  // that file's own caveat), and replace_joint_sale_parties (migrations/064)
  // now leaves superseded rows in the table on purpose — the current terms
  // are the live ones, not every version this joint sale has ever had.
  const { data: parties, error: partiesErr } = await supabaseAdmin
    .from('re_joint_sale_parties')
    .select('*')
    .eq('joint_sale_id', sale.id)
    .is('superseded_at', null);
  if (partiesErr) throw partiesErr;

  return { id: sale.id, reservation_id: sale.reservation_id, created_at: sale.created_at, parties: parties || [] };
}

function validateParties(parties) {
  if (!Array.isArray(parties) || parties.length < 2) {
    throw Object.assign(new Error('A joint sale needs at least two parties.'), { statusCode: 400 });
  }
  let total = 0;
  for (const party of parties) {
    if (!PARTY_TYPES.includes(party.party_type)) {
      throw Object.assign(new Error(`party_type must be one of: ${PARTY_TYPES.join(', ')}`), { statusCode: 400 });
    }
    if (party.party_type === 'internal_rep' && !party.user_id) {
      throw Object.assign(new Error('An internal_rep party needs a user_id.'), { statusCode: 400 });
    }
    if (party.party_type === 'external_agent' && !String(party.agent_name || '').trim()) {
      throw Object.assign(new Error('An external_agent party needs an agent_name.'), { statusCode: 400 });
    }
    // AUDIT FIX (F12) — notifyExternalParties only ever sends the
    // commission-statement PDF by email; an external agent saved with only
    // a phone number was silently dropped from that notification with
    // nothing surfaced anywhere. Required here instead, so the gap can't
    // be created in the first place.
    if (party.party_type === 'external_agent' && !String(party.agent_email || '').trim()) {
      throw Object.assign(new Error('An external_agent party needs an agent_email — that is how their commission statement is sent.'), { statusCode: 400 });
    }
    const pct = Number(party.commission_split_percentage);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw Object.assign(new Error('Each party needs a commission_split_percentage between 0 and 100.'), { statusCode: 400 });
    }
    total += pct;
  }
  // Rounding tolerance for the kind of split a human actually types
  // (33.33/33.33/33.34) rather than demanding a mathematically exact 100.
  if (Math.abs(total - 100) > 0.05) {
    throw Object.assign(new Error(`Commission splits must total 100% — these total ${round2(total)}%.`), { statusCode: 400 });
  }
}

// Replaces the whole party list on each save — a joint sale either has the
// terms it was just given, or it doesn't; there is no partial-update
// concept for "who gets what share of this specific deal".
async function createOrReplace(req, reservationId, { parties }) {
  validateParties(parties);

  const { data: reservation } = await supabaseAdmin
    .from('re_reservations')
    .select('id')
    .eq('id', reservationId)
    .eq('organization_id', req.orgId)
    .maybeSingle();
  if (!reservation) return { notFound: true };

  // AUDIT FIX (F8/F9) — delete-then-insert used to be two separate,
  // non-transactional round trips: two concurrent saves on the same
  // reservation could interleave them, leaving both the old and new party
  // rows live at once with a split that no longer sums to 100%.
  // replace_joint_sale_parties (migrations/064) does the upsert, delete and
  // insert inside one Postgres transaction, and a deferred constraint
  // trigger validates the sum only once, at that transaction's commit —
  // rejecting the whole save outright if it doesn't land on 100%, the same
  // database-enforced guarantee every other financial invariant in this
  // product already gets.
  const { data: inserted, error } = await supabaseAdmin.rpc('replace_joint_sale_parties', {
    p_org_id: req.orgId,
    p_reservation_id: reservationId,
    p_parties: parties.map((p) => ({
      party_type: p.party_type,
      user_id: p.party_type === 'internal_rep' ? p.user_id : null,
      agent_name: p.party_type === 'external_agent' ? String(p.agent_name).trim() : null,
      agent_email: p.agent_email ? String(p.agent_email).trim() : null,
      agent_phone: p.agent_phone ? String(p.agent_phone).trim() : null,
      commission_split_percentage: Number(p.commission_split_percentage),
    })),
  });
  if (error) throw error;

  const saleId = inserted?.[0]?.joint_sale_id || null;
  return { id: saleId, reservation_id: reservationId, parties: inserted || [] };
}

// Pure — each party's share of a given commission amount. Exported so this
// exact math is what both the statement PDF and the commissions-screen
// display use, rather than two copies that could drift.
//
// AUDIT FIX (F11) — rounding each party's share independently (round2 on
// each) could leave the group's shares summing to a kobo or two off from
// what the group should collectively total — the exact same drift
// installmentService.buildSchedule's own remainder correction exists to
// close for a payment schedule. Floors every share and puts the remainder
// on the LAST party instead, same "last row absorbs the kobo" pattern
// buildSchedule uses. Deliberately NOT assumed to sum to commissionAmount
// itself — `parties` is often a SUBSET (notifyExternalParties passes only
// the external agents, not the in-house rep), so the correction targets
// what THIS group's own percentages add up to, not the full commission.
function splitCommission(commissionAmount, parties) {
  const totalKobo = Math.round(Number(commissionAmount) * 100);
  const exactSharesKobo = parties.map((party) => totalKobo * (Number(party.commission_split_percentage) / 100));
  const flooredSharesKobo = exactSharesKobo.map((kobo) => Math.floor(kobo));
  const flooredSum = flooredSharesKobo.reduce((sum, kobo) => sum + kobo, 0);
  const exactSum = exactSharesKobo.reduce((sum, kobo) => sum + kobo, 0);
  const remainderKobo = Math.round(exactSum) - flooredSum;

  return parties.map((party, i) => ({
    ...party,
    share_amount: (flooredSharesKobo[i] + (i === parties.length - 1 ? remainderKobo : 0)) / 100,
  }));
}

function statementHtml({ companyName, customerName, unitLabel, party, shareAmount, commissionAmount, paymentAmount, paidAt }) {
  const name = escapeHtml(party.agent_name || 'Agent');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: Georgia, serif; color: #1D1B17; padding: 40px; }
    h1 { font-size: 20px; } table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    td { padding: 8px 0; border-bottom: 1px solid #DFDACB; }
  </style></head><body>
    <h1>Commission Statement</h1>
    <p>${escapeHtml(companyName || 'Developer')} — issued to ${name}</p>
    <table>
      <tr><td>Buyer</td><td>${escapeHtml(customerName || '—')}</td></tr>
      <tr><td>Unit</td><td>${escapeHtml(unitLabel || '—')}</td></tr>
      <tr><td>Payment received</td><td>${naira(paymentAmount)} on ${escapeHtml(String(paidAt).slice(0, 10))}</td></tr>
      <tr><td>Total commission on this payment</td><td>${naira(commissionAmount)}</td></tr>
      <tr><td>Your split</td><td>${party.commission_split_percentage}%</td></tr>
      <tr><td><strong>Amount due to you</strong></td><td><strong>${naira(shareAmount)}</strong></td></tr>
    </table>
  </body></html>`;
}

// Called from paymentEvents.js for every payment on a reservation that has a
// joint sale, whether or not a commission actually accrued on it this time
// — AUDIT FIX (F10): commissionAccrued/accrualReason let this distinguish
// "nothing to split, as expected" from "nothing to split, and that might be
// a misconfigured reservation" (see below). Never throws — a statement
// failing to generate must not affect the payment or the commission it
// describes, same rule every other paymentEvents step follows.
async function notifyExternalParties(orgId, {
  reservation, customer, unit, project, payment, commissionAmount, companyName,
  commissionAccrued = true, accrualReason = null,
}) {
  try {
    const joint = await getForReservation(orgId, reservation.id);
    if (!joint) return { notified: 0 };

    const externalParties = joint.parties.filter((p) => p.party_type === 'external_agent' && p.agent_email);
    if (!externalParties.length) return { notified: 0 };

    // AUDIT FIX (F10) — an external co-seller's share is a percentage of
    // THIS SAME commission row (this file's own header: "a DERIVED split of
    // that same row's amount"); a reservation can have its in-house
    // commission_rate left at 0% (or no sales rep assigned at all) while
    // still carrying a joint sale with real external-agent splits — which
    // used to mean this function was never even called (paymentEvents.js
    // gated it on commission having accrued), so a co-seller on such a
    // reservation never heard anything, ever, with no trace of why. Logged
    // here rather than skipped: a joint sale that never accrues anything is
    // very likely a misconfigured commission_rate, worth an operator's
    // attention, not a silent no-op.
    if (!commissionAccrued) {
      console.warn(
        `[joint-sale] reservation ${reservation.id} has ${externalParties.length} external co-seller(s) `
        + `but no commission accrued on this payment (${accrualReason || 'unknown reason'}) — nothing to split.`
      );
    }

    const shares = splitCommission(commissionAmount, externalParties);
    const unitLabel = [unit?.unit_number && `Unit ${unit.unit_number}`, project?.name].filter(Boolean).join(' — ');

    let notified = 0;
    for (const party of shares) {
      try {
        const pdf = await renderHtmlToPdf(statementHtml({
          companyName, customerName: customer?.full_name, unitLabel, party,
          shareAmount: party.share_amount, commissionAmount, paymentAmount: payment.amount, paidAt: payment.paid_at,
        }));
        await notify.sendEmail({
          orgId,
          to: party.agent_email,
          subject: `Commission statement — ${naira(party.share_amount)}`,
          html: `<p>Hi ${escapeHtml(party.agent_name)},</p><p>Attached is your commission statement for a payment just received on ${escapeHtml(unitLabel)}.</p>`,
          text: `Your commission share on this payment: ${naira(party.share_amount)}.`,
          template: 'joint_sale_statement',
          relatedType: 're_reservations',
          relatedId: reservation.id,
          attachments: [{ filename: `commission-statement-${payment.id}.pdf`, content: pdf }],
        });
        notified += 1;
      } catch (err) {
        console.warn('[joint-sale] could not send statement to', party.agent_email, err.message);
      }
    }
    return { notified };
  } catch (err) {
    console.warn('[joint-sale] could not process external statements:', err.message);
    return { notified: 0 };
  }
}

// The commissions screen's own "Joint sale commissions" section — every
// accrued re_commissions row on a reservation where this user is an
// internal_rep party, split by their percentage. Read-only and additive:
// does not change what commissionService.summaryByRep/leaderboard report
// as this rep's total (see this file's own header on why).
async function myJointSaleCommissions(orgId, userId) {
  // AUDIT FIX (D4) — more than one row can now exist per (reservation,
  // user): replace_joint_sale_parties (migrations/064) supersedes rather
  // than deletes a split once a commission has accrued against it, so
  // created_at/superseded_at are needed here to match each commission to
  // whichever split was actually LIVE when it accrued — not whatever the
  // split happens to be today, which is what a plain "one row per
  // reservation" map would silently do again.
  const { data: parties, error: partyErr } = await supabaseAdmin
    .from('re_joint_sale_parties')
    .select('id, commission_split_percentage, created_at, superseded_at, re_joint_sales!inner(reservation_id, organization_id)')
    .eq('user_id', userId)
    .eq('re_joint_sales.organization_id', orgId);
  if (partyErr) throw partyErr;
  if (!parties?.length) return [];

  const reservationIds = [...new Set(parties.map((p) => p.re_joint_sales.reservation_id))];

  const versionsByReservation = new Map();
  for (const p of parties) {
    const resId = p.re_joint_sales.reservation_id;
    const list = versionsByReservation.get(resId) || [];
    list.push({
      pct: Number(p.commission_split_percentage),
      from: new Date(p.created_at).getTime(),
      until: p.superseded_at ? new Date(p.superseded_at).getTime() : null,
    });
    versionsByReservation.set(resId, list);
  }
  const pctAt = (reservationId, atIso) => {
    const versions = versionsByReservation.get(reservationId);
    if (!versions?.length) return 0;
    const at = new Date(atIso).getTime();
    const match = versions.find((v) => v.from <= at && (v.until === null || v.until > at));
    // No version straddles the exact instant (a party row and the commission
    // it split can both be `now()` writes seconds apart) — fall back to
    // whichever version is live today rather than reporting a zero share.
    return (match || versions.find((v) => v.until === null) || versions[versions.length - 1]).pct;
  };

  const { data: commissions, error: commErr } = await supabaseAdmin
    .from('re_commissions')
    .select('id, amount, created_at, reservation_id, re_reservations(re_customers(full_name), re_units(unit_number))')
    .eq('organization_id', orgId)
    .neq('status', 'void')
    .in('reservation_id', reservationIds);
  if (commErr) throw commErr;

  return (commissions || []).map((c) => {
    const pct = pctAt(c.reservation_id, c.created_at);
    return {
      commission_id: c.id,
      reservation_id: c.reservation_id,
      customer_name: c.re_reservations?.re_customers?.full_name || null,
      unit_number: c.re_reservations?.re_units?.unit_number || null,
      total_amount: Number(c.amount),
      split_percentage: pct,
      your_share: round2(Number(c.amount) * (pct / 100)),
      accrued_at: c.created_at,
    };
  });
}

module.exports = {
  PARTY_TYPES, getForReservation, createOrReplace, splitCommission, notifyExternalParties, myJointSaleCommissions,
};
