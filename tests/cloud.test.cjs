const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const entry = { min: 75, appr: 2, land: 1, label: 'Тест' };
function journal(auth, user = 'owner') {
  const context = vm.createContext({ window: { crypto: { randomUUID: () => 'request-1' } } });
  vm.runInContext(fs.readFileSync(path.join(root, 'cloud-store.js'), 'utf8'), context);
  return context.window.createCloudJournal(auth, user);
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
test('a fresh cloud account stays empty without importing local records', async () => {
  let requested;
  const store = journal({ readJournal: async user => { requested = user; return null; } });
  assert.deepEqual(plain(await store.read()), []);
  assert.equal(requested, 'owner');
});
test('writes use the last server revision and an idempotency ID', async () => {
  let args;
  const store = journal({
    readJournal: async () => ({ entries: [], revision: 7 }),
    saveJournal: async (...values) => {
      args = values;
      return { entries: [entry], revision: 8, mutation_id: values[2] };
    }
  });
  await store.read();
  assert.deepEqual(plain(await store.write([entry])), [entry]);
  assert.equal(args[1], 7); assert.equal(args[2], 'request-1');
  assert.equal(args[3], 'owner');
});

async function cloudUI(overrides = {}, authOverrides = {}, storage = new Map()) {
  const nodes = [];
  function node() {
    const value = { value: '', disabled: false, hidden: false, textContent: '', children: [], handlers: {},
      addEventListener(event, callback) { this.handlers[event] = callback; },
      appendChild(child) { this.children.push(child); }, setAttribute() {}, focus() {}, select() {} };
    Object.defineProperty(value, 'innerHTML', { set() { value.children = []; } });
    nodes.push(value); return value;
  }
  const elements = Object.fromEntries([...fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, node()]));
  let change;
  const calls = [];
  const auth = { ready: true, readJournal() {}, saveJournal() {}, currentUser: async () => ({ id: 'owner' }), onChange: fn => { change = fn; }, ...authOverrides };
  const store = { read: async () => [], write: async entries => { calls.push(plain(entries)); return entries; }, ...overrides };
  const context = vm.createContext({
    window: { FlightAuth: auth, addEventListener() {}, localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value)
    } },
    document: { getElementById: id => elements[id], createElement: node,
      querySelectorAll: () => nodes.filter(n => n.className === 'del'), addEventListener() {}, hidden: false },
    setTimeout() {}, setInterval() {}
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'cloud-store.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'guest-store.js'), 'utf8'), context);
  context.window.createCloudJournal = () => store;
  vm.runInContext(fs.readFileSync(path.join(root, 'cloud.js'), 'utf8'), context);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick();
  return { elements, calls, tick, change, storage, fire: async (id) => { await elements[id].handlers.click(); await tick(); } };
}
test('cloud UI clears input only after confirmed saving and retains it on a failure', async () => {
  const u = await cloudUI();
  u.elements.h.value = '1'; u.elements.m.value = '15';
  await u.fire('add');
  assert.equal(u.elements.h.value, ''); assert.equal(u.elements.cnt.textContent, 1);
  assert.equal(u.calls[0][0].min, 75);
  const v = await cloudUI({ write: async () => { throw { code: '40001' }; } });
  v.elements.h.value = '2'; await v.fire('add');
  assert.equal(v.elements.h.value, '2'); assert.equal(v.elements.cnt.textContent, 0);
  assert.equal(v.elements.add.disabled, true); assert.match(v.elements.syncStatus.textContent, /другом устройстве/);
  await v.fire('refresh'); assert.equal(v.elements.add.disabled, false);
});
test('cloud import replace requires confirmation and changes only the cloud journal', async () => {
  const u = await cloudUI({ read: async () => [entry] });
  u.elements.io.value = JSON.stringify({ v: 2, entries: [{ ...entry, min: 90 }] });
  await u.fire('impRep'); assert.equal(u.calls.length, 0);
  await u.fire('impRep'); assert.equal(u.calls.length, 1);
  assert.equal(u.calls[0][0].min, 90); assert.equal(u.elements.io.value, '');
});
test('signout clears cloud data and ignores an in-flight save response', async () => {
  let finish;
  const u = await cloudUI({ read: async () => [entry], write: entries => new Promise(resolve => { finish = () => resolve(entries); }) });
  u.elements.h.value = '1';
  const pending = u.fire('add');
  u.change('SIGNED_OUT', null);
  finish(); await pending;
  assert.equal(u.elements.cnt.textContent, 0); assert.equal(u.elements.h.value, '');
  assert.equal(u.elements.add.disabled, false);
});
test('guest can immediately add while the account check is still pending', async () => {
  const u = await cloudUI({}, { currentUser: () => new Promise(() => {}) });
  assert.equal(u.elements.h.disabled, false); assert.equal(u.elements.add.disabled, false);
  u.elements.h.value = '1'; await u.fire('add');
  assert.equal(u.elements.cnt.textContent, 1); assert.equal(u.calls.length, 0);
  assert.equal(JSON.parse(u.storage.get('flight-time-entries-v2'))[0].min, 60);
});
test('main-site guests reuse legacy records, survive reload and preserve unrelated storage', async () => {
  const storage = new Map([
    ['flight-time-entries-v2', JSON.stringify([entry])],
    ['unrelated-journal', 'untouched']
  ]);
  const auth = { currentUser: async () => null };
  const u = await cloudUI({}, auth, storage);
  assert.equal(u.elements.cnt.textContent, 1);
  assert.equal(u.elements.tH.textContent, 1);
  assert.equal(u.elements.tM.textContent, '15');
  u.elements.m.value = '20'; await u.fire('add');
  const v = await cloudUI({}, auth, storage);
  assert.equal(v.elements.cnt.textContent, 2);
  assert.equal(v.elements.tH.textContent, 1);
  assert.equal(v.elements.tM.textContent, '35');
  assert.deepEqual(JSON.parse(storage.get('flight-time-entries-v2'))[0], entry);
  assert.equal(storage.get('unrelated-journal'), 'untouched');
});
test('login switches to cloud and logout restores guests without merging either list', async () => {
  const u = await cloudUI({ read: async () => [entry] }, { currentUser: async () => null });
  u.elements.m.value = '10'; await u.fire('add');
  u.change('SIGNED_IN', { id: 'owner' }); await u.tick();
  assert.equal(u.elements.tM.textContent, '15'); assert.equal(u.calls.length, 0);
  u.change('SIGNED_OUT', null); await u.tick();
  assert.equal(u.elements.tM.textContent, '10'); assert.equal(u.elements.add.disabled, false);
});
test('corrupt guest data is preserved rather than silently replaced', async () => {
  const storage = new Map([['flight-time-entries-v2', 'broken-json']]);
  const u = await cloudUI({}, { currentUser: async () => null }, storage);
  assert.equal(u.elements.add.disabled, true);
  assert.equal(storage.get('flight-time-entries-v2'), 'broken-json');
  assert.match(u.elements.modeNote.textContent, /Данные не удалены/);
});
test('missing cloud schema prevents editing and explains the setup step', async () => {
  const u = await cloudUI({ read: async () => { throw { code: 'PGRST205' }; } });
  assert.equal(u.elements.add.disabled, true);
  assert.match(u.elements.syncStatus.textContent, /База журнала ещё не настроена/);
});
test('a read failure shows a safe diagnostic code and does not claim a save failed', async () => {
  const u = await cloudUI({ read: async () => { throw { code: '42501', status: 403, message: 'private-token' }; } });
  assert.match(u.elements.syncStatus.textContent, /загрузить журнал/);
  assert.match(u.elements.syncStatus.textContent, /42501/);
  assert.doesNotMatch(u.elements.syncStatus.textContent, /private-token|подтвердить сохранение/);
});
test('a stale device does not automatically retry or overwrite a newer journal', async () => {
  let reads = 0, writes = 0;
  const store = journal({
    readJournal: async () => ({ entries: [], revision: ++reads, mutation_id: 'another' }),
    saveJournal: async () => { writes++; throw Object.assign(new Error('conflict'), { code: '40001' }); }
  });
  await store.read();
  await assert.rejects(store.write([entry]), { code: '40001' });
  await assert.rejects(store.write([entry]), /BUSY/);
  assert.equal(writes, 1);
  await store.read();
});
test('a save with lost response is reconciled without duplicating an entry', async () => {
  let saved = null, writes = 0;
  const store = journal({
    readJournal: async () => saved,
    saveJournal: async (entries, revision, mutation_id) => {
      writes++; saved = { entries, revision: revision + 1, mutation_id };
      throw new TypeError('network lost');
    }
  });
  await store.read();
  assert.deepEqual(plain(await store.write([entry])), [entry]);
  assert.equal(writes, 1);
});
test('offline failure blocks further mutations until a successful refresh', async () => {
  let online = true;
  const store = journal({
    readJournal: async () => { if (!online) throw new TypeError('offline'); return null; },
    saveJournal: async () => { online = false; throw new TypeError('offline'); }
  });
  await store.read();
  await assert.rejects(store.write([entry]), /offline/);
  await assert.rejects(store.write([entry]), /BUSY/);
  online = true; await store.read();
});
test('invalid imports never make a server write and malformed responses never succeed', async () => {
  let writes = 0;
  const store = journal({ readJournal: async () => null, saveJournal: async () => { writes++; return null; } });
  await store.read();
  await assert.rejects(store.write([{ ...entry, min: -1 }]), /INVALID_ENTRIES/);
  await assert.rejects(store.write([{ ...entry, label: 'x'.repeat(41) }]), /INVALID_ENTRIES/);
  await assert.rejects(store.write(Array(10001).fill(entry)), /INVALID_ENTRIES/);
  assert.equal(writes, 0);
  await assert.rejects(store.write([entry]), /INVALID_JOURNAL/);
});
test('duplicate clicks cannot create overlapping writes', async () => {
  let resolve, writes = 0;
  const store = journal({
    readJournal: async () => null,
    saveJournal: (entries, revision, mutation_id) => {
      writes++; return new Promise(done => { resolve = () => done({ entries, revision: 1, mutation_id }); });
    }
  });
  await store.read();
  const pending = store.write([entry]);
  await assert.rejects(store.write([entry]), /BUSY/);
  resolve(); await pending; assert.equal(writes, 1);
});
test('saving while signed in leaves the browser journal unchanged', async () => {
  const savedGuest = JSON.stringify([{ ...entry, min: 30, label: 'Guest flight' }]);
  const storage = new Map([['flight-time-entries-v2', savedGuest]]);
  const u = await cloudUI({ read: async () => [entry] }, {}, storage);
  u.elements.m.value = '10'; await u.fire('add');
  assert.equal(u.calls.length, 1);
  assert.deepEqual(u.calls[0], [entry, { min: 10, appr: 0, land: 0, label: '' }]);
  assert.equal(storage.get('flight-time-entries-v2'), savedGuest);
});
