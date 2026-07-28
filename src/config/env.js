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

  // Tokens are HS256 and must be signed with the same secret as whatever
  // issues them, so a session minted elsewhere is accepted here.
  jwt: {
    secret: process.env.JWT_SECRET,
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
