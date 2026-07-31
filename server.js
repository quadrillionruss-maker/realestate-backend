// server.js — entry point for the Real Estate Sales Operations API.
//
// A standalone service: it owns its auth, its error handling and its
// scheduled work, and imports nothing from any other codebase. Start it with
// `npm start` (or `node server.js`); it listens on process.env.PORT, which is
// what Render, Railway and Fly all inject.

const env = require('./src/config/env');

// Refuse to boot without SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
// JWT_SECRET, before anything binds a port.
env.assertRequired();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { authenticate } = require('./src/middleware/auth');
const { errorHandler, notFound } = require('./src/middleware/errorHandler');
const { supabaseAdmin } = require('./src/middleware/orgContext');
const reRoutes = require('./src/routes');
const authRoutes = require('./src/routes/auth');
const portalRoutes = require('./src/routes/portal');
const webhookRoutes = require('./src/routes/webhooks');

const app = express();

// Render (like most PaaS) terminates TLS at a proxy. Without this the rate
// limiter sees the proxy's IP for every request and throttles all users as one.
app.set('trust proxy', 1);

// helmet's default Content-Security-Policy is `script-src 'self'`, which is
// right for a bare API and wrong the moment this process also serves the
// browser app: it blocks Google Identity Services and the webfonts outright.
// The policy below is the smallest one under which the app actually works —
// still no inline scripts (which is why the API base lives in config.js rather
// than a <script> block in the page), and no wildcard anywhere.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://accounts.google.com'],
      // 'unsafe-inline' for styles only: the app sets width on progress bars
      // and unit-mix segments from data, which is a style attribute.
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      // https: for images because a developer's logo is a URL they own.
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://accounts.google.com', ...env.cors.allowedOrigins],
      frameSrc: ['https://accounts.google.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  // Signed Supabase Storage URLs are opened in a new tab; the default
  // same-origin policy on this header blocks that in some browsers.
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));

// ── CORS ───────────────────────────────────────────────────────────────────
// Never `origin: true` in production — that accepts credentialed requests from
// any site on the internet.
//
// Three sources, unioned:
//   PRODUCTION_ORIGINS  the deployed frontend, baked in
//   ALLOWED_ORIGINS     anything else, per environment
//   DEV_ORIGINS         localhost, and only when NODE_ENV != production
const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:4000',
  'http://localhost:5173',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

// The canonical deployed frontend. In the file rather than only in
// ALLOWED_ORIGINS so that a fresh deploy, or a service recreated from
// render.yaml, serves a working app before anyone remembers to set the
// variable — a forgotten env var here presents as every request failing CORS,
// which reads like a broken API rather than a missing setting.
//
// Exact origins only, never a wildcard or a regex over *.vercel.app: Vercel
// preview URLs are attacker-registerable in the general case, and `credentials:
// true` below means an allowed origin can make authenticated requests.
const PRODUCTION_ORIGINS = [
  'https://realestate-frontend-pi.vercel.app',
];

const allowedOrigins = new Set([
  ...PRODUCTION_ORIGINS,
  ...env.cors.allowedOrigins,
  ...(env.isDev ? DEV_ORIGINS : []),
]);

const corsOptions = {
  origin(origin, callback) {
    // No Origin header: server-to-server, curl, health checks.
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    callback(Object.assign(new Error(`CORS: origin '${origin}' not allowed.`), { statusCode: 403 }));
  },
  // PATCH is not optional here — every status transition in this API
  // (/reservations/:id/status, /tasks/:id/status, /documents/:id/status) uses
  // it, and the browser preflight fails without it.
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  // X-Workspace-Id names WHICH of a person's workspaces this request is in.
  // It is not optional for anyone who belongs to more than one: the browser
  // sends it on every call, and a preflight that rejects it would leave a
  // multi-workspace user permanently in whichever one the server picked.
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Workspace-Id'],
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ── Rate limiting ──────────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please slow down.' },
}));

// ── Webhooks ───────────────────────────────────────────────────────────────
// MOUNTED BEFORE express.json() ON PURPOSE. Paystack signs the raw request
// bytes; parsing to an object and re-serializing does not round-trip (key
// order and whitespace both move), so the signature would never verify again.
// express.raw() here keeps a Buffer for exactly this one path. Moving this
// below the JSON parser silently breaks every incoming payment.
app.use('/api/webhooks', express.raw({ type: '*/*', limit: '1mb' }), webhookRoutes);

// ── Body parsing ───────────────────────────────────────────────────────────
// Must come before the routes, or req.body is undefined in every handler.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health check ───────────────────────────────────────────────────────────
// Queries a table this service owns, so it reports on the database this API
// actually depends on. Render polls this to decide if a deploy is live.
app.get('/health', async (_req, res) => {
  let database = 'ok';
  try {
    const { error } = await supabaseAdmin.from('re_projects').select('id').limit(1);
    if (error) database = 'error';
  } catch {
    database = 'error';
  }

  res.status(database === 'ok' ? 200 : 503).json({
    status: database === 'ok' ? 'ok' : 'degraded',
    service: 'Real Estate Sales Operations API',
    database,
    environment: env.nodeEnv,
    timestamp: new Date().toISOString(),
  });
});

// ── Auth ───────────────────────────────────────────────────────────────────
// NOT behind `authenticate` — these are the endpoints you call when you do not
// yet have a token. This service now issues them as well as verifying them.
app.use('/api/auth', authRoutes);

// ── Buyer portal ───────────────────────────────────────────────────────────
// Also outside `authenticate`: a buyer holds a signed portal link, not a staff
// token, and the two are not interchangeable in either direction (the portal
// token carries aud:'re-portal', which the staff middleware never accepts).
app.use('/api/portal', portalRoutes);

// ── API ────────────────────────────────────────────────────────────────────
// authenticate populates req.user; orgContext (inside reRoutes) turns that
// into req.orgId, which every query filters on.
app.use('/api/re', authenticate, reRoutes);

// ── The browser app ────────────────────────────────────────────────────────
// Served from the same process so `npm start` gives you the whole product at
// one URL with no second server and no CORS to configure while developing.
// In production the frontend is usually deployed separately (Vercel); set
// SERVE_FRONTEND=false there if you would rather this process not serve it.
// Mounted after /api/* so it can never shadow an endpoint.
if (env.serveFrontend) {
  app.use(express.static(require('path').join(__dirname, 'frontend'), { extensions: ['html'] }));
}

app.use(notFound);
app.use(errorHandler); // must be last

// ── Scheduled work ─────────────────────────────────────────────────────────
// 07:00 Africa/Lagos: mark installments overdue, then brief every org.
// Requiring the module schedules it; RE_DISABLE_CRON=true skips it.
require('./src/jobs/daily');

// ── Listen ─────────────────────────────────────────────────────────────────
const server = app.listen(env.port, () => {
  console.log('');
  console.log('  ●  Real Estate Sales Operations API');
  console.log(`  ↳  http://localhost:${env.port}`);
  console.log(`  ↳  Environment: ${env.nodeEnv}`);
  console.log(`  ↳  Health:      http://localhost:${env.port}/health`);
  console.log(`  ↳  API:         http://localhost:${env.port}/api/re`);
  console.log(`  ↳  Sign in:     http://localhost:${env.port}/api/auth/login`);
  console.log(`  ↳  Webhook:     http://localhost:${env.port}/api/webhooks/paystack`);
  if (env.serveFrontend) {
    console.log(`  ↳  App:         http://localhost:${env.port}/`);
  }
  console.log('');
});

// A crash that leaves the process running serves broken responses to real
// users; better to exit and let the platform restart a clean one. Applied to
// BOTH handlers — an unhandled rejection left running is the same class of
// corrupted state as an uncaught exception, and this codebase has enough
// fire-and-forget async work (unawaited audit writes, notification sends)
// that treating the two differently was never a deliberate choice.
//
// `reason` on a rejection is not guaranteed to be an Error — anything can be
// thrown or rejected with. Logging it directly if it is not one risks
// printing an arbitrary value (in the worst case, a row containing a buyer's
// name or email) to logs Render retains indefinitely.
function describeCrash(value) {
  if (value instanceof Error) return value.stack || value.message;
  return `non-Error rejection of type ${typeof value}: ${String(value).slice(0, 200)}`;
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', describeCrash(reason));
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', describeCrash(err));
  process.exit(1);
});

// Render sends SIGTERM on deploy. Finish in-flight requests before exiting so
// a payment being recorded mid-deploy is not dropped.
const shutdown = (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
