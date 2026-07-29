// authService.js — credentials, sessions and Google sign-in.
//
// This is the file that changed what this service is. It used to only VERIFY
// bearer tokens; it now issues them as well. The middleware did not change:
// a token minted here is the same HS256 token, signed with the same
// JWT_SECRET, carrying the same `id` claim that src/middleware/auth.js has
// always expected. Anything already issuing tokens against that secret keeps
// working alongside this.
//
// ── Why scrypt and not bcrypt ──────────────────────────────────────────────
// bcrypt means a native module, which means a compiler on the deploy host and
// a class of build failure that has nothing to do with this product. scrypt is
// in Node's standard library, is memory-hard, and is what OWASP names as an
// acceptable alternative when Argon2 isn't available. No dependency, no build
// step, nothing to go wrong on Render.
//
// ── Enumeration ────────────────────────────────────────────────────────────
// Login and forgot-password answer identically whether or not the address
// exists. Login also runs a dummy hash comparison for unknown users, so the
// response time does not quietly leak the answer either.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { supabaseAdmin } = require('../middleware/orgContext');

// Cost parameters. N=16384 puts a single hash at a few tens of milliseconds on
// a small instance — slow enough to matter offline, fast enough for a login.
// They are stored in the hash string, so raising them later leaves old rows
// verifiable.
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64 };
// N * r * 128 * 2 exceeds Node's 32MB default and throws ERR_CRYPTO_INVALID_SCRYPT_PARAM.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });
const unauthorized = (message) => Object.assign(new Error(message), { statusCode: 401 });

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

// ── Password hashing ───────────────────────────────────────────────────────
function scryptKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      String(password).normalize('NFKC'), // "é" typed two ways must hash alike
      salt,
      SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptKey(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  // A NULL hash is a Google-only or pre-migration account. It must never be
  // read as "no password set, so any password works".
  if (!stored || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltHex, keyHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(keyHex, 'hex');

  let actual;
  try {
    actual = await new Promise((resolve, reject) => {
      crypto.scrypt(
        String(password).normalize('NFKC'),
        salt,
        expected.length,
        { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM },
        (err, key) => (err ? reject(err) : resolve(key))
      );
    });
  } catch {
    return false;
  }

  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Burned on a login attempt for an address that does not exist, so "no such
// user" and "wrong password" take about the same time to answer.
const DUMMY_HASH_PROMISE = hashPassword(crypto.randomBytes(24).toString('hex'));
async function burnTime() {
  try {
    await verifyPassword('not-the-password', await DUMMY_HASH_PROMISE);
  } catch {
    /* timing padding only; never fails a request */
  }
}

// ── Validation ─────────────────────────────────────────────────────────────
function assertValidCredentials(email, password) {
  if (!EMAIL_PATTERN.test(normalizeEmail(email))) {
    throw badRequest('Enter a valid email address.');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  // Long passwords are good; unbounded ones are a way to make the server do
  // arbitrary work per request.
  if (password.length > 200) throw badRequest('Password must be under 200 characters.');
}

// ── Sessions ───────────────────────────────────────────────────────────────
// `id` is the claim src/middleware/auth.js reads; `sub` is set to the same
// value so a token from here also satisfies anything expecting the standard
// claim. `email` is carried for display only — the middleware never trusts it
// for authorization.
function issueToken(user) {
  return jwt.sign(
    { id: user.id, sub: user.id, email: user.email },
    env.jwt.secret,
    { algorithm: 'HS256', expiresIn: env.jwt.expiresIn }
  );
}

const PUBLIC_USER_COLUMNS = 'id, email, full_name, company_name, avatar_url, created_at';

const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  full_name: user.full_name || null,
  company_name: user.company_name || null,
  avatar_url: user.avatar_url || null,
});

async function findUserByEmail(email) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select(`${PUBLIC_USER_COLUMNS}, password_hash, google_sub`)
    .ilike('email', normalizeEmail(email))
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ── Register ───────────────────────────────────────────────────────────────
async function register({ email, password, full_name, company_name }) {
  if (!env.auth.allowRegistration) {
    throw Object.assign(new Error('Sign-up is closed. Ask your administrator for an invite.'), { statusCode: 403 });
  }
  assertValidCredentials(email, password);

  const normalized = normalizeEmail(email);
  if (await findUserByEmail(normalized)) {
    // Registration is the one flow where hiding the answer helps nobody: the
    // person is standing at the form and needs to be told to sign in instead.
    throw Object.assign(new Error('An account with that email already exists. Sign in instead.'), { statusCode: 409 });
  }

  const { data, error } = await supabaseAdmin
    .from('users')
    .insert({
      email: normalized,
      password_hash: await hashPassword(password),
      full_name: (full_name || '').trim() || null,
      company_name: (company_name || '').trim() || null,
      last_login_at: new Date().toISOString(),
    })
    .select(PUBLIC_USER_COLUMNS)
    .single();

  // 23505 = someone registered the same address between the check and here.
  if (error?.code === '23505') {
    throw Object.assign(new Error('An account with that email already exists. Sign in instead.'), { statusCode: 409 });
  }
  if (error) throw error;

  return { token: issueToken(data), user: publicUser(data) };
}

// ── Login ──────────────────────────────────────────────────────────────────
async function login({ email, password }) {
  if (!email || !password) throw badRequest('Email and password are required.');

  const user = await findUserByEmail(email);

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    if (!user) await burnTime();
    // One message for both cases. Which of the two it was is not the
    // attacker's business.
    throw unauthorized('Incorrect email or password.');
  }

  await supabaseAdmin
    .from('users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', user.id);

  return { token: issueToken(user), user: publicUser(user) };
}

// ── Password reset ─────────────────────────────────────────────────────────
// The token is random, single-use and time-boxed; only its SHA-256 is stored,
// so a leaked database row cannot be replayed as a reset link.
const hashResetToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function requestPasswordReset(email) {
  const user = await findUserByEmail(email);

  // Always report success. "No account with that email" turns this form into
  // a way to test whether someone banks with you.
  if (!user) return { sent: false, user: null, resetUrl: null };

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + env.auth.resetTokenTtlMinutes * 60_000).toISOString();

  const { error } = await supabaseAdmin
    .from('users')
    .update({ reset_token_hash: hashResetToken(token), reset_token_expires_at: expiresAt })
    .eq('id', user.id);
  if (error) throw error;

  const base = env.appUrl || '';
  return {
    sent: true,
    user,
    token,
    expiresAt,
    resetUrl: `${base}/index.html#/reset?token=${token}`,
  };
}

async function resetPassword({ token, password }) {
  if (!token) throw badRequest('Reset token is required.');
  assertValidCredentials('placeholder@example.com', password); // password rules only

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('id, email, full_name, company_name, avatar_url, reset_token_expires_at')
    .eq('reset_token_hash', hashResetToken(token))
    .maybeSingle();
  if (error) throw error;

  if (!user || !user.reset_token_expires_at || new Date(user.reset_token_expires_at) < new Date()) {
    throw badRequest('That reset link has expired or already been used. Request a new one.');
  }

  const { error: updateError } = await supabaseAdmin
    .from('users')
    .update({
      password_hash: await hashPassword(password),
      reset_token_hash: null,       // single use
      reset_token_expires_at: null,
    })
    .eq('id', user.id);
  if (updateError) throw updateError;

  return { token: issueToken(user), user: publicUser(user) };
}

// ── Google sign-in ─────────────────────────────────────────────────────────
// The browser runs Google Identity Services and posts us the ID token it got
// back. We verify that token's RS256 signature against Google's published
// keys — the token is not trusted because it arrived, it is trusted because
// it verifies. Node can import a JWK directly, so this needs no library.

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

let googleKeyCache = { keys: null, expiresAt: 0 };

async function googleKeys() {
  if (googleKeyCache.keys && googleKeyCache.expiresAt > Date.now()) return googleKeyCache.keys;

  const response = await fetch(GOOGLE_CERTS_URL);
  if (!response.ok) throw new Error('Could not fetch Google signing keys.');
  const body = await response.json();

  // Respect Google's cache header — rotating keys mid-cache is the one way
  // this breaks in production, and it is entirely avoidable.
  const cacheControl = response.headers.get('cache-control') || '';
  const maxAge = Number((/max-age=(\d+)/.exec(cacheControl) || [])[1] || 3600);

  googleKeyCache = { keys: body.keys || [], expiresAt: Date.now() + maxAge * 1000 };
  return googleKeyCache.keys;
}

async function verifyGoogleIdToken(idToken) {
  if (!env.auth.googleClientId) {
    throw Object.assign(new Error('Google sign-in is not configured on this server.'), { statusCode: 503 });
  }
  if (!idToken) throw badRequest('Google credential is required.');

  const header = jwt.decode(idToken, { complete: true })?.header;
  if (!header?.kid) throw unauthorized('Malformed Google credential.');

  const jwk = (await googleKeys()).find((key) => key.kid === header.kid);
  if (!jwk) throw unauthorized('Google credential was signed with an unknown key.');

  let claims;
  try {
    claims = jwt.verify(idToken, crypto.createPublicKey({ key: jwk, format: 'jwk' }), {
      algorithms: ['RS256'],
      audience: env.auth.googleClientId,
      issuer: GOOGLE_ISSUERS,
    });
  } catch {
    throw unauthorized('Google sign-in failed. Try again.');
  }

  // An unverified email means Google itself does not vouch for the address,
  // so it cannot be used to claim an existing account with that address.
  if (claims.email && claims.email_verified === false) {
    throw unauthorized('That Google account has an unverified email address.');
  }
  return claims;
}

async function loginWithGoogle(idToken) {
  const claims = await verifyGoogleIdToken(idToken);
  const email = normalizeEmail(claims.email);
  const now = new Date().toISOString();

  // Match on `sub` first: it is the only Google identifier that is stable and
  // never reassigned. Email is a fallback for linking an account that already
  // signed up with a password.
  const { data: bySub } = await supabaseAdmin
    .from('users')
    .select(PUBLIC_USER_COLUMNS)
    .eq('google_sub', claims.sub)
    .maybeSingle();

  if (bySub) {
    await supabaseAdmin.from('users').update({ last_login_at: now }).eq('id', bySub.id);
    return { token: issueToken(bySub), user: publicUser(bySub), created: false };
  }

  const existing = email ? await findUserByEmail(email) : null;
  if (existing) {
    const { data: linked, error } = await supabaseAdmin
      .from('users')
      .update({
        google_sub: claims.sub,
        avatar_url: existing.avatar_url || claims.picture || null,
        full_name: existing.full_name || claims.name || null,
        last_login_at: now,
      })
      .eq('id', existing.id)
      .select(PUBLIC_USER_COLUMNS)
      .single();
    if (error) throw error;
    return { token: issueToken(linked), user: publicUser(linked), created: false };
  }

  if (!env.auth.allowRegistration) {
    throw Object.assign(new Error('Sign-up is closed. Ask your administrator for an invite.'), { statusCode: 403 });
  }
  if (!email) throw unauthorized('That Google account did not share an email address.');

  const { data: created, error: insertError } = await supabaseAdmin
    .from('users')
    .insert({
      email,
      google_sub: claims.sub,
      full_name: claims.name || null,
      avatar_url: claims.picture || null,
      last_login_at: now,
      // No password_hash: this account signs in with Google until someone
      // sets one through the reset flow.
    })
    .select(PUBLIC_USER_COLUMNS)
    .single();
  if (insertError) throw insertError;

  return { token: issueToken(created), user: publicUser(created), created: true };
}

module.exports = {
  register,
  login,
  loginWithGoogle,
  requestPasswordReset,
  resetPassword,
  hashPassword,
  verifyPassword,
  issueToken,
  publicUser,
  findUserByEmail,
  normalizeEmail,
  verifyGoogleIdToken,
  MIN_PASSWORD_LENGTH,
};
