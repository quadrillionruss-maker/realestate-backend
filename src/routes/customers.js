const express = require('express');
const { supabaseAdmin } = require('../middleware/orgContext');
const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('re_customers')
      .select('*')
      .eq('organization_id', req.orgId)
      .order('created_at', { ascending: false });

    if (req.query.search) {
      // Sales staff search by whatever they have to hand — a name, the phone
      // number from a WhatsApp thread, or an email.
      // % and _ are escaped so a search for "100%" isn't read as a wildcard.
      const term = String(req.query.search).replace(/[%_]/g, (c) => `\\${c}`);
      query = query.or(`full_name.ilike.%${term}%,phone.ilike.%${term}%,email.ilike.%${term}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// Full buyer history: every reservation, its plan, and every installment.
// This is the screen a rep opens with the customer on the phone.
router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('re_customers')
      .select(`
        *,
        re_reservations(
          id, status, reserved_at,
          re_units(unit_number, list_price, re_projects(name, location)),
          re_installment_plans(
            id, total_amount, number_of_installments, frequency, start_date,
            re_installment_schedule(id, installment_number, due_date, amount_due, status, paid_at)
          )
        )`)
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { full_name, email, phone, source } = req.body || {};
    if (!full_name) return res.status(400).json({ error: 'full_name is required' });

    const { data, error } = await supabaseAdmin
      .from('re_customers')
      .insert({
        organization_id: req.orgId,
        full_name,
        email: email || null,
        phone: phone || null,
        source: source || null,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { full_name, email, phone, source } = req.body || {};
    const updates = {};
    if (full_name !== undefined) updates.full_name = full_name;
    if (email !== undefined) updates.email = email;
    if (phone !== undefined) updates.phone = phone;
    if (source !== undefined) updates.source = source;
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const { data, error } = await supabaseAdmin
      .from('re_customers')
      .update(updates)
      .eq('id', req.params.id)
      .eq('organization_id', req.orgId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (e) { next(e); }
});

module.exports = router;
