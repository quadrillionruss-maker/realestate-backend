// pdfAdapter.js — HTML → PDF, without caring who owns the browser.
//
// When this module is grafted into FlowDesk (src/re/), it uses FlowDesk's
// existing Puppeteer service, so there is one browser configuration, one set
// of Railway-tuned launch flags, and one place to fix Chromium problems.
// When the module is checked out on its own, it launches its own browser with
// the same flags so the code path stays testable in isolation.

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
];

let hostRenderer;

// Resolved once, lazily: the require path only exists inside FlowDesk.
function resolveHostRenderer() {
  if (hostRenderer !== undefined) return hostRenderer;
  try {
    const host = require('../../services/pdf.service');
    hostRenderer = typeof host.renderHtmlToPdf === 'function' ? host.renderHtmlToPdf : null;
  } catch {
    hostRenderer = null; // standalone checkout — expected
  }
  return hostRenderer;
}

async function renderLocally(html) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    throw new Error('puppeteer is not installed. Run: npm install puppeteer');
  }

  const browser = await puppeteer.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    await browser.close();
  }
}

async function renderHtmlToPdf(html) {
  const host = resolveHostRenderer();
  return host ? host(html) : renderLocally(html);
}

module.exports = { renderHtmlToPdf, LAUNCH_ARGS };
