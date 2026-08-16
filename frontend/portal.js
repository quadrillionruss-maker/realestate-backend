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
  // SECTION 10 — display only (see src/services/exchangeRateService.js's own
  // comment); every actual payment still transacts in NGN regardless of
  // this. sessionStorage, not localStorage, matching the token's own
  // reasoning above — the reset-per-tab boundary already exists for a
  // reason, no need for a preference to outlive it either.
  var CURRENCY_KEY = 'archta.portal.currency';
  var exchangeRates = null;
  var displayCurrency = session(CURRENCY_KEY) || 'NGN';

  var fragmentToken = (/[#&]token=([^&]+)/.exec(window.location.hash) || [])[1] || '';
  var token = fragmentToken || session(STORE_KEY) || '';

  // SECTION 18 — portal.html#survey. Same fragment as the token (a survey
  // link is always the token PLUS this, never sent bare) — read alongside
  // it at the top, same "never transmitted to a server" reasoning the
  // token's own comment already gives, since a reservation id in a URL
  // fragment carries no more exposure risk than the token sitting right
  // next to it.
  var surveyReservationId = (/[#&]survey=([^&]+)/.exec(window.location.hash) || [])[1] || '';

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

  var CURRENCY_SYMBOL = { USD: '$', GBP: '£', EUR: '€', CAD: 'CA$' };

  // The small grey line under an NGN figure — nothing if NGN itself is the
  // preferred currency (redundant with the figure right above it) or the
  // rate cache has nothing yet (a fresh deploy's first six hours, or the
  // free-tier API being unreachable — exchangeRateService.js never lets
  // that fail the page, it just means no conversion to show).
  function fxLine(ngnAmount) {
    if (displayCurrency === 'NGN' || !exchangeRates || !exchangeRates.rates) return '';
    var rate = exchangeRates.rates[displayCurrency];
    if (!rate) return '';
    var converted = Number(ngnAmount || 0) * rate;
    var symbol = CURRENCY_SYMBOL[displayCurrency] || displayCurrency + ' ';
    return '<div class="fx-line">≈ ' + symbol + converted.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' ' + displayCurrency + '</div>';
  }

  // Unit pricing is marketing information international buyers reference in
  // dollars and pounds specifically, regardless of which currency a buyer
  // personally prefers for their OWN balance (fxLine above, toggle-driven) —
  // so this always shows both, not whichever one is currently selected.
  function fxLineFixed(ngnAmount) {
    if (!exchangeRates || !exchangeRates.rates) return '';
    var parts = ['USD', 'GBP'].map(function (code) {
      var rate = exchangeRates.rates[code];
      if (!rate) return null;
      var converted = Number(ngnAmount || 0) * rate;
      return (CURRENCY_SYMBOL[code] || code) + converted.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }).filter(Boolean);
    return parts.length ? '<div class="fx-line">≈ ' + parts.join(' · ') + '</div>' : '';
  }

  function fmtDate(value) {
    if (!value) return '—';
    var d = new Date(value);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // TASK 2.9/2.12 — same formatter as screens.js's formatDocType, duplicated
  // rather than imported: this file shares no JS with the operator app by
  // design (see this file's own header).
  var DOC_TYPE_MINOR_WORDS = { of: 1, and: 1, the: 1 };
  function formatDocType(type) {
    return String(type || '').replace(/_/g, ' ').split(' ').map(function (word, i) {
      if (!word) return word;
      if (i > 0 && DOC_TYPE_MINOR_WORDS[word.toLowerCase()]) return word.toLowerCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }).join(' ');
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

  // SECTION 18 — three star ratings + an open comment, submitted once. A
  // reservation not in account.reservations (a stale/forwarded link, or one
  // for a different buyer entirely) reads as a plain "link not valid"
  // rather than confirming a reservation id exists at all.
  var SURVEY_QUESTIONS = [
    ['overall_score', 'Overall, how was your experience with us?'],
    ['construction_quality_score', 'How would you rate the construction quality?'],
    ['sales_experience_score', 'How would you rate your experience with our sales team?'],
  ];

  function starRatingHtml(fieldName) {
    var stars = '';
    for (var i = 1; i <= 5; i++) {
      stars += '<button type="button" class="star-btn" data-star-field="' + fieldName + '" data-star-value="' + i + '" aria-label="' + i + ' star' + (i > 1 ? 's' : '') + '">★</button>';
    }
    return '<div class="star-row" data-star-group="' + fieldName + '">' + stars + '</div>';
  }

  function renderSurvey(account, reservationId) {
    var reservation = account.reservations.filter(function (r) { return r.id === reservationId; })[0];
    if (!reservation) {
      return fail('This survey link is not valid', 'It may be for a different account, or the link is incomplete.');
    }

    var unit = reservation.re_units || {};
    var project = unit.re_projects || {};
    var context = [project.name, unit.unit_number ? 'Unit ' + unit.unit_number : ''].filter(Boolean).map(esc).join(' · ');

    el('portal-view').innerHTML =
      '<div class="card"><div class="card-body">' +
        '<div class="serif portal-empty-title mb-1">How was your experience?</div>' +
        (context ? '<p class="muted fs-13-5 mb-2">' + context + '</p>' : '') +
        SURVEY_QUESTIONS.map(function (q) {
          return '<div class="field mb-2"><label>' + esc(q[1]) + '</label>' + starRatingHtml(q[0]) + '</div>';
        }).join('') +
        '<div class="field mb-2"><label for="survey-comments">Anything else you would like to share? (optional)</label>' +
          '<textarea class="textarea" id="survey-comments" rows="3"></textarea></div>' +
        '<button class="btn primary" type="button" id="survey-submit">Submit</button>' +
        '<p class="field-error hidden" id="survey-error" role="alert"></p>' +
      '</div></div>';

    var scores = {};
    document.querySelectorAll('[data-star-field]').forEach(function (button) {
      button.addEventListener('click', function () {
        var field = button.dataset.starField;
        var value = Number(button.dataset.starValue);
        scores[field] = value;
        var group = document.querySelector('[data-star-group="' + field + '"]');
        group.querySelectorAll('[data-star-field]').forEach(function (b) {
          b.classList.toggle('is-filled', Number(b.dataset.starValue) <= value);
        });
      });
    });

    el('survey-submit').addEventListener('click', async function () {
      var button = el('survey-submit');
      button.disabled = true;
      button.classList.add('is-working');
      var errorEl = el('survey-error');
      errorEl.classList.add('hidden');

      try {
        await api('/survey/' + reservationId, {
          method: 'POST',
          body: JSON.stringify({
            overall_score: scores.overall_score || null,
            construction_quality_score: scores.construction_quality_score || null,
            sales_experience_score: scores.sales_experience_score || null,
            comments: el('survey-comments').value.trim() || null,
          }),
        });
        el('portal-view').innerHTML =
          '<div class="card"><div class="card-body portal-empty-body">' +
            '<div class="portal-empty-icon">◇</div>' +
            '<div class="serif portal-empty-title">Thank you</div>' +
            '<p class="muted fs-13-5 lh-loose">Your feedback has been recorded.</p>' +
          '</div></div>';
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.classList.remove('hidden');
        button.disabled = false;
        button.classList.remove('is-working');
      }
    });
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

    // SECTION 18 — the whole page becomes the survey when this fragment is
    // present, rather than one more card jammed into the normal scroll: a
    // buyer who was texted a survey link is answering ONE question set, not
    // browsing their account. renderSurvey checks the reservation actually
    // belongs to this buyer itself (account.reservations, already scoped to
    // them by GET /portal/me) before showing anything.
    if (surveyReservationId) {
      return renderSurvey(account, surveyReservationId);
    }

    // Never blocks the page — a buyer's balance and schedule matter far more
    // than a currency conversion, so this failing (or the rate cache simply
    // having nothing yet) just means fxLine() renders nothing.
    try {
      exchangeRates = await api('/exchange-rates');
    } catch (err) { exchangeRates = null; }

    var currencySelect = el('currency-select');
    if (exchangeRates && exchangeRates.rates && Object.keys(exchangeRates.rates).length) {
      currencySelect.classList.remove('hidden');
      currencySelect.value = displayCurrency;
      // Property assignment, not addEventListener: load() re-runs this same
      // block on every reload (a payment, a sent message, this very
      // handler), and the <select> itself is never replaced — an
      // addEventListener here would stack a new listener each time and fire
      // load() once per accumulated listener on the next change.
      currencySelect.onchange = function () {
        displayCurrency = currencySelect.value;
        session(CURRENCY_KEY, displayCurrency);
        load();
      };
    }

    var s = account.summary;
    var developer = account.developer || {};

    // SECTION 13 — the project the Community card talks to. Pulled from
    // whichever reservation has one (the first that does, not blindly the
    // first reservation, in case a buyer's very first entry is somehow
    // missing a project link).
    communityOwnCustomerId = account.customer.id;
    activeProjectId = null;
    for (var ri = 0; ri < account.reservations.length; ri++) {
      var riProject = account.reservations[ri].re_units && account.reservations[ri].re_units.re_projects;
      if (riProject && riProject.id) { activeProjectId = riProject.id; break; }
    }

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
            '<div class="stat-value moss">' + esc(naira(s.total_paid)) + '</div>' + fxLine(s.total_paid) + '</div>' +
          '<div class="right"><div class="stat-label">Balance</div>' +
            '<div class="stat-value">' + esc(naira(s.balance)) + '</div>' + fxLine(s.balance) + '</div>' +
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
              '<div><div class="mono fs-21">' + esc(naira(nextDue.amount_due)) + '</div>' + fxLine(nextDue.amount_due) +
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
                    esc(formatDocType(d.doc_type)) + '</div>' +
                    '<div class="task-meta">' + esc(fmtDate(d.generated_at)) + '</div></div>' +
                  '<button class="btn-quiet" data-doc="' + esc(d.id) + '">Download</button>' +
                '</div>';
              }).join('') +
            '</div>' +
          '</div>'
        : '') +

      // SECTION 5 — every buyer has a code (migrations/024's DB default), so
      // this always renders, not just for someone who has already referred
      // anyone. The share link is a plain wa.me text-intent, not a page of
      // its own — this product has no public buyer self-registration, so a
      // referred friend hands the code to the developer's rep in person or
      // over the phone, the same way "How did they find you? → Referral" has
      // always worked; the code just lets that get formally credited.
      (account.customer.referral_code
        ? '<div class="card mt-2"><div class="card-body">' +
            '<div class="stat-label">Your referral code</div>' +
            '<div class="mono fs-21 mt-1">' + esc(account.customer.referral_code) + '</div>' +
            (account.customer.referral_credit_balance > 0
              ? '<div class="page-sub mt-1">' + esc(naira(account.customer.referral_credit_balance)) +
                  ' referral credit on your account, to be applied to a future payment.</div>'
              : '') +
            '<div class="btn-row mt-2">' +
              '<button class="btn-quiet" id="btn-copy-referral">Copy code</button>' +
              '<a class="btn-quiet" target="_blank" rel="noopener" href="https://wa.me/?text=' +
                encodeURIComponent('Use my referral code ' + account.customer.referral_code + ' when you buy with '
                  + (developer.company_name || 'us') + '!') +
                '">Share on WhatsApp</a>' +
            '</div>' +
          '</div></div>'
        : '') +

      // SECTION 9 — shown only once eligible (30% of the account paid, credit
      // score above 40 — financingService.isEligible, computed server-side).
      // Applies against the first reservation on the account, same reasoning
      // Messages below gives for using one reservation to name in the URL.
      (s.financing_eligible && account.reservations.length
        ? '<div class="card mt-2"><div class="card-body">' +
            '<div class="stat-label">Bank financing</div>' +
            '<p class="page-sub mt-1">Use your payment history with us as proof of creditworthiness when applying for financing.</p>' +
            '<button class="btn-quiet mt-1" id="btn-financing-toggle">Apply for bank financing</button>' +
            '<div class="hidden mt-2" id="financing-form">' +
              '<div class="field"><label>Bank name</label><input class="input" id="financing-bank" placeholder="e.g. GTBank"></div>' +
              '<div class="field"><label>Amount requested</label><div class="input-money"><input class="input" id="financing-amount" type="number" min="1" step="1"></div></div>' +
              '<div class="field"><label>Note (optional)</label><textarea class="input" id="financing-notes" rows="2"></textarea></div>' +
              '<button class="btn brass" id="btn-financing-submit">Submit application</button>' +
            '</div>' +
          '</div></div>'
        : '') +

      // SECTION 5 — a shared thread with the developer, whichever reservation
      // the buyer holds. There is no reservation picker: re_messages is one
      // thread per buyer, not per unit, so the first reservation on the
      // account is enough to name in the URL — see routes/portal.js.
      (account.reservations.length
        ? '<div class="card mt-2">' +
            '<div class="card-head"><div class="card-title">Messages</div></div>' +
            '<div class="card-body">' +
              '<div id="message-thread" class="message-thread"><p class="page-sub">Loading…</p></div>' +
              '<div class="field mt-2"><textarea class="input" id="message-input" rows="2" placeholder="Write a message to your developer"></textarea></div>' +
              '<button class="btn brass" id="btn-send-message">Send</button>' +
            '</div>' +
          '</div>'
        : '') +

      // SECTION 13 — one community per PROJECT, not per buyer. Uses the
      // first reservation's own project, same reasoning Messages above
      // gives for using the first reservation to name a URL when there is
      // no picker on this single-column page.
      (activeProjectId
        ? '<div class="card mt-2">' +
            '<div class="card-head"><div class="card-title">Community</div></div>' +
            '<div class="card-body">' +
              '<div id="community-thread"><p class="page-sub">Loading…</p></div>' +
              // SECTION 19 — "below the posts", inside the same card: this
              // motivates posting/referring in the same breath the buyer is
              // already reading the community, not a separate destination.
              '<div id="community-referrers" class="mt-2"></div>' +
              '<div class="field mt-2"><textarea class="input" id="community-post-input" rows="2" maxlength="500" placeholder="Share something with other buyers in this project"></textarea></div>' +
              '<button class="btn brass" id="btn-post-community">Post</button>' +
            '</div>' +
          '</div>'
        : '');

    applyDynamicStyles(el('portal-view'));
    wire();
    if (account.reservations.length) loadMessages(account.reservations[0].id);
    if (activeProjectId) { loadCommunity(); loadReferralLeaderboard(); }
    if (justPaidSchedule) watchForConfirmation(account);

    // SECTION 20 — needs a reservation id the same way Messages does (there
    // is no picker on this single-column page — see that section's own
    // comment for why the first reservation stands in for "this account").
    if (account.reservations.length) {
      activeReservationId = activeReservationId || account.reservations[0].id;
      el('btn-portal-notifications').classList.remove('hidden');
      wirePortalBell();
      refreshPortalNotifBell();
    }
  }

  // SECTION 20 — the portal bell. Same shape as the staff-side one
  // (realestate.js's refreshNotifBell/openNotifDropdown) but its own copy:
  // this file shares nothing else with the operator app's JS, per this
  // file's own header comment, so duplicating a hundred lines here is more
  // in keeping with that boundary than reaching across to reuse it.
  var portalNotifItems = [];
  var portalNotifDropdownOpen = false;

  async function refreshPortalNotifBell() {
    var badge = el('portal-notif-count');
    if (!badge || !activeReservationId) return;
    try {
      var result = await api('/notifications/' + activeReservationId);
      portalNotifItems = result.items;
      badge.textContent = result.unread_count > 9 ? '9+' : String(result.unread_count);
      badge.classList.toggle('hidden', !result.unread_count);
    } catch (err) { /* the bell degrades quietly — it is not core account functionality */ }
  }

  function closePortalNotifDropdown() {
    var dropdown = el('portal-notif-dropdown');
    if (dropdown) dropdown.classList.add('hidden');
    portalNotifDropdownOpen = false;
    document.removeEventListener('mousedown', onPortalNotifDocClick);
  }

  function onPortalNotifDocClick(e) {
    var dropdown = el('portal-notif-dropdown');
    var button = el('btn-portal-notifications');
    if (dropdown && !dropdown.contains(e.target) && button && !button.contains(e.target)) closePortalNotifDropdown();
  }

  function openPortalNotifDropdown() {
    var dropdown = el('portal-notif-dropdown');
    if (!dropdown) return;
    dropdown.innerHTML = portalNotifItems.length
      ? portalNotifItems.map(function (n) {
          return '<button class="notif-row' + (n.read_at ? '' : ' is-unread') + '" data-portal-notif-id="' + esc(n.id) + '" data-portal-notif-type="' + esc(n.type) + '">' +
            '<div class="notif-title">' + esc(n.title) + '</div>' +
            (n.body ? '<div class="notif-body">' + esc(n.body) + '</div>' : '') +
          '</button>';
        }).join('')
      : '<div class="notif-row"><div class="notif-body">Nothing yet.</div></div>';
    dropdown.classList.remove('hidden');
    portalNotifDropdownOpen = true;

    document.querySelectorAll('[data-portal-notif-id]').forEach(function (row) {
      row.addEventListener('click', async function () {
        closePortalNotifDropdown();
        var id = row.dataset.portalNotifId;
        try { await api('/notifications/' + activeReservationId + '/' + id + '/read', { method: 'POST' }); } catch (e) { /* not worth blocking navigation over */ }
        refreshPortalNotifBell();
        // SECTION 20 — "navigate to the relevant section": each type maps
        // to the one card already on this single-column page that answers
        // it, scrolled into view rather than a route change (there is no
        // router on this page — see this file's own header).
        var targetId = { payment_recorded: null, document_ready: null,
          hardship_approved: null, message_received: 'message-thread', developer_update: 'community-thread' }[row.dataset.portalNotifType];
        var target = targetId ? el(targetId) : null;
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    setTimeout(function () { document.addEventListener('mousedown', onPortalNotifDocClick); }, 0);
  }

  function wirePortalBell() {
    var button = el('btn-portal-notifications');
    if (!button || button.dataset.wired) return;
    button.dataset.wired = 'true';
    button.addEventListener('click', function () {
      if (portalNotifDropdownOpen) closePortalNotifDropdown();
      else openPortalNotifDropdown();
    });
  }

  var REFERRAL_MEDALS = ['🥇', '🥈', '🥉'];

  async function loadReferralLeaderboard() {
    var host = el('community-referrers');
    if (!host) return;
    try {
      var leaders = await api('/community/' + activeProjectId + '/referral-leaderboard');
      host.innerHTML = leaders.length
        ? '<div class="page-sub label-caps mb-1">Top referrers</div>' +
          leaders.map(function (l, i) {
            return '<div class="flex-row justify-between gap-10 mb-1">' +
              '<span>' + (i < 3 ? REFERRAL_MEDALS[i] + ' ' : (i + 1) + '. ') + esc(l.first_name) + '</span>' +
              '<span class="muted">' + l.referral_count + ' referral' + (l.referral_count === 1 ? '' : 's') + '</span>' +
            '</div>';
          }).join('')
        : '';
    } catch (err) {
      host.innerHTML = ''; // quietly absent rather than an error box under the posts — this is a motivational extra, not core functionality
    }
  }

  var activeReservationId = null;
  // Set inside load(), just before el('portal-view').innerHTML is built —
  // see the assignment a few lines above this function.
  var activeProjectId = null;

  async function loadCommunity() {
    try {
      var posts = await api('/community/' + activeProjectId);
      renderCommunity(posts);
    } catch (err) {
      var host = el('community-thread');
      if (host) host.innerHTML = '<p class="page-sub">' + esc(err.message) + '</p>';
    }
  }

  function renderCommunity(posts) {
    var host = el('community-thread');
    if (!host) return;
    host.innerHTML = posts.length
      ? posts.map(function (p) {
          return '<div class="drawer-section">' +
            '<div class="flex-row justify-between gap-10">' +
              '<span>' + (p.pinned ? '<span class="badge pinned">Pinned</span> ' : '') + '<b>' + esc(p.author_name) + '</b></span>' +
              '<span class="page-sub nowrap">' + esc(fmtDate(p.created_at)) + '</span>' +
            '</div>' +
            '<div class="mt-1">' + esc(p.content) + '</div>' +
            (p.customer_id === communityOwnCustomerId
              ? '<button class="btn-quiet mt-1" data-community-delete="' + esc(p.id) + '">Delete</button>'
              // TASK 3 AUDIT FIX (Important #13) — reporting is only offered on
              // someone ELSE's post; reporting your own has no sensible meaning.
              : '<button class="btn-quiet mt-1" data-community-report="' + esc(p.id) + '">Report</button>') +
            (p.replies.length
              ? '<div class="mt-1 community-replies">' + p.replies.map(function (r) {
                  return '<div class="mt-1"><b class="fs-12">' + esc(r.author_name) + '</b> ' +
                    '<span class="page-sub fs-11-5">' + esc(fmtDate(r.created_at)) + '</span>' +
                    '<div>' + esc(r.content) + '</div></div>';
                }).join('') + '</div>'
              : '') +
            '<button class="btn-quiet mt-1" data-community-reply-toggle="' + esc(p.id) + '">Reply</button>' +
            '<div class="hidden mt-1" data-community-reply-form="' + esc(p.id) + '">' +
              '<textarea class="input" data-community-reply-input="' + esc(p.id) + '" rows="2" maxlength="300"></textarea>' +
              '<button class="btn-quiet mt-1" data-community-reply-submit="' + esc(p.id) + '">Send reply</button>' +
            '</div>' +
          '</div>';
        }).join('')
      : '<p class="page-sub">No posts yet. Say hello to your fellow buyers.</p>';
  }

  // Set once from GET /me — the portal token resolves to exactly one
  // customer, so "is this my own post" is a plain id comparison, no
  // separate identity check needed the way staff moderation would.
  var communityOwnCustomerId = null;

  async function loadMessages(reservationId) {
    activeReservationId = reservationId;
    try {
      var thread = await api('/messages/' + reservationId);
      renderThread(thread);
    } catch (err) {
      var host = el('message-thread');
      if (host) host.innerHTML = '<p class="page-sub">' + esc(err.message) + '</p>';
    }
  }

  function renderThread(thread) {
    var host = el('message-thread');
    if (!host) return;
    host.innerHTML = thread.length
      ? thread.map(function (m) {
          return '<div class="message-row ' + (m.sender_type === 'buyer' ? 'mine' : 'theirs') + '">' +
            '<div class="message-bubble">' + esc(m.message) + '</div>' +
            '<div class="page-sub">' + (m.sender_type === 'buyer' ? 'You' : 'Developer') + ' · ' + esc(fmtDate(m.created_at)) + '</div>' +
          '</div>';
        }).join('')
      : '<p class="page-sub">No messages yet. Say hello.</p>';
    host.scrollTop = host.scrollHeight;
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

  function unitFactsLine(unit) {
    var parts = [];
    if (unit.bedrooms != null) parts.push(unit.bedrooms + (unit.bedrooms === 1 ? ' bed' : ' beds'));
    if (unit.bathrooms != null) parts.push(unit.bathrooms + (unit.bathrooms === 1 ? ' bath' : ' baths'));
    if (unit.parking_spaces != null) parts.push(unit.parking_spaces + ' parking');
    if (unit.floor_level != null) parts.push(unit.floor_level === 0 ? 'Ground floor' : 'Floor ' + unit.floor_level);
    if (unit.furnishing_status) parts.push(unit.furnishing_status.replace(/-/g, ' '));
    return parts.join(' · ');
  }

  function unitPhotos(unit) {
    var media = (unit.metadata && Array.isArray(unit.metadata.media)) ? unit.metadata.media : [];
    return media.filter(function (m) { return m.kind === 'photo'; });
  }

  function unitFloorPlanUrl(unit) {
    if (unit.metadata && unit.metadata.floor_plan_url) return unit.metadata.floor_plan_url;
    var media = (unit.metadata && Array.isArray(unit.metadata.media)) ? unit.metadata.media : [];
    var plan = media.find(function (m) { return m.kind === 'floor_plan'; });
    return plan ? plan.url : null;
  }

  // Highlights whichever step the document is CURRENTLY at, not every step
  // it has passed through — pending/generated/sent/signed is a single
  // current state (re_documents.status), not a set of completed milestones.
  function legalDocStep(doc) {
    return '<div class="legal-step ' + esc(doc.status) + '">' +
      '<div class="legal-step-dot"></div>' +
      '<div class="legal-step-body">' +
        '<div class="flex-row justify-between gap-10">' +
          '<span>' + esc(doc.label) + '</span>' +
          '<span class="badge ' + esc(doc.status) + '">' + esc(doc.status) + '</span>' +
        '</div>' +
        (doc.id
          ? (doc.status === 'generated' || doc.status === 'sent' || doc.status === 'signed'
              ? '<button class="btn-quiet mt-1" data-doc="' + esc(doc.id) + '">Download</button>'
              : '')
          : '<p class="page-sub mt-1">This document will be available after your reservation is confirmed.</p>') +
      '</div>' +
    '</div>';
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

        // SECTION 10 — the unit's own list price, in NGN plus a fixed
        // USD/GBP reference (fxLineFixed, not the toggle) — see that
        // function's own comment for why this one line stays fixed while
        // the buyer's personal balance/payment figures follow their
        // preferred currency instead.
        (unit.list_price
          ? '<div class="page-sub mt-1">List price: ' + esc(naira(unit.list_price)) + '</div>' + fxLineFixed(unit.list_price)
          : '') +

        // SECTION 15 — worded generically on purpose: never "health
        // score", never a number out of 100. This nudges a buyer to ask
        // their developer for an update; it does not publicly grade them.
        (r.project_health_notice
          ? '<div class="notice mt-1">Your developer has not updated construction progress in ' +
              (r.project_health_notice.days_since_update != null ? r.project_health_notice.days_since_update + ' days' : 'a while') +
              '. Contact your developer for an update.</div>'
          : '') +

        // SECTION 6 — bedrooms/bathrooms/parking/floor only show what is
        // actually on file; a unit nobody has entered these for renders no
        // row at all rather than "0 bed, 0 bath".
        (unitFactsLine(unit) ? '<div class="page-sub mt-1">' + esc(unitFactsLine(unit)) + '</div>' : '') +
        (unitPhotos(unit).length
          ? '<div class="unit-photos mt-2">' + unitPhotos(unit).map(function (p) {
              return '<img class="unit-photo" src="' + esc(p.url) + '" alt="' + esc(p.label || 'Unit photo') + '">';
            }).join('') + '</div>'
          : '') +
        (unitFloorPlanUrl(unit)
          ? '<a class="btn-quiet mt-1" target="_blank" rel="noopener" href="' + esc(unitFloorPlanUrl(unit)) + '">Download floor plan</a>'
          : '') +

        (r.construction
          ? '<div class="page-sub mt-2 label-caps">Construction progress</div>' +
            '<div class="flex-row justify-between gap-14 align-end mt-1">' +
              '<div><div class="mono fs-21">' + esc(r.construction.name) + '</div>' +
                '<div class="page-sub">' + r.construction.completion_percentage + '% complete' +
                  (r.construction.status === 'completed' && r.construction.completed_date
                    ? ' · reached <span class="nowrap">' + esc(fmtDate(r.construction.completed_date)) + '</span>'
                    : r.construction.target_date
                      ? ' · targeting <span class="nowrap">' + esc(fmtDate(r.construction.target_date)) + '</span>'
                      : '') +
                '</div></div>' +
              '<span class="badge ' + esc(r.construction.status) + '">' + esc(r.construction.status.replace(/_/g, ' ')) + '</span>' +
            '</div>' +
            (r.construction.latest_photo_url
              ? '<img class="construction-photo mt-2" src="' + esc(r.construction.latest_photo_url) + '" alt="Latest construction photo — ' + esc(r.construction.name) + '">'
              : '')
          : '') +
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

        // SECTION 7 — a fixed three-step vertical timeline (pending →
        // generated → sent → signed), always all three, whether or not a
        // document has been started — see portalService.js's
        // LEGAL_DOC_TYPES for why the order and the three types are fixed.
        (r.legal_documents && r.legal_documents.length
          ? '<div class="page-sub mt-2 label-caps">Legal documents</div>' +
            '<div class="legal-timeline mt-1">' + r.legal_documents.map(legalDocStep).join('') + '</div>'
          : '') +

        // SECTION 4 — "once per reservation" (migrations/030): the button
        // itself disappears once a request is pending or has ever been
        // approved, rather than the page relying on a 400 from the server
        // to explain why nothing happened.
        (r.hardship && r.hardship.can_request
          ? '<div class="mt-2">' +
              '<button class="btn-quiet" data-hardship-toggle="' + esc(r.id) + '">Request payment pause</button>' +
              '<div class="hidden mt-1" data-hardship-form="' + esc(r.id) + '">' +
                '<div class="field"><label>Reason</label>' +
                  '<textarea class="input" data-hardship-reason="' + esc(r.id) + '" rows="3" ' +
                    'placeholder="Tell us briefly what has changed (at least 20 characters)"></textarea></div>' +
                '<div class="field"><label>How many months do you need?</label>' +
                  '<select class="select" data-hardship-months="' + esc(r.id) + '">' +
                    '<option value="1">1 month</option><option value="2">2 months</option><option value="3">3 months</option>' +
                  '</select></div>' +
                '<p class="page-sub">This pauses upcoming due dates — nothing owed is forgiven, it moves to later in your plan. ' +
                  'An owner or sales director reviews every request.</p>' +
                '<button class="btn brass" data-hardship-submit="' + esc(r.id) + '">Submit request</button>' +
              '</div>' +
            '</div>'
          : (r.hardship && r.hardship.status === 'pending'
              ? '<p class="page-sub mt-2">Your payment pause request is pending review.</p>'
              : '')) +

        // SECTION 11 — the Handover tab, only once this reservation is
        // actually 'completed' — portalService.js never attaches
        // r.handover for anything else, so this is equivalent to gating on
        // reservation status directly.
        (r.handover
          ? '<div class="page-sub mt-2 label-caps">Handover</div>' +
            '<div class="flex-row justify-between gap-10 mt-1">' +
              '<span>' + badge(r.handover.status) + (r.handover.keys_handed ? ' <span class="page-sub">Keys handed over</span>' : '') + '</span>' +
            '</div>' +
            (r.handover.snagging_items.length
              ? '<div class="mt-1">' + r.handover.snagging_items.map(function (s) {
                  return '<div class="activity-row">' +
                    '<div class="flex-row justify-between gap-10">' + badge(s.status) +
                      '<span class="page-sub nowrap">' + esc(fmtDate(s.created_at)) + '</span></div>' +
                    '<div class="mt-1">' + esc(s.description) + '</div>' +
                    (s.photo_url ? '<img class="unit-photo mt-1" src="' + esc(s.photo_url) + '" alt="Snagging photo">' : '') +
                    (s.developer_response ? '<div class="page-sub mt-1">Developer: ' + esc(s.developer_response) + '</div>' : '') +
                    (s.fix_committed_date ? '<div class="page-sub">Fix committed by ' + esc(fmtDate(s.fix_committed_date)) + '</div>' : '') +
                  '</div>';
                }).join('') + '</div>'
              : '<p class="page-sub mt-1">No snagging items reported yet.</p>') +
            '<button class="btn-quiet mt-1" data-snag-toggle="' + esc(r.id) + '">Log a snagging item</button>' +
            '<div class="hidden mt-1" data-snag-form="' + esc(r.id) + '">' +
              '<div class="field"><label>Describe the issue</label>' +
                '<textarea class="input" data-snag-description="' + esc(r.id) + '" rows="2"></textarea></div>' +
              '<div class="field"><label>Photo (optional)</label>' +
                '<input class="input" type="file" accept="image/jpeg,image/png,image/webp" data-snag-photo="' + esc(r.id) + '"></div>' +
              '<button class="btn brass" data-snag-submit="' + esc(r.id) + '">Submit</button>' +
            '</div>'
          : '') +
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

    Array.prototype.forEach.call(document.querySelectorAll('[data-hardship-toggle]'), function (button) {
      button.addEventListener('click', function () {
        var form = document.querySelector('[data-hardship-form="' + button.dataset.hardshipToggle + '"]');
        if (form) form.classList.toggle('hidden');
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-hardship-submit]'), function (button) {
      button.addEventListener('click', async function () {
        var reservationId = button.dataset.hardshipSubmit;
        var reasonField = document.querySelector('[data-hardship-reason="' + reservationId + '"]');
        var monthsField = document.querySelector('[data-hardship-months="' + reservationId + '"]');
        var reason = (reasonField.value || '').trim();

        if (reason.length < 20) {
          toast('Please explain in at least 20 characters.', 'err');
          return;
        }

        button.disabled = true;
        button.classList.add('is-working');
        try {
          await api('/hardship-request/' + reservationId, {
            method: 'POST',
            body: JSON.stringify({ reason: reason, pause_months: Number(monthsField.value) }),
          });
          toast('Request submitted. Your developer will review it shortly.', 'ok');
          load();
        } catch (err) {
          toast(err.message, 'err');
          button.disabled = false;
          button.classList.remove('is-working');
        }
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-snag-toggle]'), function (button) {
      button.addEventListener('click', function () {
        var form = document.querySelector('[data-snag-form="' + button.dataset.snagToggle + '"]');
        if (form) form.classList.toggle('hidden');
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-snag-submit]'), function (button) {
      button.addEventListener('click', async function () {
        var reservationId = button.dataset.snagSubmit;
        var description = (document.querySelector('[data-snag-description="' + reservationId + '"]').value || '').trim();
        var fileInput = document.querySelector('[data-snag-photo="' + reservationId + '"]');
        var file = fileInput.files && fileInput.files[0];

        if (!description) { toast('Describe the issue.', 'err'); return; }

        button.disabled = true;
        button.classList.add('is-working');
        try {
          var photo = null;
          if (file) {
            var base64 = await new Promise(function (resolve, reject) {
              var reader = new FileReader();
              reader.onload = function () { resolve(String(reader.result).split(',')[1]); };
              reader.onerror = function () { reject(new Error('could not be read')); };
              reader.readAsDataURL(file);
            });
            photo = { content: base64, contentType: file.type };
          }

          await api('/handover/' + reservationId + '/snag', {
            method: 'POST',
            body: JSON.stringify({ description: description, photo: photo }),
          });
          toast('Snagging item reported.', 'ok');
          load();
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          button.disabled = false;
          button.classList.remove('is-working');
        }
      });
    });

    var financingToggle = el('btn-financing-toggle');
    if (financingToggle) {
      financingToggle.addEventListener('click', function () {
        el('financing-form').classList.toggle('hidden');
      });
    }

    var financingSubmit = el('btn-financing-submit');
    if (financingSubmit) {
      financingSubmit.addEventListener('click', async function () {
        var bank = (el('financing-bank').value || '').trim();
        var amount = Number(el('financing-amount').value);
        var notes = (el('financing-notes').value || '').trim();

        if (!bank) { toast('Enter a bank name.', 'err'); return; }
        if (!(amount > 0)) { toast('Enter the amount you are requesting.', 'err'); return; }

        financingSubmit.disabled = true;
        financingSubmit.classList.add('is-working');
        try {
          await api('/financing-request/' + activeReservationId, {
            method: 'POST',
            body: JSON.stringify({ bank_name: bank, amount_requested: amount, notes: notes }),
          });
          toast('Application submitted. Your developer will review and forward it to the bank.', 'ok');
          el('financing-form').classList.add('hidden');
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          financingSubmit.disabled = false;
          financingSubmit.classList.remove('is-working');
        }
      });
    }

    var postCommunity = el('btn-post-community');
    if (postCommunity) {
      postCommunity.addEventListener('click', async function () {
        var input = el('community-post-input');
        var text = (input.value || '').trim();
        if (!text) return;

        postCommunity.disabled = true;
        postCommunity.classList.add('is-working');
        try {
          await api('/community/' + activeProjectId, { method: 'POST', body: JSON.stringify({ content: text }) });
          input.value = '';
          await loadCommunity();
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          postCommunity.disabled = false;
          postCommunity.classList.remove('is-working');
        }
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-community-reply-toggle]'), function (button) {
      button.addEventListener('click', function () {
        var form = document.querySelector('[data-community-reply-form="' + button.dataset.communityReplyToggle + '"]');
        if (form) form.classList.toggle('hidden');
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-community-reply-submit]'), function (button) {
      button.addEventListener('click', async function () {
        var postId = button.dataset.communityReplySubmit;
        var input = document.querySelector('[data-community-reply-input="' + postId + '"]');
        var text = (input.value || '').trim();
        if (!text) return;

        button.disabled = true;
        button.classList.add('is-working');
        try {
          await api('/community/post/' + postId + '/reply', { method: 'POST', body: JSON.stringify({ content: text }) });
          await loadCommunity();
        } catch (err) {
          toast(err.message, 'err');
          button.disabled = false;
          button.classList.remove('is-working');
        }
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-community-delete]'), function (button) {
      button.addEventListener('click', async function () {
        button.disabled = true;
        try {
          await api('/community/post/' + button.dataset.communityDelete, { method: 'DELETE' });
          await loadCommunity();
        } catch (err) {
          toast(err.message, 'err');
          button.disabled = false;
        }
      });
    });

    // TASK 3 AUDIT FIX (Important #13) — same window.prompt pattern already
    // used elsewhere in this file (the payment-receipt email fallback) rather
    // than a new modal component for a single optional text field.
    Array.prototype.forEach.call(document.querySelectorAll('[data-community-report]'), function (button) {
      button.addEventListener('click', async function () {
        // null (not '') specifically means Cancel — window.prompt's only way
        // to distinguish "dismissed the dialog" from "submitted it blank".
        var reason = window.prompt('Optional: say why you\'re reporting this post (leave blank to skip).');
        if (reason === null) return;
        button.disabled = true;
        try {
          await api('/community/post/' + button.dataset.communityReport + '/report', {
            method: 'POST', body: JSON.stringify({ reason: reason }),
          });
          toast('Reported. The developer\'s team will review it.', 'ok');
          button.textContent = 'Reported';
        } catch (err) {
          toast(err.message, 'err');
          button.disabled = false;
        }
      });
    });

    var sendMessage = el('btn-send-message');
    if (sendMessage) {
      sendMessage.addEventListener('click', async function () {
        var input = el('message-input');
        var text = (input.value || '').trim();
        if (!text) return;

        sendMessage.disabled = true;
        sendMessage.classList.add('is-working');
        try {
          await api('/messages/' + activeReservationId, { method: 'POST', body: JSON.stringify({ message: text }) });
          input.value = '';
          await loadMessages(activeReservationId);
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          sendMessage.disabled = false;
          sendMessage.classList.remove('is-working');
        }
      });
    }

    var copyReferral = el('btn-copy-referral');
    if (copyReferral) {
      copyReferral.addEventListener('click', async function () {
        var code = copyReferral.closest('.card').querySelector('.mono').textContent;
        try {
          await navigator.clipboard.writeText(code);
          copyReferral.textContent = 'Copied ✓';
          setTimeout(function () { copyReferral.textContent = 'Copy code'; }, 1700);
        } catch (err) {
          toast('Could not copy — select and copy the code manually.', 'err');
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', load);
})();
