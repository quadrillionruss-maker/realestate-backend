// login.spec.js — the real sign-in FORM, in a real browser, against a live
// server. See playwright.config.js's header for what this needs to run.
const { test, expect } = require('@playwright/test');

function uniqueEmail(tag) {
  return `e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

// authService.MIN_PASSWORD_LENGTH is 12 — anything shorter 400s at register.
const PASSWORD = 'Correct-Horse-Battery-Staple-1';

async function registerAccount(request, baseURL, email) {
  const res = await request.post(`${baseURL}/api/auth/register`, {
    data: { email, password: PASSWORD, full_name: 'E2E Test', company_name: 'E2E Co' },
  });
  if (!res.ok()) {
    throw new Error(`register failed: ${res.status()} ${await res.text()}`);
  }
  return res.json();
}

test('a freshly registered account can sign in through the real form', async ({ page, request, baseURL }) => {
  const email = uniqueEmail('login');
  await registerAccount(request, baseURL, email);

  await page.goto('/');
  await expect(page.locator('#gate')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();

  await page.fill('#login-email', email);
  await page.fill('#login-password', PASSWORD);
  await page.click('#login-submit');

  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#gate')).toBeHidden();
});

test('the wrong password is rejected inline, not by leaving the sign-in page', async ({ page, request, baseURL }) => {
  const email = uniqueEmail('badpw');
  await registerAccount(request, baseURL, email);

  await page.goto('/');
  await page.fill('#login-email', email);
  await page.fill('#login-password', 'definitely-the-wrong-password');
  await page.click('#login-submit');

  await expect(page.locator('#login-error')).toBeVisible();
  await expect(page.locator('#login-error')).not.toBeEmpty();
  await expect(page.locator('#app')).toBeHidden();
});
