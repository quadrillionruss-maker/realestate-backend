-- ============================================================
-- Rich unit profiles — SECTION 6.
--
-- Floor plan and photo URLs already live in re_units.metadata (jsonb,
-- migrations/001) — see routes/units.js's own comment on why that stays
-- jsonb rather than columns (an open-ended, developer-chosen list). These
-- five are different: a fixed, known vocabulary every listing has, so they
-- are real columns the way unit_type and size_sqm already are, not one more
-- guess folded into metadata.
--
-- floor_level is nullable rather than defaulting to 0, because "ground
-- floor" and "not yet recorded" must not read as the same thing on a unit
-- nobody has entered this for yet.
--
-- Safe to re-run.
-- ============================================================

alter table re_units add column if not exists description text;
alter table re_units add column if not exists bedrooms integer;
alter table re_units add column if not exists bathrooms integer;
alter table re_units add column if not exists parking_spaces integer;
alter table re_units add column if not exists floor_level integer;
alter table re_units add column if not exists furnishing_status text not null default 'unfurnished';

alter table re_units drop constraint if exists re_units_furnishing_status_check;
alter table re_units add constraint re_units_furnishing_status_check
  check (furnishing_status in ('unfurnished','semi-furnished','fully-furnished'));

alter table re_units drop constraint if exists re_units_bedrooms_check;
alter table re_units add constraint re_units_bedrooms_check check (bedrooms is null or bedrooms >= 0);
alter table re_units drop constraint if exists re_units_bathrooms_check;
alter table re_units add constraint re_units_bathrooms_check check (bathrooms is null or bathrooms >= 0);
alter table re_units drop constraint if exists re_units_parking_spaces_check;
alter table re_units add constraint re_units_parking_spaces_check check (parking_spaces is null or parking_spaces >= 0);
