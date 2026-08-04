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

  function waLink(phone) {
    var number = waNumber(phone);
    return number ? 'https://wa.me/' + number : null;
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
          '<button class="btn ghost" type="button" data-close>' + esc(opts.cancelLabel || 'Cancel') + '</button>' +
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
  function emptyState(title, hint, actionHtml) {
    return '<div class="empty">' +
      '<span class="empty-icon">◇</span>' +
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

  function table(columns, rows, rowFn, options) {
    var opts = options || {};
    if (!rows.length) return emptyState(opts.emptyTitle || 'Nothing here yet', opts.emptyHint, opts.emptyAction);

    return '<div class="table-wrap"><table class="data"><thead><tr>' +
      columns.map(function (c) {
        return '<th' + (c.num ? ' class="num"' : '') + '>' + esc(c.label) + '</th>';
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
      view.innerHTML = '<div class="card">' + skeleton(5) + '</div>';
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
      renderFailure(view, err);
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
  function renderFailure(view, err) {
    var offline = err.status === 0 || !navigator.onLine;

    view.innerHTML =
      '<div class="page-head"><div>' +
        '<div class="page-title">' + (offline ? 'No connection' : 'Could not load this screen') + '</div>' +
        '<div class="page-sub">' +
          (offline
            ? 'Your device could not reach the server. Nothing was lost — try again when you have signal.'
            : 'The server answered with an error.') +
        '</div>' +
      '</div></div>' +
      '<div class="notice' + (offline ? ' info' : '') + '">' + esc(err.message) + '</div>' +
      '<div class="btn-row">' +
        '<button class="btn primary" id="btn-retry">Try again</button>' +
        '<button class="btn ghost" id="btn-hard-reload">Reload the app</button>' +
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
  var gateForms = ['form-login', 'form-register', 'form-forgot', 'form-reset'];

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
    sales_rep: ['dashboard', 'customers', 'reservations', 'commissions', 'projects', 'units'],
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
    renderWhoBlock(me);

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

        '<div class="divider"></div>' +

        '<button class="btn ghost" type="button" id="btn-account-signout">Sign out</button>' +
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

    onClick(m.root, '#btn-account-signout', async function () {
      m.close();
      signOut();
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  async function boot() {
    wireGate();
    wireSearch();

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
  };

  document.addEventListener('DOMContentLoaded', boot);
})();
