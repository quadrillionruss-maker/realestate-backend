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

  // ── Helpers ───────────────────────────────────────────────────────────
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function naira(amount) {
    return '₦' + Number(amount || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });
  }

  // Compact money for tiles, where ₦1,240,000,000 wraps and ₦1.24b does not.
  //
  // The cutover is 1,000, not 10,000. At 10,000 a KPI row could show "₦9,999"
  // beside "₦10k" — the same magnitude formatted two different ways, which
  // reads as a rendering bug. Below ₦1,000 there is nothing to abbreviate.
  function nairaShort(amount) {
    var n = Number(amount || 0);
    var abs = Math.abs(n);
    if (abs >= 1e9) return '₦' + trimZeros((n / 1e9).toFixed(2)) + 'b';
    if (abs >= 1e6) return '₦' + trimZeros((n / 1e6).toFixed(1)) + 'm';
    if (abs >= 1e3) return '₦' + trimZeros((n / 1e3).toFixed(1)) + 'k';
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
    setTimeout(function () { URL.revokeObjectURL(url); }, 30_000);
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

    // The token is fine; the address is not confirmed. 403 rather than 401
    // precisely so this does not look like an expired session — sending them
    // back to the password form would be a loop, since signing in again
    // succeeds and the next request fails the same way.
    if (res.status === 403 && body && body.code === 'email_unverified' && !opts.noAuthRedirect) {
      showVerifyGate(body.error);
      throw Object.assign(new Error(body.error), { status: 403, code: 'email_unverified' });
    }

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
          '<div class="spacer" style="flex:1"></div>' +
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

    var form = scrim.querySelector('form');
    var submit = scrim.querySelector('[type="submit"]');

    function close() {
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      document.removeEventListener('keydown', onKey);
    }

    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);

    qsa('[data-close]', scrim).forEach(function (b) { b.addEventListener('click', close); });
    // Clicking the backdrop closes; clicking inside the dialog must not.
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (!opts.onSubmit) return close();

      var error = qs('.modal-error', form);
      if (error) error.remove();
      if (submit) submit.classList.add('is-working');

      try {
        await opts.onSubmit(form, close);
      } catch (err) {
        var notice = document.createElement('p');
        notice.className = 'notice modal-error';
        notice.style.marginTop = '14px';
        notice.textContent = err.message;
        form.appendChild(notice);
      } finally {
        if (submit) submit.classList.remove('is-working');
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
        body: '<p class="muted" style="line-height:1.6">' + esc(options.message) + '</p>',
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
    panel.innerHTML =
      '<div class="drawer-head">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="eyebrow">' + esc(options.eyebrow || '') + '</div>' +
          '<div class="page-title" style="font-size:20px;margin-top:3px">' + esc(options.title || '') + '</div>' +
          (options.sub ? '<div class="page-sub">' + esc(options.sub) + '</div>' : '') +
        '</div>' +
        '<button class="icon-btn" data-close aria-label="Close">×</button>' +
      '</div>' +
      '<div class="drawer-body">' + (options.body || '<div class="skeleton"></div>') + '</div>';

    scrim.appendChild(panel);
    overlay.appendChild(scrim);

    function close() {
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    document.addEventListener('keydown', onKey);
    qsa('[data-close]', panel).forEach(function (b) { b.addEventListener('click', close); });
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });

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
      out += '<div class="skeleton" style="width:' + (94 - i * 9) + '%"></div>';
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
      window.scrollTo(0, 0);
    } else {
      // No screen-enter animation on a re-render either — the content
      // flickering and sliding up every time you tick a checkbox reads as a
      // page reload rather than an update.
      view.className = 'page';
    }

    try {
      await screen.render(view, route.params, route.query);
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

        panel.innerHTML = html || '<div class="empty" style="padding:22px">Nothing matched “' + esc(q) + '”.</div>';
        panel.classList.remove('hidden');

        qsa('[data-go]', panel).forEach(function (hit) {
          hit.addEventListener('click', function () {
            go(hit.dataset.go);
            hide();
            input.value = '';
          });
        });
      } catch (err) {
        panel.innerHTML = '<div class="empty" style="padding:22px">' + esc(err.message) + '</div>';
        panel.classList.remove('hidden');
      }
    }
  }

  // ── Gate ──────────────────────────────────────────────────────────────
  var gateForms = ['form-login', 'form-register', 'form-forgot', 'form-reset', 'form-verify'];

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

    el('link-verify-signin').addEventListener('click', function () {
      window.location.hash = '';
      showGateForm('form-login');
    });

    // Resend needs the token from the half-signed-in session: login succeeds
    // for an unverified address, the API refuses, and this is how the person
    // gets another link without having to remember a password again.
    el('btn-resend-verify').addEventListener('click', async function () {
      var button = this;
      button.classList.add('is-working');
      try {
        var result = await request('/auth/resend-verification', {
          method: 'POST', body: '{}', noAuthRedirect: true,
        });
        var ok = el('verify-ok');
        ok.textContent = result.message || 'Sent.';
        if (result.dev_url) {
          ok.innerHTML = esc(result.message) +
            '<br><br><b>Email is not configured on this server.</b><br>' +
            '<a class="link-quiet" href="' + esc(result.dev_url) + '">Open the confirmation link</a>';
        }
        ok.classList.remove('hidden');
        el('verify-error').classList.add('hidden');
      } catch (err) {
        var error = el('verify-error');
        error.textContent = err.status === 401
          ? 'Sign in first, then ask for a new link.'
          : err.message;
        error.classList.remove('hidden');
      } finally {
        button.classList.remove('is-working');
      }
    });

    el('form-login').addEventListener('submit', async function (e) {
      e.preventDefault();
      gateError('login-error', '');
      var button = el('login-submit');
      button.classList.add('is-working');

      try {
        var result = await authApi.post('/login', {
          email: el('login-email').value.trim(),
          password: el('login-password').value,
        });
        setToken(result.token);
        el('login-password').value = '';
        await enterApp();
      } catch (err) {
        gateError('login-error', err.message);
      } finally {
        button.classList.remove('is-working');
      }
    });

    el('form-register').addEventListener('submit', async function (e) {
      e.preventDefault();
      gateError('reg-error', '');
      var button = el('reg-submit');
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
        await enterApp();
        toast('Welcome. Start by creating your first project.', 'ok');
        go('#/projects');
      } catch (err) {
        gateError('reg-error', err.message);
      } finally {
        button.classList.remove('is-working');
      }
    });

    el('form-forgot').addEventListener('submit', async function (e) {
      e.preventDefault();
      gateError('forgot-error', '');
      el('forgot-ok').classList.add('hidden');
      var button = el('forgot-submit');
      button.classList.add('is-working');

      try {
        var result = await authApi.post('/forgot-password', { email: el('forgot-email').value.trim() });
        var ok = el('forgot-ok');
        ok.textContent = result.message;
        ok.classList.remove('hidden');

        // Only ever present outside production, and only when email is not
        // configured — otherwise the reset flow is untestable locally.
        if (result.dev_reset_url) {
          ok.innerHTML = esc(result.message) +
            '<br><br><b>Email is not configured on this server.</b><br>' +
            '<a class="link-quiet" href="' + esc(result.dev_reset_url) + '">Open the reset link</a>';
        }
      } catch (err) {
        gateError('forgot-error', err.message);
      } finally {
        button.classList.remove('is-working');
      }
    });

    el('form-reset').addEventListener('submit', async function (e) {
      e.preventDefault();
      gateError('reset-error', '');
      var button = el('reset-submit');
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

    // /auth/me answers for an unverified user on purpose — it is how the app
    // finds out to show this screen instead of the dashboard. Every /api/re
    // endpoint would 403 with code:'email_unverified', so there is nothing to
    // show behind the gate until they confirm.
    if (me.verification_required && !me.email_verified) {
      showVerifyGate('Confirm ' + me.email + ' to start using Archta. '
        + 'We sent you a link — check your inbox, and your spam folder.');
      return;
    }

    RE.state.user = me;

    el('who-name').textContent = me.full_name || me.email;
    el('who-org').textContent = me.company_name || (me.is_team ? 'Team workspace' : 'Solo workspace');
    el('who-initials').textContent = initials(me.full_name, me.email);
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

  // The "confirm your email" holding screen. The token is KEPT — it is what
  // authorises the resend — but the app is not shown, because everything behind
  // it would 403.
  function showVerifyGate(message) {
    RE.state.user = null;
    el('app').hidden = true;
    el('gate').hidden = false;
    el('overlay').innerHTML = '';
    showGateForm('form-verify');

    el('verify-sub').textContent = 'Almost there.';
    el('verify-ok').classList.add('hidden');

    var pending = el('verify-error');
    pending.textContent = message || 'Confirm your email address to continue.';
    pending.classList.remove('hidden');

    el('btn-resend-verify').classList.remove('hidden');
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

  // ── Boot ──────────────────────────────────────────────────────────────
  async function boot() {
    wireGate();
    wireSearch();

    el('btn-signout').addEventListener('click', function () { signOut(); });
    el('btn-signout-icon').addEventListener('click', function () { signOut(); });
    el('btn-account').addEventListener('click', function () { go('#/settings'); });

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

    // #/verify?token=… is the emailed confirmation link. Consumed before
    // anything else, because it both confirms the address and signs them in.
    if (window.location.hash.indexOf('#/verify') === 0) {
      await consumeVerificationLink();
      return;
    }

    if (token) await enterApp();
    else showGate();
  }

  async function consumeVerificationLink() {
    el('gate').hidden = false;
    showGateForm('form-verify');

    var verifyToken = (/[?&#]token=([^&]+)/.exec(window.location.hash) || [])[1];

    if (!verifyToken) {
      el('verify-sub').textContent = '';
      el('verify-error').textContent = 'This confirmation link is incomplete. Sign in and ask for a new one.';
      el('verify-error').classList.remove('hidden');
      return;
    }

    try {
      var result = await authApi.post('/verify-email', { token: decodeURIComponent(verifyToken) });
      setToken(result.token);
      window.location.hash = '#/dashboard';
      await enterApp();
      toast('Email confirmed. Welcome to Archta.', 'ok');
    } catch (err) {
      el('verify-sub').textContent = '';
      el('verify-error').textContent = err.message;
      el('verify-error').classList.remove('hidden');
      // Resend only helps if they can prove who they are, and an expired link
      // proves nothing.
      el('btn-resend-verify').classList.toggle('hidden', !token);
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
