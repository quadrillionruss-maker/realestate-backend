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
    tokenTtlDays: parseInt(process.env.PORTAL_TOKEN_TTL_DAYS || '60', 10),
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
    senderId: process.env.TERMII_SENDER_ID || 'Realtika',
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
  },

  cron: {
    disabled: process.env.RE_DISABLE_CRON === 'true',
    schedule: process.env.RE_BRIEF_CRON || '0 7 * * *',
  },
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
