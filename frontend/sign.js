/* sign.js — SECTION 8, the buyer-facing e-signature page.
 *
 * Standalone, same shape as portal.js: no router, no session storage beyond
 * the token itself, shares the stylesheet and nothing else. One document,
 * one decision: sign it or don't.
 *
 * The token IS the path segment the API expects (GET/POST /api/sign/:token)
 * — there is no separate Authorization header the way portal.js's Bearer
 * token works, because a signing link is scoped to exactly one document and
 * carries no broader account to authenticate.
 */
(function () {
  'use strict';

  var API_BASE = window.__API_BASE__ || null;

  var token = (/[#&]token=([^&]+)/.exec(window.location.hash) || [])[1] || '';
  if (token) {
    try { window.history.replaceState(null, '', window.location.pathname); } catch (e) { /* file:// has no history API */ }
  }

  function el(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(message, kind) {
    var node = document.createElement('div');
    node.className = 'toast ' + (kind || '');
    node.innerHTML = '<span>' + esc(message) + '</span>';
    el('toasts').appendChild(node);
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 5000);
  }

  var FETCH_TIMEOUT_MS = 20000;
  async function api(path, options) {
    var opts = options || {};
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS) : null;

    var res;
    try {
      res = await fetch(API_BASE + '/sign' + path, {
        method: opts.method || 'GET',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: opts.body,
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      throw Object.assign(new Error('Could not reach the server. Check your connection and try again.'), { status: 0 });
    } finally {
      if (timer) clearTimeout(timer);
    }

    var body = null;
    var text = await res.text().catch(function () { return ''; });
    if (text) { try { body = JSON.parse(text); } catch (e) { body = null; } }
    if (!res.ok) throw Object.assign(new Error((body && body.error) || 'Something went wrong. Please try again.'), { status: res.status });
    return body;
  }

  function fail(message, detail) {
    el('sign-view').innerHTML =
      '<div class="card"><div class="card-body portal-empty-body">' +
        '<div class="portal-empty-icon">◇</div>' +
        '<div class="serif portal-empty-title">' + esc(message) + '</div>' +
        '<p class="muted fs-13-5 lh-loose">' + esc(detail || 'Please ask your developer\'s sales office for a fresh link.') + '</p>' +
      '</div></div>';
  }

  var DOC_LABELS = {
    deed_of_assignment: 'Deed of Assignment',
    subscriber_agreement: "Subscriber's Agreement",
    power_of_attorney: 'Power of Attorney',
  };

  async function load() {
    if (!API_BASE) return fail('This page could not start up', 'A configuration file did not load. Please refresh.');
    if (!token) return fail('This link is incomplete');

    var doc;
    try {
      doc = await api('/' + encodeURIComponent(token));
    } catch (err) {
      return fail(err.status === 409 ? 'Already signed' : 'This link is not valid', err.message);
    }

    var label = DOC_LABELS[doc.doc_type] || String(doc.doc_type).replace(/_/g, ' ');

    el('sign-view').innerHTML =
      '<h1 class="serif portal-greeting">' + esc(label) + '</h1>' +
      '<p class="muted mt-1 fs-14">' +
        [doc.unit_number ? 'Unit ' + doc.unit_number : null, doc.project_name].filter(Boolean).map(esc).join(' · ') +
      '</p>' +

      '<div class="card mt-2"><div class="card-body">' +
        (doc.preview_url
          ? '<a class="btn-quiet" target="_blank" rel="noopener" href="' + esc(doc.preview_url) + '">Read the full document</a>' +
            '<p class="page-sub mt-1">Opens in a new tab. Read it fully before signing below.</p>'
          : '<p class="page-sub">The document could not be previewed. Contact your sales office if this persists.</p>') +
      '</div></div>' +

      '<div class="card mt-2"><div class="card-body">' +
        '<div class="filter-row mb-2">' +
          '<button class="pill is-on" id="mode-draw" type="button">Draw signature</button>' +
          '<button class="pill" id="mode-type" type="button">Type name</button>' +
        '</div>' +

        '<div id="draw-panel">' +
          '<canvas id="sig-canvas" class="sig-canvas" width="600" height="180"></canvas>' +
          '<button class="btn-quiet mt-1" id="sig-clear" type="button">Clear</button>' +
        '</div>' +
        '<div id="type-panel" class="hidden">' +
          '<div class="field"><label for="sig-typed">Type your full name</label>' +
            '<input class="input sig-typed-input" id="sig-typed" placeholder="' + esc(doc.buyer_name || 'Your full name') + '"></div>' +
        '</div>' +

        '<label class="check mt-2"><input type="checkbox" id="sig-consent">' +
          '<span>I have read this document and agree to sign it electronically.</span></label>' +

        '<button class="btn primary mt-2" id="sig-submit" type="button">Sign document</button>' +
      '</div></div>';

    wireSignaturePad(doc);
  }

  function wireSignaturePad(doc) {
    var canvas = el('sig-canvas');
    var ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#0b0b0b';
    ctx.lineWidth = 2.4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    var drawing = false;
    var hasStroke = false;
    var last = null;

    function pointFromEvent(e) {
      var rect = canvas.getBoundingClientRect();
      var scaleX = canvas.width / rect.width;
      var scaleY = canvas.height / rect.height;
      var point = e.touches ? e.touches[0] : e;
      return { x: (point.clientX - rect.left) * scaleX, y: (point.clientY - rect.top) * scaleY };
    }
    function start(e) {
      e.preventDefault();
      drawing = true;
      last = pointFromEvent(e);
    }
    function move(e) {
      if (!drawing) return;
      e.preventDefault();
      var p = pointFromEvent(e);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
      hasStroke = true;
    }
    function end() { drawing = false; }

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);

    el('sig-clear').addEventListener('click', function () {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasStroke = false;
    });

    var mode = 'drawn';
    el('mode-draw').addEventListener('click', function () {
      mode = 'drawn';
      el('mode-draw').classList.add('is-on');
      el('mode-type').classList.remove('is-on');
      el('draw-panel').classList.remove('hidden');
      el('type-panel').classList.add('hidden');
    });
    el('mode-type').addEventListener('click', function () {
      mode = 'typed';
      el('mode-type').classList.add('is-on');
      el('mode-draw').classList.remove('is-on');
      el('type-panel').classList.remove('hidden');
      el('draw-panel').classList.add('hidden');
    });

    el('sig-submit').addEventListener('click', async function () {
      if (!el('sig-consent').checked) {
        return toast('Please confirm you have read the document first.', 'err');
      }

      var signatureData;
      if (mode === 'drawn') {
        if (!hasStroke) return toast('Please draw your signature first.', 'err');
        signatureData = canvas.toDataURL('image/png');
      } else {
        signatureData = el('sig-typed').value.trim();
        if (!signatureData) return toast('Please type your full name.', 'err');
      }

      var button = el('sig-submit');
      button.disabled = true;
      button.classList.add('is-working');
      try {
        await api('/' + encodeURIComponent(token), {
          method: 'POST',
          body: JSON.stringify({ signature_type: mode, signature_data: signatureData }),
        });
        el('sign-view').innerHTML =
          '<div class="card"><div class="card-body portal-empty-body">' +
            '<div class="portal-empty-icon">◆</div>' +
            '<div class="serif portal-empty-title">Document signed</div>' +
            '<p class="muted fs-13-5 lh-loose">Thank you — a signed copy has been recorded. Your developer\'s sales office will be in touch with next steps.</p>' +
          '</div></div>';
      } catch (err) {
        toast(err.message, 'err');
        button.disabled = false;
        button.classList.remove('is-working');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', load);
})();
