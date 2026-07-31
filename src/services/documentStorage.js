// documentStorage.js — the private bucket every generated PDF lands in.
//
// Split out of documentService once receipts became a second kind of document.
// One copy of "which bucket, how private, how long is the link good for", so a
// receipt cannot accidentally be more public than an allocation letter.
//
// PRIVACY: these files carry a buyer's name and what they paid for a house.
// The bucket is private and the row stores an object PATH, never a bearer
// link; a signed URL is minted per request and expires within the hour.

const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');

const BUCKET = env.storage.documentsBucket;
// One hour: long enough that a link pasted into WhatsApp or opened from a slow
// mobile connection is still good by the time someone taps it, short enough
// that a leaked link is not a standing liability.
const SIGNED_URL_TTL_SECONDS = 3600;

// Created on first use so deploying needs no manual Storage step.
async function ensureBucket() {
  const { data: buckets } = await supabaseAdmin.storage.listBuckets();
  if ((buckets || []).some((b) => b.name === BUCKET)) return;

  const { error } = await supabaseAdmin.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: '10MB',
    allowedMimeTypes: ['application/pdf'],
  });
  // A parallel request may have created it between the check and the call.
  if (error && !/already exists/i.test(error.message)) throw error;
}

async function uploadPdf(storagePath, pdf) {
  await ensureBucket();
  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(storagePath, pdf, { contentType: 'application/pdf', upsert: true });
  if (error) throw error;
  return storagePath;
}

async function createSignedUrl(storagePath) {
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}

// ── Unit media ─────────────────────────────────────────────────────────────
// Floor plans and site photos live in a SEPARATE, PUBLIC bucket, and the split
// is the point. Documents carry a buyer's name and what they paid for a house;
// a floor plan is marketing material a rep needs to pull up mid-call and may
// well want to send by WhatsApp. Putting them in one bucket would mean either
// signing every image URL — which then expires inside a page a rep left open —
// or making allocation letters publicly readable. Two buckets, two answers.

const MEDIA_BUCKET = env.storage.mediaBucket;

// Raster only. An SVG is a document that can carry script, and these URLs end
// up both in an <img> in the browser and inside a Puppeteer-rendered page.
const MEDIA_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf', // a floor plan is very often a PDF
};

const MAX_MEDIA_BYTES = 6 * 1024 * 1024;

async function ensureMediaBucket() {
  const { data: buckets } = await supabaseAdmin.storage.listBuckets();
  if ((buckets || []).some((b) => b.name === MEDIA_BUCKET)) return;

  const { error } = await supabaseAdmin.storage.createBucket(MEDIA_BUCKET, {
    public: true,
    fileSizeLimit: `${MAX_MEDIA_BYTES}`,
    allowedMimeTypes: Object.keys(MEDIA_TYPES),
  });
  if (error && !/already exists/i.test(error.message)) throw error;
}

// Takes the raw bytes and returns a stable public URL. The caller decides the
// path, so a unit's media is grouped under its own id and deleting a unit's
// folder is one call rather than a search.
async function uploadMedia(path, buffer, contentType) {
  const extension = MEDIA_TYPES[contentType];
  if (!extension) {
    throw Object.assign(
      new Error(`Unsupported file type "${contentType}". Use JPEG, PNG, WebP or PDF.`),
      { statusCode: 400 }
    );
  }
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw Object.assign(new Error('That file is larger than 6MB.'), { statusCode: 400 });
  }

  await ensureMediaBucket();

  const fullPath = `${path}.${extension}`;
  const { error } = await supabaseAdmin.storage
    .from(MEDIA_BUCKET)
    .upload(fullPath, buffer, { contentType, upsert: true });
  if (error) throw error;

  const { data } = supabaseAdmin.storage.from(MEDIA_BUCKET).getPublicUrl(fullPath);
  return { path: fullPath, url: data.publicUrl };
}

module.exports = {
  BUCKET, SIGNED_URL_TTL_SECONDS, ensureBucket, uploadPdf, createSignedUrl,
  MEDIA_BUCKET, MEDIA_TYPES, MAX_MEDIA_BYTES, uploadMedia,
};
