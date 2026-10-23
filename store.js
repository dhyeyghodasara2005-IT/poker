/*
 * Game storage: every change is written to this device first (localStorage),
 * then mirrored to the artifact database when the page runs on claude.ai.
 *
 *   games/current        the live game (latest state wins, synced across devices)
 *   hands/<session>_<n>  one record per finished hand, never overwritten by others
 *   sessions/<session>   a summary + final state of each finished session
 *
 * Hand and session records go through an outbox that is itself saved on the
 * device, so a record made while offline, or just before the tab closes, is
 * sent the next time the page is open with a connection.
 */
(function (root) {
  'use strict';

  var GAME_KEY = 'poker-chip-ledger-v1';
  var OUTBOX_KEY = 'poker-chip-ledger-outbox-v1';
  var LIVE_PATH = 'games/current';
  var DEBOUNCE_MS = 400;
  var RETRY_MIN_MS = 2000;
  var RETRY_MAX_MS = 60000;
  // Codes after which retrying cannot help in this page load.
  var FATAL = ['invalid_argument', 'transform_error', 'not_granted', 'capability_disabled', 'capability_removed', 'revoked'];

  function noop() {}

  function createStore(opts) {
    opts = opts || {};
    var storage = opts.storage || null;
    var now = opts.now || function () { return Date.now(); };
    var setT = opts.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var clearT = opts.clearTimeout || function (t) { clearTimeout(t); };
    var onRemote = opts.onRemote || noop;
    var onStatus = opts.onStatus || noop;
    var tabId = opts.tabId || Math.random().toString(36).slice(2, 10);

    var s = {
      db: null,
      live: null,
      unsub: null,
      firstSnapshot: true,
      savedAt: 0,
      syncable: false,
      state: null, // the current game, written as-is at flush time
      dirty: false,
      writing: false,
      debounce: null,
      retryTimer: null,
      retryDelay: 0,
      outbox: [],
      sendingOutbox: false,
      mode: 'device', // device | cloud | off
      problem: null, // 'offline' | 'quota' | 'readonly'
      localFailed: false
    };

    // ---------- this device ----------

    function readJSON(key) {
      if (!storage) return null;
      try {
        var raw = storage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }

    function writeJSON(key, value) {
      if (!storage) return false;
      try {
        storage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) { return false; }
    }

    function loadLocal() {
      var saved = readJSON(GAME_KEY);
      var box = readJSON(OUTBOX_KEY);
      s.outbox = Array.isArray(box) ? box : [];
      if (saved && saved.state && Array.isArray(saved.state.players)) {
        s.savedAt = Number(saved.savedAt) || 0;
        return {
          state: saved.state,
          history: Array.isArray(saved.history) ? saved.history : [],
          savedAt: s.savedAt
        };
      }
      return null;
    }

    function persistLocal(state, history) {
      var ok = writeJSON(GAME_KEY, { state: state, history: history, savedAt: s.savedAt });
      // Out of space: the undo history is the expendable part.
      if (!ok && history && history.length) ok = writeJSON(GAME_KEY, { state: state, history: [], savedAt: s.savedAt });
      s.localFailed = !!storage && !ok;
    }

    // Record a change. `syncable` is false for the built-in sample table.
    function save(state, history, syncable) {
      s.savedAt = Math.max(now(), s.savedAt + 1);
      s.syncable = !!syncable;
      persistLocal(state, history);
      s.state = state;
      if (s.syncable) {
        s.dirty = true;
        if (s.live) {
          clearT(s.debounce);
          s.debounce = setT(function () { s.debounce = null; flushLive(); }, DEBOUNCE_MS);
        }
      }
      emit();
      return s.savedAt;
    }

    // The app took a newer game from another device.
    function adopt(state, savedAt) {
      s.savedAt = Math.max(Number(savedAt) || 0, s.savedAt);
      s.syncable = true;
      s.dirty = false;
      s.state = state;
      persistLocal(state, []);
      emit();
    }

    function enqueue(path, body) {
      s.outbox.push({ path: path, body: body });
      writeJSON(OUTBOX_KEY, s.outbox);
      emit();
      sendOutbox();
    }

    // ---------- cloud ----------

    function connect(db) {
      if (!db || s.db) return;
      s.db = db;
      s.mode = 'cloud';
      s.live = db.doc(LIVE_PATH);
      s.unsub = s.live.onSnapshot(handleSnapshot, function (err) {
        // A dead listener: keep writing, and resubscribe on the next kick.
        s.unsub = null;
        handleError(err);
      });
      emit();
      sendOutbox();
    }

    function handleSnapshot(snap) {
      var first = s.firstSnapshot;
      s.firstSnapshot = false;
      var data = snap && snap.exists ? snap.data() : null;
      var remoteAt = data ? Number(data.savedAt) || 0 : 0;
      if (data && data.state && remoteAt > s.savedAt) {
        onRemote({ state: JSON.parse(JSON.stringify(data.state)), savedAt: remoteAt, writer: data.writer });
        return;
      }
      // This device has changes the cloud has not seen (made offline, or
      // before the cloud copy existed): send them.
      if (first && s.syncable && s.state && remoteAt < s.savedAt) {
        s.dirty = true;
        flushLive();
      }
      emit();
    }

    // Tell the store which game is on screen after loading, before connect().
    function prime(state, syncable) {
      s.state = state;
      s.syncable = !!syncable;
      emit();
    }

    function flushLive() {
      if (!s.live || s.mode === 'off' || s.writing || !s.dirty || !s.state || s.retryTimer) return;
      s.writing = true;
      s.dirty = false;
      var body = JSON.parse(JSON.stringify({ savedAt: s.savedAt, writer: tabId, state: s.state }));
      emit();
      s.live.set(body).then(function () {
        s.retryDelay = 0;
        if (s.problem === 'offline') s.problem = null;
      }, function (err) {
        s.dirty = true;
        handleError(err);
      }).then(function () {
        s.writing = false;
        emit();
        if (s.dirty && !s.debounce) flushLive();
      });
    }

    function sendOutbox() {
      if (!s.db || s.mode === 'off' || s.sendingOutbox || !s.outbox.length || s.retryTimer) return;
      s.sendingOutbox = true;
      var item = s.outbox[0];
      emit();
      s.db.doc(item.path).set(item.body).then(function () {
        if (s.outbox[0] === item) s.outbox.shift();
        writeJSON(OUTBOX_KEY, s.outbox);
        s.retryDelay = 0;
        if (s.problem === 'offline') s.problem = null;
        s.sendingOutbox = false;
        emit();
        sendOutbox();
      }, function (err) {
        s.sendingOutbox = false;
        handleError(err);
        emit();
      });
    }

    function handleError(err) {
      var code = err && err.code;
      if (FATAL.indexOf(code) >= 0) {
        // No permission to write here (or db went away): this device keeps everything.
        s.mode = 'off';
        s.problem = 'readonly';
        emit();
        return;
      }
      s.problem = code === 'quota_exceeded' ? 'quota' : 'offline';
      scheduleRetry();
    }

    function scheduleRetry() {
      if (s.retryTimer) return;
      s.retryDelay = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, s.retryDelay * 2));
      s.retryTimer = setT(function () {
        s.retryTimer = null;
        kick();
      }, s.retryDelay);
      emit();
    }

    // Try again now (back online, tab visible again, or a retry timer fired).
    function kick() {
      if (!s.db || s.mode === 'off') return;
      if (s.retryTimer) { clearT(s.retryTimer); s.retryTimer = null; }
      if (!s.unsub && s.live) {
        s.firstSnapshot = true;
        s.unsub = s.live.onSnapshot(handleSnapshot, function (err) { s.unsub = null; handleError(err); });
      }
      flushLive();
      sendOutbox();
    }

    // The tab is going away: skip the debounce and send what we have.
    function flushNow() {
      if (s.debounce) { clearT(s.debounce); s.debounce = null; }
      flushLive();
      sendOutbox();
    }

    function status() {
      var pending = s.outbox.length + (s.dirty || s.writing ? 1 : 0);
      var st = {
        mode: s.mode,
        pending: pending,
        busy: s.writing || s.sendingOutbox,
        problem: s.problem,
        localFailed: s.localFailed,
        savedAt: s.savedAt
      };
      if (s.mode === 'device' || !s.syncable) st.label = s.localFailed ? 'Not saved: browser storage is full or blocked' : 'Saved on this device';
      else if (s.mode === 'off') st.label = 'Saved on this device only';
      else if (s.problem === 'quota') st.label = 'Cloud storage is full; saved on this device';
      else if (s.problem === 'offline' && pending) st.label = 'Offline: saved on this device, will sync';
      else if (pending) st.label = 'Saving…';
      else st.label = 'Saved to cloud';
      st.tone = s.localFailed || s.problem === 'quota' ? 'bad' : (s.mode === 'cloud' && s.syncable && (s.problem || pending)) ? 'wait' : 'ok';
      return st;
    }

    function emit() { onStatus(status()); }

    return {
      tabId: tabId,
      loadLocal: loadLocal,
      save: save,
      adopt: adopt,
      prime: prime,
      enqueue: enqueue,
      connect: connect,
      kick: kick,
      flushNow: flushNow,
      status: status,
      hasUnsynced: function () { return s.dirty || s.writing; },
      db: function () { return s.db; },
      outbox: function () { return s.outbox.slice(); }
    };
  }

  var api = { createStore: createStore, GAME_KEY: GAME_KEY, OUTBOX_KEY: OUTBOX_KEY, LIVE_PATH: LIVE_PATH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GameStore = api;
})(typeof window !== 'undefined' ? window : this);
