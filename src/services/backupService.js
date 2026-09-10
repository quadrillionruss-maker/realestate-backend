// backupService.js — SECTION 25, a full CSV export of a workspace's data,
// zipped and handed back as a signed, expiring link.
//
// Every table read here goes through supabaseAdmin, which auto-filters
// deleted_at is null on every soft-deletable table (middleware/orgContext.js
// — see CLAUDE.md's "Nothing is ever deleted"). This backup is therefore the
// LIVE set, same as every screen in the product — a developer wanting a
// deleted row back already has the recycle bin for that, and re_audit_log
// (no deleted_at at all, nothing in it is ever removed) is complete either
// way.
//
// Its own bucket (env.storage.backupsBucket) rather than the documents one —
// see env.js's own comment on why reusing it is a production landmine.

const archiver = require('archiver');
const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');
const { toCsv } = require('../utils/csv');

const BUCKET = env.storage.backupsBucket;
const SIGNED_URL_TTL_SECONDS = 3600;

async function ensureBucket() {
  const { data: buckets } = await supabaseAdmin.storage.listBuckets();
  if ((buckets || []).some((b) => b.name === BUCKET)) return;

  const { error } = await supabaseAdmin.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: '100MB',
    allowedMimeTypes: ['application/zip'],
  });
  if (error && !/already exists/i.test(error.message)) throw error;
}

// One CSV per table this workspace owns — the spec's own list, mapped onto
// this schema's real table names.
const TABLES = [
  { table: 're_customers', file: 'buyers.csv' },
  { table: 're_reservations', file: 'reservations.csv' },
  // AUDIT FIX (C6) — the schedule a buyer agreed to belongs in a complete
  // export of their own data as much as the payments made against it do;
  // re_payments alone tells you what was PAID, not what was OWED.
  { table: 're_installment_plans', file: 'installment_plans.csv' },
  { table: 're_payments', file: 'payments.csv' },
  { table: 're_documents', file: 'documents.csv' },
  { table: 're_units', file: 'units.csv' },
  { table: 're_projects', file: 'projects.csv' },
  { table: 're_commissions', file: 'commissions.csv' },
  { table: 're_activities', file: 'activities.csv' },
  // AUDIT FIX (C6) — every email/SMS/WhatsApp/push attempt this workspace
  // has sent, including its recipient (CLAUDE.md's "Nothing is ever
  // deleted": re_notifications has no deleted_at at all, same reasoning as
  // re_audit_log right below it). A workspace's own communications record
  // is exactly the kind of thing a complete export must not silently omit.
  { table: 're_notifications', file: 'notifications.csv' },
  { table: 're_audit_log', file: 'audit_log.csv' },
];

// Column order follows whatever Postgres/PostgREST returned for SELECT * —
// good enough for a raw backup, which is read by re-importing or by a human
// in a spreadsheet, not by a fixed downstream parser the way reports.js's
// curated exports are.
function rowsToCsv(rows) {
  if (!rows.length) return toCsv([['note', 'note']], [{ note: 'No rows.' }]);
  const columns = Object.keys(rows[0]).map((key) => [key, key]);
  return toCsv(columns, rows);
}

function zipBuffer(archive) {
  const chunks = [];
  archive.on('data', (chunk) => chunks.push(chunk));
  return new Promise((resolve, reject) => {
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
  });
}

async function buildBackup(orgId) {
  const results = await Promise.all(
    TABLES.map(({ table }) => supabaseAdmin.from(table).select('*').eq('organization_id', orgId))
  );
  for (const result of results) {
    if (result.error) throw result.error;
  }

  const archive = archiver('zip', { zlib: { level: 9 } });
  const bufferPromise = zipBuffer(archive);
  TABLES.forEach(({ file }, i) => {
    archive.append(rowsToCsv(results[i].data || []), { name: file });
  });
  archive.finalize();
  const zip = await bufferPromise;

  await ensureBucket();
  const stamp = new Date().toISOString().slice(0, 10);
  const path = `${orgId}/backup-${stamp}-${Date.now()}.zip`;

  const { error: uploadErr } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, zip, { contentType: 'application/zip', upsert: true });
  if (uploadErr) throw uploadErr;

  const { data: signed, error: signErr } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (signErr) throw signErr;

  return {
    url: signed.signedUrl,
    expires_in_seconds: SIGNED_URL_TTL_SECONDS,
    size_bytes: zip.length,
    tables: TABLES.map((t) => t.file),
  };
}

module.exports = { buildBackup, TABLES };
