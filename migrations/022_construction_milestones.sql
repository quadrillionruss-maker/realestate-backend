-- ============================================================
-- Construction milestone tracking — SECTION 2.
--
-- Five fixed stages per project (Foundation, Superstructure, Roofing,
-- Finishing, Handover), each with a target date, an actual completion
-- date, a completion percentage, and up to ten progress photos. The
-- five rows for a project are provisioned lazily on first read by
-- src/services/constructionService.js — this migration only defines
-- the shape, so an existing project (created before this file ever
-- ran) gets its milestones the first time anyone asks for them,
-- with no backfill script required.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_construction_milestones (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null references re_projects(id) on delete cascade,
  name text not null check (name in ('Foundation','Superstructure','Roofing','Finishing','Handover')),
  target_date date,
  completed_date date,
  completion_percentage integer not null default 0 check (completion_percentage between 0 and 100),
  -- [{ path, url, uploaded_at }, ...] — the storage path is what
  -- src/services/documentStorage.js's uploadMedia() returns; the url is
  -- the same bucket's public URL, kept alongside so the portal and the
  -- Projects screen never have to re-derive it.
  photos jsonb not null default '[]'::jsonb,
  status text not null default 'pending' check (status in ('pending','in_progress','completed')),
  -- Set the moment the "reached this milestone" buyer notification is
  -- sent, so re-saving an already-completed milestone (fixing a typo in
  -- its date, say) never re-notifies every buyer in the project a
  -- second time. Null means "not yet sent".
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, name),
  constraint re_construction_milestones_photos_max10 check (jsonb_array_length(photos) <= 10)
);

create index if not exists idx_re_construction_milestones_project on re_construction_milestones(project_id);
create index if not exists idx_re_construction_milestones_org on re_construction_milestones(organization_id);

alter table re_construction_milestones enable row level security;
drop policy if exists "org members access re_construction_milestones" on re_construction_milestones;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_construction_milestones to service_role;
  revoke all on public.re_construction_milestones from anon, authenticated;
end $$;
