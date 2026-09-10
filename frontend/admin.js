// admin.js — the whole admin dashboard's logic, deliberately self-contained.
//
// No shared code with realestate.js/screens.js (the operator app) or
// portal.js (the buyer portal) — this file duplicates the handful of small
// helpers (naira formatting, escaping, toasts) it needs rather than importing
// them, on purpose (see admin.html's own header comment for why).
//
// API_BASE is the one exception: it reads window.__API_BASE__, set by
// config.js (loaded before this file — see admin.html). That is NOT
// reinvented here, on purpose — this page's own origin (wherever Vercel
// serves frontend/ from) is not the API's origin (Render) in production;
// only local dev has them the same. config.js is already the single place
// that distinction is handled correctly, and duplicating it here was a
// real, shipped bug: admin.js used to compute window.location.origin +
// '/api/admin' directly, which resolved to the Vercel domain itself in
// production — a domain with no /api/admin route at all — so every fetch
// from this page 404'd (or worse, hit Vercel's own catch-all) the moment
// it was deployed anywhere but localhost.
(function () {
  'use strict';

  var API_BASE = (window.__API_BASE__ || '/api') + '/admin';

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

  // AUDIT FIX (AD13) — same staleness guard loadAgents() already applies by
  // hand (agentLoadToken, further down) generalized for reuse across every
  // other section. Two overlapping requests for the SAME section — two
  // quick clicks on the refresh button, or a fast navigate-away-and-back —
  // can resolve out of order; without this, a slower earlier response
  // landing after a faster later one silently overwrites the screen with
  // outdated data. start() is called right before firing the request,
  // isStale(mine) once its response lands — true means a newer call for
  // this same section has already started, so this response must be
  // dropped rather than painted.
  function staleGuard() {
    var token = 0;
    return {
      start: function () { return ++token; },
      isStale: function (mine) { return mine !== token; },
    };
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

  // ── Global error capture ─────────────────────────────────────────────
  // AUDIT FIX (FE3) — same pattern realestate.js's own reportClientError
  // uses, posting to the admin-specific endpoint (routes/admin.js's own
  // POST /client-errors) that already existed and tags reports app:'admin'
  // — this page just never called it. Fire-and-forget and self-contained:
  // a reporter that itself threw would recurse through the very 'error'
  // listener it's registered on, so the whole body is wrapped.
  function reportClientError(message, stack) {
    try {
      if (!sessionStorage.getItem(SECRET_KEY)) return; // not signed in yet — nothing to attach the report to
      api('/client-errors', {
        method: 'POST',
        body: {
          message: String(message || '(no message)'),
          stack: stack || null,
          // AUDIT FIX (AD10) — window.location.hash is already a substring of
          // window.location.href below (the fragment after '#'); sending both
          // duplicated the same value under two keys. The server derives
          // `screen` from `url` instead (routes/admin.js), so grouping by
          // screen in the Errors tab is unchanged.
          url: window.location.href,
          user_agent: navigator.userAgent,
        },
      }).catch(function () { /* nothing to do if even the report fails */ });
    } catch (e) { /* the reporter must never itself throw */ }
  }

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

  // ── Login ──────────────────────────────────────────────────────────────
  var loginScreen = document.getElementById('login-screen');
  var appShell = document.getElementById('app-shell');
  var loginForm = document.getElementById('login-form');
  var loginError = document.getElementById('login-error');

  function showApp() {
    loginScreen.hidden = true;
    appShell.hidden = false;
    // URL hash persistence — a reload (or a bookmarked/shared link) lands
    // back on whichever section was open, not always Overview. SECTIONS is
    // guaranteed assigned by the time showApp() actually runs: it is only
    // ever called from the login handler or the bottom-of-file session
    // check, both of which fire after this whole script has finished
    // evaluating — see that check's own comment for why the ordering here
    // matters at all.
    var hashSection = String(window.location.hash || '').replace(/^#/, '');
    goToSection(SECTIONS[hashSection] ? hashSection : 'overview');

    // AUDIT FIX (AD7) — a real build identifier instead of the static
    // "Archta Admin" label the sidebar always showed. Best-effort: this is
    // cosmetic, so a failed fetch just leaves the static label in place
    // rather than doing anything a signed-in admin would notice or care about.
    api('/version').then(function (result) {
      var el = document.querySelector('.sidebar-version');
      if (el && result.version) el.textContent = 'v' + result.version;
    }).catch(function () {});
  }

  document.getElementById('btn-sign-out').addEventListener('click', function () {
    sessionStorage.removeItem(SECRET_KEY);
    window.location.reload();
  });

  // AUDIT FIX (AD2/AD3) — same 401-redirect + Errors-tab-report pattern
  // goToSection's own catch (below) already applies to a full section
  // load, factored out for callers that fire from content ALREADY on
  // screen — a filter change, a manual refresh — where wiping the whole
  // view the way goToSection does would throw away what's already
  // rendered for no reason. A toast instead.
  function handleActionError(err) {
    if (err.status === 401) {
      sessionStorage.removeItem(SECRET_KEY);
      loginScreen.hidden = false;
      appShell.hidden = true;
      return;
    }
    if (typeof err.status !== 'number') reportClientError(err.message, err.stack);
    toast(err.message, 'err');
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

  // ── Nav / router ───────────────────────────────────────────────────────
  var view = document.getElementById('view');
  var currentSection = null;
  var overviewAutoRefreshTimer = null;
  var overviewLastRefreshedAt = null;

  function stopOverviewAutoRefresh() {
    if (overviewAutoRefreshTimer) { clearInterval(overviewAutoRefreshTimer); overviewAutoRefreshTimer = null; }
  }

  // Only ever armed while Overview is the visible section — goToSection
  // stops it on every navigation away, and renderOverview re-arms it once
  // loaded, so leaving the tab open elsewhere never fires a silent fetch
  // for a screen nobody is looking at.
  function startOverviewAutoRefresh() {
    stopOverviewAutoRefresh();
    overviewAutoRefreshTimer = setInterval(function () {
      // AUDIT FIX (AD11) — the .catch() below only guards a REJECTED
      // promise; a synchronous throw before renderOverview() even returns
      // one would otherwise escape this callback uncaught, and (depending on
      // the environment) a tick that throws can be the last one that ever
      // fires. try/catch guarantees one bad tick never stops the schedule —
      // startOverviewAutoRefresh only re-arms on a SUCCESSFUL render
      // (see renderOverview), so this interval is what keeps retrying
      // through a run of transient failures.
      try {
        if (currentSection === 'overview') renderOverview().catch(function () {});
      } catch (e) { /* transient failure — the next tick tries again */ }
    }, 5 * 60 * 1000);
  }

  // A title row with a manual refresh button, reused by every section —
  // clicking it just re-runs whatever SECTIONS[currentSection] already is,
  // so this one delegated listener (below) covers every tab without each
  // render function wiring its own.
  function pageTitleRow(title) {
    return '<div class="page-title-row"><h1 class="page-title">' + esc(title) + '</h1>' +
      '<button class="btn-icon-refresh" id="btn-section-refresh" type="button" title="Refresh" aria-label="Refresh">' +
        '<i class="ti ti-refresh"></i></button></div>';
  }
  var SECTIONS = {
    overview: renderOverview,
    workspaces: renderWorkspaces,
    users: renderUsers,
    agents: renderAgents,
    notifications: renderNotifications,
    health: renderHealth,
    revenue: renderRevenue,
    usage: renderUsage,
    errors: renderClientErrors,
  };

  document.getElementById('nav').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-section]');
    if (!btn) return;
    goToSection(btn.dataset.section);
  });

  // Delegated on `view` itself (which survives every innerHTML replace,
  // unlike anything inside it) so pageTitleRow's refresh button works on
  // every section without each render function wiring its own listener.
  view.addEventListener('click', function (e) {
    var btn = e.target.closest('#btn-section-refresh');
    if (!btn || !currentSection) return;
    btn.classList.add('is-spinning');
    // AUDIT FIX (AD3) — used to just blank the whole section with the raw
    // error text, with no 401 handling and nothing reaching the Errors
    // tab. A refresh failing leaves whatever was already on screen alone
    // (removing the spin so the button does not stay stuck) and toasts.
    SECTIONS[currentSection]().catch(function (err) {
      btn.classList.remove('is-spinning');
      handleActionError(err);
    });
  });

  function goToSection(name) {
    currentSection = name;
    window.location.hash = name;
    stopOverviewAutoRefresh();
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
      // Same distinction realestate.js's renderFailure makes: api() attaches
      // a numeric status to every error that actually reached the network,
      // so no status at all means this section's own render code broke, not
      // the server. Reported so it shows up on the Errors tab itself —
      // deliberately not gated behind "is this even the Errors tab", since a
      // bug in some OTHER section is exactly what needs to surface there.
      if (typeof err.status !== 'number') {
        api('/client-errors', {
          method: 'POST',
          body: { message: err.message, stack: err.stack, screen: name, url: window.location.hash, user_agent: navigator.userAgent },
        }).catch(function () {});
      }
      view.innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
    });
  }

  // ── Overview ───────────────────────────────────────────────────────────
  var overviewGuard = staleGuard();
  function renderOverview() {
    var mine = overviewGuard.start();
    return api('/overview').then(function (d) {
      if (overviewGuard.isStale(mine)) return;
      overviewLastRefreshedAt = new Date();
      view.innerHTML =
        pageTitleRow('Overview') +
        '<p class="muted" id="overview-last-refreshed">Last refreshed ' + timeAgo(overviewLastRefreshedAt) + '</p>' +
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
      startOverviewAutoRefresh();
    });
  }

  function kpi(label, value) {
    return '<div class="kpi"><div class="kpi-label">' + esc(label) + '</div><div class="kpi-value">' + esc(value) + '</div></div>';
  }

  // ── SECTION 21 — Revenue ──────────────────────────────────────────────────
  // Archta's OWN subscription revenue, not a developer workspace's collected
  // installments (that number is "Total collected" on Overview) — see
  // adminService.revenue's own header comment for why these are two
  // completely different figures that happen to share a currency symbol.
  var MRR_BAR_HEIGHT_CLASSES = ['h0', 'h10', 'h20', 'h30', 'h40', 'h50', 'h60', 'h70', 'h80', 'h90', 'h100'];
  var MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var revenueGuard = staleGuard();
  function renderRevenue() {
    var mine = revenueGuard.start();
    return api('/revenue').then(function (d) {
      if (revenueGuard.isStale(mine)) return;
      var peak = Math.max.apply(null, d.monthly_mrr_last_12.map(function (m) { return m.mrr; }).concat([1]));

      view.innerHTML =
        pageTitleRow('Revenue') +
        '<div class="kpi-grid">' +
          kpi('MRR', naira(d.mrr)) +
          kpi('Paying customers', d.total_paying_customers) +
          kpi('Avg revenue / customer', naira(d.average_revenue_per_customer)) +
          kpi('Churn rate (this month)', d.churn_rate + '%') +
          // AUDIT FIX (AD8) — adminService.revenue() sends null, not 0, when
          // there was no MRR at the start of this month to grow from (the
          // platform's first month) — "+0%"/"0%" reads as real flat growth,
          // a different and false claim from "there is nothing to compare
          // against yet".
          kpi('Monthly growth rate', d.monthly_growth_rate == null
            ? 'First month'
            : (d.monthly_growth_rate > 0 ? '+' : '') + d.monthly_growth_rate + '%') +
          kpi('Plans represented', Object.keys(d.mrr_by_plan).length) +
        '</div>' +

        '<div class="card"><div class="card-head"><h2>MRR by plan</h2></div><div class="card-body">' +
          (Object.keys(d.mrr_by_plan).length
            ? Object.keys(d.mrr_by_plan).sort(function (a, b) { return d.mrr_by_plan[b] - d.mrr_by_plan[a]; }).map(function (plan) {
                return '<div class="mrr-plan-row">' +
                  '<span>' + esc(plan) + '</span><span class="mono">' + naira(d.mrr_by_plan[plan]) + '</span></div>';
              }).join('')
            : '<div class="empty">No active subscriptions yet.</div>') +
        '</div></div>' +

        '<div class="card"><div class="card-head"><h2>MRR, last 12 months</h2></div><div class="card-body">' +
          '<div class="mrr-chart">' +
            d.monthly_mrr_last_12.map(function (m) {
              var bucket = m.mrr <= 0 ? 'h0' : MRR_BAR_HEIGHT_CLASSES[Math.min(10, Math.max(1, Math.round((m.mrr / peak) * 10)))];
              var monthNum = Number(m.month.slice(5, 7)) - 1;
              return '<div class="mrr-bar-col" title="' + esc(m.month + ': ' + naira(m.mrr)) + '">' +
                '<div class="mrr-bar-track"><div class="mrr-bar mrr-bar-' + bucket + '"></div></div>' +
                '<div class="mrr-bar-label">' + esc(MONTH_ABBR[monthNum] || m.month.slice(5)) + '</div>' +
              '</div>';
            }).join('') +
          '</div>' +
        '</div></div>';
    });
  }

  // ── SECTION 22 — Feature usage ─────────────────────────────────────────────
  // Which features are actually being used, across every workspace, last 30
  // days. The heat grid caps at the 30 busiest workspaces (by total events) —
  // a platform-wide grid with no cap would render one <td> per org per
  // feature, and the busiest handful is what an operator scanning for "is
  // anyone using X" actually needs to see first.
  var USAGE_FEATURE_LABEL = {
    brief_generated: 'Brief generated',
    payment_recorded: 'Payment recorded',
    document_generated: 'Document generated',
    agent_action: 'Agent action',
    portal_opened: 'Portal opened',
    whatsapp_sent: 'WhatsApp sent',
    import_used: 'Import used',
    hardship_requested: 'Hardship requested',
    community_posted: 'Community posted',
    referral_made: 'Referral made',
  };
  var USAGE_HEAT_CLASSES = ['usage-heat-0', 'usage-heat-1', 'usage-heat-2', 'usage-heat-3', 'usage-heat-4', 'usage-heat-5'];
  var USAGE_WORKSPACE_CAP = 30;

  function usageHeatClass(count, max) {
    if (!count) return USAGE_HEAT_CLASSES[0];
    if (!max) return USAGE_HEAT_CLASSES[1];
    var bucket = Math.min(5, Math.max(1, Math.ceil((count / max) * 5)));
    return USAGE_HEAT_CLASSES[bucket];
  }

  var usageGuard = staleGuard();
  function renderUsage() {
    var mine = usageGuard.start();
    return api('/feature-usage').then(function (d) {
      if (usageGuard.isStale(mine)) return;
      var features = d.features || Object.keys(USAGE_FEATURE_LABEL);
      var sortedFeatures = features.slice().sort(function (a, b) { return (d.by_feature[b] || 0) - (d.by_feature[a] || 0); });

      var topWorkspaces = (d.workspaces || []).slice(0, USAGE_WORKSPACE_CAP);
      var maxCell = topWorkspaces.reduce(function (max, w) {
        return Math.max(max, Math.max.apply(null, features.map(function (f) { return w.features[f] || 0; }).concat([0])));
      }, 0);

      view.innerHTML =
        pageTitleRow('Usage') +
        '<p class="muted">Since ' + esc(d.since) + ' — every workspace on the platform.</p>' +

        '<div class="card"><div class="card-head"><h2>Feature usage, last 30 days</h2></div><div class="card-body">' +
          '<div class="table-wrap"><table class="data"><thead><tr><th>Feature</th><th>Events</th></tr></thead><tbody>' +
          (sortedFeatures.length
            ? sortedFeatures.map(function (f) {
                var count = d.by_feature[f] || 0;
                return '<tr><td>' + esc(USAGE_FEATURE_LABEL[f] || f) + '</td><td class="mono">' + esc(count) +
                  '</td></tr>';
              }).join('')
            : '<tr><td colspan="2"><div class="empty">No feature events recorded yet.</div></td></tr>') +
          '</tbody></table></div>' +
        '</div></div>' +

        '<div class="card"><div class="card-head"><h2>Usage by workspace</h2></div><div class="card-body">' +
          (topWorkspaces.length
            ? '<div class="table-wrap"><table class="data usage-grid"><thead><tr><th>Workspace</th>' +
                features.map(function (f) { return '<th title="' + esc(USAGE_FEATURE_LABEL[f] || f) + '">' + esc((USAGE_FEATURE_LABEL[f] || f).replace(' ', '\n')) + '</th>'; }).join('') +
              '</tr></thead><tbody>' +
              topWorkspaces.map(function (w) {
                return '<tr><td>' + esc(w.name) + '</td>' +
                  features.map(function (f) {
                    var count = w.features[f] || 0;
                    // AUDIT FIX (AD9) — the one cell in this file whose
                    // content landed in markup with no esc() call at all
                    // (the title attribute right above it already had one).
                    // count is always a number today, so this was never
                    // exploitable, but it's the one interpolation with no
                    // escaping path if that ever stops being true.
                    return '<td class="usage-cell ' + usageHeatClass(count, maxCell) + '" title="' + esc((USAGE_FEATURE_LABEL[f] || f) + ': ' + count) + '">' +
                      esc(count || '') + '</td>';
                  }).join('') +
                '</tr>';
              }).join('') +
              '</tbody></table></div>'
            : '<div class="empty">No workspace has used a tracked feature in the last 30 days.</div>') +
        '</div></div>';
    });
  }

  // ── Client-side error reporting ────────────────────────────────────────
  // Grouped by (app, screen, message) for display — the backend stores one
  // row per occurrence (clientErrorService.js), same reasoning re_feature_events
  // stores one row per day rather than one per event: nobody triaging this
  // wants to scroll past 40 identical rows for the same bug to find the
  // next distinct one.
  var clientErrorsCache = [];
  var openErrorGroupKey = null;

  // AUDIT FIX (AD4) — two occurrences of the same bug rarely produce
  // byte-identical text: a line:column reference shifts with every deploy,
  // a memory address is different every process, and an id or amount
  // embedded in the message (a customer id, a status code, a count) is
  // different every time by definition — none of that changes WHICH bug
  // this is. Grouping on the raw message scattered one recurring bug
  // across dozens of one-row "groups", each reading as an isolated
  // one-off. Used only to build the grouping key below — the displayed
  // message (g.message) stays the real, original text of the row grouped
  // into it, so an admin reading a group still sees a concrete example,
  // not a genericized placeholder.
  function normalizeErrorMessage(message) {
    return String(message || '')
      .replace(/0x[0-9a-f]+/gi, '0xN')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
      .replace(/:\d+:\d+\)?/g, ':N:N')
      .replace(/\bline \d+\b/gi, 'line N')
      .replace(/\b\d+\b/g, 'N');
  }

  function groupClientErrors(rows) {
    var byKey = new Map();
    rows.forEach(function (r) {
      var key = r.app + '|' + (r.screen || '') + '|' + normalizeErrorMessage(r.message);
      if (!byKey.has(key)) {
        byKey.set(key, {
          key: key, app: r.app, screen: r.screen, message: r.message,
          count: 0, firstSeen: r.created_at, lastSeen: r.created_at,
          sampleStack: r.stack, orgNames: new Set(), unresolvedIds: [],
        });
      }
      var g = byKey.get(key);
      g.count += 1;
      if (r.created_at < g.firstSeen) g.firstSeen = r.created_at;
      if (r.created_at > g.lastSeen) { g.lastSeen = r.created_at; g.sampleStack = r.stack; }
      if (r.org_name) g.orgNames.add(r.org_name);
      if (!r.resolved_at) g.unresolvedIds.push(r.id);
    });
    return [...byKey.values()].sort(function (a, b) {
      var openDiff = (b.unresolvedIds.length > 0) - (a.unresolvedIds.length > 0);
      return openDiff || (new Date(b.lastSeen) - new Date(a.lastSeen));
    });
  }

  var clientErrorsGuard = staleGuard();
  function renderClientErrors() {
    var mine = clientErrorsGuard.start();
    return api('/client-errors').then(function (rows) {
      if (clientErrorsGuard.isStale(mine)) return;
      clientErrorsCache = rows;
      paintClientErrors();
    });
  }

  function paintClientErrors() {
    var groups = groupClientErrors(clientErrorsCache);
    var openCount = groups.filter(function (g) { return g.unresolvedIds.length > 0; }).length;
    var distinctScreens = new Set(clientErrorsCache.map(function (r) { return r.app + '/' + (r.screen || '—'); })).size;

    view.innerHTML =
      pageTitleRow('Errors') +
      '<p class="muted">Client-side bugs reported by the operator and admin apps, last 30 days — grouped by app, screen and message.</p>' +
      '<div class="kpi-grid">' +
        kpi('Open', openCount) +
        kpi('Total events', clientErrorsCache.length) +
        kpi('Screens affected', distinctScreens) +
      '</div>' +
      '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>App</th><th>Screen</th><th>Message</th><th>Count</th><th>Last seen</th><th>Status</th><th></th>' +
      '</tr></thead><tbody>' +
      (groups.length ? groups.map(clientErrorRow).join('') : '<tr><td colspan="7"><div class="empty">No client errors reported in the last 30 days.</div></td></tr>') +
      '</tbody></table></div>';

    Array.prototype.forEach.call(document.querySelectorAll('tr[data-error-row]'), function (tr) {
      tr.addEventListener('click', function (e) {
        if (e.target.closest('button')) return;
        openErrorGroupKey = openErrorGroupKey === tr.dataset.errorRow ? null : tr.dataset.errorRow;
        paintClientErrors();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-resolve-group]'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var group = groups.find(function (g) { return g.key === btn.dataset.resolveGroup; });
        if (!group || !group.unresolvedIds.length) return;
        api('/client-errors/resolve', { method: 'POST', body: { ids: group.unresolvedIds } })
          .then(function () { toast('Marked resolved.', 'ok'); return renderClientErrors(); })
          .catch(function (err) { toast(err.message, 'err'); });
      });
    });
  }

  function clientErrorRow(g) {
    var isOpen = openErrorGroupKey === g.key;
    var isResolved = g.unresolvedIds.length === 0;
    var row = '<tr data-error-row="' + esc(g.key) + '" class="is-clickable">' +
      '<td>' + esc(g.app) + '</td>' +
      '<td class="mono">' + esc(g.screen || '—') + '</td>' +
      '<td>' + esc(g.message.length > 100 ? g.message.slice(0, 100) + '…' : g.message) + '</td>' +
      '<td class="mono">' + g.count + '</td>' +
      '<td>' + timeAgo(g.lastSeen) + '</td>' +
      '<td><span class="badge ' + (isResolved ? 'good' : 'bad') + '">' + (isResolved ? 'Resolved' : 'Open') + '</span></td>' +
      '<td>' + (isResolved ? '' : '<button class="btn sm" data-resolve-group="' + esc(g.key) + '">Mark resolved</button>') + '</td>' +
      '</tr>';

    if (isOpen) {
      row += '<tr class="detail-row"><td colspan="7"><div class="detail-grid">' +
        detail('First seen', fmtDate(g.firstSeen)) +
        detail('Last seen', fmtDate(g.lastSeen)) +
        detail('Occurrences', g.count) +
        detail('Workspaces affected', g.orgNames.size ? [...g.orgNames].join(', ') : '—') +
        '</div>' +
        '<div class="onboarding-block"><div class="k">Stack trace</div>' +
          '<pre class="error-stack">' + esc(g.sampleStack || '(no stack captured)') + '</pre>' +
        '</div>' +
      '</td></tr>';
    }
    return row;
  }

  // ── Workspaces ─────────────────────────────────────────────────────────
  var workspacesCache = [];
  var openWorkspaceId = null;
  var onboardingCache = {}; // SECTION 23 — org id -> checklist response, fetched lazily on row expand
  var PROGRESS_WIDTH_CLASSES = ['w0', 'w10', 'w20', 'w30', 'w40', 'w50', 'w60', 'w70', 'w80', 'w90', 'w100'];

  var workspacesGuard = staleGuard();
  function renderWorkspaces() {
    var mine = workspacesGuard.start();
    return api('/workspaces').then(function (rows) {
      if (workspacesGuard.isStale(mine)) return;
      workspacesCache = rows;
      paintWorkspaces('');
    });
  }

  // AUDIT FIX (AD12) — focusSearch defaults true (initial load from
  // renderWorkspaces, and every keystroke in the box itself, both need the
  // rebuilt input refocused with its cursor restored — see AD12's own note
  // at the row-click handler below for why a plain re-render would
  // otherwise make typing impossible). The three row-click-triggered
  // repaints below pass false: expanding or collapsing a row is not a
  // reason to yank focus back to a search box the admin was not using.
  function paintWorkspaces(filterText, focusSearch) {
    if (focusSearch === undefined) focusSearch = true;
    var filtered = workspacesCache.filter(function (w) {
      if (!filterText) return true;
      var hay = (w.name + ' ' + (w.owner_email || '')).toLowerCase();
      return hay.indexOf(filterText.toLowerCase()) !== -1;
    });

    view.innerHTML =
      pageTitleRow('Workspaces') +
      '<div class="filter-row"><input class="search-input" id="ws-search" placeholder="Search by name or owner email…" value="' + esc(filterText) + '"></div>' +
      '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Name</th><th>Owner</th><th>Last login</th><th>Buyers</th><th>Brief last generated</th><th>WhatsApp</th><th>Paystack</th><th></th>' +
      '</tr></thead><tbody>' +
      (filtered.length ? filtered.map(workspaceRow).join('') : '<tr><td colspan="8"><div class="empty">No workspaces match.</div></td></tr>') +
      '</tbody></table></div>';

    var wsSearchInput = document.getElementById('ws-search');
    wsSearchInput.addEventListener('input', function (e) { paintWorkspaces(e.target.value); });
    if (focusSearch) {
      wsSearchInput.focus();
      wsSearchInput.setSelectionRange(wsSearchInput.value.length, wsSearchInput.value.length);
    }

    Array.prototype.forEach.call(document.querySelectorAll('tr[data-ws-row]'), function (tr) {
      tr.addEventListener('click', function (e) {
        if (e.target.closest('button')) return;
        var id = tr.dataset.wsRow;
        if (openWorkspaceId === id) {
          openWorkspaceId = null;
          paintWorkspaces(filterText, false);
          return;
        }
        openWorkspaceId = id;
        paintWorkspaces(filterText, false);
        if (!onboardingCache[id]) {
          api('/workspaces/' + id + '/onboarding').then(function (data) {
            onboardingCache[id] = data;
            if (openWorkspaceId === id) paintWorkspaces(filterText, false);
          }).catch(function () { /* best-effort — the rest of the detail panel still works */ });
        }
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-impersonate]'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        impersonate(btn.dataset.impersonate, btn.dataset.name);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-send-test-brief]'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var orgId = btn.dataset.sendTestBrief;
        btn.disabled = true;
        btn.textContent = 'Sending…';
        api('/workspaces/' + orgId + '/send-test-brief', { method: 'POST' }).then(function (result) {
          toast('Brief generated (' + result.generated_by + ').', 'ok');
          btn.disabled = false;
          btn.textContent = 'Send test brief';
        }).catch(function (err) {
          toast(err.message, 'err');
          btn.disabled = false;
          btn.textContent = 'Send test brief';
        });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-reset-brief-cache]'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var orgId = btn.dataset.resetBriefCache;
        btn.disabled = true;
        btn.textContent = 'Clearing…';
        api('/workspaces/' + orgId + '/reset-brief-cache', { method: 'POST' }).then(function (result) {
          toast(result.cleared ? 'Cleared — regenerates at the next 07:00 run.' : 'No cached brief for today.', 'ok');
          btn.disabled = false;
          btn.textContent = 'Reset brief cache';
        }).catch(function (err) {
          toast(err.message, 'err');
          btn.disabled = false;
          btn.textContent = 'Reset brief cache';
        });
      });
    });
  }

  var INACTIVE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
  function isWorkspaceInactive(w) {
    return !w.owner_last_login || (Date.now() - new Date(w.owner_last_login).getTime()) > INACTIVE_THRESHOLD_MS;
  }

  function workspaceRow(w) {
    var isOpen = openWorkspaceId === w.organization_id;
    var rows = '<tr data-ws-row="' + esc(w.organization_id) + '" class="is-clickable">' +
      '<td>' + esc(w.name) + '</td>' +
      '<td>' + esc(w.owner_email || '—') + '</td>' +
      '<td>' + timeAgo(w.owner_last_login) +
        (isWorkspaceInactive(w) ? ' <span class="badge warn">Inactive</span>' : '') + '</td>' +
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
        '</div>' +
        onboardingBlock(onboardingCache[w.organization_id]) +
        '<div class="onboarding-block">' +
          '<div class="k">Quick actions</div>' +
          '<button class="btn sm" data-send-test-brief="' + esc(w.organization_id) + '">Send test brief</button>' +
          '<button class="btn sm" data-reset-brief-cache="' + esc(w.organization_id) + '">Reset brief cache</button>' +
        '</div>' +
        '</td></tr>';
    }
    return rows;
  }

  // SECTION 23 — the same checklist the workspace's own dashboard shows,
  // read-only here: this is what an operator checks before a support call
  // ("have they even added a buyer yet?").
  function onboardingBlock(data) {
    if (!data) return '<div class="onboarding-block"><div class="k">Onboarding</div><div class="muted">Loading…</div></div>';
    var pct = Math.round((data.completed_count / data.total_count) * 100);
    var bucket = 'onboarding-bar-' + PROGRESS_WIDTH_CLASSES[Math.round(pct / 10)];
    return '<div class="onboarding-block">' +
      '<div class="k">Onboarding — ' + data.completed_count + '/' + data.total_count + '</div>' +
      '<div class="onboarding-bar-track"><div class="onboarding-bar ' + bucket + '"></div></div>' +
      '<ul class="onboarding-steps">' +
        data.steps.map(function (s) {
          return '<li class="' + (s.done ? 'done' : '') + '">' + (s.done ? '✓' : '○') + ' ' + esc(s.label) + '</li>';
        }).join('') +
      '</ul>' +
    '</div>';
  }

  function detail(label, value) {
    return '<div><div class="k">' + esc(label) + '</div><div class="v mono">' + esc(value) + '</div></div>';
  }

  function badge(on, onLabel, offLabel) {
    return '<span class="badge ' + (on ? 'good' : 'off') + '">' + esc(on ? onLabel : offLabel) + '</span>';
  }

  function impersonate(orgId, name) {
    api('/workspaces/' + orgId + '/impersonate', { method: 'POST' }).then(function (result) {
      // realestate.js's own session storage keys (its TOKEN_KEY/WORKSPACE_KEY
      // constants) are 'archta.token' / 'archta.workspace', not 're_token' —
      // this snippet used the wrong key for the token entirely, so pasting
      // it and reloading left the app exactly as signed-out as before,
      // silently. archta.workspace is set too, not just the token: without
      // it, an owner who belongs to more than one workspace would sign in
      // to whichever membership resolves oldest-first rather than the
      // workspace this modal actually names.
      var instructions =
        'localStorage.setItem("archta.token", "' + result.token + '"); ' +
        'localStorage.setItem("archta.workspace", "' + orgId + '"); location.reload();';
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

  var usersGuard = staleGuard();
  function renderUsers() {
    var mine = usersGuard.start();
    return api('/users').then(function (rows) {
      if (usersGuard.isStale(mine)) return;
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
      pageTitleRow('Users') +
      '<div class="filter-row"><input class="search-input" id="user-search" placeholder="Search by name or email…" value="' + esc(filterText) + '"></div>' +
      '<p class="muted">Showing ' + filtered.length + ' user' + (filtered.length === 1 ? '' : 's') + '</p>' +
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

  // Bumped on every call and checked when a response lands — typing in
  // #agent-org now fires one request per keystroke (see the 'input'
  // listener below), so an earlier, slower response landing after a later,
  // faster one must not overwrite the screen with stale results.
  var agentLoadToken = 0;

  function loadAgents() {
    var token = ++agentLoadToken;
    var qs = [];
    if (agentFilters.org) qs.push('org=' + encodeURIComponent(agentFilters.org));
    if (agentFilters.agent) qs.push('agent=' + encodeURIComponent(agentFilters.agent));
    if (agentFilters.outcome) qs.push('outcome=' + encodeURIComponent(agentFilters.outcome));
    return api('/agents' + (qs.length ? '?' + qs.join('&') : '')).then(function (rows) {
      if (token !== agentLoadToken) return;
      view.innerHTML =
        pageTitleRow('Agent actions') +
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
            // AUDIT FIX (AD5) — badge() already runs its label through esc()
            // internally; wrapping r.outcome in esc() here too double-escaped
            // it (an outcome value carrying an '&' or similar printed as the
            // literal entity "&amp;" instead of the character itself).
            '<td>' + badge(r.outcome === 'success', 'Success', r.outcome) + '</td>' +
            '<td>' + timeAgo(r.created_at) + '<span class="cell-sub mono">' + fmtDate(r.created_at) + '</span></td>' +
            '</tr>';
        }).join('') : '<tr><td colspan="6"><div class="empty">No agent actions match.</div></td></tr>') +
        '</tbody></table></div>';

      // Same focus/cursor restore paintWorkspaces/paintUsers already do for
      // their own live-as-you-type search boxes — every keystroke here now
      // rebuilds this whole section's innerHTML (including this input), so
      // without this the field would lose focus after every character.
      var orgInput = document.getElementById('agent-org');
      orgInput.focus();
      orgInput.setSelectionRange(orgInput.value.length, orgInput.value.length);

      // AUDIT FIX (AD2) — loadAgents() returns the api() promise with
      // nothing attached to it here; a failure (a 401, a dropped
      // connection) used to become an unhandled rejection with no 401
      // redirect, no toast, and nothing reaching the Errors tab.
      orgInput.addEventListener('input', function (e) {
        agentFilters.org = e.target.value;
        loadAgents().catch(handleActionError);
      });
      document.getElementById('agent-name-filter').addEventListener('change', function (e) {
        agentFilters.agent = e.target.value;
        loadAgents().catch(handleActionError);
      });
      document.getElementById('agent-outcome-filter').addEventListener('change', function (e) {
        agentFilters.outcome = e.target.value;
        loadAgents().catch(handleActionError);
      });
    });
  }

  // ── Notifications ──────────────────────────────────────────────────────
  // A failed notification's recipient is a real buyer's phone number or
  // email, and this table is otherwise plain, unmasked PII sitting in the
  // admin dashboard for anyone holding ADMIN_SECRET to read — masking it
  // here keeps "which channel is failing and why" visible (the actual
  // point of this table) without the full address/number attached to it.
  function maskRecipient(recipient) {
    var value = String(recipient || '').trim();
    if (!value) return '—';

    var atIndex = value.indexOf('@');
    if (atIndex !== -1) {
      var local = value.slice(0, atIndex);
      var domain = value.slice(atIndex); // includes the '@'
      return local.slice(0, 3) + '***' + domain;
    }

    var digits = value.replace(/\D/g, '');
    if (!digits) return '***';
    return '***' + digits.slice(-4);
  }

  var notificationsGuard = staleGuard();
  function renderNotifications() {
    var mine = notificationsGuard.start();
    return api('/notifications').then(function (d) {
      if (notificationsGuard.isStale(mine)) return;
      var byType = Object.keys(d.by_type || {}).map(function (k) {
        return kpi(k, d.by_type[k]);
      }).join('');

      view.innerHTML =
        pageTitleRow('Notifications') +
        '<div class="kpi-grid">' +
          kpi('Total sent', d.total_sent) +
          kpi('Total failed', d.total_failed) +
          kpi('Failed rate', d.failed_rate + '%') +
        '</div>' +
        (byType ? '<div class="kpi-grid">' + byType + '</div>' : '') +
        '<div class="card"><div class="card-head"><h2>Last 100 failed</h2></div>' +
        '<div class="table-wrap"><table class="data"><thead><tr><th>Channel</th><th>Recipient</th><th>Reason</th><th>When</th></tr></thead><tbody>' +
        (d.recent_failures.length ? d.recent_failures.map(function (f) {
          return '<tr><td>' + esc(f.channel) + '</td><td class="mono">' + esc(maskRecipient(f.recipient)) + '</td>' +
            '<td>' + esc(f.error || '—') + '</td><td>' + timeAgo(f.created_at) + '</td></tr>';
        }).join('') : '<tr><td colspan="4"><div class="empty">No failures recorded.</div></td></tr>') +
        '</tbody></table></div></div>';
    });
  }

  // ── Health ─────────────────────────────────────────────────────────────
  var healthCache = null;
  var migrationSortUnappliedFirst = false;

  var healthGuard = staleGuard();
  function renderHealth() {
    var mine = healthGuard.start();
    return api('/health').then(function (d) {
      if (healthGuard.isStale(mine)) return;
      healthCache = d;
      paintHealth();
    });
  }

  // AI EVALUATION SYSTEM — "AI Accuracy". Not fetched automatically with the
  // rest of Health: GET /ai-evaluation reseeds a synthetic workspace and
  // asks Archta Intelligence every case in tests/ai-evaluation/cases.js for
  // real, so every run costs actual OpenAI calls. aiEvalCache stays null
  // until an admin explicitly clicks "Run AI evaluation" below, and holds
  // the last run's results (not re-fetched on every Health repaint) until
  // they click it again.
  var aiEvalCache = null;
  var aiEvalRunning = false;

  function aiAccuracyCard() {
    var body;
    if (aiEvalRunning) {
      body = '<p class="muted">Running evaluation cases against a synthetic workspace — this calls OpenAI for real and can take a little while…</p>';
    } else if (!aiEvalCache) {
      body = '<p class="muted">Not run yet this session. Each run reseeds a small synthetic workspace and asks Archta Intelligence real questions against it.</p>';
    } else {
      body =
        '<div class="kpi-grid">' +
          kpi('Passed', aiEvalCache.pass_count + ' / ' + aiEvalCache.total) +
          kpi('Last run', fmtDate(aiEvalCache.ran_at)) +
        '</div>' +
        '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th>Case</th><th>Result</th><th>Answer produced</th><th>Expected reasoning</th>' +
        '</tr></thead><tbody>' +
        aiEvalCache.results.map(function (r) {
          return '<tr><td>' + esc(r.question) +
            (r.missing_data_keys.length ? '<div class="muted">Missing context: ' + esc(r.missing_data_keys.join(', ')) + '</div>' : '') +
            (r.matched_forbidden_claims.length ? '<div class="muted">Forbidden phrase found: ' + esc(r.matched_forbidden_claims.join(', ')) + '</div>' : '') +
            '</td>' +
            '<td>' + badge(r.passed, 'Pass', 'Fail') + '<div class="muted">' + esc(r.generated_by) + '</div></td>' +
            '<td>' + esc(r.actual_answer) + '</td>' +
            '<td class="muted">' + esc(r.expected_reasoning) + '</td>' +
            '</tr>';
        }).join('') +
        '</tbody></table></div>';
    }

    return '<div class="card"><div class="card-head"><h2>AI Accuracy</h2>' +
        '<button class="btn sm" id="btn-run-ai-eval"' + (aiEvalRunning ? ' disabled' : '') + '>' +
          (aiEvalRunning ? 'Running…' : 'Run AI evaluation') +
        '</button>' +
      '</div>' + body + '</div>';
  }

  function paintHealth() {
    var d = healthCache;
    var migrations = d.migrations.slice();
    if (migrationSortUnappliedFirst) {
      // Stable sort: not-applied rows float to the top, otherwise the
      // original (alphabetical, i.e. numeric-by-filename) order holds —
      // Array.prototype.sort in every browser this dashboard targets is
      // guaranteed stable, so ties (same `applied` value) keep their
      // existing relative order rather than being shuffled.
      migrations.sort(function (a, b) { return (a.applied === b.applied) ? 0 : (a.applied ? 1 : -1); });
    }

    view.innerHTML =
      pageTitleRow('Health') +
      '<div class="kpi-grid">' +
        kpi('Last cron run', d.last_cron_run ? timeAgo(d.last_cron_run.started_at) : 'never') +
        kpi('OpenAI calls this month', d.openai_calls_this_month) +
        kpi('Failed webhooks (7d)', d.failed_webhooks_7d) +
      '</div>' +
      '<div class="card"><div class="card-head"><h2>Migrations</h2>' +
        '<button class="btn sm" id="btn-migration-sort">' +
          (migrationSortUnappliedFirst ? 'Show alphabetical' : 'Show unapplied first') +
        '</button>' +
      '</div>' +
      '<div class="table-wrap"><table class="data"><thead><tr><th>File</th><th>Status</th></tr></thead><tbody>' +
      migrations.map(function (m) {
        return '<tr><td class="mono">' + esc(m.file) + '</td><td>' + badge(m.applied, 'Applied', 'Not applied') + '</td></tr>';
      }).join('') +
      '</tbody></table></div></div>' +
      aiAccuracyCard();

    document.getElementById('btn-migration-sort').addEventListener('click', function () {
      migrationSortUnappliedFirst = !migrationSortUnappliedFirst;
      paintHealth();
    });

    document.getElementById('btn-run-ai-eval').addEventListener('click', function () {
      if (aiEvalRunning) return;
      aiEvalRunning = true;
      paintHealth();
      api('/ai-evaluation').then(function (result) {
        aiEvalCache = result;
        aiEvalRunning = false;
        paintHealth();
      }).catch(function (err) {
        aiEvalRunning = false;
        paintHealth();
        toast(err.message, 'err');
      });
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

  // A stored secret from an earlier tab session skips straight past login —
  // sessionStorage already scopes this to the tab's own lifetime, so there is
  // nothing extra to check here. Deliberately the LAST thing this file does,
  // not right after showApp() is defined near the top: showApp() calls
  // goToSection('overview'), which reads `view` and `SECTIONS` — both
  // declared further down with `var`, so calling it before those
  // assignments actually ran left them undefined, threw partway through
  // goToSection, and silently aborted the rest of this script — including
  // the #nav click listener a few lines below that assignment. The
  // symptom was exactly a refresh with a valid session: the shell appeared
  // (showApp had already flipped the two hidden flags before the throw)
  // but the content area stayed empty and nav clicks did nothing, because
  // nothing after the throw ever ran. Placing this check after every
  // declaration and every event listener in the file is what actually
  // fixes that, not just moving it later by a few lines.
  if (sessionStorage.getItem(SECRET_KEY)) showApp();
})();
