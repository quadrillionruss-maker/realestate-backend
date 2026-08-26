/* realestate.js — Archta core: session, API, router, shell, UI primitives.
 *
 * Plain script, no bundler and no framework. The page is static HTML served
 * as-is, which means there is no build step between editing this file and
 * seeing the change — a property worth more than any component model on a
 * product one person maintains.
 *
 * Loaded BEFORE screens.js. This file defines window.RE and boots on
 * DOMContentLoaded; screens.js registers into RE.screens while the document
 * is still parsing, so every screen exists by the time the router runs.
 *
 * ── ON STORING THE TOKEN ─────────────────────────────────────────────────
 * The previous version kept the bearer token in a closure variable and
 * nowhere else, so a refresh signed you out. That was the right call when
 * the token was a long-lived secret pasted in by hand from a terminal: there
 * was no way to get another one without going back to the terminal, so
 * keeping it off disk was pure upside.
 *
 * It is the wrong call now. The token is issued by a login form, it expires,
 * and a person who is signed out by pressing F5 will not use the product.
 * So it goes in localStorage, and the tradeoff is stated rather than hidden:
 * any script running on this origin can read it. The defences are that this
 * page loads no third-party JavaScript except Google's sign-in widget, the
 * server sends a Content-Security-Policy with no 'unsafe-inline', and every
 * value rendered into the DOM goes through esc().
 */
(function () {
  'use strict';

  var API_BASE = window.__API_BASE__ || 'http://localhost:4000/api';
  var TOKEN_KEY = 'archta.token';
  var WORKSPACE_KEY = 'archta.workspace';

  // ── Session ───────────────────────────────────────────────────────────
  var token = null;
  try { token = window.localStorage.getItem(TOKEN_KEY); } catch (e) { token = null; }

  function setToken(value) {
    token = value || null;
    try {
      if (value) window.localStorage.setItem(TOKEN_KEY, value);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* private browsing: the session lasts this tab, which is fine */ }
  }

  // Which of a person's workspaces this browser is currently in — sent as
  // X-Workspace-Id on every request (see request() below). The JWT itself
  // carries no org scope (src/middleware/auth.js), so this is the only place
  // "which workspace" lives on the client, same reasoning as the token
  // itself: kept per-tab-durable in localStorage, validated fresh against
  // live membership by the server on every request, never trusted blindly.
  var workspaceId = null;
  try { workspaceId = window.localStorage.getItem(WORKSPACE_KEY); } catch (e) { workspaceId = null; }

  function setWorkspace(value) {
    workspaceId = value || null;
    try {
      if (value) window.localStorage.setItem(WORKSPACE_KEY, value);
      else window.localStorage.removeItem(WORKSPACE_KEY);
    } catch (e) { /* private browsing: the session lasts this tab, which is fine */ }
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Sign goes before the symbol — "-₦5,000", not "₦-5,000", which reads as a
  // rendering glitch rather than a negative amount.
  function naira(amount) {
    var n = Number(amount || 0);
    return (n < 0 ? '-' : '') + '₦' + Math.abs(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });
  }

  // Compact money for tiles, where ₦1,240,000,000 wraps and ₦1.24b does not.
  //
  // The cutover is 1,000, not 10,000. At 10,000 a KPI row could show "₦9,999"
  // beside "₦10k" — the same magnitude formatted two different ways, which
  // reads as a rendering bug. Below ₦1,000 there is nothing to abbreviate.
  function nairaShort(amount) {
    var n = Number(amount || 0);
    var sign = n < 0 ? '-' : '';
    var abs = Math.abs(n);
    if (abs >= 1e9) return sign + '₦' + trimZeros((abs / 1e9).toFixed(2)) + 'b';
    if (abs >= 1e6) return sign + '₦' + trimZeros((abs / 1e6).toFixed(1)) + 'm';
    if (abs >= 1e3) return sign + '₦' + trimZeros((abs / 1e3).toFixed(1)) + 'k';
    return naira(n);
  }

  var trimZeros = function (s) { return s.replace(/\.0+$/, ''); };

  function plural(count, word) { return count + ' ' + word + (count === 1 ? '' : 's'); }

  // Dates are formatted with an EXPLICIT field spec and the locale is only a
  // hint. 'en-NG' is not implemented identically everywhere — some Android
  // WebViews fall back to US ordering and render "Jul 28, 2026" — and a due
  // date that reads differently on the MD's laptop and the rep's phone is a
  // dispute waiting to happen. Two-digit day so a column of dates aligns.
  var DATE_FMT = { day: '2-digit', month: 'short', year: 'numeric' };
  var TIME_FMT = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false };

  function fmtDate(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-GB', DATE_FMT);
  }

  function fmtDateTime(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-GB', TIME_FMT);
  }

  // Today at 07:14 / Yesterday at 07:02 / 26 Jul at 07:00.
  // The brief runs at 7am; at 8pm the only thing worth knowing about it is
  // whether it is this morning's, and a bare date does not answer that.
  function fmtRelative(value) {
    if (!value) return '';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '';

    var time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    var days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);

    if (days === 0) return 'Today at ' + time;
    if (days === 1) return 'Yesterday at ' + time;
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' at ' + time;
  }

  var startOfDay = function (d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

  // ── Phone numbers ─────────────────────────────────────────────────────
  // wa.me requires the full international number with no punctuation and NO
  // leading zero. Buyers' numbers are stored exactly as somebody typed them:
  // 08031234567, +234 803 123 4567, 234-803-123-4567, 803 123 4567.
  //
  // The old code just stripped non-digits, so a locally-formatted number
  // produced wa.me/08031234567 — WhatsApp opens and says "phone number is
  // incorrect". The at-risk list is the most-used screen in the product and
  // its WhatsApp links were failing for most numbers in most databases.
  function waNumber(phone) {
    var digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;

    // "00" is the international dialing prefix used in place of "+" —
    // 00234803… means the same number as +234803…. Left unstripped, this fell
    // into the "leading 0 = local trunk prefix" branch below and mangled it
    // into a 14-digit non-number instead of dropping the link entirely.
    if (digits.indexOf('00') === 0 && digits.length > 2) digits = digits.slice(2);

    var normalized;
    if (digits.indexOf('234') === 0) normalized = digits;
    else if (digits.charAt(0) === '0') normalized = '234' + digits.slice(1);
    else if (digits.length === 10) normalized = '234' + digits; // local form, zero dropped
    else normalized = digits;                                   // already international

    // wa.me needs exactly 234 + 10 digits. A landline, a typo, a partial paste
    // or a non-Nigerian number all produce something the wrong length here —
    // rendering no link at all beats one that opens WhatsApp and then says
    // "the phone number is incorrect".
    return normalized.length === 13 ? normalized : null;
  }

  // web.whatsapp.com/send, not wa.me — wa.me hands off to the WhatsApp
  // desktop app when one is installed, and on a machine that has never
  // linked that app to a phone it answers "phone number shared via url is
  // invalid" even for a genuinely valid number. Routing through WhatsApp Web
  // in the browser instead sidesteps the desktop app entirely.
  function waLink(phone) {
    var number = waNumber(phone);
    return number ? 'https://web.whatsapp.com/send?phone=' + number : null;
  }

  // ── Touch detection ──────────────────────────────────────────────────
  function isTouchDevice() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

  // Downloads go through a real anchor click, not window.open. Popup blockers
  // on Chrome Android and Safari iOS are on by default and silently drop
  // window.open when the call is even one await away from the user's tap —
  // which every one of ours is, because the signed URL has to be fetched
  // first. A buyer tapping "Download" would simply see nothing happen.
  // Export endpoints sit behind the bearer token, so a plain <a href> would
  // arrive unauthenticated and download a 401. Fetch it, then hand the bytes to
  // the same anchor-click path.
  async function downloadCsv(path, filename) {
    var res = await fetch(API_BASE + '/re' + path, {
      headers: { Authorization: 'Bearer ' + token },
    });

    if (!res.ok) {
      var body = await res.json().catch(function () { return {}; });
      throw new Error(body.error || 'Export failed (' + res.status + ')');
    }

    var blob = await res.blob();
    var url = URL.createObjectURL(blob);
    openFile(url, filename);
    // Revoked on a delay: revoking immediately can cancel the download in
    // Safari, which reads the blob after the click returns.
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  function openFile(url, filename) {
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    if (filename) a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function todayISO() { return new Date().toISOString().slice(0, 10); }

  function el(id) { return document.getElementById(id); }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // A computed bar/meter width (or chart bar height) used to be baked
  // straight into the generated markup as style="width:37%" — the one thing
  // a CSS class cannot express, since the number comes from the data. A
  // strict Content-Security-Policy with no 'unsafe-inline' in style-src
  // blocks every such attribute silently; it does NOT block setting an
  // individual CSSOM property from JS after the element already exists, so
  // that's the only place a computed size can still live. Screens render
  // `data-w`/`data-h` (a plain percentage number, no unit) instead of an
  // inline style; call this once against the container right after that
  // markup lands in the DOM.
  function applyDynamicStyles(root) {
    qsa('[data-w]', root).forEach(function (n) { n.style.width = n.dataset.w + '%'; });
    qsa('[data-h]', root).forEach(function (n) { n.style.height = n.dataset.h + '%'; });
  }

  function badge(value) {
    if (!value) return '';
    return '<span class="badge ' + esc(value) + '">' + esc(String(value).replace(/_/g, ' ')) + '</span>';
  }

  function initials(name, email) {
    var source = (name || email || '?').trim();
    var parts = source.split(/[\s@.]+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[1][0] : '')).toUpperCase();
  }

  // ── API ───────────────────────────────────────────────────────────────
  // Errors carry `status` so a caller can tell "your session ended" from
  // "the server is down" from "that unit is already reserved".
  async function request(fullPath, options) {
    var opts = options || {};
    var headers = { Accept: 'application/json' };
    if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    if (workspaceId) headers['X-Workspace-Id'] = workspaceId;

    var res;
    try {
      res = await fetch(API_BASE + fullPath, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body,
      });
    } catch (networkError) {
      throw Object.assign(
        new Error('Could not reach the server. Check your connection and try again.'),
        { status: 0 }
      );
    }

    if (res.status === 401 && !opts.noAuthRedirect) {
      // Never navigate on a 401 — this page IS the sign-in screen, so
      // redirecting to it is an infinite reload. Fall back to the gate in place.
      var expired = Object.assign(new Error('Your session has ended. Sign in again.'), { status: 401 });
      if (RE.state.user) signOut('Your session has ended. Sign in again.');
      throw expired;
    }

    var body = null;
    var text = await res.text().catch(function () { return ''; });
    if (text) { try { body = JSON.parse(text); } catch (e) { body = null; } }

    if (!res.ok) {
      throw Object.assign(
        new Error((body && body.error) || 'Request failed (' + res.status + ')'),
        { status: res.status, body: body }
      );
    }
    return body;
  }

  var api = function (path, options) { return request('/re' + path, options); };
  var authApi = function (path, options) { return request('/auth' + path, options); };

  // Sugar, because `api('/customers', { method: 'POST', body: JSON.stringify(x) })`
  // appears about forty times across the screens.
  api.post = function (path, data) { return api(path, { method: 'POST', body: JSON.stringify(data || {}) }); };
  api.patch = function (path, data) { return api(path, { method: 'PATCH', body: JSON.stringify(data || {}) }); };
  api.put = function (path, data) { return api(path, { method: 'PUT', body: JSON.stringify(data || {}) }); };
  authApi.post = function (path, data) {
    return authApi(path, { method: 'POST', body: JSON.stringify(data || {}), noAuthRedirect: true });
  };

  // ── Global error capture ─────────────────────────────────────────────
  // renderFailure (further down, in the router) only ever sees an error
  // that broke a SCREEN'S OWN render — a throw from a click handler, a
  // timer callback, or a promise with no .catch anywhere in its chain never
  // passes through router.render()'s try/catch at all, so a bug shaped
  // exactly like the WhatsApp queue banner one (migrations/054's own
  // comment on it: a var referenced before its own assignment left
  // RE.whatsappQueue undefined) could keep throwing on every render and
  // never once reach the admin dashboard's Errors tab. These two listeners
  // are the backstop — whatever else on this page throws or rejects
  // uncaught is reported the same way, through the same /client-errors
  // route, whether or not it also visibly broke a screen.
  //
  // Fire-and-forget and self-contained: an error reporter that itself threw
  // would just recurse through the very 'error' listener it is registered
  // on, so the whole body is wrapped rather than trusting any one line.
  function reportClientError(message, stack) {
    try {
      if (!RE.state.user) return; // no session to attach the report to yet
      api.post('/client-errors', {
        message: String(message || '(no message)'),
        stack: stack || null,
        screen: window.location.hash || null,
        url: window.location.href,
        user_agent: navigator.userAgent,
        timestamp: new Date().toISOString(),
      }).catch(function () { /* nothing to do if even the report fails */ });
    } catch (e) { /* the reporter must never itself throw */ }
  }

  // stub logic.test.js requires this file against has no addEventListener —
  // same reasoning as the WhatsApp queue's own 'focus' listener further down.
  try {
    window.addEventListener('error', function (event) {
      reportClientError(
        event.error ? event.error.message : event.message,
        event.error ? event.error.stack : null
      );
    });

    window.addEventListener('unhandledrejection', function (event) {
      var reason = event.reason;
      reportClientError(
        reason instanceof Error ? reason.message : String(reason),
        reason instanceof Error ? reason.stack : null
      );
    });
  } catch (e) { /* no-op outside a real browser */ }

  // ── Toast ─────────────────────────────────────────────────────────────
  function toast(message, kind) {
    var host = el('toasts');
    var node = document.createElement('div');
    node.className = 'toast ' + (kind || '');
    node.innerHTML = '<span>' + esc(message) + '</span><button class="toast-close" aria-label="Dismiss">×</button>';
    host.appendChild(node);

    var remove = function () { if (node.parentNode) node.parentNode.removeChild(node); };
    node.querySelector('.toast-close').addEventListener('click', remove);
    // Errors linger: they usually need reading twice.
    setTimeout(remove, kind === 'err' ? 7000 : 3800);
  }

  // ── Modal ─────────────────────────────────────────────────────────────
  // Returns the modal element. `onSubmit` receives the <form>; throwing from
  // it leaves the modal open with the message shown, which is what you want
  // when the server rejects a value.
  // The submit button lives in the footer, outside the <form>, so it needs
  // form="<id>" to submit it — which means the id has to be unique. It used to
  // be the literal string "modal-form" on every modal, so two open at once
  // would give the footer button of the second modal a reference that resolved
  // to the first modal's form. Nothing in the UI opens two today; this makes
  // that a design choice rather than a landmine.
  var modalSeq = 0;

  // Keeps Tab cycling inside an open modal/drawer instead of escaping to the
  // page underneath — a screen reader or keyboard-only user tabbing past the
  // last field in a payment-record dialog should not land back on the sidebar.
  function focusableIn(container) {
    return qsa('a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', container)
      .filter(function (elx) { return elx.offsetParent !== null; });
  }
  function trapTab(container, e) {
    if (e.key !== 'Tab') return;
    var focusable = focusableIn(container);
    if (!focusable.length) return;
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function modal(options) {
    var opts = options || {};
    var overlay = el('overlay');
    var formId = 'modal-form-' + (++modalSeq);

    var scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML =
      '<div class="modal ' + (opts.wide ? 'wide' : '') + '" role="dialog" aria-modal="true">' +
        '<div class="modal-head">' +
          '<div class="modal-title">' + esc(opts.title || '') + '</div>' +
          '<div class="spacer"></div>' +
          '<button class="icon-btn" data-close aria-label="Close">×</button>' +
        '</div>' +
        '<form class="modal-body" id="' + formId + '">' + (opts.body || '') + '</form>' +
        '<div class="modal-foot">' +
          '<button class="btn" type="button" data-close>' + esc(opts.cancelLabel || 'Cancel') + '</button>' +
          (opts.submitLabel
            ? '<button class="btn primary" type="submit" form="' + formId + '">' + esc(opts.submitLabel) + '</button>'
            : '') +
        '</div>' +
      '</div>';

    overlay.appendChild(scrim);
    applyDynamicStyles(scrim);

    var form = scrim.querySelector('form');
    var submit = scrim.querySelector('[type="submit"]');

    function close() {
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      document.removeEventListener('keydown', onKey);
    }

    function onKey(e) { if (e.key === 'Escape') close(); else trapTab(scrim.querySelector('.modal'), e); }
    document.addEventListener('keydown', onKey);

    qsa('[data-close]', scrim).forEach(function (b) { b.addEventListener('click', close); });
    // Clicking the backdrop closes; clicking inside the dialog must not.
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (!opts.onSubmit) return close();

      // A second Enter keypress re-dispatches submit while the first call is
      // still mid-await — pointer-events:none on the button only stops a
      // second click, not this. Without the guard, a rep double-tapping Enter
      // while recording a payment can fire the request twice.
      if (form.dataset.submitting === 'true') return;
      form.dataset.submitting = 'true';

      var error = qs('.modal-error', form);
      if (error) error.remove();
      if (submit) { submit.classList.add('is-working'); submit.disabled = true; }

      try {
        await opts.onSubmit(form, close);
      } catch (err) {
        var notice = document.createElement('p');
        notice.className = 'notice modal-error';
        notice.style.marginTop = '14px';
        notice.textContent = err.message;
        form.appendChild(notice);
      } finally {
        delete form.dataset.submitting;
        if (submit) { submit.classList.remove('is-working'); submit.disabled = false; }
      }
    });

    // Focus the first real input, so a keyboard user can start typing.
    var first = form.querySelector('input:not([type=hidden]), select, textarea');
    if (first) setTimeout(function () { first.focus(); }, 40);

    return { close: close, form: form, root: scrim, formId: formId };
  }

  function confirmDialog(options) {
    return new Promise(function (resolve) {
      var m = modal({
        title: options.title,
        body: '<p class="muted lh-loose">' + esc(options.message) + '</p>',
        submitLabel: options.confirmLabel || 'Confirm',
        onSubmit: function (form, close) { close(); resolve(true); },
      });
      qsa('[data-close]', m.root).forEach(function (b) {
        b.addEventListener('click', function () { resolve(false); });
      });
      if (options.danger) {
        var submit = m.root.querySelector('[type="submit"]');
        if (submit) { submit.classList.remove('primary'); submit.classList.add('danger'); }
      }
    });
  }

  // ── Drawer ────────────────────────────────────────────────────────────
  function drawer(options) {
    var overlay = el('overlay');

    var scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.style.display = 'block';
    scrim.style.padding = '0';

    var panel = document.createElement('aside');
    panel.className = 'drawer';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.innerHTML =
      '<div class="drawer-head">' +
        '<div class="drawer-head-text">' +
          '<div class="eyebrow">' + esc(options.eyebrow || '') + '</div>' +
          '<div class="page-title">' + esc(options.title || '') + '</div>' +
          (options.sub ? '<div class="page-sub">' + esc(options.sub) + '</div>' : '') +
        '</div>' +
        '<button class="icon-btn" data-close aria-label="Close">×</button>' +
      '</div>' +
      '<div class="drawer-body">' + (options.body || '<div class="skeleton"></div>') + '</div>';

    scrim.appendChild(panel);
    overlay.appendChild(scrim);
    applyDynamicStyles(panel);

    function close() {
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); else trapTab(panel, e); }

    document.addEventListener('keydown', onKey);
    qsa('[data-close]', panel).forEach(function (b) { b.addEventListener('click', close); });
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });

    var firstFocusable = panel.querySelector('[data-close]');
    if (firstFocusable) setTimeout(function () { firstFocusable.focus(); }, 40);

    return { close: close, body: panel.querySelector('.drawer-body'), root: panel };
  }

  // ── Form value reading ────────────────────────────────────────────────
  // One helper, because "" and 0 and false all mean different things and
  // getting that wrong sends nulls to NOT NULL columns.
  function values(form) {
    var out = {};
    qsa('[name]', form).forEach(function (field) {
      if (field.type === 'checkbox') out[field.name] = field.checked;
      else if (field.type === 'number') out[field.name] = field.value === '' ? null : Number(field.value);
      else out[field.name] = field.value.trim();
    });
    return out;
  }

  // ── Rendering helpers ─────────────────────────────────────────────────
  // Inline SVG rather than an external file or icon font — one line each,
  // 24x24 viewBox, stroke="currentColor" so .empty-icon's own `color:
  // var(--text-faint)` is the only place a color is ever set. Geometric and
  // deliberately plain: this is a blank state, not a place for the brand's
  // one gold accent to show up.
  var EMPTY_ICONS = {
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.6 2.6L16 9.3"/>',
    checkmark: '<path d="M5 13l4.5 4.5L19 7"/>',
    person: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
    building: '<rect x="5" y="3" width="14" height="18"/><path d="M9 7.5h1M14 7.5h1M9 11h1M14 11h1M9 14.5h1M14 14.5h1"/><path d="M10 21v-4h4v4"/>',
    document: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M9.5 12h5M9.5 15.5h5"/>',
    receipt: '<path d="M6 3h12v18l-2-1.3L14 21l-2-1.3L10 21l-2-1.3L6 21z"/><path d="M9 8h6M9 11.5h6M9 15h4"/>',
    key: '<circle cx="8" cy="8" r="4"/><path d="M10.8 10.8L20 20M15.5 15.5l2-2M18.5 18.5l2-2"/>',
    chart: '<path d="M4 20V13M10 20V7M16 20v-9"/><path d="M2 20h20"/>',
  };

  function emptyState(title, hint, actionHtml, icon) {
    var svg = EMPTY_ICONS[icon];
    return '<div class="empty">' +
      (svg
        ? '<svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
            'stroke-linecap="round" stroke-linejoin="round">' + svg + '</svg>'
        : '<span class="empty-icon empty-icon-glyph">◇</span>') +
      '<strong>' + esc(title) + '</strong>' +
      (hint ? '<div>' + esc(hint) + '</div>' : '') +
      (actionHtml ? '<div class="mt-2">' + actionHtml + '</div>' : '') +
    '</div>';
  }

  function skeleton(rows) {
    var out = '<div class="card-body">';
    for (var i = 0; i < (rows || 4); i++) {
      out += '<div class="skeleton" data-w="' + (94 - i * 9) + '"></div>';
    }
    return out + '</div>';
  }

  // Shaped like the dashboard it stands in for — a 4-tile KPI grid and a
  // brief card, not the generic single-card skeleton() every other screen
  // gets — so the very first paint doesn't jump when the real layout lands.
  function dashboardSkeleton() {
    var tile =
      '<div class="stat">' +
        '<div class="skeleton" data-w="55"></div>' +
        '<div class="skeleton skeleton-lg mt-1" data-w="70"></div>' +
        '<div class="skeleton" data-w="40"></div>' +
      '</div>';
    var tiles = '';
    for (var i = 0; i < 4; i++) tiles += tile;
    return '<div class="grid cols-4">' + tiles + '</div>' +
      '<div class="brief mt-2">' +
        '<div class="skeleton" data-w="25"></div>' +
        '<div class="skeleton mt-1" data-w="96"></div>' +
        '<div class="skeleton" data-w="88"></div>' +
        '<div class="skeleton" data-w="52"></div>' +
      '</div>';
  }

  function table(columns, rows, rowFn, options) {
    var opts = options || {};
    if (!rows.length) return emptyState(opts.emptyTitle || 'Nothing here yet', opts.emptyHint, opts.emptyAction, opts.emptyIcon);

    return '<div class="table-wrap"><table class="data"><thead><tr>' +
      columns.map(function (c) {
        var cls = [c.num ? 'num' : '', c.hideMobile ? 'hide-mobile' : ''].filter(Boolean).join(' ');
        // SECTION 4 — c.raw opts a header out of escaping, for the one case
        // a column label needs to BE markup (a select-all checkbox) rather
        // than describe text. Off by default — every existing caller passes
        // a plain string label and keeps getting it escaped exactly as before.
        return '<th' + (cls ? ' class="' + cls + '"' : '') + '>' + (c.raw ? c.label : esc(c.label)) + '</th>';
      }).join('') +
      '</tr></thead><tbody>' +
      rows.map(rowFn).join('') +
      '</tbody></table></div>';
  }

  // navigator.clipboard needs a secure context; on plain http (a phone on the
  // office wifi hitting a dev server) it is undefined, so fall back.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('copy rejected'));
      } catch (err) { reject(err); } finally { document.body.removeChild(area); }
    });
  }

  // ── Call popup ────────────────────────────────────────────────────────
  // Every "Call" control in the app is a plain <a href="tel:…">. On a phone
  // that link is the whole feature — tapping it opens the dialer, which is
  // exactly what a tel: link is for. On a desktop there is usually no dialer
  // to open, so the same click instead drops a small popup with the number
  // and a Copy button, positioned under the link that was clicked. One
  // delegated listener handles every current and future "Call" link in the
  // app — nothing at the call site has to opt in.
  var openCallPopup = null;

  function closeCallPopup() {
    if (!openCallPopup) return;
    if (openCallPopup.parentNode) openCallPopup.parentNode.removeChild(openCallPopup);
    openCallPopup = null;
  }

  // SECTION 17 — customerId/customerName are undefined for a tel: link
  // rendered with no buyer context (there are none left after screens.js's
  // own SECTION 17 pass added data-customer-id everywhere a Call link
  // already knows who it's calling, but this stays optional rather than
  // required so a future tel: link that forgets the attribute just skips
  // outcome-logging instead of throwing).
  function showCallPopup(anchor, phone, customerId, customerName) {
    closeCallPopup();

    var normalized = waNumber(phone);
    var copyValue = normalized ? '+' + normalized : phone;

    var pop = document.createElement('div');
    pop.className = 'call-popup';
    pop.setAttribute('role', 'dialog');
    pop.innerHTML =
      '<div class="call-popup-number">' + esc(phone) + '</div>' +
      '<button class="btn-quiet" type="button" data-call-copy>Copy</button>';

    document.body.appendChild(pop);

    var rect = anchor.getBoundingClientRect();
    var top = rect.bottom + window.scrollY + 6;
    var left = rect.left + window.scrollX;
    // Keep it on-screen for a link sitting near the right edge — the popup
    // itself is narrow enough that flipping to a right-anchor covers it.
    var maxLeft = window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 8;
    if (left > maxLeft) left = Math.max(window.scrollX + 8, maxLeft);
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';

    pop.querySelector('[data-call-copy]').addEventListener('click', function () {
      copyText(copyValue).then(function () {
        toast('Copied', 'ok');
        // SECTION 17 — "after copying the number show a Log this call
        // button that opens the same outcome modal immediately." Appended
        // rather than replacing the popup outright, so Copy still reads as
        // having worked before the next action appears.
        if (customerId && !pop.querySelector('[data-call-log]')) {
          var logBtn = document.createElement('button');
          logBtn.className = 'btn-quiet';
          logBtn.type = 'button';
          logBtn.setAttribute('data-call-log', '');
          logBtn.textContent = 'Log this call';
          logBtn.addEventListener('click', function () {
            closeCallPopup();
            openCallOutcomeModal(customerId, customerName, { askReached: false });
          });
          pop.appendChild(logBtn);
        }
      }, function () {
        toast('Could not copy — try selecting the number instead.', 'err');
      });
    });

    openCallPopup = pop;
  }

  // SECTION 17 — a call just placed from a touch device (the dialer took
  // over; there was no popup to attach a "Log this call" button to). Set
  // right before the dialer opens; read back once this window regains
  // focus/visibility, per pendingCallReturned below.
  var pendingCallCustomer = null;

  // One document-level listener, exactly like wireSearch()'s outside-click
  // handling below — installed once in boot(), covers every screen.
  function wireCallLinks() {
    document.addEventListener('click', function (e) {
      var link = e.target.closest('a[href^="tel:"]');
      if (link) {
        var phone = link.getAttribute('href').replace(/^tel:/, '');
        var customerId = link.dataset.customerId || null;
        var customerName = link.dataset.customerName || '';

        if (isTouchDevice()) {
          // Unchanged: let the dialer open. Only difference is remembering
          // who this call was to, for pendingCallReturned to ask about once
          // the user comes back to this tab.
          if (customerId) pendingCallCustomer = { id: customerId, name: customerName };
          return;
        }

        e.preventDefault();
        // Clicking the already-open popup's own trigger again closes it,
        // rather than closing and instantly reopening in the same spot.
        if (openCallPopup && openCallPopup.dataset.forLink === phone && document.body.contains(openCallPopup)) {
          closeCallPopup();
          return;
        }
        showCallPopup(link, phone, customerId, customerName);
        if (openCallPopup) openCallPopup.dataset.forLink = phone;
        return;
      }
      if (openCallPopup && !e.target.closest('.call-popup')) closeCallPopup();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeCallPopup();
    });

    // SECTION 17 — "after returning to the app (focus/visibility change
    // event after 5 seconds)". Both events are wired (a phone switching
    // apps fires visibilitychange reliably; focus is the desktop/tablet
    // fallback) but pendingCallReturned's own dedupe means only the first
    // one to fire after a given call actually shows the prompt.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') pendingCallReturned();
    });
    window.addEventListener('focus', pendingCallReturned);
  }

  var pendingCallPromptTimer = null;

  function pendingCallReturned() {
    if (!pendingCallCustomer || pendingCallPromptTimer) return;
    var call = pendingCallCustomer;
    pendingCallPromptTimer = setTimeout(function () {
      pendingCallPromptTimer = null;
      // Cleared before opening, not after: if the rep is still on this
      // prompt when a SECOND call happens to complete, that should open its
      // own fresh prompt rather than being silently absorbed into this one.
      pendingCallCustomer = null;
      openCallOutcomeModal(call.id, call.name, { askReached: true });
    }, 5000);
  }

  // SECTION 17 — deliberately NOT the same five values as
  // re_activities.outcome's own enum (interested/not_interested/
  // promised_payment/no_answer/follow_up_needed — routes/customers.js's
  // ACTIVITY_OUTCOMES): those describe a CONVERSATION's outcome, these
  // describe whether the CALL CONNECTED at all, a different and finer-
  // grained question a rep still answers before ever getting to "were they
  // interested". Rather than widen a database CHECK constraint for a
  // frontend-only feature, this folds straight into the activity's notes
  // text (logCallActivity below) — 're_activities.notes' already accepts
  // free text, and "Call outcome: Voicemail" reads perfectly well in the
  // Activity timeline exactly as logged.
  var CALL_OUTCOMES = [
    ['answered', 'Answered'], ['no_answer', 'No answer'], ['voicemail', 'Voicemail'],
    ['busy', 'Busy'], ['wrong_number', 'Wrong number'],
  ];

  async function logCallActivity(customerId, outcomeLabel, notes) {
    var composed = 'Call outcome: ' + outcomeLabel + (notes ? ' — ' + notes : '');
    // SECTION 14 — same offline-safe path logActivityModal (screens.js) already
    // uses: a rep on a site visit with no signal is exactly the case this exists for.
    var result = await RE.offlineQueue.submitOrQueue('log_activity', '/customers/' + customerId + '/activities', {
      activity_type: 'call',
      notes: composed,
    });
    toast(result.queued ? 'No connection — call logged and will sync automatically.' : 'Call logged.', 'ok');
  }

  function callOutcomeStepHtml() {
    return '<p class="page-sub mb-2">How did it go?</p>' +
      '<div class="btn-row wrap mb-2">' +
        CALL_OUTCOMES.map(function (o) {
          return '<button class="btn-quiet" type="button" data-call-outcome="' + o[0] + '">' + esc(o[1]) + '</button>';
        }).join('') +
      '</div>' +
      '<div class="field"><label for="call-outcome-notes">Notes (optional)</label>' +
        '<textarea class="textarea" id="call-outcome-notes" rows="2"></textarea></div>';
  }

  // askReached: true for the mobile flow (tel: link fired the dialer; ask
  // "did you reach them" first) — false for the desktop popup's "Log this
  // call" button, which already implies yes, skip straight to the outcome
  // step. Both paths end at the same five-button outcome step and the same
  // logCallActivity call.
  function openCallOutcomeModal(customerId, customerName, opts) {
    var askReached = Boolean(opts && opts.askReached);

    var m = modal({
      title: askReached ? 'Did you reach ' + (customerName || 'them') + '?' : 'Log this call',
      cancelLabel: askReached ? 'Not yet' : 'Cancel',
      body: askReached
        ? '<p class="page-sub">Quick note on how the call with ' + esc(customerName || 'this buyer') + ' went.</p>' +
          '<div class="btn-row mt-2"><button class="btn primary" type="button" data-call-reached>Reached — log it</button></div>'
        : callOutcomeStepHtml(),
      onSubmit: function () {}, // every action here is its own button — see openAccountModal's identical reasoning
    });

    function wireOutcomeButtons() {
      qsa('[data-call-outcome]', m.form).forEach(function (button) {
        button.addEventListener('click', async function () {
          var notesField = qs('#call-outcome-notes', m.form);
          await logCallActivity(customerId, button.textContent, notesField ? notesField.value.trim() : '');
          m.close();
        });
      });
    }

    if (askReached) {
      qs('[data-call-reached]', m.form).addEventListener('click', function () {
        m.form.innerHTML = callOutcomeStepHtml();
        wireOutcomeButtons();
      });
    } else {
      wireOutcomeButtons();
    }
  }

  // Wires a button that does async work: spinner while it runs, toast on
  // failure, never leaves the button stuck disabled.
  function onClick(root, selector, handler) {
    qsa(selector, root).forEach(function (node) {
      node.addEventListener('click', async function (event) {
        if (node.disabled) return;
        node.disabled = true;
        node.classList.add('is-working');
        try {
          await handler(node, event);
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          node.disabled = false;
          node.classList.remove('is-working');
        }
      });
    });
  }

  // ── Router ────────────────────────────────────────────────────────────
  // Hash routing: no server rewrite rules, so the app is a static file that
  // can be dropped on any host — which is exactly how it is deployed.
  var currentScreen = null;

  function parseHash() {
    var raw = (window.location.hash || '#/dashboard').replace(/^#\/?/, '');
    var query = {};
    var parts = raw.split('?');
    if (parts[1]) {
      parts[1].split('&').forEach(function (pair) {
        var kv = pair.split('=');
        query[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
      });
    }
    var segments = parts[0].split('/').filter(Boolean);
    return { name: segments[0] || 'dashboard', params: segments.slice(1), query: query };
  }

  async function renderRoute() {
    if (!RE.state.user) return;

    var route = parseHash();
    var screen = RE.screens[route.name];

    // Identifies "the same screen with the same arguments". Tabs and filters
    // live in the query string, so #/payments?tab=due and #/payments?tab=history
    // are different screens and each should start at the top; calling reload()
    // on either is a re-render and should not move.
    var signature = route.name + '|' + route.params.join('/') + '|' +
      Object.keys(route.query).sort().map(function (k) { return k + '=' + route.query[k]; }).join('&');

    if (!screen) {
      el('view').innerHTML =
        '<div class="page-head"><div><div class="page-title">Not found</div>' +
        '<div class="page-sub">No screen at #/' + esc(route.name) + '</div></div></div>' +
        '<div class="card">' + emptyState('Nothing lives here', 'Pick something from the sidebar.') + '</div>';
      return;
    }

    // ── Scroll and skeleton, only when the screen actually changes ─────────
    // Re-rendering in place — marking a task done, recording a payment, the
    // reload() after any mutation — used to blank the view to a skeleton and
    // throw the page back to the top. On the payments screen that means
    // clicking "Record" on row 40 and being returned to row 1, which is
    // unusable for the one job that screen exists to do.
    //
    // A route CHANGE is a new screen and deserves both. A re-render of the
    // route you are already on gets neither: the old content stays put while
    // the new data loads, and the scroll position is restored afterwards.
    var isSameScreen = currentScreen === signature;
    var keptScroll = window.scrollY;

    currentScreen = signature;
    qsa('[data-nav]').forEach(function (link) {
      link.classList.toggle('is-active', link.dataset.nav === route.name);
    });

    var view = el('view');

    if (!isSameScreen) {
      view.className = 'page screen-enter';
      view.innerHTML = route.name === 'dashboard'
        ? dashboardSkeleton()
        : '<div class="card">' + skeleton(5) + '</div>';
      applyDynamicStyles(view);
      window.scrollTo(0, 0);
    } else {
      // No screen-enter animation on a re-render either — the content
      // flickering and sliding up every time you tick a checkbox reads as a
      // page reload rather than an update.
      view.className = 'page';
    }

    try {
      await screen.render(view, route.params, route.query);
      applyDynamicStyles(view);
      if (isSameScreen) {
        // After the DOM is replaced the document may briefly be shorter than it
        // was, which clamps the scroll. Restore on the next frame, once layout
        // has settled.
        window.requestAnimationFrame(function () { window.scrollTo(0, keptScroll); });
      }
    } catch (err) {
      if (err.status === 401) return; // signOut already handled it
      renderFailure(view, err, route.name);
    }

    // Closing the mobile sidebar on navigation: leaving it open over the
    // screen you just asked for is the classic mobile-nav bug.
    el('sidebar').classList.remove('is-open');
    var scrim = qs('.sidebar-scrim');
    if (scrim) scrim.remove();
  }

  // A failed screen has to offer a way forward. On a Nigerian mobile network
  // one of three parallel requests timing out is routine, and the old handler
  // said "Something went wrong" next to a full page reload — which on a slow
  // connection costs the fonts, the CSS and every request again, to retry one.
  //
  // Retry re-runs the screen only. Reload is still there for when that is not
  // enough. A status of 0 means the request never left the device, so the
  // wording says so rather than blaming the server.
  // Three genuinely different failures, told apart by whether request()
  // (realestate.js's own fetch wrapper, above) ever threw this at all.
  // request() attaches a numeric .status to EVERY error it throws — 0 for
  // "never reached the server", the real HTTP code otherwise — so an error
  // with no .status at all never went near the network. It is a bug in this
  // screen's own render code (a null the code didn't check, a typo'd
  // function name, a variable used before it was assigned — exactly what
  // broke the WhatsApp queue banner once already), and saying "the server
  // answered with an error" about it sends whoever reads it hunting through
  // the wrong half of the codebase.
  function renderFailure(view, err, screenName) {
    var offline = err.status === 0 || !navigator.onLine;
    var isServerError = !offline && typeof err.status === 'number' && err.status > 0;
    var isClientBug = !offline && !isServerError;

    // Console-only, not shown on screen: the full stack is exactly what
    // fixing a client bug needs and exactly what a Naira figure in a toast
    // does not need to expose. Every failed screen load gets one, so this is
    // the first place to look, not just this one recurring case.
    console.error('[archta] screen failed to render:', err);

    // Only a genuine client bug is reported — a server error is already
    // visible server-side (Render's logs, this workspace's own audit trail),
    // and reporting one here would just be a second, noisier copy of the
    // same fact. Fire-and-forget: a broken screen reporting itself must
    // never itself throw, and there is nothing useful to show if the report
    // fails to send. Skipped when signed out entirely — no org to attach it
    // to, and the sign-in screen has its own error handling already.
    if (isClientBug && RE.state.user) {
      api.post('/client-errors', {
        message: err.message,
        stack: err.stack,
        screen: screenName || null,
        url: window.location.hash,
        user_agent: navigator.userAgent,
      }).catch(function () { /* nothing to do if even the report fails */ });
    }

    var title = offline ? 'No connection' : isClientBug ? 'Something went wrong showing this screen' : 'Could not load this screen';
    var sub = offline
      ? 'Your device could not reach the server. Nothing was lost — try again when you have signal.'
      : isClientBug
        ? 'This is a bug in the app itself, not something the server reported. Retrying will not fix it, but reporting it will.'
        : 'The server answered with an error.';

    view.innerHTML =
      '<div class="page-head"><div>' +
        '<div class="page-title">' + esc(title) + '</div>' +
        '<div class="page-sub">' + esc(sub) + '</div>' +
      '</div></div>' +
      '<div class="notice' + (offline ? ' info' : '') + '">' + esc(err.message) + '</div>' +
      '<div class="btn-row">' +
        '<button class="btn primary" id="btn-retry">Try again</button>' +
        '<button class="btn" id="btn-hard-reload">Reload the app</button>' +
      '</div>';

    onClick(view, '#btn-retry', async function () {
      // Force a full re-render rather than the in-place path: there is nothing
      // on screen worth preserving.
      currentScreen = null;
      await renderRoute();
    });

    qsa('#btn-hard-reload', view).forEach(function (b) {
      b.addEventListener('click', function () { window.location.reload(); });
    });
  }

  function go(hash) {
    if (window.location.hash === hash) renderRoute();
    else window.location.hash = hash;
  }

  function reload() { return renderRoute(); }

  // ── Sidebar counts ────────────────────────────────────────────────────
  // Kept current so the nav is a status display and not just a menu.
  async function refreshCounts() {
    try {
      var results = await Promise.all([
        api('/dashboard/at-risk'),
        api('/tasks?status=open'),
      ]);
      setCount('count-risk', results[0].length);
      setCount('count-tasks', results[1].length);
      // Mobile bottom nav's own badges. The elements exist in the DOM at
      // every width (index.html) — only #bottom-nav's CSS visibility is
      // breakpoint-gated — so updating them unconditionally here is
      // harmless on desktop/tablet, not a wasted DOM write on a missing node.
      setCount('bottom-count-risk', results[0].length);
      setCount('bottom-count-tasks', results[1].length);
    } catch (e) { /* the nav is decoration here; never let it break a screen */ }
  }

  function setCount(id, n) {
    var node = el(id);
    if (!node) return;
    node.textContent = n;
    node.classList.toggle('hidden', !n);
  }

  // ── Global search ─────────────────────────────────────────────────────
  function wireSearch() {
    var input = el('search-input');
    var panel = el('search-results');
    var timer = null;

    function hide() { panel.classList.add('hidden'); panel.innerHTML = ''; }

    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2) return hide();
      // Debounced: a rep types a surname at speed and each keystroke would
      // otherwise be a round trip.
      timer = setTimeout(function () { runSearch(q); }, 220);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { input.blur(); hide(); }
      if (e.key === 'Enter') {
        var first = panel.querySelector('.search-hit');
        if (first) first.click();
      }
    });

    document.addEventListener('click', function (e) {
      if (!e.target.closest('.search')) hide();
    });

    // "/" focuses search from anywhere, unless you are already typing.
    //
    // Three exclusions, all of them things a user does every day: typing into
    // any field (a password like "Pa$$w0rd/2024" contains a slash), typing into
    // a rich-text region, and having a modal or drawer open — stealing focus
    // out of the "record a payment" form to open search would lose whatever
    // had been entered.
    document.addEventListener('keydown', function (e) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;

      var target = e.target || {};
      var tag = (target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (target.isContentEditable) return;
      if (el('overlay').children.length) return;

      e.preventDefault();
      input.focus();
      input.select();
    });

    async function runSearch(q) {
      try {
        var found = await api('/search?q=' + encodeURIComponent(q));
        var html = '';

        if (found.customers.length) {
          html += '<div class="search-section">Buyers</div>' + found.customers.map(function (c) {
            return '<button class="search-hit" data-go="#/customers/' + esc(c.id) + '">' +
              '<span>' + esc(c.full_name) + '</span>' +
              '<span class="hit-meta">' + esc(c.phone || c.email || '') + '</span></button>';
          }).join('');
        }

        if (found.units.length) {
          html += '<div class="search-section">Units</div>' + found.units.map(function (u) {
            return '<button class="search-hit" data-go="#/units?q=' + encodeURIComponent(u.unit_number) + '">' +
              '<span>Unit ' + esc(u.unit_number) + '</span>' +
              '<span class="hit-meta">' + esc((u.re_projects && u.re_projects.name) || '') + ' · ' + esc(u.status) + '</span></button>';
          }).join('');
        }

        if (found.projects.length) {
          html += '<div class="search-section">Projects</div>' + found.projects.map(function (p) {
            return '<button class="search-hit" data-go="#/units?project=' + esc(p.id) + '">' +
              '<span>' + esc(p.name) + '</span>' +
              '<span class="hit-meta">' + esc(p.location || '') + '</span></button>';
          }).join('');
        }

        if (found.reservations.length) {
          html += '<div class="search-section">Reservations</div>' + found.reservations.map(function (r) {
            var unit = r.re_units || {};
            return '<button class="search-hit" data-go="#/reservations">' +
              '<span>' + esc(r.re_customers.full_name) + '</span>' +
              '<span class="hit-meta">' + esc(unit.unit_number ? 'Unit ' + unit.unit_number : '') + ' · ' + esc(r.status) + '</span></button>';
          }).join('');
        }

        panel.innerHTML = html || '<div class="empty">Nothing matched “' + esc(q) + '”.</div>';
        panel.classList.remove('hidden');

        qsa('[data-go]', panel).forEach(function (hit) {
          hit.addEventListener('click', function () {
            go(hit.dataset.go);
            hide();
            input.value = '';
          });
        });
      } catch (err) {
        panel.innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
        panel.classList.remove('hidden');
      }
    }
  }

  // ── Gate ──────────────────────────────────────────────────────────────
  var gateForms = ['form-login', 'form-register', 'form-forgot', 'form-reset', 'form-2fa'];

  function showGateForm(id) {
    gateForms.forEach(function (formId) { el(formId).hidden = formId !== id; });
    el('gate-tabs').hidden = (id !== 'form-login' && id !== 'form-register');
    el('tab-login').setAttribute('aria-selected', String(id === 'form-login'));
    el('tab-register').setAttribute('aria-selected', String(id === 'form-register'));

    var focus = qs('#' + id + ' input');
    if (focus) setTimeout(function () { focus.focus(); }, 30);
  }

  function gateError(id, message) {
    var node = el(id);
    node.textContent = message || '';
    node.classList.toggle('hidden', !message);
  }

  function wireGate() {
    el('tab-login').addEventListener('click', function () { showGateForm('form-login'); });
    el('tab-register').addEventListener('click', function () { showGateForm('form-register'); });
    el('link-to-register').addEventListener('click', function () { showGateForm('form-register'); });
    el('link-to-login').addEventListener('click', function () { showGateForm('form-login'); });
    el('link-forgot').addEventListener('click', function () { showGateForm('form-forgot'); });
    el('link-back-login').addEventListener('click', function () { showGateForm('form-login'); });
    el('link-reset-cancel').addEventListener('click', function () {
      window.location.hash = '';
      showGateForm('form-login');
    });

    // A double-tap on "Sign in" — a slow network, a keyboard user's stray
    // second Enter — used to fire the request twice; is-working was only ever
    // a spinner class, never a guard. disabled is the guard now.
    el('form-login').addEventListener('submit', async function (e) {
      e.preventDefault();
      var button = el('login-submit');
      if (button.disabled) return;
      gateError('login-error', '');
      button.disabled = true;
      button.classList.add('is-working');

      try {
        var result = await authApi.post('/login', {
          email: el('login-email').value.trim(),
          password: el('login-password').value,
        });

        // SECTION 2 — an owner with 2FA on gets a short-lived partial_token
        // instead of a real session; the form-2fa screen exchanges it for
        // one after a correct code (POST /auth/login/2fa). Nothing is
        // stored yet — pendingTwoFactorToken lives only in this tab, only
        // until that exchange succeeds or the user cancels back to sign-in.
        if (result.requires_2fa) {
          pendingTwoFactorToken = result.partial_token;
          el('login-password').value = '';
          showGateForm('form-2fa');
          return;
        }

        setToken(result.token);
        el('login-password').value = '';

        // Signing in to accept a workspace invite — set by consumeInviteLink
        // when the link named an address that already has an account.
        // Registering with an invited address already joins server-side
        // (POST /register), so this is the one path that still needs it.
        if (pendingInviteToken) {
          try {
            var accepted = await authApi.post('/invite/accept', { token: pendingInviteToken });
            setWorkspace(accepted.team_id);
            window.location.hash = '#/dashboard';
          } catch (err) {
            toast(err.message, 'err');
          }
          pendingInviteToken = null;
        }

        await enterApp();
      } catch (err) {
        gateError('login-error', err.message);
      } finally {
        button.disabled = false;
        button.classList.remove('is-working');
      }
    });

    // Password visibility toggle — the two SVGs already in index.html swap
    // via .hidden, and the input's own type flips between password/text.
    // No inline handler on the button itself, so nothing here trips the
    // CSP config.js's own header already explains.
    el('toggle-login-password').addEventListener('click', function () {
      var input = el('login-password');
      var showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      qsa('.gate-eye-icon', el('toggle-login-password')).forEach(function (svg) {
        svg.classList.toggle('hidden');
      });
      el('toggle-login-password').setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    });

    // SECTION 2 — second step of login. pendingInviteToken (above) is still
    // honoured here too: an invited address with 2FA on has to clear BOTH
    // steps before the invite is claimed.
    el('form-2fa').addEventListener('submit', async function (e) {
      e.preventDefault();
      var button = el('tfa-login-submit');
      if (button.disabled) return;
      gateError('tfa-login-error', '');
      button.disabled = true;
      button.classList.add('is-working');

      try {
        var result = await authApi.post('/login/2fa', {
          partial_token: pendingTwoFactorToken,
          code: el('tfa-login-code').value.trim(),
        });
        setToken(result.token);
        el('tfa-login-code').value = '';
        pendingTwoFactorToken = null;

        if (pendingInviteToken) {
          try {
            var accepted = await authApi.post('/invite/accept', { token: pendingInviteToken });
            setWorkspace(accepted.team_id);
            window.location.hash = '#/dashboard';
          } catch (err) {
            toast(err.message, 'err');
          }
          pendingInviteToken = null;
        }

        await enterApp();
      } catch (err) {
        gateError('tfa-login-error', err.message);
      } finally {
        button.disabled = false;
        button.classList.remove('is-working');
      }
    });

    el('link-2fa-cancel').addEventListener('click', function () {
      pendingTwoFactorToken = null;
      gateError('tfa-login-error', '');
      showGateForm('form-login');
    });

    el('form-register').addEventListener('submit', async function (e) {
      e.preventDefault();
      var button = el('reg-submit');
      if (button.disabled) return;
      gateError('reg-error', '');
      button.disabled = true;
      button.classList.add('is-working');

      try {
        var result = await authApi.post('/register', {
          full_name: el('reg-name').value.trim(),
          company_name: el('reg-company').value.trim(),
          email: el('reg-email').value.trim(),
          password: el('reg-password').value,
        });
        setToken(result.token);
        el('reg-password').value = '';
        // No verification step — registration signs them straight in.
        await enterApp();
        toast('Welcome to Archta.', 'ok');
        go('#/dashboard');
      } catch (err) {
        gateError('reg-error', err.message);
      } finally {
        button.disabled = false;
        button.classList.remove('is-working');
      }
    });

    el('form-reset').addEventListener('submit', async function (e) {
      e.preventDefault();
      var button = el('reset-submit');
      if (button.disabled) return;
      gateError('reset-error', '');
      button.disabled = true;
      button.classList.add('is-working');

      try {
        // authService builds "#/reset?token=…", so [?&] is the live format.
        // [#&] is accepted too because the buyer portal uses "#token=…" and a
        // link pasted from the wrong place is otherwise indistinguishable from
        // a valid one: the regex would miss, `token` would be undefined, and
        // the server would answer "reset link expired" — sending someone to
        // request a new link that will fail in exactly the same way.
        var resetToken = (/[?&#]token=([^&]+)/.exec(window.location.hash) || [])[1];
        if (!resetToken) {
          throw Object.assign(
            new Error('This reset link is incomplete. Open the most recent link from your email, or request a new one.'),
            { status: 400 }
          );
        }

        var result = await authApi.post('/reset-password', {
          token: decodeURIComponent(resetToken),
          password: el('reset-password').value,
        });
        setToken(result.token);
        window.location.hash = '#/dashboard';
        await enterApp();
        toast('Password updated.', 'ok');
      } catch (err) {
        gateError('reset-error', err.message);
      } finally {
        button.disabled = false;
        button.classList.remove('is-working');
      }
    });

    // Item 25 of the drawing-reference redesign — no inline <script> (same
    // CSP reasoning config.js's own header explains), and a class lookup
    // rather than el()/getElementById since .gate-footer-year is a class,
    // not an id. Named yearEl rather than el deliberately: el is this
    // file's own document.getElementById helper, already in scope for the
    // rest of this function — shadowing it with a local var (even one
    // holding an unrelated querySelector result) would hoist over every
    // other el('...') call in wireGate, not just the lines after it.
    var yearEl = document.querySelector('.gate-footer-year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();
  }

  // Google Identity Services. Loaded only if the server reports a client id,
  // so a deployment without Google configured pulls no third-party script
  // at all rather than rendering a button that cannot work.
  function mountGoogle(clientId) {
    if (!clientId) return;

    window.__archtaGoogle = async function (response) {
      try {
        var result = await authApi.post('/google', { credential: response.credential });
        setToken(result.token);
        await enterApp();
      } catch (err) {
        gateError('login-error', err.message);
      }
    };

    var script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = function () {
      if (!window.google || !window.google.accounts) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: window.__archtaGoogle,
      });
      // Google only accepts a pixel width, not a percentage. 340 hardcoded
      // overflowed the card on a 320px screen, so measure the slot instead and
      // clamp to the range the widget accepts (200–400).
      var slot = el('google-slot');
      var available = Math.round(slot.getBoundingClientRect().width) || 340;

      window.google.accounts.id.renderButton(slot, {
        theme: 'filled_black',
        size: 'large',
        width: Math.max(200, Math.min(400, available)),
        text: 'continue_with',
        shape: 'rectangular',
      });
      el('alt-login').hidden = false;
    };
    // A blocked or failed CDN must not take the password form down with it.
    script.onerror = function () { console.warn('[archta] Google sign-in script did not load'); };
    document.head.appendChild(script);
  }

  // ── Role ──────────────────────────────────────────────────────────────
  // /auth/me returns `permissions` — the same list src/services/permissions.js
  // computes server-side (actionsFor) — so the browser draws the same model
  // the API enforces rather than keeping a second copy of the rules by hand.
  // This is presentation only: every one of these actions is re-checked on
  // the server regardless of what the browser shows or hides.
  function can(action) {
    var perms = RE.state.user && RE.state.user.permissions;
    return Array.isArray(perms) && perms.indexOf(action) !== -1;
  }

  // Which top-level nav items each role sees, straight out of the product
  // spec's own "X sees / No: Y" lists. This is deliberately NOT derived
  // purely from `can()` — e.g. a Sales Executive's own tasks already surface
  // on their Dashboard, so the standalone Tasks screen stays off their nav
  // even though GET /tasks itself is open to every role. Absent from this
  // map (owner, sales_director, and no role at all — a solo account) means
  // "everything", since neither role has a restricted list in the spec.
  var NAV_BY_ROLE = {
    sales_rep: ['dashboard', 'customers', 'reservations', 'payments', 'commissions', 'projects', 'units'],
    collections: ['dashboard', 'at-risk', 'payments', 'customers', 'tasks'],
    documentation: ['dashboard', 'documents', 'customers', 'reservations'],
  };

  function applyNavForRole(role) {
    var visible = NAV_BY_ROLE[role] || null; // null = everything
    qsa('[data-nav]').forEach(function (link) {
      var show = !visible || visible.indexOf(link.dataset.nav) !== -1;
      link.classList.toggle('hidden', !show);
    });
    // A nav-group whose every item just hid should not leave its label
    // floating above an empty space.
    qsa('.nav-group').forEach(function (group) {
      var anyVisible = qsa('[data-nav]', group).some(function (link) {
        return !link.classList.contains('hidden');
      });
      group.classList.toggle('hidden', !anyVisible);
    });
  }

  // The sidebar switcher — only drawn once there is something to switch
  // between. Reloads the whole app into the new workspace's context rather
  // than trying to patch the current screen's state in place: role, org id
  // and every permission the sidebar itself depends on all change at once.
  function renderWorkspaceSwitcher(me) {
    var container = el('workspace-switcher');
    if (!container) return;

    if (!me.workspaces || me.workspaces.length < 2) {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }

    container.classList.remove('hidden');
    container.innerHTML =
      '<div class="workspace-switcher-label">Workspace</div>' +
      '<select id="workspace-select">' +
        me.workspaces.map(function (w) {
          return '<option value="' + esc(w.team_id) + '"' + (w.is_current ? ' selected' : '') + '>' +
            esc(w.name) + ' — ' + esc(w.role_label) + '</option>';
        }).join('') +
      '</select>';

    el('workspace-select').addEventListener('change', async function (e) {
      setWorkspace(e.target.value);
      currentScreen = null; // force a full render — everything below depends on the new org
      await enterApp();
      toast('Switched workspace.', 'ok');
    });
  }

  // The Group nav item — hidden by default (see index.html's comment on
  // #nav-group-group) and shown only for the small minority of owners who
  // actually own a parent_organizations row. Unlike the workspace switcher,
  // this never changes X-Workspace-Id — it just navigates to #/group, a
  // screen backed by GET /group/dashboard, which is scoped by the caller's
  // own id rather than by whichever workspace happens to be selected.
  function renderGroupLink(me) {
    var group = el('nav-group-group');
    if (!group) return;
    group.classList.toggle('hidden', !me.is_group_owner);
  }

  // The sidebar footer's identity block — split out of enterApp() so the
  // account modal can refresh it in place after an edit, without a full
  // reload() (which only re-renders #view, not the sidebar chrome around it).
  function renderWhoBlock(me) {
    el('who-name').textContent = me.full_name || me.email;
    el('who-org').textContent = (me.company_name || (me.is_team ? 'Team workspace' : 'Solo workspace'))
      + (me.role_label ? ' · ' + me.role_label : '');

    var badge = el('who-initials');
    if (me.avatar_url) {
      badge.innerHTML = '<img src="' + esc(me.avatar_url) + '" alt="">';
    } else {
      badge.textContent = initials(me.full_name, me.email);
    }
  }

  // ── Enter / leave ─────────────────────────────────────────────────────
  // A stored token is a claim, not proof. /auth/me is what turns it into a
  // session: until the server confirms who this is, the app is not shown at
  // all — "looks signed in" and "is signed in" are the same state here.
  // SECTION 14 — offline-first mode. "Only works for sales_rep role — other
  // roles see a standard offline message" (the existing renderFailure() in
  // renderRoute already IS that standard message, for status:0 — nothing
  // else has to change for them). Called once per sign-in from enterApp();
  // the online/offline listeners themselves are wired only once even across
  // a workspace switch that calls enterApp() again, via the guard below.
  var offlineModeWired = false;
  function setUpOfflineMode(role) {
    var banner = el('offline-banner');
    var syncBadge = el('sync-status');
    if (!banner || !syncBadge) return;

    var isRep = role === 'sales_rep';
    banner.classList.toggle('hidden', !isRep || navigator.onLine);
    if (isRep && RE.offlineQueue) RE.offlineQueue.refreshSyncBadge();
    else syncBadge.classList.add('hidden');

    if (offlineModeWired) return;
    offlineModeWired = true;

    window.addEventListener('offline', function () {
      if (RE.state.user && RE.state.user.role === 'sales_rep') banner.classList.remove('hidden');
    });
    // Fires once connectivity actually returns — the browser's own signal,
    // not a poll. A rep on the road gets exactly one automatic sync attempt
    // per reconnect, not a timer running down their battery. Wired here
    // (not inside offline-queue.js) so the toast callbacks that turn a sync
    // result into user-visible feedback live in one file.
    window.addEventListener('online', function () {
      banner.classList.add('hidden');
      if (RE.state.user && RE.state.user.role === 'sales_rep' && RE.offlineQueue) {
        RE.offlineQueue.syncQueue(onQueueItemSynced, onQueueItemFailed);
      }
    });

    syncBadge.addEventListener('click', function () {
      if (!RE.offlineQueue) return;
      RE.offlineQueue.getAll().then(function (all) {
        var failed = all.filter(function (e) { return e.status === 'failed'; });
        if (!failed.length) return;
        toast('Retrying ' + plural(failed.length, 'submission') + '…', 'ok');
        failed.forEach(function (entry) { RE.offlineQueue.retryEntry(entry.id, onQueueItemSynced, onQueueItemFailed); });
      });
    });
  }

  function onQueueItemSynced(entry) {
    var label = entry.type === 'new_buyer' ? 'New buyer' : entry.type === 'new_reservation' ? 'New reservation' : 'Activity';
    toast(label + ' synced.', 'ok');
  }
  function onQueueItemFailed(entry, err) {
    toast('Could not sync a queued submission: ' + err.message, 'err');
  }

  async function enterApp() {
    var me;
    try {
      me = await request('/auth/me', { noAuthRedirect: true });
    } catch (err) {
      setToken(null);
      gateError('login-error', err.status === 401 ? 'Sign in to continue.' : err.message);
      showGate();
      return;
    }

    RE.state.user = me;
    applyNavForRole(me.role);
    renderWorkspaceSwitcher(me);
    renderGroupLink(me);
    renderWhoBlock(me);
    setUpOfflineMode(me.role);

    el('dateline').textContent = new Date().toLocaleDateString('en-NG', {
      weekday: 'long', day: 'numeric', month: 'long',
    });

    el('gate').hidden = true;
    el('app').hidden = false;

    if (!window.location.hash || window.location.hash.indexOf('#/reset') === 0) {
      window.location.hash = '#/dashboard';
    }

    // Light the nav BEFORE the first render, not as part of it. On a cold start
    // — a Render free-tier instance waking up, which is most first loads —
    // renderRoute is waiting on the network for a second or more, and the
    // sidebar sat with nothing highlighted for all of it.
    var landing = parseHash().name;
    qsa('[data-nav]').forEach(function (link) {
      link.classList.toggle('is-active', link.dataset.nav === landing);
    });

    await renderRoute();
    refreshCounts();
    refreshNotifBell();
  }

  function showGate() {
    RE.state.user = null;
    el('app').hidden = true;
    el('gate').hidden = false;

    // A reset link lands on #/reset?token=… before anyone is signed in.
    if (window.location.hash.indexOf('#/reset') === 0) showGateForm('form-reset');
    else showGateForm('form-login');
  }

  function signOut(message) {
    // SECTION 3 — best-effort, not awaited: sign-out has to feel instant
    // regardless of network state, and a session that fails to revoke here
    // is not a security hole — the token itself is about to be discarded
    // client-side, and the row simply ages out of "last used" on the
    // Sessions screen instead of showing revoked_at.
    if (RE.state.user && RE.state.user.current_session_id) {
      api('/auth/sessions/' + RE.state.user.current_session_id, { method: 'DELETE' }).catch(function () {});
    }

    setToken(null);
    RE.state.user = null;
    RE.state.config = RE.state.config || {};

    // Screens keep filter state between navigations — that is the point of it.
    // It must not survive a sign-out: two people share a machine in a
    // developer's office, and the second user would otherwise land on a
    // dashboard scoped to a project they may not even have access to, with a
    // pill lit up that they never clicked.
    if (typeof RE.resetScreenState === 'function') RE.resetScreenState();

    currentScreen = null;          // force a full render on the next sign-in
    el('overlay').innerHTML = '';  // close any modal or drawer left open
    el('search-input').value = '';
    el('view').innerHTML = '';     // never leave one user's data behind the gate

    showGate();
    if (message) gateError('login-error', message);
  }

  // ── Personal account ─────────────────────────────────────────────────
  // Everything here is about the SIGNED-IN PERSON, never the workspace —
  // photo, name, email, password, sign out. Workspace configuration
  // (branding, payment/SMS/email provider keys, team, commission default,
  // notification routing) lives under Settings in the sidebar nav instead;
  // the two are deliberately disjoint, so this modal has zero overlap with
  // that screen. See CLAUDE.md's "Personal account vs. workspace settings".
  function openAccountModal() {
    var me = RE.state.user;
    if (!me) return;

    var m = modal({
      title: 'Your account',
      cancelLabel: 'Close',
      body:
        '<div class="logo-upload" id="account-avatar-upload" tabindex="0" role="button" ' +
            'aria-label="' + (me.avatar_url ? 'Change photo' : 'Add photo') + '">' +
          (me.avatar_url
            ? '<img src="' + esc(me.avatar_url) + '" alt="">'
            : '<div class="logo-upload-empty">Add photo</div>') +
          '<div class="logo-upload-overlay">' + (me.avatar_url ? 'Change' : 'Add photo') + '</div>' +
        '</div>' +

        '<div class="field mt-2"><label for="acc-name">Name</label>' +
          '<input class="input" id="acc-name" value="' + esc(me.full_name || '') + '"></div>' +
        '<div class="field"><label for="acc-email">Email</label>' +
          '<input class="input" id="acc-email" type="email" value="' + esc(me.email) + '"></div>' +
        '<button class="btn primary" type="button" id="btn-save-profile">Save profile</button>' +

        '<div class="divider"></div>' +

        '<div class="field"><label for="acc-current">' + (me.has_password ? 'Current password' : 'No password set') + '</label>' +
          '<input class="input" id="acc-current" type="password" autocomplete="current-password"' +
            (me.has_password ? '' : ' disabled placeholder="You sign in with Google"') + '></div>' +
        '<div class="field"><label for="acc-new">' + (me.has_password ? 'New password' : 'Set a password') + '</label>' +
          '<input class="input" id="acc-new" type="password" autocomplete="new-password" placeholder="At least 12 characters"></div>' +
        '<button class="btn" type="button" id="btn-change-password">Change password</button>' +

        // SECTION 2 — owner role only, same gate routes/auth.js's own
        // 2fa/* routes enforce server-side; this is presentation only, the
        // usual rule (CLAUDE.md: hiding a button is never the real gate).
        (me.role === 'owner'
          ? '<div class="divider"></div>' +
            '<div class="field"><label>Two-factor authentication</label>' +
              '<p class="field-hint mb-1">' +
                (me.totp_enabled
                  ? 'Enabled — an authenticator app code is required every time you sign in.'
                  : 'Not enabled. Adds a second step to sign-in using an authenticator app.') +
              '</p>' +
              '<button class="btn" type="button" id="btn-manage-2fa">' +
                (me.totp_enabled ? 'Manage 2FA' : 'Enable 2FA') +
              '</button></div>'
          : '') +

        '<div class="divider"></div>' +

        // SECTION 3 — every role, not owner-only: a session is a fact about
        // the signed-in PERSON (this modal's whole scope, per its own
        // comment below), not a workspace permission.
        '<div class="field"><label>Sessions</label>' +
          '<p class="field-hint mb-1">See every device signed in as you, and sign out ones you do not recognise.</p>' +
          '<button class="btn" type="button" id="btn-manage-sessions">Manage sessions</button></div>' +

        '<div class="divider"></div>' +

        '<button class="btn" type="button" id="btn-account-signout">Sign out</button>' +
        // Last in the DOM on purpose: modal() autofocuses the first
        // input/select/textarea in the body, and a type=file input would win
        // that race (it matches :not([type=hidden])) despite being visually
        // hidden — leaving the Name field, the one someone actually wants
        // focused on open, skipped.
        '<input type="file" id="account-avatar-file" accept="image/jpeg,image/png,image/webp" class="hidden">',
      // No submit-type button lives in here (see below) — but the body is
      // still one <form>, so pressing Enter in any field fires its submit
      // event regardless. Without this, modal()'s own handler reads that as
      // "no onSubmit given" and closes the dialog. Each action below has its
      // own button and handles its own request; Enter alone does nothing.
      onSubmit: function () {},
    });

    var avatarUpload = qs('#account-avatar-upload', m.root);
    var avatarFile = qs('#account-avatar-file', m.root);
    var openAvatarPicker = function () { avatarFile.click(); };
    avatarUpload.addEventListener('click', openAvatarPicker);
    avatarUpload.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAvatarPicker(); }
    });

    avatarFile.addEventListener('change', async function () {
      var file = avatarFile.files && avatarFile.files[0];
      if (!file) return;

      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        toast('Use a JPEG, PNG or WebP image.', 'err');
        avatarFile.value = '';
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        toast('That image is larger than 2MB.', 'err');
        avatarFile.value = '';
        return;
      }

      avatarUpload.classList.add('is-working');
      try {
        var base64 = await new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () { resolve(String(reader.result).split(',')[1]); };
          reader.onerror = function () { reject(new Error('could not be read')); };
          reader.readAsDataURL(file);
        });

        var result = await request('/auth/me/avatar', {
          method: 'POST', body: JSON.stringify({ content: base64, content_type: file.type }),
        });

        RE.state.user.avatar_url = result.avatar_url;
        renderWhoBlock(RE.state.user);
        avatarUpload.innerHTML = '<img src="' + esc(result.avatar_url) + '" alt="">' +
          '<div class="logo-upload-overlay">Change</div>';
        avatarUpload.setAttribute('aria-label', 'Change photo');
        toast('Photo updated.', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        avatarUpload.classList.remove('is-working');
        avatarFile.value = '';
      }
    });

    onClick(m.root, '#btn-save-profile', async function () {
      var payload = { full_name: qs('#acc-name', m.root).value.trim() };
      var email = qs('#acc-email', m.root).value.trim();
      if (email && email !== RE.state.user.email) {
        payload.email = email;
        payload.current_password = qs('#acc-current', m.root).value;
      }

      var result = await request('/auth/me', { method: 'PATCH', body: JSON.stringify(payload) });
      if (result.token) {
        setToken(result.token);
        toast('Profile updated. Every other signed-in device has been signed out.', 'ok');
      } else {
        toast('Profile updated.', 'ok');
      }

      RE.state.user.full_name = result.full_name;
      RE.state.user.email = result.email;
      qs('#acc-email', m.root).value = result.email;
      renderWhoBlock(RE.state.user);
    });

    onClick(m.root, '#btn-change-password', async function () {
      var currentField = qs('#acc-current', m.root);
      var current = currentField.value;
      var next = qs('#acc-new', m.root).value;
      if (!next) throw new Error('Enter a new password.');

      var payload = { password: next };
      if (current) payload.current_password = current;

      var result = await request('/auth/me', { method: 'PATCH', body: JSON.stringify(payload) });
      if (result.token) setToken(result.token);

      // A Google-only account (me.has_password was false at render time) has
      // one now — re-enable the field the labels/disabled-state above were
      // built from, or setting a SECOND password in the same modal session
      // would demand a current_password through a field that is still
      // disabled from the first render, with no way to type into it at all.
      if (!RE.state.user.has_password) {
        RE.state.user.has_password = true;
        currentField.disabled = false;
        currentField.placeholder = '';
        var currentLabel = qs('label[for="acc-current"]', m.root);
        if (currentLabel) currentLabel.textContent = 'Current password';
        var newLabel = qs('label[for="acc-new"]', m.root);
        if (newLabel) newLabel.textContent = 'New password';
      }

      currentField.value = '';
      qs('#acc-new', m.root).value = '';
      toast('Password changed. Every other signed-in device has been signed out.', 'ok');
    });

    // SECTION 2 — defined in screens.js (it needs the same multi-step-modal
    // idioms every other domain flow there already uses); called dynamically
    // here since realestate.js loads first and screens.js has finished
    // registering everything long before anyone actually clicks this button.
    var manage2fa = qs('#btn-manage-2fa', m.root);
    if (manage2fa) {
      manage2fa.addEventListener('click', async function () {
        await RE.twoFactorModal(me);
      });
    }

    onClick(m.root, '#btn-manage-sessions', async function () {
      await RE.sessionsModal();
    });

    onClick(m.root, '#btn-account-signout', async function () {
      m.close();
      signOut();
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  async function boot() {
    wireGate();
    wireSearch();
    wireCallLinks();
    wireNotifBell();

    el('btn-signout').addEventListener('click', function () { signOut(); });
    el('btn-signout-icon').addEventListener('click', function () { signOut(); });
    el('btn-account').addEventListener('click', openAccountModal);

    el('btn-menu').addEventListener('click', function () {
      var sidebar = el('sidebar');
      sidebar.classList.add('is-open');
      var scrim = document.createElement('div');
      scrim.className = 'sidebar-scrim';
      scrim.addEventListener('click', function () {
        sidebar.classList.remove('is-open');
        scrim.remove();
      });
      document.body.appendChild(scrim);
    });

    window.addEventListener('hashchange', renderRoute);

    // Which sign-in options exist is the server's call, not the page's.
    try {
      RE.state.config = await request('/auth/config', { noAuthRedirect: true });
      mountGoogle(RE.state.config.google_client_id);
      if (!RE.state.config.allow_registration) {
        el('tab-register').hidden = true;
        el('link-to-register').closest('span').hidden = true;
      }
    } catch (e) {
      // The API being unreachable at boot is worth saying out loud, because
      // otherwise the sign-in form looks fine and fails on submit.
      gateError('login-error', 'Cannot reach the server at ' + API_BASE + '.');
    }

    // #/accept-invite?token=… is the emailed team-invite link.
    if (window.location.hash.indexOf('#/accept-invite') === 0) {
      await consumeInviteLink();
      return;
    }

    if (token) await enterApp();
    else showGate();
  }

  // Not consumed inline here for a signed-out visitor — registering with the
  // invited address already joins them server-side (POST /register calls
  // inviteService.claimPendingInvites by email), so the only case this
  // variable is actually used for is somebody who already has an account and
  // needs to sign in before POST /invite/accept can attach it to them.
  var pendingInviteToken = null;

  // SECTION 2 — the partial_token POST /login hands back when the account
  // signing in has 2FA on. Lives only in this tab, only until form-2fa's
  // own submit handler exchanges it for a real session token or the user
  // cancels back to the plain sign-in form.
  var pendingTwoFactorToken = null;

  async function consumeInviteLink() {
    el('gate').hidden = false;

    var inviteToken = (/[?&#]token=([^&]+)/.exec(window.location.hash) || [])[1];
    if (!inviteToken) {
      showGateForm('form-login');
      gateError('login-error', 'This invitation link is incomplete. Ask whoever invited you to send it again.');
      return;
    }
    inviteToken = decodeURIComponent(inviteToken);

    // Already signed in — the common case for somebody invited to a SECOND
    // workspace they already use Archta with. Nothing to show; just attach it
    // and go straight to the workspace it invited them into.
    if (token) {
      try {
        var accepted = await authApi.post('/invite/accept', { token: inviteToken });
        setWorkspace(accepted.team_id);
        window.location.hash = '#/dashboard';
        await enterApp();
        toast(accepted.already_member ? 'You are already in that workspace.' : 'Joined the workspace.', 'ok');
      } catch (err) {
        await enterApp();
        toast(err.message, 'err');
      }
      return;
    }

    // Not signed in: preview the invite (unauthenticated — GET /auth/invite/:token)
    // so the sign-in/register screen can say whose workspace this is and as
    // what, before asking for a password.
    var preview;
    try {
      preview = await authApi('/invite/' + encodeURIComponent(inviteToken));
    } catch (err) {
      preview = { valid: false };
    }

    if (!preview.valid) {
      showGateForm('form-login');
      gateError('login-error', preview.reason === 'expired'
        ? 'That invitation has expired. Ask whoever invited you to send a new one.'
        : 'That invitation link is not valid.');
      return;
    }

    pendingInviteToken = inviteToken;
    var invitedAs = preview.team_name
      ? 'Invited to ' + preview.team_name + ' as ' + preview.role_label + '.'
      : 'You have been invited as ' + preview.role_label + '.';

    if (preview.already_active) {
      // Already a member — this link is just a way back in, not an invite
      // waiting to be accepted.
      showGateForm('form-login');
      el('login-email').value = preview.email || '';
      el('gate-login-sub').textContent = invitedAs + ' Sign in to continue.';
    } else {
      showGateForm('form-register');
      el('reg-email').value = preview.email || '';
      el('gate-register-sub').textContent = invitedAs + ' Create your account to join.';
    }
  }

  // ── Public surface ────────────────────────────────────────────────────
  var RE = window.RE = {
    API_BASE: API_BASE,
    api: api,
    authApi: authApi,
    request: request,
    screens: {},
    state: { user: null, config: {} },
    can: can,

    go: go,
    reload: reload,
    refreshCounts: refreshCounts,
    signOut: signOut,
    // Swaps in a token the server handed back mid-session — the only case is a
    // password change, which invalidates the token this tab is holding. Without
    // this the very next request would 401 and bounce the user to the gate for
    // having successfully changed their password.
    adoptToken: setToken,

    esc: esc,
    naira: naira,
    nairaShort: nairaShort,
    plural: plural,
    fmtDate: fmtDate,
    fmtDateTime: fmtDateTime,
    fmtRelative: fmtRelative,
    todayISO: todayISO,
    initials: initials,
    badge: badge,
    waNumber: waNumber,
    waLink: waLink,
    openFile: openFile,
    downloadCsv: downloadCsv,

    el: el,
    qs: qs,
    qsa: qsa,
    values: values,
    onClick: onClick,
    copyText: copyText,
    applyDynamicStyles: applyDynamicStyles,

    toast: toast,
    modal: modal,
    drawer: drawer,
    confirm: confirmDialog,
    table: table,
    emptyState: emptyState,
    skeleton: skeleton,
    dashboardSkeleton: dashboardSkeleton,

    // SECTION 1
    pushSupported: pushSupported,
    shouldShowPushBanner: shouldShowPushBanner,
    dismissPushBanner: dismissPushBanner,
    subscribeToPush: subscribeToPush,
    refreshNotifBell: refreshNotifBell,
    // SECTION 15 — whatsappQueue itself isn't assigned until near the
    // bottom of this file; wired onto RE there instead of here, since
    // capturing the bare (still-undefined, var-hoisted) variable at this
    // point in the script would freeze RE.whatsappQueue at undefined
    // forever — object literals copy the value at construction time, not a
    // live binding to the variable.
  };

  // ── SECTION 1 — push notifications ───────────────────────────────────────
  // A VAPID public key arrives as base64url; PushManager.subscribe() wants
  // it as a raw Uint8Array. This is the standard conversion every Web Push
  // integration needs — there is no browser API that does it for you.
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = window.atob(base64);
    var output = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
    return output;
  }

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  var PUSH_BANNER_DISMISSED_KEY = 'archta_push_banner_dismissed';

  function pushBannerDismissed() {
    try { return window.localStorage.getItem(PUSH_BANNER_DISMISSED_KEY) === 'true'; }
    catch (e) { return false; }
  }

  function dismissPushBanner() {
    try { window.localStorage.setItem(PUSH_BANNER_DISMISSED_KEY, 'true'); } catch (e) { /* private browsing */ }
  }

  // Whether the banner should even be considered: supported by this browser,
  // the server has a VAPID key configured at all, permission has not
  // already been decided either way (a "denied" browser can only be
  // re-enabled from the browser's own site settings, not by asking again),
  // and this browser hasn't already dismissed it.
  function shouldShowPushBanner() {
    return pushSupported()
      && Boolean(RE.state.user && RE.state.user.vapid_public_key)
      && Notification.permission === 'default'
      && !pushBannerDismissed();
  }

  // The whole flow: ask the browser, subscribe with the service worker,
  // save the subscription server-side. Thrown errors are the caller's to
  // toast — this does not swallow them, since "why didn't that work" matters
  // for a feature the user just explicitly opted into.
  async function subscribeToPush() {
    if (!pushSupported()) throw new Error('Push notifications are not supported in this browser.');
    if (!RE.state.user || !RE.state.user.vapid_public_key) {
      throw new Error('Push notifications are not configured on this server.');
    }

    var permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error(permission === 'denied'
        ? 'Notifications are blocked. Enable them from your browser\'s site settings to turn this on.'
        : 'Permission was not granted.');
    }

    var registration = await navigator.serviceWorker.ready;
    var subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(RE.state.user.vapid_public_key),
    });

    await api.post('/push/subscribe', { subscription: subscription.toJSON() });
  }

  // ── The bell ─────────────────────────────────────────────────────────────
  var notifDropdownOpen = false;

  function renderNotifRow(n) {
    return '<button class="notif-row' + (n.read_at ? '' : ' is-unread') + '" data-notif-id="' + esc(n.id) + '" data-notif-url="' + esc(n.url || '') + '">' +
      '<div class="notif-title">' + esc(n.title) + '</div>' +
      (n.body ? '<div class="notif-body">' + esc(n.body) + '</div>' : '') +
      '<div class="notif-time">' + esc(fmtRelative(n.created_at)) + '</div>' +
    '</button>';
  }

  async function refreshNotifBell() {
    var badge = el('notif-count');
    if (!badge) return; // not signed in yet — boot() runs this before the gate even resolves
    try {
      var result = await api('/push/notifications?limit=20');
      badge.textContent = result.unread_count > 9 ? '9+' : String(result.unread_count);
      badge.classList.toggle('hidden', !result.unread_count);
      RE.state.notifications = result.items;
    } catch (e) {
      // A failed fetch leaves the last-known badge state rather than
      // clearing it — an unreachable API for one refresh should not read as
      // "you have no notifications".
    }
  }

  function closeNotifDropdown() {
    var dropdown = el('notif-dropdown');
    if (dropdown) dropdown.classList.add('hidden');
    notifDropdownOpen = false;
    document.removeEventListener('mousedown', onNotifDocClick);
  }

  function onNotifDocClick(e) {
    var dropdown = el('notif-dropdown');
    var button = el('btn-notifications');
    if (dropdown && !dropdown.contains(e.target) && button && !button.contains(e.target)) closeNotifDropdown();
  }

  function openNotifDropdown() {
    var dropdown = el('notif-dropdown');
    if (!dropdown) return;
    var items = RE.state.notifications || [];
    dropdown.innerHTML = items.length
      ? items.map(renderNotifRow).join('')
      : emptyState('Nothing yet', 'Notifications about payments, briefs and buyer activity will show up here.');
    dropdown.classList.remove('hidden');
    notifDropdownOpen = true;

    qsa('[data-notif-id]', dropdown).forEach(function (row) {
      row.addEventListener('click', async function () {
        closeNotifDropdown();
        try { await api.post('/push/notifications/' + row.dataset.notifId + '/read'); } catch (e) { /* not worth blocking navigation over */ }
        refreshNotifBell();
        if (row.dataset.notifUrl) window.location.hash = row.dataset.notifUrl.replace(/^\/?#?/, '#');
      });
    });

    setTimeout(function () { document.addEventListener('mousedown', onNotifDocClick); }, 0);
  }

  function wireNotifBell() {
    var button = el('btn-notifications');
    if (!button) return;
    button.addEventListener('click', function () {
      if (notifDropdownOpen) closeNotifDropdown();
      else openNotifDropdown();
    });
  }

  // ── SECTION 15 — bulk WhatsApp from the brief ────────────────────────────
  // sessionStorage, not a module variable: the whole point is surviving the
  // user tabbing away to WhatsApp Web and back, which a plain in-memory
  // variable would too (this tab never navigates), but sessionStorage is
  // also what makes the queue resume correctly across an accidental reload
  // of this tab mid-sequence, which a variable would silently lose.
  var WHATSAPP_QUEUE_KEY = 'archta_whatsapp_queue';
  var RESUME_DELAY_MS = 2000;
  var whatsappQueueAwaitingFocus = false;

  function readWhatsappQueue() {
    try {
      var raw = window.sessionStorage.getItem(WHATSAPP_QUEUE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeWhatsappQueue(queue) {
    try {
      if (queue) window.sessionStorage.setItem(WHATSAPP_QUEUE_KEY, JSON.stringify(queue));
      else window.sessionStorage.removeItem(WHATSAPP_QUEUE_KEY);
    } catch (e) { /* private browsing, or storage disabled — the queue just won't survive a reload */ }
  }

  function openWhatsappQueueLink(queue) {
    var item = queue.items[queue.index];
    if (!item) return;
    var win = window.open(item.url, '_blank', 'noopener');
    // Some browsers (mobile Safari, popup-blocked desktop) refuse a
    // window.open that isn't a direct response to the click that triggered
    // it — start()/skip() below are both real click handlers, so this is
    // the same trusted-gesture chain openFile() elsewhere in this file
    // already relies on, just without the extra fetch-then-click step a
    // signed URL needs.
    if (!win) toast('Your browser blocked the popup. Allow popups for this site to use Send all.', 'err');
    whatsappQueueAwaitingFocus = true;
  }

  // Drafts with no usable phone number are filtered out up front rather
  // than left in the queue to silently fail on — "Sending 3 of 7" should
  // never land on a draft with nothing to open.
  function startWhatsappQueue(drafts) {
    var items = [];
    (drafts || []).forEach(function (d) {
      var link = waLink(d.customer_phone);
      if (!link) return;
      items.push({
        name: d.customer_name || 'this buyer',
        url: link + '&text=' + encodeURIComponent(d.whatsapp_draft || ''),
      });
    });
    if (!items.length) {
      toast('None of these drafts have a valid phone number on file.', 'err');
      return;
    }
    var queue = { items: items, index: 0, total: items.length };
    writeWhatsappQueue(queue);
    openWhatsappQueueLink(queue);
  }

  function skipWhatsappQueueItem() {
    var queue = readWhatsappQueue();
    if (!queue) return;
    advanceWhatsappQueue(queue);
  }

  function advanceWhatsappQueue(queue) {
    queue.index += 1;
    if (queue.index >= queue.items.length) {
      writeWhatsappQueue(null);
      toast('Reached the end of the queue (' + queue.total + ' draft(s)).', 'ok');
      return;
    }
    writeWhatsappQueue(queue);
    openWhatsappQueueLink(queue);
  }

  function endWhatsappQueue() {
    writeWhatsappQueue(null);
    whatsappQueueAwaitingFocus = false;
  }

  // Returning from WhatsApp Web (or anywhere else) fires a focus event on
  // this window. A flat 2-second delay rather than reacting instantly: an
  // instant re-trigger on every alt-tab (checking something else, coming
  // right back) would fire the next link before the user meant to move on
  // at all. Wrapped like every other top-level window.* call in this file
  // (see the offline test suite's own comment on why): the minimal window
  // stub logic.test.js requires this file against has no addEventListener.
  try {
    window.addEventListener('focus', function () {
      if (!whatsappQueueAwaitingFocus) return;
      whatsappQueueAwaitingFocus = false;
      setTimeout(function () {
        var queue = readWhatsappQueue();
        if (queue) advanceWhatsappQueue(queue);
      }, RESUME_DELAY_MS);
    });
  } catch (e) { /* no-op outside a real browser */ }

  var whatsappQueue = {
    start: startWhatsappQueue,
    current: readWhatsappQueue,
    skip: skipWhatsappQueueItem,
    done: endWhatsappQueue,
  };
  RE.whatsappQueue = whatsappQueue;

  // Registered unconditionally (cheap, and every role benefits from the
  // app-shell speed-up); which SCREENS actually use what it caches is gated
  // to sales_rep inside screens.js and offline-queue.js instead. Guarded by
  // the feature check itself — an old browser or a locked-down webview with
  // no serviceWorker support must not throw and take anything else down
  // with it. Was a bare inline <script> in index.html; moved here so
  // frontend/vercel.json's CSP never has to carry a per-script hash — this
  // file's own convention (CLAUDE.md's frontend gotchas) is that nothing
  // here is ever inline. Wrapped like every other top-level window.* call in
  // this file: the minimal window stub logic.test.js requires this file
  // against has no addEventListener.
  try {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./service-worker.js').then(function (registration) {
          // Force an immediate check for a new service-worker script rather than
          // waiting for the browser's own infrequent background check — this is
          // what actually notices SHELL_CACHE was bumped and starts the update
          // cycle within this same session instead of the next cold visit.
          registration.update().catch(function () { /* offline, or nothing new — harmless */ });
        }).catch(function (err) {
          console.warn('[archta] service worker registration failed:', err.message);
        });

        // Fires once a newly-installed worker actually takes control
        // (service-worker.js's own activate handler calls self.clients.claim()
        // unconditionally). A single reload here is what lets a tab left open
        // across a deploy pick up a fixed app shell within the same session,
        // rather than a stale cached bundle replaying an already-fixed bug
        // (see migrations/054's own history of exactly that) until the tab is
        // manually closed and reopened. Guarded so it only ever fires once.
        var reloadedForNewWorker = false;
        navigator.serviceWorker.addEventListener('controllerchange', function () {
          if (reloadedForNewWorker) return;
          reloadedForNewWorker = true;
          window.location.reload();
        });
      });
    }
  } catch (e) { /* no-op outside a real browser */ }

  document.addEventListener('DOMContentLoaded', boot);
})();
