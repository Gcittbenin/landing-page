import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleAdmin, filterLeads, _resetAdmin } from '../lib/admin.js';
import { createStore } from '../lib/store.js';
import { hashPassword, verifyPassword, createAuth, readCookie } from '../lib/auth.js';

const ENV = { ADMIN_PASSWORD: 'un-mot-de-passe-solide', ADMIN_SESSION_SECRET: 'secret-de-test' };

test.beforeEach(() => _resetAdmin());

/** A store on a throwaway directory, seeded with the given leads. */
async function seeded(leads = []) {
  const dir = mkdtempSync(join(tmpdir(), 'gcitt-admin-'));
  const store = createStore({ dir });
  for (const lead of leads) await store.addLead(lead);
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const lead = (extra = {}) => ({
  firstName: 'Awa',
  lastName: 'Diallo',
  name: 'Awa Diallo',
  email: 'awa@example.com',
  phone: '+33612345678',
  country: 'France',
  cite: 'Cœur Joie',
  villa: 'Villa Kafui (Duplex)',
  source: 'TikTok',
  submittedAt: new Date().toISOString(),
  ...extra,
});

const req = (method, path, extra = {}) => ({
  method,
  path,
  query: extra.query ?? {},
  headers: { host: 'nos-villas.gcitt.com', 'x-forwarded-proto': 'https', ...(extra.headers ?? {}) },
  body: extra.body,
  ip: extra.ip ?? '203.0.113.1',
});

/** Log in and return the Cookie header a browser would send back. */
async function login(store, env = ENV) {
  const res = await handleAdmin(
    req('POST', '/admin/login', {
      body: {
        username: env.ADMIN_USERNAME ?? 'admin',
        password: env.ADMIN_PASSWORD ?? ENV.ADMIN_PASSWORD,
      },
    }),
    { env, store },
  );
  if (res.status !== 200) return null;
  const setCookie = res.headers['Set-Cookie'];
  return setCookie.split(';')[0];
}

// ── the area does not exist without a password ──────────────────────────────

test('every admin route answers 404 when no password is configured', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    for (const path of ['/admin', '/admin/login', '/admin/api/leads', '/admin/export.csv']) {
      const res = await handleAdmin(req('GET', path), { env: {}, store });
      assert.equal(res.status, 404, path);
      // Not 403: a 403 would confirm the dashboard is there, just locked.
      assert.ok(!String(res.body).toLowerCase().includes('forbidden'));
      _resetAdmin();
    }
  } finally {
    cleanup();
  }
});

// ── authentication ──────────────────────────────────────────────────────────

test('the dashboard is not served without a session', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    const res = await handleAdmin(req('GET', '/admin'), { env: ENV, store });
    assert.equal(res.status, 200);
    assert.match(res.body, /Se connecter/, 'the login form is shown instead');
    assert.ok(!res.body.includes('Exporter CSV'), 'the dashboard markup must not leak');
  } finally {
    cleanup();
  }
});

test('the data endpoints answer 401 without a session', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    for (const path of ['/admin/api/leads', '/admin/api/stats', '/admin/export.csv']) {
      const res = await handleAdmin(req('GET', path), { env: ENV, store });
      assert.equal(res.status, 401, path);
      assert.ok(!res.body.includes('awa@example.com'), 'no prospect data leaks');
    }
  } finally {
    cleanup();
  }
});

test('a correct login issues a hardened session cookie', async () => {
  const { store, cleanup } = await seeded();
  try {
    const res = await handleAdmin(
      req('POST', '/admin/login', { body: { username: 'admin', password: ENV.ADMIN_PASSWORD } }),
      { env: ENV, store },
    );
    assert.equal(res.status, 200);
    const cookie = res.headers['Set-Cookie'];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    assert.ok(!cookie.includes(ENV.ADMIN_PASSWORD), 'the password never reaches the browser');
  } finally {
    cleanup();
  }
});

test('a wrong password is refused, and says nothing about why', async () => {
  const { store, cleanup } = await seeded();
  try {
    const wrongPassword = await handleAdmin(
      req('POST', '/admin/login', { body: { username: 'admin', password: 'x' } }),
      { env: ENV, store },
    );
    const wrongUser = await handleAdmin(
      req('POST', '/admin/login', { body: { username: 'root', password: ENV.ADMIN_PASSWORD } }),
      { env: ENV, store },
    );
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongUser.status, 401);
    assert.equal(
      JSON.parse(wrongPassword.body).error,
      JSON.parse(wrongUser.body).error,
      'the same message either way, so neither half can be probed',
    );
  } finally {
    cleanup();
  }
});

test('repeated failed logins are rate-limited per IP', async () => {
  const { store, cleanup } = await seeded();
  try {
    let last;
    for (let i = 0; i < 10; i++) {
      last = await handleAdmin(
        req('POST', '/admin/login', { body: { username: 'admin', password: 'wrong' } }),
        { env: ENV, store },
      );
    }
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers['Retry-After']) > 0);

    // The limit is per IP, so a colleague elsewhere is unaffected.
    const other = await handleAdmin(
      req('POST', '/admin/login', { body: { username: 'admin', password: ENV.ADMIN_PASSWORD }, ip: '198.51.100.7' }),
      { env: ENV, store },
    );
    assert.equal(other.status, 200);
  } finally {
    cleanup();
  }
});

test('a forged cookie is rejected', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    const forged = 'gcitt_admin=' + Buffer.from('{"u":"admin","e":9999999999999}').toString('base64url') + '.zzz';
    const res = await handleAdmin(req('GET', '/admin/api/leads', { headers: { cookie: forged } }), {
      env: ENV,
      store,
    });
    assert.equal(res.status, 401);
  } finally {
    cleanup();
  }
});

test('an expired session is rejected', async () => {
  const auth = createAuth(ENV);
  const token = auth.issue();
  const { store, cleanup } = await seeded([lead()]);
  try {
    // Nine hours later: past the eight-hour lifetime.
    const past = Date.now;
    Date.now = () => past() + 9 * 60 * 60 * 1000;
    try {
      assert.equal(auth.verify(token), null);
    } finally {
      Date.now = past;
    }
  } finally {
    cleanup();
  }
});

test('logging out clears the cookie', async () => {
  const { store, cleanup } = await seeded();
  try {
    const res = await handleAdmin(req('POST', '/admin/logout'), { env: ENV, store });
    assert.equal(res.status, 200);
    assert.match(res.headers['Set-Cookie'], /Max-Age=0/);
  } finally {
    cleanup();
  }
});

test('a cross-origin login or update is refused', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    const res = await handleAdmin(
      req('POST', '/admin/login', {
        headers: { origin: 'https://evil.example' },
        body: { username: 'admin', password: ENV.ADMIN_PASSWORD },
      }),
      { env: ENV, store },
    );
    assert.equal(res.status, 403);
  } finally {
    cleanup();
  }
});

// ── the CRM ─────────────────────────────────────────────────────────────────

test('a session lists the prospects with the filter options', async () => {
  const { store, cleanup } = await seeded([
    lead({ firstName: 'Awa', source: 'TikTok' }),
    lead({ firstName: 'Koffi', source: 'Facebook', cite: 'Bethel', country: 'Bénin' }),
  ]);
  try {
    const cookie = await login(store);
    const res = await handleAdmin(req('GET', '/admin/api/leads', { headers: { cookie } }), {
      env: ENV,
      store,
    });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.total, 2);
    assert.equal(data.leads.length, 2);
    assert.deepEqual(data.facets.sources, ['Facebook', 'TikTok']);
    assert.deepEqual(data.facets.statuses, ['Nouveau', 'Contacté', 'En cours', 'Converti', 'Perdu']);
  } finally {
    cleanup();
  }
});

test('a status change is persisted and reflected in the stats', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    const cookie = await login(store);
    const [existing] = await store.listLeads();

    const res = await handleAdmin(
      req('POST', `/admin/api/leads/${existing.id}`, {
        headers: { cookie },
        body: { status: 'Converti', notes: 'Visite prévue le 12' },
      }),
      { env: ENV, store },
    );
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).lead.status, 'Converti');

    const stats = JSON.parse(
      (await handleAdmin(req('GET', '/admin/api/stats', { headers: { cookie } }), { env: ENV, store })).body,
    ).stats;
    assert.deepEqual(stats.byStatus, { Converti: 1 });
  } finally {
    cleanup();
  }
});

test('an unknown status is refused with the list of valid ones', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    const cookie = await login(store);
    const [existing] = await store.listLeads();
    const res = await handleAdmin(
      req('POST', `/admin/api/leads/${existing.id}`, { headers: { cookie }, body: { status: 'Archivé' } }),
      { env: ENV, store },
    );
    assert.equal(res.status, 422);
    assert.ok(JSON.parse(res.body).statuses.includes('Perdu'));
  } finally {
    cleanup();
  }
});

test('updating an unknown prospect is a 404, not a new record', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    const cookie = await login(store);
    const res = await handleAdmin(
      req('POST', '/admin/api/leads/inexistant', { headers: { cookie }, body: { status: 'Perdu' } }),
      { env: ENV, store },
    );
    assert.equal(res.status, 404);
    assert.equal((await store.listLeads()).length, 1);
  } finally {
    cleanup();
  }
});

test('the CSV export carries the current filters', async () => {
  const { store, cleanup } = await seeded([
    lead({ firstName: 'Awa', source: 'TikTok' }),
    lead({ firstName: 'Koffi', source: 'Facebook' }),
  ]);
  try {
    const cookie = await login(store);
    const res = await handleAdmin(
      req('GET', '/admin/export.csv', { headers: { cookie }, query: { source: 'TikTok' } }),
      { env: ENV, store },
    );
    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /text\/csv/);
    assert.match(res.headers['Content-Disposition'], /attachment; filename="prospects-gcitt-\d{4}-\d{2}-\d{2}\.csv"/);
    assert.ok(res.body.includes('Awa'));
    assert.ok(!res.body.includes('Koffi'), 'the filter applies to the export too');
  } finally {
    cleanup();
  }
});

test('prospect data is never cached by a browser or a proxy', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    const cookie = await login(store);
    for (const path of ['/admin', '/admin/api/leads', '/admin/api/stats', '/admin/export.csv']) {
      const res = await handleAdmin(req('GET', path, { headers: { cookie } }), { env: ENV, store });
      assert.equal(res.headers['Cache-Control'], 'no-store', path);
    }
  } finally {
    cleanup();
  }
});

test('an unknown admin path is a 404', async () => {
  const { store, cleanup } = await seeded();
  try {
    const cookie = await login(store);
    const res = await handleAdmin(req('GET', '/admin/api/secrets', { headers: { cookie } }), {
      env: ENV,
      store,
    });
    assert.equal(res.status, 404);
  } finally {
    cleanup();
  }
});

test('a disabled store is reported, not crashed on', async () => {
  const cookie = await login(null);
  const res = await handleAdmin(req('GET', '/admin/api/leads', { headers: { cookie } }), {
    env: ENV,
    store: null,
  });
  assert.equal(res.status, 503);
  assert.match(JSON.parse(res.body).error, /LEAD_STORE/);
});

test('the dashboard escapes the username it echoes back', async () => {
  const env = { ...ENV, ADMIN_USERNAME: '<script>alert(1)</script>' };
  const { store, cleanup } = await seeded();
  try {
    const cookie = await login(store, env);
    assert.ok(cookie, 'the login must succeed for this test to mean anything');
    const res = await handleAdmin(req('GET', '/admin', { headers: { cookie } }), { env, store });
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Exporter CSV'), 'the dashboard really was served');
    assert.ok(!res.body.includes('<script>alert(1)</script>'));
    assert.ok(res.body.includes('&lt;script&gt;'));
  } finally {
    cleanup();
  }
});

// ── filtering ───────────────────────────────────────────────────────────────

const rows = [
  { createdAt: '2026-03-01T10:00:00.000Z', firstName: 'Awa', lastName: 'Diallo', email: 'awa@example.com', status: 'Nouveau', cite: 'Cœur Joie', source: 'TikTok', country: 'France', message: 'Je visite en juillet' },
  { createdAt: '2026-03-05T10:00:00.000Z', firstName: 'Koffi', lastName: 'Agbo', email: 'koffi@example.com', status: 'Converti', cite: 'Bethel', source: 'Facebook', country: 'Bénin', message: '' },
  { createdAt: '2026-04-02T10:00:00.000Z', firstName: 'Mariam', lastName: 'Sow', email: 'mariam@example.com', status: 'Nouveau', cite: 'Bethel', source: 'TikTok', country: 'France', message: '' },
];

test('the free-text search covers the fields a salesperson types', () => {
  assert.equal(filterLeads(rows, { q: 'diallo' }).length, 1);
  assert.equal(filterLeads(rows, { q: 'KOFFI@EXAMPLE' }).length, 1, 'search is case-insensitive');
  assert.equal(filterLeads(rows, { q: 'juillet' }).length, 1, 'the message is searched too');
  assert.equal(filterLeads(rows, { q: '' }).length, 3, 'an empty search filters nothing');
  assert.equal(filterLeads(rows, { q: 'zzz' }).length, 0);
});

test('the column filters combine', () => {
  assert.equal(filterLeads(rows, { status: 'Nouveau' }).length, 2);
  assert.equal(filterLeads(rows, { cite: 'Bethel', source: 'TikTok' }).length, 1);
  assert.equal(filterLeads(rows, { status: 'Nouveau', country: 'Bénin' }).length, 0);
});

test('the date range includes both of its bounds', () => {
  assert.equal(filterLeads(rows, { from: '2026-03-05', to: '2026-03-05' }).length, 1, 'a single-day range');
  assert.equal(filterLeads(rows, { from: '2026-03-01' }).length, 3);
  assert.equal(filterLeads(rows, { to: '2026-03-31' }).length, 2);
  assert.equal(filterLeads(rows, { from: '2026-05-01' }).length, 0);
});

// ── password hashing ────────────────────────────────────────────────────────

test('a password is stored as a salted hash, never in clear', () => {
  const stored = hashPassword('un-mot-de-passe-solide');
  assert.ok(!stored.includes('un-mot-de-passe-solide'));
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(verifyPassword('un-mot-de-passe-solide', stored), true);
  assert.equal(verifyPassword('un-mot-de-passe-solid', stored), false);
});

test('the same password hashes differently every time', () => {
  assert.notEqual(hashPassword('même'), hashPassword('même'), 'a fresh salt each time');
});

test('a malformed stored hash is a failed check, not an exception', () => {
  for (const stored of ['', 'pas-de-deux-points', 'sel:pas-de-l-hexadécimal', null, undefined]) {
    assert.equal(verifyPassword('x', stored), false);
  }
});

test('ADMIN_PASSWORD_HASH avoids putting the password in the environment', () => {
  const auth = createAuth({ ADMIN_PASSWORD_HASH: hashPassword('depuis-le-hash'), ADMIN_SESSION_SECRET: 's' });
  assert.equal(auth.enabled, true);
  assert.equal(auth.check('admin', 'depuis-le-hash'), true);
  assert.equal(auth.check('admin', 'autre'), false);
});

test('without ADMIN_SESSION_SECRET the boot log says sessions will not survive a restart', () => {
  const auth = createAuth({ ADMIN_PASSWORD: 'x' });
  assert.match(auth.status(), /redémarrage/);
  assert.match(createAuth({}).status(), /désactivé/);
});

test('a session signed by one boot is invalid on the next', () => {
  // No ADMIN_SESSION_SECRET means a random per-boot key: everyone is logged
  // out on restart, which is the safe failure.
  const first = createAuth({ ADMIN_PASSWORD: 'x' });
  const second = createAuth({ ADMIN_PASSWORD: 'x' });
  assert.equal(second.verify(first.issue()), null);
});

test('readCookie picks the right cookie out of a crowded header', () => {
  const header = 'other=1; gcitt_admin=abc.def; _ga=GA1.2.3';
  assert.equal(readCookie(header, 'gcitt_admin'), 'abc.def');
  assert.equal(readCookie(header, 'absent'), null);
  assert.equal(readCookie('', 'gcitt_admin'), null);
  assert.equal(readCookie(undefined, 'gcitt_admin'), null);
});
