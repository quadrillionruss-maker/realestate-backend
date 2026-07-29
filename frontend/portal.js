/* portal.js — the buyer's self-service page.
 *
 * Standalone: it shares the stylesheet with the operator app and nothing else.
 * No router, no session storage, no sidebar. One page that answers three
 * questions and then gets out of the way.
 *
 * ── THE TOKEN ────────────────────────────────────────────────────────────
 * It arrives in the URL fragment (portal.html#token=…). A fragment is never
 * transmitted to a server, so the link cannot show up in an access log, a
 * proxy log, or the Referer header when the buyer clicks through to Paystack.
 *
 * It is read once, held in a closure, and then STRIPPED FROM THE ADDRESS BAR
 * with replaceState — so the buyer can hand their phone to someone, or leave
 * the tab open, without the credential sitting there in plain sight. It is
 * deliberately not written to localStorage: a buyer signs in twice a year
 * from a link they still have in WhatsApp, so persisting it buys nothing and
 * leaves a credential on a shared family device.
 */
(function () {
  'use strict';

  var API_BASE = window.__API_BASE__ || 'http://localhost:4000/api';

  var token = (/[#&]token=([^&]+)/.exec(window.location.hash) || [])[1] || '';
  if (token) {
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (e) { /* file:// has no history API; harmless */ }
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function naira(amount) {
    return '₦' + Number(amount || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });
  }

  function fmtDate(value) {
    if (!value) return '—';
    var d = new Date(value);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function el(id) { return document.getElementById(id); }

  function toast(message, kind) {
    var node = document.createElement('div');
    node.className = 'toast ' + (kind || '');
    node.innerHTML = '<span>' + esc(message) + '</span>';
    el('toasts').appendChild(node);
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 5000);
  }

  async function api(path, options) {
    var opts = options || {};
    var res = await fetch(API_BASE + '/portal' + path, {
      method: opts.method || 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: opts.body,
    });

    var body = null;
    var text = await res.text().catch(function () { return ''; });
    if (text) { try { body = JSON.parse(text); } catch (e) { body = null; } }

    if (!res.ok) {
      throw Object.assign(new Error((body && body.error) || 'Something went wrong. Please try again.'), { status: res.status });
    }
    return body;
  }

  // A buyer is not a developer. "Invalid token" means nothing to them; "ask
  // for a new link" is an instruction they can act on.
  function fail(message) {
    el('portal-view').innerHTML =
      '<div class="card"><div class="card-body" style="text-align:center;padding:44px 22px">' +
        '<div style="font-size:26px;opacity:.3;margin-bottom:12px">◇</div>' +
        '<div class="serif" style="font-size:20px;margin-bottom:8px">' + esc(message) + '</div>' +
        '<p class="muted" style="font-size:13.5px;line-height:1.6">' +
          'Please contact your developer\'s sales office and ask them to send you a fresh link.' +
        '</p>' +
      '</div></div>';
  }

  async function load() {
    if (!token) return fail('This link is incomplete');

    var account;
    try {
      account = await api('/me');
    } catch (err) {
      return fail(err.message);
    }

    var s = account.summary;
    var developer = account.developer || {};

    if (developer.company_name) el('developer-name').textContent = developer.company_name;

    el('portal-foot').innerHTML =
      'Questions about your account? Contact ' +
      esc(developer.company_name || 'your developer') +
      (developer.phone ? ' on ' + esc(developer.phone) : '') +
      (developer.email ? ' or ' + esc(developer.email) : '') +
      '.<br>This page is personal to you — please do not forward the link.';

    var nextDue = s.next_due;

    el('portal-view').innerHTML =
      '<h1 class="serif" style="font-size:27px;font-weight:400;letter-spacing:-.02em">' +
        'Hello, ' + esc(String(account.customer.full_name).split(' ')[0]) + '.' +
      '</h1>' +
      '<p class="muted mt-1" style="font-size:14px">Here is where your payments stand.</p>' +

      // Headline: paid, balance, and the meter between them.
      '<div class="card mt-2"><div class="card-body">' +
        '<div style="display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap">' +
          '<div><div class="stat-label">Paid so far</div>' +
            '<div class="stat-value moss">' + esc(naira(s.total_paid)) + '</div></div>' +
          '<div style="text-align:right"><div class="stat-label">Balance</div>' +
            '<div class="stat-value">' + esc(naira(s.balance)) + '</div></div>' +
        '</div>' +
        '<div class="meter mt-2"><i style="width:' + s.progress_percent + '%"></i></div>' +
        '<div class="page-sub mt-1">' + s.progress_percent + '% of ' + esc(naira(s.total_contracted)) + ' settled</div>' +
      '</div></div>' +

      (s.overdue_count
        ? '<div class="notice mt-2">' +
            esc(naira(s.overdue_amount)) + ' is past due across ' +
            s.overdue_count + (s.overdue_count === 1 ? ' installment' : ' installments') +
            '. If you have already paid, please contact the sales office so it can be recorded.' +
          '</div>'
        : '') +

      (nextDue
        ? '<div class="card mt-2"><div class="card-body">' +
            '<div class="stat-label">Next payment</div>' +
            '<div style="display:flex;justify-content:space-between;gap:14px;align-items:flex-end;margin-top:8px;flex-wrap:wrap">' +
              '<div><div class="mono" style="font-size:21px">' + esc(naira(nextDue.amount_due)) + '</div>' +
                '<div class="page-sub">due ' + esc(fmtDate(nextDue.due_date)) +
                  (nextDue.unit_number ? ' · Unit ' + esc(nextDue.unit_number) : '') + '</div></div>' +
              '<button class="btn brass" id="btn-pay" data-schedule="' + esc(nextDue.schedule_id) + '">Pay now</button>' +
            '</div>' +
          '</div></div>'
        : '') +

      account.reservations.map(reservationBlock).join('') +

      (account.documents.length
        ? '<div class="card mt-2">' +
            '<div class="card-head"><div class="card-title">Your documents</div></div>' +
            '<div class="card-body flush">' +
              account.documents.map(function (d) {
                return '<div class="task">' +
                  '<div class="task-body"><div class="task-title">' +
                    esc(String(d.doc_type).replace(/_/g, ' ')) + '</div>' +
                    '<div class="task-meta">' + esc(fmtDate(d.generated_at)) + '</div></div>' +
                  '<button class="btn-quiet" data-doc="' + esc(d.id) + '">Download</button>' +
                '</div>';
              }).join('') +
            '</div>' +
          '</div>'
        : '');

    wire();
  }

  function reservationBlock(r) {
    var unit = r.re_units || {};
    var project = unit.re_projects || {};
    var plans = Array.isArray(r.re_installment_plans) ? r.re_installment_plans : (r.re_installment_plans ? [r.re_installment_plans] : []);

    var schedule = [];
    plans.forEach(function (plan) {
      (plan.re_installment_schedule || []).forEach(function (row) { schedule.push(row); });
    });
    schedule.sort(function (a, b) { return a.installment_number - b.installment_number; });

    return '<div class="card mt-2">' +
      '<div class="card-head">' +
        '<div class="card-title">' + esc(unit.unit_number ? 'Unit ' + unit.unit_number : 'Your unit') + '</div>' +
        '<div class="spacer"></div>' +
        '<span class="badge ' + esc(r.status) + '">' + esc(r.status) + '</span>' +
      '</div>' +
      '<div class="card-body">' +
        '<div class="page-sub" style="margin-top:0">' +
          esc([project.name, project.location].filter(Boolean).join(', ')) +
          (unit.unit_type ? ' · ' + esc(unit.unit_type) : '') +
        '</div>' +
        (schedule.length
          ? '<div class="mt-2">' + schedule.map(function (row) {
              return '<div class="sched ' + esc(row.status) + '">' +
                '<span class="sched-n">' + row.installment_number + '</span>' +
                '<span class="sched-main"><span class="mono">' + esc(naira(row.amount_due)) + '</span>' +
                  '<span class="page-sub">' +
                    (row.status === 'paid'
                      ? 'paid ' + esc(fmtDate(row.paid_at || row.due_date))
                      : 'due ' + esc(fmtDate(row.due_date))) +
                  '</span></span>' +
                '<span class="badge ' + esc(row.status) + '">' + esc(row.status) + '</span>' +
                (row.status !== 'paid'
                  ? '<button class="btn-quiet" data-schedule="' + esc(row.id) + '">Pay</button>'
                  : '') +
              '</div>';
            }).join('') + '</div>'
          : '<div class="page-sub mt-1">Outright purchase — no installment plan.</div>') +
      '</div>' +
    '</div>';
  }

  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-schedule]'), function (button) {
      button.addEventListener('click', async function () {
        button.disabled = true;
        button.classList.add('is-working');
        try {
          var result = await api('/pay/' + button.dataset.schedule, { method: 'POST', body: '{}' });
          // Same tab: a popup blocker eating the payment window is the single
          // most common way an online payment quietly fails to happen.
          window.location.href = result.authorization_url;
        } catch (err) {
          toast(err.message, 'err');
          button.disabled = false;
          button.classList.remove('is-working');
        }
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-doc]'), function (button) {
      button.addEventListener('click', async function () {
        button.disabled = true;
        button.classList.add('is-working');
        try {
          var result = await api('/documents/' + button.dataset.doc + '/download');
          window.open(result.download_url, '_blank', 'noopener');
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          button.disabled = false;
          button.classList.remove('is-working');
        }
      });
    });
  }

  document.addEventListener('DOMContentLoaded', load);
})();
