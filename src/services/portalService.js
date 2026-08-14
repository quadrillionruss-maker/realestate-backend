// portalService.js — the buyer's own view of their account.
//
// "How much have I paid so far?", "when is my next installment?", "can I get a
// copy of my allocation letter?" — three phone calls a week per hundred
// buyers, every one of them answerable from data the developer already has.
// Answering them without a human is the cheapest admin saving in the product.
//
// ── Why a link and not an account ─────────────────────────────────────────
// A buyer signs in twice a year. Giving them a password is giving them a
// password to forget, and giving us a password-reset flow to support for
// people who are not our customer. So the developer issues a signed link and
// sends it by WhatsApp, which is where they already talk to their buyers.
//
// ── What makes the link safe ──────────────────────────────────────────────
//   * It is a JWT signed with JWT_SECRET, so it cannot be forged or edited.
//   * `aud: 're-portal'` means it is NOT interchangeable with a staff token.
//     verifyPortalToken pins the audience, and src/middleware/auth.js does not
//     accept it — a buyer link cannot become an operator session.
//   * It carries `v`, the customer's portal_token_version. Bumping that column
//     invalidates every link ever issued to that buyer. That is the revoke
//     button, and it exists because links get forwarded.
//   * It expires (PORTAL_TOKEN_TTL_DAYS, default 60).

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');
// Contract value is "what did this buyer agree to, in total" — for a plan
// that has been restructured, that is NOT total_amount (which, on the new
// plan, is only the remaining balance) but original_total_amount ?? total_amount.
// restructureService already owns and exports this exact reasoning
// (contractValue), so it is reused here rather than re-derived, per its own
// comment: "Anything reporting contract value reads original_total_amount ??
// total_amount ... so nothing has to know whether a plan has ever been
// restructured."
const { contractValue } = require('./restructureService');
const { getMilestonesForProjects, currentMilestoneSummary } = require('./constructionService');
const { isEligible: isFinancingEligible } = require('./financingService');
const { portalNoticeFor } = require('./projectHealthService');

const PORTAL_AUDIENCE = 're-portal';

// SECTION 7 — the three document types every reservation's legal timeline
// shows, in the fixed order the buyer sees them. allocation_letter first
// (it exists from the moment a reservation is confirmed, before any legal
// paperwork), then the two SIGNABLE_DOC_TYPES (documentService.js) that
// actually apply to a sale — power_of_attorney is the third SIGNABLE type
// but is not part of every sale's own paperwork, so it stays out of this
// fixed three-step tracker.
const LEGAL_DOC_TYPES = [
  { doc_type: 'allocation_letter', label: 'Allocation Letter' },
  { doc_type: 'deed_of_assignment', label: 'Deed of Assignment' },
  { doc_type: 'subscriber_agreement', label: 'Subscriber Agreement' },
];

function issuePortalToken(customer) {
  return jwt.sign(
    {
      cid: customer.id,
      org: customer.organization_id,
      v: Number(customer.portal_token_version || 0),
    },
    env.jwt.secret,
    {
      algorithm: 'HS256',
      audience: PORTAL_AUDIENCE,
      expiresIn: `${env.portal.tokenTtlDays}d`,
    }
  );
}

function portalUrl(token) {
  const base = env.appUrl || '';
  return `${base}/portal.html#token=${token}`;
}

// Returns the customer row, or throws a 401-shaped error. The version check is
// a database read on every request on purpose: a revoked link must stop
// working immediately, not when it happens to expire.
async function verifyPortalToken(token) {
  if (!token) throw unauthorized('This link is missing its access token.');

  let claims;
  try {
    claims = jwt.verify(token, env.jwt.secret, {
      algorithms: ['HS256'],
      audience: PORTAL_AUDIENCE,
    });
  } catch (err) {
    throw unauthorized(
      err.name === 'TokenExpiredError'
        ? 'This link has expired. Ask your developer for a new one.'
        : 'This link is not valid.'
    );
  }

  const { data: customer, error } = await supabaseAdmin
    .from('re_customers')
    .select('id, organization_id, full_name, email, phone, portal_token_version, referral_code, referral_credit_balance, credit_score')
    .eq('id', claims.cid)
    .maybeSingle();
  if (error) throw error;
  if (!customer) throw unauthorized('This link is not valid.');

  if (Number(customer.portal_token_version || 0) !== Number(claims.v || 0)) {
    throw unauthorized('This link has been revoked. Ask your developer for a new one.');
  }
  // The org is pinned in the token AND re-read from the row; a mismatch means
  // the row moved workspaces and the link should stop working.
  if (customer.organization_id !== claims.org) {
    throw unauthorized('This link is not valid.');
  }

  return customer;
}

// Everything the buyer's page shows, in one read. Scoped by the customer id
// from the verified token — never by anything in the query string.
async function loadPortalAccount(customer) {
  const [{ data: reservations, error: resErr }, { data: settings }] = await Promise.all([
    supabaseAdmin
      .from('re_reservations')
      .select(`
        id, status, reserved_at, property_type, tenancy_start_date, tenancy_end_date,
        re_units(
          unit_number, unit_type, size_sqm, list_price, metadata,
          bedrooms, bathrooms, parking_spaces, floor_level, furnishing_status,
          re_projects(id, name, location)
        ),
        re_installment_plans(
          id, total_amount, original_total_amount, status, number_of_installments, frequency, start_date,
          re_installment_schedule(id, installment_number, due_date, amount_due, status, paid_at)
        )`)
      .eq('customer_id', customer.id)
      .eq('organization_id', customer.organization_id)
      .neq('status', 'cancelled')
      .order('reserved_at', { ascending: false }),
    supabaseAdmin
      .from('re_org_settings')
      .select('company_name, phone, website, reply_to_email')
      .eq('organization_id', customer.organization_id)
      .maybeSingle(),
  ]);
  if (resErr) throw resErr;

  const reservationIds = (reservations || []).map((r) => r.id);

  // Only documents that have actually been generated. A row sitting at
  // 'pending' is an internal intention, not something to show a buyer and
  // then fail to produce.
  const { data: documents } = reservationIds.length
    ? await supabaseAdmin
        .from('re_documents')
        .select('id, doc_type, status, generated_at, reservation_id')
        .eq('organization_id', customer.organization_id)
        .in('reservation_id', reservationIds)
        .eq('status', 'generated')
        .order('generated_at', { ascending: false })
    : { data: [] };

  // SECTION 7 — the legal-documents status TRACKER, unlike the download list
  // above, deliberately includes every status ('pending' included) — the
  // whole point is showing a buyer where their paperwork stands even before
  // there is anything to download.
  const { data: legalDocRows } = reservationIds.length
    ? await supabaseAdmin
        .from('re_documents')
        .select('id, doc_type, status, generated_at, reservation_id')
        .eq('organization_id', customer.organization_id)
        .in('reservation_id', reservationIds)
        .in('doc_type', LEGAL_DOC_TYPES.map((t) => t.doc_type))
    : { data: [] };

  // SECTION 4 — payment pause eligibility, per reservation. "Once per
  // reservation" (migrations/030) means an approved request blocks the
  // button forever; a pending one blocks it until reviewed; a denied one
  // does not block a fresh attempt.
  const { data: hardshipRows } = reservationIds.length
    ? await supabaseAdmin
        .from('re_hardship_requests')
        .select('reservation_id, status')
        .eq('organization_id', customer.organization_id)
        .in('reservation_id', reservationIds)
    : { data: [] };
  const hardshipByReservation = new Map();
  for (const row of hardshipRows || []) {
    const existing = hardshipByReservation.get(row.reservation_id);
    // 'approved' beats 'pending' beats 'denied' if a buyer somehow has more
    // than one row (only possible today via a denied request followed by a
    // fresh pending one) — the more blocking status is the one that matters.
    const rank = { approved: 2, pending: 1, denied: 0 };
    if (!existing || rank[row.status] > rank[existing]) hardshipByReservation.set(row.reservation_id, row.status);
  }

  // Every plan's schedule rows go in here, superseded or not — a superseded
  // plan still has real payments recorded against its (since-waived) rows,
  // and those payments must still count toward totalPaid below. Filtering
  // this collection to only the active plan would make totalPaid wrong in
  // the OTHER direction: a buyer who paid before a restructure would see
  // that money vanish from their own total.
  const scheduleIds = [];
  for (const reservation of reservations || []) {
    for (const plan of asArray(reservation.re_installment_plans)) {
      for (const row of plan.re_installment_schedule || []) scheduleIds.push(row.id);
    }
  }

  const { data: payments } = scheduleIds.length
    ? await supabaseAdmin
        .from('re_payments')
        .select('id, schedule_id, amount, method, paid_at, reallocated_from_payment_id')
        .in('schedule_id', scheduleIds)
        // A voided payment was entered in error and corrected — a buyer
        // seeing it in their own history, not reflected in their balance,
        // is a support call this exists to prevent, not cause.
        .is('voided_at', null)
        .order('paid_at', { ascending: false })
    : { data: [] };

  let totalContracted = 0;
  let totalPaid = 0;
  let overdueAmount = 0;
  let overdueCount = 0;
  let nextDue = null;
  // A buyer whose only open installments are overdue (nothing left
  // pending) used to get no "next payment" card at all — nextDue stayed
  // null forever, since the loop below only ever populated it from a
  // pending row. Tracked separately and used only when nothing pending
  // exists, so an upcoming pending row still wins over an overdue one when
  // both are present — this is a fallback, not a re-ranking.
  let nextOverdue = null;
  let tenancy = null;

  for (const reservation of reservations || []) {
    // Shown prominently, not buried in the reservation list — a tenant opens
    // this page to answer exactly one question ("how long have I got left?"),
    // and the soonest-ending live tenancy is the one worth surfacing if a
    // buyer somehow holds more than one.
    if (reservation.property_type === 'rental' && reservation.tenancy_end_date
      && (!tenancy || reservation.tenancy_end_date < tenancy.tenancy_end_date)) {
      tenancy = {
        reservation_id: reservation.id,
        tenancy_start_date: reservation.tenancy_start_date || null,
        tenancy_end_date: reservation.tenancy_end_date,
        unit_number: reservation.re_units?.unit_number || null,
        project_name: reservation.re_units?.re_projects?.name || null,
      };
    }

    for (const plan of asArray(reservation.re_installment_plans)) {
      // A restructure supersedes the old plan and creates a new one for the
      // remaining balance (restructureService.restructure) — the OLD plan's
      // total_amount still holds the full original contract value, and the
      // NEW plan's total_amount holds only what was left, not the contract.
      // Summing both double-counts the portion already carried forward:
      // skip a superseded plan entirely here, and read the live plan's
      // contract value through contractValue() (original_total_amount when
      // it has one, i.e. exactly the full contract), not its bare
      // total_amount, or a restructured buyer's contracted total would read
      // as only their post-restructure remaining balance.
      if (plan.status !== 'superseded') {
        totalContracted += contractValue(plan);
      }
      for (const row of plan.re_installment_schedule || []) {
        if (row.status === 'overdue') {
          overdueAmount += Number(row.amount_due || 0);
          overdueCount += 1;
          if (!nextOverdue || row.due_date < nextOverdue.due_date) {
            nextOverdue = {
              schedule_id: row.id,
              due_date: row.due_date,
              amount_due: Number(row.amount_due || 0),
              installment_number: row.installment_number,
              unit_number: reservation.re_units?.unit_number || null,
              project_name: reservation.re_units?.re_projects?.name || null,
              property_type: reservation.property_type || 'off_plan',
            };
          }
        }
        if (row.status === 'pending' && (!nextDue || row.due_date < nextDue.due_date)) {
          nextDue = {
            schedule_id: row.id,
            due_date: row.due_date,
            amount_due: Number(row.amount_due || 0),
            installment_number: row.installment_number,
            unit_number: reservation.re_units?.unit_number || null,
            project_name: reservation.re_units?.re_projects?.name || null,
            // "Monthly rent" reads correctly on a lease; "Installment" reads
            // correctly on a sale. portal.js switches its label on this.
            property_type: reservation.property_type || 'off_plan',
          };
        }
      }
    }
  }

  if (!nextDue) nextDue = nextOverdue;

  // A reallocation row moves credit that was already counted once, on the
  // payment it came from — summing it again here would show the buyer a
  // balance smaller than what they actually still owe.
  totalPaid = (payments || [])
    .filter((p) => !p.reallocated_from_payment_id)
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);

  await supabaseAdmin
    .from('re_customers')
    .update({ portal_last_seen_at: new Date().toISOString() })
    .eq('id', customer.id);

  // Construction progress (SECTION 2) is per-reservation, not a single
  // account-wide fact — a buyer holding units in two different projects
  // sees each project's own stage. Attached here rather than fetched
  // separately by the frontend so the portal stays a single round trip.
  const portalProjectIds = (reservations || [])
    .map((r) => r.re_units?.re_projects?.id)
    .filter(Boolean);
  const milestonesByProject = await getMilestonesForProjects(customer.organization_id, portalProjectIds);

  // SECTION 11 — the Handover tab only ever applies to a completed
  // reservation (routes/portal.js has no route that would let a buyer log a
  // snag before then anyway), so this is skipped entirely for everyone
  // else rather than costing a query on every portal load.
  const completedReservationIds = (reservations || [])
    .filter((r) => r.status === 'completed').map((r) => r.id);
  const checklistsByReservation = new Map();
  if (completedReservationIds.length) {
    const { data: checklists } = await supabaseAdmin
      .from('re_handover_checklists')
      .select('id, reservation_id, status, handover_date, keys_handed')
      .eq('organization_id', customer.organization_id)
      .in('reservation_id', completedReservationIds);

    const checklistIds = (checklists || []).map((c) => c.id);
    const { data: snagRows } = checklistIds.length
      ? await supabaseAdmin
          .from('re_snagging_items')
          .select('id, checklist_id, description, photo_url, status, developer_response, fix_committed_date, fixed_at, created_at')
          .in('checklist_id', checklistIds)
          .order('created_at', { ascending: true })
      : { data: [] };

    for (const checklist of checklists || []) {
      checklistsByReservation.set(checklist.reservation_id, {
        ...checklist,
        snagging_items: (snagRows || []).filter((s) => s.checklist_id === checklist.id),
      });
    }
  }

  for (const reservation of reservations || []) {
    const projectId = reservation.re_units?.re_projects?.id;
    reservation.construction = projectId && milestonesByProject[projectId]
      ? currentMilestoneSummary(milestonesByProject[projectId])
      : null;

    const status = hardshipByReservation.get(reservation.id) || null;
    reservation.hardship = { status, can_request: status !== 'pending' && status !== 'approved' };

    // SECTION 7 — a fixed three-step timeline, always in the same order,
    // whether or not a row exists yet for each step. A document that has
    // never been generated reads as its own 'pending' entry with no id to
    // download rather than being absent from the list — the whole point is
    // that a buyer sees where ALL THREE stand, not just the ones started.
    const rowsForReservation = (legalDocRows || []).filter((d) => d.reservation_id === reservation.id);
    reservation.legal_documents = LEGAL_DOC_TYPES.map(({ doc_type, label }) => {
      const row = rowsForReservation.find((d) => d.doc_type === doc_type);
      return {
        doc_type,
        label,
        status: row?.status || 'pending',
        id: row?.id || null,
        generated_at: row?.generated_at || null,
      };
    });

    // SECTION 11 — null for anyone but a completed reservation, or a
    // completed one with no checklist created yet; portal.js only shows
    // the Handover tab when this is present.
    reservation.handover = checklistsByReservation.get(reservation.id) || null;

    // SECTION 15 — "if a project health score drops below 40 and has been
    // there for 14+ consecutive days, show a subtle notice to buyers in
    // that project." Deliberately worded generically in portal.js (never
    // "health score", never a number) — this nudges a buyer to ask their
    // developer, it does not publicly shame the developer with a score.
    // Reuses `projectId` from the construction-progress block above.
    reservation.project_health_notice = projectId
      ? await portalNoticeFor(customer.organization_id, projectId)
      : null;
  }

  return {
    customer: {
      id: customer.id,
      full_name: customer.full_name,
      email: customer.email,
      phone: customer.phone,
      // SECTION 5 — the buyer's own code to share, and any credit earned
      // from a referral that has already converted but had nothing open to
      // apply against yet (see referralService.applyCreditToOutstandingBalance).
      referral_code: customer.referral_code,
      referral_credit_balance: round2(customer.referral_credit_balance || 0),
    },
    developer: {
      company_name: settings?.company_name || null,
      phone: settings?.phone || null,
      website: settings?.website || null,
      email: settings?.reply_to_email || null,
    },
    summary: {
      total_contracted: round2(totalContracted),
      total_paid: round2(totalPaid),
      balance: round2(Math.max(0, totalContracted - totalPaid)),
      overdue_amount: round2(overdueAmount),
      overdue_count: overdueCount,
      progress_percent: totalContracted > 0 ? Math.min(100, Math.round((totalPaid / totalContracted) * 100)) : 0,
      next_due: nextDue,
      // null for a buyer who owns rather than rents — portal.js only shows
      // this block when it is present.
      tenancy,
      // SECTION 9 — "Apply for bank financing" button eligibility: 30% of
      // the buyer's WHOLE account paid, and a credit score above 40. See
      // financingService.isEligible for why this is decided in one place
      // and re-checked, not just displayed, when they actually submit.
      financing_eligible: isFinancingEligible({
        totalContracted, totalPaid, creditScoreValue: customer.credit_score,
      }),
    },
    reservations: reservations || [],
    documents: documents || [],
    payments: payments || [],
  };
}

// A buyer may only ever reach their own installment. This is the check that
// makes "pay this" safe to expose on a page anyone with a link can open.
async function assertOwnsSchedule(customer, scheduleId) {
  const { data } = await supabaseAdmin
    .from('re_installment_schedule')
    .select('id, re_installment_plans!inner(re_reservations!inner(customer_id))')
    .eq('id', scheduleId)
    .eq('organization_id', customer.organization_id)
    .maybeSingle();

  if (!data || data.re_installment_plans?.re_reservations?.customer_id !== customer.id) {
    throw Object.assign(new Error('Installment not found'), { statusCode: 404 });
  }
  return true;
}

// FEATURE — the check every portal route that takes a :reservationId in the
// URL needs (hardship, messages, financing, handover, community): does this
// reservation actually belong to the customer the bearer token resolved to.
// Same 404-not-401 shape as assertOwnsSchedule/assertOwnsDocument — a
// mistyped or tampered id reads as "not found", never as a hint that a
// reservation with that id exists but belongs to someone else.
async function assertOwnsReservation(customer, reservationId) {
  const { data } = await supabaseAdmin
    .from('re_reservations')
    .select('id, customer_id')
    .eq('id', reservationId)
    .eq('organization_id', customer.organization_id)
    .maybeSingle();

  if (!data || data.customer_id !== customer.id) {
    throw Object.assign(new Error('Reservation not found'), { statusCode: 404 });
  }
  return true;
}

async function assertOwnsDocument(customer, documentId) {
  const { data } = await supabaseAdmin
    .from('re_documents')
    .select('id, status, re_reservations!inner(customer_id)')
    .eq('id', documentId)
    .eq('organization_id', customer.organization_id)
    .maybeSingle();

  if (!data || data.re_reservations?.customer_id !== customer.id) {
    throw Object.assign(new Error('Document not found'), { statusCode: 404 });
  }
  // SECTION 7 — the legal-documents tracker also offers a Download button on
  // 'sent' and 'signed' documents, not only 'generated' ones: the file
  // itself never moves or disappears once rendered, only its status
  // advances past that point (sent to the buyer, then signed).
  if (!['generated', 'sent', 'signed'].includes(data.status)) {
    throw Object.assign(new Error('That document is not ready yet.'), { statusCode: 409 });
  }
  return true;
}

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const round2 = (value) => Math.round(Number(value) * 100) / 100;
const unauthorized = (message) => Object.assign(new Error(message), { statusCode: 401 });

module.exports = {
  PORTAL_AUDIENCE,
  issuePortalToken,
  portalUrl,
  verifyPortalToken,
  loadPortalAccount,
  assertOwnsSchedule,
  assertOwnsReservation,
  assertOwnsDocument,
};
