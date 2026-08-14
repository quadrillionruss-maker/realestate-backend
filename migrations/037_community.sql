-- ============================================================
-- Buyer community forum — SECTION 13.
--
-- Scoped to a PROJECT, not the whole workspace — buyers in Lekki Gardens
-- have no reason to see chatter from Abuja Hills, and more importantly no
-- business seeing WHO bought there. content is public text only; nothing
-- here ever joins a buyer's payment history, credit score or reservation —
-- see routes/portal.js's own comment on why that boundary matters more
-- here than almost anywhere else in the product.
--
-- Every post and reply is authored by a customer_id — there is no staff
-- authorship column. Moderation (pin, delete) is a staff action on an
-- existing post, not a way for staff to post as themselves; see
-- routes/community.js for the reasoning.
--
-- Safe to re-run.
-- ============================================================

create table if not exists re_community_posts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid not null references re_projects(id) on delete cascade,
  customer_id uuid not null references re_customers(id) on delete cascade,
  content text not null check (length(trim(content)) > 0 and length(content) <= 500),
  pinned boolean not null default false,
  moderated boolean not null default false,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_re_community_posts_project on re_community_posts(project_id, pinned desc, created_at desc);
create index if not exists idx_re_community_posts_org on re_community_posts(organization_id);

create table if not exists re_community_replies (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references re_community_posts(id) on delete cascade,
  organization_id uuid not null,
  customer_id uuid not null references re_customers(id) on delete cascade,
  content text not null check (length(trim(content)) > 0 and length(content) <= 300),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_re_community_replies_post on re_community_replies(post_id, created_at);
create index if not exists idx_re_community_replies_org on re_community_replies(organization_id);

alter table re_community_posts enable row level security;
drop policy if exists "org members access re_community_posts" on re_community_posts;
alter table re_community_replies enable row level security;
drop policy if exists "org members access re_community_replies" on re_community_replies;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role absent — not a Supabase database, skipping grants';
    return;
  end if;

  grant select, insert, update, delete on public.re_community_posts to service_role;
  grant select, insert, update, delete on public.re_community_replies to service_role;
  revoke all on public.re_community_posts from anon, authenticated;
  revoke all on public.re_community_replies from anon, authenticated;
end $$;
