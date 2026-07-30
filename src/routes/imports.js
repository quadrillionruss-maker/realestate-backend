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
const { parseCsvToObjects, parseAmount, parseDate } = require('../utils/csv');
const { createPlanWithSchedule } = require('../services/installmentService');
const { applyPaymentsToSchedule } = require('../services/paystackService');
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

// ── Units into one project ────────────────────────────────────────────────
router.post('/units', async (req, res, next) => {
  try {
    const { project_id, csv, dry_run } = req.body || {};
    if (!project_id) return res.status(400).json({ error: 'project_id is required' });
    if (!csv) return res.status(400).json({ error: 'csv is required' });

    const { data: project } = await supabaseAdmin
      .from('re_projects').select('id, name')
      .eq('id', project_id).eq('organization_id', req.orgId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { records } = parseCsvToObjects(csv);
    if (!records.length) return res.status(400).json({ error: 'The file has no data rows.' });
    if (records.length > MAX_ROWS) {
      return res.status(400).json({ error: `Too many rows (${records.length}). Split the file into batches of ${MAX_ROWS}.` });
    }

    const rows = [];
    const errors = [];
    const seen = new Set();

    for (const record of records) {
      const unitNumber = (record.unit_number || '').trim();
      const price = parseAmount(record.list_price);

      if (!unitNumber) { errors.push({ row: record.__row, error: 'unit_number is required' }); continue; }
      if (price == null || price < 0) { errors.push({ row: record.__row, error: 'list_price must be a number' }); continue; }
      if (seen.has(unitNumber)) { errors.push({ row: record.__row, error: `duplicate unit_number "${unitNumber}" in this file` }); continue; }

      seen.add(unitNumber);
      rows.push({
        organization_id: req.orgId,
        project_id,
        unit_number: unitNumber,
        unit_type: record.unit_type || null,
        size_sqm: parseAmount(record.size_sqm),
        list_price: price,
      });
    }

    if (dry_run) return res.json({ dry_run: true, would_create: rows.length, errors, sample: rows.slice(0, 5) });
    if (!rows.length) return res.status(400).json({ error: 'Nothing valid to import.', errors });

    const { data, error } = await supabaseAdmin.from('re_units').insert(rows).select();
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'One or more unit numbers already exist in this project.', errors });
    }
    if (error) throw error;

    audit(req, {
      action: 'import.units',
      entityType: 're_units',
      entityId: project_id,
      summary: `Imported ${data.length} units into ${project.name}`,
      metadata: { project_id, created: data.length, skipped: errors.length },
    });

    res.status(201).json({ created: data.length, errors, units: data });
  } catch (e) { next(e); }
});

// ── Buyers, with their unit, plan and payment history ─────────────────────
router.post('/customers', async (req, res, next) => {
  try {
    const { csv, project_id, dry_run } = req.body || {};
    if (!csv) return res.status(400).json({ error: 'csv is required' });

    const { records } = parseCsvToObjects(csv);
    if (!records.length) return res.status(400).json({ error: 'The file has no data rows.' });
    if (records.length > MAX_ROWS) {
      return res.status(400).json({ error: `Too many rows (${records.length}). Split the file into batches of ${MAX_ROWS}.` });
    }

    // Existing projects and customers, read once. Matching row by row would be
    // 150 round trips for a 150-row file.
    const [{ data: projects }, { data: existingCustomers }] = await Promise.all([
      supabaseAdmin.from('re_projects').select('id, name').eq('organization_id', req.orgId),
      supabaseAdmin.from('re_customers').select('id, full_name, phone, email').eq('organization_id', req.orgId),
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
        const projectName = (record.project || '').trim().toLowerCase();
        const resolved = project_id
          ? (projects || []).find((p) => p.id === project_id)
          : projectByName.get(projectName);

        if (!resolved) {
          errors.push({
            row: record.__row,
            error: projectName
              ? `no project named "${record.project}" in this workspace`
              : 'unit_number given without a project — add a "project" column or pass project_id',
          });
          continue;
        }
        entry.project = { id: resolved.id, name: resolved.name };
        entry.actions.push(`reserve unit ${entry.unit_number} in ${resolved.name}`);
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
        entry.plan = {
          total_amount: total,
          number_of_installments: count,
          frequency: ['monthly', 'quarterly'].includes((record.frequency || '').toLowerCase())
            ? record.frequency.toLowerCase() : 'monthly',
          start_date: startDate,
        };
        entry.actions.push(`${count} ${entry.plan.frequency} installments totalling ₦${total.toLocaleString('en-NG')}`);
        if (entry.amount_paid > 0) {
          entry.actions.push(`apply ₦${entry.amount_paid.toLocaleString('en-NG')} already paid`);
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
          result.errors.push({ row: entry.row, error: `unit ${entry.unit_number} is already ${unit.status}` });
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
        // outstanding at the end.
        let remaining = entry.amount_paid;
        for (const row of schedule) {
          if (remaining <= 0) break;
          const applied = Math.min(remaining, Number(row.amount_due));

          const { error: payErr } = await supabaseAdmin.from('re_payments').insert({
            organization_id: req.orgId,
            schedule_id: row.id,
            amount: applied,
            method: 'bank_transfer',
            paid_at: row.due_date,
          });
          if (payErr) throw payErr;

          await applyPaymentsToSchedule(row.id);
          result.payments += 1;
          remaining -= applied;
        }
      } catch (err) {
        result.errors.push({ row: entry.row, error: err.message });
      }
    }

    audit(req, {
      action: 'import.customers',
      entityType: 're_customers',
      summary: `Imported ${result.customers_created} buyers, ${result.reservations} reservations, ${result.payments} historical payments`,
      metadata: result,
    });

    res.status(201).json(result);
  } catch (e) { next(e); }
});

const digits = (value) => String(value || '').replace(/\D/g, '').slice(-10);

module.exports = router;
