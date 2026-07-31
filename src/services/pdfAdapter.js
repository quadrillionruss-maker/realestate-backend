// pdfAdapter.js — HTML → PDF.
//
// The single place that knows a browser is involved. Everything else builds
// HTML strings and hands them here, so which Chromium runs, and how it is
// launched, is a one-file decision.
//
// ── TWO ENGINES, PICKED BY PLATFORM NOT BY NODE_ENV ────────────────────────
// Render's plan runs Linux and has no Chromium preinstalled; downloading the
// full `puppeteer` package there means ~300MB pulled into the build every
// deploy, sitting against a free/starter-tier disk and memory budget. So in
// production this uses `puppeteer-core` (no bundled browser, a few hundred KB)
// paired with `@sparticuz/chromium`, a Chromium build compiled specifically to
// run inside that kind of constrained Linux environment.
//
// That binary is Linux-only. It does not run on the Windows or macOS machine
// this is developed on, so local development keeps using full `puppeteer`,
// which downloads a browser for whatever OS `npm install` runs on. The
// decision is therefore made on **platform**, not on `NODE_ENV`: a Linux CI box
// running tests with NODE_ENV=test should still get the serverless engine
// treatment, and a developer should never have `@sparticuz/chromium` silently
// selected under them because someone set NODE_ENV=production locally.
//
// `PDF_ENGINE=core|full` overrides the auto-detection either way, for
// diagnosing a deploy without redeploying, or for forcing the full engine on a
// Linux dev box that has real puppeteer installed.
//
// `puppeteer` therefore lives in devDependencies (package.json) — the Render
// build (`npm ci --omit=dev`) never installs it, and never attempts the
// Chromium download that engine was going to throw away unused.

const env = require('../config/env');

// Container-only flags. `--single-process` and `--no-zygote` in particular
// exist to fit inside a memory-constrained Linux container (Render); on an
// ordinary Windows or macOS dev machine they do the opposite of help — this
// combination reliably crashed the renderer with "Protocol error
// (Page.printToPDF): Target closed" during testing, because a real desktop
// Chrome does not need to be told to skip its own sandbox and process model.
// So these are applied only where they were written for: a Linux host.
const CONTAINER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  // Containers give /dev/shm 64MB by default, which Chromium exhausts and
  // then crashes mid-render. This is the flag that makes PDFs work on Render.
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
];

function resolveEngine() {
  const forced = env.pdf.engine;
  if (forced === 'core' || forced === 'full') return forced;
  // @sparticuz/chromium ships a Linux binary; anywhere else it cannot launch,
  // so platform — not environment — is the deciding fact.
  return process.platform === 'linux' ? 'core' : 'full';
}

async function launchCoreBrowser() {
  let chromium;
  let puppeteerCore;
  try {
    chromium = require('@sparticuz/chromium');
    puppeteerCore = require('puppeteer-core');
  } catch {
    throw new Error(
      '@sparticuz/chromium and puppeteer-core are not installed. Run: npm install @sparticuz/chromium puppeteer-core'
    );
  }

  return puppeteerCore.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
}

async function launchFullBrowser() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    throw new Error(
      'puppeteer is not installed. Run: npm install puppeteer (development only — ' +
      'production renders through puppeteer-core + @sparticuz/chromium instead, see pdfAdapter.js)'
    );
  }
  // Only reached with this engine on non-Linux (a dev machine) or on Linux
  // via an explicit PDF_ENGINE=full override (say, testing real Chrome in a
  // Linux CI container) — apply the container flags in the second case only.
  const args = process.platform === 'linux' ? CONTAINER_ARGS : [];
  return puppeteer.launch({ headless: true, args });
}

async function renderHtmlToPdf(html) {
  const engine = resolveEngine();
  const browser = engine === 'core' ? await launchCoreBrowser() : await launchFullBrowser();

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    // Always close, or a failed render leaks a Chromium process per attempt
    // until the container runs out of memory.
    await browser.close();
  }
}

module.exports = { renderHtmlToPdf, resolveEngine, LAUNCH_ARGS: CONTAINER_ARGS };
