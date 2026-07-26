// realestate.js — Sales Operations dashboard.
//
// Plain script, no bundler: FlowDesk's frontend is static HTML served as-is
// (index.html, portal.html), so this page follows the same rule and reads the
// same session the rest of the app uses — localStorage 'fd_token'.

(function () {
  'use strict';

  // Same resolution order as index.html, so one deploy-time global configures
  // every page.
  var API_BASE = window.__API_BASE__ || 'http://localhost:4000/api';
  var TOKEN_KEY = 'fd_token';

  // ── Helpers ───────────────────────────────────────────────────────────
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function naira(amount) {
    return '₦' + Number(amount || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });
  }

  function plural(count, word) {
    return count + ' ' + word + (count === 1 ? '' : 's');
  }

  function el(id) { return document.getElementById(id); }

  function showError(message) {
    var notice = el('error-notice');
    notice.textContent = message;
    notice.hidden = false;
  }

  function clearError() { el('error-notice').hidden = true; }

  // ── API ───────────────────────────────────────────────────────────────
  async function api(path, options) {
    var token = localStorage.getItem(TOKEN_KEY);
    var res = await fetch(API_BASE + '/re' + path, Object.assign({}, options, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: token ? 'Bearer ' + token : '',
      },
    }));

    if (res.status === 401) {
      // Session gone: hand back to the app shell, which owns the login screen.
      window.location.href = './index.html';
      throw new Error('Session expired.');
    }

    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(body.error || 'Request failed (' + res.status + ')');
    return body;
  }

  // ── Renderers ─────────────────────────────────────────────────────────
  function renderDateline() {
    el('dateline').textContent = new Date().toLocaleDateString('en-NG', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  function renderBrief(brief) {
    var summary = el('brief-summary');
    var meta = el('brief-meta');
    var risks = el('brief-risks');

    if (!brief) {
      summary.textContent = 'No brief yet. The first one is written automatically at 7:00 AM, or regenerate it now.';
      summary.classList.add('is-muted');
      meta.textContent = '';
      risks.innerHTML = '';
      return;
    }

    summary.textContent = brief.summary;
    summary.classList.remove('is-muted');

    // Say plainly when the wording came from the rule-based fallback rather
    // than the model — a degraded morning should be visible, not disguised.
    var parts = [brief.brief_date || ''];
    if (brief.generated_by === 'fallback') parts.push('rule-based');
    meta.textContent = parts.filter(Boolean).join(' · ');

    var list = (brief.payload && brief.payload.risks) || [];
    risks.innerHTML = list.map(function (r) {
      return '<span class="risk-chip ' + esc(r.severity) + '">' +
        '<b>' + esc(r.customer_name) + '</b> — ' + esc(r.reason) +
        '</span>';
    }).join('');
  }

  function renderLedger(d) {
    el('kpi-collected').textContent = naira(d.collected_this_month);
    el('kpi-outstanding').textContent = naira(d.outstanding_total);
    el('kpi-overdue').textContent = naira(d.overdue.amount);
    el('kpi-overdue-count').textContent = d.overdue.count
      ? plural(d.overdue.count, 'installment')
      : 'All current';
    el('kpi-due7').textContent = naira(d.due_next_7_days);
  }

  function renderInventory(units) {
    var total = units.available + units.reserved + units.sold;
    var bar = el('units-bar');

    if (!total) {
      bar.innerHTML = '';
      el('units-legend').innerHTML = '';
      el('units-total').textContent = 'No units yet';
      return;
    }

    var pct = function (n) { return (n / total) * 100 + '%'; };
    bar.innerHTML =
      '<div class="seg-sold" style="width:' + pct(units.sold) + '"></div>' +
      '<div class="seg-reserved" style="width:' + pct(units.reserved) + '"></div>' +
      '<div class="seg-available" style="width:' + pct(units.available) + '"></div>';

    el('units-legend').innerHTML =
      '<span><i class="swatch sold"></i>Sold ' + units.sold + '</span>' +
      '<span><i class="swatch reserved"></i>Reserved ' + units.reserved + '</span>' +
      '<span><i class="swatch available"></i>Available ' + units.available + '</span>';

    el('units-total').textContent = plural(total, 'unit');
  }

  function renderAtRisk(list) {
    var container = el('at-risk-list');

    if (!list.length) {
      container.innerHTML = '<div class="empty">No buyer is two or more installments behind. Good morning.</div>';
      return;
    }

    container.innerHTML = list.map(function (c) {
      var phone = c.customer.phone ? String(c.customer.phone) : '';
      var digits = phone.replace(/[^0-9]/g, '');
      var project = (c.unit && c.unit.re_projects && c.unit.re_projects.name) || '';
      var unitNumber = (c.unit && c.unit.unit_number) || '';
      var meta = [project, unitNumber ? 'Unit ' + unitNumber : '', plural(c.overdue_count, 'missed payment')]
        .filter(Boolean).map(esc).join(' · ');

      return '<div class="record">' +
        '<div class="record-top">' +
          '<div>' +
            '<div class="record-name">' + esc(c.customer.full_name) + '</div>' +
            '<div class="record-meta">' + meta + '</div>' +
          '</div>' +
          '<div class="record-amount">' + naira(c.overdue_amount) + '</div>' +
        '</div>' +
        (c.days_late ? '<div class="late-tag">' + plural(c.days_late, 'day') + ' late</div>' : '') +
        (phone
          ? '<div class="record-actions">' +
              '<a class="action-link" href="tel:' + esc(phone) + '">Call</a>' +
              '<a class="action-link" target="_blank" rel="noopener" href="https://wa.me/' + esc(digits) + '">WhatsApp</a>' +
            '</div>'
          : '') +
      '</div>';
    }).join('');
  }

  // Drafts are proposals: the AI writes, a human sends. Copy-to-clipboard is
  // the whole interaction in v1 — no message leaves the building automatically.
  function renderDrafts(brief) {
    var container = el('followups-list');
    var drafts = (brief && brief.payload && brief.payload.follow_ups) || [];

    if (!drafts.length) {
      container.innerHTML = '<div class="empty">Nothing to chase today.</div>';
      return;
    }

    container.innerHTML = drafts.map(function (draft, i) {
      return '<div class="draft">' +
        '<div class="record-name">' + esc(draft.customer_name) + '</div>' +
        '<div class="draft-text" id="draft-' + i + '">' + esc(draft.whatsapp_draft) + '</div>' +
        '<button class="btn-quiet" data-copy="' + i + '">Copy for WhatsApp</button>' +
      '</div>';
    }).join('');

    container.querySelectorAll('[data-copy]').forEach(function (button) {
      button.addEventListener('click', function () {
        var text = el('draft-' + button.dataset.copy).textContent;
        copyText(text).then(function () {
          button.textContent = 'Copied ✓';
          setTimeout(function () { button.textContent = 'Copy for WhatsApp'; }, 1600);
        }).catch(function () {
          button.textContent = 'Copy failed';
          setTimeout(function () { button.textContent = 'Copy for WhatsApp'; }, 1600);
        });
      });
    });
  }

  // navigator.clipboard needs a secure context; on plain http (a phone on the
  // office wifi hitting the dev server) it is undefined, so fall back.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
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
      } catch (err) {
        reject(err);
      } finally {
        document.body.removeChild(area);
      }
    });
  }

  function renderTasks(tasks) {
    var container = el('tasks-list');

    if (!tasks.length) {
      container.innerHTML = '<div class="empty">No open tasks.</div>';
      return;
    }

    container.innerHTML = tasks.map(function (t) {
      var reservation = t.re_reservations;
      var customer = reservation && reservation.re_customers;
      var unit = reservation && reservation.re_units;
      var meta = [customer && customer.full_name, unit && unit.unit_number ? 'Unit ' + unit.unit_number : '']
        .filter(Boolean).map(esc).join(' · ');

      return '<div class="task">' +
        '<div class="task-body">' +
          '<div class="task-title">' +
            (t.source === 'ai' ? '<span class="tag-ai">AI</span>' : '') +
            esc(t.title) +
          '</div>' +
          (meta ? '<div class="task-meta">' + meta + '</div>' : '') +
        '</div>' +
        '<button class="btn-quiet" data-done="' + esc(t.id) + '">Done</button>' +
      '</div>';
    }).join('');

    container.querySelectorAll('[data-done]').forEach(function (button) {
      button.addEventListener('click', async function () {
        button.disabled = true;
        try {
          await api('/tasks/' + button.dataset.done + '/status', {
            method: 'PATCH',
            body: JSON.stringify({ status: 'done' }),
          });
          await load();
        } catch (err) {
          button.disabled = false;
          showError(err.message);
        }
      });
    });
  }

  // ── Load ──────────────────────────────────────────────────────────────
  async function load() {
    try {
      var results = await Promise.all([
        api('/dashboard'),
        api('/dashboard/at-risk'),
        api('/tasks?status=open'),
      ]);
      var dashboard = results[0];

      clearError();
      renderLedger(dashboard);
      renderInventory(dashboard.units);
      renderBrief(dashboard.latest_brief);
      renderDrafts(dashboard.latest_brief);
      renderAtRisk(results[1]);
      renderTasks(results[2]);
    } catch (err) {
      showError('Could not load the dashboard: ' + err.message);
    }
  }

  // ── Wiring ────────────────────────────────────────────────────────────
  renderDateline();

  el('btn-refresh-brief').addEventListener('click', async function () {
    var button = this;
    var status = el('brief-status');
    button.disabled = true;
    button.textContent = 'Working…';
    status.textContent = 'reading payments, documents and schedules';

    try {
      await api('/brief/generate', { method: 'POST' });
      await load();
      status.textContent = '';
    } catch (err) {
      showError('Could not regenerate the brief: ' + err.message);
      status.textContent = '';
    } finally {
      button.disabled = false;
      button.textContent = 'Regenerate brief';
    }
  });

  if (!localStorage.getItem(TOKEN_KEY)) {
    window.location.href = './index.html';
  } else {
    load();
  }
})();
