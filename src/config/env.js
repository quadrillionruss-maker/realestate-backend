// env.js — one place that reads process.env.
//
// Values are exported on require so any module can read config, but the hard
// "refuse to boot" check is a separate call: server.js runs it at startup,
// while tests and one-off scripts can require modules without tripping it.

require('dotenv').config();

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET'];

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

    // Registration used to accept any address, so anyone could sign up as
    // ceo@somedeveloper.com and be inside the product immediately. In a market
    // where a developer's name is the whole asset, that is an impersonation
    // problem before it is a security one.
    //
    // DEFAULTS TO WHETHER EMAIL CAN ACTUALLY BE SENT. Requiring verification on
    // a deployment with no RESEND_API_KEY would brick the product: nobody could
    // ever receive the link, so nobody could ever get in — a self-inflicted
    // outage dressed as a security feature. Set REQUIRE_EMAIL_VERIFICATION
    // explicitly to override in either direction.
    requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION
      ? process.env.REQUIRE_EMAIL_VERIFICATION === 'true'
      : Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM),

    verifyTokenTtlHours: parseInt(process.env.VERIFY_TOKEN_TTL_HOURS || '48', 10),
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

  cors: {
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  },

  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY || '',
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
};

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
};

module.exports = env;
