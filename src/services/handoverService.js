// handoverService.js — handover checklist and snagging, SECTION 11.
//
// A checklist exists once a unit is actually ready, created deliberately
// (POST /reservations/:id/handover, owner/sales_director) — marking a
// reservation 'completed' only ever PROMPTS this from the frontend
// (screens.js), it never creates one itself.
const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('../middleware/orgContext');
const { renderHtmlToPdf } = require('./pdfAdapter');
const { escapeHtml } = require('../utils/escapeHtml');
const { resolveBranding } = require('./brandingService');
const { fillPlaceholders } = require('./documentService');
const { uploadPdf, uploadMedia } = require('./documentStorage');
const { assignedRepUser } = require('./messageService');
const { audit, auditSystem } = require('./auditService');

const TEMPLATE_PATH = path.join(__dirname, '../templates/handover_certificate.html');
const CHECKLIST_STATUSES = ['pending', 'inspection_done', 'issues_raised', 'resolved', 'signed_off'];
const SNAG_STATUSES = ['open', 'acknowledged', 'fixed', 'disputed'];

const formatDate = (value) =>
  new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

// ── Checklist ──────────────────────────────────────────────────────────
async function createChecklist(req, reservationId, { handoverDate, keysHanded, meterReadings, documentsProvided }) {
  const { data: reservation } = await supabaseAdmin
    .from('re_reservations').select('id').eq('id', reservationId).eq('organization_id', req.orgId).maybeSingle();
  if (!reservation) return { notFound: true };

  const { data, error } = await supabaseAdmin
    .from('re_handover_checklists')
    .insert({
      organization_id: req.orgId,
      reservation_id: reservationId,
      created_by: req.userId,
      handover_date: handoverDate || null,
      keys_handed: Boolean(keysHanded),
      meter_readings: meterReadings && typeof meterReadings === 'object' ? meterReadings : {},
      documents_provided: Array.isArray(documentsProvided) ? documentsProvided : [],
    })
    .select()
    .single();
  if (error) {
    if (error.code === '23505') {
      throw Object.assign(new Error('This reservation already has a handover checklist.'), { statusCode: 409 });
    }
    throw error;
  }

  audit(req, {
    action: 'handover.checklist_created',
    entityType: 're_handover_checklists',
    entityId: data.id,
    summary: `Handover checklist created for reservation ${reservationId}`,
    metadata: { reservation_id: reservationId },
  });

  return data;
}

async function getChecklist(orgId, reservationId) {
  const { data: checklist, error } = await supabaseAdmin
    .from('re_handover_checklists')
    .select('*')
    .eq('organization_id', orgId)
    .eq('reservation_id', reservationId)
    .maybeSingle();
  if (error) throw error;
  if (!checklist) return null;

  const { data: items } = await supabaseAdmin
    .from('re_snagging_items')
    .select('*')
    .eq('checklist_id', checklist.id)
    .order('created_at', { ascending: true });

  checklist.snagging_items = items || [];
  return checklist;
}

async function getChecklistById(orgId, id) {
  const { data, error } = await supabaseAdmin
    .from('re_handover_checklists')
    .select('*')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function updateChecklist(req, id, updates) {
  const patch = {};
  if (updates.status !== undefined) {
    if (!CHECKLIST_STATUSES.includes(updates.status)) {
      throw Object.assign(new Error(`status must be one of: ${CHECKLIST_STATUSES.join(', ')}`), { statusCode: 400 });
    }
    patch.status = updates.status;
  }
  if (updates.handover_date !== undefined) patch.handover_date = updates.handover_date || null;
  if (updates.keys_handed !== undefined) patch.keys_handed = Boolean(updates.keys_handed);
  if (updates.meter_readings !== undefined) {
    if (typeof updates.meter_readings !== 'object' || Array.isArray(updates.meter_readings)) {
      throw Object.assign(new Error('meter_readings must be an object'), { statusCode: 400 });
    }
    patch.meter_readings = updates.meter_readings;
  }
  if (updates.documents_provided !== undefined) {
    if (!Array.isArray(updates.documents_provided)) {
      throw Object.assign(new Error('documents_provided must be an array'), { statusCode: 400 });
    }
    patch.documents_provided = updates.documents_provided;
  }

  if (!Object.keys(patch).length) {
    throw Object.assign(new Error('No updatable fields provided'), { statusCode: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('re_handover_checklists')
    .update(patch)
    .eq('id', id)
    .eq('organization_id', req.orgId)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) return { notFound: true };

  audit(req, {
    action: 'handover.checklist_updated',
    entityType: 're_handover_checklists',
    entityId: data.id,
    summary: `Handover checklist updated: ${Object.keys(patch).join(', ')}`,
    metadata: patch,
  });

  return data;
}

// ── Snagging ───────────────────────────────────────────────────────────
// Portal: the buyer logs a defect. photo is optional base64 content, same
// shape as every other base64-in-JSON upload in this product (unit media,
// avatars) — no multipart middleware for a handful of images per handover.
async function logSnag(customer, reservationId, { description, photo }) {
  const trimmed = String(description || '').trim();
  if (!trimmed) throw Object.assign(new Error('description is required'), { statusCode: 400 });

  const checklist = await getChecklist(customer.organization_id, reservationId);
  if (!checklist) {
    throw Object.assign(new Error('No handover checklist exists for this reservation yet.'), { statusCode: 404 });
  }

  let photoUrl = null;
  if (photo?.content && photo?.contentType) {
    const base64 = String(photo.content).replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length) {
      const stored = await uploadMedia(
        `${customer.organization_id}/snags/${checklist.id}/${Date.now()}`,
        buffer,
        photo.contentType
      );
      photoUrl = stored.url;
    }
  }

  const { data, error } = await supabaseAdmin
    .from('re_snagging_items')
    .insert({
      checklist_id: checklist.id,
      organization_id: customer.organization_id,
      description: trimmed,
      photo_url: photoUrl,
    })
    .select()
    .single();
  if (error) throw error;

  auditSystem({
    orgId: customer.organization_id,
    actorKind: 'portal',
    actorEmail: customer.email,
    action: 'handover.snag_logged',
    entityType: 're_snagging_items',
    entityId: data.id,
    summary: `${customer.full_name} logged a snagging item`,
    metadata: { checklist_id: checklist.id, reservation_id: reservationId },
  });

  // Never let a notification failure hide that the snag itself was saved —
  // the same rule messageService.sendFromBuyer follows for a buyer message.
  try {
    const rep = await assignedRepUser(customer.organization_id, customer.id);
    if (rep) {
      await supabaseAdmin.from('re_tasks').insert({
        organization_id: customer.organization_id,
        title: `Snagging item logged — ${customer.full_name}`,
        notes: trimmed,
        assigned_to: rep.id,
        related_reservation_id: reservationId,
        source: 'ai',
      });
    }
  } catch (err) {
    console.warn('[handover] could not file snag task:', err.message);
  }

  return data;
}

async function updateSnag(req, snagId, { status, developerResponse, fixCommittedDate }) {
  const patch = {};
  if (status !== undefined) {
    if (!SNAG_STATUSES.includes(status)) {
      throw Object.assign(new Error(`status must be one of: ${SNAG_STATUSES.join(', ')}`), { statusCode: 400 });
    }
    patch.status = status;
    if (status === 'fixed') patch.fixed_at = new Date().toISOString();
  }
  if (developerResponse !== undefined) patch.developer_response = developerResponse || null;
  if (fixCommittedDate !== undefined) patch.fix_committed_date = fixCommittedDate || null;

  if (!Object.keys(patch).length) {
    throw Object.assign(new Error('No updatable fields provided'), { statusCode: 400 });
  }

  const { data: existing } = await supabaseAdmin
    .from('re_snagging_items').select('checklist_id').eq('id', snagId).eq('organization_id', req.orgId).maybeSingle();
  if (!existing) return { notFound: true };

  const { data, error } = await supabaseAdmin
    .from('re_snagging_items')
    .update(patch)
    .eq('id', snagId)
    .eq('organization_id', req.orgId)
    .select()
    .single();
  if (error) throw error;

  audit(req, {
    action: 'handover.snag_updated',
    entityType: 're_snagging_items',
    entityId: data.id,
    summary: `Snagging item moved to ${data.status}`,
    metadata: patch,
  });

  // SECTION 11 — "When all snagging items are fixed: generate a Handover
  // Certificate PDF". Checked after every status change, not just this one,
  // since fixing the LAST open item is the one that actually crosses the
  // threshold and there is no other trigger watching for it.
  if (patch.status === 'fixed') {
    const { data: siblings } = await supabaseAdmin
      .from('re_snagging_items').select('status').eq('checklist_id', existing.checklist_id);
    const allFixed = (siblings || []).length > 0 && (siblings || []).every((s) => s.status === 'fixed');
    if (allFixed) {
      try {
        await generateHandoverCertificate(req.orgId, existing.checklist_id);
      } catch (err) {
        console.warn('[handover] could not generate certificate:', err.message);
      }
    }
  }

  return data;
}

// ── Handover Certificate ──────────────────────────────────────────────
async function generateHandoverCertificate(orgId, checklistId) {
  const { data: checklist } = await supabaseAdmin
    .from('re_handover_checklists')
    .select(`
      id, reservation_id, handover_date, keys_handed,
      re_reservations(re_customers(full_name), re_units(unit_number, re_projects(name, location)))
    `)
    .eq('id', checklistId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (!checklist) throw Object.assign(new Error('Checklist not found'), { statusCode: 404 });

  const { data: items } = await supabaseAdmin
    .from('re_snagging_items').select('id').eq('checklist_id', checklistId);

  const branding = await resolveBranding(orgId);
  const reservation = checklist.re_reservations || {};
  const customer = reservation.re_customers || {};
  const unit = reservation.re_units || {};
  const project = unit.re_projects || {};

  const companyName = branding.brand_company_name || branding.company_name || branding.full_name || 'Our Company';
  const logoUrl = branding.brand_logo_url || branding.logo_url;
  const logoBlock = (logoUrl && String(logoUrl).startsWith('https://'))
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(companyName)}">`
    : '';

  const html = fillPlaceholders(
    fs.readFileSync(TEMPLATE_PATH, 'utf8'),
    {
      COMPANY_NAME: companyName,
      LOGO_BLOCK: logoBlock,
      REFERENCE_NUMBER: `HANDOVER-${checklist.reservation_id.slice(0, 8).toUpperCase()}`,
      DATE: formatDate(new Date()),
      CUSTOMER_NAME: customer.full_name || 'Valued Customer',
      UNIT_NUMBER: unit.unit_number || '—',
      PROJECT_LINE: [project.name, project.location].filter(Boolean).join(', '),
      HANDOVER_DATE: checklist.handover_date ? formatDate(checklist.handover_date) : formatDate(new Date()),
      KEYS_HANDED: checklist.keys_handed ? 'Yes' : 'No',
      SNAG_COUNT: String((items || []).length),
    },
    ['LOGO_BLOCK']
  );

  const pdf = await renderHtmlToPdf(html);
  const storagePath = `${orgId}/${checklist.reservation_id}/handover_certificate-${Date.now()}.pdf`;
  await uploadPdf(storagePath, pdf);

  const { data, error } = await supabaseAdmin
    .from('re_documents')
    .insert({
      organization_id: orgId,
      reservation_id: checklist.reservation_id,
      doc_type: 'handover_certificate',
      status: 'generated',
      storage_path: storagePath,
      generated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw error;

  await supabaseAdmin
    .from('re_handover_checklists').update({ status: 'signed_off' }).eq('id', checklistId).eq('organization_id', orgId);

  auditSystem({
    orgId,
    action: 'handover.certificate_generated',
    entityType: 're_documents',
    entityId: data.id,
    summary: `Handover Certificate generated for reservation ${checklist.reservation_id} — all snagging items fixed`,
  });

  return data;
}

module.exports = {
  CHECKLIST_STATUSES, SNAG_STATUSES,
  createChecklist, getChecklist, getChecklistById, updateChecklist,
  logSnag, updateSnag, generateHandoverCertificate,
};
