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

  // TASK 2.9/2.12 — "deed_of_assignment" read as-is once the underscores were
  // swapped for spaces. Proper title case, except linking words ("of", "and",
  // "the") after the first position, which stay lowercase — "Deed of
  // Assignment", not "Deed Of Assignment". A formula rather than a fixed
  // lookup table so a doc_type added later formats correctly with no code
  // change here.
  var DOC_TYPE_MINOR_WORDS = { of: 1, and: 1, the: 1 };
  function formatDocType(type) {
    return String(type || '').replace(/_/g, ' ').split(' ').map(function (word, i) {
      if (!word) return word;
      if (i > 0 && DOC_TYPE_MINOR_WORDS[word.toLowerCase()]) return word.toLowerCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }).join(' ');
  }

  // SECTION 10 — group by (reservation, doc_type, payment): a reservation
  // can hold many payments, each its own receipt document sharing the same
  // reservation_id + doc_type, so payment_id is what tells separate
  // receipts apart while still grouping every VERSION of the same
  // allocation letter or legal document together.
  function documentGroupKey(d) {
    return d.reservation_id + '|' + d.doc_type + '|' + (d.payment_id || '');
  }

  // Returns one row per (reservation, doc_type, payment) group — the
  // current live version — with __previousVersions attached for
  // documentRow's own "Show previous versions" toggle.
  function currentDocumentRows(documents) {
    var groups = {};
    documents.forEach(function (d) {
      var key = documentGroupKey(d);
      (groups[key] = groups[key] || []).push(d);
    });
    var rows = [];
    Object.keys(groups).forEach(function (key) {
      var versions = groups[key].slice().sort(function (a, b) { return (b.version || 1) - (a.version || 1); });
      var current = versions.filter(function (d) { return !d.superseded_at; })[0] || versions[0];
      current.__previousVersions = versions.filter(function (d) { return d.id !== current.id; });
      rows.push(current);
    });
    return rows.sort(function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });
  }

  // SECTION 9 — 'pending' (never issued) and 'signed'/'superseded' (already
  // resolved, one way or the other) never read as expired, only a
  // generated-or-sent document that is still sitting there past its date.
  function documentIsExpired(d) {
    return (d.status === 'generated' || d.status === 'sent') && !!d.expires_at && d.expires_at < new Date().toISOString();
  }

  function documentRow(d) {
    var reservation = d.re_reservations || {};
    var unit = reservation.re_units || {};
    // SECTION 8 — a generated-but-not-yet-signed legal document can have
    // its signing link resent (re-runs /generate, which always re-issues
    // and re-sends one — documentService.generateDocument).
    var signable = ['deed_of_assignment', 'subscriber_agreement', 'power_of_attorney'].indexOf(d.doc_type) !== -1;
    var expired = documentIsExpired(d);
    var previous = d.__previousVersions || [];

    var mainRow = '<tr>' +
      '<td class="cell-primary">' + esc(formatDocType(d.doc_type)) + (d.version > 1 ? ' <span class="muted">v' + d.version + '</span>' : '') +
        '<div class="cell-meta">' + esc((reservation.re_customers && reservation.re_customers.full_name) || '—') + '</div></td>' +
      '<td class="muted hide-mobile">' + esc(unit.unit_number || '—') + '</td>' +
      '<td>' + (expired ? badge('expired') : badge(d.status)) + '</td>' +
      '<td class="muted hide-mobile">' + esc(d.generated_at ? fmtDate(d.generated_at) : '—') + '</td>' +
      '<td class="muted hide-mobile">' + esc(d.expires_at ? fmtDate(d.expires_at) : '—') + '</td>' +
      '<td class="right nowrap">' +
        (d.status === 'generated' || d.status === 'signed'
          ? '<button class="btn-quiet" data-download="' + esc(d.id) + '">Preview</button>'
          : '<button class="btn-quiet" data-generate="' + esc(d.id) + '">Generate</button>') +
        (signable && d.status === 'generated'
          ? ' <button class="btn-quiet" data-generate="' + esc(d.id) + '">Resend link</button>'
          : '') +
      '</td>' +
    '</tr>';

    if (!previous.length) return mainRow;

    var label = 'Show ' + R.plural(previous.length, 'previous version');
    return mainRow +
      '<tr><td colspan="6" class="sched-detail-cell">' +
        '<button class="btn-quiet" data-toggle-versions="' + esc(d.id) + '" data-versions-label="' + esc(label) + '">' + esc(label) + '</button>' +
        '<div class="hidden mt-1" data-versions-detail="' + esc(d.id) + '">' +
          previous.map(previousVersionRow).join('') +
        '</div>' +
      '</td></tr>';
  }

  function previousVersionRow(d) {
    return '<div class="sched-history-row flex-row justify-between gap-10">' +
      '<span>v' + (d.version || 1) + ' — ' + badge(d.status) +
        (d.generated_at ? ' <span class="page-sub">generated ' + esc(fmtDate(d.generated_at)) + '</span>' : '') + '</span>' +
      '<button class="btn-quiet" data-download="' + esc(d.id) + '">Preview</button>' +
    '</div>';
  }

  // Remembers the project filter across screens, so choosing "Lekki Gardens"
  // on the dashboard does not reset when you go and look at the units.
  //
  // It is module-level, which means it outlives a sign-out unless something
  // clears it — and an office machine shared between the MD and a collections
  // officer would hand the second person a dashboard silently scoped to the
  // first person's project. realestate.js calls the hook below from signOut().
  var projectFilter = null;
  // TASK 2.3 — whether the dashboard's "Drafted follow-ups" card is showing
  // every draft or just the first 5. Same module-level pattern as
  // projectFilter above, and cleared alongside it for the same reason.
  var showAllDrafts = false;
  // Progressive disclosure — the Drafted follow-ups and Tasks sections start
  // collapsed on every dashboard visit ("nothing else visible by default"),
  // and open only for the rest of THIS session's dashboard visits once
  // clicked open, same module-level/reset-on-sign-out lifetime as everything
  // else on this list.
  var draftsSectionOpen = false;
  var tasksSectionOpen = false;

  R.resetScreenState = function () {
    projectFilter = null; expandedScheduleBuyerId = null; showAllDrafts = false;
    draftsSectionOpen = false; tasksSectionOpen = false;
    leaderboardSort = 'total_collected';
  };

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

  // Design item 3 — no more coloured top border (the accent-X modifier):
  // the value's own colour (o.tone) already carries that signal, and a
  // border repeating it was double-signalling the same one fact.
  function stat(label, value, opts) {
    var o = opts || {};
    return '<div class="stat">' +
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

  // Design item 5 — a labelled group inside a form, replacing the plain
  // <div class="divider"> some modals used between unrelated field
  // clusters. Stacked sections get their 24px gap for free from
  // .form-section + .form-section's own margin-top; the caller does not
  // add spacing between calls.
  function formSection(label, bodyHtml) {
    return '<div class="form-section">' +
      '<div class="form-section-label">' + esc(label) + '</div>' +
      bodyHtml +
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

  // SECTION 23 — the setup checklist card. R.navigate targets already used
  // elsewhere in the sidebar (settings, buyers, projects) so "Add a buyer"
  // etc. are real shortcuts, not just labels.
  var ONBOARDING_STEP_LINK = {
    project_created: '#/projects',
    units_added: '#/projects',
    buyer_added: '#/buyers',
    reservation_created: '#/buyers',
    payment_recorded: '#/payments',
    branding_configured: '#/settings?tab=workspace',
    team_invited: '#/settings?tab=team',
    brief_generated: '#/dashboard',
  };

  function onboardingCardHtml(onboarding) {
    var nextStep = onboarding.steps.filter(function (s) { return !s.done; })[0];
    return '<div class="card onboarding-card mb-2">' +
      '<div class="card-head">' +
        '<span class="eyebrow">Get set up</span>' +
        '<span class="spacer"></span>' +
        '<span class="muted mono">' + onboarding.completed_count + '/' + onboarding.total_count + '</span>' +
      '</div>' +
      '<div class="card-body">' +
        '<ul class="onboarding-steps">' +
          onboarding.steps.map(function (s) {
            var link = ONBOARDING_STEP_LINK[s.key];
            return '<li class="' + (s.done ? 'done' : '') + '">' +
              '<span class="onboarding-mark">' + (s.done ? '✓' : '○') + '</span>' +
              (s.done || !link
                ? '<span>' + esc(s.label) + '</span>'
                : '<a href="' + link + '">' + esc(s.label) + '</a>') +
            '</li>';
          }).join('') +
        '</ul>' +
        (nextStep ? '<p class="muted mt-1 mb-0">Next: ' + esc(nextStep.label) + '</p>' : '') +
      '</div>' +
    '</div>';
  }

  // Progressive disclosure for the Drafted follow-ups / Tasks sections —
  // collapsed to a single "Show N …" bar until clicked, per zone. Nothing
  // renders at all when there is nothing behind it: "Show 0 tasks" is not
  // a button worth offering.
  function collapsibleDashboardSection(opts) {
    if (!opts.count) return '';
    if (!opts.open) {
      return '<div class="card mt-2"><button class="collapsible-toggle" id="' + opts.toggleId + '">' +
        '<span>' + esc(opts.showLabel) + '</span><span class="collapsible-chevron">▾</span>' +
      '</button></div>';
    }
    return '<div class="mt-2">' + card(opts.cardTitle, opts.bodyHtml, {
      flush: true,
      actions: (opts.cardActions || '') + '<button class="btn-quiet" id="' + opts.toggleId + '">Hide</button>',
    }) + '</div>';
  }

  /* ══ COMMAND CENTER ═════════════════════════════════════════════════════
     The daily habit. A morning briefing, not a control room: the numbers,
     the brief, and who to call — everything else (drafted follow-ups, open
     tasks) is one click away, not on screen by default. */
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

      // SECTION 23 — owner only: inviting a team member and setting up
      // branding are workspace-wide decisions nobody else on the team can
      // act on, same reasoning the critical-projects card below restricts
      // itself to the owner.
      var wantsOnboarding = R.state.user.role === 'owner';

      var results = await Promise.all([
        api('/dashboard' + scope),
        // A Sales Executive and Documentation never reach GET /at-risk — the
        // server would 403 it, so this simply isn't asked for them.
        canSeeAtRisk ? api('/dashboard/at-risk' + scope) : Promise.resolve([]),
        api('/tasks?status=open'),
        wantsOnboarding ? api('/dashboard/onboarding').catch(function () { return null; }) : Promise.resolve(null),
      ]);

      var d = results[0], atRisk = results[1], tasks = results[2], onboarding = results[3];
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

      // TASK 2.5 — buyer-name clickthrough in the brief. aiBrief.js now
      // attaches customer_id alongside customer_name on every risks/
      // follow_ups entry (aiBrief.js's resolveRefs/buildFallbackBrief), so
      // this is a direct lookup rather than a guess against a separately-
      // loaded list — covers every buyer the brief actually mentions, not
      // just ones that also happen to be in today's at-risk view.
      var buyerIdByName = {};
      risks.concat(drafts).forEach(function (r) {
        if (r.customer_name && r.customer_id) buyerIdByName[r.customer_name] = r.customer_id;
      });

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

      // SECTION 1 — the browser's own permission prompt can only ever be
      // triggered by a real user gesture (a click), never fired
      // automatically on page load — so this is a banner with a button,
      // not the OS prompt appearing on its own. Shown once per browser
      // (R.dismissPushBanner/localStorage) whether granted or dismissed;
      // Notification.permission itself is what stops it reappearing after
      // the browser's own prompt is answered either way.
      var showPushBanner = R.shouldShowPushBanner();

      view.innerHTML =
        (showPushBanner
          ? '<div class="notice info mb-2" id="push-banner">' +
              '<div class="flex-row justify-between align-center gap-10">' +
                '<span>Turn on notifications for payments, the morning brief, and buyers falling behind — even when this tab is closed.</span>' +
                '<div class="btn-row">' +
                  '<button class="btn primary" id="btn-enable-push">Enable notifications</button>' +
                  '<button class="btn-quiet" id="btn-dismiss-push">Not now</button>' +
                '</div>' +
              '</div>' +
            '</div>'
          : '') +

        // SECTION 15 — "a prominent warning card... visible to owner
        // only". First thing on the screen, before even the greeting —
        // d.critical_projects is already [] for every other role (see
        // routes/dashboard.js), so this never renders for them regardless.
        (d.critical_projects && d.critical_projects.length
          ? '<div class="notice mb-2">' +
              d.critical_projects.map(function (p) {
                return '<b>' + esc(p.project_name) + '</b> is showing signs of operational stress ' +
                  '(health score ' + p.health_score + '/100). Review immediately.';
              }).join('<br>') +
            '</div>'
          : '') +

        // Keep the checklist visible until it is actually complete. Hiding it
        // at an arbitrary halfway point strands an owner with unfinished
        // setup work and no reminder or shortcut back to it.
        (onboarding && onboarding.completed_count < onboarding.total_count ? onboardingCardHtml(onboarding) : '') +

        '<div class="greeting"><h1>' + esc(greeting()) + '</h1>' +
          '<div class="greeting-lines">' + lines.join('') + '</div></div>' +

        projectPills +

        // ZONE 1 — the numbers, first: moved ahead of the brief so the
        // three-zone order on screen (numbers, brief, who to call) matches
        // the order this HTML is actually built in.
        // ₦28,450,000 at 18px (the mobile .stat-value size) is the widest
        // thing on a 4-up grid squeezed to one column — nairaShort's
        // ₦28.5m fits the tile instead of wrapping or overflowing it.
        '<div class="grid cols-4">' +
          stat('Collected this month', kpiMoney(d.collected_this_month), { tone: 'moss', sub: R.plural(d.collected_this_month_count, 'payment') }) +
          stat('Outstanding', kpiMoney(d.outstanding_total), { sub: R.plural(d.outstanding_count, 'installment') }) +
          stat('Overdue', kpiMoney(d.overdue.amount), {
            tone: 'clay',
            sub: d.overdue.count ? R.plural(d.overdue.count, 'installment') : 'All current',
          }) +
          stat('Due in 7 days', kpiMoney(d.due_next_7_days), { sub: R.plural(d.due_next_7_days_count, 'installment') }) +
        '</div>' +

        // ZONE 2 — the Morning Brief, full width and dominant. Owner and
        // Sales Director only. Collections and a Sales Executive see their
        // own KPIs above instead; there is nothing strategic here for
        // either of them to read, and no button that would only 403 if
        // pressed.
        (canSeeBrief
          ? '<div class="brief mt-2">' +
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
                (brief
                  ? linkifyBuyerNames(brief.summary, buyerIdByName)
                  : esc('No brief yet. The first one is written automatically at 7:00 AM Lagos time, or you can generate it now.')) +
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

              // SECTION 11 — Market Intelligence Agent folds its weekly
              // report into the SAME brief row (marketIntelAgent.js's own
              // comment on why), so this only ever appears on the Monday it
              // was generated and every day after until the next Monday
              // refreshes it — never a second, competing brief section.
              (brief && brief.payload && brief.payload.market_intelligence && brief.payload.market_intelligence.summary
                ? '<div class="notice mt-1 mb-0">' +
                    '<b>Market Intelligence</b><br>' + esc(brief.payload.market_intelligence.summary) +
                    (brief.payload.market_intelligence.signals || []).map(function (s) {
                      return '<div class="page-sub mt-1">' + esc(s.detail) + '</div>';
                    }).join('') +
                  '</div>'
                : '') +

              // SECTION 15 — Monday only (aiBrief.js only ever computes
              // this that one day), owner only — the same field exists in
              // brief.payload for a Sales Director too (the brief row is
              // shared, not role-specific), but this block is what
              // actually decides whether it is shown.
              (R.can('projectHealth.read') && brief && brief.payload && brief.payload.project_health_summary
                ? '<div class="notice mt-1 mb-0">' +
                    '<b>Project health</b> — ' +
                    R.plural(brief.payload.project_health_summary.critical_count, 'project') + ' critical, ' +
                    R.plural(brief.payload.project_health_summary.warning_count, 'project') + ' warning.<br>' +
                    brief.payload.project_health_summary.projects.map(function (p) {
                      return esc(p.project_name) + ': ' + p.health_score + '/100';
                    }).join(' · ') +
                  '</div>'
                : '') +

              // SECTION 11 — Document Agent flags anything unsigned 21+ days.
              (brief && brief.payload && (brief.payload.high_priority_documents || []).length
                ? '<div class="notice warn mt-1 mb-0">' +
                    '<b>Unsigned documents</b><br>' +
                    brief.payload.high_priority_documents.map(function (d) {
                      return esc(d.customer_name) + ' — ' + esc(formatDocType(d.doc_type)) + ', ' + d.days_unsigned + ' days unsigned';
                    }).join('<br>') +
                  '</div>'
                : '') +

              // FEATURE — buyer default prediction. Deterministically
              // computed (aiBrief.js's own comment: a ranking by a stored
              // number, not something worth asking the model for), so it
              // is present whether today's brief was written by AI or the
              // rule-based fallback — same convention as every other
              // notice block above.
              (brief && brief.payload && (brief.payload.top_default_risks || []).length
                ? '<div class="notice mt-1 mb-0">' +
                    '<b>Likely to default this month</b><br>' +
                    brief.payload.top_default_risks.map(function (r) {
                      return esc(r.customer_name) +
                        (r.unit_number ? ' — Unit ' + esc(r.unit_number) : '') +
                        (r.project ? ' (' + esc(r.project) + ')' : '') +
                        ' — risk score ' + r.default_risk_score + '/100';
                    }).join('<br>') +
                  '</div>'
                : '') +

              // FEATURE — buyer sentiment analysis. Same deterministic,
              // code-computed treatment as top_default_risks just above —
              // present regardless of whether the model or the fallback
              // wrote today's brief.
              (brief && brief.payload && (brief.payload.at_risk_sentiment || []).length
                ? '<div class="notice mt-1 mb-0">' +
                    brief.payload.at_risk_sentiment.map(function (s) {
                      return esc(s.customer_name) + ' — sentiment flagged as at-risk based on recent messages';
                    }).join('<br>') +
                  '</div>'
                : '') +

              (risks.length
                ? '<ol class="risk-list">' + risks.slice(0, 3).map(function (r, i) {
                    var buyerId = buyerIdByName[r.customer_name];
                    // data-buyer is what wireRiskRows(view) below already
                    // listens for — the same attribute the At-Risk card's
                    // own "Open" button uses — so a row with a resolved id
                    // opens the buyer drawer for free, no new wiring needed.
                    return '<li class="risk-list-row"' + (buyerId ? ' data-buyer="' + esc(buyerId) + '"' : '') + '>' +
                      '<span class="risk-list-num">' + (i + 1) + '.</span>' +
                      '<span class="risk-list-text">' +
                        '<b>' + esc(r.customer_name) + '</b>' +
                        ' / ' + esc(nairaShort(r.overdue_amount)) +
                        ' · ' + esc(R.plural(r.missed_count, 'missed installment')) +
                        ' · ' + esc(R.plural(r.days_late, 'day')) + ' overdue' +
                      '</span>' +
                      '<span class="risk-list-dot ' + riskDotClass(r.days_late) + '"></span>' +
                    '</li>';
                  }).join('') + '</ol>' +
                  (risks.length > 3
                    ? '<a class="btn-quiet risk-list-viewall" href="#/at-risk">View all ' + risks.length + ' →</a>'
                    : '')
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

        // Two revenue streams read as one number without this. Only shown once
        // there is actually a rental portfolio to report on — a pure off-plan
        // developer does not need "₦0 rental income" taking up a row forever.
        (d.collected_rental_this_month
          ? '<div class="grid cols-2 mt-2">' +
              stat('Sales income this month', naira(d.collected_sales_this_month), { tone: 'moss' }) +
              stat('Rental income this month', naira(d.collected_rental_this_month), { tone: 'gold' }) +
            '</div>'
          : '') +

        // ZONE 3 — at risk, full width, the third and last thing this screen
        // leads with. Capped at 5 (not 6): "who to call" is a short list to
        // scan before the first call of the day, not a second table.
        (canSeeAtRisk
          ? '<div class="mt-2">' + card('At risk', atRisk.length
              ? atRisk.slice(0, 5).map(riskRow).join('')
              : R.emptyState('All clear — no overdue buyers today.', null, null, 'check-circle'),
              { flush: true, actions: atRisk.length > 5 ? '<a class="btn-quiet" href="#/at-risk">See all ' + atRisk.length + '</a>' : '' }) + '</div>'
          : '') +

        // Everything below here is progressive disclosure: collapsed by
        // default (draftsSectionOpen/tasksSectionOpen both start false,
        // R.resetScreenState), so the screen a person actually lands on is
        // numbers, brief, who to call — nothing else, until they ask for it.
        (canSeeBrief ? collapsibleDashboardSection({
            open: draftsSectionOpen,
            count: drafts.length,
            showLabel: 'Show ' + R.plural(drafts.length, 'drafted message'),
            toggleId: 'btn-toggle-drafts',
            cardTitle: 'Drafted follow-ups',
            cardActions:
              '<button class="btn-quiet" id="btn-drafts-send-all">Send all</button>' +
              (drafts.length > 5
                ? (showAllDrafts
                    ? '<button class="btn-quiet" id="btn-drafts-collapse">Show fewer</button>'
                    : '<button class="btn-quiet" id="btn-drafts-see-all">See all ' + drafts.length + '</button>')
                : ''),
            // SECTION 15 — the in-progress queue banner sits above the draft
            // list itself, visible regardless of showAllDrafts, so leaving
            // the dashboard mid-sequence and coming back still shows where
            // the queue is.
            bodyHtml: whatsappQueueBannerHtml() + (showAllDrafts ? drafts : drafts.slice(0, 5)).map(draftRow).join(''),
          }) : '') +

        collapsibleDashboardSection({
          open: tasksSectionOpen,
          count: tasks.length,
          showLabel: 'Show ' + R.plural(tasks.length, 'open task'),
          toggleId: 'btn-toggle-tasks',
          cardTitle: 'Tasks',
          cardActions: '<a class="btn-quiet" href="#/tasks">All tasks</a>',
          bodyHtml: tasks.slice(0, 7).map(taskRow).join(''),
        });

      R.qsa('[data-project]', view).forEach(function (pill) {
        pill.addEventListener('click', function () {
          projectFilter = pill.dataset.project || null;
          R.reload();
        });
      });

      R.onClick(view, '#btn-enable-push', async function () {
        await R.subscribeToPush();
        R.dismissPushBanner();
        toast('Notifications enabled.', 'ok');
        R.refreshNotifBell();
        R.reload();
      });

      R.onClick(view, '#btn-dismiss-push', function () {
        R.dismissPushBanner();
        R.reload();
      });

      R.onClick(view, '#btn-toggle-drafts', function () { draftsSectionOpen = !draftsSectionOpen; R.reload(); });
      R.onClick(view, '#btn-toggle-tasks', function () { tasksSectionOpen = !tasksSectionOpen; R.reload(); });

      R.onClick(view, '#btn-drafts-see-all', function () { showAllDrafts = true; R.reload(); });
      R.onClick(view, '#btn-drafts-collapse', function () { showAllDrafts = false; R.reload(); });

      R.onClick(view, '#btn-drafts-send-all', function () {
        R.whatsappQueue.start(drafts);
        R.reload();
      });
      R.onClick(view, '#btn-drafts-queue-skip', function () {
        R.whatsappQueue.skip();
        R.reload();
      });
      R.onClick(view, '#btn-drafts-queue-done', function () {
        R.whatsappQueue.done();
        R.reload();
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
          '<a class="btn primary" href="#/documents">Go to Documents</a>' +
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

  // Wraps every occurrence of a known buyer name in `text` with a clickable
  // span carrying data-buyer — picked up by the same wireRiskRows/[data-buyer]
  // wiring the At-Risk card already uses. Longest names first, so "Chidi
  // Okafor" matches before a shorter name that happens to be a substring of
  // it. Always returns escaped, safe-to-insert HTML, even with an empty map.
  function linkifyBuyerNames(text, nameMap) {
    var names = Object.keys(nameMap).filter(Boolean).sort(function (a, b) { return b.length - a.length; });
    if (!names.length) return esc(text);
    var pattern = new RegExp('(' + names.map(function (n) {
      return n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('|') + ')', 'g');
    var out = '', lastIndex = 0, match;
    while ((match = pattern.exec(text))) {
      out += esc(text.slice(lastIndex, match.index));
      out += '<span class="brief-buyer-link" data-buyer="' + esc(nameMap[match[0]]) + '">' + esc(match[0]) + '</span>';
      lastIndex = match.index + match[0].length;
    }
    out += esc(text.slice(lastIndex));
    return out;
  }

  // Design item 1 — the brief's own numbered risk list. Four discrete
  // buckets off days_late, not the AI's own low/medium/high severity field
  // (a coarser, narrative read) — a plain, deterministic threshold on one
  // number, so the same buyer always gets the same colour regardless of
  // which words a model or the fallback wrote around them.
  function riskDotClass(daysLate) {
    var d = Number(daysLate) || 0;
    if (d >= 300) return 'risk-dot-red';
    if (d >= 90) return 'risk-dot-amber';
    if (d >= 30) return 'risk-dot-yellow';
    return 'risk-dot-grey';
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
    // TASK 2.24 — graduated by how late: 1-30 days reads as amber (the
    // .late-tag base style), 31-365 as red, 365+ as bold red. The LEGAL
    // escalation badge just below stays red regardless of day count — that
    // one signals a stage, not a duration, and the two must not be confused.
    if (c.days_late) {
      var lateClass = c.days_late > 365 ? 'late-tag severe' : c.days_late > 30 ? 'late-tag danger' : 'late-tag';
      flags += '<span class="' + lateClass + '">' + R.plural(c.days_late, 'day') + ' late</span>';
    }
    if (c.escalation && c.escalation.stage !== 'none') flags += badge(c.escalation.stage);
    // FEATURE — buyer default prediction. Above 70 specifically (the
    // product spec's own threshold) — the score already drives the sort
    // order server-side isn't relevant here, so this is purely "does this
    // one number cross the line worth a rep's attention".
    if (c.default_risk_score != null && c.default_risk_score > 70) {
      flags += '<span class="late-tag danger">DEFAULT RISK HIGH</span>';
    }
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
        (phone ? '<a class="action-link" href="tel:' + esc(phone) + '" data-customer-id="' + esc(c.customer.id) + '" data-customer-name="' + esc(c.customer.full_name) + '">Call</a>' : '') +
        (whatsapp ? '<a class="action-link" target="_blank" rel="noopener" href="' + esc(whatsapp) + '">WhatsApp</a>' : '') +
        // A promise the morning sweep already flagged open or broken still
        // needs a way out that isn't "wait for the buyer to pay" — paid in
        // cash at the office, or withdrawn on a second call. Without this the
        // only path off the at-risk list was the automatic one.
        (c.promise
          ? '<button class="action-link" data-resolve-promise="' + esc(c.promise.id) + '" data-resolve-status="kept">Mark kept</button>' +
            '<button class="action-link" data-resolve-promise="' + esc(c.promise.id) + '" data-resolve-status="cancelled">Cancel promise</button>'
          : '<button class="action-link" data-promise="' + esc(c.oldest_schedule_id) + '" data-name="' + esc(c.customer.full_name) + '">Log a promise</button>') +
        // SECTION 8 — surfaces once escalationService has already moved this
        // reservation to its worst stage; opening the case itself is still a
        // deliberate, owner-only click (legal.manage), never automatic.
        (c.escalation && c.escalation.stage === 'legal' && R.can('legal.manage')
          ? '<button class="action-link" data-open-legal-case="' + esc(c.reservation_id) + '" data-customer-id="' + esc(c.customer.id) +
            '" data-name="' + esc(c.customer.full_name) + '">Open legal case</button>'
          : '') +
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
    R.onClick(root, '[data-open-legal-case]', async function (button) {
      await openLegalCaseModal(button.dataset.openLegalCase, button.dataset.customerId, button.dataset.name);
    });
  }

  // SECTION 8 — opening a legal case from the at-risk row or the buyer
  // drawer. Owner only (legal.manage) — the button that leads here is
  // itself hidden from anyone else.
  async function openLegalCaseModal(reservationId, customerId, customerName) {
    var confirmed = await R.confirm({
      title: 'Open a legal case for ' + customerName + '?',
      message: 'This generates a formal demand letter and sends ' + customerName +
        ' a WhatsApp notice that their account has been escalated to legal recovery. This cannot be undone from here.',
      confirmLabel: 'Open legal case',
      danger: true,
    });
    if (!confirmed) return;

    await api.post('/legal-cases', { customer_id: customerId, reservation_id: reservationId });
    toast('Legal case opened. Demand letter generated.', 'ok');
    R.reload();
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

  // SECTION 15 — read fresh on every render (dashboard reload, or coming
  // back from WhatsApp Web) rather than cached, since R.whatsappQueue.current()
  // is sessionStorage-backed and can change from outside this render entirely.
  function whatsappQueueBannerHtml() {
    var queue = R.whatsappQueue.current();
    if (!queue) return '';
    return '<div class="notice info mb-2 flex-row justify-between align-center gap-10">' +
      '<span>Sending ' + (queue.index + 1) + ' of ' + queue.total +
        ' — ' + esc(queue.items[queue.index] ? queue.items[queue.index].name : '') + '</span>' +
      '<div class="btn-row">' +
        '<button class="btn-quiet" id="btn-drafts-queue-skip">Skip</button>' +
        '<button class="btn-quiet" id="btn-drafts-queue-done">Done</button>' +
      '</div>' +
    '</div>';
  }

  function draftRow(draft, i) {
    return '<div class="draft">' +
      '<div class="record-name"><span class="tag-ai">Auto</span>' + esc(draft.customer_name) + '</div>' +
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
        '<div class="task-title">' + (t.source === 'ai' ? '<span class="tag-ai">Auto</span>' : '') + esc(t.title) + '</div>' +
        (meta ? '<div class="task-meta">' + meta + '</div>' : '') +
      '</div>' +
      '<div class="btn-row">' +
        '<button class="btn-quiet" data-done="' + esc(t.id) + '">Done</button>' +
        '<button class="btn-quiet" data-dismiss="' + esc(t.id) + '">Dismiss</button>' +
      '</div>' +
    '</div>';
  }

  function wireTasks(root) {
    R.onClick(root, '[data-done]', async function (button) {
      await api.patch('/tasks/' + button.dataset.done + '/status', { status: 'done' });
      R.refreshCounts();
      await R.reload();
    });
    R.onClick(root, '[data-dismiss]', async function (button) {
      await api.patch('/tasks/' + button.dataset.dismiss + '/status', { status: 'dismissed' });
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
        head('At risk', 'Buyers with a missed installment, worst first. A broken promise outranks a bigger number.') +
        '<div class="grid cols-3 mb-2">' +
          stat('Buyers at risk', String(atRisk.length), { tone: atRisk.length ? 'clay' : null }) +
          stat('Total exposure', naira(exposure), { tone: 'clay' }) +
          stat('Broken promises', String(broken.length), { tone: broken.length ? 'clay' : null }) +
        '</div>' +
        card(null, atRisk.length
          ? atRisk.map(riskRow).join('')
          : R.emptyState('All clear — no overdue buyers today.', null, null, 'check-circle'),
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
          : status === 'open'
            ? R.emptyState('No open tasks.', 'Follow-ups you create, and the ones the AI suggests, both land here.', null, 'checkmark')
            : R.emptyState(
                'No ' + status + ' tasks',
                status === 'done'
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
      '<div class="task-title muted">' + (t.source === 'ai' ? '<span class="tag-ai">Auto</span>' : '') + esc(t.title) + '</div>' +
      '<div class="task-meta">' + esc(fmtDate(t.created_at)) + '</div>' +
    '</div></div>';
  }

  /* ══ LOG BOOK ═══════════════════════════════════════════════════════════
     FEATURE — team attendance & log book. Free-text operational notes
     (an incident, a visitor, a decision), filterable by project and type —
     the Operations-group counterpart to Tasks: things that happened, rather
     than things still to do. */
  var LOG_ENTRY_TYPES = [
    ['incident', 'Incident'], ['update', 'Update'], ['communication', 'Communication'],
    ['decision', 'Decision'], ['visitor', 'Visitor'],
  ];

  R.screens.logs = {
    render: async function (view, params, query) {
      var projectId = query.project_id || '';
      var entryType = query.entry_type || '';

      var qs = [];
      if (projectId) qs.push('project_id=' + encodeURIComponent(projectId));
      if (entryType) qs.push('entry_type=' + encodeURIComponent(entryType));

      var results = await Promise.all([
        api('/logs' + (qs.length ? '?' + qs.join('&') : '')),
        api('/projects'),
      ]);
      var entries = results[0], projects = results[1];

      view.innerHTML =
        head('Log Book', 'Incidents, visitors, decisions and updates — one place for what happened, not what to do next.',
          '<button class="btn primary" id="btn-new-log">New entry</button>') +
        '<div class="filter-row">' +
          '<select class="select" id="log-filter-project">' +
            '<option value="">All projects</option>' +
            projects.map(function (p) {
              return '<option value="' + esc(p.id) + '"' + (projectId === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
            }).join('') +
          '</select>' +
          '<select class="select" id="log-filter-type">' +
            '<option value="">All types</option>' +
            LOG_ENTRY_TYPES.map(function (t) {
              return '<option value="' + t[0] + '"' + (entryType === t[0] ? ' selected' : '') + '>' + t[1] + '</option>';
            }).join('') +
          '</select>' +
        '</div>' +
        card(null, entries.length
          ? entries.map(logEntryRow).join('')
          : R.emptyState('No log entries', 'Nothing has been logged yet for this filter.',
              '<button class="btn primary" id="btn-empty-log">Add an entry</button>'),
          { flush: true });

      function goto() {
        var next = [];
        var p = R.el('log-filter-project').value;
        var t = R.el('log-filter-type').value;
        if (p) next.push('project_id=' + encodeURIComponent(p));
        if (t) next.push('entry_type=' + encodeURIComponent(t));
        window.location.hash = '#/logs' + (next.length ? '?' + next.join('&') : '');
      }
      R.el('log-filter-project').addEventListener('change', goto);
      R.el('log-filter-type').addEventListener('change', goto);

      R.qsa('#btn-new-log, #btn-empty-log', view).forEach(function (b) {
        b.addEventListener('click', function () {
          R.modal({
            title: 'New log entry',
            body:
              '<div class="field"><label for="log-type">Type</label>' +
                '<select class="select" id="log-type" name="entry_type" required>' +
                  LOG_ENTRY_TYPES.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('') +
                '</select></div>' +
              '<div class="field"><label for="log-project">Project (optional)</label>' +
                '<select class="select" id="log-project" name="project_id">' +
                  '<option value="">Not tied to a project</option>' +
                  projects.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'; }).join('') +
                '</select></div>' +
              '<div class="field"><label for="log-content">What happened</label>' +
                '<textarea class="textarea" id="log-content" name="content" rows="4" required></textarea></div>',
            submitLabel: 'Add entry',
            onSubmit: async function (form, close) {
              var v = R.values(form);
              if (!v.content || !v.content.trim()) throw new Error('Describe what happened.');
              await api.post('/logs', {
                entry_type: v.entry_type, content: v.content.trim(), project_id: v.project_id || null,
              });
              close();
              toast('Logged.', 'ok');
              R.reload();
            },
          });
        });
      });
    },
  };

  function logEntryRow(entry) {
    var who = entry.users ? (entry.users.full_name || entry.users.email) : 'Someone';
    var type = LOG_ENTRY_TYPES.find(function (t) { return t[0] === entry.entry_type; });
    return '<div class="log-entry">' +
      '<div class="flex-row justify-between gap-10">' +
        '<div>' + badge(entry.entry_type) + ' <b>' + esc(type ? type[1] : entry.entry_type) + '</b>' +
          (entry.re_projects ? ' <span class="page-sub">· ' + esc(entry.re_projects.name) + '</span>' : '') + '</div>' +
        '<span class="page-sub nowrap">' + esc(R.fmtDateTime(entry.created_at)) + '</span>' +
      '</div>' +
      '<p class="mt-1">' + esc(entry.content) + '</p>' +
      '<div class="page-sub">Logged by ' + esc(who) + '</div>' +
    '</div>';
  }

  /* ══ PROJECTS ═══════════════════════════════════════════════════════════ */
  R.screens.projects = {
    render: async function (view) {
      // dashboard.read is granted to every role (routes/dashboard.js's own
      // comment: "every authenticated role may open this endpoint"), so this
      // second fetch needs no extra permission check beyond already being on
      // this screen. d.units is the same shape the dashboard used to show
      // its own inventory bar with — moved here, where the actual units live.
      var results = await Promise.all([api('/projects'), api('/dashboard')]);
      var projects = results[0], dashboardData = results[1];
      // Inventory is the developer's own book, not a rep's — permissions.js
      // documents Units/Projects as read-only for sales_rep explicitly. A
      // writable button in front of a read-only route is not a permission
      // model (same file's own words), so it's gated here, not just server-side.
      var canWrite = R.can('inventory.write');

      // SECTION 2 — milestone management is owner + sales_director only,
      // matching construction.manage in permissions.js.
      var canManageConstruction = R.can('construction.manage');
      // SECTION 12 — owner only, same tier as the investor report.
      var canManageContractors = R.can('contractors.manage');
      // SECTION 13 — owner/sales_director, same tier as every other
      // moderation-adjacent action in this product.
      var canModerateCommunity = R.can('community.moderate');

      view.innerHTML =
        head('Projects', 'Each development you are selling.',
          canWrite ? '<button class="btn primary" id="btn-new-project">New project</button>' : '') +
        // Moved here from the dashboard (it belongs with the units it
        // describes, not the morning briefing) — documentationDashboard
        // (routes/dashboard.js) returns a completely different shape with
        // no .units at all, so this only renders for a role that actually
        // gets one back.
        (projects.length && dashboardData && dashboardData.units
          ? card('Inventory', inventoryHtml(dashboardData.units)) + '<div class="mb-2"></div>'
          : '') +
        (projects.length
          ? '<div class="grid cols-3">' + projects.map(function (p) { return projectCard(p, canManageConstruction, canManageContractors, canModerateCommunity); }).join('') + '</div>'
          : card(null, R.emptyState(
              'No projects yet',
              'A project is one development — "Lekki Gardens Phase 2". Units, buyers and payments all hang off it.',
              canWrite ? '<button class="btn primary" id="btn-first-project">Create your first project</button>' : ''
            ), { flush: true }));

      R.qsa('#btn-new-project, #btn-first-project', view).forEach(function (b) {
        b.addEventListener('click', projectModal);
      });

      R.qsa('[data-project-open]', view).forEach(function (node) {
        node.addEventListener('click', function (event) {
          if (event.target.closest('[data-stop]')) return;
          projectFilter = node.dataset.projectOpen;
          R.go('#/units?project=' + node.dataset.projectOpen);
        });
      });

      R.onClick(view, '[data-project-progress]', function (button) {
        openMilestonesModal(button.dataset.projectProgress, button.dataset.projectName);
      });

      R.onClick(view, '[data-project-contractors]', async function (button) {
        await openContractorsModal(button.dataset.projectContractors, button.dataset.projectName);
      });

      R.onClick(view, '[data-project-community]', async function (button) {
        await openCommunityModerationModal(button.dataset.projectCommunity, button.dataset.projectName);
      });
    },
  };

  function projectCard(p, canManageConstruction, canManageContractors, canModerateCommunity) {
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
        '<div class="mt-2"><div class="meter accent"><i data-w="' + pct + '"></i></div>' +
          '<div class="units-legend mt-1 fs-11-5">' +
            '<span>' + (p.units_sold || 0) + ' sold</span>' +
            '<span>' + (p.units_reserved || 0) + ' reserved</span>' +
            '<span>' + (p.units_available || 0) + ' available</span>' +
          '</div>' +
        '</div>' +
        (canManageConstruction
          ? '<button class="btn-quiet mt-2" data-stop data-project-progress="' + esc(p.id) + '" data-project-name="' + esc(p.name) + '">Construction progress</button>'
          : '') +
        (canManageContractors
          ? '<button class="btn-quiet mt-2" data-stop data-project-contractors="' + esc(p.id) + '" data-project-name="' + esc(p.name) + '">Contractors</button>'
          : '') +
        (canModerateCommunity
          ? '<button class="btn-quiet mt-2" data-stop data-project-community="' + esc(p.id) + '" data-project-name="' + esc(p.name) + '">Community</button>'
          : '') +
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

  // SECTION 2 — construction milestone management. Fetched before the modal
  // opens (rather than into a loading skeleton inside it) because there is
  // no natural single "submit" here — five milestones, each with its own
  // Save and its own photo upload — so the modal is built once with real
  // data, the same reason allocateOverpaymentModal() fetches first too.
  async function openMilestonesModal(projectId, projectName) {
    var milestones = await api('/projects/' + projectId + '/milestones');

    var panel = R.modal({
      title: esc(projectName) + ' — Construction progress',
      wide: true,
      body: milestones.map(milestoneEditor).join(''),
      // No submitLabel — five independent Save buttons, not one shared
      // submit (see openAccountModal()'s own comment on this exact
      // pattern). The no-op onSubmit stops Enter in a date/number field
      // from silently closing the dialog.
      onSubmit: function () {},
    });

    wireMilestoneEditors(panel, projectId, projectName);
  }

  var CONTRACTOR_TYPES = ['foundation', 'roofing', 'finishing', 'electrical', 'plumbing', 'landscaping', 'other'];

  // SECTION 12 — contractors and their payment schedules for one project,
  // owner only. Same fetch-first, no-submitLabel shape as
  // openMilestonesModal above: several independent actions (add a
  // contractor, add a payment, mark one paid), not one shared submit.
  async function openContractorsModal(projectId, projectName) {
    var results = await Promise.all([
      api('/projects/' + projectId + '/contractors'),
      api('/projects/' + projectId + '/contractor-payments'),
    ]);
    var contractorList = results[0];
    var payments = results[1].payments;
    var forecast = results[1].forecast;

    var panel = R.modal({
      title: esc(projectName) + ' — Contractors',
      wide: true,
      body:
        (forecast.shortfall
          ? '<div class="notice mb-2">' + esc(forecast.shortfall.message) + '</div>'
          : '<div class="notice info mb-2">No projected shortfall at the current collection rate '
            + '(' + esc(nairaShort(forecast.avg_monthly_collection)) + '/month average, last 3 months).</div>') +

        '<div class="page-sub label-caps mb-1">Contractors</div>' +
        (contractorList.length
          ? contractorList.map(function (c) {
              return '<div class="flex-row justify-between gap-10 mb-1">' +
                '<span>' + esc(c.name) + ' <span class="page-sub">(' + esc(c.type) + ')</span></span>' +
                '<span class="page-sub">' + esc(c.phone || '') + '</span>' +
              '</div>';
            }).join('')
          : '<p class="muted mb-2">No contractors added yet.</p>') +
        '<div class="field-row mt-1">' +
          '<div class="field"><label for="ct-name">Contractor name</label><input class="input" id="ct-name" name="ct_name"></div>' +
          '<div class="field"><label for="ct-type">Trade</label><select class="select" id="ct-type" name="ct_type">' +
            CONTRACTOR_TYPES.map(function (t) { return '<option value="' + t + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>'; }).join('') +
          '</select></div>' +
        '</div>' +
        '<div class="field"><label for="ct-phone">Phone</label><input class="input" id="ct-phone" name="ct_phone"></div>' +
        '<button class="btn-quiet mb-2" type="button" id="btn-add-contractor">Add contractor</button>' +

        '<div class="divider"></div>' +
        '<div class="page-sub label-caps mb-1 mt-1">Payment schedule</div>' +
        (payments.length
          ? payments.map(function (p) {
              return '<div class="drawer-section">' +
                '<div class="flex-row justify-between gap-10">' +
                  '<span>' + esc(p.re_contractors ? p.re_contractors.name : '') + '</span>' + badge(p.status) +
                '</div>' +
                '<div class="page-sub mt-1">' + esc(naira(p.amount)) + ' due ' + esc(fmtDate(p.due_date)) +
                  (p.description ? ' — ' + esc(p.description) : '') + '</div>' +
                (p.status !== 'paid'
                  ? '<button class="btn-quiet mt-1" data-mark-paid="' + esc(p.id) + '">Mark paid</button>'
                  : '<div class="page-sub mt-1">Paid ' + esc(fmtDate(p.paid_date)) + '</div>') +
              '</div>';
            }).join('')
          : '<p class="muted mb-2">No payments scheduled yet.</p>') +
        '<div class="field-row mt-1">' +
          '<div class="field"><label for="cp-contractor">Contractor</label><select class="select" id="cp-contractor" name="cp_contractor">' +
            options(contractorList, 'id', 'name') +
          '</select></div>' +
          '<div class="field"><label for="cp-amount">Amount</label><div class="input-money"><input class="input" id="cp-amount" name="cp_amount" type="number" min="1" step="1"></div></div>' +
        '</div>' +
        '<div class="field"><label for="cp-due">Due date</label><input class="input" id="cp-due" name="cp_due" type="date"></div>' +
        '<div class="field"><label for="cp-desc">Description</label><input class="input" id="cp-desc" name="cp_desc"></div>' +
        (contractorList.length
          ? '<button class="btn-quiet" type="button" id="btn-add-payment">Schedule payment</button>'
          : '<p class="field-hint">Add a contractor first.</p>'),
      onSubmit: function () {},
    });

    R.onClick(panel.root, '#btn-add-contractor', async function () {
      var name = R.qs('#ct-name', panel.root).value.trim();
      var type = R.qs('#ct-type', panel.root).value;
      var phone = R.qs('#ct-phone', panel.root).value.trim();
      if (!name) throw new Error('Enter a contractor name.');
      await api.post('/projects/' + projectId + '/contractors', { name: name, type: type, phone: phone || null });
      panel.close();
      toast('Contractor added.', 'ok');
      openContractorsModal(projectId, projectName);
    });

    R.onClick(panel.root, '#btn-add-payment', async function () {
      var v = {
        contractor_id: R.qs('#cp-contractor', panel.root).value,
        amount: Number(R.qs('#cp-amount', panel.root).value),
        due_date: R.qs('#cp-due', panel.root).value,
        description: R.qs('#cp-desc', panel.root).value.trim() || null,
      };
      if (!v.amount || !v.due_date) throw new Error('Amount and due date are required.');
      await api.post('/projects/' + projectId + '/contractor-payments', v);
      panel.close();
      toast('Payment scheduled.', 'ok');
      openContractorsModal(projectId, projectName);
    });

    R.onClick(panel.root, '[data-mark-paid]', async function (button) {
      await api.patch('/contractor-payments/' + button.dataset.markPaid, { status: 'paid' });
      panel.close();
      toast('Marked paid.', 'ok');
      openContractorsModal(projectId, projectName);
    });
  }

  // SECTION 13 — moderating one project's community: read every post (staff
  // sees exactly what a buyer sees, plus Pin/Remove), owner/sales_director
  // only (community.moderate). "No buyer can see another buyer's personal
  // financial details" — this reuses the identical listPosts shape the
  // portal itself renders, which never carries one.
  async function openCommunityModerationModal(projectId, projectName) {
    var posts = await api('/community/' + projectId);

    var panel = R.modal({
      title: esc(projectName) + ' — Community',
      wide: true,
      cancelLabel: 'Close',
      body: posts.length
        ? posts.map(function (p) {
            return '<div class="drawer-section">' +
              '<div class="flex-row justify-between gap-10">' +
                '<span>' + (p.pinned ? badge('pinned') + ' ' : '') + '<b>' + esc(p.author_name) + '</b></span>' +
                '<span class="page-sub nowrap">' + esc(fmtDate(p.created_at)) + '</span>' +
              '</div>' +
              '<div class="mt-1">' + esc(p.content) + '</div>' +
              (p.replies.length
                ? '<div class="mt-1 community-replies">' + p.replies.map(function (r) {
                    return '<div class="mt-1"><b class="fs-12">' + esc(r.author_name) + '</b> ' + esc(r.content) + '</div>';
                  }).join('') + '</div>'
                : '') +
              '<div class="btn-row mt-1">' +
                '<button class="btn-quiet" data-community-pin="' + esc(p.id) + '" data-pinned="' + (p.pinned ? '0' : '1') + '">' +
                  (p.pinned ? 'Unpin' : 'Pin') + '</button>' +
                '<button class="btn-quiet" data-community-remove="' + esc(p.id) + '">Remove</button>' +
              '</div>' +
            '</div>';
          }).join('')
        : '<p class="muted">No posts yet.</p>',
      onSubmit: function () {},
    });

    R.onClick(panel.root, '[data-community-pin]', async function (button) {
      await api.patch('/community/post/' + button.dataset.communityPin + '/pin', { pinned: button.dataset.pinned === '1' });
      panel.close();
      openCommunityModerationModal(projectId, projectName);
    });
    R.onClick(panel.root, '[data-community-remove]', async function (button) {
      var confirmed = await R.confirm({
        title: 'Remove this post?',
        message: 'This removes the post (and any replies stay attached to it) from the community. It can be restored from the database only.',
        confirmLabel: 'Remove',
        danger: true,
      });
      if (!confirmed) return;
      await api('/community/post/' + button.dataset.communityRemove, { method: 'DELETE' });
      panel.close();
      toast('Post removed.', 'ok');
      openCommunityModerationModal(projectId, projectName);
    });
  }

  function milestoneEditor(m) {
    var photos = Array.isArray(m.photos) ? m.photos : [];
    return '<div class="milestone-editor mb-3" data-milestone-row="' + esc(m.id) + '">' +
      '<div class="flex-row justify-between align-start">' +
        '<div class="cell-primary">' + esc(m.name) + '</div>' +
        badge(m.status) +
      '</div>' +
      '<div class="field-row mt-1">' +
        '<div class="field"><label>Target date</label>' +
          '<input class="input" type="date" data-field="target_date" value="' + esc(m.target_date || '') + '"></div>' +
        '<div class="field"><label>Completion %</label>' +
          '<input class="input" type="number" min="0" max="100" data-field="completion_percentage" value="' + esc(m.completion_percentage) + '"></div>' +
      '</div>' +
      (photos.length
        ? '<div class="milestone-photos mt-1">' + photos.map(function (p) {
            return '<img class="milestone-thumb" src="' + esc(p.url) + '" alt="' + esc(m.name) + ' photo">';
          }).join('') + '</div>'
        : '') +
      '<div class="flex-row gap-8 mt-1">' +
        '<button class="btn-quiet" type="button" data-save-milestone="' + esc(m.id) + '">Save</button>' +
        (photos.length < 10
          ? '<button class="btn-quiet" type="button" data-pick-photo="' + esc(m.id) + '">Add photo</button>' +
            '<input type="file" class="hidden" data-photo-file="' + esc(m.id) + '" accept="image/jpeg,image/png,image/webp" multiple>'
          : '<span class="page-sub">10 photos — the most this milestone can hold</span>') +
      '</div>' +
    '</div>';
  }

  // The modal lives in its own overlay outside #view (see realestate.js's
  // modal()), so R.reload() — which only re-renders the Projects screen
  // behind it — would leave the open dialog showing stale data after a
  // save or an upload. Closing and reopening with a fresh fetch is the
  // straightforward way to keep the two in sync; the Projects list behind
  // it also gets a reload so its own state (nothing today, but future
  // fields might) is not left stale either.
  function wireMilestoneEditors(panel, projectId, projectName) {
    var root = panel.root;

    R.qsa('[data-save-milestone]', root).forEach(function (button) {
      button.addEventListener('click', async function () {
        var row = button.closest('[data-milestone-row]');
        var milestoneId = button.dataset.saveMilestone;
        var payload = {
          target_date: R.qs('[data-field="target_date"]', row).value || null,
          completion_percentage: Number(R.qs('[data-field="completion_percentage"]', row).value || 0),
        };
        button.disabled = true;
        try {
          await api.patch('/projects/' + projectId + '/milestones/' + milestoneId, payload);
          toast(
            payload.completion_percentage === 100
              // A milestone reaching 100% notifies every buyer in the
              // project — worth a clear beat rather than folding into a
              // generic "saved" toast.
              ? 'Milestone saved — buyers in this project are being notified.'
              : 'Milestone saved.',
            'ok'
          );
          panel.close();
          openMilestonesModal(projectId, projectName);
        } catch (err) {
          toast(err.message, 'err');
          button.disabled = false;
        }
      });
    });

    R.qsa('[data-pick-photo]', root).forEach(function (button) {
      button.addEventListener('click', function () {
        R.qs('[data-photo-file="' + button.dataset.pickPhoto + '"]', root).click();
      });
    });

    R.qsa('[data-photo-file]', root).forEach(function (input) {
      input.addEventListener('change', async function () {
        var files = Array.prototype.slice.call(input.files || []);
        if (!files.length) return;
        var milestoneId = input.dataset.photoFile;

        var photos = [];
        for (var i = 0; i < files.length; i++) {
          var file = files[i];
          if (file.size > 6 * 1024 * 1024) {
            toast(file.name + ' is larger than 6MB — skipped.', 'err');
            continue;
          }
          var base64 = await new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result).split(',')[1]); };
            reader.onerror = function () { reject(new Error('could not be read')); };
            reader.readAsDataURL(file);
          });
          photos.push({ content: base64, content_type: file.type });
        }
        input.value = '';
        if (!photos.length) return;

        try {
          await api.post('/projects/' + projectId + '/milestones/' + milestoneId + '/photos', { photos: photos });
          toast('Photo' + (photos.length > 1 ? 's' : '') + ' added.', 'ok');
          panel.close();
          openMilestonesModal(projectId, projectName);
        } catch (err) {
          toast(err.message, 'err');
        }
      });
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
                (canWrite
                  ? '<button class="btn-quiet" data-edit-unit="' + esc(u.id) + '">Edit details</button> '
                  : '') +
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
                emptyTitle: 'No units added yet.',
                emptyHint: 'Add them one at a time, in bulk, or import a CSV.',
                emptyAction: '<button class="btn primary" id="btn-empty-unit">Add unit</button>',
                emptyIcon: 'building',
              }
            // A read-only role's own screen has no Add/Import buttons — telling
            // them how to add units their screen doesn't let them add is a
            // dead end, not a hint.
            : { emptyTitle: 'No units added yet.', emptyHint: 'Units will appear here once your team adds them.', emptyIcon: 'building' }
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

      R.qsa('[data-edit-unit]', view).forEach(function (button) {
        button.addEventListener('click', function () {
          var unit = units.find(function (u) { return u.id === button.dataset.editUnit; });
          editUnitModal(unit);
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

    // SECTION 6 — grouped by kind rather than one flat grid, so "which of
    // these is the brochure?" is answered by which section it's in, not by
    // reading every label. Site map keeps its own group too — the four kinds
    // routes/units.js already accepts (unchanged), just no longer mixed
    // together on screen.
    var mediaGroups = [
      ['floor_plan', 'Floor plans'], ['photo', 'Unit photos'], ['brochure', 'Brochure'], ['site_map', 'Site maps'],
    ];

    function mediaGrid(kind) {
      var items = media.filter(function (m) { return m.kind === kind; });
      if (!items.length) return '';
      return items.map(function (m) {
        var isPdf = /\.pdf$/i.test(m.url);
        return '<a class="card media-card" href="' + esc(m.url) + '" target="_blank" rel="noopener">' +
          (isPdf
            ? '<div class="media-thumb-icon">▤</div>'
            : '<img src="' + esc(m.url) + '" alt="' + esc(m.label || m.kind) + '" class="media-thumb-img">') +
          '<div class="card-body media-card-body">' +
            '<div class="fs-12">' + esc(m.label || String(m.kind).replace(/_/g, ' ')) + '</div>' +
            '<div class="cell-meta">' + esc(fmtDate(m.uploaded_at)) + '</div>' +
          '</div></a>';
      }).join('');
    }

    R.modal({
      title: 'Unit ' + unit.unit_number + ' — floor plans, photos and brochure',
      wide: true,
      body:
        (media.length
          ? mediaGroups.map(function (g) {
              var grid = mediaGrid(g[0]);
              return grid ? '<div class="page-sub label-caps mb-1">' + g[1] + '</div><div class="grid cols-3 mb-2">' + grid + '</div>' : '';
            }).join('')
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

  // SECTION 6 — the rich-profile fields (bedrooms, bathrooms, parking,
  // floor, furnishing) plus the price/type fields unitModal only ever set
  // at creation. Owner/sales_director only — the button that opens this is
  // itself hidden from anyone else (see R.screens.units above, canWrite).
  var FURNISHING_OPTIONS = [
    ['unfurnished', 'Unfurnished'], ['semi-furnished', 'Semi-furnished'], ['fully-furnished', 'Fully furnished'],
  ];

  function editUnitModal(unit) {
    R.modal({
      title: 'Edit unit ' + unit.unit_number,
      wide: true,
      body:
        '<div class="field-row">' +
          '<div class="field"><label for="eu-type">Type</label>' +
            '<input class="input" id="eu-type" name="unit_type" value="' + esc(unit.unit_type || '') + '" placeholder="3-bed terrace"></div>' +
          '<div class="field"><label for="eu-size">Size (m²)</label>' +
            '<input class="input" id="eu-size" name="size_sqm" type="number" min="0" step="0.1" value="' + esc(unit.size_sqm || '') + '"></div>' +
        '</div>' +
        '<div class="field"><label for="eu-price">List price</label>' +
          '<div class="input-money"><input class="input" id="eu-price" name="list_price" type="number" min="1" step="1" required value="' + esc(unit.list_price || '') + '"></div></div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="eu-bed">Bedrooms</label>' +
            '<input class="input" id="eu-bed" name="bedrooms" type="number" min="0" step="1" value="' + esc(unit.bedrooms ?? '') + '"></div>' +
          '<div class="field"><label for="eu-bath">Bathrooms</label>' +
            '<input class="input" id="eu-bath" name="bathrooms" type="number" min="0" step="1" value="' + esc(unit.bathrooms ?? '') + '"></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="eu-parking">Parking spaces</label>' +
            '<input class="input" id="eu-parking" name="parking_spaces" type="number" min="0" step="1" value="' + esc(unit.parking_spaces ?? '') + '"></div>' +
          '<div class="field"><label for="eu-floor">Floor level</label>' +
            '<input class="input" id="eu-floor" name="floor_level" type="number" step="1" value="' + esc(unit.floor_level ?? '') + '" placeholder="0 = ground floor"></div>' +
        '</div>' +
        '<div class="field"><label for="eu-furnishing">Furnishing</label>' +
          '<select class="select" id="eu-furnishing" name="furnishing_status">' +
            options(FURNISHING_OPTIONS.map(function (f) { return { id: f[0], name: f[1] }; }), 'id', 'name', unit.furnishing_status || 'unfurnished') +
          '</select></div>' +
        '<div class="field"><label for="eu-desc">Description</label>' +
          '<textarea class="input" id="eu-desc" name="description" rows="3" placeholder="A short description a buyer would read">' + esc(unit.description || '') + '</textarea></div>',
      submitLabel: 'Save',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        await api.patch('/units/' + unit.id, {
          unit_type: v.unit_type || null,
          size_sqm: v.size_sqm,
          list_price: v.list_price,
          bedrooms: v.bedrooms,
          bathrooms: v.bathrooms,
          parking_spaces: v.parking_spaces,
          floor_level: v.floor_level,
          furnishing_status: v.furnishing_status,
          description: v.description || null,
        });
        close();
        toast('Unit details updated.', 'ok');
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

  // SECTION 3 — mirrors src/services/creditScoreService.js's tier() exactly
  // (80/60/40 breakpoints, same reasoning there for reusing moss on both
  // of the top two tiers rather than inventing a fourth colour this
  // product's palette does not otherwise have).
  function creditTier(score) {
    if (score == null) return null;
    if (score >= 80) return { key: 'excellent', label: 'Excellent' };
    if (score >= 60) return { key: 'good', label: 'Good' };
    if (score >= 40) return { key: 'fair', label: 'Fair' };
    return { key: 'at_risk', label: 'At risk' };
  }

  function creditBadge(score) {
    var t = creditTier(score);
    if (!t) return '<span class="page-sub">—</span>';
    return '<span class="badge credit-' + t.key + '">' + score + ' · ' + esc(t.label) + '</span>';
  }

  // FEATURE — buyer sentiment analysis. A colored dot plus the label, per
  // the product spec's own wording — green/positive, grey/neutral,
  // amber/concerned, red/at-risk.
  var SENTIMENT_META = {
    positive: ['sentiment-positive', 'Positive'],
    neutral: ['sentiment-neutral', 'Neutral'],
    concerned: ['sentiment-concerned', 'Concerned'],
    at_risk: ['sentiment-at-risk', 'At-risk'],
  };
  function sentimentIndicator(value) {
    var meta = SENTIMENT_META[value];
    if (!meta) return '';
    return '<div class="page-sub mb-2"><span class="sentiment-dot ' + meta[0] + '"></span> Sentiment: ' + meta[1] + '</div>';
  }

  // FEATURE — dynamic reminder timing. Mirrors
  // contactTimingService.describeOptimalContact server-side exactly (same
  // day labels, same morning/afternoon/evening buckets) — a display-only
  // computation from two numbers the API already sends, not worth its own
  // round trip.
  var CONTACT_DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  function optimalContactHint(c) {
    if (c.optimal_contact_day == null || c.optimal_contact_hour == null) return null;
    var part = c.optimal_contact_hour < 12 ? 'mornings' : c.optimal_contact_hour < 17 ? 'afternoons' : 'evenings';
    return CONTACT_DAY_LABELS[c.optimal_contact_day] + ' ' + part;
  }

  R.screens.customers = {
    render: async function (view, params, query) {
      // #/customers/<id> opens the buyer straight from a search result.
      // The id stays in the hash while the drawer is open — so the URL is
      // linkable/shareable and Back behaves — and is only rewritten to the
      // bare list route once the drawer actually closes (see openCustomer).
      if (params[0]) { openCustomer(params[0]); return; }

      var search = query.q || '';
      var customers = await api('/customers' + (search ? '?search=' + encodeURIComponent(search) : ''));
      // null for Documentation (server-side stripped, same as any amount) —
      // the filter row only draws once there is a real score to filter by.
      var scoresVisible = customers.some(function (c) { return c.credit_score != null; });
      var creditFilter = query.credit || '';
      var blacklistFilter = false;
      var page = 1;
      // SECTION 4 — bulk actions. id -> true, so re-rendering (a filter
      // click, a page change) doesn't lose a selection made on an earlier
      // page — cleared only by leaving this screen entirely, same lifetime
      // as projectFilter/leaderboardSort above.
      var selected = {};
      var canExportSelected = R.can('reports.export');
      var canBulkWaive = R.can('payments.waive');
      var canBulkPortalLink = R.can('customers.bulkPortalLink');
      var canBlacklist = R.can('customers.blacklist');

      function selectedIds() { return Object.keys(selected).filter(function (id) { return selected[id]; }); }
      function selectedCustomers() {
        var ids = selectedIds();
        return customers.filter(function (c) { return ids.indexOf(c.id) >= 0; });
      }

      function renderPage() {
        var filtered = customers.filter(function (c) {
          if (creditFilter) {
            var t = creditTier(c.credit_score);
            if (!t || t.key !== creditFilter) return false;
          }
          if (blacklistFilter && !c.blacklisted) return false;
          return true;
        });

        var p = paginate(filtered, CUSTOMERS_PER_PAGE, page);
        page = p.page;
        var ids = selectedIds();
        var pageIds = p.slice.map(function (c) { return c.id; });
        var allOnPageSelected = pageIds.length > 0 && pageIds.every(function (id) { return selected[id]; });

        view.innerHTML =
          head('Buyers', R.plural(filtered.length, 'buyer') + (search ? ' matching “' + search + '”' : ''),
            '<button class="btn" id="btn-export-buyers">Export CSV</button>' +
            '<button class="btn" id="btn-import-buyers">Import CSV</button>' +
            '<button class="btn primary" id="btn-new-buyer">Add buyer</button>') +

          '<div class="filter-row">' +
            (scoresVisible
              ? [['', 'All'], ['excellent', 'Excellent'], ['good', 'Good'], ['fair', 'Fair'], ['at_risk', 'At risk']]
                  .map(function (t) {
                    return '<button class="pill' + (creditFilter === t[0] ? ' is-on' : '') + '" data-credit-filter="' + t[0] + '">' + t[1] + '</button>';
                  }).join('')
              : '') +
            // SECTION 7 — a plain toggle pill, not a fifth credit tier: a
            // buyer can be blacklisted at any credit score, so this filters
            // independently of, not alongside, the tier pills above.
            '<button class="pill' + (blacklistFilter ? ' is-on' : '') + '" data-blacklist-filter>Blacklisted</button>' +
          '</div>' +

          // SECTION 4 — only shown once something IS selected, above the
          // table it acts on. Send WhatsApp has no permission gate (every
          // role that can see this screen may message a buyer); the other
          // three each check the tier the spec calls for.
          (ids.length
            ? '<div class="bulk-action-bar">' +
                '<span class="bulk-count">' + R.plural(ids.length, 'buyer') + ' selected</span>' +
                '<div class="btn-row">' +
                  '<button class="btn-quiet" id="btn-bulk-whatsapp">Send WhatsApp</button>' +
                  (canExportSelected ? '<button class="btn-quiet" id="btn-bulk-export">Export selected</button>' : '') +
                  (canBulkPortalLink ? '<button class="btn-quiet" id="btn-bulk-portal">Send portal link</button>' : '') +
                  (canBulkWaive ? '<button class="btn danger" id="btn-bulk-waive">Bulk waive next overdue</button>' : '') +
                  '<button class="btn-quiet" id="btn-bulk-clear">Clear</button>' +
                '</div>' +
              '</div>'
            : '') +

          card(null, table(
            [{ label: '<input type="checkbox" id="select-all-buyers"' + (allOnPageSelected ? ' checked' : '') + '>', raw: true },
              { label: 'Name' }, { label: 'Phone' }, { label: 'Email', hideMobile: true },
              { label: 'Source', hideMobile: true }, { label: 'Added', hideMobile: true },
              { label: 'Credit score', hideMobile: true }, { label: '' }],
            p.slice,
            function (c) {
              return '<tr class="is-clickable" data-open="' + esc(c.id) + '">' +
                '<td data-stop><input type="checkbox" class="row-select" data-select="' + esc(c.id) + '"' +
                  (selected[c.id] ? ' checked' : '') + '></td>' +
                '<td class="cell-primary">' + esc(c.full_name) +
                  (c.blacklisted ? ' ' + badge('blacklisted') : '') + '</td>' +
                '<td class="mono muted">' + esc(c.phone || '—') + '</td>' +
                '<td class="muted hide-mobile">' + esc(c.email || '—') + '</td>' +
                '<td class="muted hide-mobile">' + esc(c.source || '—') + '</td>' +
                '<td class="muted hide-mobile">' + esc(fmtDate(c.created_at)) + '</td>' +
                '<td class="hide-mobile">' + creditBadge(c.credit_score) + '</td>' +
                // data-stop keeps the row's own click handler from firing and
                // opening the drawer behind the confirmation/checkbox.
                '<td class="right">' + (R.can('recycle.delete')
                  ? '<button class="btn-quiet" data-stop data-delete-customer="' + esc(c.id) +
                    '" data-label="' + esc(c.full_name) + '">Delete</button>'
                  : '') + '</td>' +
              '</tr>';
            },
            {
              emptyTitle: search ? 'Nobody matched that' : creditFilter ? 'Nobody in this tier' : blacklistFilter ? 'No blacklisted buyers' : 'No buyers yet.',
              emptyHint: search ? 'Try a phone number or part of a surname.' : 'Add them one at a time, or import the list you already have.',
              // Only the genuinely-empty-account case gets the icon and CTA —
              // "no buyers yet" and "no buyers matched this search" are
              // different problems, and "Import buyers" is not the answer
              // to the second one.
              emptyIcon: (!search && !creditFilter && !blacklistFilter) ? 'person' : undefined,
              emptyAction: (!search && !creditFilter && !blacklistFilter)
                ? '<button class="btn primary" id="btn-empty-import-buyers">Import buyers</button>' : undefined,
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

        R.qsa('[data-credit-filter]', view).forEach(function (btn) {
          btn.addEventListener('click', function () {
            creditFilter = btn.dataset.creditFilter;
            page = 1;
            renderPage();
          });
        });

        var blacklistPill = R.qs('[data-blacklist-filter]', view);
        if (blacklistPill) {
          blacklistPill.addEventListener('click', function () {
            blacklistFilter = !blacklistFilter;
            page = 1;
            renderPage();
          });
        }

        // SECTION 4 — every checkbox click just flips `selected` and
        // re-renders; the whole bar (and the header checkbox's own state)
        // is derived from that one object, so there is nowhere else for
        // selection state to drift out of sync.
        R.qsa('[data-select]', view).forEach(function (box) {
          box.addEventListener('click', function (event) {
            event.stopPropagation();
            selected[box.dataset.select] = box.checked;
            renderPage();
          });
        });
        var selectAll = R.qs('#select-all-buyers', view);
        if (selectAll) {
          selectAll.addEventListener('click', function () {
            pageIds.forEach(function (id) { selected[id] = selectAll.checked; });
            renderPage();
          });
        }

        R.qs('#btn-new-buyer', view).addEventListener('click', customerModal);
        // importCustomersModal now fetches its own Project list before
        // opening — R.onClick gives that fetch a spinner and a toast if it
        // fails, which a bare addEventListener wouldn't for an async handler.
        R.onClick(view, '#btn-import-buyers', importCustomersModal);
        R.onClick(view, '#btn-empty-import-buyers', importCustomersModal);
        R.onClick(view, '#btn-export-buyers', async function () {
          await R.downloadCsv('/reports/export/customers', 'archta-buyers.csv');
          toast('Exported. Check your downloads.', 'ok');
        });

        R.onClick(view, '#btn-bulk-clear', function () {
          selected = {};
          renderPage();
        });

        R.onClick(view, '#btn-bulk-whatsapp', function () {
          bulkWhatsAppModal(selectedCustomers());
        });

        R.onClick(view, '#btn-bulk-export', async function () {
          await R.downloadCsv('/reports/export/customers?ids=' + selectedIds().join(','), 'archta-buyers-selected.csv');
          toast('Exported. Check your downloads.', 'ok');
        });

        R.onClick(view, '#btn-bulk-portal', async function () {
          var ids2 = selectedIds();
          var confirmed = await R.confirm({
            title: 'Send portal link to ' + R.plural(ids2.length, 'buyer') + '?',
            message: 'Emails a personal payment-account link to every selected buyer who has an email on file. Buyers with no email are skipped.',
            confirmLabel: 'Send',
          });
          if (!confirmed) return;
          var result = await api.post('/customers/bulk-portal-link', { customer_ids: ids2 });
          toast(result.sent + ' portal link(s) sent' +
            (result.skipped_no_email ? ', ' + result.skipped_no_email + ' skipped (no email)' : '') + '.', 'ok');
        });

        R.onClick(view, '#btn-bulk-waive', async function () {
          await bulkWaiveModal(selectedIds(), function () {
            selected = {};
            renderPage();
          });
        });

        var prev = R.qs('[data-page-prev]', view);
        if (prev) prev.addEventListener('click', function () { page -= 1; renderPage(); });
        var next = R.qs('[data-page-next]', view);
        if (next) next.addEventListener('click', function () { page += 1; renderPage(); });
      }

      renderPage();
    },
  };

  // SECTION 4 — bulk WhatsApp. Real anchor clicks, one per buyer, same as
  // every other WhatsApp link in this app (see the module doc's own note on
  // R.openFile/popup blockers) — a rep clicks each one themselves rather
  // than the app trying to auto-sequence window.open calls, which a phone's
  // popup blocker would drop for every buyer after the first anyway. A
  // drafted per-buyer message (from the daily brief) is Section 15's job on
  // the dashboard; this is the plain, always-available generic version.
  var BULK_WHATSAPP_GENERIC_MESSAGE = 'Hi, this is a quick check-in about your account with us. Please reach out if you have any questions.';
  function bulkWhatsAppModal(buyers) {
    R.modal({
      title: 'Send WhatsApp to ' + R.plural(buyers.length, 'buyer'),
      body:
        '<p class="page-sub mb-2">Click each buyer to open their WhatsApp chat with a pre-filled message.</p>' +
        '<div class="btn-row">' +
          buyers.map(function (c) {
            var link = R.waLink(c.phone);
            if (!link) return '<span class="btn-quiet" title="No valid phone number">' + esc(c.full_name) + ' (no phone)</span>';
            return '<a class="btn-quiet" target="_blank" rel="noopener" href="' + link +
              '&text=' + encodeURIComponent(BULK_WHATSAPP_GENERIC_MESSAGE) + '">' + esc(c.full_name) + '</a>';
          }).join('') +
        '</div>',
    });
  }

  // SECTION 4 — bulk waive. Two-step: a dry run shows the reps exactly what
  // they are about to write off before the confirmation form even appears
  // (imports.js's own preview-then-commit shape), so "how much money is
  // this" is answered before the reason field is filled in, not after.
  async function bulkWaiveModal(customerIds, onDone) {
    var preview = await api.post('/payments/bulk-waive-next-overdue', { customer_ids: customerIds, dry_run: true });
    if (!preview.rows.length) {
      toast('None of the selected buyers have an overdue installment to waive.', 'err');
      return;
    }
    R.modal({
      title: 'Bulk waive next overdue installment',
      body:
        '<p class="page-sub mb-2">This waives the next overdue installment for ' + R.plural(preview.rows.length, 'buyer') +
          ', totalling <b>' + esc(naira(preview.total_amount)) + '</b>.' +
          (preview.skipped_count ? ' ' + R.plural(preview.skipped_count, 'buyer') + ' with no overdue installment will be skipped.' : '') +
        '</p>' +
        '<div class="mb-2">' + preview.rows.map(function (r) {
          return '<div class="flex-row justify-between gap-10 mb-1"><span>' + esc(r.buyer_name) + '</span><span class="mono">' + esc(naira(r.amount)) + '</span></div>';
        }).join('') + '</div>' +
        '<div class="field"><label for="bw-reason">Reason</label>' +
          '<textarea class="textarea" id="bw-reason" name="reason" required rows="2" placeholder="Why are these being waived?"></textarea></div>',
      submitLabel: 'Waive ' + naira(preview.total_amount),
      onSubmit: async function (form, close) {
        var v = R.values(form);
        if (!v.reason) throw new Error('A reason is required.');
        var result = await api.post('/payments/bulk-waive-next-overdue', {
          customer_ids: customerIds, reason: v.reason, dry_run: false,
        });
        close();
        toast(result.waived_count + ' installment(s) waived, ' + naira(result.total_amount) + ' total.', 'ok');
        onDone();
      },
    });
  }

  function customerModal() {
    // Design item 5 — sectioned per the brief's own Add Buyer breakdown
    // (Personal Details / Property / Payment Plan / Assignment), but only
    // Personal Details actually exists as fields on this specific modal —
    // property, plan and rep assignment happen afterwards, in the New
    // Reservation flow (reservationModal, below), a genuinely separate
    // step in this product: a buyer record can exist with no unit, no
    // plan and no rep at all. Adding those three sections here with
    // nothing in them would mean inventing fields this form has never had.
    R.modal({
      title: 'Add a buyer',
      body: formSection('Personal Details',
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
          '</select></div>' +
        // SECTION 5 — a DIFFERENT thing from the "How did they find you?"
        // dropdown above: this is another buyer's actual referral_code,
        // which links referred_by_customer_id and opens the referral
        // reward workflow. Optional and separate on purpose — "referral"
        // as a source is just a label; a code is a specific person who
        // gets credit.
        '<div class="field"><label for="c-referral">Referred by (code, optional)</label>' +
          '<input class="input input-uppercase" id="c-referral" name="referral_code" placeholder="e.g. 7K2QX9LM"></div>'),
      submitLabel: 'Add buyer',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        if (!v.full_name) throw new Error('A name is required.');
        if (!v.referral_code) delete v.referral_code;

        // SECTION 14 — a Sales Executive with no signal still gets "saved",
        // queued in IndexedDB for the next reconnect, rather than a network
        // error on a form they may have just spent five minutes filling in
        // on a site visit. Every other role gets the ordinary error.
        var result = await R.offlineQueue.submitOrQueue('new_buyer', '/customers', v);
        close();
        toast(result.queued ? 'No connection — buyer saved and will sync automatically.' : 'Buyer added.', 'ok');
        if (!result.queued) R.reload();
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
      var canSeeMessages = R.can('messages.read');
      // SECTION 16 — same tier as logging a call (activities.write), so
      // whoever can already see the Activity section below can see this too.
      var canScheduleMessages = R.can('activities.write');
      var results = await Promise.all([
        api('/customers/' + id),
        api('/customers/' + id + '/activities'),
        canSeeMessages ? api('/customers/' + id + '/messages') : Promise.resolve([]),
        canScheduleMessages ? api('/scheduled-messages?customer_id=' + id) : Promise.resolve([]),
      ]);
      var c = results[0];
      var activities = results[1];
      var thread = results[2];
      var scheduledMessages = results[3];
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
        // SECTION 3 — null for Documentation (server-side stripped, same as
        // any amount on this drawer) rather than a fourth "no data" state.
        (c.credit_score != null
          ? '<div class="mb-2">' + creditBadge(c.credit_score) + '</div>'
          : '') +

        // FEATURE — buyer sentiment analysis. Null until this buyer has
        // sent at least one portal message or WhatsApp reply — nothing
        // renders rather than a "no signal yet" placeholder, same
        // convention the contact-timing hint just below already follows.
        (sentimentIndicator(c.latest_sentiment)) +

        // FEATURE — dynamic reminder timing. Null until at least 3 payments
        // exist (contactTimingService's own threshold) — nothing renders
        // rather than a "no pattern yet" placeholder nobody asked for.
        (optimalContactHint(c)
          ? '<p class="page-sub mb-2">Best time to reach — ' + esc(optimalContactHint(c)) + '</p>'
          : '') +

        // SECTION 7 — the badge on the Buyers row is a glance; this is the
        // reason, front and center every time someone opens this specific
        // buyer, since forgetting WHY somebody was blacklisted is how a
        // blacklist stops being trusted.
        (c.blacklisted
          ? '<div class="notice mb-2">Blacklisted' + (c.blacklist_reason ? ' — ' + esc(c.blacklist_reason) : '') + '</div>'
          : '') +

        // A credit from an overpayment that nobody has allocated yet stays
        // visible every time this drawer is opened, not just in the moment it
        // happened — otherwise it is forgotten the instant the drawer closes.
        (credit
          ? '<div class="notice warn" id="d-credit-notice">Unallocated credit of ' + esc(naira(credit.amount)) +
              ' — tap to allocate</div>'
          : '') +

        // FEATURE — hardship request count, owner/sales_director only (the
        // server only ever includes hardship_requests for that tier — see
        // routes/customers.js).
        (c.hardship_requests
          ? '<div class="notice ' + (c.hardship_requests.pending ? 'warn' : 'info') + ' mb-2" id="d-hardship-notice">' +
              R.plural(c.hardship_requests.total, 'hardship request') +
              (c.hardship_requests.pending ? ' — ' + R.plural(c.hardship_requests.pending, 'pending') + ', tap to review' : '') +
            '</div>'
          : '') +

        '<div class="grid cols-3">' +
          stat('Contracted', nairaShort(totalPlan)) +
          stat('Paid', nairaShort(totalPaid), { tone: 'moss' }) +
          stat('Overdue', nairaShort(overdue), { tone: overdue ? 'clay' : null }) +
        '</div>' +
        '<div class="mt-2"><div class="meter"><i data-w="' + pct + '"></i></div>' +
        '<div class="page-sub">' + pct + '% of the plan settled</div></div>' +

        '<div class="btn-row mt-2">' +
          (c.phone ? '<a class="btn-quiet" href="tel:' + esc(c.phone) + '" data-customer-id="' + esc(c.id) + '" data-customer-name="' + esc(c.full_name) + '">Call</a>' : '') +
          (R.waLink(c.phone) ? '<a class="btn-quiet" target="_blank" rel="noopener" href="' + esc(R.waLink(c.phone)) + '">WhatsApp</a>' : '') +
          // Two independent actions, not one button with a shared side effect.
          // Emailing and copying used to happen together — send_email was tied
          // to whether an email existed, so there was no way to hand a rep a
          // WhatsApp link without also silently emailing the buyer. Each button
          // below issues its OWN portal link and reports its OWN outcome.
          '<button class="btn-quiet" id="d-portal-email"' +
            (c.email ? '' : ' disabled title="Add buyer email first"') + '>Email link</button>' +
          '<button class="btn-quiet" id="d-portal-copy">Copy for WhatsApp</button>' +
          (canScheduleMessages
            ? '<button class="btn-quiet" id="d-schedule-message"' + (c.phone ? '' : ' disabled title="Add buyer phone first"') + '>Schedule message</button>'
            : '') +
          // SECTION 7 — owner only (permissions.js's customers.blacklist),
          // same tier as the routes themselves.
          (R.can('customers.blacklist')
            ? (c.blacklisted
                ? '<button class="btn-quiet" id="d-unblacklist">Unblacklist</button>'
                : '<button class="btn-quiet" id="d-blacklist">Blacklist buyer</button>')
            : '') +
        '</div>' +

        reservations.map(function (r) {
          var unit = r.re_units || {};
          var project = unit.re_projects || {};
          // A restructured or renewed reservation carries every plan it has
          // ever had (migrations/005's uniq_re_active_plan_per_reservation
          // allows exactly one ACTIVE one, but superseded ones stay in the
          // array forever) — Supabase gives no ordering guarantee on a nested
          // embed, so the summary above must pick the active one by status,
          // not by array position.
          var allPlans = asArray(r.re_installment_plans);
          var plan = allPlans.find(function (p) { return p.status === 'active'; }) || allPlans[0];
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
          var rep = r.re_sales_reps;
          var repName = rep && rep.users ? (rep.users.full_name || rep.users.email) : null;

          return '<div class="drawer-section">' +
            '<div class="flex-row justify-between gap-10">' +
              '<div><b>' + esc(unit.unit_number ? 'Unit ' + unit.unit_number : 'Reservation') + '</b>' +
              '<div class="page-sub">' + esc([project.name, project.location].filter(Boolean).join(', ')) + '</div></div>' +
              badge(r.status) +
              // FEATURE — joint sales.
              (asArray(r.re_joint_sales).length ? ' <span class="badge joint-sale">Joint sale</span>' : '') +
            '</div>' +
            (R.can('reservations.reassign')
              ? '<div class="page-sub mt-1">Rep: ' + esc(repName || 'Unassigned') +
                  ' <button class="btn-quiet" data-change-rep="' + esc(r.id) + '" data-rep-name="' + esc(repName || '') + '">Change rep</button></div>'
              : '') +
            (R.can('reservations.jointSale')
              ? '<div class="page-sub mt-1"><button class="btn-quiet" data-joint-sale="' + esc(r.id) +
                  '" data-buyer-name="' + esc(c.full_name) + '">' +
                  (asArray(r.re_joint_sales).length ? 'Edit joint sale' : 'Set up joint sale') + '</button></div>'
              : '') +
            (r.escalation_stage === 'legal' && R.can('legal.manage')
              ? '<div class="notice mt-1">Escalated to legal review. ' +
                  '<button class="btn-quiet" data-open-legal-case="' + esc(r.id) + '" data-customer-id="' + esc(c.id) +
                  '" data-name="' + esc(c.full_name) + '">Open legal case</button></div>'
              : '') +
            (r.status === 'completed' && R.can('handover.manage')
              ? '<div class="page-sub mt-1"><button class="btn-quiet" data-manage-handover="' + esc(r.id) +
                  '" data-buyer-name="' + esc(c.full_name) + '">Handover checklist</button></div>'
              : '') +
            (r.property_type === 'outright' && plan
              // FEATURE — outright sales. One amount, one row — the generic
              // "N installments" line and the paid-rows-collapse UI (built
              // for a buyer eighteen months into a real schedule) have
              // nothing to summarize here, so this is just the row itself.
              ? '<div class="page-sub mt-1">Outright sale · ' + naira(plan.total_amount) + '</div>' +
                '<div class="mt-1">' + schedule.map(scheduleRow).join('') + '</div>'
              : plan
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
            // SECTION 6 — plan history. Only shown once there IS a history:
            // a reservation on its first, never-restructured plan has one row
            // and nothing to compare it against. Newest first — the most
            // recent restructure is the one someone opening this just asked
            // "what changed" about.
            (allPlans.length > 1
              ? '<div class="mt-2"><button class="btn-quiet" data-toggle-plan-history="' + esc(r.id) + '">Show plan history (' + allPlans.length + ')</button></div>' +
                '<div class="hidden mt-1" data-plan-history="' + esc(r.id) + '">' +
                  allPlans.slice().sort(function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); })
                    .map(function (p) { return planHistoryRow(p); }).join('') +
                '</div>'
              : '') +
          '</div>';
        }).join('') +

        (reservations.length ? '' : '<div class="drawer-section">' +
          R.emptyState('No reservations yet', 'This buyer has not been allocated a unit.',
            '<button class="btn primary" id="d-reserve">Create a reservation</button>') + '</div>') +

        '<div class="drawer-section">' +
          '<div class="flex-row justify-between gap-10">' +
            '<b>Activity</b>' +
            (R.can('activities.write')
              ? '<button class="btn-quiet" id="d-log-activity">Log activity</button>' : '') +
          '</div>' +
          (activities.length
            ? '<div class="mt-1">' + activities.map(activityRow).join('') + '</div>'
            : '<p class="page-sub mt-1">No calls, visits or notes logged yet.</p>') +
        '</div>' +

        // SECTION 16 — shown only once there is something to show, same
        // convention as every other conditional section on this drawer.
        (canScheduleMessages && scheduledMessages.length
          ? '<div class="drawer-section"><b>Scheduled messages</b>' +
              '<div class="mt-1">' + scheduledMessages.map(scheduledMessageRow).join('') + '</div>' +
            '</div>'
          : '') +

        (canSeeMessages
          ? '<div class="drawer-section">' +
              '<b>Messages' +
              (thread.filter(function (m) { return m.sender_type === 'buyer' && !m.read_at; }).length
                ? ' <span class="badge clay">' + thread.filter(function (m) { return m.sender_type === 'buyer' && !m.read_at; }).length + ' unread</span>'
                : '') +
              '</b>' +
              '<div class="message-thread mt-1">' +
                (thread.length
                  ? thread.map(function (m) {
                      return '<div class="message-row ' + (m.sender_type === 'staff' ? 'mine' : 'theirs') + '">' +
                        '<div class="message-bubble">' + esc(m.message) + '</div>' +
                        '<div class="page-sub">' + (m.sender_type === 'staff' ? (m.users ? esc(m.users.full_name || m.users.email) : 'Staff') : esc(c.full_name)) +
                          ' · ' + esc(R.fmtDateTime(m.created_at)) + '</div>' +
                      '</div>';
                    }).join('')
                  : '<p class="page-sub">No messages yet.</p>') +
              '</div>' +
              '<div class="field mt-2"><textarea class="input" id="d-message-input" rows="2" placeholder="Reply to ' + esc(c.full_name) + '"></textarea></div>' +
              '<button class="btn-quiet" id="d-send-message">Send</button>' +
            '</div>'
          : '');
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

      // SECTION 16 — scheduleMessageModal reopens the drawer on success
      // rather than patching the DOM in place, since a newly-scheduled
      // message also needs the "Scheduled messages" section itself to
      // appear (it is only rendered at all once scheduledMessages.length > 0).
      var scheduleButton = R.qs('#d-schedule-message', panel.body);
      if (scheduleButton) {
        scheduleButton.addEventListener('click', function () {
          scheduleMessageModal(c.id, c.full_name, function () { openCustomer(id); });
        });
      }

      R.onClick(panel.body, '[data-cancel-scheduled]', async function (button) {
        await api('/scheduled-messages/' + button.dataset.cancelScheduled, { method: 'DELETE' });
        toast('Scheduled message cancelled.', 'ok');
        openCustomer(id);
      });

      // SECTION 7 — blacklist. Unblacklist needs no reason (it is reversing
      // a decision already explained on the way in); blacklisting does, via
      // blacklistModal, same "require a reason" pattern as waiveModal.
      R.onClick(panel.body, '#d-blacklist', async function () {
        await blacklistModal(c.id, c.full_name);
        openCustomer(id);
      });

      R.onClick(panel.body, '#d-unblacklist', async function () {
        var confirmed = await R.confirm({
          title: 'Unblacklist ' + c.full_name + '?',
          message: 'They can be added to a new reservation again once this is lifted.',
          confirmLabel: 'Unblacklist',
        });
        if (!confirmed) return;
        await api.post('/customers/' + c.id + '/unblacklist');
        toast(c.full_name + ' unblacklisted.', 'ok');
        openCustomer(id);
      });

      R.onClick(panel.body, '[data-pay]', async function (button) {
        panel.close();
        recordPaymentModal(button.dataset.pay, button.dataset.outstanding, c.full_name, c.id);
      });

      R.onClick(panel.body, '[data-waive]', async function (button) {
        await waiveModal(button.dataset.waive, button.dataset.installment, c.full_name);
        openCustomer(id); // the row has to reflect the new status immediately
      });

      R.onClick(panel.body, '[data-change-rep]', async function (button) {
        await changeRepModal(button.dataset.changeRep, button.dataset.repName);
        openCustomer(id); // the row has to reflect the new rep immediately
      });

      R.onClick(panel.body, '[data-joint-sale]', async function (button) {
        await jointSaleModal(button.dataset.jointSale, button.dataset.buyerName);
        openCustomer(id); // the badge has to reflect the new joint sale immediately
      });

      R.onClick(panel.body, '[data-open-legal-case]', async function (button) {
        await openLegalCaseModal(button.dataset.openLegalCase, button.dataset.customerId, button.dataset.name);
        openCustomer(id);
      });

      R.onClick(panel.body, '[data-manage-handover]', async function (button) {
        try {
          await manageHandoverModal(button.dataset.manageHandover, button.dataset.buyerName);
        } catch (err) {
          if (err.status === 404) {
            var wantsChecklist = await R.confirm({
              title: 'No handover checklist yet',
              message: 'Create one now for ' + button.dataset.buyerName + '?',
              confirmLabel: 'Create checklist',
            });
            if (wantsChecklist) await createHandoverChecklistModal(button.dataset.manageHandover);
          } else {
            throw err;
          }
        }
      });

      var hardshipNotice = R.qs('#d-hardship-notice', panel.body);
      if (hardshipNotice) {
        hardshipNotice.addEventListener('click', async function () {
          panel.close();
          await hardshipReviewModal(c.id, c.full_name);
          openCustomer(id);
        });
      }

      R.onClick(panel.body, '#d-log-activity', async function () {
        await logActivityModal(c.id);
        openCustomer(id);
      });

      R.onClick(panel.body, '#d-send-message', async function () {
        var input = R.qs('#d-message-input', panel.body);
        var text = (input.value || '').trim();
        if (!text) return;
        await api.post('/customers/' + c.id + '/messages', { message: text });
        openCustomer(id);
      });

      R.onClick(panel.body, '[data-delete-activity]', async function (button) {
        var confirmed = await R.confirm({
          title: 'Delete this activity note?',
          message: 'This removes it from the buyer\'s activity timeline.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!confirmed) return;
        await api('/customers/' + c.id + '/activities/' + button.dataset.deleteActivity, { method: 'DELETE' });
        openCustomer(id);
      });

      R.qsa('[data-toggle-paid]', panel.body).forEach(function (button) {
        button.addEventListener('click', function () {
          var rows = R.qs('[data-paid-rows="' + button.dataset.togglePaid + '"]', panel.body);
          var wasHidden = rows.classList.contains('hidden');
          rows.classList.toggle('hidden');
          button.textContent = wasHidden ? 'Hide' : 'Show';
        });
      });

      // SECTION 6 — plan history, and each historical plan's own schedule,
      // collapse behind the same show/hide idiom as data-toggle-paid above
      // rather than a real tab: this drawer has no tab component at all
      // (it's one continuous scroll of drawer-section blocks), so a second
      // show/hide toggle nested inside the first is the idiom already
      // established here, not a new one.
      R.qsa('[data-toggle-plan-history]', panel.body).forEach(function (button) {
        button.addEventListener('click', function () {
          var section = R.qs('[data-plan-history="' + button.dataset.togglePlanHistory + '"]', panel.body);
          var wasHidden = section.classList.contains('hidden');
          section.classList.toggle('hidden');
          button.textContent = (wasHidden ? 'Hide' : 'Show') + ' plan history (' +
            asArray(reservations.find(function (r) { return r.id === button.dataset.togglePlanHistory; }).re_installment_plans).length + ')';
        });
      });

      R.qsa('[data-toggle-plan-schedule]', panel.body).forEach(function (button) {
        button.addEventListener('click', function () {
          var rows = R.qs('[data-plan-schedule="' + button.dataset.togglePlanSchedule + '"]', panel.body);
          var wasHidden = rows.classList.contains('hidden');
          rows.classList.toggle('hidden');
          button.textContent = wasHidden ? 'Hide schedule' : 'Show schedule';
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

  /* Moves ONE reservation to a different rep, from the buyer drawer. Owner
     and Sales Director only (reservations.reassign) — the button that opens
     this is itself hidden from anyone else (see openCustomer above). */
  async function changeRepModal(reservationId, currentRepName) {
    var raw = await api('/sales-reps');
    var reps = raw.map(function (r) {
      return { id: r.id, name: (r.users && (r.users.full_name || r.users.email)) || 'Unnamed rep' };
    });

    R.modal({
      title: 'Change sales rep',
      body:
        (currentRepName ? '<p class="muted mb-2">Currently ' + esc(currentRepName) + '.</p>' : '') +
        '<div class="field"><label for="cr-target">New rep</label>' +
          '<select class="select" id="cr-target" name="sales_rep_id">' +
            '<option value="">Unassign</option>' +
            options(reps, 'id', 'name') +
          '</select></div>',
      submitLabel: 'Save',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        await api.patch('/reservations/' + reservationId + '/sales-rep', { sales_rep_id: v.sales_rep_id || null });
        close();
        toast('Sales rep updated.', 'ok');
      },
    });
  }

  function activityRow(a) {
    var me = RE.state.user;
    var canDelete = R.can('activities.write') && (me.role !== 'sales_rep' || a.logged_by_user_id === me.id);
    return '<div class="activity-row">' +
      '<div class="flex-row justify-between gap-10">' +
        '<span>' + badge(a.activity_type) +
          (a.outcome ? ' ' + badge(a.outcome) : '') + '</span>' +
        '<span class="page-sub nowrap">' + esc(R.fmtRelative(a.created_at)) + '</span>' +
      '</div>' +
      '<div class="mt-1">' + esc(a.notes) + '</div>' +
      '<div class="page-sub mt-1">' + esc((a.users && (a.users.full_name || a.users.email)) || 'Someone') +
        (canDelete ? ' · <button class="btn-quiet" data-delete-activity="' + esc(a.id) + '">Delete</button>' : '') +
      '</div>' +
    '</div>';
  }

  // SECTION 16 — one row per scheduled WhatsApp message. Cancel only ever
  // shows for a still-pending one — a sent/failed/cancelled row is history,
  // same "past state, no further action" convention badge() itself already
  // carries everywhere else in this app.
  function scheduledMessageRow(m) {
    return '<div class="sched-history-row flex-row justify-between gap-10">' +
      '<div><div>' + esc(m.message) + '</div>' +
        '<div class="page-sub">' + badge(m.status) + ' · for ' + esc(R.fmtDateTime(m.scheduled_for)) + '</div></div>' +
      (m.status === 'pending'
        ? '<button class="btn-quiet" data-cancel-scheduled="' + esc(m.id) + '">Cancel</button>'
        : '') +
    '</div>';
  }

  // SECTION 16 — message text + a date/time picker. datetime-local rather
  // than separate date/time fields: one native control, no timezone-offset
  // arithmetic to get wrong client-side — the browser hands back a local
  // wall-clock string and `new Date(...)` on it (done server-side, in
  // scheduledMessageService.schedule) reads it in the browser's own zone.
  function scheduleMessageModal(customerId, customerName, onScheduled) {
    R.modal({
      title: 'Schedule a message — ' + customerName,
      body:
        '<div class="field"><label for="sm-message">Message</label>' +
          '<textarea class="textarea" id="sm-message" name="message" rows="4" required placeholder="Hi, just a reminder about..."></textarea></div>' +
        '<div class="field"><label for="sm-when">Send at</label>' +
          '<input class="input" id="sm-when" name="scheduled_for" type="datetime-local" required></div>',
      submitLabel: 'Schedule',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        if (!v.message) throw new Error('Enter a message.');
        if (!v.scheduled_for) throw new Error('Choose a date and time.');
        await api.post('/scheduled-messages', {
          customer_id: customerId,
          message: v.message,
          scheduled_for: new Date(v.scheduled_for).toISOString(),
        });
        close();
        toast('Message scheduled.', 'ok');
        onScheduled();
      },
    });
  }

  /* FEATURE — reviewing a buyer's hardship requests from the drawer's
     hardship notice. Owner/sales_director only (the notice itself only
     ever renders for that tier — see openCustomer above). */
  async function hardshipReviewModal(customerId, customerName) {
    var requests = await api('/hardship-requests?customer_id=' + customerId);

    var panel = R.modal({
      title: 'Payment pause requests — ' + customerName,
      cancelLabel: 'Close',
      body: requests.length
        ? requests.map(function (r) {
            return '<div class="drawer-section">' +
              '<div class="flex-row justify-between gap-10">' + badge(r.status) +
                '<span class="page-sub nowrap">' + esc(fmtDate(r.created_at)) + '</span></div>' +
              '<div class="mt-1">' + R.plural(r.pause_months, 'month') + ' requested</div>' +
              '<div class="page-sub mt-1">' + esc(r.reason) + '</div>' +
              (r.status === 'pending'
                ? '<div class="btn-row mt-1">' +
                    '<button class="btn-quiet" data-hardship-approve="' + esc(r.id) + '">Approve</button>' +
                    '<button class="btn-quiet" data-hardship-deny="' + esc(r.id) + '">Deny</button>' +
                  '</div>'
                : '') +
            '</div>';
          }).join('')
        : '<p class="muted">No hardship requests on file.</p>',
      onSubmit: function () {},
    });

    R.onClick(panel.root, '[data-hardship-approve]', async function (button) {
      await api.patch('/hardship-requests/' + button.dataset.hardshipApprove + '/review', { status: 'approved' });
      toast('Payment pause approved.', 'ok');
      panel.close();
    });
    R.onClick(panel.root, '[data-hardship-deny]', async function (button) {
      await api.patch('/hardship-requests/' + button.dataset.hardshipDeny + '/review', { status: 'denied' });
      toast('Request denied.', 'ok');
      panel.close();
    });
  }

  var ACTIVITY_TYPES = [
    ['call', 'Call'], ['visit', 'Visit'], ['whatsapp', 'WhatsApp'], ['email', 'Email'], ['note', 'Note'], ['site_visit', 'Site visit'],
  ];
  var ACTIVITY_OUTCOMES = [
    ['', 'None'], ['interested', 'Interested'], ['not_interested', 'Not interested'],
    ['promised_payment', 'Promised payment'], ['no_answer', 'No answer'], ['follow_up_needed', 'Follow-up needed'],
  ];

  async function logActivityModal(customerId) {
    R.modal({
      title: 'Log activity',
      body:
        '<div class="field"><label for="la-type">Type</label>' +
          '<select class="select" id="la-type" name="activity_type">' +
            ACTIVITY_TYPES.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('') +
          '</select></div>' +
        '<div class="field"><label for="la-notes">Notes</label>' +
          '<textarea class="input" id="la-notes" name="notes" rows="3" required placeholder="What happened, what was said"></textarea></div>' +
        '<div class="field"><label for="la-outcome">Outcome (optional)</label>' +
          '<select class="select" id="la-outcome" name="outcome">' +
            ACTIVITY_OUTCOMES.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('') +
          '</select></div>',
      submitLabel: 'Log activity',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        // SECTION 14 — logging a call from a site visit with no signal is
        // exactly the case this queue exists for.
        var result = await R.offlineQueue.submitOrQueue('log_activity', '/customers/' + customerId + '/activities', {
          activity_type: v.activity_type,
          notes: v.notes,
          outcome: v.outcome || null,
        });
        close();
        toast(result.queued ? 'No connection — activity saved and will sync automatically.' : 'Activity logged.', 'ok');
      },
    });
  }

  function scheduleRow(s) {
    // Waiving only ever applies to money still owed — a paid row has nothing
    // left to write off, and an already-waived one has been through this once.
    var waivable = (s.status === 'pending' || s.status === 'overdue') && R.can('payments.waive');
    return '<div class="sched ' + esc(s.status) + '">' +
      '<span class="sched-n">' + s.installment_number + '</span>' +
      '<span class="sched-main"><span class="mono">' + naira(s.amount_due) + '</span>' +
        '<span class="page-sub">due <span class="nowrap">' + esc(fmtDate(s.due_date)) + '</span>' +
          (s.paid_at ? ' · paid <span class="nowrap">' + esc(fmtDate(s.paid_at)) + '</span>' : '') + '</span></span>' +
      badge(s.status) +
      (s.status !== 'paid' && R.can('payments.record')
        ? '<button class="btn-quiet" data-pay="' + esc(s.id) + '" data-outstanding="' + esc(s.amount_due) + '">Record</button>'
        : '') +
      (waivable
        ? '<button class="btn-quiet" data-waive="' + esc(s.id) + '" data-installment="' + esc(s.installment_number) + '">Waive</button>'
        : '') +
    '</div>';
  }

  // SECTION 6 — one row per plan in a reservation's Plan history. total_amount
  // (null for Documentation — see routes/customers.js's stripFinancials) reads
  // as "—" rather than ₦0, the same convention naira() already uses elsewhere
  // for a stripped figure. carried_amount_paid only ever appears on a
  // restructured plan (it is what made the restructure's new total the
  // BALANCE rather than the full contract value — see CLAUDE.md's
  // "Renegotiating a plan"), so it is omitted entirely on an original plan.
  function planHistoryRow(p) {
    var schedule = asArray(p.re_installment_schedule)
      .slice().sort(function (a, b) { return a.installment_number - b.installment_number; });
    return '<div class="sched-history-row">' +
      '<div class="flex-row justify-between gap-10">' +
        '<div><b>' + (p.restructured_at ? 'Restructured' : 'Original plan') + '</b>' +
          '<div class="page-sub">Created ' + esc(fmtDate(p.created_at)) + '</div></div>' +
        badge(p.status || 'active') +
      '</div>' +
      '<div class="page-sub mt-1">' + p.number_of_installments + ' ' + esc(p.frequency) +
        ' installments · ' + (p.total_amount != null ? naira(p.total_amount) : '—') +
        (p.carried_amount_paid ? ' (' + naira(p.carried_amount_paid) + ' carried forward, already paid)' : '') +
      '</div>' +
      (p.restructure_reason ? '<div class="page-sub mt-1">Reason: ' + esc(p.restructure_reason) + '</div>' : '') +
      (schedule.length
        ? '<div class="mt-1"><button class="btn-quiet" data-toggle-plan-schedule="' + esc(p.id) + '">Show schedule</button></div>' +
          '<div class="hidden mt-1" data-plan-schedule="' + esc(p.id) + '">' + schedule.map(scheduleRow).join('') + '</div>'
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
              '<td>' + badge(r.status) + (r.escalation_stage && r.escalation_stage !== 'none' ? ' ' + badge(r.escalation_stage) : '') +
                // FEATURE — joint sales.
                (asArray(r.re_joint_sales).length ? ' <span class="badge joint-sale">Joint sale</span>' : '') +
              '</td>' +
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
                // FEATURE — joint sales. DIRECTORS-tier, same as Restructure.
                (R.can('reservations.jointSale')
                  ? '<button class="btn-quiet" data-joint-sale="' + esc(r.id) + '" data-buyer-name="' +
                    esc((r.re_customers && r.re_customers.full_name) || '') + '">Joint sale</button> '
                  : '') +
                '<button class="btn-quiet" data-res-menu="' + esc(r.id) + '" data-status="' + esc(r.status) +
                  '" data-rental="' + (rental ? '1' : '') + '" data-buyer-name="' + esc((r.re_customers && r.re_customers.full_name) || '') + '">Change</button>' +
              '</td>' +
            '</tr>';
          },
          status
            ? { emptyTitle: 'No ' + status + ' reservations', emptyHint: 'A reservation ties a buyer to a unit and starts their payment schedule.' }
            : {
                emptyTitle: 'No reservations yet.',
                emptyHint: 'A reservation ties a buyer to a unit and starts their payment schedule.',
                emptyIcon: 'key',
                emptyAction: '<button class="btn primary" id="btn-empty-res">New reservation</button>',
              }
        ), { flush: true });

      R.onClick(view, '#btn-new-res, #btn-empty-res', async function () { await reservationModal({}); });

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

      R.onClick(view, '[data-joint-sale]', async function (button) {
        await jointSaleModal(button.dataset.jointSale, button.dataset.buyerName);
      });
    },
  };

  /* ══ JOINT SALE ═════════════════════════════════════════════════════════
     FEATURE — joint sales. Co-sellers on one deal, splitting commission by
     percentage. Two fixed row shapes (internal rep / external agent)
     rather than a per-row type switcher — simpler to get right, and a
     deal's co-sellers do not change type mid-edit. */
  function jointSalePartyRow(type, party) {
    party = party || {};
    var repRow = type === 'internal_rep';
    return '<div class="field-row js-party-row" data-party-type="' + type + '">' +
      (repRow
        ? '<div class="field"><label>Sales rep</label><select class="select js-party-user" data-user-id="' + esc(party.user_id || '') + '"></select></div>'
        : '<div class="field"><label>Agent name</label><input class="input js-party-name" value="' + esc(party.agent_name || '') + '" placeholder="Full name"></div>' +
          '<div class="field"><label>Email</label><input class="input js-party-email" type="email" value="' + esc(party.agent_email || '') + '"></div>' +
          '<div class="field"><label>Phone</label><input class="input js-party-phone" value="' + esc(party.agent_phone || '') + '"></div>') +
      '<div class="field"><label>Split %</label><input class="input js-party-pct" type="number" min="0.01" max="100" step="0.01" value="' + esc(party.commission_split_percentage || '') + '"></div>' +
      '<button type="button" class="icon-btn js-remove-party" aria-label="Remove">×</button>' +
    '</div>';
  }

  async function jointSaleModal(reservationId, buyerName) {
    var results = await Promise.all([
      api('/sales-reps'),
      api('/reservations/' + reservationId + '/joint-sale').catch(function () { return null; }),
    ]);
    var reps = results[0], existing = results[1];

    var initialRows = (existing && existing.parties && existing.parties.length)
      ? existing.parties.map(function (p) { return jointSalePartyRow(p.party_type, p); }).join('')
      : jointSalePartyRow('internal_rep') + jointSalePartyRow('external_agent');

    var panel = R.modal({
      title: 'Joint sale — ' + buyerName,
      wide: true,
      body:
        '<p class="field-hint mb-2">Co-sellers on this deal and their commission split. Splits must total 100%.</p>' +
        '<div id="js-parties">' + initialRows + '</div>' +
        '<div class="btn-row mt-1">' +
          '<button type="button" class="btn-quiet" id="js-add-rep">+ Add sales rep</button>' +
          '<button type="button" class="btn-quiet" id="js-add-agent">+ Add external agent</button>' +
        '</div>',
      submitLabel: 'Save joint sale',
      onSubmit: async function (form, close) {
        var rows = R.qsa('.js-party-row', panel.form);
        var parties = rows.map(function (row) {
          var type = row.dataset.partyType;
          var pct = Number(R.qs('.js-party-pct', row).value);
          if (type === 'internal_rep') {
            return { party_type: type, user_id: R.qs('.js-party-user', row).value, commission_split_percentage: pct };
          }
          return {
            party_type: type,
            agent_name: R.qs('.js-party-name', row).value.trim(),
            agent_email: R.qs('.js-party-email', row).value.trim() || null,
            agent_phone: R.qs('.js-party-phone', row).value.trim() || null,
            commission_split_percentage: pct,
          };
        });

        var total = parties.reduce(function (sum, p) { return sum + (p.commission_split_percentage || 0); }, 0);
        if (Math.abs(total - 100) > 0.05) {
          throw new Error('Splits must total 100% — these total ' + Math.round(total * 100) / 100 + '%.');
        }

        await api.post('/reservations/' + reservationId + '/joint-sale', { parties: parties });
        close();
        toast('Joint sale saved.', 'ok');
        R.reload();
      },
    });

    // Rep dropdowns are populated after the modal exists (so the select
    // element is already in the DOM to select against), same reasoning
    // the reservation form's own "New reservation" rep field is built
    // from a pre-fetched list rather than an inline fetch per row.
    function populateRepSelect(select) {
      var chosen = select.dataset.userId;
      select.innerHTML = '<option value="">Choose a rep</option>' + reps.map(function (rep) {
        var userId = rep.users && rep.users.id || rep.user_id || '';
        var name = (rep.users && (rep.users.full_name || rep.users.email)) || 'Rep';
        return '<option value="' + esc(userId) + '"' + (userId === chosen ? ' selected' : '') + '>' + esc(name) + '</option>';
      }).join('');
    }
    R.qsa('.js-party-user', panel.form).forEach(populateRepSelect);

    function addRow(type) {
      var container = R.el('js-parties');
      container.insertAdjacentHTML('beforeend', jointSalePartyRow(type));
      var added = container.lastElementChild;
      var select = R.qs('.js-party-user', added);
      if (select) populateRepSelect(select);
      wireRemove(added);
    }
    function wireRemove(row) {
      R.qs('.js-remove-party', row).addEventListener('click', function () { row.remove(); });
    }
    R.qsa('.js-party-row', panel.form).forEach(wireRemove);

    R.el('js-add-rep').addEventListener('click', function () { addRow('internal_rep'); });
    R.el('js-add-agent').addEventListener('click', function () { addRow('external_agent'); });
  }

  /* ══ CAMPAIGNS ══════════════════════════════════════════════════════════
     FEATURE — email/SMS/WhatsApp campaign tracking. Reading the list is
     campaigns.read (owner + director); creating and sending is owner-only
     (campaigns.write/campaigns.send) — see permissions.js's own comment. */
  var CAMPAIGN_AUDIENCES = [
    ['all', 'All buyers'], ['overdue', 'Overdue buyers only'],
    ['project', 'Buyers in a specific project'], ['credit_below', 'Buyers with credit score below…'],
  ];

  function campaignAudienceLabel(filter) {
    filter = filter || {};
    var found = CAMPAIGN_AUDIENCES.find(function (a) { return a[0] === (filter.audience || 'all'); });
    var label = found ? found[1] : 'All buyers';
    if (filter.audience === 'credit_below') label = 'Credit score below ' + filter.credit_score_below;
    return label;
  }

  R.screens.campaigns = {
    render: async function (view) {
      var canWrite = R.can('campaigns.write');
      var canSend = R.can('campaigns.send');
      var list = await api('/campaigns');

      view.innerHTML =
        head('Campaigns', 'Bulk email, SMS and WhatsApp sends to a chosen slice of your buyer list.',
          canWrite ? '<button class="btn primary" id="btn-new-campaign">New campaign</button>' : '') +
        card(null, table(
          [{ label: 'Name' }, { label: 'Type' }, { label: 'Audience', hideMobile: true }, { label: 'Status' },
            { label: 'Sent', num: true, hideMobile: true }, { label: 'Failed', num: true, hideMobile: true }, { label: '' }],
          list,
          function (c) {
            return '<tr>' +
              '<td class="cell-primary">' + esc(c.name) + '</td>' +
              '<td class="muted">' + esc(c.type) + '</td>' +
              '<td class="muted hide-mobile">' + esc(campaignAudienceLabel(c.target_filter)) + '</td>' +
              '<td>' + badge(c.status) + '</td>' +
              '<td class="num hide-mobile">' + c.sent_count + '</td>' +
              '<td class="num hide-mobile ' + (c.failed_count ? 'clay' : 'muted') + '">' + c.failed_count + '</td>' +
              '<td class="right">' +
                (c.status !== 'sent' && canSend
                  ? '<button class="btn-quiet" data-send-campaign="' + esc(c.id) + '" data-name="' + esc(c.name) + '">Send</button>'
                  : '') +
              '</td>' +
            '</tr>';
          },
          {
            emptyTitle: 'No campaigns yet',
            emptyHint: 'Reach a slice of your buyer list — overdue, a project, or everyone — in one send.',
            emptyAction: canWrite ? '<button class="btn primary" id="btn-empty-campaign">New campaign</button>' : null,
          }
        ), { flush: true });

      R.qsa('[data-send-campaign]', view).forEach(function (button) {
        button.addEventListener('click', async function () {
          var confirmed = await R.confirm({
            title: 'Send campaign',
            message: 'Send "' + button.dataset.name + '" now? This cannot be undone.',
            confirmLabel: 'Send',
          });
          if (!confirmed) return;
          var result = await api.post('/campaigns/' + button.dataset.sendCampaign + '/send', {});
          toast('Sent to ' + result.sent_count + ' buyers' + (result.failed_count ? ', ' + result.failed_count + ' failed' : '') + '.', 'ok');
          R.reload();
        });
      });

      R.qsa('#btn-new-campaign, #btn-empty-campaign', view).forEach(function (b) {
        b.addEventListener('click', newCampaignModal);
      });
    },
  };

  async function newCampaignModal() {
    var projects = await api('/projects');
    var panel = R.modal({
      title: 'New campaign',
      wide: true,
      body:
        '<div class="field"><label for="cmp-name">Name</label>' +
          '<input class="input" id="cmp-name" name="name" required placeholder="March overdue reminder"></div>' +
        '<div class="field"><label for="cmp-type">Channel</label>' +
          '<select class="select" id="cmp-type" name="type">' +
            '<option value="email">Email</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option>' +
          '</select></div>' +
        '<div class="field"><label for="cmp-audience">Audience</label>' +
          '<select class="select" id="cmp-audience" name="audience">' +
            CAMPAIGN_AUDIENCES.map(function (a) { return '<option value="' + a[0] + '">' + a[1] + '</option>'; }).join('') +
          '</select></div>' +
        '<div class="field-row" id="cmp-project-row" hidden>' +
          '<div class="field"><label for="cmp-project">Project</label>' +
            '<select class="select" id="cmp-project" name="project_id">' +
              projects.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'; }).join('') +
            '</select></div>' +
        '</div>' +
        '<div class="field-row" id="cmp-credit-row" hidden>' +
          '<div class="field"><label for="cmp-credit">Credit score below</label>' +
            '<input class="input" id="cmp-credit" name="credit_score_below" type="number" min="0" max="100" value="50"></div>' +
        '</div>' +
        '<div class="field"><label for="cmp-body">Message</label>' +
          '<textarea class="textarea" id="cmp-body" name="message_body" rows="4" required></textarea></div>' +
        '<button type="button" class="btn-quiet mb-2" id="cmp-preview">Preview recipients</button>' +
        '<p class="field-hint" id="cmp-preview-result"></p>',
      submitLabel: 'Save campaign',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        if (!v.name || !v.message_body) throw new Error('Give the campaign a name and a message.');
        await api.post('/campaigns', {
          name: v.name, type: v.type, message_body: v.message_body,
          target_filter: buildTargetFilter(v),
        });
        close();
        toast('Campaign saved as a draft.', 'ok');
        R.reload();
      },
    });

    function buildTargetFilter(v) {
      if (v.audience === 'project') return { audience: 'project', project_id: v.project_id };
      if (v.audience === 'credit_below') return { audience: 'credit_below', credit_score_below: Number(v.credit_score_below) };
      return { audience: v.audience };
    }

    R.qs('#cmp-audience', panel.form).addEventListener('change', function (e) {
      R.el('cmp-project-row').hidden = e.target.value !== 'project';
      R.el('cmp-credit-row').hidden = e.target.value !== 'credit_below';
    });

    R.qs('#cmp-preview', panel.form).addEventListener('click', async function (button) {
      button.disabled = true;
      try {
        var v = R.values(panel.form);
        var result = await api.post('/campaigns/preview-audience', { target_filter: buildTargetFilter(v) });
        R.el('cmp-preview-result').textContent = R.plural(result.count, 'buyer') + ' would receive this' +
          (result.sample.length ? ' — e.g. ' + result.sample.slice(0, 3).map(function (s) { return s.full_name; }).join(', ') : '');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        button.disabled = false;
      }
    });
  }

  /* ══ HANDOVER CHECKLIST ══════════════════════════════════════════════════
     SECTION 11. Owner/sales_director only (handover.manage). Created once,
     manually — see reservationStatusModal above for the prompt this answers,
     and manageHandoverModal (buyer drawer) for reviewing snagging items
     reported afterward. */
  async function createHandoverChecklistModal(reservationId) {
    R.modal({
      title: 'Create handover checklist',
      body:
        '<div class="field"><label for="ho-date">Handover date</label>' +
          '<input class="input" id="ho-date" name="handover_date" type="date" value="' + esc(R.todayISO()) + '"></div>' +
        '<div class="field"><label><input type="checkbox" id="ho-keys" name="keys_handed"> Keys handed over</label></div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="ho-electricity">Electricity meter reading</label>' +
            '<input class="input" id="ho-electricity" name="electricity"></div>' +
          '<div class="field"><label for="ho-water">Water meter reading</label>' +
            '<input class="input" id="ho-water" name="water"></div>' +
        '</div>' +
        '<div class="field"><label for="ho-docs">Documents provided (comma separated)</label>' +
          '<input class="input" id="ho-docs" name="documents_provided" placeholder="Warranty booklet, User manual"></div>',
      submitLabel: 'Create checklist',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        await api.post('/reservations/' + reservationId + '/handover', {
          handover_date: v.handover_date || null,
          keys_handed: v.keys_handed,
          meter_readings: { electricity: v.electricity || null, water: v.water || null },
          documents_provided: (v.documents_provided || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        });
        close();
        toast('Handover checklist created.', 'ok');
      },
    });
  }

  // SECTION 11 — reviewing snagging items reported against a completed
  // reservation's checklist, and acting on each (acknowledge / mark fixed /
  // dispute), from the buyer drawer.
  async function manageHandoverModal(reservationId, buyerName) {
    var checklist = await api('/reservations/' + reservationId + '/handover');
    var items = checklist.snagging_items || [];

    var panel = R.modal({
      title: 'Handover — ' + buyerName,
      wide: true,
      cancelLabel: 'Close',
      body:
        '<div class="grid cols-3 mb-2">' +
          stat('Status', checklist.status.replace(/_/g, ' ')) +
          stat('Keys handed', checklist.keys_handed ? 'Yes' : 'No') +
          stat('Snagging items', String(items.length)) +
        '</div>' +
        (items.length
          ? items.map(function (s) {
              return '<div class="drawer-section">' +
                '<div class="flex-row justify-between gap-10">' + badge(s.status) +
                  '<span class="page-sub nowrap">' + esc(fmtDate(s.created_at)) + '</span></div>' +
                '<div class="mt-1">' + esc(s.description) + '</div>' +
                (s.photo_url ? '<a href="' + esc(s.photo_url) + '" target="_blank" rel="noopener" class="btn-quiet mt-1">View photo</a>' : '') +
                (s.developer_response ? '<div class="page-sub mt-1">Response: ' + esc(s.developer_response) + '</div>' : '') +
                (s.status !== 'fixed'
                  ? '<div class="btn-row mt-1">' +
                      '<button class="btn-quiet" data-snag-ack="' + esc(s.id) + '">Acknowledge</button>' +
                      '<button class="btn-quiet" data-snag-fix="' + esc(s.id) + '">Mark fixed</button>' +
                    '</div>'
                  : '') +
              '</div>';
            }).join('')
          : '<p class="muted">No snagging items reported yet.</p>'),
      onSubmit: function () {},
    });

    R.onClick(panel.root, '[data-snag-ack]', async function (button) {
      await api.patch('/handover/snag/' + button.dataset.snagAck, { status: 'acknowledged' });
      toast('Snagging item acknowledged.', 'ok');
      panel.close();
      manageHandoverModal(reservationId, buyerName);
    });
    R.onClick(panel.root, '[data-snag-fix]', async function (button) {
      await api.patch('/handover/snag/' + button.dataset.snagFix, { status: 'fixed' });
      toast('Snagging item marked fixed.', 'ok');
      panel.close();
      manageHandoverModal(reservationId, buyerName);
    });
  }

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
          stat('To reschedule', naira(state.remaining), { tone: 'gold' }) +
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
                  '<span class="page-sub">due <span class="nowrap">' + esc(fmtDate(row.due_date)) + '</span></span></span></div>';
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
    // SECTION 7 — the id of the last recommendation shown (if any) and
    // whether the rep clicked "Use this" on it, so onSubmit below can log
    // the outcome once it knows whether a reservation actually resulted.
    var currentRecommendation = null;
    var recommendationAccepted = false;

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
        formSection('Buyer',
          '<div class="field"><label for="r-customer">Buyer</label>' +
            '<select class="select" id="r-customer" name="customer_id" required>' +
              options(customers, 'id', 'full_name', preset.customerId) + '</select></div>'
        ) +

        formSection('Unit',
          '<div class="field"><label for="r-unit">Unit</label>' +
            '<select class="select" id="r-unit" name="unit_id" required>' + options(unitList, 'id', 'label', preset.unitId) + '</select></div>' +
          '<div class="field"><label for="r-property-type">What is this?</label>' +
            '<select class="select" id="r-property-type" name="property_type">' +
              '<option value="off_plan">Off-plan sale</option>' +
              '<option value="outright">Outright sale</option>' +
              '<option value="rental">Rental / tenancy</option>' +
            '</select></div>'
        ) +

        formSection('Assignment',
          '<div class="field"><label for="r-rep">Sales rep</label>' +
            '<select class="select" id="r-rep" name="sales_rep_id">' +
              '<option value="">Unassigned</option>' +
              reps.map(function (rep) {
                return '<option value="' + esc(rep.id) + '">' +
                  esc((rep.users && (rep.users.full_name || rep.users.email)) || 'Rep') +
                  (rep.commission_rate ? ' — ' + rep.commission_rate + '% commission' : '') + '</option>';
              }).join('') +
            '</select>' +
            '<p class="field-hint">Commission accrues to this rep on every payment against this reservation.</p></div>'
        ) +

        formSection('Payment Plan',
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

            // SECTION 7 — needs both a buyer and a unit picked (the
            // recommendation is built from THIS unit's price and THIS buyer's
            // credit score), so it stays disabled until both selects have a
            // value — see wirePlanRecommendation().
            '<button class="btn-quiet mb-2" type="button" id="r-ai-recommend" disabled>AI Recommendation</button>' +
            '<div class="hidden" id="r-ai-suggestion"></div>' +
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
          '</div>' +

          // FEATURE — outright sales. No schedule to configure: one amount,
          // due today, settled by one payment — so this replaces the whole
          // "Set up an installment plan" checkbox and its fields rather than
          // sitting alongside them, same treatment the rental block above
          // gets for its own reason.
          '<div id="r-plan-outright" class="hidden">' +
            '<div class="field"><label for="r-outright-amount">Full sale amount</label>' +
              '<div class="input-money"><input class="input" id="r-outright-amount" name="outright_amount" type="number" min="1" step="1"></div></div>' +
            '<p class="field-hint">Due immediately. Allocation letter generates automatically the moment this is paid in full.</p>' +
          '</div>'
        ),
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
        } else if (v.property_type === 'outright') {
          if (!v.outright_amount) {
            throw new Error('An outright sale needs a full sale amount.');
          }
          // number_of_installments/frequency/start_date are set server-side
          // (routes/reservations.js) for an outright sale regardless of what
          // travels here — total_amount is the one real input.
          payload.plan = { total_amount: Number(v.outright_amount) };
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

        // SECTION 14 — offline, this queues instead of creating outright;
        // there is then no real reservation.id yet, so the plan-
        // recommendation follow-up below (which needs one) only runs on
        // the ordinary, online path.
        var result = await R.offlineQueue.submitOrQueue('new_reservation', '/reservations', payload);

        if (!result.queued) {
          var created = result.data;
          // SECTION 7 — logs the outcome regardless of which way it went:
          // accepted (this reservation is the one it produced) or shown and
          // not used. Never blocks the reservation itself on this call.
          if (currentRecommendation) {
            try {
              await api.patch('/reservations/plan-recommendations/' + currentRecommendation.id, {
                accepted: recommendationAccepted,
                reservation_id: recommendationAccepted ? created.reservation.id : null,
              });
            } catch (err) { /* logging the decision must not block a reservation that already exists */ }
          }
        }

        close();
        toast(result.queued
          ? 'No connection — reservation saved and will sync automatically.'
          : (v.property_type === 'rental' ? 'Tenancy created.'
            : v.property_type === 'outright' ? 'Outright sale reserved — record the payment to complete it.'
            : 'Reservation created.'), 'ok');
        if (!result.queued) R.reload();
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
    // fields for rent fields rather than showing both at once. "Outright"
    // (FEATURE — outright sales) gets the same treatment, its own single
    // amount field replacing the installment-plan fields entirely.
    R.el('r-property-type').addEventListener('change', function (e) {
      var rental = e.target.value === 'rental';
      var outright = e.target.value === 'outright';
      R.el('r-plan-rental').classList.toggle('hidden', !rental);
      R.el('r-plan-outright').classList.toggle('hidden', !outright);
      R.el('r-has-plan-row').classList.toggle('hidden', rental || outright);
      R.el('r-plan').classList.toggle('hidden', rental || outright || !R.el('r-has-plan').checked);
      if (rental) updateRentalPreview();
    });

    // SECTION 7 — needs a real unit AND a real buyer picked first (the
    // recommendation is built from this unit's price and this buyer's own
    // credit score), so the button stays disabled until both selects have a
    // value, same reasoning "New reservation" itself requires both.
    var aiButton = R.el('r-ai-recommend');
    var suggestionBox = R.el('r-ai-suggestion');
    var customerSelect = R.el('r-customer');
    var updateAiButtonState = function () {
      aiButton.disabled = !unitSelect.value || !customerSelect.value;
    };
    unitSelect.addEventListener('change', updateAiButtonState);
    customerSelect.addEventListener('change', updateAiButtonState);
    updateAiButtonState();

    aiButton.addEventListener('click', async function () {
      aiButton.disabled = true;
      aiButton.classList.add('is-working');
      try {
        var rec = await api.post('/reservations/plan-recommendation', {
          customer_id: customerSelect.value, unit_id: unitSelect.value,
        });
        currentRecommendation = rec;
        recommendationAccepted = false;
        suggestionBox.classList.remove('hidden');
        suggestionBox.innerHTML =
          '<div class="notice info mt-1">' +
            '<div class="flex-row justify-between align-start gap-10">' +
              '<div>' +
                '<b>' + rec.recommended_installments + ' ' + esc(rec.recommended_frequency) + ' installments, ' +
                  rec.recommended_deposit_percent + '% deposit</b>' +
                '<div class="page-sub mt-1">' + esc(rec.reasoning) + '</div>' +
                (rec.generated_by === 'fallback' ? '<div class="page-sub mt-1">Rule-based suggestion — AI is not configured for this workspace.</div>' : '') +
              '</div>' +
              '<button class="icon-btn" type="button" id="r-ai-dismiss" aria-label="Dismiss">×</button>' +
            '</div>' +
            '<div class="btn-row mt-1"><button class="btn-quiet" type="button" id="r-ai-use">Use this</button></div>' +
          '</div>';

        R.qs('#r-ai-dismiss', suggestionBox).addEventListener('click', function () {
          suggestionBox.classList.add('hidden');
          suggestionBox.innerHTML = '';
        });
        R.qs('#r-ai-use', suggestionBox).addEventListener('click', function () {
          R.el('r-count').value = rec.recommended_installments;
          R.el('r-freq').value = rec.recommended_frequency;
          recommendationAccepted = true;
          updatePreview();
          toast('Plan fields updated. Deposit suggestion (' + rec.recommended_deposit_percent + '%) is not auto-recorded — collect it as a separate payment if the buyer pays it upfront.', 'ok');
        });
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        aiButton.disabled = false;
        aiButton.classList.remove('is-working');
      }
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

        // SECTION 11 — "when a reservation is marked completed: prompt the
        // owner to create a handover checklist." Rental's own 'completed'
        // means the TENANCY ended (the buyer moving out, unit back on the
        // market) rather than a buyer taking possession, so this only
        // fires for an off-plan/outright sale actually closing.
        if (next === 'completed' && current !== 'completed' && !isRental && R.can('handover.manage')) {
          var wantsChecklist = await R.confirm({
            title: 'Create a handover checklist?',
            message: buyerName + '’s unit is now marked completed. Start the handover checklist now?',
            confirmLabel: 'Create checklist',
          });
          if (wantsChecklist) await createHandoverChecklistModal(id);
        }

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
                emptyTitle: 'No payments recorded yet.',
                emptyHint: 'Record one against a due installment, or wait for the next Paystack payment to settle.',
                emptyIcon: 'receipt',
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

          '<div class="sched-buyer-table">' + card(null, table(
            [{ label: 'Buyer' }, { label: 'Unit' }, { label: 'Paid', hideMobile: true }, { label: 'Remaining', num: true }],
            p.slice,
            buyerRow,
            {
              emptyTitle: tab === 'overdue' ? 'Nothing is overdue' : tab === 'due_week' ? 'Nothing due this week' : 'Nothing outstanding',
              emptyHint: 'Reservations with an open payment plan appear here.',
            }
          ), { flush: true }) + '</div>' +
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
        '<span class="page-sub">' + (s.status === 'overdue' ? 'overdue since ' : 'due ') +
          '<span class="nowrap">' + esc(fmtDate(s.due_date)) + '</span>' +
          (s.paid_at ? ' · paid <span class="nowrap">' + esc(fmtDate(s.paid_at)) + '</span>' : '') + '</span></span>' +
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

        formSection('Amount',
          '<div class="field"><label for="pay-amount">Amount received</label>' +
            '<div class="input-money"><input class="input" id="pay-amount" name="amount" type="number" min="1" step="1" required value="' + esc(outstanding || '') + '"></div>' +
            '<p class="field-hint">Part payments are fine. The installment settles once it is fully covered.</p>' +
            '<div id="pay-warn"></div></div>'
        ) +

        formSection('Transaction Details',
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
            '<input class="input" id="pay-payer" name="payer_name" placeholder="e.g. a spouse, company or lawyer\'s account"></div>'
        ),
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

  // SECTION 7 — blacklist. Same shape as waiveModal above: a reason is
  // required (there is no receipt behind this decision the way a payment
  // has one, so the reason IS the record), and the buyer's name is shown so
  // whoever clicked confirms who they are about to blacklist.
  function blacklistModal(customerId, customerName) {
    return new Promise(function (resolve) {
      var panel = R.modal({
        title: 'Blacklist ' + customerName,
        body:
          '<p class="muted mb-2">They cannot be added to a new reservation while blacklisted. ' +
            'Existing reservations are not affected.</p>' +
          '<div class="field"><label for="bl-reason">Reason</label>' +
            '<textarea class="textarea" id="bl-reason" name="reason" rows="3" required ' +
              'placeholder="Why are they being blacklisted?"></textarea></div>',
        submitLabel: 'Blacklist buyer',
        onSubmit: async function (form, close) {
          var v = R.values(form);
          if (!v.reason) throw new Error('A reason is required.');
          await api.post('/customers/' + customerId + '/blacklist', { reason: v.reason });
          close();
          toast(customerName + ' blacklisted.', 'ok');
          resolve(true);
        },
      });
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
                    'due <span class="nowrap">' + esc(fmtDate(s.due_date)) + '</span></span></span>' +
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
    render: async function (view, params, query) {
      if (query.project) projectFilter = query.project;
      var results = await Promise.all([api('/documents'), api('/reservations'), api('/projects')]);
      var allDocuments = results[0], reservations = results[1], projects = results[2];
      var canBulkGenerate = R.can('documents.bulkGenerate');

      // SECTION 8 — client-side, same as the Dashboard/Units screens'
      // projectFilter idiom (module-level, shared across screens): both
      // lists this screen already loads carry project_id now (widened in
      // routes/documents.js and routes/reservations.js specifically for
      // this), so there is nothing worth a new server-side query param for.
      var documents = projectFilter
        ? allDocuments.filter(function (d) {
            var unit = d.re_reservations && d.re_reservations.re_units;
            return unit && unit.project_id === projectFilter;
          })
        : allDocuments;

      var projectPills = projects.length > 1
        ? '<div class="filter-row">' +
            '<button class="pill' + (projectFilter ? '' : ' is-on') + '" data-project="">All projects</button>' +
            projects.map(function (p) {
              return '<button class="pill' + (projectFilter === p.id ? ' is-on' : '') + '" data-project="' + esc(p.id) + '">' + esc(p.name) + '</button>';
            }).join('') +
          '</div>'
        : '';

      view.innerHTML =
        head('Documents', 'Allocation letters, legal documents and receipts, stored privately and served through short-lived links.',
          '<button class="btn primary" id="btn-new-doc">New document</button>' +
            // SECTION 8 — only shown while filtered to ONE project: "generate
            // all" needs a project to scope to, the same reason the button
            // does not appear on the unfiltered "every document" view.
            (canBulkGenerate && projectFilter
              ? '<button class="btn" id="btn-generate-all">Generate all</button>'
              : '')) +

        projectPills +

        card(null, table(
          // Type and Buyer used to be two separate columns — on a phone,
          // hiding Unit/Generated alone still left Buyer's own column wide
          // enough (a real name easily runs to two or three words) to push
          // the Download/Generate button off-screen anyway. Folding Buyer
          // in under Type as a second line reclaims that whole column,
          // the same cell-primary/cell-meta idiom already used for
          // Project+Location and Tenant+Unit elsewhere on this screen set.
          [{ label: 'Document' }, { label: 'Unit', hideMobile: true }, { label: 'Status' },
            { label: 'Generated', hideMobile: true }, { label: 'Expiry', hideMobile: true }, { label: '' }],
          currentDocumentRows(documents),
          documentRow,
          {
            emptyTitle: 'No documents yet.',
            emptyHint: 'Generate an allocation letter to get started.',
            emptyIcon: 'document',
            emptyAction: '<button class="btn primary" id="btn-empty-doc">New document</button>',
          }
        ), { flush: true });

      R.onClick(view, '[data-generate]', async function (button) {
        var result = await api.post('/documents/' + button.dataset.generate + '/generate');
        R.openFile(result.download_url);
        toast(result.signing_url ? 'Signing link sent to the buyer.' : 'Document generated.', 'ok');
        R.reload();
      });

      R.onClick(view, '[data-download]', async function (button) {
        var result = await api('/documents/' + button.dataset.download + '/download');
        R.openFile(result.download_url);
      });

      // SECTION 10 — same collapsed-summary/detail-row pair as buyerRow()
      // on the Payments screen: table()'s rowFn returns a string, and a
      // <tbody> does not care whether that is one <tr> or several.
      R.qsa('[data-toggle-versions]', view).forEach(function (button) {
        button.addEventListener('click', function () {
          var row = R.qs('[data-versions-detail="' + button.dataset.toggleVersions + '"]', view);
          var wasHidden = row.classList.contains('hidden');
          row.classList.toggle('hidden');
          button.textContent = wasHidden ? 'Hide previous versions' : button.dataset.versionsLabel;
        });
      });

      R.qsa('[data-project]', view).forEach(function (pill) {
        pill.addEventListener('click', function () {
          projectFilter = pill.dataset.project || null;
          R.reload();
        });
      });

      // SECTION 8 — the preview count is computed from data already on the
      // page (reservations + documents, both now carrying project_id), not
      // a second request: it is the same "active reservations in this
      // project without a live allocation letter" set the server itself
      // will process, just counted client-side first so the confirmation
      // can say a real number before anything is generated.
      R.onClick(view, '#btn-generate-all', async function (button) {
        var projectReservations = reservations.filter(function (r) {
          return r.status !== 'cancelled' && r.re_units && r.re_units.project_id === projectFilter;
        });
        var alreadyHas = {};
        allDocuments.forEach(function (d) {
          if (d.doc_type === 'allocation_letter') alreadyHas[d.reservation_id] = true;
        });
        var toGenerate = projectReservations.filter(function (r) { return !alreadyHas[r.id]; }).length;
        var projectName = (projects.filter(function (p) { return p.id === projectFilter; })[0] || {}).name || 'this project';

        if (!toGenerate) {
          toast('Every active reservation in ' + projectName + ' already has an allocation letter.', 'ok');
          return;
        }

        var confirmed = await R.confirm({
          title: 'Generate ' + R.plural(toGenerate, 'allocation letter') + '?',
          message: 'Generates an allocation letter for every active reservation in ' + projectName +
            ' that does not already have one. This may take a minute for a large project.',
          confirmLabel: 'Generate all',
        });
        if (!confirmed) return;

        button.textContent = 'Generating ' + toGenerate + ' document(s)…';
        var result = await api.post('/documents/bulk-generate', { project_id: projectFilter, doc_type: 'allocation_letter' });
        toast(
          result.generated + ' generated, ' + result.skipped + ' already existed' +
            (result.failed ? ', ' + result.failed + ' failed' : '') + '.',
          result.failed ? 'err' : 'ok'
        );
        R.reload();
      });

      R.qsa('#btn-new-doc, #btn-empty-doc', view).forEach(function (b) { b.addEventListener('click', function () {
        if (!reservations.length) return toast('Create a reservation first.', 'err');

        var list = reservations.map(function (r) {
          var unit = r.re_units || {};
          return {
            id: r.id,
            label: ((r.re_customers && r.re_customers.full_name) || 'Buyer') +
              (unit.unit_number ? ' — Unit ' + unit.unit_number : ''),
          };
        });

        // SECTION 8 — deed_of_assignment, subscriber_agreement and
        // power_of_attorney join allocation_letter as choices here.
        // lease_agreement/other are left off this list on purpose: real,
        // creatable doc_types with no template yet (routes/documents.js's
        // own comment) — offering them here would just walk a rep into the
        // "no template for this yet" error on generate.
        var DOC_TYPE_OPTIONS = [
          ['allocation_letter', 'Allocation letter'],
          ['deed_of_assignment', 'Deed of assignment'],
          ['subscriber_agreement', "Subscriber's agreement"],
          ['power_of_attorney', 'Power of attorney'],
        ];

        var panel = R.modal({
          title: 'New document',
          body:
            '<div class="field"><label for="doc-type">Document type</label>' +
              '<select class="select" id="doc-type" name="doc_type">' +
                DOC_TYPE_OPTIONS.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('') +
              '</select></div>' +
            // Focused first (modal() focuses the first real input), so typing
            // to narrow the list is possible the instant the dialog opens —
            // useful the moment a project has more than a handful of buyers.
            '<div class="field"><label for="doc-search">Search buyer</label>' +
              '<input class="input" id="doc-search" type="text" placeholder="Type a name to filter…" autocomplete="off"></div>' +
            '<div class="field"><label for="doc-res">Reservation</label>' +
              '<select class="select" id="doc-res" name="reservation_id">' + options(list, 'id', 'label') + '</select></div>' +
            '<p class="field-hint" id="doc-type-hint">The letter uses the letterhead from Settings. Set your company name and logo there first if you have not.</p>',
          submitLabel: 'Create and generate',
          onSubmit: async function (form, close) {
            var v = R.values(form);
            var created = await api.post('/documents', {
              reservation_id: v.reservation_id,
              doc_type: v.doc_type,
            });
            close();
            toast('Generating…');
            try {
              var result = await api.post('/documents/' + created.id + '/generate');
              R.openFile(result.download_url);
              toast(
                result.signing_url
                  ? 'Document ready — a signing link has been sent to the buyer.'
                  : 'Document ready.',
                'ok'
              );
            } catch (err) {
              // Puppeteer is absent on some runtimes. The document row still
              // exists, so say what happened rather than pretending it worked.
              toast('Document created but could not be rendered: ' + err.message, 'err');
            }
            R.reload();
          },
        });

        R.qs('#doc-type', panel.root).addEventListener('change', function (e) {
          var signable = e.target.value !== 'allocation_letter';
          R.el('doc-type-hint').textContent = signable
            ? 'The buyer will automatically be sent a link by email/WhatsApp to review and sign this document.'
            : 'The letter uses the letterhead from Settings. Set your company name and logo there first if you have not.';
        });

        // Client-side only — the list is already loaded in full above, so
        // there is nothing worth round-tripping to the server for.
        var search = R.qs('#doc-search', panel.root);
        var select = R.qs('#doc-res', panel.root);
        search.addEventListener('input', function () {
          var q = search.value.trim().toLowerCase();
          var options_ = R.qsa('option', select);
          var selectedStillVisible = false;
          options_.forEach(function (opt) {
            var match = !q || opt.textContent.toLowerCase().indexOf(q) !== -1;
            opt.hidden = !match;
            if (match && opt.selected) selectedStillVisible = true;
          });
          // Filtering out the buyer that was selected must not leave a
          // hidden option silently chosen underneath — the dropdown jumps
          // to whichever name is still on screen instead.
          if (!selectedStillVisible) {
            var firstVisible = options_.filter(function (opt) { return !opt.hidden; })[0];
            if (firstVisible) firstVisible.selected = true;
          }
        });
      }); });
    },
  };

  /* ══ GROUP DASHBOARD (SECTION 1 — multi-branch / multi-company) ═════════
     Only reachable via the sidebar's Group link, itself only shown when
     GET /auth/me reported is_group_owner. The route still works if typed
     directly by someone who is not a group owner — the API answers
     is_group_owner:false rather than 403ing, and this screen renders the
     "create a group" empty state instead, same as any other owner-only
     screen degrades gracefully rather than assuming the nav already
     gatekept it. */
  R.screens.group = {
    render: async function (view) {
      var data = await api('/group/dashboard');

      if (!data.is_group_owner) {
        view.innerHTML = head('Group dashboard', 'A consolidated view across every branch workspace you own.') +
          card(null, R.emptyState(
            'You do not own a group yet',
            'A group rolls up collections, buyers, overdue and GDV across several branch workspaces you own — Mshel Abuja, Mshel Lagos, Mshel Kano under one Mshel Homes Group, for example.',
            '<button class="btn primary" id="btn-create-group">Create a group</button>'
          ));

        R.qs('#btn-create-group', view).addEventListener('click', function () {
          R.modal({
            title: 'Create a group',
            body: '<div class="field"><label for="grp-name">Group name</label>' +
              '<input class="input" id="grp-name" name="name" required placeholder="Mshel Homes Group"></div>',
            submitLabel: 'Create',
            onSubmit: async function (form, close) {
              await api.post('/group', { name: R.values(form).name });
              close();
              toast('Group created.', 'ok');
              R.reload();
            },
          });
        });
        return;
      }

      var totals = data.totals;
      var branches = data.branches;
      var branchIds = branches.map(function (b) { return b.branch_id; });
      // Candidates for "Add branch": workspaces this person owns outright
      // that are not already rolled into this group. me.workspaces (from
      // GET /auth/me, already loaded into RE.state.user) is the same list
      // the workspace switcher itself draws from — no second fetch needed.
      var ownedElsewhere = (R.state.user.workspaces || []).filter(function (w) {
        return w.role === 'owner' && branchIds.indexOf(w.team_id) === -1;
      });

      view.innerHTML = head('Group dashboard', 'Consolidated across ' + branches.length +
          (branches.length === 1 ? ' branch.' : ' branches.'),
          '<button class="btn-quiet" id="btn-add-branch">Add branch</button>') +

        '<div class="grid cols-4 mb-2">' +
          stat('Total buyers', String(totals.total_buyers)) +
          stat('Total collections', naira(totals.collected_total), { tone: 'moss' }) +
          stat('Total overdue', naira(totals.receivables_overdue), { tone: totals.receivables_overdue ? 'clay' : null }) +
          stat('Total GDV', naira(totals.gross_development_value)) +
        '</div>' +

        card('By branch', table(
          [{ label: 'Branch' }, { label: 'Buyers', num: true, hideMobile: true },
            { label: 'Collected', num: true }, { label: 'Overdue', num: true },
            { label: 'GDV', num: true, hideMobile: true }, { label: '' }],
          branches,
          function (b) {
            return '<tr>' +
              '<td class="cell-primary">' + esc(b.name) + '</td>' +
              '<td class="num hide-mobile">' + b.total_buyers + '</td>' +
              '<td class="num moss">' + naira(b.collected_total) + '</td>' +
              '<td class="num ' + (b.receivables_overdue ? 'clay' : 'muted') + '">' + naira(b.receivables_overdue) + '</td>' +
              '<td class="num hide-mobile">' + naira(b.gross_development_value) + '</td>' +
              '<td class="right"><button class="btn-quiet" data-remove-branch="' + esc(b.branch_id) + '" data-name="' + esc(b.name) + '">Remove</button></td>' +
            '</tr>';
          },
          { emptyTitle: 'No branches yet', emptyHint: 'Add a workspace you own to start rolling up its numbers here.' }
        ), { flush: true });

      R.qs('#btn-add-branch', view).addEventListener('click', function () {
        if (!ownedElsewhere.length) {
          return toast('Every workspace you own is already a branch of this group.', 'err');
        }
        R.modal({
          title: 'Add branch',
          body: '<div class="field"><label for="grp-branch">Workspace</label>' +
            '<select class="select" id="grp-branch" name="team_id">' +
              ownedElsewhere.map(function (w) {
                return '<option value="' + esc(w.team_id) + '">' + esc(w.name) + '</option>';
              }).join('') +
            '</select></div>' +
            '<p class="field-hint">The branch keeps its own buyers, payments and documents — only its totals join this dashboard.</p>',
          submitLabel: 'Add',
          onSubmit: async function (form, close) {
            await api.post('/group/branches', { group_id: data.groups[0].id, team_id: R.values(form).team_id });
            close();
            toast('Branch added.', 'ok');
            R.reload();
          },
        });
      });

      R.onClick(view, '[data-remove-branch]', async function (button) {
        var ok = await R.confirm({
          title: 'Remove ' + button.dataset.name + '?',
          message: 'This branch keeps every buyer, payment and document exactly as they are — it just stops being counted in this group’s totals.',
          confirmLabel: 'Remove',
        });
        if (!ok) return;
        await api('/group/branches/' + button.dataset.removeBranch, { method: 'DELETE' });
        toast('Branch removed from the group.', 'ok');
        R.reload();
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
        // FEATURE — joint sales. "My own" regardless of role, same
        // reasoning as the entries list above it — see
        // jointSaleService.myJointSaleCommissions's own header for why
        // this is a split of the SAME rows the entries table already
        // lists, not separate commission money.
        var entriesResults = await Promise.all([api('/commissions'), api('/commissions/joint-sales')]);
        var entries = entriesResults[0], jointCommissions = entriesResults[1];
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
          ), { flush: true }) +

          // FEATURE — joint sales. Only rendered once there is something to
          // show — a rep who has never been tagged as a co-seller on a deal
          // sees nothing extra here, same "no card for zero rows" rule the
          // rest of this screen already follows.
          (jointCommissions.length
            ? '<div class="mt-2">' + card('Joint sale commissions', table(
                [{ label: 'Buyer' }, { label: 'Unit', hideMobile: true }, { label: 'Total commission', num: true, hideMobile: true },
                  { label: 'Your split', num: true }, { label: 'Your share', num: true }],
                jointCommissions,
                function (jc) {
                  return '<tr>' +
                    '<td class="cell-primary">' + esc(jc.customer_name || '—') + '</td>' +
                    '<td class="muted hide-mobile">' + esc(jc.unit_number || '—') + '</td>' +
                    '<td class="num muted hide-mobile">' + naira(jc.total_amount) + '</td>' +
                    '<td class="num muted">' + jc.split_percentage + '%</td>' +
                    '<td class="num gold">' + naira(jc.your_share) + '</td>' +
                  '</tr>';
                }
              ), { flush: true }) + '</div>'
            : '');

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
          stat('Owed to reps', naira(totalOwed), { tone: totalOwed ? 'gold' : null }) +
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
  var LEGAL_CASE_STATUSES = [
    ['active', 'Active'], ['settled', 'Settled'], ['judgment_obtained', 'Judgment obtained'],
    ['withdrawn', 'Withdrawn'], ['closed', 'Closed'],
  ];

  // SECTION 8 — owner only (legal.manage), the entry point PATCH
  // /legal-cases/:id has in this app: lawyer details, status, settlement,
  // and a download link for whichever demand letter(s) have been generated
  // for this reservation (documentService.getDownloadUrl, reused as-is).
  async function manageLegalCaseModal(caseId) {
    var legalCase = await api('/legal-cases/' + caseId);

    R.modal({
      title: 'Legal case — ' + (legalCase.re_customers ? legalCase.re_customers.full_name : 'buyer'),
      wide: true,
      body:
        (legalCase.demand_letters && legalCase.demand_letters.length
          ? '<p class="field-hint">' +
              legalCase.demand_letters.map(function (d) {
                return '<button type="button" class="btn-quiet" data-download-doc="' + esc(d.id) + '">Download demand letter (' +
                  esc(fmtDate(d.generated_at)) + ')</button>';
              }).join(' ') +
            '</p>'
          : '<p class="field-hint">No demand letter was generated for this case.</p>') +
        '<div class="field"><label for="lc-status">Status</label>' +
          '<select class="select" id="lc-status" name="status">' +
            options(LEGAL_CASE_STATUSES.map(function (s) { return { id: s[0], name: s[1] }; }), 'id', 'name', legalCase.status) +
          '</select></div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="lc-lawyer-name">Lawyer name</label>' +
            '<input class="input" id="lc-lawyer-name" name="lawyer_name" value="' + esc(legalCase.lawyer_name || '') + '"></div>' +
          '<div class="field"><label for="lc-lawyer-phone">Lawyer phone</label>' +
            '<input class="input" id="lc-lawyer-phone" name="lawyer_phone" value="' + esc(legalCase.lawyer_phone || '') + '"></div>' +
        '</div>' +
        '<div class="field"><label for="lc-lawyer-email">Lawyer email</label>' +
          '<input class="input" id="lc-lawyer-email" name="lawyer_email" type="email" value="' + esc(legalCase.lawyer_email || '') + '"></div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="lc-settlement-amount">Settlement amount</label>' +
            '<div class="input-money"><input class="input" id="lc-settlement-amount" name="settlement_amount" type="number" min="0" step="1" value="' + esc(legalCase.settlement_amount || '') + '"></div></div>' +
          '<div class="field"><label for="lc-settlement-date">Settlement date</label>' +
            '<input class="input" id="lc-settlement-date" name="settlement_date" type="date" value="' + esc((legalCase.settlement_date || '').slice(0, 10)) + '"></div>' +
        '</div>' +
        '<div class="field"><label for="lc-notes">Notes</label>' +
          '<textarea class="input" id="lc-notes" name="notes" rows="3">' + esc(legalCase.notes || '') + '</textarea></div>',
      submitLabel: 'Save',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        await api.patch('/legal-cases/' + caseId, {
          status: v.status,
          lawyer_name: v.lawyer_name || null,
          lawyer_phone: v.lawyer_phone || null,
          lawyer_email: v.lawyer_email || null,
          settlement_amount: v.settlement_amount,
          settlement_date: v.settlement_date || null,
          notes: v.notes || null,
        });
        close();
        toast('Legal case updated.', 'ok');
      },
    });

    R.onClick(R.el('overlay'), '[data-download-doc]', async function (button) {
      var result = await api('/documents/' + button.dataset.downloadDoc + '/download');
      R.openFile(result.download_url);
    });
  }

  var FINANCING_STATUSES = [
    ['pending', 'Pending'], ['submitted', 'Submitted'], ['under_review', 'Under review'],
    ['approved', 'Approved'], ['rejected', 'Rejected'], ['disbursed', 'Disbursed'],
  ];

  // SECTION 9 — owner only (financing.manage). No GET /financing-requests/:id
  // route exists (the spec's own route list has none) — the row already
  // sitting in the Reports screen's fetched list is enough to populate this.
  async function manageFinancingModal(id, requests) {
    var request = requests.find(function (r) { return r.id === id; });
    if (!request) return;

    R.modal({
      title: 'Financing request — ' + (request.re_customers ? request.re_customers.full_name : 'buyer'),
      body:
        '<p class="field-hint">' + esc(request.bank_name) + ' · ' + esc(naira(request.amount_requested)) +
          (request.notes ? '<br>' + esc(request.notes) : '') + '</p>' +
        '<div class="field"><label for="fr-status">Status</label>' +
          '<select class="select" id="fr-status" name="status">' +
            options(FINANCING_STATUSES.map(function (s) { return { id: s[0], name: s[1] }; }), 'id', 'name', request.status) +
          '</select></div>' +
        '<div class="field"><label for="fr-reference">Bank reference</label>' +
          '<input class="input" id="fr-reference" name="bank_reference" value="' + esc(request.bank_reference || '') + '"></div>' +
        '<div class="field"><label for="fr-notes">Notes</label>' +
          '<textarea class="input" id="fr-notes" name="notes" rows="3">' + esc(request.notes || '') + '</textarea></div>',
      submitLabel: 'Save',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        await api.patch('/financing-requests/' + id, {
          status: v.status,
          bank_reference: v.bank_reference || null,
          notes: v.notes || null,
        });
        close();
        toast('Financing request updated.', 'ok');
      },
    });
  }

  var LEADERBOARD_PERIODS = ['this_month', 'last_3_months', 'this_year', 'all_time'];
  var LEADERBOARD_PERIOD_LABELS = { this_month: 'This month', last_3_months: 'Last 3 months', this_year: 'This year', all_time: 'All time' };
  // Column key -> [label shown in the "Sort by" pill, comparator]. Every
  // comparator sorts DESCENDING (highest first) except default_rate, where
  // lower is better — sorting a "default rate" column ascending-by-default
  // would put the worst-performing rep on top, the opposite of every other
  // column here.
  var LEADERBOARD_SORTS = {
    total_collected: ['Collected', function (a, b) { return b.total_collected - a.total_collected; }],
    total_contracted: ['Contracted', function (a, b) { return b.total_contracted - a.total_contracted; }],
    deals_closed: ['Deals closed', function (a, b) { return b.deals_closed - a.deals_closed; }],
    collection_rate: ['Collection rate', function (a, b) { return b.collection_rate - a.collection_rate; }],
    default_rate: ['Default rate', function (a, b) { return a.default_rate - b.default_rate; }],
    commission_earned: ['Commission earned', function (a, b) { return b.commission_earned - a.commission_earned; }],
  };
  var leaderboardSort = 'total_collected'; // module-level: survives a sort-pill click's local re-render, resets on navigation away like projectFilter above

  function leaderboardTableHtml(rows) {
    var sorted = rows.slice().sort(LEADERBOARD_SORTS[leaderboardSort][1]);
    return table(
      [{ label: 'Rank' }, { label: 'Rep' }, { label: 'Deals closed', num: true, hideMobile: true },
        { label: 'Contracted', num: true, hideMobile: true }, { label: 'Collected', num: true },
        { label: 'Collection rate', num: true, hideMobile: true }, { label: 'Default rate', num: true, hideMobile: true },
        { label: 'Commission earned', num: true }],
      sorted,
      function (r, i) {
        return '<tr>' +
          '<td class="muted">' + (i + 1) + '</td>' +
          '<td class="cell-primary">' + esc(r.name) + (r.active ? '' : ' <span class="muted">(inactive)</span>') + '</td>' +
          '<td class="num hide-mobile">' + r.deals_closed + '</td>' +
          '<td class="num hide-mobile">' + nairaShort(r.total_contracted) + '</td>' +
          '<td class="num moss">' + nairaShort(r.total_collected) + '</td>' +
          '<td class="num hide-mobile ' + (r.collection_rate >= 70 ? 'moss' : r.collection_rate < 40 ? 'clay' : '') + '">' + r.collection_rate + '%</td>' +
          '<td class="num hide-mobile ' + (r.default_rate > 10 ? 'clay' : '') + '">' + r.default_rate + '%</td>' +
          '<td class="num gold">' + nairaShort(r.commission_earned) + '</td>' +
        '</tr>';
      },
      { emptyTitle: 'No sales reps with reservations in this period' }
    );
  }

  // SECTION 13 — the same 31-day figures the backend hands back
  // (bucketPaymentsByDayOfMonth), rendered 7-wide. Color intensity buckets
  // into 5 fixed classes rather than an inline style — this app's CSP has no
  // 'unsafe-inline' in style-src (see R.applyDynamicStyles's own comment
  // elsewhere in this file), so a computed color can't be a style attribute
  // any more than a computed bar height can.
  function heatmapGrid(heatmap) {
    var days = (heatmap && heatmap.days) || [];
    var max = (heatmap && heatmap.max_amount) || 0;
    if (!max) return R.emptyState('Not enough data yet.', 'Reports will populate as payments are recorded.', null, 'chart');
    return '<div class="heatmap-grid">' +
      days.map(function (d) {
        var bucket = d.amount <= 0 ? 0 : Math.min(4, Math.ceil((d.amount / max) * 4));
        return '<div class="hm-cell hm-' + bucket + '" title="Day ' + d.day + ': ' + esc(naira(d.amount)) + ' across ' + R.plural(d.count, 'payment') + '">' +
          '<span class="hm-day">' + d.day + '</span>' +
        '</div>';
      }).join('') +
    '</div>' +
    '<div class="page-sub mt-1">Darker = more collected on that day of the month, historically.</div>';
  }

  // SECTION 12 — mirrors routes/reports.js's CUSTOM_REPORT_FIELDS exactly
  // (key, label). Static on both ends, so duplicating the list here is a
  // fixed, one-time cost rather than an endpoint whose only job would be
  // handing back an array that never changes at runtime.
  var CUSTOM_REPORT_FIELD_OPTIONS = [
    ['buyer_name', 'Buyer name'], ['email', 'Email'], ['phone', 'Phone'],
    ['unit_number', 'Unit number'], ['project_name', 'Project name'],
    ['total_contracted', 'Total contracted'], ['total_paid', 'Total paid'],
    ['balance', 'Balance'], ['overdue_amount', 'Overdue amount'],
    ['credit_score', 'Credit score'], ['sales_rep_name', 'Sales rep name'],
    ['reservation_date', 'Reservation date'], ['last_payment_date', 'Last payment date'],
    ['next_due_date', 'Next due date'], ['escalation_stage', 'Escalation stage'],
    ['referral_code', 'Referral code'],
  ];
  var CUSTOM_REPORT_DEFAULT_FIELDS = CUSTOM_REPORT_FIELD_OPTIONS.map(function (f) { return f[0]; });

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
      var canReferrals = R.can('reports.referrals');
      var canForecast = R.can('reports.forecast');
      // SECTION 8 — owner only, same as reports.investor: this is exposure,
      // not a sales-book number a director's own reports.collections/
      // reports.rental tier would otherwise cover.
      var canLegal = R.can('legal.manage');
      // SECTION 9 — same owner-only tier as legal cases: "Owner can mark the
      // request as submitted... from the financing requests screen."
      var canFinancing = R.can('financing.manage');
      // SECTION 11/12/13 — leaderboard, custom report builder, payment
      // heatmap. All three DIRECTORS-tier (permissions.js), same as
      // reports.collections/reports.rental beside them.
      var canLeaderboard = R.can('reports.leaderboard');
      var canCustomExport = R.can('reports.customExport');
      var canHeatmap = R.can('reports.heatmap');
      // SECTION 18 — same DIRECTORS tier as the three above.
      var canSatisfaction = R.can('reports.satisfaction');
      var leaderboardPeriod = LEADERBOARD_PERIODS.indexOf(query.period) >= 0 ? query.period : 'all_time';

      var results = await Promise.all([
        canInvestor ? api('/reports/investor' + scope) : Promise.resolve(null),
        canCollections ? api('/reports/collections?months=12') : Promise.resolve(null),
        canRental ? api('/reports/rental') : Promise.resolve(null),
        canReferrals ? api('/reports/referrals') : Promise.resolve(null),
        canForecast ? api('/reports/forecast') : Promise.resolve(null),
        canLegal ? api('/legal-cases/summary') : Promise.resolve(null),
        canLegal ? api('/legal-cases?status=active') : Promise.resolve(null),
        canFinancing ? api('/financing-requests') : Promise.resolve(null),
        canLeaderboard ? api('/reports/leaderboard?period=' + leaderboardPeriod) : Promise.resolve(null),
        canHeatmap ? api('/reports/payment-heatmap') : Promise.resolve(null),
        canSatisfaction ? api('/reports/satisfaction') : Promise.resolve(null),
      ]);
      var report = results[0], collections = results[1], rental = results[2], referralStats = results[3], forecast = results[4];
      var legalSummary = results[5], legalCases = results[6], financingRequests = results[7];
      var leaderboard = results[8], heatmap = results[9], satisfaction = results[10];
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

        // SECTION 6 — owner-only, same tier as the investor view it sits
        // above. forecast is null on the very first load of a workspace with
        // no OPENAI_API_KEY AND no cached row yet — getOrGenerateForecast
        // always returns SOMETHING (a rule-based projection at minimum), so
        // null here only means the fetch itself hasn't resolved.
        (canForecast && forecast
          ? card('AI sales forecast',
              '<div class="flex-row justify-between align-start gap-10 mb-2">' +
                '<p class="page-sub">' + (forecast.generated_by === 'fallback' ? 'Rule-based projection' : 'AI-generated') +
                  ' · ' + esc(fmtDate(forecast.generated_at)) + (forecast.cached ? ' · cached' : '') + '</p>' +
                '<button class="btn-quiet" id="btn-regenerate-forecast">Regenerate</button>' +
              '</div>' +
              '<div class="grid cols-3 mb-2">' +
                stat('Next month', nairaShort(forecast.payload.projected_collections_3mo.month_1), { tone: 'gold' }) +
                stat('Month 2', nairaShort(forecast.payload.projected_collections_3mo.month_2)) +
                stat('Month 3', nairaShort(forecast.payload.projected_collections_3mo.month_3)) +
              '</div>' +
              '<p class="page-sub mb-2">' + esc(forecast.payload.projected_collections_3mo.reasoning) + '</p>' +

              (forecast.payload.project_completions.length
                ? '<div class="page-sub label-caps mb-1">Projected completion, at current collection rate</div>' +
                  forecast.payload.project_completions.map(function (p) {
                    return '<div class="flex-row justify-between gap-10 mb-1">' +
                      '<span>' + esc(p.project_name) + '</span>' +
                      '<span class="mono">' + (p.projected_completion_date ? esc(fmtDate(p.projected_completion_date)) : 'Not enough data') + '</span>' +
                    '</div>';
                  }).join('')
                : '') +

              (forecast.payload.default_risks.length
                ? '<div class="page-sub label-caps mt-2 mb-1">Buyers most likely to default within 60 days</div>' +
                  forecast.payload.default_risks.map(function (r) {
                    return '<div class="mb-1"><b>' + esc(r.customer_name) + '</b><div class="page-sub">' + esc(r.risk_reason) + '</div></div>';
                  }).join('')
                : '<p class="page-sub mt-2">No buyers currently flagged as at risk.</p>') +

              (forecast.payload.recommended_actions.length
                ? '<div class="page-sub label-caps mt-2 mb-1">Recommended actions</div>' +
                  '<ul class="mb-0">' + forecast.payload.recommended_actions.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul>'
                : ''),
              { flush: false })
          : '') +

        (canInvestor
          ? '<div class="grid cols-4 mb-2">' +
              stat('Gross development value', nairaShort(t.gross_development_value)) +
              stat('Contracted', nairaShort(t.contracted_value), { tone: 'gold' }) +
              stat('Collected to date', nairaShort(t.collected_total), { tone: 'moss' }) +
              stat('Receivables outstanding', nairaShort(t.receivables_outstanding), {
                sub: t.receivables_overdue ? nairaShort(t.receivables_overdue) + ' overdue' : 'none overdue',
                tone: t.receivables_overdue ? 'clay' : null,
              }) +
            '</div>'
          : '') +

        // SECTION 12 — the other side of the ledger: money going OUT to
        // contractors, on the same investor-only screen as money coming in.
        (canInvestor && report.contractor_payments
          ? '<div class="grid cols-3 mb-2">' +
              stat('Contractor payments — paid', nairaShort(report.contractor_payments.paid_total), { tone: 'moss' }) +
              stat('Contractor payments — pending', nairaShort(report.contractor_payments.pending_total)) +
              stat('Contractor payments — overdue', nairaShort(report.contractor_payments.overdue_total), {
                sub: R.plural(report.contractor_payments.overdue_count, 'payment'),
                tone: report.contractor_payments.overdue_count ? 'clay' : null,
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
              [{ label: 'Project' }, { label: 'Units', hideMobile: true }, { label: 'Sold', num: true, hideMobile: true },
                { label: 'Sell-through', num: true, hideMobile: true },
                { label: 'Contracted', num: true, hideMobile: true }, { label: 'Collected', num: true },
                { label: 'Collection rate', num: true, hideMobile: true },
                { label: 'Overdue', num: true }],
              report.projects,
              function (p) {
                return '<tr>' +
                  '<td class="cell-primary">' + esc(p.name) + '<div class="cell-meta">' + esc(p.location || '') + '</div></td>' +
                  '<td class="muted hide-mobile">' + p.units.total + '</td>' +
                  '<td class="num hide-mobile">' + p.units.sold + '</td>' +
                  '<td class="num muted hide-mobile">' + p.sell_through_rate + '%</td>' +
                  '<td class="num hide-mobile">' + nairaShort(p.contracted_value) + '</td>' +
                  '<td class="num moss">' + nairaShort(p.collected_total) + '</td>' +
                  '<td class="num hide-mobile ' + (p.collection_rate >= 70 ? 'moss' : p.collection_rate < 40 ? 'clay' : '') + '">' + p.collection_rate + '%</td>' +
                  '<td class="num ' + (p.receivables_overdue ? 'clay' : 'muted') + '">' + nairaShort(p.receivables_overdue) + '</td>' +
                '</tr>';
              },
              { emptyTitle: 'No projects to report on yet' }
            ), { flush: true })
          : '') +

        // SECTION 5 — cash-bonus totals are deliberately absent (see
        // routes/reports.js's own comment): cash leaves this product's
        // bookkeeping the moment it's handed over, so only what "credit"
        // actually moved is summed here.
        (canReferrals
          ? card('Referral network',
              '<div class="grid cols-3">' +
                stat('Total referrals', String(referralStats.total_referrals)) +
                stat('Conversion rate', referralStats.conversion_rate + '%', {
                  sub: referralStats.completed_referrals + ' converted',
                  tone: referralStats.conversion_rate >= 30 ? 'moss' : null,
                }) +
                stat('Credits given', nairaShort(referralStats.total_credits_given), { tone: 'gold' }) +
              '</div>', { flush: false })
          : '') +

        // SECTION 11 — sales rep leaderboard. Period is a URL query param
        // (full re-fetch on change, same idiom as query.project's scope
        // above); sort is a local, in-memory re-order (leaderboardSort,
        // module-level like projectFilter) so clicking "Sort by" doesn't
        // cost a network round trip for data already on the page.
        (canLeaderboard
          ? card('Sales rep leaderboard',
              '<div class="filter-row mb-1">' +
                LEADERBOARD_PERIODS.map(function (p) {
                  return '<a class="pill' + (leaderboardPeriod === p ? ' is-on' : '') + '" href="#/reports?period=' + p + '">' +
                    esc(LEADERBOARD_PERIOD_LABELS[p]) + '</a>';
                }).join('') +
              '</div>' +
              '<div class="filter-row mb-1">' +
                Object.keys(LEADERBOARD_SORTS).map(function (key) {
                  return '<a class="pill' + (leaderboardSort === key ? ' is-on' : '') + '" data-leaderboard-sort="' + key + '">' +
                    esc(LEADERBOARD_SORTS[key][0]) + '</a>';
                }).join('') +
              '</div>' +
              '<div id="leaderboard-table">' + leaderboardTableHtml(leaderboard.rows) + '</div>',
              { flush: true })
          : '') +

        // SECTION 12 — custom report builder. No preview fetch: the field
        // list is static (CUSTOM_REPORT_FIELDS on the server), so the whole
        // card is just a checklist and an Export button.
        (canCustomExport
          ? card('Custom report builder',
              '<p class="page-sub mb-2">Choose the columns you want, then export a CSV with only those.</p>' +
              '<div class="grid cols-3 mb-2" id="custom-report-fields">' +
                CUSTOM_REPORT_FIELD_OPTIONS.map(function (f) {
                  return '<label class="check"><input type="checkbox" value="' + esc(f[0]) + '"' +
                    (CUSTOM_REPORT_DEFAULT_FIELDS.indexOf(f[0]) >= 0 ? ' checked' : '') + '> ' + esc(f[1]) + '</label>';
                }).join('') +
              '</div>' +
              '<button class="btn primary" id="btn-custom-export">Export selected fields</button>',
              { flush: false })
          : '') +

        // SECTION 13 — payment-day heatmap. Day-of-month, not a real
        // calendar (see routes/reports.js's own comment on
        // bucketPaymentsByDayOfMonth for why day 15 has no single weekday to
        // anchor to across a workspace's whole history) — laid out 7-wide in
        // day order, which reads as calendar-like without claiming a
        // precision the data doesn't have.
        (canHeatmap
          ? card('When buyers pay', heatmapGrid(heatmap), { flush: false })
          : '') +

        // SECTION 18 — buyer satisfaction. completed_count is the honest
        // denominator (sent-but-unanswered surveys carry no score), so a
        // workspace that just started handing over units sees "no
        // responses yet" rather than a misleading 0.0 average.
        (canSatisfaction && satisfaction
          ? card('Buyer satisfaction',
              satisfaction.completed_count
                ? '<div class="grid cols-3 mb-2">' +
                    stat('Overall experience', satisfaction.average_overall_score != null ? satisfaction.average_overall_score + ' / 5' : '—') +
                    stat('Construction quality', satisfaction.average_construction_quality_score != null ? satisfaction.average_construction_quality_score + ' / 5' : '—') +
                    stat('Sales experience', satisfaction.average_sales_experience_score != null ? satisfaction.average_sales_experience_score + ' / 5' : '—') +
                  '</div>' +
                  '<div class="page-sub mb-1">' + R.plural(satisfaction.completed_count, 'response') + '</div>' +
                  (satisfaction.recent_comments.length
                    ? satisfaction.recent_comments.map(function (c) {
                        return '<div class="sched-history-row"><div class="page-sub">' + esc(c.customer_name) + ' · ' + esc(fmtDate(c.completed_at)) + '</div>' +
                          '<div>' + esc(c.comments) + '</div></div>';
                      }).join('')
                    : '')
                : R.emptyState('No survey responses yet', 'Sent automatically once a handover checklist is signed off.'),
              { flush: false })
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
                stat('Rental income this month', naira(rental.monthly_rental_income), { tone: 'gold' }) +
                stat('Current monthly rent roll', naira(rental.current_monthly_rent_roll)) +
              '</div>', { flush: false }) +

            card('Renewals due in the next 90 days', table(
              [{ label: 'Tenant' }, { label: 'Unit', hideMobile: true }, { label: 'Monthly rent', num: true },
                { label: 'Tenancy ends' }, { label: '' }],
              rental.upcoming_renewals,
              function (r) {
                return '<tr>' +
                  '<td class="cell-primary">' + esc(r.tenant_name || '—') + '</td>' +
                  '<td class="hide-mobile">' + esc(r.unit_number || '—') + '<div class="cell-meta">' + esc(r.project_name || '') + '</div></td>' +
                  '<td class="num">' + naira(r.current_monthly_rent) + '</td>' +
                  '<td class="muted">' + esc(fmtDate(r.tenancy_end_date)) +
                    '<div class="cell-meta">' + R.plural(r.days_remaining, 'day') + ' left</div></td>' +
                  '<td class="right"><button class="btn-quiet" data-renew="' + esc(r.reservation_id) +
                    '" data-buyer-name="' + esc(r.tenant_name || '') + '">Renew tenancy</button></td>' +
                '</tr>';
              },
              { emptyTitle: 'Nothing expiring soon', emptyHint: 'Renewals due in the next 90 days will appear here.' }
            ), { flush: true })
          : '') +

        // SECTION 8 — active cases, total exposure, what settled this month.
        (canLegal
          ? card('Legal cases',
              '<div class="grid cols-3">' +
                stat('Active cases', String(legalSummary.active_count), { tone: legalSummary.active_count ? 'clay' : null }) +
                stat('Total in dispute', nairaShort(legalSummary.total_in_dispute), { tone: 'clay' }) +
                stat('Settled this month', legalSummary.settled_this_month_count + ' · ' + nairaShort(legalSummary.settled_this_month_amount), { tone: 'moss' }) +
              '</div>', { flush: false })
          : '') +

        (canLegal
          ? card(null, table(
              [{ label: 'Buyer' }, { label: 'Unit', hideMobile: true }, { label: 'Lawyer', hideMobile: true }, { label: '' }],
              legalCases,
              function (c) {
                var unit = c.re_reservations && c.re_reservations.re_units;
                return '<tr>' +
                  '<td class="cell-primary">' + esc((c.re_customers && c.re_customers.full_name) || '—') + '</td>' +
                  '<td class="muted hide-mobile">' + esc((unit && unit.unit_number) || '—') +
                    '<div class="cell-meta">' + esc((unit && unit.re_projects && unit.re_projects.name) || '') + '</div></td>' +
                  '<td class="muted hide-mobile">' + esc(c.lawyer_name || '—') + '</td>' +
                  '<td class="right"><button class="btn-quiet" data-manage-case="' + esc(c.id) + '">Manage</button></td>' +
                '</tr>';
              },
              { emptyTitle: 'No active legal cases' }
            ), { flush: true })
          : '') +

        // SECTION 9 — bank financing requests, owner only.
        (canFinancing
          ? card('Financing requests', table(
              [{ label: 'Buyer' }, { label: 'Bank', hideMobile: true }, { label: 'Amount', num: true },
                { label: 'Status' }, { label: '' }],
              financingRequests,
              function (f) {
                return '<tr>' +
                  '<td class="cell-primary">' + esc((f.re_customers && f.re_customers.full_name) || '—') + '</td>' +
                  '<td class="muted hide-mobile">' + esc(f.bank_name) + '</td>' +
                  '<td class="num">' + naira(f.amount_requested) + '</td>' +
                  '<td>' + badge(f.status) + '</td>' +
                  '<td class="right"><button class="btn-quiet" data-manage-financing="' + esc(f.id) + '">Manage</button></td>' +
                '</tr>';
              },
              { emptyTitle: 'No financing requests yet' }
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

      R.onClick(view, '[data-manage-case]', async function (button) {
        await manageLegalCaseModal(button.dataset.manageCase);
        R.reload();
      });

      R.onClick(view, '[data-manage-financing]', async function (button) {
        await manageFinancingModal(button.dataset.manageFinancing, financingRequests);
        R.reload();
      });

      R.onClick(view, '#btn-regenerate-forecast', async function () {
        await api('/reports/forecast?regenerate=true');
        toast('Forecast regenerated.', 'ok');
        R.reload();
      });

      // Your data, in a file you keep. Also the only backup a developer
      // controls without a Supabase login.
      R.onClick(view, '[data-export]', async function (button) {
        var kind = button.dataset.export;
        await R.downloadCsv('/reports/export/' + kind, 'archta-' + kind + '.csv');
        toast('Exported. Check your downloads.', 'ok');
      });

      // SECTION 11 — sort is local, in-memory: the data for every rep is
      // already on the page (leaderboard.rows), so re-ordering it needs no
      // round trip. Only the table + sort pills re-render, not the period
      // pills or the rest of the screen.
      R.onClick(view, '[data-leaderboard-sort]', function (button) {
        leaderboardSort = button.dataset.leaderboardSort;
        R.qsa('[data-leaderboard-sort]', view).forEach(function (pill) {
          pill.classList.toggle('is-on', pill.dataset.leaderboardSort === leaderboardSort);
        });
        var target = R.qs('#leaderboard-table', view);
        if (target) target.innerHTML = leaderboardTableHtml(leaderboard.rows);
      });

      // SECTION 12 — at least one field required, same rule the server
      // enforces (buildCustomReportColumns) — checked here first so a click
      // with nothing selected gets an immediate answer instead of a 400
      // round trip.
      R.onClick(view, '#btn-custom-export', async function () {
        var checked = R.qsa('#custom-report-fields input[type="checkbox"]:checked', view)
          .map(function (input) { return input.value; });
        if (!checked.length) {
          toast('Choose at least one field first.', 'err');
          return;
        }
        await R.downloadCsv('/reports/custom-export?fields=' + checked.join(','), 'archta-custom-report.csv');
        toast('Exported. Check your downloads.', 'ok');
      });
    },
  };

  /* ══ SETTINGS ═══════════════════════════════════════════════════════════ */
  R.screens.settings = {
    render: async function (view, params, query) {
      var tab = query.tab || 'workspace';

      var tabs = '<div class="filter-row">' +
        [['workspace', 'Workspace'], ['team', 'Team & reps'], ['attendance', 'Attendance'], ['notifications', 'Notifications'], ['templates', 'Document templates'],
          ['activity', 'Activity log'], ['bin', 'Bin']].map(function (t) {
          return '<a class="pill' + (tab === t[0] ? ' is-on' : '') + '" href="#/settings?tab=' + t[0] + '">' + t[1] + '</a>';
        }).join('') + '</div>';

      if (tab === 'activity') return activityTab(view, tabs);
      if (tab === 'team') return teamTab(view, tabs);
      if (tab === 'attendance') return attendanceTab(view, tabs, query.month);
      if (tab === 'notifications') return notificationsTab(view, tabs);
      if (tab === 'templates') return templatesTab(view, tabs);
      if (tab === 'bin') return binTab(view, tabs, query.of || 'customers');
      return workspaceTab(view, tabs);
    },
  };

  // SECTION 8 — document template editor. Owner-only content behind a tab
  // anyone who can open Settings can click through to (same as every other
  // owner-gated card on the Workspace tab) — the API itself (settings.write)
  // is the real gate; this just avoids a confusing empty screen for someone
  // who taps the tab without the permission to save anything here.
  async function templatesTab(view, tabs) {
    view.innerHTML = head('Settings', 'The default Nigerian-law template for each legal document type, customizable per workspace.') + tabs +
      (R.can('settings.write')
        ? '<div class="card"><div class="card-body">' +
            '<div class="field"><label for="tpl-select">Document type</label>' +
              '<select class="select" id="tpl-select"></select></div>' +
            '<div class="field"><label for="tpl-html">Template HTML</label>' +
              '<textarea class="textarea mono-input" id="tpl-html" rows="18"></textarea>' +
              '<p class="field-hint">Placeholders: <code>{{buyer_name}}</code>, <code>{{unit_number}}</code>, ' +
                '<code>{{unit_type}}</code>, <code>{{project_name}}</code>, <code>{{project_location}}</code>, ' +
                '<code>{{total_amount}}</code>, <code>{{date}}</code>, <code>{{company_name}}</code>, ' +
                '<code>{{reference_number}}</code>, and <code>{{signature_block}}</code> — the buyer\'s actual ' +
                'signature, which must appear somewhere in the template or saving is refused.</p>' +
            '</div>' +
            '<div class="btn-row"><button class="btn primary" id="tpl-save">Save</button>' +
              '<button class="btn" id="tpl-reset">Reset to default</button></div>' +
            '<p class="page-sub mt-1" id="tpl-status"></p>' +
          '</div></div>' +

          // SECTION 5 — receipt header/footer only: what a receipt actually
          // STATES (amount, receipt number, installment breakdown) is never
          // editable here, same boundary receiptService.buildReceiptHtml
          // enforces server-side.
          '<div class="card"><div class="card-head"><div class="card-title">Receipt template</div></div>' +
            '<div class="card-body">' +
              '<p class="field-hint mb-2">Customize the letterhead and footer of your payment receipts. ' +
                'The amount, receipt number and installment details are never editable.</p>' +
              '<label class="check mb-1"><input type="checkbox" id="rtpl-logo" checked> Show company logo in the default header</label>' +
              '<label class="check mb-2"><input type="checkbox" id="rtpl-address" checked> Show company address/phone in the default footer</label>' +
              '<div class="grid cols-2">' +
                '<div class="field"><label for="rtpl-header">Header HTML <span class="muted">(optional — replaces the default letterhead)</span></label>' +
                  '<textarea class="textarea mono-input" id="rtpl-header" rows="6" maxlength="2000" placeholder="Leave blank to use the default company name + logo"></textarea></div>' +
                '<div class="field"><label>Preview</label><div class="receipt-preview" id="rtpl-header-preview"></div></div>' +
              '</div>' +
              '<div class="grid cols-2">' +
                '<div class="field"><label for="rtpl-footer">Footer HTML <span class="muted">(optional — replaces the default disclaimer/contact line)</span></label>' +
                  '<textarea class="textarea mono-input" id="rtpl-footer" rows="4" maxlength="1000" placeholder="Leave blank to use the default disclaimer"></textarea></div>' +
                '<div class="field"><label>Preview</label><div class="receipt-preview" id="rtpl-footer-preview"></div></div>' +
              '</div>' +
              '<button class="btn primary" id="rtpl-save">Save receipt template</button>' +
            '</div></div>'
        : '<div class="card"><div class="card-body"><p class="muted">Only the workspace owner can customize document templates.</p></div></div>');

    if (!R.can('settings.write')) return;

    var receiptTemplate = await api('/settings/receipt-template');
    R.el('rtpl-logo').checked = receiptTemplate.show_logo !== false;
    R.el('rtpl-address').checked = receiptTemplate.show_developer_address !== false;
    R.el('rtpl-header').value = receiptTemplate.header_html || '';
    R.el('rtpl-footer').value = receiptTemplate.footer_html || '';

    function refreshReceiptPreview() {
      // The developer's own content, previewed in their own browser as
      // they type it — the same trust boundary the template actually
      // renders under server-side (receiptService's own comment: owner-
      // authored HTML, not buyer-supplied), so innerHTML here is fine.
      R.el('rtpl-header-preview').innerHTML = R.el('rtpl-header').value || '<span class="muted">Default letterhead</span>';
      R.el('rtpl-footer-preview').innerHTML = R.el('rtpl-footer').value || '<span class="muted">Default disclaimer</span>';
    }
    refreshReceiptPreview();
    R.el('rtpl-header').addEventListener('input', refreshReceiptPreview);
    R.el('rtpl-footer').addEventListener('input', refreshReceiptPreview);

    R.onClick(view, '#rtpl-save', async function () {
      var headerHtml = R.el('rtpl-header').value;
      var footerHtml = R.el('rtpl-footer').value;
      if (headerHtml.length > 2000) throw new Error('Header HTML must be 2000 characters or fewer.');
      if (footerHtml.length > 1000) throw new Error('Footer HTML must be 1000 characters or fewer.');

      await api.patch('/settings/receipt-template', {
        header_html: headerHtml,
        footer_html: footerHtml,
        show_logo: R.el('rtpl-logo').checked,
        show_developer_address: R.el('rtpl-address').checked,
      });
      toast('Receipt template saved.', 'ok');
    });

    var templates = await api('/documents/templates');
    var select = R.el('tpl-select');
    select.innerHTML = templates.map(function (t) {
      return '<option value="' + t.doc_type + '">' +
        formatDocType(t.doc_type) + (t.is_custom ? ' (customized)' : ' (default)') + '</option>';
    }).join('');

    function renderCurrent() {
      var t = templates.filter(function (x) { return x.doc_type === select.value; })[0];
      R.el('tpl-html').value = t.template_html;
      R.el('tpl-status').textContent = t.is_custom
        ? 'This workspace has customized this template.'
        : 'Using the shipped default template.';
    }
    renderCurrent();
    select.addEventListener('change', renderCurrent);

    R.onClick(view, '#tpl-save', async function () {
      var updated = await api.put('/documents/templates/' + select.value, { template_html: R.el('tpl-html').value });
      var idx = templates.findIndex(function (x) { return x.doc_type === select.value; });
      templates[idx] = updated;
      select.options[select.selectedIndex].text = select.value.replace(/_/g, ' ') + ' (customized)';
      R.el('tpl-status').textContent = 'This workspace has customized this template.';
      toast('Template saved.', 'ok');
    });

    R.onClick(view, '#tpl-reset', async function () {
      var updated = await api.put('/documents/templates/' + select.value, { template_html: '' });
      var idx = templates.findIndex(function (x) { return x.doc_type === select.value; });
      templates[idx] = updated;
      select.options[select.selectedIndex].text = select.value.replace(/_/g, ' ') + ' (default)';
      renderCurrent();
      toast('Reset to the default template.', 'ok');
    });
  }

  async function workspaceTab(view, tabs) {
    // FEATURE — VAT compliance. Its own endpoint (not folded into GET
    // /settings) because it is owner-only end to end, same as Paystack/
    // WhatsApp above — only fetched at all when this caller can act on it,
    // matching those two cards' own conditional render.
    var canConfigureVat = R.can('settings.write');
    var results = await Promise.all([api('/settings'), canConfigureVat ? api('/settings/vat') : Promise.resolve(null)]);
    var settings = results[0], vatSettings = results[1];

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
              ? '<p class="field-hint mb-2">Without your own Paystack keys, buyers cannot pay online. Add your Paystack public and secret keys so payments go directly into your account.</p>' +
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

          // SECTION 5 — off (reward type 'none') until a developer opts in, so
          // a workspace that never opens this card is never on the hook for a
          // reward nobody configured — see migrations/024's default.
          card('Referral rewards', '<p class="field-hint mb-2">Every buyer gets their own code automatically. ' +
            'Choose what happens when someone they referred makes their first payment.</p>' +
            '<form id="form-referrals">' +
              '<div class="field"><label for="s-ref-type">Reward</label>' +
                '<select class="select" id="s-ref-type" name="referral_reward_type">' +
                  ['none', 'credit', 'cash'].map(function (t) {
                    var labels = { none: 'No reward — track referrals only', credit: 'Balance credit (applied automatically)', cash: 'Cash bonus (paid manually — files a task for the owner)' };
                    return '<option value="' + t + '"' + (settings.referral_reward_type === t ? ' selected' : '') + '>' + labels[t] + '</option>';
                  }).join('') +
                '</select></div>' +
              '<div class="field"><label for="s-ref-amount">Reward amount (₦)</label>' +
                '<input class="input" id="s-ref-amount" name="referral_reward_amount" type="number" min="0" step="0.01" value="' + esc(settings.referral_reward_amount || 0) + '"></div>' +
              '<button class="btn primary mt-1" type="submit">Save reward</button>' +
            '</form>') +
        '</div>' +

        '<div>' +
          // SECTION 5/9 — no platform-wide fallback the way Email/SMS have
          // one (see notificationService.resolveWhatsAppCredentials) — a
          // workspace without its own Meta Business account simply has no
          // WhatsApp send capability yet, which is why there is no "Not
          // configured, sends from the default" wording here.
          card('WhatsApp',
            (R.can('settings.write')
              ? '<p class="field-hint mb-2">From a Meta Business app with WhatsApp Cloud API enabled. Powers referral notifications and the WhatsApp mini app — a buyer messaging this number can check their balance, see their next payment, pay online or get their receipt automatically.</p>' +
                '<p class="field-hint mb-2">Webhook URL for the Meta App dashboard: <code>' + esc((window.__API_BASE__ || '') + '/webhooks/whatsapp') + '</code></p>' +
                '<form id="form-whatsapp">' +
                  '<div class="field"><label for="s-wa-phone">Phone number ID</label>' +
                    '<input class="input" id="s-wa-phone" name="whatsapp_phone_number_id" value="' + esc(settings.whatsapp_phone_number_id || '') + '"></div>' +
                  '<div class="field"><label for="s-wa-business">Business account ID</label>' +
                    '<input class="input" id="s-wa-business" name="whatsapp_business_account_id" value="' + esc(settings.whatsapp_business_account_id || '') + '"></div>' +
                  '<div class="field"><label for="s-wa-token">Access token</label>' +
                    '<input class="input" id="s-wa-token" name="whatsapp_token" type="password" autocomplete="off" placeholder="' +
                      (settings.whatsapp_configured ? 'Configured, ending in ' + esc(settings.whatsapp_token_last4) + ' — leave blank to keep' : 'EAAG…') + '">' +
                    '<p class="field-hint">Never shown again once saved. Leave blank to keep the current token.</p></div>' +
                  '<button class="btn primary mt-1" type="submit">Save</button>' +
                '</form>'
              : '<p class="muted">' +
                (settings.whatsapp_configured
                  ? 'Configured.'
                  : 'Not configured — referral notifications will not reach buyers over WhatsApp.') +
                ' Only the workspace owner can change this.</p>')) +

          // FEATURE — VAT compliance. Owner only, same tier as Paystack and
          // WhatsApp above — this decides what every receipt from here on
          // states was charged in tax, workspace-wide.
          (canConfigureVat
            ? card('VAT Configuration', '<p class="field-hint mb-2">' +
                'Nigeria standard rate is 7.5%. Applies to every payment recorded from the moment you save this, ' +
                'not retroactively — past receipts keep showing whatever was true when they were issued.</p>' +
                '<form id="form-vat">' +
                  '<label class="check mb-2"><input type="checkbox" id="s-vat-enabled" name="enabled"' +
                    (vatSettings.enabled ? ' checked' : '') + '> <span>Enable VAT</span></label>' +
                  '<div class="field"><label for="s-vat-rate">VAT rate (%)</label>' +
                    '<input class="input" id="s-vat-rate" name="rate" type="number" min="0" max="100" step="0.1" value="' + esc(vatSettings.rate) + '"></div>' +
                  '<div class="field"><label for="s-vat-inclusive">Prices are</label>' +
                    '<select class="select" id="s-vat-inclusive" name="inclusive">' +
                      '<option value="false"' + (!vatSettings.inclusive ? ' selected' : '') + '>VAT-exclusive (added on top)</option>' +
                      '<option value="true"' + (vatSettings.inclusive ? ' selected' : '') + '>VAT-inclusive (already included)</option>' +
                    '</select></div>' +
                  '<button class="btn primary mt-1" type="submit">Save VAT settings</button>' +
                '</form>')
            : '') +

          // SECTION 25 — owner only, same tier as everything else this
          // workspace's whole book is worth (the investor report, the full
          // audit export).
          (R.can('settings.backup')
            ? card('Data backup', '<p class="field-hint mb-2">Every buyer, reservation, payment, document, unit, project, ' +
                'commission, activity and audit entry as one CSV each, zipped. Once a day.</p>' +
                '<button class="btn" type="button" id="btn-workspace-backup">Download backup</button>')
            : '') +
        '</div>' +
      '</div>';

    guardedSubmit(R.qs('#form-org', view), async function (form) {
      await api.put('/settings', R.values(form));
      toast('Company details saved.', 'ok');
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

    guardedSubmit(R.qs('#form-referrals', view), async function (form) {
      await api.put('/settings', R.values(form));
      toast('Referral reward saved.', 'ok');
    });

    R.onClick(view, '#btn-test-paystack', async function () {
      var secretKey = R.qs('#s-pk-secret', view).value.trim();
      if (!secretKey) { toast('Enter a secret key to test first.', 'err'); return; }
      var result = await api.post('/settings/paystack/test', { secret_key: secretKey });
      toast(result.valid ? 'Paystack key is valid.' : (result.reason || 'Paystack rejected this key.'), result.valid ? 'ok' : 'err');
    });

    var vatForm = R.qs('#form-vat', view);
    if (vatForm) {
      guardedSubmit(vatForm, async function (form) {
        var v = R.values(form);
        await api.patch('/settings/vat', { enabled: v.enabled, rate: v.rate, inclusive: v.inclusive === 'true' });
        toast('VAT settings saved.', 'ok');
        R.reload();
      });
    }

    var whatsappForm = R.qs('#form-whatsapp', view);
    if (whatsappForm) {
      guardedSubmit(whatsappForm, async function (form) {
        var v = R.values(form);
        var payload = {
          whatsapp_phone_number_id: v.whatsapp_phone_number_id || null,
          whatsapp_business_account_id: v.whatsapp_business_account_id || null,
        };
        if (v.whatsapp_token) payload.whatsapp_token = v.whatsapp_token;
        await api.put('/settings/whatsapp', payload);
        toast('WhatsApp settings saved.', 'ok');
        R.reload();
      });
    }

    // R.onClick already disables the button and shows is-working for the
    // duration, and toasts a thrown error — no manual try/catch needed here,
    // same as every other button on this screen.
    R.onClick(view, '#btn-workspace-backup', async function () {
      var result = await api.post('/settings/backup', {});
      // R.openFile clicks a real anchor — CLAUDE.md's own "Downloads go
      // through R.openFile()" gotcha: a bare window.open here would be
      // dropped by a mobile popup blocker since the signed URL had to be
      // awaited first.
      R.openFile(result.url, 'archta-backup-' + R.todayISO() + '.zip');
      toast('Backup ready — ' + result.tables.length + ' files, ' + Math.round(result.size_bytes / 1024) + ' KB.', 'ok');
    });
  }

  // TASK 2.11 — split out of workspaceTab: escalation email, reply-to,
  // receipt/alert toggles, and the two provider cards (Resend, Termii) that
  // used to live on the Workspace tab. Every field, every endpoint and every
  // test button here is unchanged from workspaceTab's own — this is a move,
  // not a rebuild, since all of it already worked.
  // SECTION 14 — labels + a one-line description of when each type sends,
  // so a developer editing "document_ready" without opening the code still
  // knows what triggers it. overdue_reminder and welcome are shown as
  // "Not yet sent automatically" — see notificationService.js's own
  // comment on why those two are configurable but not wired to a live send.
  var EMAIL_TEMPLATE_META = {
    receipt: ['Payment receipt', 'Sent to the buyer every time a payment is recorded.'],
    portal_link: ['Portal link', 'Sent when staff email a buyer their payment-account link.'],
    document_ready: ['Document ready to sign', 'Sent when a deed, subscriber’s agreement or power of attorney is generated.'],
    overdue_reminder: ['Overdue reminder', 'Not yet sent automatically — buyer reminders currently go by SMS only.'],
    welcome: ['Welcome', 'Not yet sent automatically — this deployment sends no email at sign-up.'],
  };
  var EMAIL_TEMPLATE_VARIABLES = ['buyer_name', 'amount', 'unit', 'due_date', 'portal_link'];

  function emailTemplateRow(t) {
    var meta = EMAIL_TEMPLATE_META[t.template_type] || [t.template_type, ''];
    return '<div class="drawer-section">' +
      '<div class="flex-row justify-between gap-10">' +
        '<div><b>' + esc(meta[0]) + '</b><div class="page-sub">' + esc(meta[1]) + '</div></div>' +
        (t.is_custom ? badge('generated') : badge('pending')) +
      '</div>' +
      '<div class="mt-1"><button class="btn-quiet" data-toggle-email-template="' + esc(t.template_type) + '">' +
        (t.is_custom ? 'Edit' : 'Customize') + '</button></div>' +
      '<div class="hidden mt-2" data-email-template-editor="' + esc(t.template_type) + '">' +
        '<div class="field"><label for="et-subject-' + esc(t.template_type) + '">Subject</label>' +
          '<input class="input" id="et-subject-' + esc(t.template_type) + '" value="' + esc(t.subject) + '" maxlength="200"></div>' +
        '<div class="field"><label for="et-body-' + esc(t.template_type) + '">Body (HTML)</label>' +
          '<textarea class="textarea mono-input" id="et-body-' + esc(t.template_type) + '" rows="8" maxlength="5000">' + esc(t.body_html) + '</textarea>' +
          '<p class="field-hint">Available variables: ' +
            EMAIL_TEMPLATE_VARIABLES.map(function (v) { return '<code>{{' + v + '}}</code>'; }).join(', ') + '</p></div>' +
        '<div class="field-row">' +
          '<button class="btn primary" data-save-email-template="' + esc(t.template_type) + '">Save</button>' +
          (t.is_custom ? '<button class="btn" data-reset-email-template="' + esc(t.template_type) + '">Reset to default</button>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  async function notificationsTab(view, tabs) {
    var canManageTemplates = R.can('settings.write');
    var results = await Promise.all([
      api('/settings'),
      canManageTemplates ? api('/settings/email-templates') : Promise.resolve([]),
    ]);
    var settings = results[0];
    var emailTemplates = results[1];

    view.innerHTML = head('Settings', 'Who gets told what, and which of your own providers send it.') + tabs +
      '<div class="grid cols-2">' +
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
        '</div>' +

        '<div>' +
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

          (canManageTemplates
            ? card('Email templates', emailTemplates.map(emailTemplateRow).join(''), { flush: true })
            : '') +
        '</div>' +
      '</div>';

    guardedSubmit(R.qs('#form-notify', view), async function (form) {
      await api.put('/settings', R.values(form));
      toast('Preferences saved.', 'ok');
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

    // SECTION 14 — same show/hide-behind-a-toggle idiom as every other
    // "expand for detail" control on this screen set (plan history, previous
    // document versions), not a real tab: five editors on screen at once
    // would be a wall of textareas nobody scrolls past.
    R.qsa('[data-toggle-email-template]', view).forEach(function (button) {
      button.addEventListener('click', function () {
        var editor = R.qs('[data-email-template-editor="' + button.dataset.toggleEmailTemplate + '"]', view);
        editor.classList.toggle('hidden');
      });
    });

    R.onClick(view, '[data-save-email-template]', async function (button) {
      var type = button.dataset.saveEmailTemplate;
      var subject = R.qs('#et-subject-' + type, view).value.trim();
      var bodyHtml = R.qs('#et-body-' + type, view).value.trim();
      if (!subject || !bodyHtml) {
        toast('Both a subject and a body are required.', 'err');
        return;
      }
      await api.patch('/settings/email-templates/' + type, { subject: subject, body_html: bodyHtml });
      toast('Template saved.', 'ok');
      R.reload();
    });

    R.onClick(view, '[data-reset-email-template]', async function (button) {
      var type = button.dataset.resetEmailTemplate;
      var confirmed = await R.confirm({
        title: 'Reset this template?',
        message: 'This deletes your customization and goes back to the built-in email.',
        confirmLabel: 'Reset',
      });
      if (!confirmed) return;
      await api.patch('/settings/email-templates/' + type, { subject: '', body_html: '' });
      toast('Reset to the default.', 'ok');
      R.reload();
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
        [{ label: 'Name' }, { label: 'Email', hideMobile: true }, { label: 'Role' },
          { label: 'Last active', hideMobile: true }, { label: 'Status' }, { label: '' }],
        team.members,
        function (m) {
          var canManage = m.role !== 'owner' && m.id && R.can('team.manageMembers');
          return '<tr>' +
            '<td class="cell-primary">' + esc(m.full_name || '—') + '</td>' +
            '<td class="muted hide-mobile">' + esc(m.email || '') + '</td>' +
            '<td class="muted">' + esc(m.role_label || m.role) +
              (m.status === 'invited' && m.invited_role && m.invited_role !== m.role
                ? '<div class="cell-meta">invited as ' + esc(m.invited_role) + '</div>' : '') + '</td>' +
            '<td class="muted hide-mobile">' + esc(m.last_login_at ? R.fmtRelative(m.last_login_at) : 'never signed in') + '</td>' +
            '<td>' + badge(m.status) + '</td>' +
            // The owner cannot be removed or re-roled — the API refuses it,
            // and offering the buttons anyway is just a dead end with a
            // confirmation on it. nowrap keeps up to three buttons on one
            // tidy line on desktop; people-actions lets them wrap onto their
            // own lines once the row is too narrow for that, on mobile.
            '<td class="right nowrap people-actions">' + (
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
        [{ label: 'Rep' }, { label: 'Email', hideMobile: true }, { label: 'Commission', num: true }, { label: 'Status' }, { label: '' }],
        reps,
        function (rep) {
          return '<tr>' +
            '<td class="cell-primary">' + esc((rep.users && rep.users.full_name) || '—') + '</td>' +
            '<td class="muted hide-mobile">' + esc((rep.users && rep.users.email) || '') + '</td>' +
            '<td class="num">' + (rep.commission_rate || 0) + '%</td>' +
            '<td>' + badge(rep.active ? 'active' : 'none') + '</td>' +
            '<td class="right nowrap">' +
              '<button class="btn-quiet" data-profile="' + esc(rep.id) + '">Profile</button> ' +
              '<button class="btn-quiet" data-rate="' + esc(rep.id) + '" data-current="' + esc(rep.commission_rate || 0) + '">Set rate</button>' +
            '</td>' +
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

    R.onClick(view, '[data-profile]', async function (button) {
      await repProfileModal(button.dataset.profile);
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

  // FEATURE — team attendance & log book. A calendar-style grid: one row per
  // active team member, one column per day of the selected month. Owner and
  // Sales Director only (attendance.read/attendance.manage in
  // permissions.js) — this tab is not reachable at all by any other role,
  // same convention every owner/director-only Settings section already
  // follows (see templatesTab's own comment on this).
  var ATTENDANCE_STATUSES = [
    ['present', 'Present', 'P'], ['late', 'Late', 'L'],
    ['half_day', 'Half day', 'H'], ['absent', 'Absent', 'A'],
  ];

  function attendanceStatusMeta(status) {
    return ATTENDANCE_STATUSES.find(function (s) { return s[0] === status; });
  }

  async function attendanceTab(view, tabs, monthParam) {
    if (!R.can('attendance.read')) {
      view.innerHTML = head('Attendance', '') + tabs +
        card(null, R.emptyState('Not available', 'Attendance is visible to the owner and Head of Sales.'));
      return;
    }

    var now = new Date();
    var month = /^\d{4}-\d{2}$/.test(monthParam || '') ? monthParam
      : String(now.getFullYear()) + '-' + String(now.getMonth() + 1).padStart(2, '0');
    var year = Number(month.slice(0, 4));
    var monthIndex = Number(month.slice(5, 7)) - 1;
    var daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    var days = [];
    for (var d = 1; d <= daysInMonth; d++) days.push(d);

    var results = await Promise.all([
      api('/settings/team'),
      api('/attendance?month=' + month),
    ]);
    var team = results[0], rows = results[1];

    // Invited-but-not-joined rows have no user_id yet — nothing to mark
    // attendance against until they actually have an account.
    var people = team.members.filter(function (m) { return m.user_id && m.status === 'active'; });

    var byPersonDay = {};
    rows.forEach(function (r) {
      byPersonDay[r.user_id + '|' + r.date] = r;
    });

    var canManage = R.can('attendance.manage');
    var monthLabel = new Date(year, monthIndex, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    var prevMonth = monthIndex === 0 ? (year - 1) + '-12' : year + '-' + String(monthIndex).padStart(2, '0');
    var nextMonth = monthIndex === 11 ? (year + 1) + '-01' : year + '-' + String(monthIndex + 2).padStart(2, '0');

    view.innerHTML = head('Attendance', 'Who was in, and when — one grid per month.') + tabs +
      '<div class="filter-row justify-between align-center">' +
        '<div class="btn-row">' +
          '<a class="btn-quiet" href="#/settings?tab=attendance&month=' + prevMonth + '">&larr; Prev</a>' +
          '<b>' + esc(monthLabel) + '</b>' +
          '<a class="btn-quiet" href="#/settings?tab=attendance&month=' + nextMonth + '">Next &rarr;</a>' +
        '</div>' +
        '<div class="page-sub">' +
          ATTENDANCE_STATUSES.map(function (s) { return '<span class="attendance-legend-item">' + s[2] + ' = ' + s[1] + '</span>'; }).join('  ') +
        '</div>' +
      '</div>' +
      (people.length
        ? '<div class="table-wrap"><table class="data attendance-grid"><thead><tr>' +
            '<th>Name</th>' +
            days.map(function (dNum) { return '<th>' + dNum + '</th>'; }).join('') +
          '</tr></thead><tbody>' +
            people.map(function (p) {
              return '<tr>' +
                '<td class="cell-primary nowrap">' + esc(p.full_name || p.email) + '</td>' +
                days.map(function (dNum) {
                  var date = month + '-' + String(dNum).padStart(2, '0');
                  var mark = byPersonDay[p.user_id + '|' + date];
                  var meta = mark && attendanceStatusMeta(mark.status);
                  return '<td class="attendance-cell' + (canManage ? ' is-clickable' : '') + (meta ? ' status-' + mark.status : '') + '"' +
                    (canManage ? ' data-mark-attendance data-user-id="' + esc(p.user_id) + '" data-user-name="' + esc(p.full_name || p.email) +
                      '" data-date="' + date + '" data-status="' + (mark ? mark.status : '') + '"' : '') +
                    '>' + (meta ? meta[2] : '') + '</td>';
                }).join('') +
              '</tr>';
            }).join('') +
          '</tbody></table></div>'
        : card(null, R.emptyState('No one to mark yet', 'Invite a team member from the Team & reps tab first.'))) +
      (canManage
        ? '<p class="page-sub mt-2">Click any day to mark or correct that person\'s attendance.</p>'
        : '');

    if (canManage) {
      R.qsa('[data-mark-attendance]', view).forEach(function (cell) {
        cell.addEventListener('click', function () {
          var userId = cell.dataset.userId, userName = cell.dataset.userName;
          var date = cell.dataset.date, current = cell.dataset.status;
          R.modal({
            title: 'Mark attendance — ' + userName,
            body:
              '<p class="page-sub mb-2">' + esc(fmtDate(date)) + '</p>' +
              '<div class="field"><label for="att-status">Status</label>' +
                '<select class="select" id="att-status" name="status">' +
                  ATTENDANCE_STATUSES.map(function (s) {
                    return '<option value="' + s[0] + '"' + (current === s[0] ? ' selected' : '') + '>' + s[1] + '</option>';
                  }).join('') +
                '</select></div>' +
              '<div class="field-row">' +
                '<div class="field"><label for="att-in">Check-in</label><input class="input" id="att-in" name="check_in_time" type="time"></div>' +
                '<div class="field"><label for="att-out">Check-out</label><input class="input" id="att-out" name="check_out_time" type="time"></div>' +
              '</div>' +
              '<div class="field"><label for="att-notes">Notes</label><textarea class="textarea" id="att-notes" name="notes"></textarea></div>',
            submitLabel: 'Save',
            onSubmit: async function (form, close) {
              var v = R.values(form);
              await api.post('/attendance', {
                user_id: userId, date: date, status: v.status,
                check_in_time: v.check_in_time || null, check_out_time: v.check_out_time || null,
                notes: v.notes || null,
              });
              close();
              toast('Attendance saved.', 'ok');
              R.reload();
            },
          });
        });
      });
    }
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
        || row.title || (row.doc_type ? formatDocType(row.doc_type) : null)
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

  /* FEATURE — a sales rep's profile from Settings → Team: what they are
     carrying right now, and a "Reassign all reservations" action for moving
     their WHOLE portfolio (not just the open deals the removal flow above
     moves) onto another rep in one deliberate action — a territory handover
     or portfolio rebalance while the rep is still active, not a response to
     them leaving. No submitLabel: like openAccountModal, this dialog holds
     one independent action wired to its own button rather than a form
     submit, so an onSubmit no-op keeps Enter from closing it. */
  async function repProfileModal(repId) {
    var summary = await api('/sales-reps/' + repId + '/summary');
    var rep = summary.rep;
    var hasTargets = summary.other_reps.length > 0;

    var panel = R.modal({
      title: rep.name,
      cancelLabel: 'Close',
      body:
        '<div class="grid cols-3 mb-2">' +
          stat('Commission', rep.commission_rate + '%') +
          stat('Reservations', String(summary.total_reservations)) +
          stat('Active', String(summary.active_reservations)) +
        '</div>' +
        (summary.total_reservations
          ? ('<div class="divider"></div>' +
            '<div class="field"><label for="rp-target">Reassign all reservations to</label>' +
              (hasTargets
                ? '<select class="select" id="rp-target" name="target_rep_id">' +
                    options(summary.other_reps.map(function (r) { return { id: r.id, name: r.name }; }), 'id', 'name') +
                  '</select>'
                : '<p class="muted">No other active rep in this workspace yet.</p>') +
            '</div>' +
            '<p class="field-hint">Moves every reservation this rep has ever held — including completed and cancelled ones — ' +
              'onto the rep chosen above. Commission already accrued stays credited to ' + esc(rep.name) +
              '; only future payments accrue to the new rep.</p>' +
            (hasTargets
              ? '<button class="btn danger" type="button" id="btn-reassign-all">Reassign all reservations</button>'
              : ''))
          : '<p class="muted mt-2">No reservations to reassign.</p>'),
      onSubmit: function () {},
    });

    R.onClick(panel.root, '#btn-reassign-all', async function () {
      var targetId = R.qs('#rp-target', panel.root).value;
      var confirmed = await R.confirm({
        title: 'Reassign all reservations?',
        message: 'This moves all ' + summary.total_reservations + ' of ' + rep.name +
          '’s reservations — including completed and cancelled ones — to another rep. This cannot be undone from here.',
        confirmLabel: 'Reassign',
        danger: true,
      });
      if (!confirmed) return;

      var result = await api.post('/sales-reps/' + repId + '/reassign', { target_rep_id: targetId });
      panel.close();
      toast(result.moved + ' reservation(s) reassigned to ' + result.to + '.', 'ok');
      R.reload();
    });
  }

  async function activityTab(view, tabs) {
    var results = await Promise.all([api('/audit?limit=150'), api('/audit/notifications?limit=60')]);
    var entries = results[0], notifications = results[1];
    // SECTION 24 — owner only (permissions.js's audit.export), narrower than
    // audit.read itself: a sales director may look at this screen, but
    // walking away with the whole log as a file is a different decision.
    var canExportAudit = R.can('audit.export');
    // FEATURE — system log with undo. Owner only (audit.undo, same tier as
    // several of the actions this can reverse).
    var canUndo = R.can('audit.undo');

    view.innerHTML = head('Activity log', 'Who did what, when. Append-only — nothing in this product can edit or delete it.',
      canExportAudit ? '<button class="btn" id="btn-export-audit">Export audit log</button>' : '') + tabs +

      (canExportAudit
        ? '<p class="page-sub clay mb-2">This file may contain sensitive information. Do not share it unless required for legal purposes.</p>'
        : '') +

      card('Actions', table(
        [{ label: 'When' }, { label: 'Who', hideMobile: true }, { label: 'Action' }, { label: 'Detail' }, { label: '' }],
        entries,
        function (e) {
          return '<tr>' +
            '<td class="muted nowrap">' + esc(R.fmtDateTime(e.created_at)) + '</td>' +
            '<td class="muted hide-mobile">' + esc(e.actor_email || e.actor_kind) + '</td>' +
            '<td><span class="mono fs-11-5">' + esc(e.action) + '</span></td>' +
            '<td class="muted">' + esc(e.summary || '') +
              (e.reversed_at ? '<div class="cell-meta">Undone ' + esc(R.fmtRelative(e.reversed_at)) + '</div>' : '') +
            '</td>' +
            '<td class="right">' +
              (canUndo && e.reversible && !e.reversed_at
                ? '<button class="btn-quiet" data-undo-audit="' + esc(e.id) + '" data-summary="' + esc(e.summary || e.action) + '">Undo</button>'
                : '') +
            '</td>' +
          '</tr>';
        },
        { emptyTitle: 'Nothing recorded yet' }
      ), { flush: true }) +

      card('Messages sent', table(
        [{ label: 'When' }, { label: 'Channel' }, { label: 'To', hideMobile: true }, { label: 'Subject' }, { label: 'Result' }],
        notifications,
        function (n) {
          return '<tr>' +
            '<td class="muted nowrap">' + esc(R.fmtDateTime(n.created_at)) + '</td>' +
            '<td class="muted">' + esc(n.channel) + '</td>' +
            '<td class="muted hide-mobile">' + esc(n.recipient) + '</td>' +
            '<td class="muted">' + esc(n.subject || n.template || '') + '</td>' +
            '<td>' + badge(n.status) + (n.error ? '<div class="cell-meta">' + esc(n.error) + '</div>' : '') + '</td>' +
          '</tr>';
        },
        {
          emptyTitle: 'Nothing sent yet',
          emptyHint: 'Receipts and alerts appear here whether they were delivered, failed, or skipped because email is not configured.',
        }
      ), { flush: true });

    var exportButton = R.qs('#btn-export-audit', view);
    if (exportButton) {
      exportButton.addEventListener('click', async function () {
        try {
          await R.downloadCsv('/audit/export', 'archta-audit-log.csv');
          toast('Exported. Check your downloads.', 'ok');
        } catch (err) {
          toast(err.message || 'Export failed.', 'err');
        }
      });
    }

    // FEATURE — system log with undo.
    R.qsa('[data-undo-audit]', view).forEach(function (button) {
      button.addEventListener('click', async function () {
        var confirmed = await R.confirm({
          title: 'Undo this action?',
          message: 'This will reverse: "' + button.dataset.summary + '". Undo is limited to 10 per day for this workspace.',
          confirmLabel: 'Undo',
        });
        if (!confirmed) return;
        try {
          await api.patch('/audit/' + button.dataset.undoAudit + '/undo', {});
          toast('Undone.', 'ok');
          R.reload();
        } catch (err) {
          toast(err.message || 'Could not undo this action.', 'err');
        }
      });
    });
  }

  // SECTION 2 — 2FA setup/disable, opened from openAccountModal (realestate.js)
  // via RE.twoFactorModal. No QR code image: rendering one would mean either
  // sending the TOTP secret to a third-party QR API (defeats the point of a
  // secret that is supposed to never leave a trusted channel) or vendoring a
  // QR-encoding library into a frontend that deliberately has no build step
  // and no dependency manager. Manual entry — the secret plus the same
  // otpauth:// URL a QR code would have encoded, both copyable — is every
  // authenticator app's own fallback for exactly this case, so nothing is
  // actually unreachable, just one tap slower.
  R.twoFactorModal = async function (me) {
    if (me.totp_enabled) return disable2faModal();
    return setup2faModal();
  };

  async function setup2faModal() {
    var setup;
    try {
      setup = await api.post('/auth/2fa/setup');
    } catch (err) {
      toast(err.message, 'err');
      return;
    }

    var panel = R.modal({
      title: 'Set up two-factor authentication',
      body: setup2faStepOneBody(setup),
      submitLabel: 'Verify code',
      onSubmit: async function (form, close) {
        var code = R.qs('#tfa-code', form).value.trim();
        if (!code) throw new Error('Enter the 6-digit code from your authenticator app.');
        var result = await api.post('/auth/2fa/verify', { code: code });

        // Step two, in the same dialog: the backup codes, shown exactly
        // once. Swapping the modal body in place rather than closing and
        // reopening keeps this one continuous flow the owner cannot
        // accidentally dismiss between "verified" and "codes saved".
        form.innerHTML = setup2faStepTwoBody(result.backup_codes);
        var submitBtn = R.qs('[type="submit"]', panel.root);
        if (submitBtn) submitBtn.classList.add('hidden');
        var cancelBtn = R.qs('[data-close]', panel.root);
        if (cancelBtn) cancelBtn.textContent = 'Done';

        R.state.user.totp_enabled = true;
        toast('Two-factor authentication is now on.', 'ok');
      },
    });
  }

  function setup2faStepOneBody(setup) {
    return '<p class="page-sub mb-2">Scan or enter this manually in Google Authenticator, Authy, or any TOTP app.</p>' +
      '<div class="field"><label for="tfa-secret">Secret key</label>' +
        '<input class="input mono" id="tfa-secret" value="' + esc(setup.secret) + '" readonly></div>' +
      '<div class="field"><label for="tfa-url">Setup link</label>' +
        '<input class="input mono" id="tfa-url" value="' + esc(setup.otpauth_url) + '" readonly>' +
        '<p class="field-hint">Some authenticator apps and password managers can open this link directly.</p></div>' +
      '<div class="field"><label for="tfa-code">Code from your app</label>' +
        '<input class="input mono" id="tfa-code" name="code" autocomplete="one-time-code" inputmode="numeric" ' +
          'maxlength="6" placeholder="123456" required></div>';
  }

  function setup2faStepTwoBody(backupCodes) {
    return '<div class="notice mb-2">Save these backup codes now. Each works once if you ever lose access to your ' +
        'authenticator app, and they will not be shown again.</div>' +
      '<div class="mono mb-2 lh-19">' + backupCodes.map(esc).join('<br>') + '</div>';
  }

  // SECTION 3 — session management, opened from openAccountModal
  // (realestate.js) via RE.sessionsModal. Re-fetches and re-renders its own
  // body in place after every revoke, the same "one continuous flow, not a
  // close-and-reopen" idiom setup2faModal already uses.
  R.sessionsModal = async function () {
    var panel = R.modal({ title: 'Sessions', cancelLabel: 'Close', body: R.skeleton(3) });

    async function renderSessions() {
      var sessions = await api('/auth/sessions');
      var otherCount = sessions.filter(function (s) { return !s.is_current; }).length;

      panel.form.innerHTML =
        '<p class="page-sub mb-2">Every device currently signed in as you.</p>' +
        sessions.map(sessionRow).join('') +
        (otherCount
          ? '<button class="btn mt-2" type="button" id="btn-sessions-revoke-all">Sign out all other devices (' + otherCount + ')</button>'
          : '');

      R.onClick(panel.form, '[data-revoke-session]', async function (button) {
        await api('/auth/sessions/' + button.dataset.revokeSession, { method: 'DELETE' });
        toast('Session revoked.', 'ok');
        await renderSessions();
      });

      var revokeAll = R.qs('#btn-sessions-revoke-all', panel.form);
      if (revokeAll) {
        revokeAll.addEventListener('click', async function () {
          await api('/auth/sessions', { method: 'DELETE' });
          toast('Signed out of all other devices.', 'ok');
          await renderSessions();
        });
      }
    }

    await renderSessions();
  };

  function sessionRow(s) {
    return '<div class="sched-history-row flex-row justify-between gap-10">' +
      '<div><b>' + esc(s.device_info || 'Unknown device') + (s.is_current ? ' <span class="muted">(this device)</span>' : '') + '</b>' +
        '<div class="page-sub">' + esc(s.ip_address || 'Unknown location') +
          ' · last active ' + esc(R.fmtRelative(s.last_used_at)) + '</div></div>' +
      (s.is_current ? '' : '<button class="btn-quiet" data-revoke-session="' + esc(s.id) + '">Sign out</button>') +
    '</div>';
  }

  async function disable2faModal() {
    R.modal({
      title: 'Disable two-factor authentication',
      body:
        '<p class="page-sub mb-2">Requires your password and a current code — this removes the extra step from every future sign-in.</p>' +
        '<div class="field"><label for="tfa-off-password">Current password</label>' +
          '<input class="input" id="tfa-off-password" name="current_password" type="password" autocomplete="current-password" required></div>' +
        '<div class="field"><label for="tfa-off-code">Authenticator code</label>' +
          '<input class="input mono" id="tfa-off-code" name="code" autocomplete="one-time-code" inputmode="numeric" ' +
            'maxlength="6" placeholder="123456" required></div>',
      submitLabel: 'Disable 2FA',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        await api.post('/auth/2fa/disable', { current_password: v.current_password, code: v.code });
        R.state.user.totp_enabled = false;
        close();
        toast('Two-factor authentication is off.', 'ok');
      },
    });
  }
})();
