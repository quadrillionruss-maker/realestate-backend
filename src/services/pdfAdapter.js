// pdfAdapter.js — HTML → PDF.
//
// The single place that knows a browser is involved. Everything else builds
// HTML strings and hands them here, so swapping Puppeteer for a rendering
// service later is a one-file change.

const LAUNCH_ARGS = [
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

async function renderHtmlToPdf(html) {
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
    // Always close, or a failed render leaks a Chromium process per attempt
    // until the container runs out of memory.
    await browser.close();
  }
}

module.exports = { renderHtmlToPdf, LAUNCH_ARGS };
