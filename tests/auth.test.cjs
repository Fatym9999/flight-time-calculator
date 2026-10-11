const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const validConfig = { url: 'https://test-project.supabase.co', publishableKey: 'sb_publishable_testkey', emailOtpEnabled: true };

function adapter(config = validConfig, protocol = 'https:', overrides = {}) {
  const calls = [];
  const user = { id: 'test-user', email: 'pilot@example.com' };
  const api = {
    signInWithOtp: async args => { calls.push(['send', args]); return { data: {}, error: null }; },
    verifyOtp: async args => { calls.push(['verify', args]); return { data: { user, session: { user } }, error: null }; },
    getSession: async () => ({ data: { session: { user } }, error: null }),
    getUser: async () => ({ data: { user }, error: null }),
    signOut: async args => { calls.push(['logout', args]); return { error: null }; },
    onAuthStateChange() {},
    ...overrides
  };
  const window = { FLIGHT_AUTH_CONFIG: config, location: { protocol }, supabase: {
    createClient(url, key, options) { calls.push(['create', url, key, options]); return { auth: api }; }
  } };
  vm.runInNewContext(read('auth-client.js'), { window, URL });
  return { auth: window.FlightAuth, calls };
}

test('unconfigured, secret-key and file previews cannot create an auth client', async () => {
  for (const [config, protocol] of [[{}, 'https:'], [{ ...validConfig, emailOtpEnabled: false }, 'https:'], [{ ...validConfig, publishableKey: 'sb_secret_not_for_browser' }, 'https:'], [validConfig, 'file:']]) {
    const { auth, calls } = adapter(config, protocol);
    assert.equal(auth.ready, false); assert.equal(calls.length, 0);
    await assert.rejects(auth.sendCode('pilot@example.com'));
  }
});

test('uses separate auth storage and sends every code to the server, including old demo code', async () => {
  const { auth, calls } = adapter();
  assert.equal(calls[0][3].auth.storageKey, 'flight-time-auth-test-test-project-v1');
  assert.equal(calls[0][3].auth.detectSessionInUrl, false);
  await auth.sendCode('pilot@example.com');
  assert.equal(calls[1][1].options.shouldCreateUser, true);
  await auth.verifyCode('pilot@example.com', '123456');
  assert.equal(calls[2][1].token, '123456'); assert.equal(calls[2][1].type, 'email');
  await auth.signOut(); assert.equal(calls[3][1].scope, 'local');
});

test('server errors and missing sessions never authenticate', async () => {
  const error = { code: 'otp_expired', status: 403 };
  const a = adapter(validConfig, 'https:', { verifyOtp: async () => ({ error }) });
  await assert.rejects(a.auth.verifyCode('pilot@example.com', '123456'), e => e === error);
  const b = adapter(validConfig, 'https:', { verifyOtp: async () => ({ data: { user: {} } }) });
  await assert.rejects(b.auth.verifyCode('pilot@example.com', '999999'));
  const c = adapter(validConfig, 'https:', { getUser: async () => ({ error: { status: 401 } }) });
  assert.equal(await c.auth.currentUser(), null);
});

test('friendly errors do not expose server response details', () => {
  const { auth } = adapter();
  assert.match(auth.errorMessage({ code: 'otp_expired' }), /Код неверный/);
  assert.match(auth.errorMessage({ status: 429 }), /Слишком много/);
  assert.match(auth.errorMessage({ name: 'AuthRetryableFetchError' }), /интернет/);
  assert.doesNotMatch(auth.errorMessage({ message: 'private-token' }), /private-token/);
});

async function ui(overrides = {}) {
  const elements = Object.fromEntries([...read('registration.html').matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    value: '', hidden: ['codeStep', 'successStep', 'setupNotice'].includes(id), textContent: '', disabled: false,
    validity: { valid: true }, attrs: {}, handlers: {},
    addEventListener(event, handler) { this.handlers[event] = handler; }, focus() {},
    setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; }
  }]));
  const calls = []; let changed;
  const auth = { ready: true, issue: '', currentUser: async () => null,
    errorMessage: error => 'Ошибка: ' + error.code,
    sendCode: async email => { calls.push(['send', email]); },
    verifyCode: async (email, code) => { calls.push(['verify', email, code]); return { email }; },
    signOut: async () => { calls.push(['logout']); },
    onChange: callback => { changed = callback; }, ...overrides
  };
  vm.runInNewContext(read('registration.js'), {
    window: { FlightAuth: auth }, document: { getElementById: id => elements[id] },
    setInterval: () => 1, clearInterval() {}, Date
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick();
  return { elements, calls, tick, change: event => changed(event), fire: async (id, event = 'click') => {
    await elements[id].handlers[event]({ preventDefault() {} }); await tick();
  } };
}

test('missing setup disables sending and clearly reports state', async () => {
  const u = await ui({ ready: false, issue: 'Не подключено' });
  assert.equal(u.elements.sendCode.disabled, true);
  assert.equal(u.elements.setupNotice.textContent, 'Не подключено');
  await u.fire('emailForm', 'submit'); assert.equal(u.calls.length, 0);
});

test('send failure stays on email screen; bad email never sends', async () => {
  const u = await ui({ sendCode: async () => { throw { code: 'network' }; } });
  u.elements.email.validity.valid = false;
  await u.fire('emailForm', 'submit'); assert.match(u.elements.emailError.textContent, /Введите почту/);
  u.elements.email.validity.valid = true; u.elements.email.value = 'pilot@example.com';
  await u.fire('emailForm', 'submit');
  assert.equal(u.elements.codeStep.hidden, true); assert.match(u.elements.emailError.textContent, /network/);
  assert.equal(u.elements.sendCode.disabled, false);
});

test('successful flow, resend cooldown, reload session and signout', async () => {
  const u = await ui(); u.elements.email.value = 'pilot@example.com';
  await u.fire('emailForm', 'submit'); assert.equal(u.elements.codeStep.hidden, false);
  assert.equal(u.elements.resend.disabled, true); await u.fire('resend'); assert.equal(u.calls.length, 1);
  u.elements.code.value = '654321'; await u.fire('codeForm', 'submit');
  assert.equal(u.elements.successStep.hidden, false);
  assert.deepEqual(u.calls[1], ['verify', 'pilot@example.com', '654321']);
  await u.fire('signOut'); assert.equal(u.elements.emailStep.hidden, false);
  assert.equal(u.elements.accountEmail.textContent, '');
  const restored = await ui({ currentUser: async () => ({ email: 'pilot@example.com' }) });
  assert.equal(restored.elements.successStep.hidden, false);
  restored.change('SIGNED_OUT'); assert.equal(restored.elements.successStep.hidden, true);
});

test('failed verification does not enter success; failed logout remains visible', async () => {
  const u = await ui({ verifyCode: async () => { throw { code: 'otp_expired' }; } });
  u.elements.email.value = 'pilot@example.com'; await u.fire('emailForm', 'submit');
  u.elements.code.value = '123456'; await u.fire('codeForm', 'submit');
  assert.equal(u.elements.successStep.hidden, true); assert.match(u.elements.codeError.textContent, /otp_expired/);
  const v = await ui({ currentUser: async () => ({ email: 'pilot@example.com' }), signOut: async () => { throw { code: 'network' }; } });
  await v.fire('signOut'); assert.equal(v.elements.successStep.hidden, false); assert.match(v.elements.accountError.textContent, /network/);
});

test('double submission cannot send duplicate requests while in flight', async () => {
  let finish, sends = 0;
  const u = await ui({ sendCode: () => { sends++; return new Promise(resolve => { finish = resolve; }); } });
  u.elements.email.value = 'pilot@example.com'; await u.fire('emailForm', 'submit');
  assert.equal(u.elements.sendCode.disabled, true); await u.fire('emailForm', 'submit'); assert.equal(sends, 1);
  finish(); await u.tick(); assert.equal(u.elements.codeStep.hidden, false);
});

test('auth scripts never access flight entries; all referenced scripts exist', () => {
  for (const file of ['auth-client.js', 'registration.js', 'account.js']) {
    assert.doesNotMatch(read(file), /flight-time-entries|localStorage\.clear|sessionStorage\.clear/);
  }
  for (const file of ['index.html', 'local.html', 'registration.html']) {
    for (const [, src] of read(file).matchAll(/<script src="([^"]+)"/g)) {
      assert.ok(fs.existsSync(path.join(root, src.split(/[?#]/)[0])), src);
    }
  }
});

test('calculator still loads, adds, exports, imports and preserves saved flight data on reload', () => {
  const key = 'flight-time-entries-v2';
  const storage = new Map([[key, JSON.stringify([{ min: 65, appr: 2, land: 1, label: 'Test flight' }])]]);
  function start() {
    function element() {
      const classes = new Set();
      return { value: '', textContent: '', hidden: false, children: [], handlers: {},
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
        set innerHTML(value) { this.children = []; },
        appendChild(child) { this.children.push(child); },
        addEventListener(event, fn) { this.handlers[event] = fn; },
        setAttribute() {}, focus() {}, select() {}
      };
    }
    const elements = Object.fromEntries([...read('local.html').matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, element()]));
    vm.runInNewContext(read('local.html').match(/<script>([\s\S]*?)<\/script>/)[1], {
      document: { getElementById: id => elements[id], createElement: element, execCommand: () => false },
      localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      navigator: {}, setTimeout: () => 1, clearTimeout() {}
    });
    return { e: elements, click: id => elements[id].handlers.click() };
  }
  const u = start(); assert.equal(u.e.tH.textContent, 1); assert.equal(u.e.tM.textContent, '05');
  u.e.h.value = '1'; u.e.m.value = '10'; u.e.a.value = '1'; u.e.l.value = '1'; u.click('add');
  assert.equal(u.e.tH.textContent, 2); assert.equal(u.e.tM.textContent, '15');
  u.click('exp'); const exported = JSON.parse(u.e.io.value); assert.equal(exported.entries.length, 2);
  assert.equal(start().e.cnt.textContent, 2);
  const saved = storage.get(key); u.e.io.value = 'broken json'; u.click('impAdd'); assert.equal(storage.get(key), saved);
  u.e.io.value = JSON.stringify({ v: 2, entries: [{ min: 30, appr: 0, land: 0, label: 'Imported test' }] });
  u.click('impAdd'); assert.equal(start().e.cnt.textContent, 3);
  assert.equal(JSON.parse(storage.get(key))[0].label, 'Test flight');
});
