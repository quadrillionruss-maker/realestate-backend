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

async function renderOnePage(browser, html) {
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    await page.close().catch(() => {});
  }
}

// AUDIT FIX (P4) — `pool` is optional and this default (single-shot) path is
// unchanged: launch a browser, render one PDF, close the browser. Correct
// and simple for every call site that renders exactly one document — every
// caller except routes/documents.js's own bulk-generate endpoint.
async function renderHtmlToPdf(html, { pool } = {}) {
  if (pool) return pool.render(html);

  const engine = resolveEngine();
  const browser = engine === 'core' ? await launchCoreBrowser() : await launchFullBrowser();

  try {
    return await renderOnePage(browser, html);
  } finally {
    // Always close, or a failed render leaks a Chromium process per attempt
    // until the container runs out of memory.
    await browser.close();
  }
}

// AUDIT FIX (P4) — a pool of ONE reused Chromium process for a whole batch
// of renders, instead of the plain renderHtmlToPdf() path's one process per
// document. routes/documents.js's /bulk-generate used to be sequential for
// exactly this reason (its own comment said so): launching a fresh browser
// PROCESS per document and running several of those at once risked the host
// running out of memory. A PAGE inside an already-running browser is cheap
// by comparison — what actually needed bounding was how many pages render
// at once against that one shared process, which is what POOL_CONCURRENCY
// does here, in the pool itself, regardless of how many callers call
// render() concurrently or whether the caller's own loop is bounded too.
//
// Scoped to the caller's own lifetime (typically one HTTP request generating
// several documents) rather than a module-level singleton kept alive
// indefinitely: createPdfPool()/close() are the caller's to pair, same as
// launch()/browser.close() always were for the single-shot path above.
const POOL_CONCURRENCY = 3;

class PdfPool {
  constructor() {
    this._browserPromise = null;
    this._active = 0;
    this._queue = [];
  }

  async _getBrowser() {
    if (!this._browserPromise) {
      const engine = resolveEngine();
      this._browserPromise = (engine === 'core' ? launchCoreBrowser() : launchFullBrowser())
        .catch((err) => { this._browserPromise = null; throw err; });
    }
    return this._browserPromise;
  }

  async _acquire() {
    if (this._active < POOL_CONCURRENCY) { this._active += 1; return; }
    await new Promise((resolve) => this._queue.push(resolve));
    this._active += 1;
  }

  _release() {
    this._active -= 1;
    const next = this._queue.shift();
    if (next) next();
  }

  async render(html) {
    await this._acquire();
    try {
      const browser = await this._getBrowser();
      return await renderOnePage(browser, html);
    } finally {
      this._release();
    }
  }

  // Closes the one underlying browser process this pool ever launched.
  // Never launched at all if render() was never called — an empty batch
  // opens no browser. Safe to call more than once.
  async close() {
    if (!this._browserPromise) return;
    const browser = await this._browserPromise.catch(() => null);
    this._browserPromise = null;
    if (browser) await browser.close().catch(() => {});
  }
}

function createPdfPool() {
  return new PdfPool();
}

module.exports = { renderHtmlToPdf, createPdfPool, resolveEngine, LAUNCH_ARGS: CONTAINER_ARGS };
