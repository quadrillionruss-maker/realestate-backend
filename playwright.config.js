// playwright.config.js — browser end-to-end smoke tests.
//
// Unlike src/test/ (offline: syntax/logic/schema, run by `npm test`, no
// network and no browser), these drive a real browser against a REAL running
// server — the one layer the offline suite structurally cannot reach, since
// server.js serves the API and frontend/ from the same process (see
// CLAUDE.md's "Entry point").
//
// Requires the server already running (`npm start`) against a real,
// migrated Supabase project — there is no in-process fake for Storage, email
// or a browser session the way schema.test.js fakes Postgres with PGlite.
// Registration needs no confirmation step (see CLAUDE.md's "Sign-up and
// sign-in"), so each spec seeds its own throwaway account via the API rather
// than depending on a pre-existing test user.
//
// Point E2E_BASE_URL at the server if it isn't on the default localhost:4000.
// Not wired into CI (.github/workflows/test.yml) yet — that workflow only
// runs the fully-offline suite, because these need real Supabase credentials
// CI does not have configured.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:4000',
    trace: 'retain-on-failure',
  },
});
