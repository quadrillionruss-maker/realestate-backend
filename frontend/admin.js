// admin.js — the whole admin dashboard's logic, deliberately self-contained.
//
// No shared code with realestate.js/screens.js (the operator app) or
// portal.js (the buyer portal) — this file duplicates the handful of small
// helpers (naira formatting, escaping, toasts) it needs rather than importing
// them, on purpose (see admin.html's own header comment for why).

(function () {
  'use strict';

  var API_BASE = (function () {
    var host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:' + (window.location.port || '4000') + '/api/admin';
    return window.location.origin + '/api/admin';
  })();

  var SECRET_KEY = 'archta_admin_secret';

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function naira(kobo) {
    var n = Number(kobo || 0);
    return '₦' + n.toLocaleString('en-NG', { maximumFractionDigits: 0 });
  }

  function fmtDate(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function timeAgo(value) {
    if (!value) return 'never';
    var ms = Date.now() - new Date(value).getTime();
    if (ms < 0) return 'just now';
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' minute' + (mins === 1 ? '' : 's') + ' ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
    var days = Math.floor(hours / 24);
    return days + ' day' + (days === 1 ? '' : 's') + ' ago';
  }

  // ── Toasts ─────────────────────────────────────────────────────────────
  function toast(message, kind) {
    var host = document.getElementById('toasts');
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = message;
    host.appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  // ── API client ─────────────────────────────────────────────────────────
  function api(path, options) {
    options = options || {};
    var secret = sessionStorage.getItem(SECRET_KEY);
    var headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    if (secret) headers.Authorization = 'Bearer ' + secret;

    return fetch(API_BASE + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error(body.error || 'Request failed (' + res.status + ')');
          err.status = res.status;
          throw err;
        }
        return body;
      });
    });
  }

  // ── Login ──────────────────────────────────────────────────────────────
  var loginScreen = document.getElementById('login-screen');
  var appShell = document.getElementById('app-shell');
  var loginForm = document.getElementById('login-form');
  var loginError = document.getElementById('login-error');

  function showApp() {
    loginScreen.hidden = true;
    appShell.hidden = false;
    goToSection('overview');
  }

  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var secret = document.getElementById('login-secret').value;
    loginError.textContent = '';
    fetch(API_BASE + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: secret }),
    }).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok, body: body }; });
    }).then(function (result) {
      if (!result.ok) {
        loginError.textContent = result.body.error || 'Incorrect secret.';
        return;
      }
      sessionStorage.setItem(SECRET_KEY, secret);
      showApp();
    }).catch(function () {
      loginError.textContent = 'Could not reach the server.';
    });
  });

  // A stored secret from an earlier tab session skips straight past login —
  // sessionStorage already scopes this to the tab's own lifetime, so there is
  // nothing extra to check here.
  if (sessionStorage.getItem(SECRET_KEY)) showApp();

  // ── Nav / router ───────────────────────────────────────────────────────
  var view = document.getElementById('view');
  var currentSection = null;
  var SECTIONS = {
    overview: renderOverview,
    workspaces: renderWorkspaces,
    users: renderUsers,
    agents: renderAgents,
    notifications: renderNotifications,
    health: renderHealth,
  };

  document.getElementById('nav').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-section]');
    if (!btn) return;
    goToSection(btn.dataset.section);
  });

  function goToSection(name) {
    currentSection = name;
    Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (btn) {
      btn.classList.toggle('is-active', btn.dataset.section === name);
    });
    view.innerHTML = '<div class="empty">Loading…</div>';
    SECTIONS[name]().catch(function (err) {
      if (err.status === 401) {
        sessionStorage.removeItem(SECRET_KEY);
        loginScreen.hidden = false;
        appShell.hidden = true;
        return;
      }
      view.innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
    });
  }

  // ── Overview ───────────────────────────────────────────────────────────
  function renderOverview() {
    return api('/overview').then(function (d) {
      view.innerHTML =
        '<h1 class="page-title">Overview</h1>' +
        '<div class="kpi-grid">' +
          kpi('Workspaces', d.total_workspaces) +
          kpi('Users', d.total_users) +
          kpi('Active last 7 days', d.active_workspaces_7d) +
          kpi('Buyers', d.total_buyers) +
          kpi('Payments recorded', d.total_payments) +
          kpi('Total collected', naira(d.total_collections)) +
        '</div>' +
        '<div class="card"><div class="card-head"><h2>Last cron run</h2></div><div class="card-body">' +
          (d.last_cron_run
            ? '<div>' + esc(d.last_cron_run.job_name) + ' — ' + timeAgo(d.last_cron_run.started_at) +
              '<div class="muted mono">' + fmtDate(d.last_cron_run.started_at) +
              (d.last_cron_run.finished_at ? ' → ' + fmtDate(d.last_cron_run.finished_at) : ' (still running or did not finish)') + '</div></div>'
            : '<div class="empty">No cron run recorded yet.</div>') +
        '</div></div>';
    });
  }

  function kpi(label, value) {
    return '<div class="kpi"><div class="kpi-label">' + esc(label) + '</div><div class="kpi-value">' + esc(value) + '</div></div>';
  }

  // ── Workspaces ─────────────────────────────────────────────────────────
  var workspacesCache = [];
  var openWorkspaceId = null;

  function renderWorkspaces() {
    return api('/workspaces').then(function (rows) {
      workspacesCache = rows;
      paintWorkspaces('');
    });
  }

  function paintWorkspaces(filterText) {
    var filtered = workspacesCache.filter(function (w) {
      if (!filterText) return true;
      var hay = (w.name + ' ' + (w.owner_email || '')).toLowerCase();
      return hay.indexOf(filterText.toLowerCase()) !== -1;
    });

    view.innerHTML =
      '<h1 class="page-title">Workspaces</h1>' +
      '<div class="filter-row"><input class="search-input" id="ws-search" placeholder="Search by name or owner email…" value="' + esc(filterText) + '"></div>' +
      '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Name</th><th>Owner</th><th>Last login</th><th>Buyers</th><th>Brief last generated</th><th>WhatsApp</th><th>Paystack</th><th></th>' +
      '</tr></thead><tbody>' +
      (filtered.length ? filtered.map(workspaceRow).join('') : '<tr><td colspan="8"><div class="empty">No workspaces match.</div></td></tr>') +
      '</tbody></table></div>';

    var wsSearchInput = document.getElementById('ws-search');
    wsSearchInput.addEventListener('input', function (e) { paintWorkspaces(e.target.value); });
    wsSearchInput.focus();
    wsSearchInput.setSelectionRange(wsSearchInput.value.length, wsSearchInput.value.length);

    Array.prototype.forEach.call(document.querySelectorAll('tr[data-ws-row]'), function (tr) {
      tr.addEventListener('click', function (e) {
        if (e.target.closest('button')) return;
        openWorkspaceId = openWorkspaceId === tr.dataset.wsRow ? null : tr.dataset.wsRow;
        paintWorkspaces(filterText);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-impersonate]'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        impersonate(btn.dataset.impersonate, btn.dataset.name);
      });
    });
  }

  function workspaceRow(w) {
    var isOpen = openWorkspaceId === w.organization_id;
    var rows = '<tr data-ws-row="' + esc(w.organization_id) + '" class="is-clickable">' +
      '<td>' + esc(w.name) + '</td>' +
      '<td>' + esc(w.owner_email || '—') + '</td>' +
      '<td>' + timeAgo(w.owner_last_login) + '</td>' +
      '<td class="mono">' + esc(w.buyer_count) + '</td>' +
      '<td>' + timeAgo(w.brief_last_generated_at) + '</td>' +
      '<td>' + badge(w.whatsapp_configured, 'On', 'Off') + '</td>' +
      '<td>' + badge(w.paystack_configured, 'On', 'Off') + '</td>' +
      '<td><button class="btn sm" data-impersonate="' + esc(w.organization_id) + '" data-name="' + esc(w.name) + '">Impersonate</button></td>' +
      '</tr>';

    if (isOpen) {
      rows += '<tr class="detail-row"><td colspan="8"><div class="detail-grid">' +
        detail('Created', fmtDate(w.created_at)) +
        detail('Members', w.member_count) +
        detail('Projects', w.project_count) +
        detail('Units', w.unit_count) +
        detail('Reservations', w.reservation_count) +
        detail('Payments', w.payment_count) +
        detail('Agent actions (7d)', w.agent_actions_7d) +
        detail('Organization id', w.organization_id) +
        '</div></td></tr>';
    }
    return rows;
  }

  function detail(label, value) {
    return '<div><div class="k">' + esc(label) + '</div><div class="v mono">' + esc(value) + '</div></div>';
  }

  function badge(on, onLabel, offLabel) {
    return '<span class="badge ' + (on ? 'good' : 'off') + '">' + esc(on ? onLabel : offLabel) + '</span>';
  }

  function impersonate(orgId, name) {
    api('/workspaces/' + orgId + '/impersonate', { method: 'POST' }).then(function (result) {
      var instructions =
        'localStorage.setItem("re_token", "' + result.token + '"); location.reload();';
      return navigator.clipboard.writeText(instructions).then(function () {
        openModal({
          title: 'Impersonation token copied',
          body:
            '<p>A 2-hour token for <b>' + esc(result.user_email) + '</b> (' + esc(name) + ') is on your clipboard as a ready-to-run snippet.</p>' +
            '<p>Open the app, open the browser console (F12), paste it, and press Enter. You will be signed in as this workspace\'s owner until the token expires.</p>' +
            '<div class="password-box mono" style="word-break:break-all;font-size:11px;">' + esc(instructions) + '</div>',
          okOnly: true,
        });
      });
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  // ── Users ──────────────────────────────────────────────────────────────
  var usersCache = [];

  function renderUsers() {
    return api('/users').then(function (rows) {
      usersCache = rows;
      paintUsers('');
    });
  }

  function paintUsers(filterText) {
    var filtered = usersCache.filter(function (u) {
      if (!filterText) return true;
      var hay = ((u.full_name || '') + ' ' + u.email).toLowerCase();
      return hay.indexOf(filterText.toLowerCase()) !== -1;
    });

    view.innerHTML =
      '<h1 class="page-title">Users</h1>' +
      '<div class="filter-row"><input class="search-input" id="user-search" placeholder="Search by name or email…" value="' + esc(filterText) + '"></div>' +
      '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Name</th><th>Email</th><th>Workspace</th><th>Role</th><th>Created</th><th>Last login</th><th></th>' +
      '</tr></thead><tbody>' +
      (filtered.length ? filtered.map(userRow).join('') : '<tr><td colspan="7"><div class="empty">No users match.</div></td></tr>') +
      '</tbody></table></div>';

    document.getElementById('user-search').addEventListener('input', function (e) { paintUsers(e.target.value); });
    var input = document.getElementById('user-search');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    Array.prototype.forEach.call(document.querySelectorAll('[data-reset]'), function (btn) {
      btn.addEventListener('click', function () { resetPassword(btn.dataset.reset, btn.dataset.email); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-delete-user]'), function (btn) {
      btn.addEventListener('click', function () { confirmDeleteUser(btn.dataset.deleteUser, btn.dataset.email); });
    });
  }

  function userRow(u) {
    return '<tr>' +
      '<td>' + esc(u.full_name || '—') + '</td>' +
      '<td>' + esc(u.email) + '</td>' +
      '<td>' + esc(u.workspace_name) + '</td>' +
      '<td>' + esc(u.role) + '</td>' +
      '<td>' + fmtDate(u.created_at) + '</td>' +
      '<td>' + timeAgo(u.last_login_at) + '</td>' +
      '<td>' +
        '<button class="btn sm" data-reset="' + esc(u.id) + '" data-email="' + esc(u.email) + '">Reset password</button>' +
        '<button class="btn sm danger" data-delete-user="' + esc(u.id) + '" data-email="' + esc(u.email) + '">Delete</button>' +
      '</td>' +
      '</tr>';
  }

  function resetPassword(userId, email) {
    api('/users/' + userId + '/reset-password', { method: 'POST' }).then(function (result) {
      openModal({
        title: 'Password reset',
        body:
          '<p>New password for <b>' + esc(result.email) + '</b>. This is shown once — copy it now.</p>' +
          '<div class="password-box"><span class="mono" id="new-pw">' + esc(result.password) + '</span>' +
          '<button class="btn sm" id="copy-pw">Copy</button></div>',
        okOnly: true,
        onOpen: function () {
          document.getElementById('copy-pw').addEventListener('click', function () {
            navigator.clipboard.writeText(result.password);
            toast('Copied.', 'ok');
          });
        },
      });
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function confirmDeleteUser(userId, email) {
    openModal({
      title: 'Hard delete ' + email + '?',
      body:
        '<p>This permanently deletes the user row. If they are the last active member of a workspace ' +
        '(including their own solo account), that entire workspace — every buyer, payment, project and ' +
        'document in it — is permanently deleted too. <b>This cannot be undone; there is no soft-delete, ' +
        'no bin, no restore.</b></p>',
      confirmLabel: 'Permanently delete',
      danger: true,
      onConfirm: function () {
        return api('/users/' + userId, { method: 'DELETE' }).then(function (result) {
          toast('Deleted ' + result.deleted_user + (result.workspaces_wiped ? ' and ' + result.workspaces_wiped + ' workspace(s)' : '') + '.', 'ok');
          return renderUsers();
        });
      },
    });
  }

  // ── Agents ─────────────────────────────────────────────────────────────
  var agentFilters = { org: '', agent: '', outcome: '' };

  function renderAgents() {
    return loadAgents();
  }

  function loadAgents() {
    var qs = [];
    if (agentFilters.org) qs.push('org=' + encodeURIComponent(agentFilters.org));
    if (agentFilters.agent) qs.push('agent=' + encodeURIComponent(agentFilters.agent));
    if (agentFilters.outcome) qs.push('outcome=' + encodeURIComponent(agentFilters.outcome));
    return api('/agents' + (qs.length ? '?' + qs.join('&') : '')).then(function (rows) {
      view.innerHTML =
        '<h1 class="page-title">Agent actions</h1>' +
        '<div class="filter-row">' +
          '<input class="search-input" id="agent-org" placeholder="Filter by org name/id…" value="' + esc(agentFilters.org) + '">' +
          '<select class="filter" id="agent-name-filter">' +
            '<option value="">All agents</option>' +
            ['collections', 'document', 'sales', 'finance', 'market-intel'].map(function (a) {
              return '<option value="' + a + '"' + (agentFilters.agent === a ? ' selected' : '') + '>' + a + '</option>';
            }).join('') +
          '</select>' +
          '<select class="filter" id="agent-outcome-filter">' +
            '<option value="">All outcomes</option>' +
            '<option value="success"' + (agentFilters.outcome === 'success' ? ' selected' : '') + '>Success</option>' +
            '<option value="failed"' + (agentFilters.outcome === 'failed' ? ' selected' : '') + '>Failed</option>' +
          '</select>' +
          '<span class="muted">' + rows.length + ' row(s), last 500</span>' +
        '</div>' +
        '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th>Agent</th><th>Org</th><th>Buyer</th><th>Action</th><th>Outcome</th><th>When</th>' +
        '</tr></thead><tbody>' +
        (rows.length ? rows.map(function (r) {
          return '<tr>' +
            '<td>' + esc(r.agent_name) + '</td>' +
            '<td>' + esc(r.org_name) + '</td>' +
            '<td>' + esc(r.customer_name || '—') + '</td>' +
            '<td>' + esc(r.action_type) + '</td>' +
            '<td>' + badge(r.outcome === 'success', 'Success', esc(r.outcome)) + '</td>' +
            '<td>' + timeAgo(r.created_at) + '</td>' +
            '</tr>';
        }).join('') : '<tr><td colspan="6"><div class="empty">No agent actions match.</div></td></tr>') +
        '</tbody></table></div>';

      document.getElementById('agent-org').addEventListener('change', function (e) { agentFilters.org = e.target.value; loadAgents(); });
      document.getElementById('agent-name-filter').addEventListener('change', function (e) { agentFilters.agent = e.target.value; loadAgents(); });
      document.getElementById('agent-outcome-filter').addEventListener('change', function (e) { agentFilters.outcome = e.target.value; loadAgents(); });
    });
  }

  // ── Notifications ──────────────────────────────────────────────────────
  function renderNotifications() {
    return api('/notifications').then(function (d) {
      var byType = Object.keys(d.by_type || {}).map(function (k) {
        return kpi(k, d.by_type[k]);
      }).join('');

      view.innerHTML =
        '<h1 class="page-title">Notifications</h1>' +
        '<div class="kpi-grid">' +
          kpi('Total sent', d.total_sent) +
          kpi('Total failed', d.total_failed) +
          kpi('Failed rate', d.failed_rate + '%') +
        '</div>' +
        (byType ? '<div class="kpi-grid">' + byType + '</div>' : '') +
        '<div class="card"><div class="card-head"><h2>Last 100 failed</h2></div>' +
        '<div class="table-wrap"><table class="data"><thead><tr><th>Channel</th><th>Recipient</th><th>Reason</th><th>When</th></tr></thead><tbody>' +
        (d.recent_failures.length ? d.recent_failures.map(function (f) {
          return '<tr><td>' + esc(f.channel) + '</td><td>' + esc(f.recipient || '—') + '</td>' +
            '<td>' + esc(f.reason || '—') + '</td><td>' + timeAgo(f.created_at) + '</td></tr>';
        }).join('') : '<tr><td colspan="4"><div class="empty">No failures recorded.</div></td></tr>') +
        '</tbody></table></div></div>';
    });
  }

  // ── Health ─────────────────────────────────────────────────────────────
  function renderHealth() {
    return api('/health').then(function (d) {
      view.innerHTML =
        '<h1 class="page-title">Health</h1>' +
        '<div class="kpi-grid">' +
          kpi('Last cron run', d.last_cron_run ? timeAgo(d.last_cron_run.started_at) : 'never') +
          kpi('OpenAI calls this month', d.openai_calls_this_month) +
          kpi('Failed webhooks (7d)', d.failed_webhooks_7d) +
        '</div>' +
        '<div class="card"><div class="card-head"><h2>Migrations</h2></div>' +
        '<div class="table-wrap"><table class="data"><thead><tr><th>File</th><th>Status</th></tr></thead><tbody>' +
        d.migrations.map(function (m) {
          return '<tr><td class="mono">' + esc(m.file) + '</td><td>' + badge(m.applied, 'Applied', 'Not applied') + '</td></tr>';
        }).join('') +
        '</tbody></table></div></div>';
    });
  }

  // ── Modal ──────────────────────────────────────────────────────────────
  function openModal(opts) {
    var overlay = document.getElementById('overlay');
    overlay.innerHTML =
      '<div class="scrim" id="scrim">' +
        '<div class="modal">' +
          '<div class="modal-head">' + esc(opts.title) + '</div>' +
          '<div class="modal-body">' + opts.body + '</div>' +
          '<div class="modal-foot">' +
            (opts.okOnly
              ? '<button class="btn primary" id="modal-ok">Done</button>'
              : '<button class="btn" id="modal-cancel">Cancel</button>' +
                '<button class="btn ' + (opts.danger ? 'danger' : 'primary') + '" id="modal-confirm">' + esc(opts.confirmLabel || 'Confirm') + '</button>') +
          '</div>' +
        '</div>' +
      '</div>';

    function close() { overlay.innerHTML = ''; }

    document.getElementById('scrim').addEventListener('click', function (e) { if (e.target.id === 'scrim') close(); });
    if (opts.okOnly) {
      document.getElementById('modal-ok').addEventListener('click', close);
    } else {
      document.getElementById('modal-cancel').addEventListener('click', close);
      document.getElementById('modal-confirm').addEventListener('click', function () {
        var btn = document.getElementById('modal-confirm');
        btn.textContent = 'Working…';
        btn.disabled = true;
        Promise.resolve(opts.onConfirm()).then(close).catch(function (err) {
          toast(err.message, 'err');
          close();
        });
      });
    }
    if (opts.onOpen) opts.onOpen();
  }
})();
