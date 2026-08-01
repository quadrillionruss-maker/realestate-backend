// credentials.js — encrypting a WORKSPACE's own third-party API keys at rest.
//
// This is a different threat model from password_hash (authService.js):
// a password only ever needs to be COMPARED, so a one-way hash is enough and
// the plaintext is never needed again. A Paystack secret key or a Resend API
// key has to be handed back to Paystack/Resend in plaintext every time a
// payment link is created or an email is sent — encryption here has to be
// reversible, which is exactly what makes it worth doing carefully.
//
// AES-256-GCM: authenticated encryption, so a tampered ciphertext (a stray
// bit flipped in a backup restore, a bug that truncates a column) fails to
// decrypt loudly instead of silently handing back garbage that then gets
// used as an API key.
//
// Base64 in a `text` column, not `bytea` — PostgREST returns bytea as a
// hex-prefixed string (`\x...`) that has to be parsed correctly by every
// client library reading it; a plain base64 string in `text` is exactly what
// every other JSON-shaped value in this API already is, so there is nothing
// bytea-specific for supabase-js or this file to get subtly wrong.

const crypto = require('crypto');
const env = require('../config/env');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function getKey() {
  const raw = env.credentials.encryptionKey;
  if (!raw) {
    throw Object.assign(
      new Error('This server is not configured to store your own API credentials yet — ask whoever runs it to set CREDENTIALS_ENCRYPTION_KEY.'),
      { statusCode: 503 }
    );
  }
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) {
    throw Object.assign(
      new Error('CREDENTIALS_ENCRYPTION_KEY is misconfigured (must be 32 bytes, 64 hex characters).'),
      { statusCode: 503 }
    );
  }
  return key;
}

// iv (12 bytes) + auth tag (16 bytes) + ciphertext, concatenated and
// base64'd — one column, nothing else to track alongside it.
function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function decrypt(stored) {
  if (!stored) return null;
  const key = getKey();
  const buf = Buffer.from(stored, 'base64');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // Throws (GCM's auth check failing) rather than returning garbage if the
  // stored value was ever tampered with or truncated.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// What Settings shows back for a credential it will never display again in
// full — "configured, ending in 7f3a" is enough for someone to recognise
// their own key without this response ever being worth stealing.
function last4(plaintext) {
  const s = String(plaintext || '');
  return s.length > 4 ? s.slice(-4) : s;
}

module.exports = { encrypt, decrypt, last4 };
