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

  R.resetScreenState = function () { projectFilter = null; };

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
      if (query.project) projectFilter = query.project;
      var scope = projectFilter ? '?project_id=' + encodeURIComponent(projectFilter) : '';

      var results = await Promise.all([
        api('/dashboard' + scope),
        api('/dashboard/at-risk' + scope),
        api('/tasks?status=open'),
      ]);

      var d = results[0], atRisk = results[1], tasks = results[2];
      var brief = d.latest_brief;
      var drafts = (brief && brief.payload && brief.payload.follow_ups) || [];
      var risks = (brief && brief.payload && brief.payload.risks) || [];

      var lines = [];
      if (atRisk.length) lines.push('<span class="greeting-line clay"><b>' + atRisk.length + '</b> ' + (atRisk.length === 1 ? 'buyer needs' : 'buyers need') + ' chasing</span>');
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

        // The brief
        '<div class="brief">' +
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
            ? '<div class="notice info mt-1" style="margin-bottom:0">' +
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
        '</div>' +

        '<div class="grid cols-4 mt-2">' +
          stat('Collected this month', naira(d.collected_this_month), { tone: 'moss', accent: 'moss' }) +
          stat('Outstanding', naira(d.outstanding_total)) +
          stat('Overdue', naira(d.overdue.amount), {
            tone: 'clay', accent: d.overdue.count ? 'clay' : null,
            sub: d.overdue.count ? R.plural(d.overdue.count, 'installment') : 'All current',
          }) +
          stat('Due in 7 days', naira(d.due_next_7_days)) +
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
            card('At risk', atRisk.length
              ? atRisk.slice(0, 6).map(riskRow).join('')
              : R.emptyState('Nobody is two or more installments behind', 'Good morning.'),
              { flush: true, actions: atRisk.length > 6 ? '<a class="btn-quiet" href="#/at-risk">See all ' + atRisk.length + '</a>' : '' }) +

            card('Inventory', inventoryHtml(d.units), { actions: '<a class="btn-quiet" href="#/units">Manage</a>' }) +
          '</div>' +

          '<div>' +
            card('Drafted follow-ups', drafts.length
              ? drafts.slice(0, 5).map(draftRow).join('')
              : R.emptyState('Nothing to chase today'),
              { flush: true }) +

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

  function inventoryHtml(units) {
    var total = units.available + units.reserved + units.sold;
    if (!total) return '<div class="empty" style="padding:14px">No units yet. <a class="link-quiet" href="#/projects">Create a project</a> to add some.</div>';
    var pct = function (n) { return (n / total) * 100 + '%'; };
    return '<div class="units-bar">' +
        '<div class="seg-sold" style="width:' + pct(units.sold) + '"></div>' +
        '<div class="seg-reserved" style="width:' + pct(units.reserved) + '"></div>' +
        '<div class="seg-available" style="width:' + pct(units.available) + '"></div>' +
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
        '<button class="action-link" data-promise="' + esc(c.oldest_schedule_id) + '" data-name="' + esc(c.customer.full_name) + '">Log a promise</button>' +
        '<button class="action-link" data-buyer="' + esc(c.customer.id) + '">Open</button>' +
      '</div>' +
    '</div>';
  }

  function wireRiskRows(root) {
    R.qsa('[data-promise]', root).forEach(function (button) {
      button.addEventListener('click', function () { promiseModal(button.dataset.promise, button.dataset.name); });
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
            '<div class="input-money"><input class="input" id="p-amount" name="promised_amount" type="number" min="0" step="1000" placeholder="Optional"></div></div>' +
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
          : R.emptyState('No ' + status + ' tasks'),
          { flush: true });

      if (status === 'open') wireTasks(view);

      R.qs('#btn-new-task', view).addEventListener('click', function () {
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

      view.innerHTML =
        head('Projects', 'Each development you are selling.',
          '<button class="btn primary" id="btn-new-project">New project</button>') +
        (projects.length
          ? '<div class="grid cols-3">' + projects.map(projectCard).join('') + '</div>'
          : card(null, R.emptyState(
              'No projects yet',
              'A project is one development — "Lekki Gardens Phase 2". Units, buyers and payments all hang off it.',
              '<button class="btn primary" id="btn-first-project">Create your first project</button>'
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

    return '<div class="card" style="cursor:pointer" data-project-open="' + esc(p.id) + '">' +
      '<div class="card-body">' +
        '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">' +
          '<div><div style="font-size:15px;font-weight:600">' + esc(p.name) + '</div>' +
          '<div class="page-sub">' + esc(p.location || 'No location set') + '</div></div>' +
          badge(p.status) +
        '</div>' +
        '<div class="mt-2"><div class="meter gold"><i style="width:' + pct + '%"></i></div>' +
          '<div class="units-legend mt-1" style="font-size:11.5px">' +
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

      if (!projects.length) {
        view.innerHTML = head('Units', 'Inventory across your developments.') +
          card(null, R.emptyState('Create a project first', 'Units belong to a development.',
            '<a class="btn primary" href="#/projects">Go to projects</a>'), { flush: true });
        return;
      }

      view.innerHTML =
        head('Units', R.plural(units.length, 'unit') + ' in view',
          '<button class="btn" id="btn-import-units">Import CSV</button>' +
          '<button class="btn" id="btn-bulk-units">Add many</button>' +
          '<button class="btn primary" id="btn-new-unit">Add unit</button>') +

        '<div class="filter-row">' +
          '<button class="pill' + (projectFilter ? '' : ' is-on') + '" data-project="">All projects</button>' +
          projects.map(function (p) {
            return '<button class="pill' + (projectFilter === p.id ? ' is-on' : '') + '" data-project="' + esc(p.id) + '">' + esc(p.name) + '</button>';
          }).join('') +
        '</div>' +

        card(null, table(
          [{ label: 'Unit' }, { label: 'Project' }, { label: 'Type' }, { label: 'Size', num: true },
            { label: 'Price', num: true }, { label: 'Status' }, { label: '' }],
          units,
          function (u) {
            return '<tr>' +
              '<td class="cell-primary">' + esc(u.unit_number) + '</td>' +
              '<td class="muted">' + esc((u.re_projects && u.re_projects.name) || '') + '</td>' +
              '<td class="muted">' + esc(u.unit_type || '—') + '</td>' +
              '<td class="num muted">' + (u.size_sqm ? esc(u.size_sqm) + ' m²' : '—') + '</td>' +
              '<td class="num">' + naira(u.list_price) + '</td>' +
              '<td>' + badge(u.status) + '</td>' +
              '<td class="right nowrap">' +
                '<button class="btn-quiet" data-media="' + esc(u.id) + '" data-unit="' + esc(u.unit_number) + '">' +
                  (mediaCount(u) ? 'Media ' + mediaCount(u) : 'Media') +
                '</button> ' +
                (u.status === 'available'
                  ? '<button class="btn-quiet" data-reserve="' + esc(u.id) + '">Reserve</button> '
                  : '') +
                (u.status === 'available'
                  ? '<button class="btn-quiet" data-delete-unit="' + esc(u.id) +
                    '" data-label="Unit ' + esc(u.unit_number) + '">Delete</button>'
                  : '') +
              '</td>' +
            '</tr>';
          },
          { emptyTitle: 'No units yet', emptyHint: 'Add them one at a time, in bulk, or import a CSV.' }
        ), { flush: true });

      R.qsa('[data-project]', view).forEach(function (pill) {
        pill.addEventListener('click', function () {
          projectFilter = pill.dataset.project || null;
          R.go('#/units' + (projectFilter ? '?project=' + projectFilter : ''));
          R.reload();
        });
      });

      R.qs('#btn-new-unit', view).addEventListener('click', function () { unitModal(projects); });
      R.qs('#btn-bulk-units', view).addEventListener('click', function () { bulkUnitModal(projects); });
      R.qs('#btn-import-units', view).addEventListener('click', function () { importUnitsModal(projects); });

      R.qsa('[data-reserve]', view).forEach(function (button) {
        button.addEventListener('click', function () { openReservationModal({ unitId: button.dataset.reserve }); });
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

    R.modal({
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

    var submit = R.qs('.modal-foot [type="submit"]');
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
              return '<a class="card" style="text-decoration:none;overflow:hidden" href="' + esc(m.url) + '" target="_blank" rel="noopener">' +
                (isPdf
                  ? '<div style="height:96px;display:grid;place-items:center;background:var(--panel-2);font-size:22px;opacity:.4">▤</div>'
                  : '<img src="' + esc(m.url) + '" alt="' + esc(m.label || m.kind) + '" style="width:100%;height:96px;object-fit:cover;display:block">') +
                '<div class="card-body" style="padding:9px 11px">' +
                  '<div style="font-size:12px">' + esc(m.label || String(m.kind).replace(/_/g, ' ')) + '</div>' +
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
        '<div class="field"><label for="m-file">File</label>' +
          '<input class="input" id="m-file" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required>' +
          '<p class="field-hint">JPEG, PNG, WebP or PDF, up to 6MB. These are publicly readable so a rep can send one straight to a buyer.</p></div>',
      submitLabel: 'Upload',
      onSubmit: async function (form, close) {
        var input = R.el('m-file');
        var file = input.files[0];
        if (!file) throw new Error('Choose a file to upload.');
        if (file.size > 6 * 1024 * 1024) throw new Error('That file is larger than 6MB.');

        var base64 = await new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () { resolve(String(reader.result).split(',')[1]); };
          reader.onerror = function () { reject(new Error('Could not read that file.')); };
          reader.readAsDataURL(file);
        });

        var v = R.values(form);
        await api.post('/units/' + unit.id + '/media', {
          content: base64,
          content_type: file.type,
          kind: v.kind,
          label: v.label || null,
        });

        close();
        toast('Uploaded.', 'ok');
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
            '<div class="input-money"><input class="input" id="u-price" name="list_price" type="number" min="0" step="10000" required placeholder="45000000"></div></div>' +
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
            '<div class="input-money"><input class="input" id="b-price" name="list_price" type="number" min="0" step="10000" required placeholder="45000000"></div></div>' +
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
    var panel = R.modal({
      title: 'Import units from CSV',
      wide: true,
      body:
        '<p class="muted mb-2">Columns: <code>unit_number, unit_type, size_sqm, list_price</code>. ' +
        'The first row must be the header. <a class="link-quiet" href="' + R.API_BASE + '/re/imports/template/units" target="_blank" rel="noopener">Download the template</a></p>' +
        '<div class="field"><label for="i-project">Project</label>' +
          '<select class="select" id="i-project" name="project_id" required>' + options(projects, 'id', 'name', projectFilter) + '</select></div>' +
        '<div class="field"><label for="i-file">CSV file</label>' +
          '<input class="input" id="i-file" type="file" accept=".csv,text/csv"></div>' +
        '<div class="field"><label for="i-csv">…or paste it</label>' +
          '<textarea class="textarea" id="i-csv" name="csv" rows="7" style="font-family:var(--mono);font-size:12px" placeholder="unit_number,unit_type,size_sqm,list_price&#10;B12,3-bed terrace,145,45000000"></textarea></div>' +
        '<div id="i-result"></div>',
      submitLabel: 'Preview import',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        if (!v.csv) throw new Error('Paste the CSV or choose a file.');

        var previewed = form.dataset.previewed === 'true';
        var result = await api.post('/imports/units', {
          project_id: v.project_id, csv: v.csv, dry_run: !previewed,
        });

        if (!previewed) {
          form.dataset.previewed = 'true';
          R.el('i-result').innerHTML =
            '<div class="notice ' + (result.errors.length ? '' : 'ok') + '">' +
              esc(result.would_create + ' units will be created' +
                (result.errors.length ? '; ' + result.errors.length + ' rows will be skipped' : '') + '.') +
              (result.errors.length
                ? '<div class="mt-1" style="font-size:12px">' + result.errors.slice(0, 6).map(function (e) {
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

    R.el('i-file').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        R.el('i-csv').value = reader.result;
        // A new file invalidates the previous preview, so the next submit
        // previews again instead of importing something nobody has seen.
        panel.form.dataset.previewed = 'false';
      };
      reader.readAsText(file);
    });
  }

  /* ══ BUYERS ═════════════════════════════════════════════════════════════ */
  R.screens.customers = {
    render: async function (view, params, query) {
      // #/customers/<id> opens the buyer straight from a search result.
      if (params[0]) { openCustomer(params[0]); window.location.hash = '#/customers'; return; }

      var search = query.q || '';
      var customers = await api('/customers' + (search ? '?search=' + encodeURIComponent(search) : ''));

      view.innerHTML =
        head('Buyers', R.plural(customers.length, 'buyer') + (search ? ' matching “' + search + '”' : ''),
          '<button class="btn" id="btn-import-buyers">Import CSV</button>' +
          '<button class="btn primary" id="btn-new-buyer">Add buyer</button>') +

        card(null, table(
          [{ label: 'Name' }, { label: 'Phone' }, { label: 'Email' }, { label: 'Source' },
            { label: 'Added' }, { label: '' }],
          customers,
          function (c) {
            return '<tr class="is-clickable" data-open="' + esc(c.id) + '">' +
              '<td class="cell-primary">' + esc(c.full_name) + '</td>' +
              '<td class="mono muted">' + esc(c.phone || '—') + '</td>' +
              '<td class="muted">' + esc(c.email || '—') + '</td>' +
              '<td class="muted">' + esc(c.source || '—') + '</td>' +
              '<td class="muted">' + esc(fmtDate(c.created_at)) + '</td>' +
              // data-stop keeps the row's own click handler from firing and
              // opening the drawer behind the confirmation.
              '<td class="right"><button class="btn-quiet" data-stop data-delete-customer="' + esc(c.id) +
                '" data-label="' + esc(c.full_name) + '">Delete</button></td>' +
            '</tr>';
          },
          {
            emptyTitle: search ? 'Nobody matched that' : 'No buyers yet',
            emptyHint: search ? 'Try a phone number or part of a surname.' : 'Add them one at a time, or import the list you already have.',
          }
        ), { flush: true });

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
      R.qs('#btn-import-buyers', view).addEventListener('click', importCustomersModal);
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
  function importCustomersModal() {
    var panel = R.modal({
      title: 'Import buyers from CSV',
      wide: true,
      body:
        '<p class="muted mb-2">One row per buyer. Include their unit, plan and payments so far and it all comes across in one go. ' +
        '<a class="link-quiet" href="' + R.API_BASE + '/re/imports/template/customers" target="_blank" rel="noopener">Download the template</a></p>' +
        '<div class="notice info" style="font-size:12px">' +
          'Imported payments settle the schedule silently — no receipts are emailed for money that arrived months ago.' +
        '</div>' +
        '<div class="field"><label for="ic-file">CSV file</label>' +
          '<input class="input" id="ic-file" type="file" accept=".csv,text/csv"></div>' +
        '<div class="field"><label for="ic-csv">…or paste it</label>' +
          '<textarea class="textarea" id="ic-csv" name="csv" rows="7" style="font-family:var(--mono);font-size:12px" placeholder="full_name,phone,email,project,unit_number,list_price,total_amount,number_of_installments,start_date,amount_paid_to_date"></textarea></div>' +
        '<div id="ic-result"></div>',
      submitLabel: 'Preview import',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        if (!v.csv) throw new Error('Paste the CSV or choose a file.');

        var previewed = form.dataset.previewed === 'true';
        var result = await api.post('/imports/customers', { csv: v.csv, dry_run: !previewed });

        if (!previewed) {
          form.dataset.previewed = 'true';
          R.el('ic-result').innerHTML =
            '<div class="notice ' + (result.errors.length ? '' : 'ok') + '">' +
              esc(result.rows + ' rows ready' + (result.errors.length ? ', ' + result.errors.length + ' with problems' : '') + '.') +
            '</div>' +
            (result.errors.length
              ? '<div class="mt-1" style="font-size:12px;max-height:130px;overflow:auto">' +
                  result.errors.map(function (e) { return 'Row ' + e.row + ': ' + esc(e.error); }).join('<br>') + '</div>'
              : '') +
            '<div class="mt-1" style="font-size:12px;max-height:170px;overflow:auto;color:var(--text-dim)">' +
              result.preview.slice(0, 25).map(function (p) {
                return '<b>' + esc(p.full_name) + '</b> — ' + esc(p.actions.join('; '));
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

    R.el('ic-file').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        R.el('ic-csv').value = reader.result;
        panel.form.dataset.previewed = 'false';
      };
      reader.readAsText(file);
    });
  }

  // The screen a rep opens with the buyer on the phone: everything about them,
  // without leaving the list behind it.
  async function openCustomer(id) {
    var panel = R.drawer({ eyebrow: 'Buyer', title: 'Loading…' });

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

      panel.body.innerHTML =
        '<div class="grid cols-3">' +
          stat('Contracted', nairaShort(totalPlan)) +
          stat('Paid', nairaShort(totalPaid), { tone: 'moss' }) +
          stat('Overdue', nairaShort(overdue), { tone: overdue ? 'clay' : null }) +
        '</div>' +
        '<div class="mt-2"><div class="meter"><i style="width:' + pct + '%"></i></div>' +
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

          return '<div class="drawer-section">' +
            '<div style="display:flex;justify-content:space-between;gap:10px;align-items:center">' +
              '<div><b>' + esc(unit.unit_number ? 'Unit ' + unit.unit_number : 'Reservation') + '</b>' +
              '<div class="page-sub">' + esc([project.name, project.location].filter(Boolean).join(', ')) + '</div></div>' +
              badge(r.status) +
            '</div>' +
            (plan
              ? '<div class="page-sub mt-1">' + plan.number_of_installments + ' ' + esc(plan.frequency) +
                ' installments · ' + naira(plan.total_amount) + ' · from ' + esc(fmtDate(plan.start_date)) + '</div>' +
                '<div class="mt-1">' + schedule.map(scheduleRow).join('') + '</div>'
              : '<div class="page-sub mt-1">Outright purchase — no installment plan.</div>') +
          '</div>';
        }).join('') +

        (reservations.length ? '' : '<div class="drawer-section">' +
          R.emptyState('No reservations yet', 'This buyer has not been allocated a unit.',
            '<button class="btn primary" id="d-reserve">Create a reservation</button>') + '</div>');

      var reserveButton = R.qs('#d-reserve', panel.body);
      if (reserveButton) {
        reserveButton.addEventListener('click', function () {
          panel.close();
          openReservationModal({ customerId: c.id });
        });
      }

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
        recordPaymentModal(button.dataset.pay, button.dataset.outstanding, c.full_name);
      });
    } catch (err) {
      panel.body.innerHTML = '<div class="notice">' + esc(err.message) + '</div>';
    }
  }

  function scheduleRow(s) {
    return '<div class="sched ' + esc(s.status) + '">' +
      '<span class="sched-n">' + s.installment_number + '</span>' +
      '<span class="sched-main"><span class="mono">' + naira(s.amount_due) + '</span>' +
        '<span class="page-sub">due ' + esc(fmtDate(s.due_date)) + (s.paid_at ? ' · paid ' + esc(fmtDate(s.paid_at)) : '') + '</span></span>' +
      badge(s.status) +
      (s.status !== 'paid'
        ? '<button class="btn-quiet" data-pay="' + esc(s.id) + '" data-outstanding="' + esc(s.amount_due) + '">Record</button>'
        : '') +
    '</div>';
  }

  /* ══ RESERVATIONS ═══════════════════════════════════════════════════════ */
  R.screens.reservations = {
    render: async function (view, params, query) {
      var status = query.status || '';
      var reservations = await api('/reservations' + (status ? '?status=' + status : ''));

      view.innerHTML =
        head('Reservations', 'Unit, buyer, rep and payment plan.',
          '<button class="btn primary" id="btn-new-res">New reservation</button>') +

        '<div class="filter-row">' +
          '<a class="pill' + (status ? '' : ' is-on') + '" href="#/reservations">All</a>' +
          ['reserved', 'confirmed', 'completed', 'cancelled'].map(function (s) {
            return '<a class="pill' + (status === s ? ' is-on' : '') + '" href="#/reservations?status=' + s + '">' +
              s.charAt(0).toUpperCase() + s.slice(1) + '</a>';
          }).join('') +
        '</div>' +

        card(null, table(
          [{ label: 'Buyer' }, { label: 'Unit' }, { label: 'Plan' }, { label: 'Value', num: true },
            { label: 'Reserved' }, { label: 'Status' }, { label: '' }],
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
              '<td class="muted">' +
                (rental
                  ? (plan ? plan.number_of_installments + '-month lease' : 'Rental') +
                    (r.tenancy_end_date ? '<div class="cell-meta">ends ' + esc(fmtDate(r.tenancy_end_date)) + '</div>' : '')
                  : (plan ? plan.number_of_installments + ' installments' : 'Outright')) +
              '</td>' +
              '<td class="num">' + naira(plan ? (rental ? plan.total_amount / plan.number_of_installments : plan.total_amount) : unit.list_price) +
                (rental && plan ? '<div class="cell-meta">/month</div>' : '') +
              '</td>' +
              '<td class="muted">' + esc(fmtDate(r.reserved_at)) + '</td>' +
              '<td>' + badge(r.status) + (r.escalation_stage && r.escalation_stage !== 'none' ? ' ' + badge(r.escalation_stage) : '') + '</td>' +
              '<td class="right nowrap">' +
                (rental
                  ? '<button class="btn-quiet" data-renew="' + esc(r.id) + '" data-buyer-name="' +
                    esc((r.re_customers && r.re_customers.full_name) || '') + '">Renew tenancy</button> '
                  : asArray(r.re_installment_plans).length
                    ? '<button class="btn-quiet" data-restructure="' + esc(r.id) + '" data-buyer-name="' +
                      esc((r.re_customers && r.re_customers.full_name) || '') + '">Restructure</button> '
                    : '') +
                '<button class="btn-quiet" data-res-menu="' + esc(r.id) + '" data-status="' + esc(r.status) +
                  '" data-buyer-name="' + esc((r.re_customers && r.re_customers.full_name) || '') + '">Change</button>' +
              '</td>' +
            '</tr>';
          },
          { emptyTitle: 'No reservations yet', emptyHint: 'A reservation ties a buyer to a unit and starts their payment schedule.' }
        ), { flush: true });

      R.qs('#btn-new-res', view).addEventListener('click', function () { openReservationModal({}); });

      R.qsa('[data-res-menu]', view).forEach(function (button) {
        button.addEventListener('click', function () {
          reservationStatusModal(button.dataset.resMenu, button.dataset.status, button.dataset.buyerName);
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

        '<div class="notice info" style="font-size:12px">' +
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

        '<div class="notice info" style="font-size:12px">' +
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

  // The modal has to load units, buyers and reps before it can draw itself, so
  // it is async — and an async function handed straight to addEventListener
  // rejects into nothing. Every call site goes through this.
  function openReservationModal(preset) {
    reservationModal(preset || {}).catch(function (err) { toast(err.message, 'err'); });
  }

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
              '<div class="input-money"><input class="input" id="r-total" name="total_amount" type="number" min="1" step="10000"></div></div>' +
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
            '<div class="field"><label for="r-duration">Tenancy duration (months)</label>' +
              '<input class="input" id="r-duration" name="duration_months" type="number" min="1" max="120" value="12"></div>' +
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

  function reservationStatusModal(id, current, buyerName) {
    var panel = R.modal({
      title: 'Change reservation status',
      body:
        '<p class="muted mb-2">Currently <b>' + esc(current) + '</b>. The unit follows: cancelling puts it back on the market, completing takes it off for good.</p>' +
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
            ? '<div class="notice info mt-1">The unit is marked <b>sold</b> and taken off the market permanently.</div>'
            : '';
    };
    select.addEventListener('change', describe);
    describe();
  }

  // Typing the word is the point. A confirm dialog with a button is dismissed
  // reflexively; a word has to be read first.
  function confirmCancellation(id, buyerName) {
    R.modal({
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

    var submit = R.qs('.modal-foot [type="submit"]');
    if (submit) { submit.classList.remove('primary'); submit.classList.add('danger'); }
  }

  /* ══ PAYMENTS ═══════════════════════════════════════════════════════════ */
  R.screens.payments = {
    render: async function (view, params, query) {
      var tab = query.tab || 'due';

      if (tab === 'history') {
        var payments = await api('/payments?limit=200');
        view.innerHTML = head('Payments', 'Every naira received, most recent first.') + paymentTabs(tab) +
          card(null, table(
            [{ label: 'Date' }, { label: 'Buyer' }, { label: 'Unit' }, { label: 'Method' },
              { label: 'Amount', num: true }, { label: '' }],
            payments,
            function (p) {
              var s = p.re_installment_schedule || {};
              var reservation = (s.re_installment_plans && s.re_installment_plans.re_reservations) || {};
              var unit = reservation.re_units || {};
              return '<tr>' +
                '<td class="muted">' + esc(fmtDate(p.paid_at)) + '</td>' +
                '<td class="cell-primary">' + esc((reservation.re_customers && reservation.re_customers.full_name) || '—') + '</td>' +
                '<td class="muted">' + esc(unit.unit_number || '—') +
                  '<div class="cell-meta">' + esc((unit.re_projects && unit.re_projects.name) || '') + '</div></td>' +
                '<td class="muted">' + esc(String(p.method).replace(/_/g, ' ')) + '</td>' +
                '<td class="num moss">' + naira(p.amount) + '</td>' +
                '<td class="right"><button class="btn-quiet" data-receipt="' + esc(p.id) + '">Receipt</button></td>' +
              '</tr>';
            },
            { emptyTitle: 'No payments recorded yet' }
          ), { flush: true });

        R.onClick(view, '[data-receipt]', async function (button) {
          var result = await api.post('/payments/' + button.dataset.receipt + '/receipt');
          R.openFile(result.download_url);
          toast('Receipt ' + result.receipt_number + ' ready.', 'ok');
        });
        return;
      }

      var status = tab === 'overdue' ? 'overdue' : 'pending';
      var schedule = await api('/payments/schedule?status=' + status + '&limit=400');

      var due = schedule.reduce(function (sum, s) { return sum + Number(s.amount_outstanding || 0); }, 0);

      view.innerHTML =
        head('Payments', tab === 'overdue' ? 'Installments past their due date.' : 'What is scheduled and not yet settled.') +
        paymentTabs(tab) +
        '<div class="grid cols-3 mb-2">' +
          stat(tab === 'overdue' ? 'Overdue installments' : 'Open installments', String(schedule.length)) +
          stat('Outstanding', naira(due), { tone: tab === 'overdue' ? 'clay' : null }) +
          stat('Buyers', String(new Set(schedule.map(function (s) {
            var r = s.re_installment_plans.re_reservations;
            return r.re_customers && r.re_customers.id;
          })).size)) +
        '</div>' +

        card(null, table(
          [{ label: 'Due' }, { label: 'Buyer' }, { label: 'Unit' }, { label: 'No.' },
            { label: 'Due', num: true }, { label: 'Outstanding', num: true }, { label: '' }],
          schedule,
          function (s) {
            var reservation = s.re_installment_plans.re_reservations;
            var customer = reservation.re_customers || {};
            var unit = reservation.re_units || {};
            return '<tr>' +
              '<td class="muted nowrap">' + esc(fmtDate(s.due_date)) + '</td>' +
              '<td class="cell-primary">' + esc(customer.full_name || '—') + '</td>' +
              '<td class="muted">' + esc(unit.unit_number || '—') +
                '<div class="cell-meta">' + esc((unit.re_projects && unit.re_projects.name) || '') + '</div></td>' +
              '<td class="muted">' + s.installment_number + '/' + s.re_installment_plans.number_of_installments + '</td>' +
              '<td class="num muted">' + naira(s.amount_due) + '</td>' +
              '<td class="num">' + naira(s.amount_outstanding) + '</td>' +
              '<td class="right nowrap">' +
                '<button class="btn-quiet" data-record="' + esc(s.id) + '" data-outstanding="' + esc(s.amount_outstanding) +
                  '" data-name="' + esc(customer.full_name || '') + '">Record</button> ' +
                (customer.email
                  ? '<button class="btn-quiet" data-link="' + esc(s.id) + '" data-email="' + esc(customer.email) + '">Link</button>'
                  : '') +
              '</td>' +
            '</tr>';
          },
          { emptyTitle: tab === 'overdue' ? 'Nothing is overdue' : 'Nothing is scheduled', emptyHint: 'Reservations with a payment plan appear here.' }
        ), { flush: true });

      R.qsa('[data-record]', view).forEach(function (button) {
        button.addEventListener('click', function () {
          recordPaymentModal(button.dataset.record, button.dataset.outstanding, button.dataset.name);
        });
      });

      R.onClick(view, '[data-link]', async function (button) {
        var result = await api.post('/payments/' + button.dataset.link + '/init', { customer_email: button.dataset.email });
        await R.copyText(result.authorization_url);
        toast('Paystack link for ' + naira(result.amount) + ' copied to your clipboard.', 'ok');
      });
    },
  };

  function paymentTabs(active) {
    return '<div class="filter-row">' +
      [['due', 'Due'], ['overdue', 'Overdue'], ['history', 'History']].map(function (t) {
        return '<a class="pill' + (active === t[0] ? ' is-on' : '') + '" href="#/payments?tab=' + t[0] + '">' + t[1] + '</a>';
      }).join('') +
    '</div>';
  }

  function recordPaymentModal(scheduleId, outstanding, customerName) {
    var due = Number(outstanding || 0);

    var panel = R.modal({
      title: 'Record a payment',
      body:
        (customerName ? '<p class="muted mb-2">From <b>' + esc(customerName) + '</b>.</p>' : '') +
        '<div class="field"><label for="pay-amount">Amount received</label>' +
          '<div class="input-money"><input class="input" id="pay-amount" name="amount" type="number" min="1" step="1000" required value="' + esc(outstanding || '') + '"></div>' +
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
          '<input class="input" id="pay-ref" name="reference" placeholder="Bank reference or teller number"></div>',
      submitLabel: 'Record payment',
      onSubmit: async function (form, close) {
        var v = R.values(form);
        if (!v.amount) throw new Error('Enter the amount received.');

        var result = await api.post('/payments/' + scheduleId + '/record', {
          amount: v.amount, method: v.method, reference: v.reference || null,
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

        // An overpayment gets its own message, not a clause in a list. It is
        // the thing the buyer will phone about.
        if (result.overpayment > 0) {
          toast(naira(result.overpayment) + ' more than this installment required. '
            + 'Agree with the buyer which installment it goes against, then record it there.', 'err');
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
      var tab = query.tab || 'summary';

      if (tab === 'performance') {
        var performance = await api('/commissions/performance');
        view.innerHTML = head('Sales performance', 'Who is selling, and who is collecting.') + commissionTabs(tab) +
          card(null, table(
            [{ label: 'Rep' }, { label: 'Reservations', num: true }, { label: 'This month', num: true },
              { label: 'Portfolio', num: true }, { label: 'Collected', num: true }, { label: 'Rate', num: true },
              { label: 'At risk', num: true }, { label: 'Commission', num: true }],
            performance,
            function (p) {
              return '<tr>' +
                '<td class="cell-primary">' + esc(p.name) + (p.active ? '' : ' <span class="badge none">inactive</span>') + '</td>' +
                '<td class="num">' + p.reservations_total + '</td>' +
                '<td class="num">' + p.reservations_this_month + '</td>' +
                '<td class="num muted">' + nairaShort(p.portfolio_value) + '</td>' +
                '<td class="num moss">' + nairaShort(p.collected) + '</td>' +
                '<td class="num ' + (p.collection_rate >= 70 ? 'moss' : p.collection_rate < 40 ? 'clay' : '') + '">' + p.collection_rate + '%</td>' +
                '<td class="num ' + (p.buyers_at_risk ? 'clay' : 'muted') + '">' + p.buyers_at_risk + '</td>' +
                '<td class="num gold">' + naira(p.commission_earned) + '</td>' +
              '</tr>';
            },
            { emptyTitle: 'No sales reps yet', emptyHint: 'Add reps in Settings, then assign them to reservations.' }
          ), { flush: true });
        return;
      }

      if (tab === 'entries') {
        var entries = await api('/commissions');
        view.innerHTML = head('Commission entries', 'One row per payment. This is where a rep\'s total comes from.') +
          commissionTabs(tab) +
          card(null, table(
            [{ label: 'Date' }, { label: 'Rep' }, { label: 'Buyer' }, { label: 'Payment', num: true },
              { label: 'Rate', num: true }, { label: 'Commission', num: true }, { label: 'Status' }],
            entries,
            function (c) {
              var reservation = c.re_reservations || {};
              return '<tr>' +
                '<td class="muted">' + esc(fmtDate(c.created_at)) + '</td>' +
                '<td>' + esc((c.re_sales_reps && c.re_sales_reps.users && (c.re_sales_reps.users.full_name || c.re_sales_reps.users.email)) || '—') + '</td>' +
                '<td class="muted">' + esc((reservation.re_customers && reservation.re_customers.full_name) || '—') + '</td>' +
                '<td class="num muted">' + naira(c.base_amount) + '</td>' +
                '<td class="num muted">' + c.rate + '%</td>' +
                '<td class="num gold">' + naira(c.amount) + '</td>' +
                '<td>' + badge(c.status) + '</td>' +
              '</tr>';
            },
            { emptyTitle: 'No commission accrued yet', emptyHint: 'Commission accrues when a payment lands against a reservation with a rep on it.' }
          ), { flush: true });
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
          [{ label: 'Rep' }, { label: 'Rate', num: true }, { label: 'Collected on', num: true },
            { label: 'Earned', num: true }, { label: 'Owed', num: true }, { label: 'Paid out', num: true }, { label: '' }],
          summary,
          function (r) {
            return '<tr>' +
              '<td class="cell-primary">' + esc(r.name) + '</td>' +
              '<td class="num muted">' + r.commission_rate + '%</td>' +
              '<td class="num muted">' + nairaShort(r.collected_base) + '</td>' +
              '<td class="num gold">' + naira(r.earned) + '</td>' +
              '<td class="num">' + naira(r.outstanding) + '</td>' +
              '<td class="num moss">' + naira(r.paid) + '</td>' +
              '<td class="right">' + (r.outstanding > 0
                ? '<button class="btn-quiet" data-payout="' + esc(r.sales_rep_id) + '" data-name="' + esc(r.name) + '">Mark paid</button>'
                : '') + '</td>' +
            '</tr>';
          },
          { emptyTitle: 'No commission yet', emptyHint: 'Set a rate on each rep in Settings, then assign them to reservations.' }
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
    return '<div class="filter-row">' +
      [['summary', 'By rep'], ['entries', 'Entries'], ['performance', 'Performance']].map(function (t) {
        return '<a class="pill' + (active === t[0] ? ' is-on' : '') + '" href="#/commissions?tab=' + t[0] + '">' + t[1] + '</a>';
      }).join('') +
    '</div>';
  }

  /* ══ REPORTS ════════════════════════════════════════════════════════════ */
  R.screens.reports = {
    render: async function (view, params, query) {
      var scope = query.project ? '?project_id=' + encodeURIComponent(query.project) : '';
      var results = await Promise.all([
        api('/reports/investor' + scope), api('/reports/collections?months=12'), api('/reports/rental'),
      ]);
      var report = results[0], collections = results[1], rental = results[2];
      var t = report.totals;
      // Only a developer who actually runs a rental portfolio sees this
      // section — nothing to report on is nothing to show.
      var hasRentals = rental.occupancy.occupied > 0 || rental.upcoming_renewals.length > 0;

      var peak = Math.max.apply(null, collections.map(function (m) { return m.amount; }).concat([1]));

      view.innerHTML =
        head('Reports', 'The summary you send to investors, without rebuilding it in PowerPoint.',
          '<button class="btn" data-export="customers">Export buyers</button>' +
          '<button class="btn" data-export="schedule">Export schedule</button>' +
          '<button class="btn" data-export="payments">Export payments</button>' +
          '<button class="btn primary" id="btn-print">Print / PDF</button>') +

        '<div class="grid cols-4 mb-2">' +
          stat('Gross development value', nairaShort(t.gross_development_value)) +
          stat('Contracted', nairaShort(t.contracted_value), { tone: 'gold' }) +
          stat('Collected to date', nairaShort(t.collected_total), { tone: 'moss', accent: 'moss' }) +
          stat('Receivables outstanding', nairaShort(t.receivables_outstanding), {
            sub: t.receivables_overdue ? nairaShort(t.receivables_overdue) + ' overdue' : 'none overdue',
            accent: t.receivables_overdue ? 'clay' : null,
          }) +
        '</div>' +

        card('Collections, last 12 months',
          '<div class="bars">' + collections.map(function (m) {
            var height = Math.max(2, Math.round((m.amount / peak) * 100));
            return '<div title="' + esc(m.month + ': ' + naira(m.amount)) + '">' +
              '<div class="bar" style="height:' + height + '%"></div>' +
              '<div class="bar-label">' + esc(m.month.slice(5)) + '</div></div>';
          }).join('') + '</div>' +
          '<div class="page-sub mt-1">Peak month ' + naira(peak) + '</div>') +

        card('By project', table(
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
        ), { flush: true }) +

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

      R.qs('#btn-print', view).addEventListener('click', function () { window.print(); });

      R.onClick(view, '[data-renew]', async function (button) {
        await renewTenancyModal(button.dataset.renew, button.dataset.buyerName);
      });

      // Your data, in a file you keep. Also the only backup a developer
      // controls without a Supabase login.
      R.onClick(view, '[data-export]', async function (button) {
        var kind = button.dataset.export;
        await R.downloadCsv('/reports/export/' + kind, 'realtika-' + kind + '.csv');
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
    var me = R.state.user;

    view.innerHTML = head('Settings', 'Letterhead, commission default and who gets told what.') + tabs +
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
              '<br><span class="field-hint" style="margin-top:2px">Goes to your customers and costs per SMS, so this one is off until you turn it on. ' +
              'Buyers past a gentle reminder are skipped — those are conversations, not texts.</span></span></label>' +
            '<div class="field mt-2"><label for="s-rate">Default commission rate</label>' +
              '<input class="input" id="s-rate" name="default_commission_rate" type="number" min="0" max="100" step="0.1" value="' + esc(settings.default_commission_rate || 0) + '">' +
              '<p class="field-hint">Percent. Applied to a new sales rep unless you set theirs individually.</p></div>' +
            '<button class="btn primary mt-1" type="submit">Save preferences</button>' +
          '</form>') +

          card('Your account', '<form id="form-me">' +
            '<div class="field"><label for="s-name">Your name</label>' +
              '<input class="input" id="s-name" name="full_name" value="' + esc(me.full_name || '') + '"></div>' +
            '<div class="field"><label>Email</label>' +
              '<input class="input" value="' + esc(me.email) + '" disabled></div>' +
            '<div class="field"><label for="s-current">' + (me.has_password ? 'Current password' : 'No password set') + '</label>' +
              '<input class="input" id="s-current" name="current_password" type="password" autocomplete="current-password"' +
                (me.has_password ? '' : ' disabled placeholder="You sign in with Google"') + '></div>' +
            '<div class="field"><label for="s-new">' + (me.has_password ? 'New password' : 'Set a password') + '</label>' +
              '<input class="input" id="s-new" name="password" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div>' +
            '<button class="btn mt-1" type="submit">Update account</button>' +
          '</form>') +
        '</div>' +
      '</div>';

    R.qs('#form-org', view).addEventListener('submit', async function (e) {
      e.preventDefault();
      try {
        await api.put('/settings', R.values(e.target));
        toast('Company details saved.', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    });

    R.qs('#form-notify', view).addEventListener('submit', async function (e) {
      e.preventDefault();
      try {
        await api.put('/settings', R.values(e.target));
        toast('Preferences saved.', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    });

    R.qs('#form-me', view).addEventListener('submit', async function (e) {
      e.preventDefault();
      var v = R.values(e.target);
      var payload = { full_name: v.full_name };
      if (v.password) { payload.password = v.password; payload.current_password = v.current_password; }
      try {
        var result = await R.request('/auth/me', { method: 'PATCH', body: JSON.stringify(payload) });

        // Changing the password invalidates every token, including the one this
        // tab is holding. The server returns a replacement so the person who
        // made the change is not signed out by making it.
        if (result && result.token) {
          R.adoptToken(result.token);
          toast('Password changed. Every other signed-in device has been signed out.', 'ok');
        } else {
          toast('Account updated.', 'ok');
        }
        R.reload();
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  async function teamTab(view, tabs) {
    var results = await Promise.all([api('/settings/team'), api('/sales-reps?include_inactive=true')]);
    var team = results[0], reps = results[1];

    view.innerHTML = head('Team & sales reps', team.is_team ? 'A shared workspace.' : 'A solo workspace.') + tabs +

      card('People', table(
        [{ label: 'Name' }, { label: 'Email' }, { label: 'Role' }, { label: 'Last active' },
          { label: 'Status' }, { label: '' }],
        team.members,
        function (m) {
          return '<tr>' +
            '<td class="cell-primary">' + esc(m.full_name || '—') + '</td>' +
            '<td class="muted">' + esc(m.email || '') + '</td>' +
            '<td class="muted">' + esc(m.role) + '</td>' +
            '<td class="muted">' + esc(m.last_login_at ? R.fmtRelative(m.last_login_at) : 'never signed in') + '</td>' +
            '<td>' + badge(m.status) + '</td>' +
            // The owner cannot be removed — the API refuses it, and offering the
            // button anyway is just a dead end with a confirmation on it.
            '<td class="right">' + (m.role !== 'owner' && m.status !== 'removed' && m.id
              ? '<button class="btn-quiet" data-remove="' + esc(m.id) + '" data-name="' +
                esc(m.full_name || m.email || 'this person') + '">Remove</button>'
              : '') + '</td>' +
          '</tr>';
        },
        { emptyTitle: 'Just you so far' }
      ), {
        flush: true,
        actions: team.is_team
          ? '<button class="btn-quiet" id="btn-invite">Invite someone</button>'
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

    var invite = R.qs('#btn-invite', view);
    if (invite) {
      invite.addEventListener('click', function () {
        R.modal({
          title: 'Invite someone',
          body:
            '<div class="field"><label for="inv-email">Email</label>' +
              '<input class="input" id="inv-email" name="email" type="email" required></div>' +
            '<div class="field"><label for="inv-role">Role</label>' +
              '<select class="select" id="inv-role" name="role"><option value="member">Member</option><option value="admin">Admin</option></select></div>' +
            '<p class="field-hint">If they already have an account they join immediately. If not, the invite waits for them to register with that address.</p>',
          submitLabel: 'Send invite',
          onSubmit: async function (form, close) {
            await api.post('/settings/team/invite', R.values(form));
            close();
            toast('Invited.', 'ok');
            R.reload();
          },
        });
      });
    }

    var makeTeam = R.qs('#btn-make-team', view);
    if (makeTeam) {
      makeTeam.addEventListener('click', function () {
        R.modal({
          title: 'Turn this into a team workspace',
          body:
            '<p class="muted mb-2">Everything you have — projects, buyers, payments, documents — moves to the new team. You will need to sign out and back in afterwards.</p>' +
            '<div class="field"><label for="tm-name">Team name</label>' +
              '<input class="input" id="tm-name" name="name" required placeholder="Adron Homes"></div>',
          submitLabel: 'Create team',
          onSubmit: async function (form, close) {
            var result = await api.post('/settings/team', R.values(form));
            close();
            if (result.failed && result.failed.length) {
              toast('Team created, but some records did not move. Check the activity log.', 'err');
            } else {
              toast('Team created. Sign out and back in to continue.', 'ok');
            }
          },
        });
      });
    }

    R.onClick(view, '[data-remove]', async function (button) {
      await removeMemberModal(button.dataset.remove, button.dataset.name);
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

    R.qs('#btn-add-rep', view).addEventListener('click', async function () {
      var team = await api('/settings/team');
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

    R.modal({
      title: 'Remove ' + name + '?',
      body:
        (work.has_workload
          ? '<div class="notice mb-2">' +
              '<b>' + name + ' holds ' + work.open_reservations + ' open reservation' +
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

        '<p class="muted" style="font-size:13px">' +
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

    var submit = R.qs('.modal-foot [type="submit"]');
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
            '<td><span class="mono" style="font-size:11.5px">' + esc(e.action) + '</span></td>' +
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
