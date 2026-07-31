// errorHandler.js — the last middleware in the stack.
//
// Every route in this service ends with `catch (e) { next(e) }`, so this is
// where those land. Services attach `statusCode` to errors they raise
// deliberately (404 for a missing installment, 409 for one already paid);
// anything without one is an unexpected failure and becomes a 500.

const env = require('../config/env');

function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || err.status || 500;

  // Always log server-side with enough context to find it in Render's logs.
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${statusCode}: ${err.message}`);
  if (statusCode >= 500) console.error(err.stack);

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
  res.status(404).json({ success: false, error: `Route ${req.method} ${req.originalUrl} not found.` });
}

module.exports = { errorHandler, createError, notFound };
