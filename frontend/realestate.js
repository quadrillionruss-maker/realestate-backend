/* realestate.js — Realtika core: session, API, router, shell, UI primitives.
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
  var TOKEN_KEY = 'realtika.token';

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
  function nairaShort(amount) {
    var n = Number(amount || 0);
    if (Math.abs(n) >= 1e9) return '₦' + (n / 1e9).toFixed(2).replace(/\.00$/, '') + 'b';
    if (Math.abs(n) >= 1e6) return '₦' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'm';
    if (Math.abs(n) >= 1e4) return '₦' + Math.round(n / 1e3) + 'k';
    return naira(n);
  }

  function plural(count, word) { return count + ' ' + word + (count === 1 ? '' : 's'); }

  function fmtDate(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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
  function modal(options) {
    var opts = options || {};
    var overlay = el('overlay');

    var scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML =
      '<div class="modal ' + (opts.wide ? 'wide' : '') + '" role="dialog" aria-modal="true">' +
        '<div class="modal-head">' +
          '<div class="modal-title">' + esc(opts.title || '') + '</div>' +
          '<div class="spacer" style="flex:1"></div>' +
          '<button class="icon-btn" data-close aria-label="Close">×</button>' +
        '</div>' +
        '<form class="modal-body" id="modal-form">' + (opts.body || '') + '</form>' +
        '<div class="modal-foot">' +
          '<button class="btn ghost" type="button" data-close>' + esc(opts.cancelLabel || 'Cancel') + '</button>' +
          (opts.submitLabel
            ? '<button class="btn primary" type="submit" form="modal-form">' + esc(opts.submitLabel) + '</button>'
            : '') +
        '</div>' +
      '</div>';

    overlay.appendChild(scrim);

    var form = scrim.querySelector('#modal-form');
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

    return { close: close, form: form, root: scrim };
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

    if (!screen) {
      el('view').innerHTML =
        '<div class="page-head"><div><div class="page-title">Not found</div>' +
        '<div class="page-sub">No screen at #/' + esc(route.name) + '</div></div></div>' +
        '<div class="card">' + emptyState('Nothing lives here', 'Pick something from the sidebar.') + '</div>';
      return;
    }

    currentScreen = route.name;
    qsa('[data-nav]').forEach(function (link) {
      link.classList.toggle('is-active', link.dataset.nav === route.name);
    });

    var view = el('view');
    view.className = 'page screen-enter';
    view.innerHTML = '<div class="card">' + skeleton(5) + '</div>';
    window.scrollTo(0, 0);

    try {
      await screen.render(view, route.params, route.query);
    } catch (err) {
      if (err.status === 401) return; // signOut already handled it
      view.innerHTML =
        '<div class="page-head"><div><div class="page-title">Something went wrong</div></div></div>' +
        '<div class="notice">' + esc(err.message) + '</div>' +
        '<button class="btn" onclick="location.reload()">Reload</button>';
    }

    // Closing the mobile sidebar on navigation: leaving it open over the
    // screen you just asked for is the classic mobile-nav bug.
    el('sidebar').classList.remove('is-open');
    var scrim = qs('.sidebar-scrim');
    if (scrim) scrim.remove();
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
    document.addEventListener('keydown', function (e) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
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
  var gateForms = ['form-login', 'form-register', 'form-forgot', 'form-reset'];

  function showGateForm(id) {
    gateForms.forEach(function (formId) { el(formId).hidden = formId !== id; });
    el('gate-tabs').hidden = (id === 'form-forgot' || id === 'form-reset');
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
        var resetToken = (/[?&]token=([^&]+)/.exec(window.location.hash) || [])[1];
        var result = await authApi.post('/reset-password', {
          token: resetToken,
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

    window.__realtikaGoogle = async function (response) {
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
        callback: window.__realtikaGoogle,
      });
      window.google.accounts.id.renderButton(el('google-slot'), {
        theme: 'filled_black',
        size: 'large',
        width: 340,
        text: 'continue_with',
        shape: 'rectangular',
      });
      el('alt-login').hidden = false;
    };
    // A blocked or failed CDN must not take the password form down with it.
    script.onerror = function () { console.warn('[realtika] Google sign-in script did not load'); };
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
    el('overlay').innerHTML = '';
    showGate();
    if (message) gateError('login-error', message);
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  async function boot() {
    wireGate();
    wireSearch();

    el('btn-signout').addEventListener('click', function () { signOut(); });
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

    if (token) await enterApp();
    else showGate();
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

    esc: esc,
    naira: naira,
    nairaShort: nairaShort,
    plural: plural,
    fmtDate: fmtDate,
    fmtDateTime: fmtDateTime,
    todayISO: todayISO,
    initials: initials,
    badge: badge,

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
