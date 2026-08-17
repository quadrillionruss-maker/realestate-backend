// clientErrorService.js — the write side lives behind an authenticated
// operator-app route (routes/index.js's /client-errors); the read/triage
// side is the platform admin dashboard only (routes/admin.js).
//
// Truncated defensively here rather than rejected by a DB check constraint
// (migrations/054 has none on these columns) — this is telemetry generated
// by code, not a form a human fills in, so there is no useful "please
// shorten your stack trace" UX to send back. A report that's merely long
// should still be recorded, just capped.

const { supabaseRaw } = require('../middleware/orgContext');

const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
const MAX_SHORT = 500;

const trunc = (value, max) => (value == null ? null : String(value).slice(0, max));

async function report({ orgId, userId, app, message, stack, screen, url, userAgent }) {
  const { error } = await supabaseRaw.from('re_client_errors').insert({
    organization_id: orgId || null,
    user_id: userId || null,
    app: ['operator', 'admin', 'portal'].includes(app) ? app : 'operator',
    message: trunc(message, MAX_MESSAGE) || '(no message)',
    stack: trunc(stack, MAX_STACK),
    screen: trunc(screen, MAX_SHORT),
    url: trunc(url, MAX_SHORT),
    user_agent: trunc(userAgent, MAX_SHORT),
  });
  if (error) throw error;
}

// Last 30 days, raw rows — the admin dashboard groups these by
// (app, screen, message) itself for display, same as adminService.featureUsage
// aggregates client-side rather than pre-computing a second shape server-side.
async function list() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await supabaseRaw
    .from('re_client_errors')
    .select('id, organization_id, user_id, app, message, stack, screen, url, user_agent, created_at, resolved_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const orgIds = [...new Set((rows || []).map((r) => r.organization_id).filter(Boolean))];
  const userIds = [...new Set((rows || []).map((r) => r.user_id).filter(Boolean))];
  const [{ data: teams }, { data: users }] = await Promise.all([
    orgIds.length ? supabaseRaw.from('teams').select('id, name').in('id', orgIds) : Promise.resolve({ data: [] }),
    userIds.length ? supabaseRaw.from('users').select('id, full_name, email').in('id', userIds) : Promise.resolve({ data: [] }),
  ]);
  const teamById = new Map((teams || []).map((t) => [t.id, t.name]));
  const userById = new Map((users || []).map((u) => [u.id, u.full_name || u.email]));

  return (rows || []).map((r) => ({
    ...r,
    org_name: r.organization_id ? (teamById.get(r.organization_id) || userById.get(r.organization_id) || r.organization_id) : null,
    user_name: r.user_id ? (userById.get(r.user_id) || r.user_id) : null,
  }));
}

async function resolve(ids) {
  const { error } = await supabaseRaw
    .from('re_client_errors')
    .update({ resolved_at: new Date().toISOString() })
    .in('id', ids)
    .is('resolved_at', null);
  if (error) throw error;
}

module.exports = { report, list, resolve };
