// onboarding.spec.js — the dashboard's "Get set up" checklist card
// (src/services/onboardingService.js, SECTION 23). src/test/logic.test.js
// already covers buildChecklist's pure decision logic offline; this is the
// one layer that actually renders the card and its step links, which is
// exactly where the two bugs fixed alongside this spec were hiding (a
// pending invite not counting toward "Invite a team member", and a progress
// bar CSS class missing its "onboarding-bar-" prefix on the admin side).
const { test, expect } = require('@playwright/test');

const PASSWORD = 'Correct-Horse-Battery-Staple-1';

test('a brand new solo workspace shows the onboarding card at 0/8, and its first step links to Projects', async ({ page, request, baseURL }) => {
  const email = `e2e-onboarding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

  // No company_name here, deliberately: routes/auth.js's register handler
  // upserts whatever company_name arrives straight into re_org_settings, and
  // onboardingService's branding_configured step reads that same column — a
  // company_name at registration would make this workspace start at 1/8,
  // not 0/8, before anything else in the test ever runs.
  const registerRes = await request.post(`${baseURL}/api/auth/register`, {
    data: { email, password: PASSWORD, full_name: 'E2E Owner' },
  });
  if (!registerRes.ok()) {
    throw new Error(`register failed: ${registerRes.status()} ${await registerRes.text()}`);
  }
  const { token } = await registerRes.json();

  // A solo account is always 'owner' (CLAUDE.md's "Org scoping") and
  // wantsOnboarding in screens.js gates the card to owner alone — so seeding
  // the session directly via the token realestate.js itself reads
  // ('archta.token', frontend/realestate.js) reaches the same dashboard the
  // real login form would, without re-testing the form itself (login.spec.js
  // already does that).
  await page.addInitScript((t) => {
    window.localStorage.setItem('archta.token', t);
  }, token);

  await page.goto('/#/dashboard');

  const card = page.locator('.onboarding-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('0/8');
  await expect(card).toContainText('Next: Create your first project');

  const firstStepLink = card.locator('a', { hasText: 'Create your first project' });
  await expect(firstStepLink).toHaveAttribute('href', '#/projects');

  await firstStepLink.click();
  await expect(page).toHaveURL(/#\/projects$/);
});
