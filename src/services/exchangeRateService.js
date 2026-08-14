// exchangeRateService.js — multi-currency PRICE DISPLAY, SECTION 10.
//
// Display only. NGN is the only currency this product ever actually
// transacts in — Paystack charges NGN, every re_payments.amount is NGN, every
// commission and receipt is computed in NGN. A rate moving between the
// moment a buyer looks at a screen and the moment they pay would make a
// dollar figure a promise this product cannot keep, so nothing here is ever
// read by paystackService, installmentService or any other money-moving code.
//
// ExchangeRate-API's free tier (api.exchangerate-api.com/v4/latest/NGN) needs
// no key for this pair and allows 1,500 requests/month — a 6-hour in-memory
// cache is what keeps this product's traffic nowhere near that ceiling: one
// process serving any number of buyers makes at most 4 calls a day, not one
// per page load.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const API_URL = 'https://api.exchangerate-api.com/v4/latest/NGN';
const FETCH_TIMEOUT_MS = 10_000;
// Everything the portal currency toggle offers (SECTION 10) — NGN is the
// base itself, not a converted rate.
const DISPLAY_CURRENCIES = ['USD', 'GBP', 'EUR', 'CAD'];

// Module-level, not per-request — the whole point is one shared cache
// across every buyer's portal session on this process, not one per caller.
let cache = null; // { rates, fetched_at }

async function fetchLatestRates() {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const response = await fetch(API_URL, { signal: controller ? controller.signal : undefined });
    if (!response.ok) throw new Error(`ExchangeRate-API returned ${response.status}`);
    const body = await response.json();
    if (!body?.rates) throw new Error('ExchangeRate-API response had no rates');
    return body.rates;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Returns { base: 'NGN', rates: { USD, GBP, EUR, CAD }, fetched_at }. Never
// throws: a rate that fails to fetch keeps serving the last good cache
// (even if stale past 6 hours) rather than breaking a buyer's portal page
// over a display-only feature; the very first call with no cache at all and
// a failed fetch returns null rates rather than 500ing the whole page.
async function getRates() {
  const now = Date.now();
  if (cache && now - cache.fetched_at < CACHE_TTL_MS) return toResponse(cache);

  try {
    const rates = await fetchLatestRates();
    cache = { rates, fetched_at: now };
  } catch (err) {
    console.warn('[exchange-rates] could not refresh:', err.message);
    if (!cache) return { base: 'NGN', rates: null, fetched_at: null, stale: false };
    // Serve the stale cache rather than nothing — an hour-old rate is still
    // a far better display estimate than no conversion at all.
  }

  return toResponse(cache);
}

function toResponse(entry) {
  const filtered = {};
  for (const code of DISPLAY_CURRENCIES) {
    if (entry.rates[code] != null) filtered[code] = entry.rates[code];
  }
  return {
    base: 'NGN',
    rates: filtered,
    fetched_at: new Date(entry.fetched_at).toISOString(),
    stale: Date.now() - entry.fetched_at >= CACHE_TTL_MS,
  };
}

// Test-only: lets the offline suite exercise getRates()'s caching/staleness
// logic without a real network call — the same "the module owns the cache
// entirely" shape means it needs a seam to inspect or reset from outside.
function _setCacheForTests(entry) { cache = entry; }

module.exports = { getRates, CACHE_TTL_MS, DISPLAY_CURRENCIES, _setCacheForTests };
