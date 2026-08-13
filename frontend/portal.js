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

  // No localhost fallback here, unlike the operator app. If config.js failed to
  // load — a CSP block, a bad path, a CDN timeout — a buyer would get a page
  // that silently tried to reach their own machine and then said "something
  // went wrong". Better to say what is actually broken.
  var API_BASE = window.__API_BASE__ || null;

  // ── The token, and surviving a trip to Paystack ──────────────────────────
  // Read from the fragment on first arrival, then kept in sessionStorage.
  //
  // sessionStorage, not localStorage, and the distinction is the whole point:
  // it is scoped to this one tab and destroyed when the tab closes, so a family
  // phone does not retain a credential. What it buys is the round trip — the
  // buyer leaves for Paystack and comes back to portal.html with no fragment,
  // and without this they would land on "this link is incomplete" immediately
  // after paying, which is the worst possible moment for it.
  var STORE_KEY = 'archta.portal.token';
  var PAID_KEY = 'archta.portal.paid';

  var fragmentToken = (/[#&]token=([^&]+)/.exec(window.location.hash) || [])[1] || '';
  var token = fragmentToken || session(STORE_KEY) || '';

  if (fragmentToken) {
    session(STORE_KEY, fragmentToken);
    try {
      // Strip the credential out of the address bar so it is not sitting there
      // when the buyer hands the phone to someone.
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (e) { /* file:// has no history API; harmless */ }
  }

  // ?paid=<schedule-id> comes back from Paystack's callback_url. The webhook is
  // usually a second or two behind the redirect, so the row is still 'pending'
  // when the buyer looks at it.
  var justPaidSchedule = (/[?&]paid=([^&]+)/.exec(window.location.search) || [])[1] || session(PAID_KEY) || '';
  if (justPaidSchedule) {
    session(PAID_KEY, justPaidSchedule);
    try {
      window.history.replaceState(null, '', window.location.pathname);
    } catch (e) { /* ignore */ }
  }

  function session(key, value) {
    try {
      if (value === undefined) return window.sessionStorage.getItem(key);
      if (value === null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, value);
    } catch (e) { /* private mode: the round trip degrades, nothing breaks */ }
    return value;
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function naira(amount) {
    var n = Number(amount || 0);
    return (n < 0 ? '-' : '') + '₦' + Math.abs(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });
  }

  function fmtDate(value) {
    if (!value) return '—';
    var d = new Date(value);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // "142 days left" reads faster than doing the subtraction from a date
  // stamped at the top of the same card.
  function daysUntil(dateStr) {
    var target = new Date(dateStr);
    if (isNaN(target.getTime())) return '';
    var days = Math.round((target.getTime() - Date.now()) / 86400000);
    if (days < 0) return 'Expired ' + Math.abs(days) + (Math.abs(days) === 1 ? ' day ago' : ' days ago');
    if (days === 0) return 'Ends today';
    return days + (days === 1 ? ' day left' : ' days left');
  }

  function el(id) { return document.getElementById(id); }

  // A computed value (the payment progress meter's width) cannot live in a
  // CSS class — the number comes from the data. It also can't live in a
  // style="" attribute: this page is served under a Content-Security-Policy
  // with no 'unsafe-inline' in style-src, which silently refuses to apply
  // any inline style attribute. Setting the CSSOM property directly from JS,
  // after the element already exists, is unaffected by that — so markup
  // carries `data-w="37"` instead, and this runs once against it.
  function applyDynamicStyles(root) {
    Array.prototype.slice.call(root.querySelectorAll('[data-w]')).forEach(function (n) {
      n.style.width = n.dataset.w + '%';
    });
  }

  function toast(message, kind) {
    var node = document.createElement('div');
    node.className = 'toast ' + (kind || '');
    node.innerHTML = '<span>' + esc(message) + '</span>';
    el('toasts').appendChild(node);
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 5000);
  }

  // A buyer on patchy mobile data deserves an actual answer, not a spinner
  // that sits forever because the request never resolved either way.
  var FETCH_TIMEOUT_MS = 20000;

  async function api(path, options) {
    var opts = options || {};
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS) : null;

    var res;
    try {
      res = await fetch(API_BASE + '/portal' + path, {
        method: opts.method || 'GET',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: opts.body,
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw Object.assign(new Error('That took too long to respond. Check your connection and try again.'), { status: 0 });
      }
      throw Object.assign(new Error('Could not reach the server. Check your connection and try again.'), { status: 0 });
    } finally {
      if (timer) clearTimeout(timer);
    }

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
  function fail(message, detail) {
    el('portal-view').innerHTML =
      '<div class="card"><div class="card-body portal-empty-body">' +
        '<div class="portal-empty-icon">◇</div>' +
        '<div class="serif portal-empty-title">' + esc(message) + '</div>' +
        '<p class="muted fs-13-5 lh-loose">' +
          esc(detail || 'Please contact your developer\'s sales office and ask them to send you a fresh link.') +
        '</p>' +
      '</div></div>';
  }

  async function load() {
    if (!API_BASE) {
      return fail('This page could not start up', 'A configuration file did not load. Please refresh, or ask your developer to send the link again.');
    }
    if (!token) {
      // An operator-generated payment link (routes/payments.js's own /init,
      // as opposed to the portal's own "pay" button) sends a buyer straight
      // to Paystack — they were never on this page before, so there is no
      // session token to come back to. Paystack's callback_url still points
      // here so they land somewhere after paying rather than a generic
      // Paystack page; without this branch that visit hit the same wall as a
      // genuinely broken link, right after a successful payment.
      if (justPaidSchedule) {
        return fail(
          'Payment received',
          'Thank you — we are confirming it now. You will get a receipt by email, '
            + 'and your developer\'s sales office can also confirm from their end.'
        );
      }
      return fail('This link is incomplete');
    }

    var account;
    try {
      account = await api('/me');
    } catch (err) {
      return fail(err.message);
    }

    var s = account.summary;
    var developer = account.developer || {};

    if (developer.company_name) el('developer-name').textContent = developer.company_name;

    // With no phone and no email configured this used to render "Questions
    // about your account? Contact Archta." — an instruction with nothing to
    // act on, naming the wrong company. If there is no way to make contact,
    // the offer is not made.
    var reach = [developer.phone, developer.email].filter(Boolean);
    el('portal-foot').innerHTML =
      (reach.length
        ? 'Questions about your account? Contact ' + esc(developer.company_name || 'your developer') +
          ' on ' + reach.map(esc).join(' or ') + '.<br>'
        : '') +
      'This page is personal to you — please do not forward the link.';

    var nextDue = s.next_due;
    var tenancy = s.tenancy;
    // A tenant's page and a buyer's page ask different first questions — "how
    // long have I got left?" vs "how much is left to pay?". `tenancy` is only
    // present when the customer holds a live rental, so this is the one flag
    // that decides the vocabulary for the rest of the page.
    var isRental = Boolean(tenancy) || (nextDue && nextDue.property_type === 'rental');

    el('portal-view').innerHTML =
      '<h1 class="serif portal-greeting">' +
        'Hello, ' + esc(String(account.customer.full_name).split(' ')[0]) + '.' +
      '</h1>' +
      '<p class="muted mt-1 fs-14">Here is where your payments stand.</p>' +

      // Headline: paid, balance, and the meter between them.
      '<div class="card mt-2"><div class="card-body">' +
        '<div class="flex-row justify-between gap-18">' +
          '<div><div class="stat-label">Paid so far</div>' +
            '<div class="stat-value moss">' + esc(naira(s.total_paid)) + '</div></div>' +
          '<div class="right"><div class="stat-label">Balance</div>' +
            '<div class="stat-value">' + esc(naira(s.balance)) + '</div></div>' +
        '</div>' +
        '<div class="meter mt-2"><i data-w="' + s.progress_percent + '"></i></div>' +
        '<div class="page-sub mt-1">' + s.progress_percent + '% of ' + esc(naira(s.total_contracted)) + ' settled</div>' +
      '</div></div>' +

      // The tenancy end date, prominent and near the top — not folded into the
      // reservation card below, because "how long have I got left?" is the
      // first thing a tenant opens this page to answer.
      (tenancy
        ? '<div class="card mt-2"><div class="card-body">' +
            '<div class="flex-row justify-between gap-14 align-end">' +
              '<div><div class="stat-label">Tenancy ends</div>' +
                '<div class="stat-value">' + esc(fmtDate(tenancy.tenancy_end_date)) + '</div></div>' +
              (tenancy.unit_number
                ? '<div class="page-sub right">Unit ' + esc(tenancy.unit_number) +
                  (tenancy.project_name ? '<br>' + esc(tenancy.project_name) : '') + '</div>'
                : '') +
            '</div>' +
            '<div class="page-sub mt-1">' + daysUntil(tenancy.tenancy_end_date) + '</div>' +
          '</div></div>'
        : '') +

      // Shown at the top, before anything else, because a buyer returning from
      // Paystack is looking for exactly one thing.
      (justPaidSchedule
        ? '<div class="notice info mt-2" id="paid-banner">' +
            '<b>Thank you — we are confirming your payment.</b><br>' +
            'This usually takes a few seconds. Your receipt will be emailed once it clears. ' +
            'You do not need to pay again.' +
          '</div>'
        : '') +

      (s.overdue_count
        ? '<div class="notice mt-2">' +
            esc(naira(s.overdue_amount)) + ' is past due across ' +
            s.overdue_count + (isRental
              ? (s.overdue_count === 1 ? ' rent payment' : ' rent payments')
              : (s.overdue_count === 1 ? ' installment' : ' installments')) +
            '. If you have already paid, please contact the ' + (isRental ? 'lettings' : 'sales') + ' office so it can be recorded.' +
          '</div>'
        : '') +

      (nextDue
        ? '<div class="card mt-2"><div class="card-body">' +
            '<div class="stat-label">' + (nextDue.property_type === 'rental' ? 'Next rent due' : 'Next payment') + '</div>' +
            '<div class="flex-row justify-between gap-14 align-end mt-8px">' +
              '<div><div class="mono fs-21">' + esc(naira(nextDue.amount_due)) + '</div>' +
                '<div class="page-sub">due <span class="nowrap">' + esc(fmtDate(nextDue.due_date)) + '</span>' +
                  (nextDue.unit_number ? ' · Unit ' + esc(nextDue.unit_number) : '') + '</div></div>' +
              '<button class="btn brass" id="btn-pay" data-schedule="' + esc(nextDue.schedule_id) + '">Pay now</button>' +
            '</div>' +
          '</div></div>'
        : '') +

      (account.reservations.length
        ? account.reservations.map(reservationBlock).join('')
        : '<div class="card mt-2"><div class="card-body portal-empty-body sm">' +
            '<p class="muted fs-13-5 lh-loose">' +
              'Nothing is on your account yet. Once your sales office records a reservation, it will show up here.' +
            '</p>' +
          '</div></div>') +

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

    applyDynamicStyles(el('portal-view'));
    wire();
    if (justPaidSchedule) watchForConfirmation(account);
  }

  // Polls until the webhook lands, then re-renders so the buyer sees "paid"
  // without touching anything.
  //
  // Bounded on purpose: eight tries at four seconds is about half a minute,
  // which covers a normal webhook. Past that the honest thing is to stop and
  // tell them it is recorded and being processed, rather than spin forever on
  // someone's mobile data.
  var confirmTries = 0;

  function watchForConfirmation(previous) {
    var settled = isSettled(previous, justPaidSchedule);
    if (settled) {
      session(PAID_KEY, null);
      justPaidSchedule = '';
      toast('Payment confirmed. Your receipt is on its way.', 'ok');
      // The toast just said this — the banner's own "we are confirming"
      // wording would otherwise sit on the page, now stale, until the next
      // full reload.
      var confirmedBanner = el('paid-banner');
      if (confirmedBanner) confirmedBanner.remove();
      return;
    }

    if (confirmTries >= 8) {
      var banner = el('paid-banner');
      if (banner) {
        banner.innerHTML = '<b>Your payment is recorded and still being confirmed.</b><br>' +
          'Refresh this page in a few minutes. If it has not cleared by then, contact the sales office — ' +
          'and please do not pay again in the meantime.';
      }
      return;
    }

    confirmTries += 1;
    setTimeout(function () { load(); }, 4000);
  }

  function isSettled(account, scheduleId) {
    if (!scheduleId) return false;
    var found = false;
    (account.reservations || []).forEach(function (r) {
      var plans = Array.isArray(r.re_installment_plans)
        ? r.re_installment_plans
        : (r.re_installment_plans ? [r.re_installment_plans] : []);
      plans.forEach(function (plan) {
        (plan.re_installment_schedule || []).forEach(function (row) {
          if (row.id === scheduleId && row.status === 'paid') found = true;
        });
      });
    });
    return found;
  }

  function reservationBlock(r) {
    var unit = r.re_units || {};
    var project = unit.re_projects || {};
    var plans = Array.isArray(r.re_installment_plans) ? r.re_installment_plans : (r.re_installment_plans ? [r.re_installment_plans] : []);
    var rental = r.property_type === 'rental';

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
        '<div class="page-sub mt-0">' +
          esc([project.name, project.location].filter(Boolean).join(', ')) +
          (unit.unit_type ? ' · ' + esc(unit.unit_type) : '') +
        '</div>' +
        (schedule.length
          ? '<div class="page-sub mt-2 label-caps">' +
              (rental ? 'Monthly rent' : 'Payment plan') +
            '</div>' +
            '<div class="mt-1">' + schedule.map(function (row) {
              return '<div class="sched ' + esc(row.status) + '">' +
                '<span class="sched-n">' + row.installment_number + '</span>' +
                '<span class="sched-main"><span class="mono">' + esc(naira(row.amount_due)) + '</span>' +
                  '<span class="page-sub">' +
                    (row.status === 'paid'
                      ? 'paid <span class="nowrap">' + esc(fmtDate(row.paid_at || row.due_date)) + '</span>'
                      : 'due <span class="nowrap">' + esc(fmtDate(row.due_date)) + '</span>') +
                  '</span></span>' +
                // A row the buyer has just paid shows "confirming", not
                // "pending" with a live Pay button beside it. That combination
                // is what talks somebody into paying the same installment
                // twice while the webhook is still in flight.
                (row.id === justPaidSchedule && row.status !== 'paid'
                  ? '<span class="badge pending">confirming…</span>'
                  : '<span class="badge ' + esc(row.status) + '">' + esc(row.status) + '</span>') +
                (row.status !== 'paid' && row.id !== justPaidSchedule
                  // Every row's button says just "Pay" visually — fine
                  // sighted, since it sits next to its own amount and date,
                  // but a screen reader lists all of them with no context
                  // distinguishing one installment's button from another's.
                  ? '<button class="btn-quiet" data-schedule="' + esc(row.id) + '" aria-label="Pay installment ' +
                    row.installment_number + ', ' + esc(naira(row.amount_due)) + ', due ' + esc(fmtDate(row.due_date)) + '">Pay</button>'
                  : '') +
              '</div>';
            }).join('') + '</div>'
          : '<div class="page-sub mt-1">' +
              (rental ? 'No rent schedule set up yet.' : 'Outright purchase — no installment plan.') +
            '</div>') +
      '</div>' +
    '</div>';
  }

  // The API requires an email for Paystack's receipt (see routes/portal.js)
  // and falls back to req.body.email when the buyer's own record has none —
  // this is the frontend half of that fallback. Without it, a buyer with no
  // email on file saw the "needs an email address" toast and no way to
  // actually supply one.
  async function initiatePay(scheduleId, email) {
    try {
      return await api('/pay/' + scheduleId, {
        method: 'POST',
        body: JSON.stringify(email ? { email: email } : {}),
      });
    } catch (err) {
      if (err.status === 400 && /email/i.test(err.message) && !email) {
        var entered = window.prompt('Enter an email address for your payment receipt:');
        if (entered && entered.trim()) return initiatePay(scheduleId, entered.trim());
      }
      throw err;
    }
  }

  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-schedule]'), function (button) {
      button.addEventListener('click', async function () {
        button.disabled = true;
        button.classList.add('is-working');
        try {
          var scheduleId = button.dataset.schedule;
          var result = await initiatePay(scheduleId);

          // Remembered before leaving, so the "confirming" state survives even
          // if Paystack drops the ?paid= parameter on the way back.
          session(PAID_KEY, scheduleId);

          // Same tab, not a popup: a blocker eating the payment window is the
          // most common way an online payment quietly fails to happen. The
          // return trip is handled by the token in sessionStorage.
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
          // An anchor click, not window.open. Mobile popup blockers are on by
          // default and drop window.open when the call is an await away from
          // the tap — which this one is, because the signed URL has to be
          // fetched first. The buyer would tap Download and see nothing.
          var a = document.createElement('a');
          a.href = result.download_url;
          a.target = '_blank';
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
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
