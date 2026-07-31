-- ============================================================
-- PER-ACCOUNT LOGIN LOCKOUT
--
-- /api/auth/login was rate-limited only per source IP (20 attempts
-- per 15 minutes, server.js/routes/auth.js). That stops one
-- machine hammering the endpoint but does nothing against a
-- distributed attacker rotating IPs at one known email address —
-- exactly the shape of attack a per-IP limiter cannot see.
--
-- These two columns back a second, independent lock keyed on the
-- ACCOUNT rather than the request: five wrong passwords in a row
-- locks that address out for fifteen minutes, regardless of how
-- many different IPs the attempts came from. authService.login()
-- reads and writes both; a successful login clears them.
-- ============================================================

alter table users add column if not exists failed_login_count integer not null default 0;

alter table users add column if not exists locked_until timestamptz;
