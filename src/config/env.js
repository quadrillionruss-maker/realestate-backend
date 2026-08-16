// env.js — one place that reads process.env.
//
// Values are exported on require so any module can read config, but the hard
// "refuse to boot" check is a separate call: server.js runs it at startup,
// while tests and one-off scripts can require modules without tripping it.

require('dotenv').config();

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET'];

// The exact literal shown in .env.example — someone who copies the file and
// forgets to replace this one line would otherwise boot a production server
// signing every session and every buyer-portal link with a secret published
// in this repo's own history.
const PLACEHOLDER_JWT_SECRET = 'your-jwt-secret-minimum-32-characters';
const MIN_JWT_SECRET_LENGTH = 32;

const env = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',

  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    // A stalled query used to hang the request until Node's own TCP timeout
    // (minutes, if it ever gave up at all) — an operator's "Record payment"
    // click would just spin. This bounds it to something a person will
    // actually wait through before assuming it failed.
    timeoutMs: parseInt(process.env.SUPABASE_TIMEOUT_MS || '20000', 10),
  },

  // Tokens are HS256. This service now both issues (POST /api/auth/login) and
  // verifies them, so a session minted elsewhere with the same secret is still
  // accepted — the middleware did not change, only where tokens come from.
  jwt: {
    secret: process.env.JWT_SECRET,
    // Long enough that a working day never ends in a surprise logout.
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  },

  auth: {
    // Set false once your team is onboarded to stop the open sign-up form.
    allowRegistration: process.env.ALLOW_REGISTRATION !== 'false',
    // Sent to Google Identity Services in the browser and used as the audience
    // when verifying the ID token here. Absent → the button is not rendered.
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    resetTokenTtlMinutes: parseInt(process.env.RESET_TOKEN_TTL_MINUTES || '60', 10),
  },

  // Where the browser app lives. Used to build password-reset and buyer-portal
  // links, which are useless if they point at the API instead of the UI.
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),

  portal: {
    // A buyer signs in twice a year; a 60-day link is the difference between
    // "click here" and a support call.
    //
    // Hard-capped at 90 days, and the cap is the point: revoking a link is a
    // manual act, and the links that most need revoking — a dispute, a deal
    // that fell through — are exactly the ones nobody remembers to revoke. A
    // ceiling means every link eventually stops working on its own. Floored at
    // 1 so a typo cannot mint a link that is already expired.
    tokenTtlDays: Math.min(90, Math.max(1,
      parseInt(process.env.PORTAL_TOKEN_TTL_DAYS || '60', 10) || 60)),
  },

  // Transactional email. Absent → notifications are recorded as 'skipped'
  // rather than failing the request that triggered them.
  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    from: process.env.RESEND_FROM || '',
  },

  // Termii: Nigerian SMS, cheaper than Twilio locally and with local support.
  termii: {
    apiKey: process.env.TERMII_API_KEY || '',
    senderId: process.env.TERMII_SENDER_ID || 'Archta',
  },

  // WhatsApp Business (Meta Cloud API) — the platform's own business
  // account, if this deployment runs one. Most workspaces configure their
  // own instead (Settings → Notifications → WhatsApp, re_org_settings'
  // whatsapp_* columns, migrations/024) the same way they can bring their
  // own Paystack/Resend/Termii — see notificationService.resolveWhatsAppCredentials.
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
    // SECTION 9 — the shared secret Meta's webhook verification handshake
    // (GET /api/webhooks/whatsapp?hub.verify_token=...) is checked against.
    // One value for the whole deployment, not per workspace, because a
    // Meta webhook subscription is configured once at the App level —
    // WHICH workspace an inbound message belongs to is resolved from the
    // message's own phone_number_id against re_org_settings, not from this.
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
  },

  cors: {
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  },

  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY || '',
  },

  // Encrypts an org's OWN Paystack/Resend credentials at rest
  // (src/utils/credentials.js) — a separate concern from the platform's own
  // keys above, which are never stored in the database at all. Optional: a
  // workspace that never enters its own third-party keys never needs this
  // set, and the routes that would use it fail with a clear 503 rather than
  // storing anything unencrypted if it's missing.
  credentials: {
    encryptionKey: process.env.CREDENTIALS_ENCRYPTION_KEY || '',
  },

  // Feature switches for the work that costs money or writes to the world.
  features: {
    // Auto-render a receipt PDF when a payment is recorded. Puppeteer is heavy
    // and absent from some runtimes, so this can be turned off without
    // touching the payment path itself.
    autoReceipts: process.env.RE_AUTO_RECEIPTS !== 'false',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    briefModel: process.env.OPENAI_BRIEF_MODEL || 'gpt-5.6-luna',
  },

  storage: {
    documentsBucket: process.env.RE_DOCUMENTS_BUCKET || 're-documents',
    mediaBucket: process.env.RE_MEDIA_BUCKET || 're-media',
    // Its own bucket rather than reusing documentsBucket (SECTION 25) — that
    // bucket's allowedMimeTypes is a fixed list set at CREATE time on
    // Supabase's side; a bucket already provisioned in production before
    // this feature existed would keep rejecting a ZIP's content-type
    // forever, no matter what this file says. A backup is also a full
    // workspace export, not one document — worth its own bucket on that
    // basis alone.
    backupsBucket: process.env.RE_BACKUPS_BUCKET || 're-backups',
    // Provisioned directly in Supabase, not created by this app — unlike the
    // two buckets above, a missing public-assets bucket is a deploy-config
    // problem to surface, not one to silently paper over by creating it.
    publicAssetsBucket: process.env.RE_PUBLIC_ASSETS_BUCKET || 'public-assets',
  },

  cron: {
    disabled: process.env.RE_DISABLE_CRON === 'true',
    schedule: process.env.RE_BRIEF_CRON || '0 7 * * *',
    // The post-cutoff marking-only sweep — see overdueService for why the day
    // needs both a 07:00 and an 18:05 run.
    eveningSchedule: process.env.RE_EVENING_SWEEP_CRON || '5 18 * * *',
    // SECTION 16 — how often scheduledMessageService.checkScheduledMessages
    // runs. Hourly, not daily: a message scheduled for 2pm should not sit
    // unsent until the next morning's brief run.
    scheduledMessagesSchedule: process.env.RE_SCHEDULED_MESSAGES_CRON || '0 * * * *',
  },

  // 'core' | 'full' | '' — pdfAdapter picks by platform when this is unset;
  // set explicitly to force one engine for local diagnosis.
  pdf: {
    engine: (process.env.PDF_ENGINE || '').toLowerCase(),
  },

  overdue: {
    // Close of business, Lagos. 0-23, falls back to 18 on anything invalid.
    cutoffHour: (() => {
      const raw = parseInt(process.env.RE_DUE_CUTOFF_HOUR || '18', 10);
      return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 18;
    })(),
  },

  // Whether this process serves frontend/ itself. Set false when the
  // frontend is deployed separately (Vercel) and this process is API-only.
  serveFrontend: process.env.SERVE_FRONTEND !== 'false',

  // SECTION 1 — Web Push. Absent → push notifications are recorded
  // 'skipped', same degrade shape as every other optional provider above.
  // Generate a pair once with `npx web-push generate-vapid-keys` — the
  // private key never leaves the server, the public one is handed to the
  // browser's own PushManager.subscribe() call.
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    // web-push requires a contact URI (mailto: or https:) so a push service
    // that needs to reach the sender about abuse has somewhere to go.
    subject: process.env.VAPID_SUBJECT || 'mailto:support@archta.example',
  },

  // Platform-operator access — every re_* table across every workspace, at
  // once, with no org filter. Not a user role: there is no user row and no
  // JWT here, just one shared secret compared with a timing-safe check
  // (src/routes/admin.js). Absent → every /api/admin/* route 503s rather
  // than either booting wide open or refusing to start at all; this is
  // optional infrastructure, not a required credential like JWT_SECRET.
  adminSecret: process.env.ADMIN_SECRET || '',
};

// TASK 3 AUDIT FIX (Important #10) — present-but-weak used to be silently
// usable (only a console.warn, no enforcement anywhere). Deliberately NOT a
// boot-blocking failure the way a weak JWT_SECRET is: JWT_SECRET is
// required — the whole product (every session, every buyer-portal link)
// depends on it, so refusing to boot is proportionate. ADMIN_SECRET is
// optional infrastructure the core product never touches; taking down
// staff and buyer traffic over a weak value entered for a feature nobody
// may even be using tonight would be a wildly disproportionate blast
// radius. Instead, routes/admin.js treats a weak secret exactly like an
// absent one (503, the feature simply isn't usable) — a weak value can
// exist in the environment but can never actually gate real access.
env.adminSecretIsWeak = Boolean(env.adminSecret) && env.adminSecret.length < MIN_JWT_SECRET_LENGTH;

// Called by server.js before anything binds a port. Failing loudly at boot
// beats a 500 on the first request that happens to need a missing key.
env.assertRequired = () => {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error('Missing required environment variables:');
    missing.forEach((key) => console.error(`  - ${key}`));
    console.error('\nCopy .env.example to .env and fill in your values.');
    process.exit(1);
  }

  // Present is not the same as strong. JWT_SECRET signs every staff session
  // AND every buyer-portal link (portalService) — a short or default secret
  // is brute-forceable or simply publicly known, either of which lets anyone
  // forge a token for any user or any buyer's portal link.
  const jwtSecret = process.env.JWT_SECRET || '';
  const jwtProblems = [];
  if (jwtSecret === PLACEHOLDER_JWT_SECRET) {
    jwtProblems.push('JWT_SECRET is still the literal placeholder value from .env.example — generate a real one.');
  }
  if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    jwtProblems.push(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters (got ${jwtSecret.length}).`);
  }
  if (jwtProblems.length) {
    console.error('JWT_SECRET is not strong enough to boot with:');
    jwtProblems.forEach((problem) => console.error(`  - ${problem}`));
    console.error('\nGenerate one: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
    process.exit(1);
  }

  // ADMIN_SECRET is optional infrastructure (env.adminSecret's own comment
  // above), so this logs loudly rather than blocking boot the way a weak
  // JWT_SECRET does — see env.adminSecretIsWeak's own comment for why that
  // split is deliberate. routes/admin.js is what actually enforces this:
  // env.adminSecretIsWeak makes the admin feature 503 exactly as if the
  // secret were never set at all, so a weak value can sit in the
  // environment without ever being able to gate real access.
  if (env.adminSecretIsWeak) {
    console.error(`ADMIN_SECRET is only ${env.adminSecret.length} characters — too short to use. `
      + `It gates unrestricted cross-workspace read/write/delete access and needs to be at least as strong as `
      + `JWT_SECRET (${MIN_JWT_SECRET_LENGTH}+ characters, generated, never reused from another value in this file). `
      + 'The /api/admin/* routes and the /admin dashboard will 503 until this is fixed.');
  }
};

module.exports = env;
