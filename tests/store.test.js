const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, LIVE_PATH, GAME_KEY, OUTBOX_KEY } = require('../store.js');

// In-memory stand-in for the artifact db: shared docs, snapshot listeners, and
// an `online` switch that makes writes reject like a dropped connection.
function fakeDb() {
  const docs = new Map();
  const listeners = new Map();
  const db = {
    online: true,
    writes: 0,
    docs,
    doc(path) {
      return {
        path,
        set(body) {
          if (!db.online) return Promise.reject({ code: 'unavailable', message: 'offline' });
          db.writes++;
          const copy = JSON.parse(JSON.stringify(body));
          docs.set(path, copy);
          (listeners.get(path) || []).forEach((fn) => queueMicrotask(() => fn(snap(copy))));
          return Promise.resolve();
        },
        onSnapshot(next) {
          if (!listeners.has(path)) listeners.set(path, []);
          listeners.get(path).push(next);
          queueMicrotask(() => next(snap(docs.get(path))));
          return () => {};
        },
      };
    },
  };
  const snap = (d) => ({ exists: !!d, data: () => d, metadata: { fromCache: false, hasPendingWrites: false } });
  return db;
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

// Manual timers so tests control the debounce and retry clock.
function clock() {
  let t = 1000;
  let timers = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimeout: (h) => { timers = timers.filter((x) => x !== h); },
    async advance(ms) {
      t += ms;
      const due = timers.filter((x) => x.at <= t);
      timers = timers.filter((x) => x.at > t);
      due.forEach((x) => x.fn());
      await settle();
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

function make(db, extra = {}) {
  const c = extra.clock || clock();
  const storage = extra.storage || memoryStorage();
  const remote = [];
  const store = createStore({ storage, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, onRemote: (r) => remote.push(r), tabId: extra.tabId });
  return { store, c, storage, remote };
}

const game = (n) => ({ players: [{ id: 1, name: 'A', stack: n, buyIn: 100 }], sessionId: 's1' });

test('every change is on the device immediately, then in the cloud after the debounce', async () => {
  const db = fakeDb();
  const { store, c, storage } = make(db);
  store.prime(game(100), true);
  store.connect(db);
  await settle();
  store.save(game(90), [], true);
  assert.equal(JSON.parse(storage.getItem(GAME_KEY)).state.players[0].stack, 90);
  assert.equal(db.docs.has(LIVE_PATH), false);
  await c.advance(400);
  assert.equal(db.docs.get(LIVE_PATH).state.players[0].stack, 90);
  assert.equal(store.status().label, 'Saved to cloud');
});

test('a burst of changes becomes one cloud write with the latest state', async () => {
  const db = fakeDb();
  const { store, c } = make(db);
  store.prime(game(100), true);
  store.connect(db);
  await settle();
  for (let i = 1; i <= 5; i++) store.save(game(100 - i), [], true);
  await c.advance(400);
  assert.equal(db.writes, 1);
  assert.equal(db.docs.get(LIVE_PATH).state.players[0].stack, 95);
});

test('changes made offline are kept and sent when the connection returns', async () => {
  const db = fakeDb();
  const { store, c } = make(db);
  store.prime(game(100), true);
  store.connect(db);
  await settle();
  db.online = false;
  store.save(game(80), [], true);
  await c.advance(400);
  assert.match(store.status().label, /Offline/);
  store.save(game(70), [], true);
  await c.advance(400);
  db.online = true;
  await c.advance(2000); // retry timer
  await c.advance(400);
  assert.equal(db.docs.get(LIVE_PATH).state.players[0].stack, 70);
  assert.equal(store.status().label, 'Saved to cloud');
});

test('hand records survive a closed tab and are sent on the next visit', async () => {
  const db = fakeDb();
  db.online = false;
  const storage = memoryStorage();
  const first = make(db, { storage });
  first.store.prime(game(100), true);
  first.store.connect(db);
  await settle();
  first.store.enqueue('hands/s1_1', { number: 1 });
  first.store.enqueue('hands/s1_2', { number: 2 });
  assert.equal(JSON.parse(storage.getItem(OUTBOX_KEY)).length, 2);
  // Tab closes; later the page opens again with a connection.
  db.online = true;
  const second = make(db, { storage });
  second.store.loadLocal();
  second.store.prime(game(100), true);
  second.store.connect(db);
  await settle(); await settle(); await settle();
  assert.deepEqual(db.docs.get('hands/s1_1'), { number: 1 });
  assert.deepEqual(db.docs.get('hands/s1_2'), { number: 2 });
  assert.equal(JSON.parse(storage.getItem(OUTBOX_KEY)).length, 0);
});

test('a newer game from another device is handed to the app', async () => {
  const db = fakeDb();
  const shared = clock();
  const phone = make(db, { clock: shared, tabId: 'phone' });
  const laptop = make(db, { clock: shared, tabId: 'laptop' });
  phone.store.prime(game(100), true);
  laptop.store.prime(null, false); // fresh device showing the sample table
  phone.store.connect(db);
  laptop.store.connect(db);
  await settle();
  await shared.advance(10);
  phone.store.save(game(60), [], true);
  await shared.advance(400);
  await settle();
  assert.equal(laptop.remote.length, 1);
  assert.equal(laptop.remote[0].state.players[0].stack, 60);
  assert.equal(phone.remote.length, 0, 'own write is not echoed back');
});

test('a device with newer unsent changes pushes them instead of taking the older cloud copy', async () => {
  const db = fakeDb();
  db.docs.set(LIVE_PATH, { savedAt: 500, writer: 'x', state: game(10) });
  const storage = memoryStorage();
  storage.setItem(GAME_KEY, JSON.stringify({ state: game(55), history: [], savedAt: 900 }));
  const { store, remote } = make(db, { storage });
  const saved = store.loadLocal();
  store.prime(saved.state, true);
  store.connect(db);
  await settle(); await settle();
  assert.equal(remote.length, 0);
  assert.equal(db.docs.get(LIVE_PATH).state.players[0].stack, 55);
});

test('the sample table is never written to the cloud', async () => {
  const db = fakeDb();
  const { store, c } = make(db);
  store.prime(game(1), false);
  store.connect(db);
  await settle();
  store.save(game(2), [], false);
  await c.advance(1000);
  assert.equal(db.writes, 0);
});

test('without write permission the device copy is kept and retries stop', async () => {
  const db = fakeDb();
  db.doc = ((orig) => (path) => ({ ...orig(path), set: () => Promise.reject({ code: 'invalid_argument' }) }))(db.doc.bind(db));
  const { store, c, storage } = make(db);
  store.prime(game(1), true);
  store.connect(db);
  await settle();
  store.save(game(2), [], true);
  await c.advance(400);
  assert.equal(store.status().label, 'Saved on this device only');
  assert.equal(JSON.parse(storage.getItem(GAME_KEY)).state.players[0].stack, 2);
});
