// errorHandler.js — the last middleware in the stack.
//
// Every route in this service ends with `catch (e) { next(e) }`, so this is
// where those land. Services attach `statusCode` to errors they raise
// deliberately (404 for a missing installment, 409 for one already paid);
// anything without one is an unexpected failure and becomes a 500.

const env = require('../config/env');

function errorHandler(err, req, res, next) {
  // A prior handler (e.g. reports.js's CSV export, which streams headers
  // before the body) may already have started writing the response. Calling
  // res.status().json() again in that state throws ERR_HTTP_HEADERS_SENT —
  // Express's own documented escape hatch is to delegate to the default
  // handler via next(err) instead of writing a second response.
  if (res.headersSent) return next(err);

  const statusCode = err.statusCode || err.status || 500;

  // Always log server-side with enough context to find it in Render's logs.
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${statusCode}: ${err.message}`);
  // Routes throughout this codebase throw supabase-js's plain
  // {message, details, hint, code} object, not an Error instance — it has no
  // .stack, so logging err.stack alone silently logs "undefined" for the most
  // common class of 500 here. err.code is a Postgres SQLSTATE (never row
  // data, unlike .details/.hint, which must never be logged — see CLAUDE.md's
  // "Data retention" section), so it's what's left to log when there's no
  // stack.
  if (statusCode >= 500) console.error(err.stack || `code=${err.code || 'n/a'}`);

  // 4xx messages are written for the caller and are safe to return.
  // 5xx messages can carry internals (a Postgres error, a stack frame), so in
  // production they are replaced — the detail is in the log above.
  const body = { success: false, error: statusCode >= 500 ? 'Something went wrong.' : err.message };

  if (statusCode >= 500 && env.isDev) {
    body.error = err.message;
    body.stack = err.stack;
  }

  res.status(statusCode).json(body);
}

// throw createError(404, 'Unit not found')
function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function notFound(req, res) {
  // Same reflector concern as the CORS rejection message above: this is an
  // unauthenticated path, and req.originalUrl is attacker-controlled input.
  // Log it server-side only; the response body stays a constant string.
  console.warn(`[${new Date().toISOString()}] 404: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ success: false, error: 'Not found.' });
}

module.exports = { errorHandler, createError, notFound };
