// brandingService.js — whose letterhead goes on the document.
//
// This used to live inside documentService, which was fine while allocation
// letters were the only thing printed. Receipts need the same answer, and two
// copies of "which company name wins" is exactly how a receipt ends up branded
// differently from the letter that accompanies it.
//
// RESOLUTION ORDER, most specific first:
//   1. re_org_settings for this organization_id  (migrations/003)
//   2. the users row whose id IS the organization_id  (solo account)
//   3. the owner of the team whose id IS the organization_id  (team account)
//   4. nothing — a plain heading, because a letter with no logo beats a 500

const { supabaseAdmin } = require('../middleware/orgContext');

const PROFILE_COLUMNS =
  'full_name, company_name, brand_company_name, brand_logo_url, brand_address, brand_phone, brand_website';

// Normalized shape every template builder consumes, so neither of them has to
// know which of the three sources answered.
const shape = (source) => ({
  company_name: source.company_name || null,
  logo_url: source.logo_url || null,
  address: source.address || null,
  phone: source.phone || null,
  website: source.website || null,
  reply_to: source.reply_to || null,
});

async function resolveBranding(orgId) {
  // 1. Org settings — the only source keyed by organization_id, so it answers
  // the same way for a solo account and a team.
  const { data: settings } = await supabaseAdmin
    .from('re_org_settings')
    .select('company_name, logo_url, address, phone, website, reply_to_email')
    .eq('organization_id', orgId)
    .maybeSingle();

  if (settings && (settings.company_name || settings.logo_url || settings.address)) {
    return shape({ ...settings, reply_to: settings.reply_to_email });
  }

  // 2. Solo account: organization_id is the user's own id.
  const { data: soloUser } = await supabaseAdmin
    .from('users')
    .select(PROFILE_COLUMNS)
    .eq('id', orgId)
    .maybeSingle();

  if (soloUser) return fromProfile(soloUser);

  // 3. Team account: organization_id is a team id; the letterhead belongs to
  // its owner, but the TEAM's name wins over the owner's personal company.
  const { data: team } = await supabaseAdmin
    .from('teams')
    .select('name, owner_id')
    .eq('id', orgId)
    .maybeSingle();

  if (team?.owner_id) {
    const { data: owner } = await supabaseAdmin
      .from('users')
      .select(PROFILE_COLUMNS)
      .eq('id', team.owner_id)
      .maybeSingle();
    if (owner) {
      const branding = fromProfile(owner);
      return { ...branding, company_name: team.name || branding.company_name };
    }
  }

  return team ? shape({ company_name: team.name }) : shape({});
}

const fromProfile = (user) => shape({
  company_name: user.brand_company_name || user.company_name || user.full_name,
  logo_url: user.brand_logo_url,
  address: user.brand_address,
  phone: user.brand_phone,
  website: user.brand_website,
});

// Only https logos are embedded. A data: or file: URL inside a Puppeteer page
// is a way to pull local content into a customer-facing document.
const safeLogoUrl = (url) =>
  typeof url === 'string' && url.startsWith('https://') ? url : null;

// The line along the bottom of every generated document.
const contactLine = (branding) =>
  [branding.address, branding.phone, branding.website].filter(Boolean).join(' · ');

module.exports = { resolveBranding, safeLogoUrl, contactLine, PROFILE_COLUMNS };
