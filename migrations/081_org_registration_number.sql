-- ============================================================
-- COMPANY REGISTRATION NUMBER ON THE LETTERHEAD
--
-- Prompted by a compliance review: allocation letters and receipts print
-- company_name/address/phone/website (all optional, all filled in under
-- Settings → Company) but had nowhere for a CAC registration number (an
-- "RC ..." for a limited company or "BN ..." for a business name) at all —
-- not a missing default, a genuinely absent field.
--
-- Free text rather than a separate "RC" vs "BN" type + number pair: a
-- workspace types whichever prefix actually applies to them ("RC 1234567",
-- "BN 7654321"), or leaves it blank if not yet CAC-registered. Optional,
-- same as address/phone/website — a workspace that leaves it blank sees
-- exactly the letterhead it always has.
-- ============================================================

alter table re_org_settings add column if not exists registration_number text;

-- Self-registers in the migrations ledger (migrations/082) so the Health
-- tab's "applied" status is a straight lookup, not a hand-maintained map.
insert into schema_migrations (filename) values ('081_org_registration_number.sql')
  on conflict (filename) do nothing;
