#!/usr/bin/env node
// make-token.js — mint a bearer token for local work and smoke tests.
//
//   npm run token -- <user-uuid> [email] [expiry]
//   npm run token -- 3f1c...  you@example.com 30d
//
// This service verifies tokens but does not issue them, so on a fresh install
// there is no way to call any endpoint until something signs one. That
// something is normally your login service; this script covers the gap while
// you are setting up, running the smoke test, or debugging.
//
// It signs with JWT_SECRET from .env — the same secret the API verifies with.
// It does NOT check that the user exists; create the row first (see the
// bootstrap block at the end of migrations/001_phase1_schema.sql), or the
// token will authenticate as an id that owns nothing.
//
// Treat the output like a password: it grants full access to that account's
// data for as long as it is valid. Prefer short expiries.

const jwt = require('jsonwebtoken');
const env = require('../src/config/env');

const [userId, email, expiresIn = '7d'] = process.argv.slice(2);

if (!userId) {
  console.error(`
  Usage: npm run token -- <user-uuid> [email] [expiry]

  Example:
    npm run token -- 3f1c8e42-9a7b-4c11-8f23-6d5e4a1b2c3d you@example.com 7d

  Create the user first:
    insert into users (email, full_name) values ('you@example.com', 'Your Name') returning id;
`);
  process.exit(1);
}

if (!env.jwt.secret) {
  console.error('JWT_SECRET is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!UUID.test(userId)) {
  // Not fatal — an external identity provider may not use UUIDs — but a typo'd
  // id produces a token that authenticates as nobody, which is confusing to debug.
  console.warn(`  Warning: "${userId}" is not a UUID. Continuing anyway.\n`);
}

// `id` is what this API reads first; `sub` is the standard claim, included so
// the same token works against anything else expecting it.
const token = jwt.sign(
  { id: userId, sub: userId, ...(email ? { email } : {}) },
  env.jwt.secret,
  { algorithm: 'HS256', expiresIn }
);

console.log(`\n${token}\n`);
console.error(`  expires in ${expiresIn}\n`);
console.error('  Try it:');
console.error(`    curl -H "Authorization: Bearer $TOKEN" http://localhost:${env.port}/api/re/projects\n`);
console.error('  Smoke test:');
console.error(`    RE_SMOKE_TOKEN=$TOKEN npm run smoke\n`);
