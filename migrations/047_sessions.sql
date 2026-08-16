-- ============================================================
-- Session visibility and management — SECTION 3.
--
-- One row per bearer token this server has ever seen used, keyed by
-- token_hash (sha256 of the raw JWT string — never the token itself, which
-- would make this table as sensitive as a password column). The row is
-- created lazily, on the FIRST authenticated request that token makes
-- (src/middleware/auth.js), not at issue time — issueToken() itself stays
-- synchronous and DB-free, used from a dozen call sites (register, login,
-- Google sign-in, 2FA, every password/email change that reissues one), and
-- none of them need to change for this to work.
--
-- revoked_at is what actually ends a session: middleware/auth.js checks it
-- on every request and 401s once set, even though the JWT signature itself
-- is still valid and not expired — the same "a valid signature is not a
-- live session" principle token_version already established, just scoped
-- to ONE token instead of every token a user holds.
--
-- device_info is a short "Browser on OS" string, parsed once from the
-- User-Agent header at creation and never re-parsed — a device does not
-- change mid-session. ip_address DOES update on every request (the same
-- request that bumps last_used_at), since a laptop moving between home and
-- office wifi is the actual case this column exists to make visible.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  organization_id uuid not null,
  token_hash text not null unique,
  device_info text,
  ip_address text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- The Sessions screen's own query: "every live session for this user".
create index if not exists idx_re_sessions_user
  on re_sessions(user_id, last_used_at desc);

alter table re_sessions enable row level security;
drop policy if exists "org members access re_sessions" on re_sessions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update on public.re_sessions to service_role;
  revoke all on public.re_sessions from anon, authenticated;
end $$;
