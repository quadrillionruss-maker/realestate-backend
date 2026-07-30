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

const PORTAL_AUDIENCE = 're-portal';

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
    .select('id, organization_id, full_name, email, phone, portal_token_version')
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
        re_units(unit_number, unit_type, size_sqm, list_price, re_projects(name, location)),
        re_installment_plans(
          id, total_amount, number_of_installments, frequency, start_date,
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

  const scheduleIds = [];
  for (const reservation of reservations || []) {
    for (const plan of asArray(reservation.re_installment_plans)) {
      for (const row of plan.re_installment_schedule || []) scheduleIds.push(row.id);
    }
  }

  const { data: payments } = scheduleIds.length
    ? await supabaseAdmin
        .from('re_payments')
        .select('id, schedule_id, amount, method, paid_at')
        .in('schedule_id', scheduleIds)
        .order('paid_at', { ascending: false })
    : { data: [] };

  let totalContracted = 0;
  let totalPaid = 0;
  let overdueAmount = 0;
  let overdueCount = 0;
  let nextDue = null;
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
      totalContracted += Number(plan.total_amount || 0);
      for (const row of plan.re_installment_schedule || []) {
        if (row.status === 'overdue') {
          overdueAmount += Number(row.amount_due || 0);
          overdueCount += 1;
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

  totalPaid = (payments || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);

  await supabaseAdmin
    .from('re_customers')
    .update({ portal_last_seen_at: new Date().toISOString() })
    .eq('id', customer.id);

  return {
    customer: {
      id: customer.id,
      full_name: customer.full_name,
      email: customer.email,
      phone: customer.phone,
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
  if (data.status !== 'generated') {
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
  assertOwnsDocument,
};
