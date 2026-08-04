// routes/imports.js — CSV import.
//
// This sounds like a convenience and is actually the onboarding moment. Every
// developer you demo to already has their buyers somewhere: an Excel file, a
// Google Sheet, the last system they tried. The question that decides the deal
// is not "can I create a customer" — it is "can I get my 150 existing buyers in
// here without typing them". Manually entering 150 buyers with their payment
// histories is a full day of work, and nobody does it; they say they will,
// and then they don't, and the trial dies quietly.
//
// So one CSV carries the whole picture per row: the buyer, their unit, their
// plan, and how much they have already paid.
//
// ── THE ONE RULE THAT MATTERS HERE ────────────────────────────────────────
// An import does NOT call paymentEvents.onPaymentRecorded. Historical payments
// are history: rendering 400 receipt PDFs and emailing every buyer a receipt
// for money they transferred eight months ago would be the worst possible
// first impression of a product whose pitch is that it talks to your buyers
// for you. Imported payments settle the schedule and nothing else.
//
// Everything is validated BEFORE anything is written, and `dry_run` returns
// exactly what would happen without writing at all — the preview a developer
// needs before trusting a spreadsheet they last edited in 2024.

const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const { requirePermission } = require('../middleware/rbac');
const { parseCsvToObjects, parseAmount, parseDate } = require('../utils/csv');
const { createPlanWithSchedule } = require('../services/installmentService');
const { audit } = require('../services/auditService');
const router = express.Router();

const MAX_ROWS = 1000;

const TEMPLATES = {
  customers: {
    headers: ['full_name', 'phone', 'email', 'source', 'project', 'unit_number', 'unit_type',
      'size_sqm', 'list_price', 'total_amount', 'number_of_installments', 'frequency',
      'start_date', 'amount_paid_to_date'],
    example: ['Mrs Adeyemi Okonkwo', '08031234567', 'adeyemi@example.com', 'referral',
      'Lekki Gardens Phase 2', 'B12', '3-bed terrace', '145', '45000000', '45000000',
      '18', 'monthly', '2026-02-01', '7500000'],
  },
  units: {
    headers: ['unit_number', 'unit_type', 'size_sqm', 'list_price'],
    example: ['B12', '3-bed terrace', '145', '45000000'],
  },
};

// "Download this, fill it in, upload it." The example row is included because
// a template with only headers gets filled in wrongly every time — people copy
// the shape of the data they can see.
router.get('/template/:kind', (req, res) => {
  const template = TEMPLATES[req.params.kind];
  if (!template) {
    return res.status(404).json({ error: `No template for "${req.params.kind}". Try: ${Object.keys(TEMPLATES).join(', ')}` });
  }

  const csv = [template.headers.join(','), template.example.map(quote).join(',')].join('\n');
  res.type('text/csv').attachment(`archta-${req.params.kind}-template.csv`).send(csv);
});

const quote = (value) => /[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value);

// ── Units, into a default project unless a row names its own ───────────────
// project_id (the dropdown in the import modal) is REQUIRED and is the
// default every row gets — but a row carrying its own "project" column
// overrides that default for itself alone, exactly the way the customers
// import already lets a row's own project name route it, just inverted: here
// the dropdown wins only when a row is silent, not the other way round.
router.post('/units', requirePermission('imports.write'), async (req, res, next) => {
  try {
    const { project_id, csv, dry_run } = req.body || {};
    if (!project_id) return res.status(400).json({ error: 'project_id is required' });
    if (!csv) return res.status(400).json({ error: 'csv is required' });

    const { data: projects } = await supabaseAdmin
      .from('re_projects').select('id, name')
      .eq('organization_id', req.orgId);

    const defaultProject = (projects || []).find((p) => p.id === project_id);
    if (!defaultProject) return res.status(404).json({ error: 'Project not found' });

    const projectByName = new Map((projects || []).map((p) => [p.name.trim().toLowerCase(), p]));

    const { records } = parseCsvToObjects(csv);
    if (!records.length) return res.status(400).json({ error: 'The file has no data rows.' });
    if (records.length > MAX_ROWS) {
      return res.status(400).json({ error: `Too many rows (${records.length}). Split the file into batches of ${MAX_ROWS}.` });
    }

    const rows = [];
    const errors = [];
    // Keyed by project too, not just unit_number — two different projects can
    // legitimately share a unit number ("A1" in both Lekki Gardens and Ikeja
    // Heights), which a plain unit_number Set would have wrongly flagged as a
    // duplicate the moment rows could span more than one project.
    const seen = new Set();

    for (const record of records) {
      const unitNumber = (record.unit_number || '').trim();
      const price = parseAmount(record.list_price);

      if (!unitNumber) { errors.push({ row: record.__row, error: 'unit_number is required' }); continue; }
      if (price == null || price < 0) { errors.push({ row: record.__row, error: 'list_price must be a number' }); continue; }

      const projectName = (record.project || '').trim();
      let project = defaultProject;
      if (projectName) {
        const resolved = projectByName.get(projectName.toLowerCase());
        if (!resolved) {
          errors.push({ row: record.__row, error: `no project named "${projectName}" in this workspace` });
          continue;
        }
        project = resolved;
      }

      const dedupeKey = `${project.id}|${unitNumber.toLowerCase()}`;
      if (seen.has(dedupeKey)) {
        errors.push({ row: record.__row, error: `duplicate unit_number "${unitNumber}" for ${project.name} in this file` });
        continue;
      }

      seen.add(dedupeKey);
      rows.push({
        organization_id: req.orgId,
        project_id: project.id,
        unit_number: unitNumber,
        unit_type: record.unit_type || null,
        size_sqm: parseAmount(record.size_sqm),
        list_price: price,
      });
    }

    // Per-project counts, so the preview can show a "project" column's
    // override actually took effect rather than trusting it silently — the
    // common case (no project column at all) still resolves to one entry.
    const byProject = [...rows.reduce((map, r) => map.set(r.project_id, (map.get(r.project_id) || 0) + 1), new Map())]
      .map(([id, count]) => ({
        project_id: id,
        project_name: (projects || []).find((p) => p.id === id)?.name || '—',
        count,
      }));

    if (dry_run) return res.json({ dry_run: true, would_create: rows.length, errors, by_project: byProject, sample: rows.slice(0, 5) });
    if (!rows.length) return res.status(400).json({ error: 'Nothing valid to import.', errors });

    const { data, error } = await supabaseAdmin.from('re_units').insert(rows).select();
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'One or more unit numbers already exist in their project.', errors });
    }
    if (error) throw error;

    audit(req, {
      action: 'import.units',
      entityType: 're_units',
      entityId: project_id,
      summary: byProject.length > 1
        ? `Imported ${data.length} units across ${byProject.length} projects (default: ${defaultProject.name})`
        : `Imported ${data.length} units into ${defaultProject.name}`,
      metadata: { project_id, by_project: byProject, created: data.length, skipped: errors.length },
    });

    res.status(201).json({ created: data.length, errors, by_project: byProject, units: data });
  } catch (e) { next(e); }
});

// ── Buyers, with their unit, plan and payment history ─────────────────────
router.post('/customers', requirePermission('imports.write'), async (req, res, next) => {
  try {
    const { csv, project_id, dry_run } = req.body || {};
    if (!csv) return res.status(400).json({ error: 'csv is required' });

    const { records } = parseCsvToObjects(csv);
    if (!records.length) return res.status(400).json({ error: 'The file has no data rows.' });
    if (records.length > MAX_ROWS) {
      return res.status(400).json({ error: `Too many rows (${records.length}). Split the file into batches of ${MAX_ROWS}.` });
    }

    // Existing projects, customers and units, read once. Matching row by row
    // would be 150 round trips for a 150-row file.
    const [{ data: projects }, { data: existingCustomers }, { data: existingUnits }] = await Promise.all([
      supabaseAdmin.from('re_projects').select('id, name').eq('organization_id', req.orgId),
      supabaseAdmin.from('re_customers').select('id, full_name, phone, email').eq('organization_id', req.orgId),
      supabaseAdmin.from('re_units').select('id, project_id, unit_number, status').eq('organization_id', req.orgId),
    ]);

    const projectByName = new Map((projects || []).map((p) => [p.name.trim().toLowerCase(), p]));
    // Phone is the reliable key in this market — two buyers share a surname
    // far more often than a phone number, and email is frequently blank.
    const customerByPhone = new Map();
    const customerByEmail = new Map();
    for (const customer of existingCustomers || []) {
      if (customer.phone) customerByPhone.set(digits(customer.phone), customer);
      if (customer.email) customerByEmail.set(customer.email.toLowerCase(), customer);
    }

    // So a dry run can flag "B12 is already reserved by Chidi Okafor" up front,
    // rather than the developer only discovering the conflict once the real
    // import runs and half the file has already been written.
    const unitByKey = new Map(
      (existingUnits || []).map((u) => [`${u.project_id}|${u.unit_number.trim().toLowerCase()}`, u])
    );
    const takenUnitIds = (existingUnits || []).filter((u) => u.status !== 'available').map((u) => u.id);
    const holderByUnitId = new Map();
    if (takenUnitIds.length) {
      const { data: holders } = await supabaseAdmin
        .from('re_reservations')
        .select('unit_id, created_at, re_customers(full_name)')
        .eq('organization_id', req.orgId)
        .in('unit_id', takenUnitIds)
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false });
      for (const h of holders || []) {
        if (!holderByUnitId.has(h.unit_id)) holderByUnitId.set(h.unit_id, h.re_customers?.full_name || null);
      }
    }

    const plan = [];
    const errors = [];

    for (const record of records) {
      const fullName = (record.full_name || record.name || '').trim();
      if (!fullName) { errors.push({ row: record.__row, error: 'full_name is required' }); continue; }

      const entry = {
        row: record.__row,
        full_name: fullName,
        phone: (record.phone || '').trim() || null,
        email: (record.email || '').trim().toLowerCase() || null,
        source: (record.source || '').trim() || null,
        existing_customer: null,
        unit_number: (record.unit_number || '').trim() || null,
        project: null,
        plan: null,
        amount_paid: parseAmount(record.amount_paid_to_date) || 0,
        actions: [],
        conflict: null,
        // buyer_only | buyer_and_reservation | buyer_and_plan — what this row
        // actually creates, so a dry-run preview can say so plainly instead of
        // making someone read the action list to work it out.
        outcome: 'buyer_only',
      };

      const match = (entry.phone && customerByPhone.get(digits(entry.phone)))
        || (entry.email && customerByEmail.get(entry.email));
      if (match) {
        entry.existing_customer = match.id;
        entry.actions.push('customer already exists — will be reused, not duplicated');
      } else {
        entry.actions.push('create customer');
      }

      if (entry.unit_number) {
        // A row's own "project" column overrides the dropdown for that row
        // alone — the dropdown (project_id) is only the default for rows
        // that leave it blank, same priority as /imports/units above.
        const projectName = (record.project || '').trim();
        let resolved = null;
        if (projectName) {
          resolved = projectByName.get(projectName.toLowerCase());
          if (!resolved) {
            errors.push({ row: record.__row, error: `no project named "${record.project}" in this workspace` });
            continue;
          }
        } else if (project_id) {
          resolved = (projects || []).find((p) => p.id === project_id);
        }

        if (!resolved) {
          errors.push({
            row: record.__row,
            error: 'unit_number given without a project — add a "project" column to the CSV, or select a project from the dropdown above.',
          });
          continue;
        }
        entry.project = { id: resolved.id, name: resolved.name };

        const existingUnit = unitByKey.get(`${resolved.id}|${entry.unit_number.toLowerCase()}`);
        if (existingUnit && existingUnit.status !== 'available') {
          const holder = holderByUnitId.get(existingUnit.id);
          entry.conflict = `unit ${entry.unit_number} in ${resolved.name} is already ${existingUnit.status}` +
            (holder ? ` (held by ${holder})` : '');
          errors.push({ row: record.__row, error: entry.conflict });
        } else {
          entry.actions.push(`reserve unit ${entry.unit_number} in ${resolved.name}`);
          entry.outcome = 'buyer_and_reservation';
        }
      }

      const total = parseAmount(record.total_amount);
      const count = record.number_of_installments ? Number(record.number_of_installments) : null;
      const startDate = parseDate(record.start_date);

      if (total || count || startDate) {
        if (!total || !count || !startDate) {
          errors.push({ row: record.__row, error: 'a payment plan needs total_amount, number_of_installments AND start_date' });
          continue;
        }
        if (!Number.isInteger(count) || count < 1 || count > 120) {
          errors.push({ row: record.__row, error: 'number_of_installments must be a whole number between 1 and 120' });
          continue;
        }
        if (!entry.unit_number) {
          errors.push({ row: record.__row, error: 'a payment plan needs a unit_number to attach to' });
          continue;
        }
        if (entry.conflict) {
          errors.push({ row: record.__row, error: `unit ${entry.unit_number} conflict — payment plan not created for this row` });
        } else {
          entry.plan = {
            total_amount: total,
            number_of_installments: count,
            frequency: ['monthly', 'quarterly'].includes((record.frequency || '').toLowerCase())
              ? record.frequency.toLowerCase() : 'monthly',
            start_date: startDate,
          };
          entry.actions.push(`${count} ${entry.plan.frequency} installments totalling ₦${total.toLocaleString('en-NG')}`);
          entry.outcome = 'buyer_and_plan';
          if (entry.amount_paid > 0) {
            entry.actions.push(`apply ₦${entry.amount_paid.toLocaleString('en-NG')} already paid`);
          }
        }
      }

      plan.push(entry);
    }

    if (dry_run) {
      return res.json({
        dry_run: true,
        rows: plan.length,
        errors,
        // Everything, not a sample: this is the screen where someone decides
        // whether to trust the file, and a sample hides the row that is wrong.
        preview: plan,
      });
    }

    if (!plan.length) return res.status(400).json({ error: 'Nothing valid to import.', errors });

    const result = { customers_created: 0, customers_reused: 0, reservations: 0, plans: 0, payments: 0, errors: [...errors] };
    // Every historical payment this run creates, so the batch-level audit
    // entry below can answer "which rows" and not just "how many" — the
    // import itself is one event, but a dispute over one buyer's history
    // needs the id of their specific backfilled row, not just a count.
    const importedPaymentIds = [];

    // Row by row rather than in bulk: a reservation needs the customer's id,
    // and a plan needs the reservation's. One bad row is skipped with its
    // reason rather than failing the other 149.
    for (const entry of plan) {
      try {
        let customerId = entry.existing_customer;

        if (!customerId) {
          const { data: customer, error } = await supabaseAdmin
            .from('re_customers')
            .insert({
              organization_id: req.orgId,
              full_name: entry.full_name,
              phone: entry.phone,
              email: entry.email,
              source: entry.source || 'import',
            })
            .select('id')
            .single();
          if (error) throw error;
          customerId = customer.id;
          result.customers_created += 1;
          if (entry.phone) customerByPhone.set(digits(entry.phone), { id: customerId });
        } else {
          result.customers_reused += 1;
        }

        if (!entry.unit_number) continue;

        // Find the unit, or create it — a developer importing buyers usually
        // has not entered inventory yet, and refusing the row for that reason
        // would make them do the work twice.
        let { data: unit } = await supabaseAdmin
          .from('re_units').select('id, status')
          .eq('organization_id', req.orgId)
          .eq('project_id', entry.project.id)
          .eq('unit_number', entry.unit_number)
          .maybeSingle();

        if (!unit) {
          const { data: created, error } = await supabaseAdmin
            .from('re_units')
            .insert({
              organization_id: req.orgId,
              project_id: entry.project.id,
              unit_number: entry.unit_number,
              list_price: entry.plan?.total_amount || 0,
            })
            .select('id, status')
            .single();
          if (error) throw error;
          unit = created;
        }

        if (unit.status !== 'available') {
          // Fetched fresh rather than from the dry-run prefetch: a unit can be
          // claimed by an earlier row in this very file between the preview
          // and the real run.
          const { data: holderRow } = await supabaseAdmin
            .from('re_reservations')
            .select('re_customers(full_name)')
            .eq('organization_id', req.orgId)
            .eq('unit_id', unit.id)
            .neq('status', 'cancelled')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          const holder = holderRow?.re_customers?.full_name;
          result.errors.push({
            row: entry.row,
            error: `unit ${entry.unit_number} is already ${unit.status}` + (holder ? ` (held by ${holder})` : ''),
          });
          continue;
        }

        // Same conditional claim the reservations route uses: the unique
        // partial index on live reservations applies to imports too, and an
        // import is exactly when a spreadsheet contains the same unit twice.
        const { data: claimed } = await supabaseAdmin
          .from('re_units').update({ status: 'reserved' })
          .eq('id', unit.id).eq('organization_id', req.orgId).eq('status', 'available')
          .select('id');
        if (!claimed?.length) {
          result.errors.push({ row: entry.row, error: `unit ${entry.unit_number} was taken by another row` });
          continue;
        }

        const { data: reservation, error: resErr } = await supabaseAdmin
          .from('re_reservations')
          .insert({ organization_id: req.orgId, unit_id: unit.id, customer_id: customerId })
          .select('id')
          .single();
        if (resErr) {
          await supabaseAdmin.from('re_units').update({ status: 'available' }).eq('id', unit.id);
          throw resErr;
        }
        result.reservations += 1;

        if (!entry.plan) continue;

        const { schedule } = await createPlanWithSchedule(req.orgId, {
          reservationId: reservation.id,
          totalAmount: entry.plan.total_amount,
          numberOfInstallments: entry.plan.number_of_installments,
          frequency: entry.plan.frequency,
          startDate: entry.plan.start_date,
        });
        result.plans += 1;

        // Historical money, applied oldest installment first — which is how it
        // was actually paid, and the only ordering that leaves the right rows
        // outstanding at the end. Batched rather than one insert plus one
        // status re-check per installment: these are brand-new schedule rows
        // with nothing else recorded against them yet, so "is this one fully
        // paid" is exactly "did today's backfill cover its amount_due" —
        // arithmetic this loop already has, not something worth a round trip
        // to ask the database. For an importer's stated case (150 buyers,
        // each with several months already paid) this turns what was
        // hundreds of sequential queries into two.
        let remaining = entry.amount_paid;
        const paymentRows = [];
        const fullyPaidScheduleIds = [];
        for (const row of schedule) {
          if (remaining <= 0) break;
          const applied = Math.min(remaining, Number(row.amount_due));

          paymentRows.push({
            organization_id: req.orgId,
            schedule_id: row.id,
            amount: applied,
            method: 'bank_transfer',
            paid_at: row.due_date,
          });
          // Kobo comparison, like everywhere else money is compared here —
          // floating point equality would leave a fully-paid row stuck
          // 'pending' by a fraction of a kobo.
          if (Math.round(applied * 100) >= Math.round(Number(row.amount_due) * 100)) {
            fullyPaidScheduleIds.push(row.id);
          }
          remaining -= applied;
        }

        if (paymentRows.length) {
          const { data: insertedPayments, error: payErr } = await supabaseAdmin
            .from('re_payments').insert(paymentRows).select('id');
          if (payErr) throw payErr;
          result.payments += paymentRows.length;
          importedPaymentIds.push(...(insertedPayments || []).map((row) => row.id));

          if (fullyPaidScheduleIds.length) {
            const { error: statusErr } = await supabaseAdmin
              .from('re_installment_schedule')
              .update({ status: 'paid', paid_at: new Date().toISOString() })
              .in('id', fullyPaidScheduleIds);
            if (statusErr) throw statusErr;
          }
        }
      } catch (err) {
        result.errors.push({ row: entry.row, error: err.message });
      }
    }

    audit(req, {
      action: 'import.customers',
      entityType: 're_customers',
      summary: `Imported ${result.customers_created} buyers, ${result.reservations} reservations, ${result.payments} historical payments`,
      metadata: { ...result, imported_payment_ids: importedPaymentIds },
    });

    res.status(201).json(result);
  } catch (e) { next(e); }
});

const digits = (value) => String(value || '').replace(/\D/g, '').slice(-10);

module.exports = router;
