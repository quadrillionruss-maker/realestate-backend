// routes/search.js — one box, four kinds of answer.
//
// Below about forty buyers a developer can find Mrs Adeyemi by scrolling. Above
// it they cannot, and the product quietly stops being usable — not because
// anything broke, but because the only way to reach a record was to already be
// looking at it.
//
// Deliberately NOT full-text search. A rep types a surname, four digits of a
// phone number, or a unit number, and wants the row now. ILIKE against three
// indexed columns answers that in single-digit milliseconds at this data size,
// and does not need an extension, a tsvector column or a reindex job.

const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission, isOwnRecordsOnly, salesRepIdsFor, MATCHES_NOTHING } = require('../middleware/rbac');
const { sanitizeSearchTerm } = require('../utils/searchFilter');
const router = express.Router();

const LIMIT_PER_KIND = 8;

router.get('/', requirePermission('search.read'), async (req, res, next) => {
  try {
    const raw = String(req.query.q || '').trim();
    if (raw.length < 2) {
      return res.json({ query: raw, customers: [], units: [], projects: [], reservations: [] });
    }

    const term = sanitizeSearchTerm(raw);
    const like = `%${term}%`;
    // Phone numbers are typed with spaces, dashes and +234 in every possible
    // combination. Matching on digits alone is what makes "0803 123" find
    // "+2348031234567".
    const digits = raw.replace(/\D/g, '');

    // A Sales Executive's search must not be a side door around "sees only
    // their own buyers" — every other screen filters by this, and a search
    // box that doesn't would let them find a colleague's buyer by name.
    const ownOnly = isOwnRecordsOnly(req.orgRole);
    const repIds = ownOnly ? await salesRepIdsFor(req) : null;

    let customerQuery = supabaseAdmin
      .from('re_customers')
      .select('id, full_name, phone, email, source')
      .eq('organization_id', req.orgId)
      .or(
        [
          `full_name.ilike.${like}`,
          `email.ilike.${like}`,
          `phone.ilike.${like}`,
          digits.length >= 3 ? `phone.ilike.%${digits}%` : null,
        ].filter(Boolean).join(',')
      )
      .limit(LIMIT_PER_KIND);
    if (ownOnly) customerQuery = customerQuery.eq('created_by_user_id', req.userId);

    let reservationQuery = supabaseAdmin
      .from('re_reservations')
      // Reservations are searched THROUGH the buyer's name rather than by any
      // field of their own — nobody remembers a reservation id, they
      // remember who bought it.
      .select('id, status, reserved_at, re_customers!inner(full_name), re_units(unit_number, re_projects(name))')
      .eq('organization_id', req.orgId)
      .ilike('re_customers.full_name', like)
      .limit(LIMIT_PER_KIND);
    if (ownOnly) reservationQuery = reservationQuery.in('sales_rep_id', repIds.length ? repIds : [MATCHES_NOTHING]);

    const [customers, units, projects, reservations] = await Promise.all([
      customerQuery,

      supabaseAdmin
        .from('re_units')
        .select('id, unit_number, unit_type, list_price, status, re_projects(name)')
        .eq('organization_id', req.orgId)
        .ilike('unit_number', like)
        .limit(LIMIT_PER_KIND),

      supabaseAdmin
        .from('re_projects')
        .select('id, name, location, status')
        .eq('organization_id', req.orgId)
        .or(`name.ilike.${like},location.ilike.${like}`)
        .limit(LIMIT_PER_KIND),

      reservationQuery,
    ]);

    for (const result of [customers, units, projects, reservations]) {
      if (result.error) throw result.error;
    }

    res.json({
      query: raw,
      customers: customers.data || [],
      units: units.data || [],
      projects: projects.data || [],
      reservations: reservations.data || [],
    });
  } catch (e) { next(e); }
});

module.exports = router;
