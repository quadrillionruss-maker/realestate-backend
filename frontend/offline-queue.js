/* offline-queue.js — SECTION 14: the sync queue behind offline-first mode
 * for a Sales Executive on a bad connection.
 *
 * Loaded after realestate.js (needs window.RE) and before screens.js (whose
 * forms call R.offlineQueue.submitOrQueue instead of api.post directly).
 *
 * Split in two, deliberately:
 *   - PURE functions (buildEntry, sortByQueuedAt, summarize) touch neither
 *     indexedDB nor the network — these are what src/test/logic.test.js
 *     exercises directly, the same way it already pulls naturalSort and
 *     matchImportColumn off screens.js. The service worker's own caching
 *     logic has no such seam (it needs a real ServiceWorkerGlobalScope) and
 *     is untested for exactly that reason.
 *   - IndexedDB-backed functions (add/getAll/remove/updateEntry) are the
 *     actual queue storage — one row per queued submission, small enough
 *     (a handful of items on a bad connection, not thousands) that
 *     getAll()-then-filter is simpler and plenty fast, rather than
 *     indexing by status.
 *
 * WHY QUEUEING IS SCOPED TO sales_rep ONLY: a rep's new-buyer, new-
 * reservation and log-activity forms are the one place a delayed write is
 * harmless — nobody else is racing to touch the same row. Payments,
 * approvals and anything money-moving never go through this queue, for any
 * role, because a submission replayed minutes or hours later against
 * state that has since changed (a payment already recorded by someone
 * else, a unit already reserved) is exactly the double-allocation/
 * double-payment class of bug this product's unique indexes elsewhere
 * exist to prevent.
 */
(function () {
  'use strict';

  var R = window.RE;
  if (!R) return; // realestate.js must load first — see this file's header

  var DB_NAME = 'archta-offline';
  var DB_VERSION = 1;
  var STORE = 'queue';
  // Matches the service worker's own CACHE_TTL_MS (service-worker.js) —
  // kept as a separate constant here rather than shared, since a page
  // script and a service worker cannot import from one file without a
  // bundler, and this product deliberately has none (CLAUDE.md).
  var CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  // AUDIT FIX (FE4) — one idempotency key per queued submission, generated
  // ONCE at queue time and reused for every attempt (the first, live one in
  // submitOrQueue AND every later replay in syncQueue) — never regenerated
  // per attempt, or a retry would just look like a brand new submission to
  // the server and defeat the whole point. Not a security token — just
  // needs to be practically unique — so crypto.randomUUID() with a
  // Math.random fallback (same reasoning buildEntry's own `id` below
  // already uses one for) rather than requiring a feature not every
  // in-field device's browser has yet.
  function newIdempotencyKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'k-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
      + '-' + Math.random().toString(36).slice(2, 10);
  }

  // ── Pure: building and reading the queue ─────────────────────────────
  function buildEntry(type, path, payload) {
    return {
      id: 'q-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      type: type, // 'new_buyer' | 'new_reservation' | 'log_activity'
      path: path, // the api() path to POST to once back online
      payload: payload,
      idempotencyKey: newIdempotencyKey(),
      status: 'pending', // 'pending' | 'syncing' | 'failed'
      queued_at: new Date().toISOString(),
      attempts: 0,
      last_error: null,
    };
  }

  // Oldest first — "sync all queued submissions in order" (SECTION 14).
  function sortByQueuedAt(entries) {
    return entries.slice().sort(function (a, b) {
      return a.queued_at < b.queued_at ? -1 : a.queued_at > b.queued_at ? 1 : 0;
    });
  }

  // The topbar indicator's whole data source: Synced / Syncing / N pending,
  // plus how many need a manual retry.
  function summarize(entries) {
    var pending = entries.filter(function (e) { return e.status === 'pending'; });
    var syncing = entries.filter(function (e) { return e.status === 'syncing'; });
    var failed = entries.filter(function (e) { return e.status === 'failed'; });
    return {
      total: entries.length,
      pendingCount: pending.length,
      syncingCount: syncing.length,
      failedCount: failed.length,
      isSyncing: syncing.length > 0,
      isSynced: entries.length === 0,
    };
  }

  // ── IndexedDB ─────────────────────────────────────────────────────────
  function openDb() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available')); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function add(entry) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(entry);
        tx.oncomplete = function () { resolve(entry); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function getAll() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function remove(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // get-then-put rather than a cursor update — the queue is a handful of
  // items on a bad connection, never worth a second index for.
  function updateEntry(id, changes) {
    return getAll().then(function (all) {
      var entry = all.find(function (e) { return e.id === id; });
      if (!entry) return null;
      var updated = Object.assign({}, entry, changes);
      return add(updated).then(function () { return updated; });
    });
  }

  // ── The one call site every offline-capable form goes through ────────
  // Tries the real request first, exactly as if this file did not exist.
  // Only a NETWORK failure (request() in realestate.js sets status:0 when
  // fetch itself throws — see that file) is ever queued; a real rejection
  // (400 validation, 403, a duplicate) must reach the caller normally, or a
  // rep would see "saved" for a submission the server actually refused.
  async function submitOrQueue(type, path, payload) {
    // AUDIT FIX (FE4) — the key is generated before the FIRST attempt (not
    // only once an entry is actually queued), so if this live call reaches
    // the server and succeeds there but the response never makes it back
    // (the connection drops mid-response — indistinguishable from the
    // request never arriving at all, from here), the entry queued below
    // carries the SAME key and the eventual replay is caught server-side
    // as a duplicate rather than creating a second row.
    var idempotencyKey = newIdempotencyKey();

    if (!R.state.user || R.state.user.role !== 'sales_rep') {
      return { queued: false, data: await R.api.post(path, payload, { 'X-Idempotency-Key': idempotencyKey }) };
    }
    try {
      var data = await R.api.post(path, payload, { 'X-Idempotency-Key': idempotencyKey });
      return { queued: false, data: data };
    } catch (err) {
      if (err.status !== 0) throw err;
      var entry = buildEntry(type, path, payload);
      entry.idempotencyKey = idempotencyKey;
      await add(entry);
      refreshSyncBadge();
      return { queued: true, entry: entry };
    }
  }

  // Walks the queue oldest-first. Each success is reported via onSynced (a
  // toast per item, per the spec); each failure stays in the queue with
  // status 'failed' rather than being dropped, so "flag any that failed for
  // manual retry" has something to point at.
  var syncing = false;
  async function syncQueue(onSynced, onFailed) {
    if (syncing) return; // a second trigger (online event + interval) must not run two passes at once
    syncing = true;
    try {
      var all = sortByQueuedAt((await getAll()).filter(function (e) { return e.status !== 'failed'; }));
      for (var i = 0; i < all.length; i++) {
        var entry = all[i];
        await updateEntry(entry.id, { status: 'syncing' });
        refreshSyncBadge();
        try {
          // AUDIT FIX (FE4) — the SAME key this entry was queued with
          // (buildEntry/submitOrQueue), not a fresh one, so a retry of a
          // submission that actually landed the first time is recognised
          // as one by the backend rather than creating a second row.
          await R.api.post(entry.path, entry.payload, { 'X-Idempotency-Key': entry.idempotencyKey });
          await remove(entry.id);
          if (onSynced) onSynced(entry);
        } catch (err) {
          await updateEntry(entry.id, { status: 'failed', last_error: err.message, attempts: (entry.attempts || 0) + 1 });
          if (onFailed) onFailed(entry, err);
        }
        refreshSyncBadge();
      }
    } finally {
      syncing = false;
      refreshSyncBadge();
    }
  }

  // A failed item never retries itself — "flag any that failed for manual
  // retry" — this is that manual trigger, re-entering the normal queue.
  async function retryEntry(id, onSynced, onFailed) {
    await updateEntry(id, { status: 'pending', last_error: null });
    await syncQueue(onSynced, onFailed);
  }

  // ── Topbar indicator ──────────────────────────────────────────────────
  async function refreshSyncBadge() {
    var node = document.getElementById('sync-status');
    if (!node) return;
    var all = await getAll().catch(function () { return []; });
    var summary = summarize(all);

    node.classList.toggle('hidden', summary.isSynced && !summary.failedCount);
    if (summary.isSyncing) {
      node.textContent = 'Syncing…';
      node.className = 'sync-status syncing';
    } else if (summary.failedCount) {
      node.textContent = summary.failedCount + ' failed — tap to retry';
      node.className = 'sync-status failed';
    } else if (summary.pendingCount) {
      node.textContent = summary.pendingCount + ' pending';
      node.className = 'sync-status pending';
    } else {
      node.textContent = 'Synced';
      node.className = 'sync-status synced hidden';
    }
  }

  // No 'online' listener here — realestate.js's setUpOfflineMode wires that,
  // so the callbacks that turn a sync result into a toast live in exactly
  // one place instead of this file reaching for functions defined in the
  // other one.

  R.offlineQueue = {
    buildEntry: buildEntry,
    sortByQueuedAt: sortByQueuedAt,
    summarize: summarize,
    add: add,
    getAll: getAll,
    remove: remove,
    updateEntry: updateEntry,
    submitOrQueue: submitOrQueue,
    syncQueue: syncQueue,
    retryEntry: retryEntry,
    refreshSyncBadge: refreshSyncBadge,
    CACHE_TTL_MS: CACHE_TTL_MS,
  };
})();
