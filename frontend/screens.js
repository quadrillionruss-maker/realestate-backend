/* screens.js — every screen in the app.
 *
 * Registers into RE.screens, which realestate.js routes against. Loaded after
 * realestate.js and before DOMContentLoaded, so all of these exist by the
 * time the router first runs.
 *
 * Each screen is `{ render(view, params, query) }` and owns its own fetching
 * and its own event wiring. No shared mutable state between screens, so
 * navigating away and back always produces the same result as a hard reload.
 *
 * ── WHAT CHANGED, AND WHY IT MATTERED ────────────────────────────────────
 * The API has always had routes for creating projects, units, buyers,
 * reservations and payments. There was no UI for any of them. The only way
 * to put data into this product was Postman with a hand-minted JWT — which
 * meant it was a read-only dashboard for anyone who was not its author, and
 * the smoke test was the only thing that had ever created a reservation.
 * Everything below exists to close that gap.
 */
(function () {
  'use strict';

  var R = window.RE;
  var esc = R.esc, naira = R.naira, nairaShort = R.nairaShort, fmtDate = R.fmtDate;
  var api = R.api, badge = R.badge, table = R.table, toast = R.toast;

  // Remembers the project filter across screens, so choosing "Lekki Gardens"
  // on the dashboard does not reset when you go and look at the units.
  //
  // It is module-level, which means it outlives a sign-out unless something
  // clears it — and an office machine shared between the MD and a collections
  // officer would hand the second person a dashboard silently scoped to the
  // first person's project. realestate.js calls the hook below from signOut().
  var projectFilter = null;

  R.resetScreenState = function () { projectFilter = null; expandedScheduleBuyerId = null; };

  // Mirrors src/services/installmentService.js addMonthsUTC exactly: a lease
  // starting 31 Jan renews to 28/29 Feb, not 3 March, which is what native
  // Date arithmetic (setMonth past a short month) would silently produce.
  // The reservation-creation and renewal modals both compute a tenancy end
  // date client-side to show the rep before they submit, and it has to match
  // what the server would derive, or the confirmation lies.
  function addMonthsClamped(dateStr, months) {
    var parts = String(dateStr).slice(0, 10).split('-').map(Number);
    var year = parts[0], month = parts[1] - 1, day = parts[2];
    var lastDayOfTarget = new Date(Date.UTC(year, month + months + 1, 0)).getUTCDate();
    var result = new Date(Date.UTC(year, month + months, Math.min(day, lastDayOfTarget)));
    return result.toISOString().slice(0, 10);
  }

  // The device's own local Y-M-D, NOT toISOString().slice(0,10) — that reads
  // the UTC date, which between 00:00-01:00 Africa/Lagos (UTC+1) is still
  // "yesterday" in UTC and would shift a same-day filter window by a day.
  function localDateStr(d) {
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function head(title, sub, actions) {
    return '<div class="page-head"><div>' +
      '<div class="page-title">' + esc(title) + '</div>' +
      (sub ? '<div class="page-sub">' + esc(sub) + '</div>' : '') +
      '</div>' + (actions ? '<div class="page-actions">' + actions + '</div>' : '') +
    '</div>';
  }

  function stat(label, value, opts) {
    var o = opts || {};
    return '<div class="stat' + (o.accent ? ' accent-' + o.accent : '') + '">' +
      '<div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value' + (o.tone ? ' ' + o.tone : '') + '">' + esc(value) + '</div>' +
      (o.sub ? '<div class="stat-sub">' + esc(o.sub) + '</div>' : '') +
    '</div>';
  }

  function card(title, bodyHtml, opts) {
    var o = opts || {};
    return '<div class="card">' +
      (title ? '<div class="card-head"><div class="card-title">' + esc(title) + '</div>' +
        '<div class="spacer"></div>' + (o.actions || '') + '</div>' : '') +
      '<div class="card-body' + (o.flush ? ' flush' : '') + '">' + bodyHtml + '</div>' +
    '</div>';
  }

  // Simple Previous/Next pagination over a list already held in memory —
  // these screens already fetch a bounded batch in one request, so slicing it
  // client-side is the whole feature, with no new backend query parameters.
  // Only three screens need this (Buyers, Payments History, Payments
  // Due/Overdue), so it is a small shared helper rather than a new primitive
  // on R — nothing else in the app currently has enough rows to need it.
  function paginate(rows, perPage, page) {
    var total = rows.length;
    var pageCount = Math.max(1, Math.ceil(total / perPage));
    var current = Math.min(Math.max(1, page || 1), pageCount);
    var start = (current - 1) * perPage;
    var slice = rows.slice(start, start + perPage);
    return {
      page: current,
      pageCount: pageCount,
      slice: slice,
      label: total === 0 ? '' : 'Showing ' + (start + 1) + '-' + Math.min(start + perPage, total) + ' of ' + total,
    };
  }

  function paginationControls(p) {
    if (p.pageCount <= 1) return '';
    return '<div class="pagination">' +
      '<span class="page-sub">' + esc(p.label) + '</span>' +
      '<div class="btn-row">' +
        '<button class="btn-quiet" data-page-prev' + (p.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
        '<button class="btn-quiet" data-page-next' + (p.page >= p.pageCount ? ' disabled' : '') + '>Next</button>' +
      '</div>' +
    '</div>';
  }

  // Supabase returns a nested one-to-many as an array, but a relationship it
  // resolves as one-to-one comes back as a bare object — and which of the two
  // you get depends on the foreign keys it can see, not on the query. Every
  // place that iterates a nested relation goes through this, so a shape change
  // degrades to "no rows" instead of "forEach is not a function" on a screen
  // the developer is standing in front of.
  function asArray(value) {
    if (Array.isArray(value)) return value;
    return value ? [value] : [];
  }

  // A1, A2, A10, A11, A100, B1 — not the A1, A10, A100, A11, A2 a plain string
  // sort produces once a project passes nine units. Splits a unit number into
  // its alphabetic prefix and trailing numeric suffix, sorts by prefix first
  // (alphabetically), then by the suffix as a NUMBER rather than more
  // characters to compare. A unit number with no trailing digits sorts before
  // any numbered variant of the same prefix.
  function naturalSort(a, b) {
    var sa = String(a == null ? '' : a);
    var sb = String(b == null ? '' : b);
    var ma = /^(.*?)(\d+)\s*$/.exec(sa);
    var mb = /^(.*?)(\d+)\s*$/.exec(sb);
    var prefixA = ma ? ma[1] : sa;
    var prefixB = mb ? mb[1] : sb;
    if (prefixA !== prefixB) return prefixA < prefixB ? -1 : 1;
    var numA = ma ? Number(ma[2]) : -1;
    var numB = mb ? Number(mb[2]) : -1;
    return numA - numB;
  }

  // The array the API hands back is never sorted in place — callers may still
  // hold the original reference (e.g. for a count in the page header).
  function sortUnitsNaturally(units) {
    return units.slice().sort(function (a, b) { return naturalSort(a.unit_number, b.unit_number); });
  }

  // Exposed for the offline logic test suite, which loads this file under a
  // window/document stub (src/test/logic.test.js) and has no way to reach a
  // function private to this closure otherwise.
  R.naturalSort = naturalSort;

  /* ══ CSV column mapping (import modals) ═══════════════════════════════════
     A raw spreadsheet header ("Unit No.", "Price (₦)", "Full Name"…) rarely
     matches the field name the API expects. Rather than reject the file or
     silently guess wrong, each import shows a mapping step between the pasted
     CSV and the dry-run preview: every header gets a dropdown, pre-selected by
     matching known spreadsheet variations, so a developer's own export
     usually needs no manual remapping at all. Unmatched columns default to
     "Skip this column" rather than a guess that could put phone numbers in
     the price column. */
  var IMPORT_FIELDS = {
    units: {
      unit_number: ['unit_number', 'Unit No.', 'Unit Number', 'unit no', 'unit'],
      list_price: ['list_price', 'Price', 'Price (₦)', 'price', 'amount'],
      unit_type: ['unit_type', 'Type', 'type'],
      size_sqm: ['size_sqm', 'Size', 'size', 'sqm'],
      // Optional — a row that has one overrides the Project dropdown for
      // itself alone; every other row still falls back to the dropdown.
      project: ['project', 'Project', 'Project Name', 'project name'],
    },
    customers: {
      full_name: ['full_name', 'Name', 'name', 'Full Name', 'buyer name'],
      phone: ['phone', 'Phone', 'Phone Number', 'mobile'],
      email: ['email', 'Email'],
      source: ['source'],
      project: ['project', 'Project', 'Project Name', 'project name'],
      unit_number: ['unit_number', 'Unit No.', 'Unit Number', 'unit no', 'unit'],
      unit_type: ['unit_type', 'Type', 'type'],
      size_sqm: ['size_sqm', 'Size', 'size', 'sqm'],
      list_price: ['list_price', 'Price', 'Price (₦)', 'price', 'amount'],
      total_amount: ['total_amount', 'Total Amount', 'total amount'],
      number_of_installments: ['number_of_installments', 'Number of Installments', 'installments'],
      frequency: ['frequency'],
      start_date: ['start_date', 'Start Date', 'first payment date'],
      amount_paid_to_date: ['amount_paid_to_date', 'Amount Paid', 'amount paid to date', 'paid to date'],
    },
  };

  var IMPORT_FIELD_LABELS = {
    unit_number: 'Unit number', list_price: 'List price', unit_type: 'Unit type', size_sqm: 'Size (sqm)',
    full_name: 'Full name', phone: 'Phone', email: 'Email', source: 'Source', project: 'Project',
    total_amount: 'Total amount', number_of_installments: 'Number of installments', frequency: 'Frequency',
    start_date: 'Start date', amount_paid_to_date: 'Amount paid to date',
  };

  var REQUIRED_IMPORT_FIELDS = { units: ['unit_number', 'list_price'], customers: ['full_name'] };

  // Case, spacing and punctuation all vary between exports of the same field
  // ("Unit No." vs "unit no" vs "unit_number"), so both the header and every
  // candidate variation are folded to the same shape before comparing.
  function normalizeColumnLabel(value) {
    return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // The canonical field name a raw CSV header most likely means, or null —
  // meaning the mapping UI should default that column to "Skip this column".
  function matchImportColumn(header, kind) {
    var fields = IMPORT_FIELDS[kind];
    var needle = normalizeColumnLabel(header);
    if (!fields || !needle) return null;
    var found = null;
    Object.keys(fields).forEach(function (field) {
      if (found) return;
      fields[field].some(function (variant) {
        if (normalizeColumnLabel(variant) === needle) { found = field; return true; }
        return false;
      });
    });
    return found;
  }

  R.matchImportColumn = matchImportColumn;

  // A minimal mirror of the backend's RFC 4180 parser (src/utils/csv.js),
  // needed here only to read the header row for the mapping step and to
  // rewrite it before the file is sent. Quoted fields, embedded commas and
  // escaped quotes all round-trip; nothing more is used on this side.
  function parseCsvRows(text) {
    var input = String(text || '').replace(/^﻿/, '');
    var rows = [], row = [], field = '', inQuotes = false, i = 0;

    while (i < input.length) {
      var char = input[i];
      if (inQuotes) {
        if (char === '"') {
          if (input[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i += 1; continue;
        }
        field += char; i += 1; continue;
      }
      if (char === '"') { inQuotes = true; i += 1; continue; }
      if (char === ',') { row.push(field); field = ''; i += 1; continue; }
      if (char === '\r') { i += 1; continue; }
      if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
      field += char; i += 1;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (cell) { return String(cell).trim().length; }); });
  }

  function quoteCsvField(value) {
    var s = value == null ? '' : String(value);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // Rewrites a CSV's header row to canonical field names and drops every
  // column mapped to "skip" — so the backend, which knows nothing about a
  // mapping UI, receives exactly the columns it already understands, named
  // the way it already expects. `mapping` is { columnIndex: fieldName|null }.
  function remapCsv(text, mapping) {
    var rows = parseCsvRows(text);
    if (!rows.length) return '';
    var header = rows[0];
    var keepIndexes = [];
    var newHeader = [];
    header.forEach(function (h, index) {
      var field = mapping[index];
      if (!field) return;
      keepIndexes.push(index);
      newHeader.push(field);
    });

    var lines = [newHeader.map(quoteCsvField).join(',')];
    rows.slice(1).forEach(function (r) {
      lines.push(keepIndexes.map(function (index) { return quoteCsvField(r[index]); }).join(','));
    });
    return lines.join('\r\n');
  }

  R.remapCsv = remapCsv;

  // Renders the mapping table into `container` for the given CSV text and
  // kind ('units' or 'customers'), wires its dropdowns, and calls
  // onChange(mapping, missingRequiredFields) whenever a selection changes —
  // including once immediately, so the caller's initial gate state is correct.
  // `mapping` is keyed by column index because two columns can share a header
  // in a messy export.
  function renderColumnMapping(container, csvText, kind, onChange) {
    var rows = parseCsvRows(csvText);
    if (!rows.length) {
      container.innerHTML = '';
      container.classList.add('hidden');
      if (onChange) onChange({}, REQUIRED_IMPORT_FIELDS[kind] || []);
      return;
    }
    container.classList.remove('hidden');

    var headers = rows[0];
    var fields = IMPORT_FIELDS[kind] || {};
    var fieldNames = Object.keys(fields);
    var required = REQUIRED_IMPORT_FIELDS[kind] || [];
    var auto = headers.map(function (h) { return matchImportColumn(h, kind); });

    container.innerHTML =
      '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>CSV column</th><th>Maps to</th>' +
      '</tr></thead><tbody>' +
      headers.map(function (h, index) {
        return '<tr data-map-row="' + index + '"' + (auto[index] ? '' : ' class="map-row-unmatched"') + '>' +
          '<td class="mono">' + esc(h || '(blank)') + '</td>' +
          '<td><select class="select map-select" data-map-index="' + index + '">' +
            '<option value="">Skip this column</option>' +
            fieldNames.map(function (f) {
              return '<option value="' + esc(f) + '"' + (auto[index] === f ? ' selected' : '') + '>' +
                esc(IMPORT_FIELD_LABELS[f] || f) + '</option>';
            }).join('') +
          '</select></td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>' +
      '<p class="field-hint map-summary"></p>';

    function currentMapping() {
      var mapping = {};
      R.qsa('.map-select', container).forEach(function (select) {
        mapping[Number(select.dataset.mapIndex)] = select.value || null;
      });
      return mapping;
    }

    function refresh() {
      var mapping = currentMapping();
      var mappedCount = 0, skippedCount = 0;
      headers.forEach(function (h, index) { if (mapping[index]) mappedCount += 1; else skippedCount += 1; });
      var mappedFields = Object.keys(mapping).map(function (i) { return mapping[i]; }).filter(Boolean);
      var missing = required.filter(function (f) { return mappedFields.indexOf(f) === -1; });

      var summary = R.qs('.map-summary', container);
      summary.textContent = mappedCount + ' column' + (mappedCount === 1 ? '' : 's') + ' matched, ' +
        skippedCount + ' column' + (skippedCount === 1 ? '' : 's') + ' will be skipped' +
        (missing.length
          ? ', ' + missing.length + ' required field' + (missing.length === 1 ? '' : 's') +
            ' missing (' + missing.map(function (f) { return IMPORT_FIELD_LABELS[f] || f; }).join(', ') + ').'
          : '.');
      summary.classList.toggle('warn', missing.length > 0);

      if (onChange) onChange(mapping, missing);
    }

    R.qsa('.map-select', container).forEach(function (select) {
      select.addEventListener('change', function () {
        // A manual choice is no longer "the default nobody looked at".
        select.closest('tr').classList.remove('map-row-unmatched');
        refresh();
      });
    });

    refresh();
  }

  function options(list, valueKey, labelKey, selected) {
    return list.map(function (item) {
      return '<option value="' + esc(item[valueKey]) + '"' +
        (String(item[valueKey]) === String(selected) ? ' selected' : '') + '>' +
        esc(item[labelKey]) + '</option>';
    }).join('');
  }

  function greeting() {
    var hour = new Date().getHours();
    var part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    var name = (R.state.user && R.state.user.full_name) || '';
    return part + (name ? ', ' + name.split(' ')[0] : '') + '.';
  }

  /* ══ COMMAND CENTER ═════════════════════════════════════════════════════
     The daily habit. Everything a developer needs before their first call:
     what the AI noticed overnight, the four numbers, the unit mix, who is
     behind, what to say to them, and what is on the list. */
  R.screens.dashboard = {
    render: async function (view, params, query) {
      // Documentation's dashboard is a different question entirely — what
      // still needs doing on paper, none of it financial — and the backend
      // answers it with a different shape (routes/dashboard.js's
      // documentationDashboard), not a stripped-down copy of the KPI one
      // below. Same reason it gets its own render path here.
      if (R.state.user.role === 'documentation') {
        return renderDocumentationDashboard(view);
      }

      if (query.project) projectFilter = query.project;
      var scope = projectFilter ? '?project_id=' + encodeURIComponent(projectFilter) : '';

      var canSeeAtRisk = R.can('atRisk.read');
      var canSeeBrief = R.can('brief.read');

      var results = await Promise.all([
        api('/dashboard' + scope),
        // A Sales Executive and Documentation never reach GET /at-risk — the
        // server would 403 it, so this simply isn't asked for them.
        canSeeAtRisk ? api('/dashboard/at-risk' + scope) : Promise.resolve([]),
        api('/tasks?status=open'),
      ]);

      var d = results[0], atRisk = results[1], tasks = results[2];
      // The 4 KPI tiles read a lot better as ₦28.5m than ₦28,450,000 once
      // the grid has collapsed to one column — checked at render time, not
      // in a media query, because there is no CSS way to swap which STRING
      // a tile contains, only how it is styled.
      var kpiMoney = window.innerWidth < 480 ? nairaShort : naira;
      // Collections and a Sales Executive never get a brief back at all
      // (routes/dashboard.js only fetches one for Owner/Sales Director) —
      // d.latest_brief is already null for them, same as canSeeBrief being
      // false; both checks below agree.
      var brief = canSeeBrief ? d.latest_brief : null;
      var drafts = (brief && brief.payload && brief.payload.follow_ups) || [];
      var risks = (brief && brief.payload && brief.payload.risks) || [];

      var lines = [];
      if (canSeeAtRisk && atRisk.length) lines.push('<span class="greeting-line clay"><b>' + atRisk.length + '</b> ' + (atRisk.length === 1 ? 'buyer needs' : 'buyers need') + ' chasing</span>');
      if (d.overdue.count) lines.push('<span class="greeting-line clay"><b>' + nairaShort(d.overdue.amount) + '</b> overdue</span>');
      if (d.due_next_7_days) lines.push('<span class="greeting-line"><b>' + nairaShort(d.due_next_7_days) + '</b> due this week</span>');
      if (d.open_tasks.total) lines.push('<span class="greeting-line gold"><b>' + d.open_tasks.total + '</b> open ' + (d.open_tasks.total === 1 ? 'task' : 'tasks') + '</span>');
      if (!lines.length) lines.push('<span class="greeting-line">Nothing is overdue. Nothing is due this week.</span>');

      var projectPills = d.projects.length > 1
        ? '<div class="filter-row">' +
            '<button class="pill' + (projectFilter ? '' : ' is-on') + '" data-project="">All projects</button>' +
            d.projects.map(function (p) {
              return '<button class="pill' + (projectFilter === p.id ? ' is-on' : '') + '" data-project="' + esc(p.id) + '">' + esc(p.name) + '</button>';
            }).join('') +
          '</div>'
        : '';

      view.innerHTML =
        '<div class="greeting"><h1>' + esc(greeting()) + '</h1>' +
          '<div class="greeting-lines">' + lines.join('') + '</div></div>' +

        projectPills +

        // The brief — Owner and Sales Director only. Collections and a Sales
        // Executive see their own KPIs below instead; there is nothing
        // strategic here for either of them to read, and no button that
        // would only 403 if pressed.
        (canSeeBrief
          ? '<div class="brief">' +
              '<div class="brief-head">' +
                '<span class="eyebrow">Morning Brief</span>' +
                // "Today at 07:14" rather than a bare date. Checking the dashboard
                // at 8pm, the only thing worth knowing about the brief is whether
                // it is this morning's — and a date cannot answer that.
                '<span class="brief-meta">' + esc(brief
                  ? [R.fmtRelative(brief.created_at) || brief.brief_date,
                     brief.generated_by === 'fallback' ? 'rule-based' : ''].filter(Boolean).join(' · ')
                  : '') + '</span>' +
              '</div>' +
              '<p class="brief-body' + (brief ? '' : ' is-muted') + '" id="brief-summary">' +
                esc(brief ? brief.summary : 'No brief yet. The first one is written automatically at 7:00 AM Lagos time, or you can generate it now.') +
              '</p>' +

              // A degraded morning is stated, not disguised. Without this a
              // rule-based brief reads as the AI's work, and nobody knows to look
              // at it more carefully or to try again.
              (brief && brief.payload && brief.payload.model_error
                ? '<div class="notice info mt-1 mb-0">' +
                    'The AI was unavailable this morning, so this brief was built from the rules. ' +
                    'The figures are correct; only the wording is plainer.' +
                  '</div>'
                : '') +
              (risks.length
                ? '<div class="risk-row">' + risks.slice(0, 6).map(function (r) {
                    return '<div class="risk-chip ' + esc(r.severity) + '"><b>' + esc(r.customer_name) + '</b><span>' + esc(r.reason) + '</span></div>';
                  }).join('') + '</div>'
                : '') +
              '<div class="brief-actions">' +
                '<button class="btn brass" id="btn-brief">Regenerate brief</button>' +
                // Every click is a paid model call. Saying so is cheaper than
                // discovering someone clicked it forty times because the wording
                // looked off.
                '<span class="brief-meta" id="brief-status">Writes a new brief — one AI call</span>' +
              '</div>' +
            '</div>'
          : '') +

        // ₦28,450,000 at 18px (the mobile .stat-value size) is the widest
        // thing on a 4-up grid squeezed to one column — nairaShort's
        // ₦28.5m fits the tile instead of wrapping or overflowing it.
        '<div class="grid cols-4 mt-2">' +
          stat('Collected this month', kpiMoney(d.collected_this_month), { tone: 'moss', accent: 'moss' }) +
          stat('Outstanding', kpiMoney(d.outstanding_total)) +
          stat('Overdue', kpiMoney(d.overdue.amount), {
            tone: 'clay', accent: d.overdue.count ? 'clay' : null,
            sub: d.overdue.count ? R.plural(d.overdue.count, 'installment') : 'All current',
          }) +
          stat('Due in 7 days', kpiMoney(d.due_next_7_days)) +
        '</div>' +

        // Two revenue streams read as one number without this. Only shown once
        // there is actually a rental portfolio to report on — a pure off-plan
        // developer does not need "₦0 rental income" taking up a row forever.
        (d.collected_rental_this_month
          ? '<div class="grid cols-2 mt-2">' +
              stat('Sales income this month', naira(d.collected_sales_this_month), { tone: 'moss' }) +
              stat('Rental income this month', naira(d.collected_rental_this_month), { tone: 'gold', accent: 'gold' }) +
            '</div>'
          : '') +

        '<div class="grid split mt-2">' +
          '<div>' +
            (canSeeAtRisk
              ? card('At risk', atRisk.length
                  ? atRisk.slice(0, 6).map(riskRow).join('')
                  : R.emptyState('Nobody is two or more installments behind', 'Good morning.'),
                  { flush: true, actions: atRisk.length > 6 ? '<a class="btn-quiet" href="#/at-risk">See all ' + atRisk.length + '</a>' : '' })
              : '') +

            card('Inventory', inventoryHtml(d.units), { actions: '<a class="btn-quiet" href="#/units">Manage</a>' }) +
          '</div>' +

          '<div>' +
            (canSeeBrief
              ? card('Drafted follow-ups', drafts.length
                  ? drafts.slice(0, 5).map(draftRow).join('')
                  : R.emptyState('Nothing to chase today'),
                  { flush: true })
              : '') +

            card('Tasks', tasks.length
              ? tasks.slice(0, 7).map(taskRow).join('')
              : R.emptyState('No open tasks'),
              { flush: true, actions: '<a class="btn-quiet" href="#/tasks">All tasks</a>' }) +
          '</div>' +
        '</div>';

      R.qsa('[data-project]', view).forEach(function (pill) {
        pill.addEventListener('click', function () {
          projectFilter = pill.dataset.project || null;
          R.reload();
        });
      });

      // R.onClick disables the button for the duration, which is the debounce:
      // a frustrated developer cannot queue twenty model calls by clicking
      // twenty times.
      R.onClick(view, '#btn-brief', async function () {
        R.el('brief-status').textContent = 'reading payments, schedules and documents…';
        try {
          var fresh = await api.post('/brief/generate');
          toast(fresh.generated_by === 'fallback'
            ? 'Brief rebuilt from the rules — the AI was unavailable.'
            : 'Brief regenerated.', 'ok');
          await R.reload();
        } finally {
          var status = R.el('brief-status');
          if (status) status.textContent = 'Writes a new brief — one AI call';
        }
      });

      wireDrafts(view);
      wireTasks(view);
      wireRiskRows(view);
    },
  };

  // Documentation's whole dashboard: what still needs doing on paper, and
  // nothing else — matches routes/dashboard.js's documentationDashboard,
  // which is the only thing GET /dashboard returns for this role.
  async function renderDocumentationDashboard(view) {
    var d = await api('/dashboard');

    view.innerHTML =
      '<div class="greeting"><h1>' + esc(greeting()) + '</h1>' +
        '<div class="greeting-lines">' +
          (d.pending_letters
            ? '<span class="greeting-line gold"><b>' + d.pending_letters + '</b> ' + (d.pending_letters === 1 ? 'letter' : 'letters') + ' to generate</span>'
            : '') +
          (d.unsigned_deeds
            ? '<span class="greeting-line clay"><b>' + d.unsigned_deeds + '</b> unsigned ' + (d.unsigned_deeds === 1 ? 'deed' : 'deeds') + '</span>'
            : '') +
          (!d.pending_letters && !d.unsigned_deeds
            ? '<span class="greeting-line">Nothing pending.</span>'
            : '') +
        '</div></div>' +

      '<div class="grid cols-4 mt-2">' +
        stat('Pending', String(d.by_status.pending)) +
        stat('Generated', String(d.by_status.generated)) +
        stat('Sent', String(d.by_status.sent)) +
        stat('Signed', String(d.by_status.signed), { tone: 'moss' }) +
      '</div>' +

      '<div class="mt-2">' +
        card(null, '<div class="center-pad">' +
          '<a class="btn brass" href="#/documents">Go to Documents</a>' +
        '</div>') +
      '</div>';
  }

  function inventoryHtml(units) {
    var total = units.available + units.reserved + units.sold;
    if (!total) return '<div class="empty compact">No units yet. <a class="link-quiet" href="#/projects">Create a project</a> to add some.</div>';
    var pct = function (n) { return (n / total) * 100; };
    return '<div class="units-bar">' +
        '<div class="seg-sold" data-w="' + pct(units.sold) + '"></div>' +
        '<div class="seg-reserved" data-w="' + pct(units.reserved) + '"></div>' +
        '<div class="seg-available" data-w="' + pct(units.available) + '"></div>' +
      '</div>' +
      '<div class="units-legend">' +
        '<span><i class="swatch sold"></i>Sold ' + units.sold + '</span>' +
        '<span><i class="swatch reserved"></i>Reserved ' + units.reserved + '</span>' +
        '<span><i class="swatch available"></i>Available ' + units.available + '</span>' +
        '<span class="faint">' + R.plural(total, 'unit') + '</span>' +
      '</div>';
  }

  function riskRow(c) {
    var phone = c.customer.phone ? String(c.customer.phone) : '';
    // R.waLink normalizes 0803… to 234803…. Stripping non-digits (what this
    // used to do) produced wa.me/08031234567, which opens WhatsApp and then
    // says the number is incorrect — on the screen reps use most.
    var whatsapp = R.waLink(phone);
    var project = (c.unit && c.unit.re_projects && c.unit.re_projects.name) || '';
    var meta = [project, c.unit && c.unit.unit_number ? 'Unit ' + c.unit.unit_number : '',
      R.plural(c.overdue_count, 'missed payment')].filter(Boolean).map(esc).join(' · ');

    var flags = '';
    if (c.days_late) flags += '<span class="late-tag">' + R.plural(c.days_late, 'day') + ' late</span>';
    if (c.escalation && c.escalation.stage !== 'none') flags += badge(c.escalation.stage);
    if (c.promise) {
      flags += '<span class="promise-tag' + (c.promise.status === 'broken' ? ' broken' : '') + '">' +
        (c.promise.status === 'broken' ? 'Broke promise of ' : 'Promised ') + esc(fmtDate(c.promise.promised_date)) +
        '</span>';
    }

    return '<div class="record">' +
      '<div class="record-top">' +
        '<div><div class="record-name">' + esc(c.customer.full_name) + '</div>' +
        '<div class="record-meta">' + meta + '</div></div>' +
        '<div class="record-amount">' + naira(c.overdue_amount) + '</div>' +
      '</div>' +
      (flags ? '<div class="record-flags">' + flags + '</div>' : '') +
      '<div class="record-actions">' +
        (phone ? '<a class="action-link" href="tel:' + esc(phone) + '">Call</a>' : '') +
        (whatsapp ? '<a class="action-link" target="_blank" rel="noopener" href="' + esc(whatsapp) + '">WhatsApp</a>' : '') +
        // A promise the morning sweep already flagged open or broken still
        // needs a way out that isn't "wait for the buyer to pay" — paid in
        // cash at the office, or withdrawn on a second call. Without this the
        // only path off the at-risk list was the automatic one.
        (c.promise
          ? '<button class="action-link" data-resolve-promise="' + esc(c.promise.id) + '" data-resolve-status="kept">Mark kept</button>' +
            '<button class="action-link" data-resolve-promise="' + esc(c.promise.id) + '" data-resolve-status="cancelled">Cancel promise</button>'
          : '<button class="action-link" data-promise="' + esc(c.oldest_schedule_id) + '" data-name="' + esc(c.customer.full_name) + '">Log a promise</button>') +
        '<button class="action-link" data-buyer="' + esc(c.customer.id) + '">Open</button>' +
      '</div>' +
    '</div>';
  }

  function wireRiskRows(root) {
    R.qsa('[data-promise]', root).forEach(function (button) {
      button.addEventListener('click', function () { promiseModal(button.dataset.promise, button.dataset.name); });
    });
    R.qsa('[data-resolve-promise]', root).forEach(function (button) {
      button.addEventListener('click', async function () {
        var status = button.dataset.resolveStatus;
        var ok = await R.confirm({
          title: status === 'kept' ? 'Mark promise kept' : 'Cancel this promise',
          message: status === 'kept'
            ? 'Marks this promise kept without waiting for the sweep — use this when the money arrived outside Paystack, e.g. paid in cash at the office.'
            : 'Withdraws this promise. Use this when the buyer walked it back on a later call.',
          confirmLabel: status === 'kept' ? 'Mark kept' : 'Cancel promise',
        });
        if (!ok) return;
        try {
          await api.patch('/promises/' + button.dataset.resolvePromise + '/status', { status: status });
          toast(status === 'kept' ? 'Promise marked kept.' : 'Promise cancelled.', 'ok');
          R.reload();
        } catch (err) { toast(err.message, 'err'); }
      });
    });
    R.qsa('[data-buyer]', root).forEach(function (button) {
      button.addEventListener('click', function () { openCustomer(button.dataset.buyer); });
    });
  }

  // Logged while the rep still has the buyer on the phone. Anything that takes
  // longer than the call itself does not get filled in.
  function promiseModal(scheduleId, customerName) {
    R.modal({
      title: 'Log a promise to pay',
      body:
        '<p class="muted mb-2">' + esc(customerName) + ' said they would pay. Write down when, and the morning sweep will notice if the date passes.</p>' +
        '<div class="field-row">' +
          '<div class="field"><label for="p-date">Promised date</label>' +
            '<input class="input" id="p-date" name="promised_date" type="date" required min="' + R.todayISO() + '"></div>' +
          '<div class="field"><label for="p-amount">Amount promised</label>' +
            '<div class="input-money"><input class="input" id="p-amount" name="promised_amount" type="number" min="1" step="1" placeholder="Optional"></div></div>' +
        '</div>' +
        '<div class="field"><label for="p-who">Who did you speak to?</label>' +
          '<input class="input" id="p-who" name="spoke_to" placeholder="The buyer, their spouse, their PA…"></div>' +
        '<div class="field"><label for="p-notes">Notes</label>' +
          '<textarea class="textarea" id="p-notes" name="notes" placeholder="Anything worth remembering next time"></textarea></div>',
      submitLabel: 'Save promise',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        await api.post('/promises', {
          schedule_id: scheduleId,
          promised_date: v.promised_date,
          promised_amount: v.promised_amount || null,
          spoke_to: v.spoke_to || null,
          notes: v.notes || null,
        });
        close();
        toast('Promise logged.', 'ok');
        R.reload();
      },
    });
  }

  function draftRow(draft, i) {
    return '<div class="draft">' +
      '<div class="record-name"><span class="tag-ai">AI</span>' + esc(draft.customer_name) + '</div>' +
      '<div class="draft-text" data-draft="' + i + '">' + esc(draft.whatsapp_draft) + '</div>' +
      (draft.email_draft ? '<div class="draft-text hidden" data-draft-email="' + i + '">' + esc(draft.email_draft) + '</div>' : '') +
      '<div class="btn-row">' +
        '<button class="btn-quiet" data-copy="' + i + '">Copy for WhatsApp</button>' +
        (draft.email_draft ? '<button class="btn-quiet" data-copy-email="' + i + '">Copy email</button>' : '') +
      '</div>' +
    '</div>';
  }

  // Drafts are proposals: the AI writes, a human sends. Copy-to-clipboard is
  // the whole interaction — no message leaves the building automatically.
  function wireDrafts(root) {
    R.qsa('[data-copy]', root).forEach(function (button) {
      button.addEventListener('click', function () {
        var text = R.qs('[data-draft="' + button.dataset.copy + '"]', root).textContent;
        R.copyText(text).then(function () {
          button.textContent = 'Copied ✓';
          button.classList.add('is-done');
          setTimeout(function () {
            button.textContent = 'Copy for WhatsApp';
            button.classList.remove('is-done');
          }, 1700);
        }).catch(function () { toast('Could not copy. Select the text instead.', 'err'); });
      });
    });

    R.qsa('[data-copy-email]', root).forEach(function (button) {
      button.addEventListener('click', function () {
        var text = R.qs('[data-draft-email="' + button.dataset.copyEmail + '"]', root).textContent;
        R.copyText(text).then(function () {
          button.textContent = 'Copied ✓';
          button.classList.add('is-done');
          setTimeout(function () {
            button.textContent = 'Copy email';
            button.classList.remove('is-done');
          }, 1700);
        }).catch(function () { toast('Could not copy. Select the text instead.', 'err'); });
      });
    });
  }

  function taskRow(t) {
    var reservation = t.re_reservations;
    var customer = reservation && reservation.re_customers;
    var unit = reservation && reservation.re_units;
    var meta = [customer && customer.full_name, unit && unit.unit_number ? 'Unit ' + unit.unit_number : '',
      t.due_date ? 'due ' + fmtDate(t.due_date) : ''].filter(Boolean).map(esc).join(' · ');

    return '<div class="task">' +
      '<div class="task-body">' +
        '<div class="task-title">' + (t.source === 'ai' ? '<span class="tag-ai">AI</span>' : '') + esc(t.title) + '</div>' +
        (meta ? '<div class="task-meta">' + meta + '</div>' : '') +
      '</div>' +
      '<button class="btn-quiet" data-done="' + esc(t.id) + '">Done</button>' +
    '</div>';
  }

  function wireTasks(root) {
    R.onClick(root, '[data-done]', async function (button) {
      await api.patch('/tasks/' + button.dataset.done + '/status', { status: 'done' });
      R.refreshCounts();
      await R.reload();
    });
  }

  /* ══ AT RISK ════════════════════════════════════════════════════════════ */
  R.screens['at-risk'] = {
    render: async function (view) {
      var scope = projectFilter ? '?project_id=' + encodeURIComponent(projectFilter) : '';
      var results = await Promise.all([api('/dashboard/at-risk' + scope), api('/promises?status=broken')]);
      var atRisk = results[0], broken = results[1];

      var exposure = atRisk.reduce(function (sum, c) { return sum + Number(c.overdue_amount || 0); }, 0);

      view.innerHTML =
        head('At risk', 'Buyers two or more installments behind, worst first. A broken promise outranks a bigger number.') +
        '<div class="grid cols-3 mb-2">' +
          stat('Buyers at risk', String(atRisk.length), { accent: atRisk.length ? 'clay' : null }) +
          stat('Total exposure', naira(exposure), { tone: 'clay' }) +
          stat('Broken promises', String(broken.length), { tone: broken.length ? 'clay' : null }) +
        '</div>' +
        card(null, atRisk.length
          ? atRisk.map(riskRow).join('')
          : R.emptyState('Nobody is two or more installments behind', 'Every buyer is within one payment of current.'),
          { flush: true });

      wireRiskRows(view);
    },
  };

  /* ══ TASKS ══════════════════════════════════════════════════════════════ */
  R.screens.tasks = {
    render: async function (view, params, query) {
      var status = query.status || 'open';
      var tasks = await api('/tasks?status=' + encodeURIComponent(status));

      view.innerHTML =
        head('Tasks', 'One list for what you decided and what the AI suggested.',
          '<button class="btn primary" id="btn-new-task">New task</button>') +
        '<div class="filter-row">' +
          ['open', 'done', 'dismissed'].map(function (s) {
            return '<a class="pill' + (status === s ? ' is-on' : '') + '" href="#/tasks?status=' + s + '">' +
              s.charAt(0).toUpperCase() + s.slice(1) + '</a>';
          }).join('') +
        '</div>' +
        card(null, tasks.length
          ? tasks.map(status === 'open' ? taskRow : doneTaskRow).join('')
          : R.emptyState(
              'No ' + status + ' tasks',
              status === 'open'
                ? 'Follow-ups you create, and the ones the AI suggests, both land here.'
                : status === 'done'
                  ? 'Tasks you mark done move here — nothing has been completed yet.'
                  : 'Tasks you dismiss move here — nothing has been dismissed yet.',
              '<button class="btn primary" id="btn-empty-task">Add a task</button>'
            ),
          { flush: true });

      if (status === 'open') wireTasks(view);

      R.qsa('#btn-new-task, #btn-empty-task', view).forEach(function (b) {
        b.addEventListener('click', function () {
          R.modal({
            title: 'New task',
            body:
              '<div class="field"><label for="t-title">Task</label>' +
                '<input class="input" id="t-title" name="title" required placeholder="Call Mrs Adeyemi about her February installment"></div>' +
              '<div class="field"><label for="t-due">Due date</label>' +
                '<input class="input" id="t-due" name="due_date" type="date"></div>' +
              '<div class="field"><label for="t-notes">Notes</label>' +
                '<textarea class="textarea" id="t-notes" name="notes"></textarea></div>',
            submitLabel: 'Add task',
            onSubmit: async function (form, close) {
              var v = R.values(form);
              if (!v.title) throw new Error('Give the task a title.');
              await api.post('/tasks', { title: v.title, due_date: v.due_date || null, notes: v.notes || null });
              close();
              toast('Task added.', 'ok');
              R.refreshCounts();
              R.reload();
            },
          });
        });
      });
    },
  };

  function doneTaskRow(t) {
    return '<div class="task"><div class="task-body">' +
      '<div class="task-title muted">' + (t.source === 'ai' ? '<span class="tag-ai">AI</span>' : '') + esc(t.title) + '</div>' +
      '<div class="task-meta">' + esc(fmtDate(t.created_at)) + '</div>' +
    '</div></div>';
  }

  /* ══ PROJECTS ═══════════════════════════════════════════════════════════ */
  R.screens.projects = {
    render: async function (view) {
      var projects = await api('/projects');
      // Inventory is the developer's own book, not a rep's — permissions.js
      // documents Units/Projects as read-only for sales_rep explicitly. A
      // writable button in front of a read-only route is not a permission
      // model (same file's own words), so it's gated here, not just server-side.
      var canWrite = R.can('inventory.write');

      view.innerHTML =
        head('Projects', 'Each development you are selling.',
          canWrite ? '<button class="btn primary" id="btn-new-project">New project</button>' : '') +
        (projects.length
          ? '<div class="grid cols-3">' + projects.map(projectCard).join('') + '</div>'
          : card(null, R.emptyState(
              'No projects yet',
              'A project is one development — "Lekki Gardens Phase 2". Units, buyers and payments all hang off it.',
              canWrite ? '<button class="btn primary" id="btn-first-project">Create your first project</button>' : ''
            ), { flush: true }));

      R.qsa('#btn-new-project, #btn-first-project', view).forEach(function (b) {
        b.addEventListener('click', projectModal);
      });

      R.qsa('[data-project-open]', view).forEach(function (node) {
        node.addEventListener('click', function () {
          projectFilter = node.dataset.projectOpen;
          R.go('#/units?project=' + node.dataset.projectOpen);
        });
      });
    },
  };

  function projectCard(p) {
    var total = p.units_total || 0;
    var taken = (p.units_sold || 0) + (p.units_reserved || 0);
    var pct = total ? Math.round((taken / total) * 100) : 0;

    return '<div class="card cursor-pointer" data-project-open="' + esc(p.id) + '">' +
      '<div class="card-body">' +
        '<div class="flex-row justify-between align-start">' +
          '<div><div class="project-card-title">' + esc(p.name) + '</div>' +
          '<div class="page-sub">' + esc(p.location || 'No location set') + '</div></div>' +
          badge(p.status) +
        '</div>' +
        '<div class="mt-2"><div class="meter gold"><i data-w="' + pct + '"></i></div>' +
          '<div class="units-legend mt-1 fs-11-5">' +
            '<span>' + (p.units_sold || 0) + ' sold</span>' +
            '<span>' + (p.units_reserved || 0) + ' reserved</span>' +
            '<span>' + (p.units_available || 0) + ' available</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function projectModal() {
    R.modal({
      title: 'New project',
      body:
        '<div class="field"><label for="pr-name">Project name</label>' +
          '<input class="input" id="pr-name" name="name" required placeholder="Lekki Gardens Phase 2"></div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="pr-loc">Location</label>' +
            '<input class="input" id="pr-loc" name="location" placeholder="Ajah, Lagos"></div>' +
          '<div class="field"><label for="pr-units">Planned units</label>' +
            '<input class="input" id="pr-units" name="total_units" type="number" min="0" placeholder="40"></div>' +
        '</div>' +
        '<div class="field"><label for="pr-status">Status</label>' +
          '<select class="select" id="pr-status" name="status">' +
            '<option value="active">Active</option><option value="planning">Planning</option>' +
            '<option value="sold_out">Sold out</option><option value="archived">Archived</option>' +
          '</select></div>',
      submitLabel: 'Create project',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        if (!v.name) throw new Error('Give the project a name.');
        await api.post('/projects', v);
        close();
        toast('Project created. Add its units next.', 'ok');
        R.reload();
      },
    });
  }

  /* ══ UNITS ══════════════════════════════════════════════════════════════ */
  R.screens.units = {
    render: async function (view, params, query) {
      if (query.project) projectFilter = query.project;

      var results = await Promise.all([
        api('/units' + (projectFilter ? '?project_id=' + encodeURIComponent(projectFilter) : '')),
        api('/projects'),
      ]);
      var units = results[0], projects = results[1];

      if (query.q) {
        var needle = query.q.toLowerCase();
        units = units.filter(function (u) { return String(u.unit_number).toLowerCase().indexOf(needle) >= 0; });
      }

      // A1, A2 … A10, A11 … A100, then B1 — not the plain alphabetical order
      // the API returns (order('unit_number') is a string sort in Postgres).
      units = sortUnitsNaturally(units);

      if (!projects.length) {
        view.innerHTML = head('Units', 'Inventory across your developments.') +
          card(null, R.emptyState('Create a project first', 'Units belong to a development.',
            '<a class="btn primary" href="#/projects">Go to projects</a>'), { flush: true });
        return;
      }

      // Inventory is the developer's own book, not a rep's — permissions.js
      // documents Units/Projects as read-only for sales_rep explicitly.
      var canWrite = R.can('inventory.write');

      view.innerHTML =
        head('Units', R.plural(units.length, 'unit') + ' in view',
          canWrite
            ? '<button class="btn" id="btn-import-units">Import CSV</button>' +
              '<button class="btn" id="btn-bulk-units">Add many</button>' +
              '<button class="btn primary" id="btn-new-unit">Add unit</button>'
            : '') +

        '<div class="filter-row">' +
          '<button class="pill' + (projectFilter ? '' : ' is-on') + '" data-project="">All projects</button>' +
          projects.map(function (p) {
            return '<button class="pill' + (projectFilter === p.id ? ' is-on' : '') + '" data-project="' + esc(p.id) + '">' + esc(p.name) + '</button>';
          }).join('') +
        '</div>' +

        card(null, table(
          [{ label: 'Unit' }, { label: 'Project', hideMobile: true }, { label: 'Type', hideMobile: true },
            { label: 'Size', num: true, hideMobile: true },
            { label: 'Price', num: true }, { label: 'Status' }, { label: '' }],
          units,
          function (u) {
            return '<tr>' +
              '<td class="cell-primary">' + esc(u.unit_number) + '</td>' +
              '<td class="muted hide-mobile">' + esc((u.re_projects && u.re_projects.name) || '') + '</td>' +
              '<td class="muted hide-mobile">' + esc(u.unit_type || '—') + '</td>' +
              '<td class="num muted hide-mobile">' + (u.size_sqm ? esc(u.size_sqm) + ' m²' : '—') + '</td>' +
              '<td class="num">' + naira(u.list_price) + '</td>' +
              '<td>' + badge(u.status) + '</td>' +
              '<td class="right nowrap">' +
                '<button class="btn-quiet" data-media="' + esc(u.id) + '" data-unit="' + esc(u.unit_number) + '">' +
                  (mediaCount(u) ? 'Media ' + mediaCount(u) : 'Media') +
                '</button> ' +
                (u.status === 'available'
                  ? '<button class="btn-quiet" data-reserve="' + esc(u.id) + '">Reserve</button> '
                  : '') +
                (u.status === 'available' && R.can('recycle.delete')
                  ? '<button class="btn-quiet" data-delete-unit="' + esc(u.id) +
                    '" data-label="Unit ' + esc(u.unit_number) + '">Delete</button>'
                  : '') +
              '</td>' +
            '</tr>';
          },
          canWrite
            ? {
                emptyTitle: 'No units yet',
                emptyHint: 'Add them one at a time, in bulk, or import a CSV.',
                emptyAction: '<button class="btn primary" id="btn-empty-unit">Add unit</button>',
              }
            // A read-only role's own screen has no Add/Import buttons — telling
            // them how to add units their screen doesn't let them add is a
            // dead end, not a hint.
            : { emptyTitle: 'No units yet', emptyHint: 'Units will appear here once your team adds them.' }
        ), { flush: true });

      R.qsa('[data-project]', view).forEach(function (pill) {
        pill.addEventListener('click', function () {
          projectFilter = pill.dataset.project || null;
          R.go('#/units' + (projectFilter ? '?project=' + projectFilter : ''));
          R.reload();
        });
      });

      if (canWrite) {
        R.qsa('#btn-new-unit, #btn-empty-unit', view).forEach(function (b) {
          b.addEventListener('click', function () { unitModal(projects); });
        });
        R.qs('#btn-bulk-units', view).addEventListener('click', function () { bulkUnitModal(projects); });
        R.qs('#btn-import-units', view).addEventListener('click', function () { importUnitsModal(projects); });
      }

      // R.onClick (not a bare addEventListener) so the button shows a
      // spinner and is protected against a double-click while
      // units/customers/reps are still being pre-fetched for the modal,
      // same as the restructure and renew-tenancy buttons elsewhere.
      R.onClick(view, '[data-reserve]', async function (button) {
        await reservationModal({ unitId: button.dataset.reserve });
      });

      R.onClick(view, '[data-delete-unit]', async function (button) {
        await deleteModal('units', button.dataset.deleteUnit, button.dataset.label);
      });

      R.qsa('[data-media]', view).forEach(function (button) {
        button.addEventListener('click', function () {
          var unit = units.find(function (u) { return u.id === button.dataset.media; });
          unitMediaModal(unit);
        });
      });
    },
  };

  /* ══ DELETE AND RESTORE ═════════════════════════════════════════════════
     Nothing is really deleted. The confirmation says what goes with it and
     says plainly that it can be brought back, because a warning that
     overstates the danger gets clicked through as fast as one that
     understates it. */
  async function deleteModal(resource, id, label) {
    var impact = await api('/recycle/' + resource + '/' + id + '/impact');

    var panel = R.modal({
      title: 'Delete ' + (label || 'this record') + '?',
      body:
        '<div class="notice mb-2">This also removes ' + esc(impact.takes_with_it) + '.</div>' +
        '<p class="muted mb-2">Nothing is permanently erased — the records stay in the database and in the ' +
        'activity log, and you can restore them from the bin in Settings.</p>' +
        '<div class="field"><label for="del-reason">Reason (optional)</label>' +
          '<input class="input" id="del-reason" name="reason" placeholder="Duplicate entry"></div>',
      submitLabel: 'Delete',
      onSubmit: async function (form, close) {
        var result = await api('/recycle/' + resource + '/' + id, {
          method: 'DELETE',
          body: JSON.stringify({ reason: R.values(form).reason || null }),
        });
        close();
        toast('Deleted ' + result.total + ' record(s). Restore from Settings → Bin.', 'ok');
        R.refreshCounts();
        R.reload();
      },
    });

    // Scoped to this modal's own root — an unscoped document-wide lookup
    // here would restyle whichever modal's submit button the selector
    // happens to hit first if more than one were ever open at once (the
    // exact bug modal()'s own formId-per-instance scheme was hardened
    // against once already; see the comment on modalSeq in realestate.js).
    var submit = R.qs('[type="submit"]', panel.root);
    if (submit) { submit.classList.remove('primary'); submit.classList.add('danger'); }
  }

  function mediaCount(unit) {
    var media = unit.metadata && unit.metadata.media;
    return Array.isArray(media) ? media.length : 0;
  }

  // What a rep needs on the phone: "what does it look like?" answered without
  // hanging up. Files go to a public media bucket, separate from the private
  // one holding allocation letters — a floor plan is marketing, a buyer's
  // letter is not.
  function unitMediaModal(unit) {
    var media = (unit.metadata && Array.isArray(unit.metadata.media)) ? unit.metadata.media : [];

    R.modal({
      title: 'Unit ' + unit.unit_number + ' — floor plans and photos',
      wide: true,
      body:
        (media.length
          ? '<div class="grid cols-3 mb-2">' + media.map(function (m) {
              var isPdf = /\.pdf$/i.test(m.url);
              return '<a class="card media-card" href="' + esc(m.url) + '" target="_blank" rel="noopener">' +
                (isPdf
                  ? '<div class="media-thumb-icon">▤</div>'
                  : '<img src="' + esc(m.url) + '" alt="' + esc(m.label || m.kind) + '" class="media-thumb-img">') +
                '<div class="card-body media-card-body">' +
                  '<div class="fs-12">' + esc(m.label || String(m.kind).replace(/_/g, ' ')) + '</div>' +
                  '<div class="cell-meta">' + esc(fmtDate(m.uploaded_at)) + '</div>' +
                '</div></a>';
            }).join('') + '</div>'
          : '<p class="muted mb-2">Nothing attached to this unit yet.</p>') +

        '<div class="divider"></div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="m-kind">What is it?</label>' +
            '<select class="select" id="m-kind" name="kind">' +
              '<option value="floor_plan">Floor plan</option>' +
              '<option value="photo">Photo</option>' +
              '<option value="site_map">Site map</option>' +
              '<option value="brochure">Brochure</option>' +
            '</select></div>' +
          '<div class="field"><label for="m-label">Label</label>' +
            '<input class="input" id="m-label" name="label" placeholder="Ground floor"></div>' +
        '</div>' +
        '<div class="field"><label for="m-file">Files</label>' +
          '<input class="input" id="m-file" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple required>' +
          '<p class="field-hint">JPEG, PNG, WebP or PDF, up to 6MB each. These are publicly readable so a rep can send one straight to a buyer.</p>' +
          '<p class="field-hint" id="m-progress"></p></div>',
      submitLabel: 'Upload',
      onSubmit: async function (form, close) {
        var input = R.el('m-file');
        var files = Array.prototype.slice.call(input.files || []);
        if (!files.length) throw new Error('Choose at least one file to upload.');

        var v = R.values(form);
        var progress = R.el('m-progress');
        var uploaded = 0;
        var failures = [];

        // Sequential, not parallel — the progress line only means something if
        // one upload finishes before the next starts, and it is one file at a
        // time on a rep's phone data connection anyway.
        for (var i = 0; i < files.length; i++) {
          var file = files[i];
          progress.textContent = 'Uploading ' + (i + 1) + ' of ' + files.length + '…';

          try {
            if (file.size > 6 * 1024 * 1024) throw new Error('larger than 6MB');

            var base64 = await new Promise(function (resolve, reject) {
              var reader = new FileReader();
              reader.onload = function () { resolve(String(reader.result).split(',')[1]); };
              reader.onerror = function () { reject(new Error('could not be read')); };
              reader.readAsDataURL(file);
            });

            await api.post('/units/' + unit.id + '/media', {
              content: base64,
              content_type: file.type,
              kind: v.kind,
              label: v.label || null,
            });
            uploaded += 1;
          } catch (err) {
            failures.push(file.name + ' (' + err.message + ')');
          }
        }

        progress.textContent = '';
        close();

        // Whatever succeeded is already saved — one bad file in a batch of ten
        // should not cost the other nine, so this closes and reloads either way
        // and simply names what did not make it.
        if (failures.length) {
          toast(uploaded + ' of ' + files.length + ' uploaded. Failed: ' + failures.join(', '), 'err');
        } else {
          toast(R.plural(uploaded, 'file') + ' uploaded.', 'ok');
        }
        R.reload();
      },
    });
  }

  function unitModal(projects) {
    R.modal({
      title: 'Add a unit',
      body:
        '<div class="field"><label for="u-project">Project</label>' +
          '<select class="select" id="u-project" name="project_id" required>' + options(projects, 'id', 'name', projectFilter) + '</select></div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="u-number">Unit number</label>' +
            '<input class="input" id="u-number" name="unit_number" required placeholder="B12"></div>' +
          '<div class="field"><label for="u-type">Type</label>' +
            '<input class="input" id="u-type" name="unit_type" placeholder="3-bed terrace"></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="u-size">Size (m²)</label>' +
            '<input class="input" id="u-size" name="size_sqm" type="number" min="0" step="0.1" placeholder="145"></div>' +
          '<div class="field"><label for="u-price">List price</label>' +
            '<div class="input-money"><input class="input" id="u-price" name="list_price" type="number" min="1" step="1" required placeholder="45000000"></div></div>' +
        '</div>' +
        '<div class="field"><label for="u-plan">Floor plan URL</label>' +
          '<input class="input" id="u-plan" name="floor_plan_url" type="url" placeholder="https://…">' +
          '<p class="field-hint">Optional. Must be https. Shown to reps when a buyer asks what the unit looks like.</p></div>',
      submitLabel: 'Add unit',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        if (!v.unit_number || v.list_price == null) throw new Error('Unit number and list price are required.');
        await api.post('/units', {
          project_id: v.project_id,
          unit_number: v.unit_number,
          unit_type: v.unit_type || null,
          size_sqm: v.size_sqm,
          list_price: v.list_price,
          metadata: v.floor_plan_url ? { floor_plan_url: v.floor_plan_url } : {},
        });
        close();
        toast('Unit added.', 'ok');
        R.reload();
      },
    });
  }

  // How inventory actually gets entered: one paste of forty units, not forty
  // form submissions.
  function bulkUnitModal(projects) {
    // The handle is captured rather than looking the form up by id: modal form
    // ids are now unique per instance, so #modal-form no longer exists.
    var panel = R.modal({
      title: 'Add many units',
      wide: true,
      body:
        '<div class="field"><label for="b-project">Project</label>' +
          '<select class="select" id="b-project" name="project_id" required>' + options(projects, 'id', 'name', projectFilter) + '</select></div>' +
        '<div class="field-row three">' +
          '<div class="field"><label for="b-prefix">Prefix</label>' +
            '<input class="input" id="b-prefix" name="prefix" placeholder="B" value="A"></div>' +
          '<div class="field"><label for="b-from">From</label>' +
            '<input class="input" id="b-from" name="from" type="number" min="1" value="1"></div>' +
          '<div class="field"><label for="b-to">To</label>' +
            '<input class="input" id="b-to" name="to" type="number" min="1" value="20"></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="b-type">Type (all)</label>' +
            '<input class="input" id="b-type" name="unit_type" placeholder="3-bed terrace"></div>' +
          '<div class="field"><label for="b-price">List price (all)</label>' +
            '<div class="input-money"><input class="input" id="b-price" name="list_price" type="number" min="1" step="1" required placeholder="45000000"></div></div>' +
        '</div>' +
        '<p class="field-hint" id="b-preview"></p>',
      submitLabel: 'Create units',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        var from = Number(v.from), to = Number(v.to);
        if (!(to >= from)) throw new Error('"To" must be the same as or higher than "From".');
        if (to - from + 1 > 500) throw new Error('That is more than 500 units. Split it into batches.');
        if (v.list_price == null) throw new Error('Set a list price.');

        var units = [];
        for (var i = from; i <= to; i++) {
          units.push({
            unit_number: (v.prefix || '') + i,
            unit_type: v.unit_type || null,
            list_price: v.list_price,
          });
        }
        units.sort(function (a, b) { return naturalSort(a.unit_number, b.unit_number); });

        var created = await api.post('/units/bulk', { project_id: v.project_id, units: units });
        close();
        toast('Created ' + created.length + ' units.', 'ok');
        R.reload();
      },
    });

    // Live preview: "A1 … A20 (20 units)". Cheap, and it stops the mistake
    // where somebody creates 1–2000 by leaving the default in.
    var form = panel.form;
    var update = function () {
      var v = R.values(form);
      var count = Number(v.to) - Number(v.from) + 1;
      R.el('b-preview').textContent = count > 0
        ? 'Creates ' + (v.prefix || '') + v.from + ' … ' + (v.prefix || '') + v.to + '  (' + count + ' units)'
        : '';
    };
    ['b-prefix', 'b-from', 'b-to'].forEach(function (id) {
      R.el(id).addEventListener('input', update);
    });
    update();
  }

  function importUnitsModal(projects) {
    var mapping = {};
    var missing = REQUIRED_IMPORT_FIELDS.units;

    var panel = R.modal({
      title: 'Import units from CSV',
      wide: true,
      body:
        '<p class="muted mb-2">Any column headings — map them below. The first row must be the header. ' +
        '<a class="link-quiet" href="' + R.API_BASE + '/re/imports/template/units" target="_blank" rel="noopener">Download the template</a></p>' +
        '<div class="field"><label for="i-project">Project</label>' +
          '<select class="select" id="i-project" name="project_id" required>' + options(projects, 'id', 'name', projectFilter) + '</select>' +
          '<p class="field-hint">Every unit is imported into this project, unless the CSV has its own "Project" ' +
            'column — then that row goes into whichever project it names instead, and this is just the default ' +
            'for rows that leave it blank.</p></div>' +
        '<div class="field"><label for="i-file">CSV file</label>' +
          '<input class="input" id="i-file" type="file" accept=".csv,text/csv"></div>' +
        '<div class="field"><label for="i-csv">…or paste it</label>' +
          '<textarea class="textarea mono-input" id="i-csv" name="csv" rows="7" placeholder="unit_number,unit_type,size_sqm,list_price&#10;B12,3-bed terrace,145,45000000"></textarea></div>' +
        '<div id="i-mapping" class="hidden mt-2"></div>' +
        '<div id="i-result"></div>',
      submitLabel: 'Preview import',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        if (!v.csv) throw new Error('Paste the CSV or choose a file.');
        if (missing.length) throw new Error('Map the required fields first: ' + missing.join(', ') + '.');

        var previewed = form.dataset.previewed === 'true';
        var remapped = R.remapCsv(v.csv, mapping);
        var result = await api.post('/imports/units', {
          project_id: v.project_id, csv: remapped, dry_run: !previewed,
        });

        if (!previewed) {
          form.dataset.previewed = 'true';
          R.el('i-result').innerHTML =
            '<div class="notice ' + (result.errors.length ? '' : 'ok') + '">' +
              esc(result.would_create + ' units will be created' +
                (result.errors.length ? '; ' + result.errors.length + ' rows will be skipped' : '') + '.') +
              // Only shown once a "Project" column actually split the file
              // across more than one project — the common case (everything
              // under the dropdown default) has nothing worth breaking down.
              (result.by_project && result.by_project.length > 1
                ? '<div class="mt-1 fs-12">' + result.by_project.map(function (p) {
                    return esc(p.project_name) + ': ' + p.count;
                  }).join('<br>') + '</div>'
                : '') +
              (result.errors.length
                ? '<div class="mt-1 fs-12">' + result.errors.slice(0, 6).map(function (e) {
                    return 'Row ' + e.row + ': ' + esc(e.error);
                  }).join('<br>') + '</div>'
                : '') +
            '</div>';
          R.qs('[type="submit"]', form.closest('.modal')).textContent = 'Import ' + result.would_create + ' units';
          return;
        }

        close();
        toast('Imported ' + result.created + ' units.', 'ok');
        R.reload();
      },
    });

    // No mapping yet, nothing valid to preview — the button reappears once
    // the required fields are mapped.
    var submitBtn = R.qs('[type="submit"]', panel.root);
    submitBtn.classList.add('hidden');

    function refreshMapping() {
      var csvText = R.el('i-csv').value;
      renderColumnMapping(R.el('i-mapping'), csvText, 'units', function (nextMapping, nextMissing) {
        mapping = nextMapping;
        missing = nextMissing;
        submitBtn.classList.toggle('hidden', !csvText || missing.length > 0);
        submitBtn.textContent = 'Preview import';
      });
      // A changed mapping invalidates whatever was already previewed.
      panel.form.dataset.previewed = 'false';
      R.el('i-result').innerHTML = '';
    }

    R.el('i-csv').addEventListener('input', refreshMapping);

    R.el('i-file').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        R.el('i-csv').value = reader.result;
        refreshMapping();
      };
      reader.readAsText(file);
    });
  }

  /* ══ BUYERS ═════════════════════════════════════════════════════════════ */
  var CUSTOMERS_PER_PAGE = 50;

  R.screens.customers = {
    render: async function (view, params, query) {
      // #/customers/<id> opens the buyer straight from a search result.
      // The id stays in the hash while the drawer is open — so the URL is
      // linkable/shareable and Back behaves — and is only rewritten to the
      // bare list route once the drawer actually closes (see openCustomer).
      if (params[0]) { openCustomer(params[0]); return; }

      var search = query.q || '';
      var customers = await api('/customers' + (search ? '?search=' + encodeURIComponent(search) : ''));
      var page = 1;

      function renderPage() {
        var p = paginate(customers, CUSTOMERS_PER_PAGE, page);
        page = p.page;

        view.innerHTML =
          head('Buyers', R.plural(customers.length, 'buyer') + (search ? ' matching “' + search + '”' : ''),
            '<button class="btn" id="btn-export-buyers">Export CSV</button>' +
            '<button class="btn" id="btn-import-buyers">Import CSV</button>' +
            '<button class="btn primary" id="btn-new-buyer">Add buyer</button>') +

          card(null, table(
            [{ label: 'Name' }, { label: 'Phone' }, { label: 'Email', hideMobile: true },
              { label: 'Source', hideMobile: true }, { label: 'Added', hideMobile: true }, { label: '' }],
            p.slice,
            function (c) {
              return '<tr class="is-clickable" data-open="' + esc(c.id) + '">' +
                '<td class="cell-primary">' + esc(c.full_name) + '</td>' +
                '<td class="mono muted">' + esc(c.phone || '—') + '</td>' +
                '<td class="muted hide-mobile">' + esc(c.email || '—') + '</td>' +
                '<td class="muted hide-mobile">' + esc(c.source || '—') + '</td>' +
                '<td class="muted hide-mobile">' + esc(fmtDate(c.created_at)) + '</td>' +
                // data-stop keeps the row's own click handler from firing and
                // opening the drawer behind the confirmation.
                '<td class="right">' + (R.can('recycle.delete')
                  ? '<button class="btn-quiet" data-stop data-delete-customer="' + esc(c.id) +
                    '" data-label="' + esc(c.full_name) + '">Delete</button>'
                  : '') + '</td>' +
              '</tr>';
            },
            {
              emptyTitle: search ? 'Nobody matched that' : 'No buyers yet',
              emptyHint: search ? 'Try a phone number or part of a surname.' : 'Add them one at a time, or import the list you already have.',
            }
          ), { flush: true }) +
          paginationControls(p);

        R.qsa('[data-open]', view).forEach(function (row) {
          row.addEventListener('click', function (event) {
            if (event.target.closest('[data-stop]')) return;
            openCustomer(row.dataset.open);
          });
        });

        R.onClick(view, '[data-delete-customer]', async function (button) {
          await deleteModal('customers', button.dataset.deleteCustomer, button.dataset.label);
        });

        R.qs('#btn-new-buyer', view).addEventListener('click', customerModal);
        // importCustomersModal now fetches its own Project list before
        // opening — R.onClick gives that fetch a spinner and a toast if it
        // fails, which a bare addEventListener wouldn't for an async handler.
        R.onClick(view, '#btn-import-buyers', importCustomersModal);
        R.onClick(view, '#btn-export-buyers', async function () {
          await R.downloadCsv('/reports/export/customers', 'archta-buyers.csv');
          toast('Exported. Check your downloads.', 'ok');
        });

        var prev = R.qs('[data-page-prev]', view);
        if (prev) prev.addEventListener('click', function () { page -= 1; renderPage(); });
        var next = R.qs('[data-page-next]', view);
        if (next) next.addEventListener('click', function () { page += 1; renderPage(); });
      }

      renderPage();
    },
  };

  function customerModal() {
    R.modal({
      title: 'Add a buyer',
      body:
        '<div class="field"><label for="c-name">Full name</label>' +
          '<input class="input" id="c-name" name="full_name" required placeholder="Mrs Adeyemi Okonkwo"></div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="c-phone">Phone</label>' +
            '<input class="input" id="c-phone" name="phone" type="tel" placeholder="08031234567"></div>' +
          '<div class="field"><label for="c-email">Email</label>' +
            '<input class="input" id="c-email" name="email" type="email" placeholder="adeyemi@example.com"></div>' +
        '</div>' +
        '<div class="field"><label for="c-source">How did they find you?</label>' +
          '<select class="select" id="c-source" name="source">' +
            '<option value="">Not recorded</option>' +
            ['referral', 'walk-in', 'instagram', 'facebook', 'whatsapp', 'billboard', 'agent', 'website', 'other']
              .map(function (s) { return '<option value="' + s + '">' + s.charAt(0).toUpperCase() + s.slice(1) + '</option>'; }).join('') +
          '</select></div>',
      submitLabel: 'Add buyer',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        if (!v.full_name) throw new Error('A name is required.');
        await api.post('/customers', v);
        close();
        toast('Buyer added.', 'ok');
        R.reload();
      },
    });
  }

  // The onboarding moment: 150 existing buyers, their units, their plans and
  // what they have already paid, in one paste.
  var IMPORT_OUTCOME_LABEL = {
    buyer_only: 'buyer only',
    buyer_and_reservation: 'buyer + reservation',
    buyer_and_plan: 'buyer + reservation + payment plan',
  };

  async function importCustomersModal() {
    // Only needed for the Project dropdown below, and the common case (a
    // buyer-only file with no unit_number column at all) never opens it —
    // fetched lazily here rather than by the Buyers screen on every load.
    var projects = await api('/projects');
    var mapping = {};
    var missing = REQUIRED_IMPORT_FIELDS.customers;

    var panel = R.modal({
      title: 'Import buyers from CSV',
      wide: true,
      body:
        '<p class="muted mb-2">One row per buyer. A <code>unit_number</code> column reserves that unit for them ' +
        'automatically — add <code>total_amount</code>, <code>number_of_installments</code>, <code>frequency</code>, ' +
        '<code>start_date</code> and <code>amount_paid_to_date</code> too and the payment plan is created in the same ' +
        'pass. Everything beyond the buyer\'s name is optional; a <code>unit_number</code> with no plan columns just ' +
        'reserves the unit with no schedule attached. Map your own column headings below. ' +
        '<a class="link-quiet" href="' + R.API_BASE + '/re/imports/template/customers" target="_blank" rel="noopener">Download the template</a></p>' +
        '<div class="notice info compact">' +
          'Imported payments settle the schedule silently — no receipts are emailed for money that arrived months ago.' +
        '</div>' +
        '<div class="field"><label for="ic-project">Project</label>' +
          '<select class="select" id="ic-project" name="project_id">' +
            '<option value="">No default — every row with a unit_number needs its own "project" column</option>' +
            options(projects, 'id', 'name') +
          '</select>' +
          '<p class="field-hint">Only matters for a row that has a <code>unit_number</code>. A row\'s own ' +
            '"project" column overrides this; a row with neither is skipped with an error, not silently guessed.</p></div>' +
        '<div class="field"><label for="ic-file">CSV file</label>' +
          '<input class="input" id="ic-file" type="file" accept=".csv,text/csv"></div>' +
        '<div class="field"><label for="ic-csv">…or paste it</label>' +
          '<textarea class="textarea mono-input" id="ic-csv" name="csv" rows="7" placeholder="full_name,phone,email,project,unit_number,list_price,total_amount,number_of_installments,start_date,amount_paid_to_date"></textarea></div>' +
        '<div id="ic-mapping" class="hidden mt-2"></div>' +
        '<div id="ic-result"></div>',
      submitLabel: 'Preview import',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        if (!v.csv) throw new Error('Paste the CSV or choose a file.');
        if (missing.length) throw new Error('Map the required fields first: ' + missing.join(', ') + '.');

        var previewed = form.dataset.previewed === 'true';
        var remapped = R.remapCsv(v.csv, mapping);
        var result = await api.post('/imports/customers', {
          csv: remapped, project_id: v.project_id || null, dry_run: !previewed,
        });

        if (!previewed) {
          form.dataset.previewed = 'true';
          R.el('ic-result').innerHTML =
            '<div class="notice ' + (result.errors.length ? '' : 'ok') + '">' +
              esc(result.rows + ' rows ready' + (result.errors.length ? ', ' + result.errors.length + ' with problems' : '') + '.') +
            '</div>' +
            (result.errors.length
              ? '<div class="mt-1 import-errors">' +
                  result.errors.map(function (e) { return 'Row ' + e.row + ': ' + esc(e.error); }).join('<br>') + '</div>'
              : '') +
            '<div class="mt-1 import-preview">' +
              result.preview.slice(0, 25).map(function (p) {
                var outcome = IMPORT_OUTCOME_LABEL[p.outcome] || 'buyer only';
                return '<b>' + esc(p.full_name) + '</b> <span class="mono opacity-60">[' + esc(outcome) + ']</span>' +
                  (p.conflict ? ' <b class="clay">⚠ conflict</b>' : '') +
                  ' — ' + esc(p.actions.join('; '));
              }).join('<br>') +
            '</div>';
          R.qs('[type="submit"]', form.closest('.modal')).textContent = 'Import ' + result.rows + ' buyers';
          return;
        }

        close();
        toast('Imported ' + result.customers_created + ' buyers, ' + result.reservations +
          ' reservations, ' + result.payments + ' payments.', 'ok');
        R.reload();
      },
    });

    var submitBtn = R.qs('[type="submit"]', panel.root);
    submitBtn.classList.add('hidden');

    function refreshMapping() {
      var csvText = R.el('ic-csv').value;
      renderColumnMapping(R.el('ic-mapping'), csvText, 'customers', function (nextMapping, nextMissing) {
        mapping = nextMapping;
        missing = nextMissing;
        submitBtn.classList.toggle('hidden', !csvText || missing.length > 0);
        submitBtn.textContent = 'Preview import';
      });
      panel.form.dataset.previewed = 'false';
      R.el('ic-result').innerHTML = '';
    }

    R.el('ic-csv').addEventListener('input', refreshMapping);

    R.el('ic-file').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        R.el('ic-csv').value = reader.result;
        refreshMapping();
      };
      reader.readAsText(file);
    });
  }

  // The screen a rep opens with the buyer on the phone: everything about them,
  // without leaving the list behind it.
  async function openCustomer(id) {
    var panel = R.drawer({ eyebrow: 'Buyer', title: 'Loading…' });

    // R.drawer (realestate.js) closes itself on the × button, Escape, a
    // scrim click, or a handler here calling panel.close() outright (e.g.
    // "Create a reservation" below) — with no onClose hook exposed. A
    // MutationObserver on the drawer's fixed overlay parent catches every
    // one of those paths in one place: once the drawer's own scrim node is
    // no longer a child, it really is closed, so only then does the URL
    // fall back to the bare list route.
    var scrim = panel.root.parentNode;
    if (scrim && scrim.parentNode) {
      var overlayEl = scrim.parentNode;
      var hashObserver = new MutationObserver(function () {
        if (scrim.parentNode) return;
        hashObserver.disconnect();
        if (window.location.hash.indexOf('#/customers/') === 0) window.location.hash = '#/customers';
      });
      hashObserver.observe(overlayEl, { childList: true });
    }

    try {
      var c = await api('/customers/' + id);
      var reservations = c.re_reservations || [];

      panel.root.querySelector('.page-title').textContent = c.full_name;
      panel.root.querySelector('.drawer-head .eyebrow').textContent =
        [c.phone, c.email].filter(Boolean).join(' · ') || 'No contact details';

      var totalPlan = 0, totalPaid = 0, overdue = 0;
      reservations.forEach(function (r) {
        asArray(r.re_installment_plans).forEach(function (plan) {
          totalPlan += Number(plan.total_amount || 0);
          asArray(plan.re_installment_schedule).forEach(function (s) {
            if (s.status === 'paid') totalPaid += Number(s.amount_due || 0);
            if (s.status === 'overdue') overdue += Number(s.amount_due || 0);
          });
        });
      });

      var pct = totalPlan ? Math.round((totalPaid / totalPlan) * 100) : 0;
      var credit = c.unallocated_credit;

      panel.body.innerHTML =
        // A credit from an overpayment that nobody has allocated yet stays
        // visible every time this drawer is opened, not just in the moment it
        // happened — otherwise it is forgotten the instant the drawer closes.
        (credit
          ? '<div class="notice warn" id="d-credit-notice">Unallocated credit of ' + esc(naira(credit.amount)) +
              ' — tap to allocate</div>'
          : '') +

        '<div class="grid cols-3">' +
          stat('Contracted', nairaShort(totalPlan)) +
          stat('Paid', nairaShort(totalPaid), { tone: 'moss' }) +
          stat('Overdue', nairaShort(overdue), { tone: overdue ? 'clay' : null }) +
        '</div>' +
        '<div class="mt-2"><div class="meter"><i data-w="' + pct + '"></i></div>' +
        '<div class="page-sub">' + pct + '% of the plan settled</div></div>' +

        '<div class="btn-row mt-2">' +
          (c.phone ? '<a class="btn-quiet" href="tel:' + esc(c.phone) + '">Call</a>' : '') +
          (R.waLink(c.phone) ? '<a class="btn-quiet" target="_blank" rel="noopener" href="' + esc(R.waLink(c.phone)) + '">WhatsApp</a>' : '') +
          // Two independent actions, not one button with a shared side effect.
          // Emailing and copying used to happen together — send_email was tied
          // to whether an email existed, so there was no way to hand a rep a
          // WhatsApp link without also silently emailing the buyer. Each button
          // below issues its OWN portal link and reports its OWN outcome.
          '<button class="btn-quiet" id="d-portal-email"' +
            (c.email ? '' : ' disabled title="Add buyer email first"') + '>Email link</button>' +
          '<button class="btn-quiet" id="d-portal-copy">Copy for WhatsApp</button>' +
        '</div>' +

        reservations.map(function (r) {
          var unit = r.re_units || {};
          var project = unit.re_projects || {};
          var plan = asArray(r.re_installment_plans)[0];
          var schedule = asArray(plan && plan.re_installment_schedule)
            .slice() // never sort the array the API handed us in place
            .sort(function (a, b) { return a.installment_number - b.installment_number; });

          // Paid rows collapse behind a summary line by default — a buyer
          // eighteen months into a plan has eighteen settled rows nobody needs
          // to see every time this drawer opens. Unpaid and overdue rows,
          // where the actual work is, always show.
          var openRows = schedule.filter(function (s) { return s.status !== 'paid'; });
          var paidRows = schedule.filter(function (s) { return s.status === 'paid'; });
          var paidTotal = paidRows.reduce(function (sum, s) { return sum + Number(s.amount_due || 0); }, 0);

          return '<div class="drawer-section">' +
            '<div class="flex-row justify-between gap-10">' +
              '<div><b>' + esc(unit.unit_number ? 'Unit ' + unit.unit_number : 'Reservation') + '</b>' +
              '<div class="page-sub">' + esc([project.name, project.location].filter(Boolean).join(', ')) + '</div></div>' +
              badge(r.status) +
            '</div>' +
            (plan
              ? '<div class="page-sub mt-1">' + plan.number_of_installments + ' ' + esc(plan.frequency) +
                ' installments · ' + naira(plan.total_amount) + ' · from ' + esc(fmtDate(plan.start_date)) + '</div>' +
                '<div class="mt-1">' + openRows.map(scheduleRow).join('') + '</div>' +
                (paidRows.length
                  ? '<div class="sched-paid-summary">' +
                      '<span class="page-sub">' + R.plural(paidRows.length, 'paid installment') + ' — ' + esc(naira(paidTotal)) + ' total</span>' +
                      '<button class="btn-quiet" data-toggle-paid="' + esc(r.id) + '">Show</button>' +
                    '</div>' +
                    '<div class="hidden" data-paid-rows="' + esc(r.id) + '">' + paidRows.map(scheduleRow).join('') + '</div>'
                  : '')
              : '<div class="page-sub mt-1">Outright purchase — no installment plan.</div>') +
          '</div>';
        }).join('') +

        (reservations.length ? '' : '<div class="drawer-section">' +
          R.emptyState('No reservations yet', 'This buyer has not been allocated a unit.',
            '<button class="btn primary" id="d-reserve">Create a reservation</button>') + '</div>');
      R.applyDynamicStyles(panel.body);

      // R.onClick — same reasoning as the unit-row Reserve buttons: shows a
      // spinner and blocks a double-click while the modal's own
      // units/customers/reps pre-fetch is still in flight.
      R.onClick(panel.body, '#d-reserve', async function () {
        panel.close();
        await reservationModal({ customerId: c.id });
      });

      // Each mints its own link (a fresh token, same underlying buyer account)
      // and reports its own result — R.onClick disables only the button it is
      // wired to, so triggering one never disables or affects the other.
      R.onClick(panel.body, '#d-portal-email', async function () {
        var result = await api.post('/customers/' + c.id + '/portal-link', { send_email: true });
        if (result.emailed === 'sent') {
          toast('Sent to ' + c.email, 'ok');
        } else {
          // send_email:true was requested but the send did not go through
          // (Resend unconfigured, or it failed) — say so rather than claiming
          // success on an email that never left.
          toast('Could not email the link — check Settings → Notifications.', 'err');
        }
      });

      R.onClick(panel.body, '#d-portal-copy', async function (button) {
        var result = await api.post('/customers/' + c.id + '/portal-link', { send_email: false });
        await R.copyText(result.url);
        button.textContent = 'Copied ✓';
        button.classList.add('is-done');
        setTimeout(function () {
          button.textContent = 'Copy for WhatsApp';
          button.classList.remove('is-done');
        }, 1700);
      });

      R.onClick(panel.body, '[data-pay]', async function (button) {
        panel.close();
        recordPaymentModal(button.dataset.pay, button.dataset.outstanding, c.full_name, c.id);
      });

      R.onClick(panel.body, '[data-waive]', async function (button) {
        await waiveModal(button.dataset.waive, button.dataset.installment, c.full_name);
        openCustomer(id); // the row has to reflect the new status immediately
      });

      R.qsa('[data-toggle-paid]', panel.body).forEach(function (button) {
        button.addEventListener('click', function () {
          var rows = R.qs('[data-paid-rows="' + button.dataset.togglePaid + '"]', panel.body);
          var wasHidden = rows.classList.contains('hidden');
          rows.classList.toggle('hidden');
          button.textContent = wasHidden ? 'Hide' : 'Show';
        });
      });

      var creditNotice = R.qs('#d-credit-notice', panel.body);
      if (creditNotice) {
        creditNotice.addEventListener('click', function () {
          allocateOverpaymentModal(credit.payment_id, null, c.id, credit.amount, function (resolved) {
            if (resolved) openCustomer(id);
          });
        });
      }
    } catch (err) {
      panel.body.innerHTML = '<div class="notice">' + esc(err.message) + '</div>';
    }
  }

  function scheduleRow(s) {
    // Waiving only ever applies to money still owed — a paid row has nothing
    // left to write off, and an already-waived one has been through this once.
    var waivable = (s.status === 'pending' || s.status === 'overdue') && R.can('payments.waive');
    return '<div class="sched ' + esc(s.status) + '">' +
      '<span class="sched-n">' + s.installment_number + '</span>' +
      '<span class="sched-main"><span class="mono">' + naira(s.amount_due) + '</span>' +
        '<span class="page-sub">due ' + esc(fmtDate(s.due_date)) + (s.paid_at ? ' · paid ' + esc(fmtDate(s.paid_at)) : '') + '</span></span>' +
      badge(s.status) +
      (s.status !== 'paid' && R.can('payments.record')
        ? '<button class="btn-quiet" data-pay="' + esc(s.id) + '" data-outstanding="' + esc(s.amount_due) + '">Record</button>'
        : '') +
      (waivable
        ? '<button class="btn-quiet" data-waive="' + esc(s.id) + '" data-installment="' + esc(s.installment_number) + '">Waive</button>'
        : '') +
    '</div>';
  }

  /* ══ RESERVATIONS ═══════════════════════════════════════════════════════ */
  R.screens.reservations = {
    render: async function (view, params, query) {
      var status = query.status || '';
      var reservations = await api('/reservations' + (status ? '?status=' + status : ''));
      // reports.export, reservations.restructure and reservations.renewTenancy
      // are all DIRECTORS-only (owner + sales_director) — a sales rep has
      // none of them, but 'reservations' is still in their nav for their own
      // book, so each has to be hidden individually rather than the whole
      // screen gated at the route.
      var canExport = R.can('reports.export');
      var canRestructure = R.can('reservations.restructure');
      var canRenew = R.can('reservations.renewTenancy');

      view.innerHTML =
        head('Reservations', 'Unit, buyer, rep and payment plan.',
          (canExport ? '<button class="btn" id="btn-export-reservations">Export CSV</button>' : '') +
          '<button class="btn primary" id="btn-new-res">New reservation</button>') +

        '<div class="filter-row">' +
          '<a class="pill' + (status ? '' : ' is-on') + '" href="#/reservations">All</a>' +
          ['reserved', 'confirmed', 'completed', 'cancelled'].map(function (s) {
            return '<a class="pill' + (status === s ? ' is-on' : '') + '" href="#/reservations?status=' + s + '">' +
              s.charAt(0).toUpperCase() + s.slice(1) + '</a>';
          }).join('') +
        '</div>' +

        card(null, table(
          [{ label: 'Buyer' }, { label: 'Unit' }, { label: 'Plan', hideMobile: true }, { label: 'Value', num: true },
            { label: 'Reserved', hideMobile: true }, { label: 'Status' }, { label: '' }],
          reservations,
          function (r) {
            var unit = r.re_units || {};
            var plan = asArray(r.re_installment_plans)[0];
            var rental = r.property_type === 'rental';
            return '<tr>' +
              '<td class="cell-primary">' + esc((r.re_customers && r.re_customers.full_name) || '—') +
                '<div class="cell-meta">' + esc((r.re_customers && r.re_customers.phone) || '') + '</div></td>' +
              '<td>' + esc(unit.unit_number || '—') +
                '<div class="cell-meta">' + esc((unit.re_projects && unit.re_projects.name) || '') + '</div></td>' +
              '<td class="muted hide-mobile">' +
                (rental
                  ? (plan ? plan.number_of_installments + '-month lease' : 'Rental') +
                    (r.tenancy_end_date ? '<div class="cell-meta">ends ' + esc(fmtDate(r.tenancy_end_date)) + '</div>' : '')
                  : (plan ? plan.number_of_installments + ' installments' : 'Outright')) +
              '</td>' +
              '<td class="num">' + naira(plan ? (rental ? plan.total_amount / plan.number_of_installments : plan.total_amount) : unit.list_price) +
                (rental && plan ? '<div class="cell-meta">/month</div>' : '') +
              '</td>' +
              '<td class="muted hide-mobile">' + esc(fmtDate(r.reserved_at)) + '</td>' +
              '<td>' + badge(r.status) + (r.escalation_stage && r.escalation_stage !== 'none' ? ' ' + badge(r.escalation_stage) : '') + '</td>' +
              '<td class="right nowrap">' +
                (rental
                  ? (canRenew
                    ? '<button class="btn-quiet" data-renew="' + esc(r.id) + '" data-buyer-name="' +
                      esc((r.re_customers && r.re_customers.full_name) || '') + '">Renew tenancy</button> '
                    : '')
                  : asArray(r.re_installment_plans).length && canRestructure
                    ? '<button class="btn-quiet" data-restructure="' + esc(r.id) + '" data-buyer-name="' +
                      esc((r.re_customers && r.re_customers.full_name) || '') + '">Restructure</button> '
                    : '') +
                '<button class="btn-quiet" data-res-menu="' + esc(r.id) + '" data-status="' + esc(r.status) +
                  '" data-rental="' + (rental ? '1' : '') + '" data-buyer-name="' + esc((r.re_customers && r.re_customers.full_name) || '') + '">Change</button>' +
              '</td>' +
            '</tr>';
          },
          { emptyTitle: 'No reservations yet', emptyHint: 'A reservation ties a buyer to a unit and starts their payment schedule.' }
        ), { flush: true });

      R.onClick(view, '#btn-new-res', async function () { await reservationModal({}); });

      R.onClick(view, '#btn-export-reservations', async function () {
        await R.downloadCsv('/reports/export/schedule', 'archta-reservations.csv');
        toast('Exported. Check your downloads.', 'ok');
      });

      R.qsa('[data-res-menu]', view).forEach(function (button) {
        button.addEventListener('click', function () {
          reservationStatusModal(button.dataset.resMenu, button.dataset.status, button.dataset.buyerName, Boolean(button.dataset.rental));
        });
      });

      R.onClick(view, '[data-restructure]', async function (button) {
        await restructureModal(button.dataset.restructure, button.dataset.buyerName);
      });

      R.onClick(view, '[data-renew]', async function (button) {
        await renewTenancyModal(button.dataset.renew, button.dataset.buyerName);
      });
    },
  };

  /* ══ RENEW A TENANCY ═════════════════════════════════════════════════════
     The rental equivalent of restructuring. 60 days before a lease ends the
     morning sweep files a task asking whether to renew or end it
     (src/services/rentalService.js) — this is the "renew" side of that
     decision. The old plan, its schedule and its payments are left exactly as
     they were; a new plan is created for the new period, and the tenancy end
     date moves forward to match. */
  async function renewTenancyModal(reservationId, tenantName) {
    var state = await api('/reservations/' + reservationId + '/renew-tenancy');

    var panel = R.modal({
      title: 'Renew ' + (tenantName ? tenantName + '’s' : 'this') + ' tenancy',
      wide: true,
      body:
        '<div class="grid cols-2 mb-2">' +
          stat('Current monthly rent', state.current_monthly_rent ? naira(state.current_monthly_rent) : '—') +
          stat('Current tenancy ends', fmtDate(state.current_tenancy_end_date), { tone: 'clay' }) +
        '</div>' +

        '<div class="notice info compact">' +
          'The current plan and its payment history are kept exactly as they are. A new rent schedule is ' +
          'created for the renewal period, and the tenancy end date moves forward to match.' +
        '</div>' +

        '<div class="field-row">' +
          '<div class="field"><label for="rn-rent">Monthly rent</label>' +
            '<div class="input-money"><input class="input" id="rn-rent" name="monthly_rent" type="number" min="1" step="10000" value="' +
              (state.current_monthly_rent || '') + '"></div></div>' +
          '<div class="field"><label for="rn-duration">Renewal duration (months)</label>' +
            '<input class="input" id="rn-duration" name="duration_months" type="number" min="1" max="120" value="12"></div>' +
        '</div>' +
        '<div class="field"><label for="rn-start">Renewal start date</label>' +
          '<input class="input" id="rn-start" name="start_date" type="date" value="' +
            (state.current_tenancy_end_date || R.todayISO()) + '">' +
          '<p class="field-hint">Defaults to the day the current tenancy ends, so the tenant\'s paid-for period is never shortened.</p></div>' +

        '<div class="field"><label for="rn-reason">Note (optional)</label>' +
          '<input class="input" id="rn-reason" name="reason" placeholder="Renewed at the same rate"></div>' +

        '<p class="field-hint" id="rn-preview"></p>',
      submitLabel: 'Renew the tenancy',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        if (!v.monthly_rent || !v.duration_months) {
          throw new Error('Set the monthly rent and the renewal duration.');
        }
        var result = await api.post('/reservations/' + reservationId + '/renew-tenancy', {
          monthly_rent: v.monthly_rent,
          duration_months: v.duration_months,
          start_date: v.start_date || null,
          reason: v.reason || null,
        });
        close();
        toast('Tenancy renewed — new end date ' + fmtDate(result.new_tenancy_end_date) + '.', 'ok');
        R.reload();
      },
    });

    var updateRenewalPreview = function () {
      var v = R.values(panel.form);
      var months = Number(v.duration_months);
      if (v.monthly_rent && months > 0 && v.start_date) {
        var endDate = addMonthsClamped(v.start_date, months);
        R.el('rn-preview').textContent = months + ' × ' + naira(v.monthly_rent) +
          ' per month, from ' + fmtDate(v.start_date) + ' — new tenancy end date ' + fmtDate(endDate);
      } else {
        R.el('rn-preview').textContent = '';
      }
    };

    ['rn-rent', 'rn-duration', 'rn-start'].forEach(function (id) {
      R.el(id).addEventListener('input', updateRenewalPreview);
      R.el(id).addEventListener('change', updateRenewalPreview);
    });
    updateRenewalPreview();
  }

  /* ══ RESTRUCTURE A PAYMENT PLAN ═════════════════════════════════════════
     The alternative to cancelling. A buyer three installments down agrees new
     terms; the money they have already paid carries forward and their receipts
     still refer to the schedule they were issued against.

     The preview is fetched from the server, using the same function that will
     build the real schedule — so what the rep reads to the buyer on the phone
     is exactly what gets written. */
  async function restructureModal(reservationId, buyerName) {
    var state = await api('/reservations/' + reservationId + '/restructure');

    var panel = R.modal({
      title: 'Restructure ' + (buyerName ? buyerName + '’s' : 'this') + ' payment plan',
      wide: true,
      body:
        '<div class="grid cols-3 mb-2">' +
          stat('Contract value', naira(state.contract_value)) +
          stat('Already paid', naira(state.total_paid), { tone: 'moss' }) +
          stat('To reschedule', naira(state.remaining), { tone: 'gold', accent: 'gold' }) +
        '</div>' +

        '<p class="field-hint mb-2">' +
          'Current terms: ' + state.current.number_of_installments + ' ' + esc(state.current.frequency) +
          ' installments from ' + esc(fmtDate(state.current.start_date)) + '. ' +
          state.paid_rows + ' paid, ' + state.unpaid_rows + ' unpaid.' +
        '</p>' +

        '<div class="notice info compact">' +
          'The old plan is kept and marked superseded. Paid installments and their receipts are untouched; ' +
          'the ' + state.unpaid_rows + ' unpaid one(s) are waived and replaced by the schedule below.' +
        '</div>' +

        '<div class="field-row three">' +
          '<div class="field"><label for="rs-count">New installments</label>' +
            '<input class="input" id="rs-count" name="number_of_installments" type="number" min="1" max="120" value="12"></div>' +
          '<div class="field"><label for="rs-freq">Frequency</label>' +
            '<select class="select" id="rs-freq" name="frequency">' +
              '<option value="monthly">Monthly</option><option value="quarterly">Quarterly</option>' +
            '</select></div>' +
          '<div class="field"><label for="rs-start">First payment due</label>' +
            '<input class="input" id="rs-start" name="start_date" type="date" value="' + R.todayISO() + '"></div>' +
        '</div>' +

        '<div class="field"><label for="rs-reason">Why?</label>' +
          '<input class="input" id="rs-reason" name="reason" placeholder="Buyer requested a 3-month moratorium">' +
          '<p class="field-hint">Recorded in the activity log. A renegotiated schedule is a change to the terms of a sale, and this is the note that explains it later.</p></div>' +

        '<div id="rs-preview"></div>',
      submitLabel: 'Restructure the plan',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        if (!v.number_of_installments || !v.start_date) {
          throw new Error('Set the number of installments and the first due date.');
        }
        var result = await api.post('/reservations/' + reservationId + '/restructure', {
          number_of_installments: v.number_of_installments,
          frequency: v.frequency,
          start_date: v.start_date,
          reason: v.reason || null,
        });
        close();
        toast('Plan restructured — ' + naira(result.carried_amount_paid) + ' carried forward, '
          + result.schedule.length + ' new installments.', 'ok');
        R.reload();
      },
    });

    // Live preview of the actual dates and amounts, debounced so typing "18"
    // is one request rather than two.
    var timer = null;
    var refresh = function () {
      clearTimeout(timer);
      timer = setTimeout(async function () {
        var v = R.values(panel.form);
        if (!v.number_of_installments || !v.start_date) return;
        try {
          var proposed = await api('/reservations/' + reservationId + '/restructure'
            + '?number_of_installments=' + encodeURIComponent(v.number_of_installments)
            + '&frequency=' + encodeURIComponent(v.frequency)
            + '&start_date=' + encodeURIComponent(v.start_date));

          var target = R.el('rs-preview');
          if (proposed.proposed_error) {
            target.innerHTML = '<div class="notice mt-1">' + esc(proposed.proposed_error) + '</div>';
            return;
          }
          var rows = proposed.proposed || [];
          target.innerHTML = rows.length
            ? '<div class="label mt-2">New schedule</div><div>' + rows.map(function (row) {
                return '<div class="sched"><span class="sched-n">' + row.installment_number + '</span>' +
                  '<span class="sched-main"><span class="mono">' + naira(row.amount_due) + '</span>' +
                  '<span class="page-sub">due ' + esc(fmtDate(row.due_date)) + '</span></span></div>';
              }).join('') + '</div>'
            : '';
        } catch (err) {
          R.el('rs-preview').innerHTML = '<div class="notice mt-1">' + esc(err.message) + '</div>';
        }
      }, 280);
    };

    ['rs-count', 'rs-freq', 'rs-start'].forEach(function (id) {
      R.el(id).addEventListener('input', refresh);
      R.el(id).addEventListener('change', refresh);
    });
    refresh();
  }

  // The modal has to load units, buyers and reps before it can draw itself,
  // so it is async. Every call site now goes through R.onClick, which
  // awaits it directly — spinner on the triggering button, and errors
  // (including "no available units" / "add a buyer first" below) toasted
  // automatically instead of each site needing its own .catch().
  async function reservationModal(preset) {
    var results = await Promise.all([
      api('/units?status=available'),
      api('/customers'),
      api('/sales-reps'),
    ]);
    var units = results[0], customers = results[1], reps = results[2];

    if (!units.length) {
      return toast('No available units. Add units before reserving one.', 'err');
    }
    if (!customers.length) {
      return toast('Add a buyer first.', 'err');
    }

    units = sortUnitsNaturally(units);
    var unitList = units.map(function (u) {
      return {
        id: u.id,
        label: 'Unit ' + u.unit_number + ' — ' + ((u.re_projects && u.re_projects.name) || '') + ' — ' + naira(u.list_price),
        price: u.list_price,
      };
    });

    var panel = R.modal({
      title: 'New reservation',
      wide: true,
      body:
        '<div class="field-row">' +
          '<div class="field"><label for="r-unit">Unit</label>' +
            '<select class="select" id="r-unit" name="unit_id" required>' + options(unitList, 'id', 'label', preset.unitId) + '</select></div>' +
          '<div class="field"><label for="r-customer">Buyer</label>' +
            '<select class="select" id="r-customer" name="customer_id" required>' +
              options(customers, 'id', 'full_name', preset.customerId) + '</select></div>' +
        '</div>' +

        '<div class="field"><label for="r-property-type">What is this?</label>' +
          '<select class="select" id="r-property-type" name="property_type">' +
            '<option value="off_plan">Off-plan sale</option>' +
            '<option value="outright">Outright sale</option>' +
            '<option value="rental">Rental / tenancy</option>' +
          '</select></div>' +

        '<div class="field"><label for="r-rep">Sales rep</label>' +
          '<select class="select" id="r-rep" name="sales_rep_id">' +
            '<option value="">Unassigned</option>' +
            reps.map(function (rep) {
              return '<option value="' + esc(rep.id) + '">' +
                esc((rep.users && (rep.users.full_name || rep.users.email)) || 'Rep') +
                (rep.commission_rate ? ' — ' + rep.commission_rate + '% commission' : '') + '</option>';
            }).join('') +
          '</select>' +
          '<p class="field-hint">Commission accrues to this rep on every payment against this reservation.</p></div>' +

        '<div class="divider"></div>' +

        // Off-plan / outright: a plan is optional (an outright buyer often
        // pays in full, off-book).
        '<label class="check mb-2" id="r-has-plan-row"><input type="checkbox" id="r-has-plan" name="has_plan" checked>' +
          '<span>Set up an installment plan</span></label>' +

        '<div id="r-plan">' +
          '<div class="field-row">' +
            '<div class="field"><label for="r-total">Total amount</label>' +
              '<div class="input-money"><input class="input" id="r-total" name="total_amount" type="number" min="1" step="1"></div></div>' +
            '<div class="field"><label for="r-count">Number of installments</label>' +
              '<input class="input" id="r-count" name="number_of_installments" type="number" min="1" max="120" value="12"></div>' +
          '</div>' +
          '<div class="field-row">' +
            '<div class="field"><label for="r-freq">Frequency</label>' +
              '<select class="select" id="r-freq" name="frequency">' +
                '<option value="monthly">Monthly</option><option value="quarterly">Quarterly</option>' +
              '</select></div>' +
            '<div class="field"><label for="r-start">First payment due</label>' +
              '<input class="input" id="r-start" name="start_date" type="date" value="' + R.todayISO() + '"></div>' +
          '</div>' +
          '<p class="field-hint" id="r-preview"></p>' +
        '</div>' +

        // Rental: always has a rent schedule — "Monthly rent amount" and
        // "Tenancy duration in months" replace "Total amount" and "Number of
        // installments", and the schedule is generated from those two values
        // exactly the way an off-plan plan is (monthly_rent × months = total,
        // months = installment count) — installmentService needs no change.
        '<div id="r-plan-rental" class="hidden">' +
          '<div class="field-row">' +
            '<div class="field"><label for="r-rent">Monthly rent amount</label>' +
              '<div class="input-money"><input class="input" id="r-rent" name="monthly_rent" type="number" min="1" step="10000"></div></div>' +
            '<div class="field"><label for="r-duration">Initial lease period</label>' +
              '<select class="select" id="r-duration" name="duration_months">' +
                '<option value="6">6 months</option>' +
                '<option value="12" selected>1 year</option>' +
                '<option value="24">2 years</option>' +
                '<option value="36">3 years</option>' +
              '</select></div>' +
          '</div>' +
          '<div class="field"><label for="r-tenancy-start">Tenancy start date</label>' +
            '<input class="input" id="r-tenancy-start" name="tenancy_start_date" type="date" value="' + R.todayISO() + '"></div>' +
          '<p class="field-hint" id="r-rental-preview"></p>' +
        '</div>',
      submitLabel: 'Create reservation',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        var payload = {
          unit_id: v.unit_id, customer_id: v.customer_id, sales_rep_id: v.sales_rep_id || null,
          property_type: v.property_type,
        };

        if (v.property_type === 'rental') {
          if (!v.monthly_rent || !v.duration_months || !v.tenancy_start_date) {
            throw new Error('A rental needs a monthly rent amount, a duration and a tenancy start date.');
          }
          var months = Number(v.duration_months);
          payload.tenancy_start_date = v.tenancy_start_date;
          payload.tenancy_end_date = addMonthsClamped(v.tenancy_start_date, months);
          payload.plan = {
            total_amount: Number(v.monthly_rent) * months,
            number_of_installments: months,
            frequency: 'monthly',
            start_date: v.tenancy_start_date,
          };
        } else if (v.has_plan) {
          if (!v.total_amount || !v.number_of_installments || !v.start_date) {
            throw new Error('A plan needs a total, a count and a start date.');
          }
          payload.plan = {
            total_amount: v.total_amount,
            number_of_installments: v.number_of_installments,
            frequency: v.frequency,
            start_date: v.start_date,
          };
        }

        await api.post('/reservations', payload);
        close();
        toast(v.property_type === 'rental' ? 'Tenancy created.' : 'Reservation created.', 'ok');
        R.reload();
      },
    });

    // Default the plan total to the unit's list price, and show what each
    // installment works out at. The last one carries the rounding remainder,
    // which is why the preview says "approximately".
    var form = panel.form;
    var unitSelect = R.el('r-unit');
    var total = R.el('r-total');

    var setPrice = function () {
      var chosen = unitList.find(function (u) { return u.id === unitSelect.value; });
      if (chosen && !total.value) total.value = chosen.price;
      updatePreview();
    };

    var updatePreview = function () {
      var v = R.values(form);
      var count = Number(v.number_of_installments);
      R.el('r-preview').textContent = (v.total_amount && count > 0)
        ? count + ' × approximately ' + naira(v.total_amount / count) + ', ' + v.frequency +
          ', starting ' + fmtDate(v.start_date)
        : '';
    };

    var updateRentalPreview = function () {
      var v = R.values(form);
      var months = Number(v.duration_months);
      if (v.monthly_rent && months > 0 && v.tenancy_start_date) {
        var endDate = addMonthsClamped(v.tenancy_start_date, months);
        R.el('r-rental-preview').textContent = months + ' × ' + naira(v.monthly_rent) +
          ' per month, from ' + fmtDate(v.tenancy_start_date) + ' — tenancy ends ' + fmtDate(endDate);
      } else {
        R.el('r-rental-preview').textContent = '';
      }
    };

    unitSelect.addEventListener('change', setPrice);
    ['r-total', 'r-count', 'r-freq', 'r-start'].forEach(function (id) {
      R.el(id).addEventListener('input', updatePreview);
      R.el(id).addEventListener('change', updatePreview);
    });
    ['r-rent', 'r-duration', 'r-tenancy-start'].forEach(function (id) {
      R.el(id).addEventListener('input', updateRentalPreview);
      R.el(id).addEventListener('change', updateRentalPreview);
    });

    // The whole point of requirement #10: picking "Rental" swaps the plan
    // fields for rent fields rather than showing both at once.
    R.el('r-property-type').addEventListener('change', function (e) {
      var rental = e.target.value === 'rental';
      R.el('r-plan-rental').classList.toggle('hidden', !rental);
      R.el('r-has-plan-row').classList.toggle('hidden', rental);
      R.el('r-plan').classList.toggle('hidden', rental || !R.el('r-has-plan').checked);
      if (rental) updateRentalPreview();
    });

    R.el('r-has-plan').addEventListener('change', function (e) {
      R.el('r-plan').classList.toggle('hidden', !e.target.checked);
    });

    setPrice();
  }

  function reservationStatusModal(id, current, buyerName, isRental) {
    var panel = R.modal({
      title: 'Change reservation status',
      body:
        '<p class="muted mb-2">Currently <b>' + esc(current) + '</b>. The unit follows: cancelling puts it back on the market' +
          (isRental ? ', completing ends the tenancy and the unit is available to let again.</p>' : ', completing takes it off for good.</p>') +
        '<div class="field"><label for="rs-status">New status</label>' +
          '<select class="select" id="rs-status" name="status">' +
            ['reserved', 'confirmed', 'completed', 'cancelled'].map(function (s) {
              return '<option value="' + s + '"' + (s === current ? ' selected' : '') + '>' +
                s.charAt(0).toUpperCase() + s.slice(1) + '</option>';
            }).join('') +
          '</select></div>' +
        '<div id="rs-warn"></div>',
      submitLabel: 'Update',
      onSubmit: async function (form, close) {
        var next = R.values(form).status;

        // Cancelling is the one transition that cannot be undone by picking a
        // different option afterwards: it frees the unit, so somebody else can
        // reserve it in the meantime and the original buyer's allocation is
        // gone. A misclick by a collections officer would be a self-inflicted
        // double allocation, so it gets a typed confirmation rather than an
        // "are you sure" nobody reads.
        if (next === 'cancelled' && current !== 'cancelled') {
          close();
          return confirmCancellation(id, buyerName);
        }

        await api.patch('/reservations/' + id + '/status', { status: next });
        close();
        toast('Reservation updated.', 'ok');
        R.reload();
      },
    });

    // The consequence appears as soon as the option is chosen, before the
    // button is pressed.
    var select = R.qs('#rs-status', panel.form);
    var warn = R.qs('#rs-warn', panel.form);
    var describe = function () {
      var next = select.value;
      warn.innerHTML =
        next === 'cancelled' && current !== 'cancelled'
          ? '<div class="notice mt-1">The unit returns to <b>available</b> and can be reserved by someone else. ' +
            'The payment history stays, but the allocation does not.</div>'
          : next === 'completed'
            ? (isRental
                ? '<div class="notice info mt-1">The tenancy ends and the unit returns to <b>available</b> to let again.</div>'
                : '<div class="notice info mt-1">The unit is marked <b>sold</b> and taken off the market permanently.</div>')
            : '';
    };
    select.addEventListener('change', describe);
    describe();
  }

  // Typing the word is the point. A confirm dialog with a button is dismissed
  // reflexively; a word has to be read first.
  function confirmCancellation(id, buyerName) {
    var panel = R.modal({
      title: 'Cancel this reservation?',
      body:
        '<div class="notice mb-2">This frees the unit for anyone else to reserve. ' +
        (buyerName ? esc(buyerName) + ' loses their allocation.' : 'The buyer loses their allocation.') +
        '</div>' +
        '<p class="muted mb-2">Their payments and receipts are kept, and the change is recorded in the activity log against your name.</p>' +
        '<div class="field"><label for="cx-word">Type <b>CANCEL</b> to confirm</label>' +
          '<input class="input" id="cx-word" name="word" autocomplete="off" spellcheck="false" placeholder="CANCEL"></div>',
      submitLabel: 'Cancel the reservation',
      onSubmit: async function (form, close) {
        if (R.values(form).word.toUpperCase() !== 'CANCEL') {
          throw new Error('Type CANCEL exactly to confirm, or close this box to leave it alone.');
        }
        await api.patch('/reservations/' + id + '/status', { status: 'cancelled' });
        close();
        toast('Reservation cancelled. The unit is available again.', 'ok');
        R.reload();
      },
    });

    // Scoped to this modal's own root — see the comment in deleteModal().
    var submit = R.qs('[type="submit"]', panel.root);
    if (submit) { submit.classList.remove('primary'); submit.classList.add('danger'); }
  }

  /* ══ PAYMENTS ═══════════════════════════════════════════════════════════ */
  var PAYMENTS_HISTORY_PER_PAGE = 50;
  var PAYMENTS_SCHEDULE_PER_PAGE = 50; // buyers per page, not installment rows

  // Which buyer's row is expanded on the Schedule tab. Module-level, not a
  // closure var inside render(), so it survives R.reload() — recording a
  // payment from inside the expanded row reloads the whole route, and the
  // rep should still be looking at the buyer they were just working on, not
  // back at a fully collapsed list.
  var expandedScheduleBuyerId = null;

  // This screen was already permission-agnostic before Sales Rep got read
  // access here: it fetches /payments and /payments/schedule directly and
  // trusts the server's row-level filter (permissions.js's payments.read /
  // payments.schedule now include sales_rep, scoped to their own buyers via
  // salesRepIdsFor — CLAUDE.md's "Row-level filtering" section), and its
  // write actions (Record, the Paystack Link button, Void) are separately
  // gated on payments.record/payments.void below, which a rep still does not
  // have. So nothing here needed to change for a rep to see their own
  // buyers' payment status read-only, exactly as intended.
  //
  // What still needs doing OUTSIDE this file: realestate.js's NAV_BY_ROLE
  // has no 'payments' entry for sales_rep, so there is no sidebar link to
  // this screen for that role yet — the route itself works if reached
  // directly (#/payments). Adding the nav entry is a one-line change in
  // realestate.js, which this pass does not own/touch.
  R.screens.payments = {
    render: async function (view, params, query) {
      var tab = query.tab || 'all';
      if (tab === 'due') tab = 'all'; // pre-redesign bookmark or link

      if (tab === 'history') {
        var payments = await api('/payments?limit=200');
        var historyPage = 1;

        var renderHistory = function () {
          var p = paginate(payments, PAYMENTS_HISTORY_PER_PAGE, historyPage);
          historyPage = p.page;

          view.innerHTML =
            head('Payments', 'Every naira received, most recent first.',
              '<button class="btn" id="btn-export-payments">Export CSV</button>') +
            paymentTabs(tab) +
            card(null, table(
              [{ label: 'Date' }, { label: 'Buyer' }, { label: 'Unit', hideMobile: true },
                { label: 'Method', hideMobile: true },
                { label: 'Amount', num: true }, { label: '' }],
              p.slice,
              function (row) {
                var s = row.re_installment_schedule || {};
                var reservation = (s.re_installment_plans && s.re_installment_plans.re_reservations) || {};
                var unit = reservation.re_units || {};
                var buyerName = (reservation.re_customers && reservation.re_customers.full_name) || '';
                return '<tr' + (row.voided_at ? ' class="is-voided"' : '') + '>' +
                  '<td class="muted">' + esc(fmtDate(row.paid_at)) + '</td>' +
                  '<td class="cell-primary">' + esc(buyerName || '—') + '</td>' +
                  '<td class="muted hide-mobile">' + esc(unit.unit_number || '—') +
                    '<div class="cell-meta">' + esc((unit.re_projects && unit.re_projects.name) || '') + '</div></td>' +
                  '<td class="muted hide-mobile">' + esc(String(row.method).replace(/_/g, ' ')) + '</td>' +
                  '<td class="num moss">' + naira(row.amount) +
                    (row.voided_at ? '<div class="cell-meta">voided — ' + esc(row.void_reason || '') + '</div>' : '') + '</td>' +
                  '<td class="right nowrap">' + (row.voided_at
                    ? '<span class="muted">Voided</span>'
                    : '<button class="btn-quiet" data-receipt="' + esc(row.id) + '">Receipt</button> ' +
                      (R.can('payments.void')
                        ? '<button class="btn-quiet" data-void="' + esc(row.id) + '" data-amount="' + esc(row.amount) +
                          '" data-name="' + esc(buyerName) + '">Void</button>'
                        : '')) + '</td>' +
                '</tr>';
              },
              {
                emptyTitle: 'No payments recorded yet',
                emptyHint: 'Record one against a due installment, or wait for the next Paystack payment to settle.',
                emptyAction: '<a class="btn-quiet" href="#/payments?tab=all">Go to Schedule</a>',
              }
            ), { flush: true }) +
            paginationControls(p);

          R.onClick(view, '[data-receipt]', async function (button) {
            var result = await api.post('/payments/' + button.dataset.receipt + '/receipt');
            R.openFile(result.download_url);
            toast('Receipt ' + result.receipt_number + ' ready.', 'ok');
          });

          R.qsa('[data-void]', view).forEach(function (button) {
            button.addEventListener('click', async function () {
              var voided = await voidPaymentModal(button.dataset.void, button.dataset.amount, button.dataset.name);
              if (voided) renderHistory();
            });
          });

          R.onClick(view, '#btn-export-payments', async function () {
            await R.downloadCsv('/reports/export/payments', 'archta-payments.csv');
            toast('Exported. Check your downloads.', 'ok');
          });

          var prev = R.qs('[data-page-prev]', view);
          if (prev) prev.addEventListener('click', function () { historyPage -= 1; renderHistory(); });
          var next = R.qs('[data-page-next]', view);
          if (next) next.addEventListener('click', function () { historyPage += 1; renderHistory(); });
        };

        renderHistory();
        return;
      }

      if (['all', 'overdue', 'due_week'].indexOf(tab) === -1) tab = 'all';

      // Fetched once, ungrouped and unfiltered by status — "X of Y paid" and
      // "remaining balance" per buyer need the buyer's WHOLE plan, not just
      // whichever slice the active tab cares about, so grouping and tab
      // filtering both happen client-side against this one fetch.
      var schedule = await api('/payments/schedule?limit=1000');
      var buyers = groupScheduleByBuyer(schedule);
      var filtered = filterBuyersForTab(buyers, tab).sort(function (a, b) {
        // Most urgent first: earliest still-open due date, buyers with
        // nothing open (shouldn't happen once filtered, but guarded anyway)
        // sort last.
        var ea = a.earliestOpenDue || '9999-99-99';
        var eb = b.earliestOpenDue || '9999-99-99';
        return ea < eb ? -1 : ea > eb ? 1 : 0;
      });
      var schedulePage = 1;

      var totalOutstanding = filtered.reduce(function (sum, b) { return sum + b.remaining; }, 0);
      var openRowCount = filtered.reduce(function (sum, b) {
        if (tab === 'overdue') return sum + b.rows.filter(function (r) { return r.status === 'overdue'; }).length;
        if (tab === 'due_week') return sum + b.dueThisWeekRows.length;
        return sum + b.rows.filter(function (r) { return r.status === 'pending' || r.status === 'overdue'; }).length;
      }, 0);
      var thirdStatLabel = tab === 'overdue' ? 'Overdue installments' : tab === 'due_week' ? 'Due this week' : 'Open installments';

      var renderSchedule = function () {
        var p = paginate(filtered, PAYMENTS_SCHEDULE_PER_PAGE, schedulePage);
        schedulePage = p.page;

        view.innerHTML =
          head('Payments', tab === 'overdue' ? 'Buyers with an installment past its due date.'
            : tab === 'due_week' ? 'Buyers with an installment due in the next 7 days.'
            : 'Every buyer who still owes something.') +
          paymentTabs(tab) +
          '<div class="grid cols-3 mb-2">' +
            stat('Buyers', String(filtered.length)) +
            stat('Outstanding', naira(totalOutstanding), { tone: tab === 'overdue' ? 'clay' : null }) +
            stat(thirdStatLabel, String(openRowCount)) +
          '</div>' +

          card(null, table(
            [{ label: 'Buyer' }, { label: 'Unit' }, { label: 'Paid', hideMobile: true }, { label: 'Remaining', num: true }],
            p.slice,
            buyerRow,
            {
              emptyTitle: tab === 'overdue' ? 'Nothing is overdue' : tab === 'due_week' ? 'Nothing due this week' : 'Nothing outstanding',
              emptyHint: 'Reservations with an open payment plan appear here.',
            }
          ), { flush: true }) +
          paginationControls(p);

        wireScheduleRowActions(view);

        // Only one buyer open at a time — expanding another collapses
        // whichever was open, same as it would in a plain accordion.
        R.qsa('[data-expand]', view).forEach(function (row) {
          row.addEventListener('click', function (event) {
            if (event.target.closest('[data-stop]')) return;
            var id = row.dataset.expand;
            expandedScheduleBuyerId = expandedScheduleBuyerId === id ? null : id;
            renderSchedule();
          });
        });

        var prev = R.qs('[data-page-prev]', view);
        if (prev) prev.addEventListener('click', function () { schedulePage -= 1; renderSchedule(); });
        var next = R.qs('[data-page-next]', view);
        if (next) next.addEventListener('click', function () { schedulePage += 1; renderSchedule(); });
      };

      renderSchedule();
    },
  };

  function paymentTabs(active) {
    return '<div class="filter-row">' +
      [['all', 'All'], ['overdue', 'Overdue'], ['due_week', 'Due this week'], ['history', 'History']].map(function (t) {
        return '<a class="pill' + (active === t[0] ? ' is-on' : '') + '" href="#/payments?tab=' + t[0] + '">' + t[1] + '</a>';
      }).join('') +
    '</div>';
  }

  // One row per installment plan (== one row per buyer — a reservation has
  // at most one active plan). /payments/schedule already excludes a
  // restructured reservation's superseded plan server-side, so grouping by
  // plan_id here can never mix two different "number_of_installments"
  // totals for the same buyer together.
  function groupScheduleByBuyer(schedule) {
    var byPlan = {};
    var todayStr = localDateStr(new Date());
    var weekAheadStr = localDateStr(new Date(Date.now() + 6 * 86400000));

    schedule.forEach(function (row) {
      var plan = row.re_installment_plans;
      var reservation = plan.re_reservations;
      if (!byPlan[plan.id]) {
        byPlan[plan.id] = {
          reservationId: reservation.id,
          customer: reservation.re_customers || {},
          unit: reservation.re_units || {},
          project: (reservation.re_units && reservation.re_units.re_projects) || {},
          numberOfInstallments: plan.number_of_installments,
          rows: [],
        };
      }
      byPlan[plan.id].rows.push(row);
    });

    return Object.keys(byPlan).map(function (planId) {
      var b = byPlan[planId];
      b.rows.sort(function (x, y) { return x.installment_number - y.installment_number; });
      b.paidCount = b.rows.filter(function (r) { return r.status === 'paid'; }).length;
      // A waived row's amount_outstanding is still computed as due-minus-paid
      // server-side (the column does not know about waiving) — excluded here
      // the same way receiptService/portalService exclude a reallocated
      // payment from a "how much is owed" total: it is not real debt any more.
      b.remaining = b.rows.reduce(function (sum, r) {
        return sum + (r.status === 'waived' ? 0 : Number(r.amount_outstanding || 0));
      }, 0);
      b.hasOverdue = b.rows.some(function (r) { return r.status === 'overdue'; });
      b.dueThisWeekRows = b.rows.filter(function (r) {
        return r.status === 'pending' && r.due_date >= todayStr && r.due_date <= weekAheadStr;
      });
      var openRows = b.rows.filter(function (r) { return r.status === 'pending' || r.status === 'overdue'; });
      b.earliestOpenDue = openRows.length
        ? openRows.reduce(function (min, r) { return r.due_date < min ? r.due_date : min; }, openRows[0].due_date)
        : null;
      return b;
    });
  }

  function filterBuyersForTab(buyers, tab) {
    if (tab === 'overdue') return buyers.filter(function (b) { return b.hasOverdue; });
    if (tab === 'due_week') return buyers.filter(function (b) { return b.dueThisWeekRows.length > 0; });
    return buyers.filter(function (b) { return b.remaining > 0; });
  }

  // The collapsed summary row plus its detail row, always rendered as a pair
  // — table()'s rowFn just needs to return a string, and a <tbody> does not
  // care whether that string is one <tr> or two.
  function buyerRow(b) {
    var isOpen = expandedScheduleBuyerId === b.reservationId;
    return (
      '<tr class="is-clickable buyer-summary-row' + (isOpen ? ' is-open' : '') + '" data-expand="' + esc(b.reservationId) + '">' +
        '<td class="cell-primary">' +
          '<span class="expand-caret">▸</span>' + esc(b.customer.full_name || '—') +
          (b.hasOverdue ? ' ' + badge('overdue') : '') +
        '</td>' +
        '<td class="muted">' + esc(b.unit.unit_number || '—') +
          '<div class="cell-meta">' + esc(b.project.name || '') + '</div></td>' +
        '<td class="muted hide-mobile">' + b.paidCount + ' of ' + b.numberOfInstallments + ' paid</td>' +
        '<td class="num">' + naira(b.remaining) + '</td>' +
      '</tr>' +
      '<tr class="' + (isOpen ? '' : 'hidden') + '" data-buyer-detail="' + esc(b.reservationId) + '">' +
        '<td class="sched-detail-cell" colspan="4">' +
          b.rows.map(function (s) { return scheduleActionRow(s, b.customer); }).join('') +
        '</td>' +
      '</tr>'
    );
  }

  // One installment line inside an expanded buyer row — same badge/layout
  // idiom as scheduleRow() (the buyer-drawer's own schedule), just with the
  // Record/Link actions this screen has always offered instead of Waive.
  function scheduleActionRow(s, customer) {
    var recordable = (s.status === 'pending' || s.status === 'overdue') && R.can('payments.record');
    return '<div class="sched ' + esc(s.status) + '">' +
      '<span class="sched-n">' + s.installment_number + '</span>' +
      '<span class="sched-main"><span class="mono">' + naira(s.amount_due) + '</span>' +
        '<span class="page-sub">' + (s.status === 'overdue' ? 'overdue since ' : 'due ') + esc(fmtDate(s.due_date)) +
          (s.paid_at ? ' · paid ' + esc(fmtDate(s.paid_at)) : '') + '</span></span>' +
      badge(s.status) +
      (recordable
        ? '<button class="btn-quiet" data-record="' + esc(s.id) + '" data-outstanding="' + esc(s.amount_outstanding) +
          '" data-name="' + esc(customer.full_name || '') + '" data-customer="' + esc(customer.id || '') + '">Record</button>'
        : '') +
      (recordable && customer.email
        ? '<button class="btn-quiet" data-link="' + esc(s.id) + '">Link</button>' +
          // Hidden until the button above is clicked — generating and
          // copying a payment link used to fire the instant it was clicked,
          // with no way to back out of a misclick.
          '<span class="hidden" data-link-confirm="' + esc(s.id) + '">' +
            '<span class="page-sub">Send Paystack link to ' + esc(customer.full_name || 'this buyer') +
              ' for ' + esc(naira(s.amount_outstanding)) + '?</span> ' +
            '<button class="btn-quiet" data-link-yes="' + esc(s.id) + '" data-email="' + esc(customer.email) + '">Confirm</button> ' +
            '<button class="btn-quiet" data-link-no="' + esc(s.id) + '">Cancel</button>' +
          '</span>'
        : '') +
    '</div>';
  }

  // Record and Link both live inside collapsed-by-default detail rows, so
  // this runs after every render (initial, page change, or expand/collapse)
  // rather than once — a row that was hidden a moment ago may hold buttons
  // that have never been wired.
  function wireScheduleRowActions(root) {
    R.qsa('[data-record]', root).forEach(function (button) {
      button.addEventListener('click', function () {
        recordPaymentModal(button.dataset.record, button.dataset.outstanding, button.dataset.name, button.dataset.customer);
      });
    });

    R.qsa('[data-link]', root).forEach(function (button) {
      button.addEventListener('click', function () {
        button.classList.add('hidden');
        R.qs('[data-link-confirm="' + button.dataset.link + '"]', root).classList.remove('hidden');
      });
    });

    R.qsa('[data-link-no]', root).forEach(function (button) {
      button.addEventListener('click', function () {
        var id = button.dataset.linkNo;
        R.qs('[data-link-confirm="' + id + '"]', root).classList.add('hidden');
        R.qs('[data-link="' + id + '"]', root).classList.remove('hidden');
      });
    });

    R.onClick(root, '[data-link-yes]', async function (button) {
      var id = button.dataset.linkYes;
      var result = await api.post('/payments/' + id + '/init', { customer_email: button.dataset.email });
      await R.copyText(result.authorization_url);
      toast('Paystack link for ' + naira(result.amount) + ' copied to your clipboard.', 'ok');
      R.qs('[data-link-confirm="' + id + '"]', root).classList.add('hidden');
      R.qs('[data-link="' + id + '"]', root).classList.remove('hidden');
    });
  }

  function recordPaymentModal(scheduleId, outstanding, customerName, customerId) {
    var due = Number(outstanding || 0);

    var panel = R.modal({
      title: 'Record a payment',
      body:
        (customerName ? '<p class="muted mb-2">From <b>' + esc(customerName) + '</b>.</p>' : '') +
        '<div class="field"><label for="pay-amount">Amount received</label>' +
          '<div class="input-money"><input class="input" id="pay-amount" name="amount" type="number" min="1" step="1" required value="' + esc(outstanding || '') + '"></div>' +
          '<p class="field-hint">Part payments are fine. The installment settles once it is fully covered.</p>' +
          '<div id="pay-warn"></div></div>' +
        '<div class="field"><label for="pay-method">Method</label>' +
          '<select class="select" id="pay-method" name="method">' +
            '<option value="bank_transfer">Bank transfer</option>' +
            '<option value="cash">Cash</option>' +
            '<option value="pos">POS</option>' +
            '<option value="paystack">Paystack</option>' +
          '</select></div>' +
        '<div class="field"><label for="pay-ref">Reference</label>' +
          '<input class="input" id="pay-ref" name="reference" placeholder="Bank reference or teller number"></div>' +
        '<div class="field"><label for="pay-payer">Payer name <span class="muted">(if not ' + esc(customerName || 'the buyer') + ')</span></label>' +
          '<input class="input" id="pay-payer" name="payer_name" placeholder="e.g. a spouse, company or lawyer\'s account"></div>',
      submitLabel: 'Record payment',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        if (!v.amount) throw new Error('Enter the amount received.');

        var result = await api.post('/payments/' + scheduleId + '/record', {
          amount: v.amount, method: v.method, reference: v.reference || null, payer_name: v.payer_name || null,
        });
        close();

        // Say what actually happened. "Receipt generated, buyer emailed" and
        // "receipt generated, email not configured" are different outcomes and
        // the person who just took ₦2m needs to know which one they got.
        var effects = result.effects || {};
        var notes = [];
        if (effects.receipt === 'generated') notes.push('receipt generated');
        if (effects.buyer_email === 'sent') notes.push('buyer emailed');
        else if (effects.buyer_email === 'skipped') notes.push('no email sent');
        if (String(effects.commission).indexOf('accrued') === 0) notes.push(effects.commission);

        toast('Payment recorded' + (notes.length ? ' — ' + notes.join(', ') : '') + '.', 'ok');

        // Not blocked — a buyer really can pay the same amount twice in one
        // day — but flagged immediately, while whoever just recorded it can
        // still remember whether it really was a second transfer. Void it
        // from Payments → History if it was not.
        if (result.possible_duplicate) {
          toast('A payment of the same amount was already recorded on this installment in the last 24 hours. Check this isn\'t a duplicate entry.', 'err');
        }

        // An overpayment gets its own message, not a clause in a list. It is
        // the thing the buyer will phone about — and immediately after it, a
        // chance to actually do something about it rather than a note to
        // "agree with the buyer later" that nobody comes back to.
        if (result.overpayment > 0) {
          toast(naira(result.overpayment) + ' more than this installment required.', 'err');

          if (customerId) {
            // The credit is a real column on the payment row now (server
            // computed it before this response came back), so there is
            // nothing to mark client-side — dismissing this picker without
            // allocating still leaves it correctly visible next time this
            // buyer's record is opened, on any device.
            await allocateOverpaymentModal(result.id, scheduleId, customerId, result.overpayment);
          }
        }

        R.refreshCounts();
        R.reload();
      },
    });

    // Warn while they type, not after they submit. Recording ₦5,000,000 against
    // a ₦500,000 installment is usually a missed decimal point, and the moment
    // to catch it is before the row exists.
    var amount = R.qs('#pay-amount', panel.form);
    var warn = R.qs('#pay-warn', panel.form);

    amount.addEventListener('input', function () {
      var value = Number(amount.value || 0);
      if (due > 0 && value > due) {
        warn.innerHTML = '<div class="notice mt-1">' +
          esc(naira(value - due)) + ' more than the ' + esc(naira(due)) + ' outstanding on this installment. ' +
          'It will be recorded, and flagged as a credit for you to allocate.</div>';
      } else if (due > 0 && value > 0 && value < due) {
        warn.innerHTML = '<div class="notice info mt-1">Part payment — ' +
          esc(naira(due - value)) + ' will remain outstanding.</div>';
      } else {
        warn.innerHTML = '';
      }
    });
  }

  /* ══ WAIVE AN INSTALLMENT ══════════════════════════════════════════════
     A write-off, not a payment — a goodwill gesture, a dispute settled
     another way, a bad debt finally accepted. The reason is required because,
     unlike a payment, there is no receipt behind this to explain later why the
     money stopped being owed. */
  function waiveModal(scheduleId, installmentNumber, customerName) {
    return new Promise(function (resolve) {
      var panel = R.modal({
        title: 'Waive installment ' + installmentNumber,
        body:
          (customerName ? '<p class="muted mb-2">For <b>' + esc(customerName) + '</b>.</p>' : '') +
          '<div class="field"><label for="waive-reason">Reason</label>' +
            '<textarea class="textarea" id="waive-reason" name="reason" rows="3" required ' +
              'placeholder="Why is this being written off?"></textarea>' +
            '<p class="field-hint">Recorded in the activity log.</p></div>',
        submitLabel: 'Waive installment',
        onSubmit: async function (form, close) {
          var v = R.values(form);
          if (!v.reason) throw new Error('A reason is required.');
          await api.patch('/payments/' + scheduleId + '/waive', { reason: v.reason });
          close();
          toast('Installment waived.', 'ok');
          resolve(true);
        },
      });
      // Scoped to this modal's own root — see the comment in deleteModal().
      var submit = R.qs('[type="submit"]', panel.root);
      if (submit) { submit.classList.remove('primary'); submit.classList.add('danger'); }
      qsaCloseWatch(panel, resolve);
    });
  }

  /* ══ VOID A WRONGLY RECORDED PAYMENT ═══════════════════════════════════
     Not a delete — the entry stays in the ledger, dimmed, with the reason
     attached, because a payment is a financial fact even when it was
     entered wrong. Any commission it earned is voided with it. */
  function voidPaymentModal(paymentId, amount, customerName) {
    return new Promise(function (resolve) {
      var panel = R.modal({
        title: 'Void this payment',
        body:
          '<p class="muted mb-2">' + esc(naira(amount)) + (customerName ? ' from ' + esc(customerName) : '') +
            '. The entry stays on the record, marked voided — it stops counting toward what is owed, ' +
            'and any commission it earned is voided with it.</p>' +
          '<div class="field"><label for="void-reason">Reason</label>' +
            '<textarea class="textarea" id="void-reason" name="reason" rows="3" required ' +
              'placeholder="Why was this entered wrongly?"></textarea>' +
            '<p class="field-hint">Recorded in the activity log.</p></div>',
        submitLabel: 'Void payment',
        onSubmit: async function (form, close) {
          var v = R.values(form);
          if (!v.reason) throw new Error('A reason is required.');
          await api.post('/payments/' + paymentId + '/void', { reason: v.reason });
          close();
          toast('Payment voided.', 'ok');
          resolve(true);
        },
      });
      // Scoped to this modal's own root — see the comment in deleteModal().
      var submit = R.qs('[type="submit"]', panel.root);
      if (submit) { submit.classList.remove('primary'); submit.classList.add('danger'); }
      qsaCloseWatch(panel, resolve);
    });
  }

  // Every dismissal path a modal can take — the × button, "Cancel", the
  // backdrop, Escape — resolves the same outer promise with `false` if
  // nothing has resolved it already. `resolve` is a no-op the second time it
  // is called, so a real Confirm followed by the modal's own close() calling
  // this again costs nothing.
  function qsaCloseWatch(panel, resolve) {
    R.qsa('[data-close]', panel.root).forEach(function (button) {
      button.addEventListener('click', function () { resolve(false); });
    });
    panel.root.addEventListener('mousedown', function (e) {
      if (e.target === panel.root) resolve(false);
    });
  }

  /* ══ OVERPAYMENT ALLOCATION ═════════════════════════════════════════════
     A buyer sends more than one installment required. The excess is real
     money already recorded — what it is not yet is ASSIGNED to anything, and
     "agree with the buyer which installment it goes against" used to be the
     whole plan. This is that conversation, made concrete: every other open
     installment for the same buyer, one tap to apply the credit to it.

     The credit itself is a column on the original payment row
     (re_payments.overpayment) — the server surfaces it on the buyer's
     record (c.unallocated_credit), so it is visible to any staff member on
     any device, not just the one that recorded the payment. */

  // `onResolved(true)` fires only once the excess has actually been applied
  // somewhere — that is the one signal the caller needs, to know whether to
  // refresh a drawer that might now be showing the persistent notice.
  async function allocateOverpaymentModal(paymentId, excludeScheduleId, customerId, overpaymentAmount, onResolved) {
    var rows = await api('/payments/schedule?customer_id=' + encodeURIComponent(customerId) + '&limit=200');
    var candidates = rows.filter(function (s) {
      return s.id !== excludeScheduleId && (s.status === 'pending' || s.status === 'overdue');
    });

    var panel = R.modal({
      title: 'Allocate the credit',
      wide: true,
      body:
        '<p class="muted mb-2">' + esc(naira(overpaymentAmount)) +
          ' was paid over what this installment required. Pick which installment it should go against instead.</p>' +
        (candidates.length
          ? '<div>' + candidates.map(function (s) {
              var reservation = s.re_installment_plans.re_reservations;
              var unit = reservation.re_units || {};
              return '<div class="sched ' + esc(s.status) + '">' +
                '<span class="sched-n">' + s.installment_number + '</span>' +
                '<span class="sched-main"><span class="mono">' + naira(s.amount_outstanding) + '</span>' +
                  '<span class="page-sub">' + (unit.unit_number ? 'Unit ' + esc(unit.unit_number) + ' · ' : '') +
                    'due ' + esc(fmtDate(s.due_date)) + '</span></span>' +
                badge(s.status) +
                '<button class="btn-quiet" data-allocate="' + esc(s.id) + '">Apply here</button>' +
              '</div>';
            }).join('') + '</div>'
          : '<p class="muted">This buyer has no other pending or overdue installment to allocate it to right now.</p>'),
      cancelLabel: 'Decide later',
    });

    R.qsa('[data-allocate]', panel.root).forEach(function (button) {
      button.addEventListener('click', async function () {
        if (button.disabled) return;
        button.disabled = true;
        try {
          // Moves the existing credit — it is not a second transfer, so this
          // does not go through /record a second time (that was the bug: a
          // brand-new payment row for money that never arrived twice).
          await api.post('/payments/' + paymentId + '/reallocate', {
            to_schedule_id: button.dataset.allocate,
          });
          panel.close();
          toast('Credit allocated.', 'ok');
          if (onResolved) onResolved(true);
        } catch (err) {
          button.disabled = false;
          toast(err.message, 'err');
        }
      });
    });

    // "Decide later", the × button, the backdrop or Escape all leave the
    // credit exactly as unallocated as it was before this opened — the
    // persistent notice (set the moment the overpayment was recorded) is what
    // carries that forward, so nothing extra needs to happen here.
    if (onResolved) qsaCloseWatch(panel, function () { onResolved(false); });
  }

  /* ══ DOCUMENTS ══════════════════════════════════════════════════════════ */
  R.screens.documents = {
    render: async function (view) {
      var results = await Promise.all([api('/documents'), api('/reservations')]);
      var documents = results[0], reservations = results[1];

      view.innerHTML =
        head('Documents', 'Allocation letters and receipts, stored privately and served through short-lived links.',
          '<button class="btn primary" id="btn-new-doc">New allocation letter</button>') +

        card(null, table(
          [{ label: 'Type' }, { label: 'Buyer' }, { label: 'Unit' }, { label: 'Status' }, { label: 'Generated' }, { label: '' }],
          documents,
          function (d) {
            var reservation = d.re_reservations || {};
            var unit = reservation.re_units || {};
            return '<tr>' +
              '<td class="cell-primary">' + esc(String(d.doc_type).replace(/_/g, ' ')) + '</td>' +
              '<td>' + esc((reservation.re_customers && reservation.re_customers.full_name) || '—') + '</td>' +
              '<td class="muted">' + esc(unit.unit_number || '—') + '</td>' +
              '<td>' + badge(d.status) + '</td>' +
              '<td class="muted">' + esc(d.generated_at ? fmtDate(d.generated_at) : '—') + '</td>' +
              '<td class="right nowrap">' + (d.status === 'generated'
                ? '<button class="btn-quiet" data-download="' + esc(d.id) + '">Download</button>'
                : '<button class="btn-quiet" data-generate="' + esc(d.id) + '">Generate</button>') + '</td>' +
            '</tr>';
          },
          { emptyTitle: 'No documents yet', emptyHint: 'Allocation letters are generated per reservation; receipts appear automatically when a payment is recorded.' }
        ), { flush: true });

      R.onClick(view, '[data-generate]', async function (button) {
        var result = await api.post('/documents/' + button.dataset.generate + '/generate');
        R.openFile(result.download_url);
        toast('Document generated.', 'ok');
        R.reload();
      });

      R.onClick(view, '[data-download]', async function (button) {
        var result = await api('/documents/' + button.dataset.download + '/download');
        R.openFile(result.download_url);
      });

      R.qs('#btn-new-doc', view).addEventListener('click', function () {
        if (!reservations.length) return toast('Create a reservation first.', 'err');

        var list = reservations.map(function (r) {
          var unit = r.re_units || {};
          return {
            id: r.id,
            label: ((r.re_customers && r.re_customers.full_name) || 'Buyer') +
              (unit.unit_number ? ' — Unit ' + unit.unit_number : ''),
          };
        });

        R.modal({
          title: 'New allocation letter',
          body:
            '<div class="field"><label for="doc-res">Reservation</label>' +
              '<select class="select" id="doc-res" name="reservation_id">' + options(list, 'id', 'label') + '</select></div>' +
            '<p class="field-hint">The letter uses the letterhead from Settings. Set your company name and logo there first if you have not.</p>',
          submitLabel: 'Create and generate',
          onSubmit: async function (form, close) {
            var created = await api.post('/documents', {
              reservation_id: R.values(form).reservation_id,
              doc_type: 'allocation_letter',
            });
            close();
            toast('Generating the letter…');
            try {
              var result = await api.post('/documents/' + created.id + '/generate');
              R.openFile(result.download_url);
              toast('Allocation letter ready.', 'ok');
            } catch (err) {
              // Puppeteer is absent on some runtimes. The document row still
              // exists, so say what happened rather than pretending it worked.
              toast('Document created but could not be rendered: ' + err.message, 'err');
            }
            R.reload();
          },
        });
      });
    },
  };

  /* ══ COMMISSIONS ════════════════════════════════════════════════════════ */
  R.screens.commissions = {
    render: async function (view, params, query) {
      // 'summary' (by rep) and 'performance' need commissions.readAll — a
      // sales rep only ever has commissions.read (their own entries). Landing
      // them on the default they cannot open would 403 the whole screen on
      // the one click most people take to get here (the sidebar link, which
      // carries no ?tab=).
      var tab = query.tab || (R.can('commissions.readAll') ? 'summary' : 'entries');

      if (tab === 'performance') {
        var performance = await api('/commissions/performance');
        view.innerHTML = head('Sales performance', 'Who is selling, and who is collecting.') + commissionTabs(tab) +
          card(null, table(
            [{ label: 'Rep' }, { label: 'Reservations', num: true, hideMobile: true },
              { label: 'This month', num: true, hideMobile: true },
              { label: 'Portfolio', num: true, hideMobile: true }, { label: 'Collected', num: true },
              { label: 'Rate', num: true, hideMobile: true },
              { label: 'At risk', num: true, hideMobile: true }, { label: 'Commission', num: true }],
            performance,
            function (p) {
              return '<tr>' +
                '<td class="cell-primary">' + esc(p.name) + (p.active ? '' : ' <span class="badge none">inactive</span>') + '</td>' +
                '<td class="num hide-mobile">' + p.reservations_total + '</td>' +
                '<td class="num hide-mobile">' + p.reservations_this_month + '</td>' +
                '<td class="num muted hide-mobile">' + nairaShort(p.portfolio_value) + '</td>' +
                '<td class="num moss">' + nairaShort(p.collected) + '</td>' +
                '<td class="num hide-mobile ' + (p.collection_rate >= 70 ? 'moss' : p.collection_rate < 40 ? 'clay' : '') + '">' + p.collection_rate + '%</td>' +
                '<td class="num hide-mobile ' + (p.buyers_at_risk ? 'clay' : 'muted') + '">' + p.buyers_at_risk + '</td>' +
                '<td class="num gold">' + naira(p.commission_earned) + '</td>' +
              '</tr>';
            },
            {
              emptyTitle: 'No sales reps yet',
              emptyHint: 'Add reps in Settings, then assign them to reservations.',
              emptyAction: '<a class="btn-quiet" href="#/settings?tab=team">Go to Settings</a>',
            }
          ), { flush: true });
        return;
      }

      if (tab === 'entries') {
        var entries = await api('/commissions');
        view.innerHTML = head('Commission entries', 'One row per payment. This is where a rep\'s total comes from.') +
          commissionTabs(tab) +
          card(null, table(
            [{ label: 'Date', hideMobile: true }, { label: 'Rep' }, { label: 'Buyer' },
              { label: 'Payment', num: true, hideMobile: true },
              { label: 'Rate', num: true, hideMobile: true }, { label: 'Commission', num: true },
              { label: 'Status' }, { label: '' }],
            entries,
            function (c) {
              var reservation = c.re_reservations || {};
              return '<tr>' +
                '<td class="muted hide-mobile">' + esc(fmtDate(c.created_at)) + '</td>' +
                '<td>' + esc((c.re_sales_reps && c.re_sales_reps.users && (c.re_sales_reps.users.full_name || c.re_sales_reps.users.email)) || '—') + '</td>' +
                '<td class="muted">' + esc((reservation.re_customers && reservation.re_customers.full_name) || '—') + '</td>' +
                '<td class="num muted hide-mobile">' + naira(c.base_amount) + '</td>' +
                '<td class="num muted hide-mobile">' + c.rate + '%</td>' +
                '<td class="num gold">' + naira(c.amount) + '</td>' +
                '<td>' + badge(c.status) + '</td>' +
                // The middle step of accrued → approved → paid (CLAUDE.md:
                // "a director approves, only the owner pays") — until now
                // there was no way to move a row out of 'accrued' short of
                // the owner paying it outright.
                '<td class="right">' + (c.status === 'accrued' && R.can('commissions.approve')
                  ? '<button class="btn-quiet" data-approve="' + esc(c.id) + '">Approve</button>'
                  : '') + '</td>' +
              '</tr>';
            },
            {
              emptyTitle: 'No commission accrued yet',
              emptyHint: 'Commission accrues when a payment lands against a reservation with a rep on it.',
              emptyAction: '<a class="btn-quiet" href="#/payments">Go to Payments</a>',
            }
          ), { flush: true });

        R.qsa('[data-approve]', view).forEach(function (button) {
          button.addEventListener('click', async function () {
            var confirmed = await R.confirm({
              title: 'Approve commission',
              message: 'Approve this commission for payout? The owner still has to mark it paid.',
              confirmLabel: 'Approve',
            });
            if (!confirmed) return;

            await api.patch('/commissions/status', { ids: [button.dataset.approve], status: 'approved' });
            toast('Commission approved.', 'ok');
            R.reload();
          });
        });
        return;
      }

      var summary = await api('/commissions/summary');
      var totalEarned = summary.reduce(function (s, r) { return s + r.earned; }, 0);
      var totalOwed = summary.reduce(function (s, r) { return s + r.outstanding; }, 0);

      view.innerHTML =
        head('Commissions', 'What each rep has earned, and what is still owed to them.') +
        commissionTabs(tab) +
        '<div class="grid cols-3 mb-2">' +
          stat('Total earned', naira(totalEarned), { tone: 'gold' }) +
          stat('Owed to reps', naira(totalOwed), { accent: totalOwed ? 'gold' : null }) +
          stat('Reps earning', String(summary.length)) +
        '</div>' +

        card(null, table(
          [{ label: 'Rep' }, { label: 'Rate', num: true, hideMobile: true },
            { label: 'Collected on', num: true, hideMobile: true },
            { label: 'Earned', num: true }, { label: 'Owed', num: true },
            { label: 'Paid out', num: true, hideMobile: true }, { label: '' }],
          summary,
          function (r) {
            return '<tr>' +
              '<td class="cell-primary">' + esc(r.name) + '</td>' +
              '<td class="num muted hide-mobile">' + r.commission_rate + '%</td>' +
              '<td class="num muted hide-mobile">' + nairaShort(r.collected_base) + '</td>' +
              '<td class="num gold">' + naira(r.earned) + '</td>' +
              '<td class="num">' + naira(r.outstanding) + '</td>' +
              '<td class="num moss hide-mobile">' + naira(r.paid) + '</td>' +
              '<td class="right">' + (r.outstanding > 0 && R.can('commissions.markPaid')
                ? '<button class="btn-quiet" data-payout="' + esc(r.sales_rep_id) + '" data-name="' + esc(r.name) + '">Mark paid</button>'
                : '') + '</td>' +
            '</tr>';
          },
          {
            emptyTitle: 'No commission yet',
            emptyHint: 'Set a rate on each rep in Settings, then assign them to reservations.',
            emptyAction: '<a class="btn-quiet" href="#/settings?tab=team">Go to Settings</a>',
          }
        ), { flush: true });

      R.qsa('[data-payout]', view).forEach(function (button) {
        button.addEventListener('click', async function () {
          var confirmed = await R.confirm({
            title: 'Mark commission paid',
            message: 'Mark everything currently owed to ' + button.dataset.name + ' as paid out? This does not move any money — it records that you have.',
            confirmLabel: 'Mark as paid',
          });
          if (!confirmed) return;

          var entries = await api('/commissions?sales_rep_id=' + button.dataset.payout);
          var ids = entries.filter(function (e) { return e.status === 'accrued' || e.status === 'approved'; })
            .map(function (e) { return e.id; });
          if (!ids.length) return toast('Nothing outstanding.', 'err');

          var result = await api.patch('/commissions/status', { ids: ids, status: 'paid' });
          toast('Marked ' + naira(result.total) + ' as paid.', 'ok');
          R.reload();
        });
      });
    },
  };

  function commissionTabs(active) {
    // 'By rep' and 'Performance' both need commissions.readAll, which a
    // sales rep never has — offering a tab that always 403s on click is the
    // same bug as landing on one by default.
    var canReadAll = R.can('commissions.readAll');
    var tabs = canReadAll
      ? [['summary', 'By rep'], ['entries', 'Entries'], ['performance', 'Performance']]
      : [['entries', 'Entries']];
    return '<div class="filter-row">' +
      tabs.map(function (t) {
        return '<a class="pill' + (active === t[0] ? ' is-on' : '') + '" href="#/commissions?tab=' + t[0] + '">' + t[1] + '</a>';
      }).join('') +
    '</div>';
  }

  /* ══ REPORTS ════════════════════════════════════════════════════════════ */
  R.screens.reports = {
    render: async function (view, params, query) {
      var scope = query.project ? '?project_id=' + encodeURIComponent(query.project) : '';

      // 'reports.investor' is owner-only (CLAUDE.md: "only the chairman sees
      // the investor's view"); 'reports.collections'/'reports.rental' are
      // owner+sales_director. A single Promise.all over all three used to
      // reject WHOLE-SCREEN the moment a Sales Director (who is in nav for
      // 'reports', same as owner — neither is in NAV_BY_ROLE's restricted
      // list) hit the investor-only endpoint. Each section now fetches only
      // what its own permission allows, and renders only what it got.
      var canInvestor = R.can('reports.investor');
      var canCollections = R.can('reports.collections');
      var canRental = R.can('reports.rental');
      var canExport = R.can('reports.export');

      var results = await Promise.all([
        canInvestor ? api('/reports/investor' + scope) : Promise.resolve(null),
        canCollections ? api('/reports/collections?months=12') : Promise.resolve(null),
        canRental ? api('/reports/rental') : Promise.resolve(null),
      ]);
      var report = results[0], collections = results[1], rental = results[2];
      var t = report && report.totals;
      // Only a developer who actually runs a rental portfolio sees this
      // section — nothing to report on is nothing to show.
      var hasRentals = rental && (rental.occupancy.occupied > 0 || rental.upcoming_renewals.length > 0);

      // peakAmount is the real figure ("Peak month ₦x") and is only shown
      // when a month actually collected something. peakScale is purely the
      // bar-height denominator and always keeps the +1 divide-by-zero guard
      // — a brand-new workspace with zero collections must not display a
      // literal "Peak month ₦1", but the bars still need a safe divisor.
      var peakAmount = collections
        ? Math.max.apply(null, collections.map(function (m) { return m.amount; }).concat([0]))
        : 0;
      var peakScale = Math.max(peakAmount, 1);
      var hasCollectionsData = Boolean(collections && collections.length && peakAmount > 0);
      var MONTH_ABBR = { '01': 'Jan', '02': 'Feb', '03': 'Mar', '04': 'Apr', '05': 'May', '06': 'Jun',
        '07': 'Jul', '08': 'Aug', '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dec' };

      view.innerHTML =
        head('Reports', 'The summary you send to investors, without rebuilding it in PowerPoint.',
          canExport
            ? '<button class="btn" data-export="customers">Export buyers</button>' +
              '<button class="btn" data-export="schedule">Export schedule</button>' +
              '<button class="btn" data-export="payments">Export payments</button>' +
              '<button class="btn primary" id="btn-print">Print / PDF</button>'
            : '') +

        (canInvestor
          ? '<div class="grid cols-4 mb-2">' +
              stat('Gross development value', nairaShort(t.gross_development_value)) +
              stat('Contracted', nairaShort(t.contracted_value), { tone: 'gold' }) +
              stat('Collected to date', nairaShort(t.collected_total), { tone: 'moss', accent: 'moss' }) +
              stat('Receivables outstanding', nairaShort(t.receivables_outstanding), {
                sub: t.receivables_overdue ? nairaShort(t.receivables_overdue) + ' overdue' : 'none overdue',
                accent: t.receivables_overdue ? 'clay' : null,
              }) +
            '</div>'
          : '') +

        (canCollections
          ? card('Collections, last 12 months',
              hasCollectionsData
                ? '<div class="bars">' + collections.map(function (m) {
                    var height = Math.max(2, Math.round((m.amount / peakScale) * 100));
                    // The amount is a visible label, not just a title tooltip —
                    // hover does nothing on the touch/mobile devices this app
                    // primarily runs on. title= stays as a bonus for mouse users.
                    // Suppressed below 15% height: on a twelve-bar chart a tall
                    // peak next to several near-flat months left the small
                    // bars' labels overlapping each other and the bar below.
                    return '<div title="' + esc(m.month + ': ' + naira(m.amount)) + '">' +
                      (height > 15 ? '<div class="bar-label">' + esc(nairaShort(m.amount)) + '</div>' : '') +
                      '<div class="bar-track"><div class="bar" data-h="' + height + '"></div></div>' +
                      '<div class="bar-label">' + esc(MONTH_ABBR[m.month.slice(5)] || m.month.slice(5)) + '</div></div>';
                  }).join('') + '</div>' +
                  '<div class="page-sub mt-1">Peak month ' + naira(peakAmount) + '</div>'
                : R.emptyState('No collections recorded yet'))
          : '') +

        (canInvestor
          ? card('By project', table(
              [{ label: 'Project' }, { label: 'Units' }, { label: 'Sold', num: true }, { label: 'Sell-through', num: true },
                { label: 'Contracted', num: true }, { label: 'Collected', num: true }, { label: 'Collection rate', num: true },
                { label: 'Overdue', num: true }],
              report.projects,
              function (p) {
                return '<tr>' +
                  '<td class="cell-primary">' + esc(p.name) + '<div class="cell-meta">' + esc(p.location || '') + '</div></td>' +
                  '<td class="muted">' + p.units.total + '</td>' +
                  '<td class="num">' + p.units.sold + '</td>' +
                  '<td class="num muted">' + p.sell_through_rate + '%</td>' +
                  '<td class="num">' + nairaShort(p.contracted_value) + '</td>' +
                  '<td class="num moss">' + nairaShort(p.collected_total) + '</td>' +
                  '<td class="num ' + (p.collection_rate >= 70 ? 'moss' : p.collection_rate < 40 ? 'clay' : '') + '">' + p.collection_rate + '%</td>' +
                  '<td class="num ' + (p.receivables_overdue ? 'clay' : 'muted') + '">' + nairaShort(p.receivables_overdue) + '</td>' +
                '</tr>';
              },
              { emptyTitle: 'No projects to report on yet' }
            ), { flush: true })
          : '') +

        // "How full is the building" and "how much sold" are different
        // questions with different answers — folding rental units into the
        // sales occupancy numbers above would answer neither correctly.
        (hasRentals
          ? card('Rental portfolio',
              '<div class="grid cols-3">' +
                stat('Occupancy', rental.occupancy.rate + '%', {
                  tone: rental.occupancy.rate >= 70 ? 'moss' : null,
                  sub: rental.occupancy.occupied + ' occupied · ' + rental.occupancy.vacant + ' vacant',
                }) +
                stat('Rental income this month', naira(rental.monthly_rental_income), { tone: 'gold', accent: 'gold' }) +
                stat('Current monthly rent roll', naira(rental.current_monthly_rent_roll)) +
              '</div>', { flush: false }) +

            card('Renewals due in the next 90 days', table(
              [{ label: 'Tenant' }, { label: 'Unit' }, { label: 'Monthly rent', num: true },
                { label: 'Tenancy ends' }, { label: '' }],
              rental.upcoming_renewals,
              function (r) {
                return '<tr>' +
                  '<td class="cell-primary">' + esc(r.tenant_name || '—') + '</td>' +
                  '<td>' + esc(r.unit_number || '—') + '<div class="cell-meta">' + esc(r.project_name || '') + '</div></td>' +
                  '<td class="num">' + naira(r.current_monthly_rent) + '</td>' +
                  '<td class="muted">' + esc(fmtDate(r.tenancy_end_date)) +
                    '<div class="cell-meta">' + R.plural(r.days_remaining, 'day') + ' left</div></td>' +
                  '<td class="right"><button class="btn-quiet" data-renew="' + esc(r.reservation_id) +
                    '" data-buyer-name="' + esc(r.tenant_name || '') + '">Renew tenancy</button></td>' +
                '</tr>';
              },
              { emptyTitle: 'Nothing expiring soon', emptyHint: 'Renewals due in the next 90 days will appear here.' }
            ), { flush: true })
          : '');

      // Collections bars carry their height as data-h (a CSP with no
      // 'unsafe-inline' in style-src blocks a literal style="height:…"
      // attribute) — this is the one step that turns that number into an
      // actual bar. Same helper the CSS-computed-size convention already
      // uses everywhere else in the app.
      R.applyDynamicStyles(view);

      // Only rendered when canExport. reports.export is DIRECTORS in
      // permissions.js — the same group as reports.collections/reports.rental
      // — so a Sales Director has it too, same as the owner; this null guard
      // is for a role with none of the three (sales_rep, collections,
      // documentation — none of whom even have 'reports' in NAV_BY_ROLE)
      // forcing this URL directly rather than reaching it from the sidebar.
      var printButton = R.qs('#btn-print', view);
      if (printButton) printButton.addEventListener('click', function () { window.print(); });

      R.onClick(view, '[data-renew]', async function (button) {
        await renewTenancyModal(button.dataset.renew, button.dataset.buyerName);
      });

      // Your data, in a file you keep. Also the only backup a developer
      // controls without a Supabase login.
      R.onClick(view, '[data-export]', async function (button) {
        var kind = button.dataset.export;
        await R.downloadCsv('/reports/export/' + kind, 'archta-' + kind + '.csv');
        toast('Exported. Check your downloads.', 'ok');
      });
    },
  };

  /* ══ SETTINGS ═══════════════════════════════════════════════════════════ */
  R.screens.settings = {
    render: async function (view, params, query) {
      var tab = query.tab || 'workspace';

      var tabs = '<div class="filter-row">' +
        [['workspace', 'Workspace'], ['team', 'Team & reps'],
          ['activity', 'Activity log'], ['bin', 'Bin']].map(function (t) {
          return '<a class="pill' + (tab === t[0] ? ' is-on' : '') + '" href="#/settings?tab=' + t[0] + '">' + t[1] + '</a>';
        }).join('') + '</div>';

      if (tab === 'activity') return activityTab(view, tabs);
      if (tab === 'team') return teamTab(view, tabs);
      if (tab === 'bin') return binTab(view, tabs, query.of || 'customers');
      return workspaceTab(view, tabs);
    },
  };

  async function workspaceTab(view, tabs) {
    var settings = await api('/settings');

    view.innerHTML = head('Settings', 'Workspace configuration — letterhead, provider keys, commission default and who gets told what. Your own profile and password are under your name, bottom left of the sidebar.') + tabs +
      '<div class="grid cols-2">' +
        '<div>' +
          card('Company', '<form id="form-org">' +
            '<div class="field"><label for="s-company">Company name</label>' +
              '<input class="input" id="s-company" name="company_name" value="' + esc(settings.company_name || '') + '" placeholder="Adron Homes"></div>' +
            '<div class="field"><label for="s-logo">Logo URL</label>' +
              '<input class="input" id="s-logo" name="logo_url" type="url" value="' + esc(settings.logo_url || '') + '" placeholder="https://…">' +
              '<p class="field-hint">Must be https. Printed on allocation letters and receipts.</p></div>' +
            '<div class="field"><label for="s-address">Address</label>' +
              '<input class="input" id="s-address" name="address" value="' + esc(settings.address || '') + '"></div>' +
            '<div class="field-row">' +
              '<div class="field"><label for="s-phone">Phone</label>' +
                '<input class="input" id="s-phone" name="phone" value="' + esc(settings.phone || '') + '"></div>' +
              '<div class="field"><label for="s-website">Website</label>' +
                '<input class="input" id="s-website" name="website" value="' + esc(settings.website || '') + '"></div>' +
            '</div>' +
            '<button class="btn primary mt-1" type="submit">Save company details</button>' +
          '</form>') +

          card('Payments — Paystack',
            (R.can('settings.write')
              ? '<p class="field-hint mb-2">Optional. Without your own Paystack account, card payments settle into Archta\'s default account and are forwarded to you. Add your own keys to receive them directly.</p>' +
                '<form id="form-paystack">' +
                  '<div class="field"><label for="s-pk-public">Public key</label>' +
                    '<input class="input" id="s-pk-public" name="paystack_public_key" value="' + esc(settings.paystack_public_key || '') + '" placeholder="pk_live_…"></div>' +
                  '<div class="field"><label for="s-pk-secret">Secret key</label>' +
                    '<input class="input" id="s-pk-secret" name="paystack_secret_key" type="password" autocomplete="off" placeholder="' +
                      (settings.paystack_configured ? 'Configured, ending in ' + esc(settings.paystack_secret_key_last4) + ' — leave blank to keep' : 'sk_live_…') + '">' +
                    '<p class="field-hint">Never shown again once saved. Leave blank to keep the current key.</p></div>' +
                  '<div class="field-row">' +
                    '<button class="btn primary" type="submit">Save</button>' +
                    '<button class="btn" type="button" id="btn-test-paystack">Test key</button>' +
                  '</div>' +
                '</form>'
              : '<p class="muted">' +
                (settings.paystack_configured
                  ? 'Configured, ending in ' + esc(settings.paystack_secret_key_last4) + '.'
                  : 'Not configured — card payments use the platform default account.') +
                ' Only the workspace owner can change this.</p>')) +
        '</div>' +

        '<div>' +
          card('Notifications', '<form id="form-notify">' +
            '<div class="field"><label for="s-md">Escalation email</label>' +
              '<input class="input" id="s-md" name="notify_md_email" type="email" value="' + esc(settings.notify_md_email || '') + '" placeholder="md@company.com">' +
              '<p class="field-hint">Where final-notice and unassigned-arrears alerts go. Usually the MD.</p></div>' +
            '<div class="field"><label for="s-reply">Reply-to address</label>' +
              '<input class="input" id="s-reply" name="reply_to_email" type="email" value="' + esc(settings.reply_to_email || '') + '" placeholder="sales@company.com">' +
              '<p class="field-hint">Where a buyer\'s reply to a receipt lands.</p></div>' +
            '<label class="check"><input type="checkbox" name="notify_on_payment"' + (settings.notify_on_payment !== false ? ' checked' : '') + '>' +
              '<span>Email the buyer a receipt when a payment is recorded</span></label>' +
            '<label class="check"><input type="checkbox" name="notify_on_overdue"' + (settings.notify_on_overdue !== false ? ' checked' : '') + '>' +
              '<span>Alert the sales rep each morning when their buyer misses a payment</span></label>' +
            '<label class="check"><input type="checkbox" name="notify_payment_reminders"' + (settings.notify_payment_reminders ? ' checked' : '') + '>' +
              '<span>Text buyers automatically — 3 days before a payment is due, and the morning after one is missed' +
              '<br><span class="field-hint mt-2px">Goes to your customers and costs per SMS, so this one is off until you turn it on. ' +
              'Buyers past a gentle reminder are skipped — those are conversations, not texts.</span></span></label>' +
            '<div class="field mt-2"><label for="s-rate">Default commission rate</label>' +
              '<input class="input" id="s-rate" name="default_commission_rate" type="number" min="0" max="100" step="0.1" value="' + esc(settings.default_commission_rate || 0) + '">' +
              '<p class="field-hint">Percent. Applied to a new sales rep unless you set theirs individually.</p></div>' +
            '<button class="btn primary mt-1" type="submit">Save preferences</button>' +
          '</form>') +

          card('Email',
            (R.can('settings.write')
              ? '<p class="field-hint mb-2">Optional. Without this, receipts, portal links and alerts still send — they just arrive from Archta rather than your own domain.</p>' +
                '<form id="form-email">' +
                  '<div class="field"><label for="s-resend-key">Resend API key</label>' +
                    '<input class="input" id="s-resend-key" name="resend_api_key" type="password" autocomplete="off" placeholder="' +
                      (settings.resend_configured ? 'Configured, ending in ' + esc(settings.resend_api_key_last4) + ' — leave blank to keep' : 're_…') + '">' +
                    '<p class="field-hint">Never shown again once saved. Leave blank to keep the current key.</p></div>' +
                  '<div class="field"><label for="s-resend-from">From email address</label>' +
                    '<input class="input" id="s-resend-from" name="resend_from_email" type="email" value="' + esc(settings.resend_from_email || '') + '" placeholder="receipts@yourcompany.com">' +
                    '<p class="field-hint">Must belong to a domain verified in your own Resend account, or Resend will refuse to send.</p></div>' +
                  '<div class="field-row">' +
                    '<button class="btn primary" type="submit">Save</button>' +
                    '<button class="btn" type="button" id="btn-test-email">Send test email</button>' +
                  '</div>' +
                '</form>'
              : '<p class="muted">' +
                (settings.resend_configured
                  ? 'Configured — sending from ' + esc(settings.resend_from_email || 'your domain') + '.'
                  : 'Not configured — email sends from Archta\'s default address.') +
                ' Only the workspace owner can change this.</p>')) +

          card('SMS — Termii',
            (R.can('settings.write')
              ? '<p class="field-hint mb-2">Optional. Without this, payment reminders and overdue texts still send — they just arrive from Archta\'s registered sender ID rather than your own.</p>' +
                '<form id="form-termii">' +
                  '<div class="field"><label for="s-termii-sender">Sender ID</label>' +
                    '<input class="input" id="s-termii-sender" name="termii_sender_id" value="' + esc(settings.termii_sender_id || '') + '" placeholder="AdronHomes" maxlength="11">' +
                    '<p class="field-hint">Must already be registered with Termii — an unregistered sender ID is rejected at send time, not here.</p></div>' +
                  '<div class="field"><label for="s-termii-key">Termii API key</label>' +
                    '<input class="input" id="s-termii-key" name="termii_api_key" type="password" autocomplete="off" placeholder="' +
                      (settings.termii_configured ? 'Configured, ending in ' + esc(settings.termii_api_key_last4) + ' — leave blank to keep' : 'TLxxxxxxxxxxxxxxxxxxxxxxxxxxxx') + '">' +
                    '<p class="field-hint">Never shown again once saved. Leave blank to keep the current key.</p></div>' +
                  '<div class="field"><label for="s-termii-test-to">Test number</label>' +
                    '<input class="input" id="s-termii-test-to" type="tel" placeholder="0803…" autocomplete="off">' +
                    '<p class="field-hint">Where the test button below sends a real text.</p></div>' +
                  '<div class="field-row">' +
                    '<button class="btn primary" type="submit">Save</button>' +
                    '<button class="btn" type="button" id="btn-test-termii">Send test text</button>' +
                  '</div>' +
                '</form>'
              : '<p class="muted">' +
                (settings.termii_configured
                  ? 'Configured, sender ID ' + esc(settings.termii_sender_id || '—') + '.'
                  : 'Not configured — texts send from Archta\'s default sender ID.') +
                ' Only the workspace owner can change this.</p>')) +
        '</div>' +
      '</div>';

    guardedSubmit(R.qs('#form-org', view), async function (form) {
      await api.put('/settings', R.values(form));
      toast('Company details saved.', 'ok');
    });

    guardedSubmit(R.qs('#form-notify', view), async function (form) {
      await api.put('/settings', R.values(form));
      toast('Preferences saved.', 'ok');
    });

    // Owner-only cards — absent from the DOM entirely for anyone else, so
    // these two forms only exist to wire up when they were actually rendered.
    var paystackForm = R.qs('#form-paystack', view);
    if (paystackForm) {
      guardedSubmit(paystackForm, async function (form) {
        var v = R.values(form);
        var payload = { paystack_public_key: v.paystack_public_key || null };
        // Blank means "leave the saved key alone" — the field never shows the
        // real value again once set, so blank cannot mean "clear it".
        if (v.paystack_secret_key) payload.paystack_secret_key = v.paystack_secret_key;
        await api.put('/settings/paystack', payload);
        toast('Paystack settings saved.', 'ok');
        R.reload();
      });
    }

    R.onClick(view, '#btn-test-paystack', async function () {
      var secretKey = R.qs('#s-pk-secret', view).value.trim();
      if (!secretKey) { toast('Enter a secret key to test first.', 'err'); return; }
      var result = await api.post('/settings/paystack/test', { secret_key: secretKey });
      toast(result.valid ? 'Paystack key is valid.' : (result.reason || 'Paystack rejected this key.'), result.valid ? 'ok' : 'err');
    });

    var emailForm = R.qs('#form-email', view);
    if (emailForm) {
      guardedSubmit(emailForm, async function (form) {
        var v = R.values(form);
        var payload = { resend_from_email: v.resend_from_email || null };
        if (v.resend_api_key) payload.resend_api_key = v.resend_api_key;
        await api.put('/settings/email', payload);
        toast('Email settings saved.', 'ok');
        R.reload();
      });
    }

    R.onClick(view, '#btn-test-email', async function () {
      var apiKey = R.qs('#s-resend-key', view).value.trim();
      var from = R.qs('#s-resend-from', view).value.trim();
      if (!apiKey || !from) { toast('Enter both an API key and a From address to test.', 'err'); return; }
      var result = await api.post('/settings/email/test', { resend_api_key: apiKey, resend_from_email: from });
      toast(result.valid ? 'Test email sent — check your inbox.' : (result.reason || 'Could not send the test email.'), result.valid ? 'ok' : 'err');
    });

    var termiiForm = R.qs('#form-termii', view);
    if (termiiForm) {
      guardedSubmit(termiiForm, async function (form) {
        var v = R.values(form);
        var payload = { termii_sender_id: v.termii_sender_id || null };
        if (v.termii_api_key) payload.termii_api_key = v.termii_api_key;
        await api.put('/settings/termii', payload);
        toast('SMS settings saved.', 'ok');
        R.reload();
      });
    }

    R.onClick(view, '#btn-test-termii', async function () {
      var apiKey = R.qs('#s-termii-key', view).value.trim();
      var senderId = R.qs('#s-termii-sender', view).value.trim();
      var to = R.qs('#s-termii-test-to', view).value.trim();
      if (!apiKey || !senderId) { toast('Enter both a sender ID and an API key to test.', 'err'); return; }
      if (!to) { toast('Enter a phone number to send the test to.', 'err'); return; }
      var result = await api.post('/settings/termii/test', { termii_api_key: apiKey, termii_sender_id: senderId, to: to });
      toast(result.valid ? 'Test text sent — check your phone.' : (result.reason || 'Could not send the test text.'), result.valid ? 'ok' : 'err');
    });
  }

  // Same disable-and-spin protection R.onClick already gives every button —
  // these three Settings forms submit directly rather than through
  // R.modal(), and were the one place in the app missing it entirely: no
  // visual feedback, and nothing stopping a double-click from firing two
  // concurrent requests (a real race on the password form, which bumps
  // token_version and returns a fresh token per request).
  function guardedSubmit(form, handler) {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var submit = R.qs('[type="submit"]', form);
      if (submit && submit.disabled) return;
      if (submit) { submit.disabled = true; submit.classList.add('is-working'); }
      try {
        await handler(form);
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        if (submit) { submit.disabled = false; submit.classList.remove('is-working'); }
      }
    });
  }

  // ── Role-change guards ────────────────────────────────────────────────
  // There used to be a hand-copied ROLE_RANK map and a ROLE_LOSS_GROUPS list
  // here, mirroring src/services/permissions.js's own ROLE_RANK and
  // capabilitiesLostGoingFrom() literally field-for-field — exactly the
  // "second copy of a rule the server already computes" CLAUDE.md's
  // per-workspace-credentials and RBAC sections both warn against. Neither
  // copy is needed: realestate.js's request() already attaches the full
  // parsed JSON body to a failed request as `err.body`, and
  // PATCH /settings/team/:id already answers a downgrade attempted without
  // confirm_downgrade with exactly this shape in its 409 body —
  // { downgrade: true, current_role_label, new_role_label, loses: [...] }
  // (src/routes/settings.js, built from permissions.js's own ROLE_RANK and
  // ROLE_LOSS_GROUPS). Both call sites below now read that instead of
  // precomputing it — the first attempt costs nothing extra for a lateral
  // move or a promotion, and only a genuine downgrade ever needs a second
  // round trip. Self-inviting at a lower role is the same story: rather
  // than duplicating that check too, the invite submit below just lets
  // POST /settings/team/invite reject it (inviteService.js already throws
  // the identical message), and the modal's own error display shows it.

  async function teamTab(view, tabs) {
    var results = await Promise.all([
      api('/settings/team'), api('/sales-reps?include_inactive=true'), api('/settings'),
    ]);
    var team = results[0], reps = results[1], settings = results[2];

    // The effective logo, from wherever it actually lives — GET /settings
    // already merges teams.logo_url for the response, so this widget works
    // identically for a solo workspace (re_org_settings.logo_url) and a team
    // (teams.logo_url), without needing to know which.
    var logoUrl = settings.logo_url;
    // Branding is workspace settings — "Cannot change workspace settings
    // (commission default, notifications, branding)" applies to a Sales
    // Director exactly as it does to PUT /settings, and POST /settings/logo
    // is gated the same way (owner only). A director can still reach this
    // screen (team management is theirs), so the upload widget itself is
    // what has to stay out of their way rather than 403 on click.
    var canEditLogo = R.can('settings.write');
    var logoBlock = canEditLogo
      ? '<div class="card mb-2"><div class="card-body flex-row gap-16">' +
          '<div class="logo-upload" id="logo-upload" tabindex="0" role="button" ' +
              'aria-label="' + (logoUrl ? 'Change workspace logo' : 'Add workspace logo') + '">' +
            (logoUrl
              ? '<img src="' + esc(logoUrl) + '" alt="Workspace logo">'
              : '<div class="logo-upload-empty">Add logo</div>') +
            '<div class="logo-upload-overlay">' + (logoUrl ? 'Change' : 'Add logo') + '</div>' +
          '</div>' +
          '<input type="file" id="logo-file" accept="image/jpeg,image/png,image/webp" class="hidden">' +
          '<div><div class="cell-primary mb-3px">Workspace logo</div>' +
            '<p class="page-sub mt-0">JPEG, PNG or WebP, up to 2MB. Shown here and on allocation letters and receipts.</p></div>' +
        '</div></div>'
      : '';

    view.innerHTML = head('Team & sales reps', team.is_team ? 'A shared workspace.' : 'A solo workspace.') + tabs +
      logoBlock +

      card('People', table(
        [{ label: 'Name' }, { label: 'Email' }, { label: 'Role' }, { label: 'Last active' },
          { label: 'Status' }, { label: '' }],
        team.members,
        function (m) {
          var canManage = m.role !== 'owner' && m.id && R.can('team.manageMembers');
          return '<tr>' +
            '<td class="cell-primary">' + esc(m.full_name || '—') + '</td>' +
            '<td class="muted">' + esc(m.email || '') + '</td>' +
            '<td class="muted">' + esc(m.role_label || m.role) +
              (m.status === 'invited' && m.invited_role && m.invited_role !== m.role
                ? '<div class="cell-meta">invited as ' + esc(m.invited_role) + '</div>' : '') + '</td>' +
            '<td class="muted">' + esc(m.last_login_at ? R.fmtRelative(m.last_login_at) : 'never signed in') + '</td>' +
            '<td>' + badge(m.status) + '</td>' +
            // The owner cannot be removed or re-roled — the API refuses it,
            // and offering the buttons anyway is just a dead end with a
            // confirmation on it.
            '<td class="right nowrap">' + (
              canManage
                ? '<button class="btn-quiet" data-change-role="' + esc(m.id) + '" data-current="' + esc(m.role) +
                  '" data-name="' + esc(m.full_name || m.email || 'this person') + '">Change role</button> '
                : ''
            ) + (
              m.role !== 'owner' && m.status === 'active' && m.id && R.can('settings.transferOwner')
                ? '<button class="btn-quiet" data-make-owner="' + esc(m.id) + '" data-name="' +
                  esc(m.full_name || m.email || 'this person') + '">Make owner</button> '
                : ''
            ) + (m.role !== 'owner' && m.status !== 'removed' && m.id && R.can('team.manageMembers')
              ? '<button class="btn-quiet" data-remove="' + esc(m.id) + '" data-name="' +
                esc(m.full_name || m.email || 'this person') + '">Remove</button>'
              : '') + '</td>' +
          '</tr>';
        },
        { emptyTitle: 'Just you so far' }
      ), {
        flush: true,
        actions: team.is_team
          ? (R.can('team.invite') ? '<button class="btn-quiet" id="btn-invite">Invite someone</button>' : '')
          : '<button class="btn-quiet" id="btn-make-team">Turn this into a team</button>',
      }) +

      card('Sales reps', table(
        [{ label: 'Rep' }, { label: 'Email' }, { label: 'Commission', num: true }, { label: 'Status' }, { label: '' }],
        reps,
        function (rep) {
          return '<tr>' +
            '<td class="cell-primary">' + esc((rep.users && rep.users.full_name) || '—') + '</td>' +
            '<td class="muted">' + esc((rep.users && rep.users.email) || '') + '</td>' +
            '<td class="num">' + (rep.commission_rate || 0) + '%</td>' +
            '<td>' + badge(rep.active ? 'active' : 'none') + '</td>' +
            '<td class="right"><button class="btn-quiet" data-rate="' + esc(rep.id) + '" data-current="' + esc(rep.commission_rate || 0) + '">Set rate</button></td>' +
          '</tr>';
        },
        {
          emptyTitle: 'No sales reps yet',
          emptyHint: 'A rep is a person in your workspace tagged for this product. Reservations are assigned to them and commission accrues on every payment.',
        }
      ), { flush: true, actions: '<button class="btn-quiet" id="btn-add-rep">Add a rep</button>' });

    var logoUpload = R.qs('#logo-upload', view);
    if (logoUpload) {
      var logoFile = R.qs('#logo-file', view);
      var openLogoPicker = function () { logoFile.click(); };
      logoUpload.addEventListener('click', openLogoPicker);
      logoUpload.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLogoPicker(); }
      });

      logoFile.addEventListener('change', async function () {
        var file = logoFile.files && logoFile.files[0];
        if (!file) return;

        // Checked here too, not just via the file input's accept/the server's
        // own validation — an early, specific message beats waiting on a
        // round trip to be told the same thing.
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
          toast('Use a JPEG, PNG or WebP image.', 'err');
          logoFile.value = '';
          return;
        }
        if (file.size > 2 * 1024 * 1024) {
          toast('That image is larger than 2MB.', 'err');
          logoFile.value = '';
          return;
        }

        logoUpload.classList.add('is-working');
        try {
          var base64 = await new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result).split(',')[1]); };
            reader.onerror = function () { reject(new Error('could not be read')); };
            reader.readAsDataURL(file);
          });

          await api.post('/settings/logo', { content: base64, content_type: file.type });
          toast('Logo updated.', 'ok');
          R.reload();
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          logoUpload.classList.remove('is-working');
          logoFile.value = '';
        }
      });
    }

    var invite = R.qs('#btn-invite', view);
    if (invite) {
      invite.addEventListener('click', function () {
        // Only the roles THIS caller may hand out — team.invitable_roles,
        // from GET /settings/team — so an owner sees all four and a Sales
        // Director never sees "Head of Sales" offered only to be refused
        // after they have already typed the address (only the owner may
        // appoint a second one).
        R.modal({
          title: 'Invite someone',
          body:
            '<div class="field"><label for="inv-email">Email</label>' +
              '<input class="input" id="inv-email" name="email" type="email" required></div>' +
            '<div class="field"><label for="inv-role">Role</label>' +
              '<select class="select" id="inv-role" name="role">' +
                team.invitable_roles.map(function (r) {
                  return '<option value="' + esc(r.role) + '">' + esc(r.label) + '</option>';
                }).join('') +
              '</select></div>' +
            '<p class="field-hint">If they already have an account they join immediately. If not, we email a link that expires in 7 days.</p>',
          submitLabel: 'Send invite',
          onSubmit: async function (form, close) {
            var v = R.values(form);
            // Inviting your own address at a role below the one you already
            // hold is how somebody would otherwise demote themselves with no
            // other owner's say-so. src/services/inviteService.js already
            // rejects exactly that (comparing against permissions.js's own
            // ROLE_RANK) and throws the identical message below — this used
            // to duplicate that check client-side to fail before a round
            // trip, but it's rare enough (an admin inviting themselves) that
            // the one extra request isn't worth hand-copying the server's
            // rank table for.
            var result = await api.post('/settings/team/invite', v);
            close();
            toast(result.joined_immediately ? 'Added to the workspace.' : 'Invite sent.', 'ok');
            R.reload();
          },
        });
      });
    }

    R.qsa('[data-change-role]', view).forEach(function (button) {
      button.addEventListener('click', function () {
        R.modal({
          title: 'Change role — ' + button.dataset.name,
          body:
            '<div class="field"><label for="role-select">New role</label>' +
              '<select class="select" id="role-select" name="role">' +
                team.invitable_roles.map(function (r) {
                  return '<option value="' + esc(r.role) + '"' +
                    (r.role === button.dataset.current ? ' selected' : '') + '>' + esc(r.label) + '</option>';
                }).join('') +
              '</select></div>',
          submitLabel: 'Save',
          onSubmit: async function (form, close) {
            var newRole = R.values(form).role;

            // First attempt never claims confirm_downgrade — a lateral move
            // or a promotion just succeeds here, one request. A genuine
            // downgrade gets refused with a 409 carrying exactly what it
            // costs (permissions.js's ROLE_RANK and ROLE_LOSS_GROUPS,
            // computed server-side — see the comment above this function).
            try {
              await api.patch('/settings/team/' + button.dataset.changeRole, { role: newRole });
            } catch (err) {
              // Anything else is a real failure (e.g. "there must always be
              // at least one owner") — let it bubble to the modal's own
              // error display like any other rejected submit.
              if (!(err.status === 409 && err.body && err.body.downgrade)) throw err;

              var confirmed = await R.confirm({
                title: 'Change ' + button.dataset.name + '’s role?',
                message: 'You are about to change ' + button.dataset.name + ' from ' +
                  err.body.current_role_label + ' to ' + err.body.new_role_label + '. ' +
                  'They will immediately lose access to ' + err.body.loses.join('; ') + '. Are you sure?',
                confirmLabel: 'Change role',
                danger: true,
              });
              // Cancelling leaves the "Change role" modal open on the role
              // they had already picked, rather than closing the whole flow —
              // they may just want a different new role, not to give up.
              if (!confirmed) return;

              await api.patch('/settings/team/' + button.dataset.changeRole, { role: newRole, confirm_downgrade: true });
            }

            close();
            toast('Role updated.', 'ok');
            R.reload();
          },
        });
      });
    });

    var makeTeam = R.qs('#btn-make-team', view);
    if (makeTeam) {
      makeTeam.addEventListener('click', function () {
        R.modal({
          title: 'Turn this into a team workspace',
          body:
            '<p class="muted mb-2">Everything you have — projects, buyers, payments, documents — moves to the new team.</p>' +
            '<div class="field"><label for="tm-name">Team name</label>' +
              '<input class="input" id="tm-name" name="name" required placeholder="Adron Homes"></div>',
          submitLabel: 'Create team',
          onSubmit: async function (form, close) {
            var result = await api.post('/settings/team', R.values(form));
            close();

            // The API token itself needs no change — org scope is resolved
            // fresh from team_members on every request, never carried in the
            // token — but this screen's cached view of "am I a solo account
            // or a team" was set once at sign-in and has to be refreshed
            // explicitly, or the app goes on describing a workspace that no
            // longer exists until the next full sign-in.
            R.state.user = await R.authApi('/me');

            if (result.failed && result.failed.length) {
              toast('Team created, but some records did not move. Check the activity log.', 'err');
            } else {
              toast('Team created.', 'ok');
            }
            R.reload();
          },
        });
      });
    }

    R.onClick(view, '[data-remove]', async function (button) {
      await removeMemberModal(button.dataset.remove, button.dataset.name);
    });

    R.qsa('[data-make-owner]', view).forEach(function (button) {
      button.addEventListener('click', function () {
        R.modal({
          title: 'Make ' + button.dataset.name + ' the workspace owner?',
          body:
            '<div class="notice mb-2">You will no longer be the owner — you move to <b>Head of Sales</b> instead. ' +
              esc(button.dataset.name) + ' becomes the only person who can transfer ownership again.</div>' +
            '<p class="muted">Everything else — projects, buyers, payments — stays exactly as it is.</p>',
          submitLabel: 'Transfer ownership',
          onSubmit: async function (form, close) {
            await api.post('/settings/team/transfer-owner', { member_id: button.dataset.makeOwner });
            close();
            toast('Ownership transferred.', 'ok');
            R.state.user = await R.authApi('/me');
            R.reload();
          },
        });
      });
    });

    R.qsa('[data-rate]', view).forEach(function (button) {
      button.addEventListener('click', function () {
        R.modal({
          title: 'Commission rate',
          body:
            '<div class="field"><label for="cr-rate">Rate (%)</label>' +
              '<input class="input" id="cr-rate" name="commission_rate" type="number" min="0" max="100" step="0.1" value="' + esc(button.dataset.current) + '"></div>' +
            '<p class="field-hint">Applies to future payments only. Commission already earned keeps the rate that was in force when it was earned.</p>',
          submitLabel: 'Save rate',
          onSubmit: async function (form, close) {
            await api.patch('/sales-reps/' + button.dataset.rate, { commission_rate: R.values(form).commission_rate });
            close();
            toast('Rate updated.', 'ok');
            R.reload();
          },
        });
      });
    });

    // R.onClick for the spinner/disable and automatic error toast on the
    // (rare, but real — a stale invite, a race with another admin) failure
    // path a bare addEventListener here had no try/catch for. `team` is
    // already sitting in this closure from the Promise.all above — no need
    // to hit /settings/team a second time for data that hasn't changed.
    R.onClick(view, '#btn-add-rep', async function () {
      var candidates = team.members.filter(function (m) { return m.user_id; });

      R.modal({
        title: 'Add a sales rep',
        body: candidates.length
          ? '<div class="field"><label for="rep-user">Person</label>' +
              '<select class="select" id="rep-user" name="user_id">' +
                candidates.map(function (m) {
                  return '<option value="' + esc(m.user_id) + '">' + esc(m.full_name || m.email) + '</option>';
                }).join('') + '</select></div>' +
            '<div class="field"><label for="rep-rate">Commission rate (%)</label>' +
              '<input class="input" id="rep-rate" name="commission_rate" type="number" min="0" max="100" step="0.1" placeholder="Leave blank for the workspace default"></div>'
          : '<p class="muted">Invite someone to the workspace first — a sales rep has to be a person with an account.</p>',
        submitLabel: candidates.length ? 'Add rep' : null,
        onSubmit: async function (form, close) {
          var v = R.values(form);
          await api.post('/sales-reps', {
            user_id: v.user_id,
            commission_rate: v.commission_rate == null ? undefined : v.commission_rate,
          });
          close();
          toast('Sales rep added.', 'ok');
          R.reload();
        },
      });
    });
  }

  // The bin. Soft delete is only a real safety net if the person who deleted
  // something by mistake can find it and put it back without asking anyone.
  async function binTab(view, tabs, of) {
    var kinds = [['customers', 'Buyers'], ['reservations', 'Reservations'], ['units', 'Units'],
      ['projects', 'Projects'], ['documents', 'Documents'], ['tasks', 'Tasks']];

    var rows = await api('/recycle/' + of + '?limit=200');

    // Each table has a different "what is this row" field, so the label is
    // picked per kind rather than guessed at generically.
    var labelOf = function (row) {
      return row.full_name || row.name || (row.unit_number ? 'Unit ' + row.unit_number : null)
        || row.title || (row.doc_type ? String(row.doc_type).replace(/_/g, ' ') : null)
        || String(row.id).slice(0, 8);
    };

    view.innerHTML = head('Bin', 'Deleted records are kept permanently. Restoring one brings back everything that went with it.') +
      tabs +
      '<div class="filter-row">' +
        kinds.map(function (k) {
          return '<a class="pill' + (of === k[0] ? ' is-on' : '') + '" href="#/settings?tab=bin&of=' + k[0] + '">' + k[1] + '</a>';
        }).join('') +
      '</div>' +

      card(null, table(
        [{ label: 'Record' }, { label: 'Deleted' }, { label: '' }],
        rows,
        function (row) {
          return '<tr>' +
            '<td class="cell-primary">' + esc(labelOf(row)) + '</td>' +
            '<td class="muted">' + esc(R.fmtRelative(row.deleted_at) || fmtDate(row.deleted_at)) + '</td>' +
            '<td class="right"><button class="btn-quiet" data-restore="' + esc(row.id) + '">Restore</button></td>' +
          '</tr>';
        },
        {
          emptyTitle: 'Nothing deleted',
          emptyHint: 'Deleted records appear here and can be restored at any time.',
        }
      ), { flush: true });

    R.onClick(view, '[data-restore]', async function (button) {
      var result = await api.post('/recycle/' + of + '/' + button.dataset.restore + '/restore');
      var total = Object.values(result.restored || {}).reduce(function (s, n) { return s + n; }, 0);
      toast('Restored ' + total + ' record(s).', 'ok');
      R.refreshCounts();
      R.reload();
    });
  }

  /* ══ REMOVING SOMEONE FROM THE TEAM ═════════════════════════════════════
     A departing rep's open reservations have to go somewhere. Without this
     step they keep pointing at a rep who is gone: nobody is responsible,
     nobody is chasing, no commission accrues, and the morning brief names
     someone who no longer has an account.

     The workload is fetched FIRST so the question is concrete — "Emeka has 40
     open reservations worth ₦1.8bn. Reassign them to:" — rather than a generic
     warning that gets clicked through. */
  async function removeMemberModal(memberId, name) {
    var work = await api('/settings/team/' + memberId + '/workload');

    var hasReps = work.reps && work.reps.length;

    var panel = R.modal({
      title: 'Remove ' + name + '?',
      body:
        (work.has_workload
          ? '<div class="notice mb-2">' +
              '<b>' + esc(name) + ' holds ' + work.open_reservations + ' open reservation' +
              (work.open_reservations === 1 ? '' : 's') + '</b>' +
              (work.open_value ? ' worth ' + esc(nairaShort(work.open_value)) : '') + '. ' +
              'Choose who takes them over.' +
            '</div>'
          : '<div class="notice info mb-2">' + esc(name) + ' has no open reservations to hand over.</div>') +

        (work.has_workload
          ? '<div class="field"><label for="rm-target">Reassign open reservations to</label>' +
              '<select class="select" id="rm-target" name="reassign_to">' +
                (hasReps
                  ? options(work.reps, 'id', 'name') + '<option value="">Leave unassigned for now</option>'
                  : '<option value="">Leave unassigned — no other active rep</option>') +
              '</select>' +
              '<p class="field-hint">' +
                'Only open reservations move. Completed and cancelled ones keep ' + esc(name) +
                '’s name, and commission they have already earned stays theirs — it was earned on money that ' +
                'had already arrived.' +
              '</p></div>'
          : '') +

        '<p class="muted fs-13">' +
          'Their sign-in stops working immediately, every session they have open ends, and their sales-rep ' +
          'record is deactivated rather than deleted so past sales still show who made them.' +
        '</p>',
      submitLabel: 'Remove ' + name,
      onSubmit: async function (form, close) {
        var v = R.values(form);
        var result = await api.patch('/settings/team/' + memberId, {
          status: 'removed',
          reassign_to: v.reassign_to || null,
        });
        close();

        var parts = ['Removed ' + name];
        if (result.reassigned && result.reassigned.moved) {
          parts.push(result.reassigned.moved + ' reservation(s) reassigned');
        }
        if (result.reassigned && result.reassigned.orphaned) {
          parts.push(result.reassigned.orphaned + ' left unassigned');
        }
        if (result.sessions_ended) parts.push('sessions ended');

        toast(parts.join(' — ') + '.', 'ok');
        R.reload();
      },
    });

    // Scoped to this modal's own root — see the comment in deleteModal().
    var submit = R.qs('[type="submit"]', panel.root);
    if (submit) { submit.classList.remove('primary'); submit.classList.add('danger'); }
  }

  async function activityTab(view, tabs) {
    var results = await Promise.all([api('/audit?limit=150'), api('/audit/notifications?limit=60')]);
    var entries = results[0], notifications = results[1];

    view.innerHTML = head('Activity log', 'Who did what, when. Append-only — nothing in this product can edit or delete it.') + tabs +

      card('Actions', table(
        [{ label: 'When' }, { label: 'Who' }, { label: 'Action' }, { label: 'Detail' }],
        entries,
        function (e) {
          return '<tr>' +
            '<td class="muted nowrap">' + esc(R.fmtDateTime(e.created_at)) + '</td>' +
            '<td class="muted">' + esc(e.actor_email || e.actor_kind) + '</td>' +
            '<td><span class="mono fs-11-5">' + esc(e.action) + '</span></td>' +
            '<td class="muted">' + esc(e.summary || '') + '</td>' +
          '</tr>';
        },
        { emptyTitle: 'Nothing recorded yet' }
      ), { flush: true }) +

      card('Messages sent', table(
        [{ label: 'When' }, { label: 'Channel' }, { label: 'To' }, { label: 'Subject' }, { label: 'Result' }],
        notifications,
        function (n) {
          return '<tr>' +
            '<td class="muted nowrap">' + esc(R.fmtDateTime(n.created_at)) + '</td>' +
            '<td class="muted">' + esc(n.channel) + '</td>' +
            '<td class="muted">' + esc(n.recipient) + '</td>' +
            '<td class="muted">' + esc(n.subject || n.template || '') + '</td>' +
            '<td>' + badge(n.status) + (n.error ? '<div class="cell-meta">' + esc(n.error) + '</div>' : '') + '</td>' +
          '</tr>';
        },
        {
          emptyTitle: 'Nothing sent yet',
          emptyHint: 'Receipts and alerts appear here whether they were delivered, failed, or skipped because email is not configured.',
        }
      ), { flush: true });
  }
})();
