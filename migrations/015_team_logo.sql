-- ============================================================
-- TEAM LOGO
--
-- Uploaded in Settings, stored in the public-assets bucket at
-- logos/{team_id}/{filename}, and the resulting public URL is kept
-- here. Team-scoped rather than organization-scoped like
-- re_org_settings.logo_url: a solo workspace has no teams row, so
-- this feature is only reachable once a workspace has become a team.
-- ============================================================

alter table teams add column if not exists logo_url text;
