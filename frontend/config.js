/* config.js — where the browser app looks for its API.
 *
 * ── THE BUG THIS FILE EXISTS TO FIX ──────────────────────────────────────
 * realestate.js reads `window.__API_BASE__ || 'http://localhost:4000/api'`.
 * Nothing ever set that global, so every deployed copy of this app called
 * http://localhost:4000 — i.e. the laptop of whoever had the page open. It
 * worked for exactly one person, on one machine, with the server running,
 * and failed instantly for everybody else with "Could not reach the API".
 *
 * ── WHY A FILE AND NOT AN INLINE <script> ────────────────────────────────
 * The API can serve this app itself (server.js, express.static), and it
 * sends a Content-Security-Policy without 'unsafe-inline'. An inline script
 * block in index.html would be silently blocked there and the page would
 * break in precisely the confusing way this file is meant to prevent.
 *
 * ── CHANGING IT ──────────────────────────────────────────────────────────
 * Edit PRODUCTION_API below. Nothing else in the app hardcodes a host.
 * Localhost keeps pointing at a local server so `npm start` still works
 * without editing anything.
 *
 * Two OTHER files hardcode a deployment host too, independently, because
 * there is no build step shared across these three deploy targets. Moving
 * either the API or the frontend to a new domain means updating all three,
 * by hand, or something breaks silently (a blocked fetch reads as "the app
 * is broken" with nothing useful in the Network tab):
 *   1. PRODUCTION_API here — which API host the browser calls
 *   2. server.js's PRODUCTION_ORIGINS — which frontend origin the API's CORS
 *      config accepts (the reverse direction of this file)
 *   3. vercel.json's Content-Security-Policy connect-src, in this same
 *      folder — which hosts the browser is even allowed to call. JSON has no
 *      comment syntax, which is why this note lives here instead of there.
 */
(function () {
  'use strict';

  var PRODUCTION_API = 'https://realestate-backend-e55w.onrender.com/api';
  var LOCAL_API = 'http://localhost:4000/api';

  var host = window.location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '' || host === '[::1]';

  // Served by the API itself (same origin): use a relative path, so the app
  // works on any host and port without this file knowing which.
  var sameOrigin = window.location.port === '4000' || Boolean(window.__SAME_ORIGIN_API__);

  window.__API_BASE__ = sameOrigin ? '/api' : (isLocal ? LOCAL_API : PRODUCTION_API);
})();
