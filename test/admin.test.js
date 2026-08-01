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
    assert.deepEqual(
      data.facets.stages.map((s) => s.id),
      ['nouveau', 'contact', 'relance', 'rdv', 'negociation', 'signe', 'lance', 'livre', 'perdu'],
    );
  } finally {
    cleanup();
  }
});

test('a stage change is persisted and reflected in the stats', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    const cookie = await login(store);
    const [existing] = await store.listLeads();

    const res = await handleAdmin(
      req('POST', `/admin/api/leads/${existing.id}`, {
        headers: { cookie },
        body: { stage: 'signe', notes: 'Visite prévue le 12' },
      }),
      { env: ENV, store },
    );
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).lead.stage, 'signe');
    assert.equal(JSON.parse(res.body).lead.stageLabel, 'Contrat signé');

    const stats = JSON.parse(
      (await handleAdmin(req('GET', '/admin/api/stats', { headers: { cookie } }), { env: ENV, store })).body,
    ).stats;
    assert.equal(stats.stageCounts.signe, 1);
    assert.equal(stats.stageCounts.nouveau, 0);
  } finally {
    cleanup();
  }
});

test('an unknown stage is refused with the list of valid ones', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    const cookie = await login(store);
    const [existing] = await store.listLeads();
    const res = await handleAdmin(
      req('POST', `/admin/api/leads/${existing.id}`, { headers: { cookie }, body: { stage: 'archive' } }),
      { env: ENV, store },
    );
    assert.equal(res.status, 422);
    assert.ok(JSON.parse(res.body).stages.some((s) => s.id === 'perdu'));
  } finally {
    cleanup();
  }
});

test('updating an unknown prospect is a 404, not a new record', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    const cookie = await login(store);
    const res = await handleAdmin(
      req('POST', '/admin/api/leads/inexistant', { headers: { cookie }, body: { stage: 'perdu' } }),
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

// ── the new console routes ──────────────────────────────────────────────────

test('the overview hands the KPI cards and the stage counters to the dashboard', async () => {
  const { store, cleanup } = await seeded([lead(), lead({ stage: 'rdv' })]);
  try {
    const cookie = await login(store);
    const res = await handleAdmin(req('GET', '/admin/api/overview', { headers: { cookie } }), { env: ENV, store });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.overview.totalLeads, 2);
    assert.ok(data.overview.cards.some((c) => c.label === 'Taux de conversion'));
    assert.equal(data.stages.length, 9);
  } finally {
    cleanup();
  }
});

test('a comment is stored on the fiche and attributed to its author', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    const cookie = await login(store);
    const [existing] = await store.listLeads();

    const res = await handleAdmin(
      req('POST', `/admin/api/leads/${existing.id}/comment`, {
        headers: { cookie },
        body: { text: 'Rappelé, rappelle jeudi.' },
      }),
      { env: ENV, store },
    );
    assert.equal(res.status, 200);
    const lead = JSON.parse(res.body).lead;
    assert.equal(lead.comments.length, 1);
    assert.equal(lead.comments[0].by, 'admin');
    assert.equal(lead.comments[0].text, 'Rappelé, rappelle jeudi.');
  } finally {
    cleanup();
  }
});

test('an empty comment is ignored rather than stored', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    const cookie = await login(store);
    const [existing] = await store.listLeads();
    const res = await handleAdmin(
      req('POST', `/admin/api/leads/${existing.id}/comment`, { headers: { cookie }, body: { text: '   ' } }),
      { env: ENV, store },
    );
    assert.equal(JSON.parse(res.body).lead.comments.length, 0);
  } finally {
    cleanup();
  }
});

test("the fiche carries the prospect's own browsing, joined by session id", async () => {
  const { store, cleanup } = await seeded();
  try {
    const cookie = await login(store);
    const saved = await store.addLead({ ...lead(), sid: 'session-1' });
    await store.addEvent({ name: 'page_view', sid: 'session-1', path: '/' });
    await store.addEvent({ name: 'cta_click', sid: 'session-1', label: 'Prendre rendez-vous' });
    // Somebody else's session must not leak onto this fiche.
    await store.addEvent({ name: 'page_view', sid: 'session-2', path: '/' });

    const res = await handleAdmin(req('GET', `/admin/api/leads/${saved.id}`, { headers: { cookie } }), {
      env: ENV,
      store,
    });
    const data = JSON.parse(res.body);
    assert.equal(data.activity.visits, 1);
    assert.equal(data.activity.interactions.length, 1);
    assert.equal(data.activity.interactions[0].label, 'Prendre rendez-vous');
  } finally {
    cleanup();
  }
});

test('a lead with no session id simply has no browsing history', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    const cookie = await login(store);
    const [existing] = await store.listLeads();
    const res = await handleAdmin(req('GET', `/admin/api/leads/${existing.id}`, { headers: { cookie } }), {
      env: ENV,
      store,
    });
    assert.equal(JSON.parse(res.body).activity.visits, 0);
  } finally {
    cleanup();
  }
});

test('the SEO audit runs against the real page and returns a score', async () => {
  const { store, cleanup } = await seeded();
  try {
    const cookie = await login(store);
    const res = await handleAdmin(req('GET', '/admin/api/seo', { headers: { cookie } }), { env: ENV, store });
    assert.equal(res.status, 200);
    const seo = JSON.parse(res.body).seo;
    assert.ok(seo.score >= 0 && seo.score <= 100);
    assert.ok(seo.checks.length >= 10);
    assert.ok(seo.unavailable.length > 0, 'what cannot be measured is stated, not left blank');
  } finally {
    cleanup();
  }
});

test('the ping answers with the live count and only genuinely new leads', async () => {
  const { store, cleanup } = await seeded();
  try {
    const cookie = await login(store);
    const before = new Date(Date.now() - 60_000).toISOString();
    await store.addLead({ ...lead(), submittedAt: new Date().toISOString() });

    const fresh = JSON.parse(
      (await handleAdmin(req('GET', '/admin/api/ping', { headers: { cookie }, query: { since: before } }), {
        env: ENV,
        store,
      })).body,
    );
    assert.equal(fresh.newCount, 1);
    assert.ok(fresh.latest);

    // Asking again from "now" must not re-announce the same prospect.
    const after = JSON.parse(
      (await handleAdmin(req('GET', '/admin/api/ping', { headers: { cookie }, query: { since: fresh.now } }), {
        env: ENV,
        store,
      })).body,
    );
    assert.equal(after.newCount, 0);
    assert.equal(after.latest, null);
  } finally {
    cleanup();
  }
});

test('the first ping of a session announces nothing', async () => {
  // Without a `since`, every stored prospect would look new and the dashboard
  // would open with a burst of notifications.
  const { store, cleanup } = await seeded([lead(), lead()]);
  try {
    const cookie = await login(store);
    const res = await handleAdmin(req('GET', '/admin/api/ping', { headers: { cookie } }), { env: ENV, store });
    const data = JSON.parse(res.body);
    assert.equal(data.newCount, 0);
    assert.equal(data.total, 2);
  } finally {
    cleanup();
  }
});

// ── audit trail ─────────────────────────────────────────────────────────────

test('logins, stage changes and exports are all written to the audit trail', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    const cookie = await login(store);
    const [existing] = await store.listLeads();

    await handleAdmin(
      req('POST', `/admin/api/leads/${existing.id}`, { headers: { cookie }, body: { stage: 'contact' } }),
      { env: ENV, store },
    );
    await handleAdmin(req('GET', '/admin/export.csv', { headers: { cookie } }), { env: ENV, store });

    const entries = await store.listAudit();
    const actions = entries.map((e) => e.action);
    assert.ok(actions.includes('login'));
    assert.ok(actions.includes('changement_etape'));
    assert.ok(actions.includes('export_csv'));

    const move = entries.find((e) => e.action === 'changement_etape');
    assert.equal(move.user, 'admin');
    assert.match(move.detail, /Nouveau prospect → Premier contact/);
  } finally {
    cleanup();
  }
});

test('a refused login is recorded too', async () => {
  const { store, cleanup } = await seeded();
  try {
    await handleAdmin(
      req('POST', '/admin/login', { body: { username: 'admin', password: 'faux' } }),
      { env: ENV, store },
    );
    const entries = await store.listAudit();
    assert.equal(entries[0].action, 'login_refuse');
    assert.ok(!JSON.stringify(entries).includes('faux'), 'the attempted password is never logged');
  } finally {
    cleanup();
  }
});

test('the audit trail is readable from the dashboard', async () => {
  const { store, cleanup } = await seeded();
  try {
    const cookie = await login(store);
    const res = await handleAdmin(req('GET', '/admin/api/audit', { headers: { cookie } }), { env: ENV, store });
    assert.equal(res.status, 200);
    assert.ok(JSON.parse(res.body).audit.length > 0);
  } finally {
    cleanup();
  }
});

// ── backup and restore ──────────────────────────────────────────────────────

test('the backup downloads as a file and is recorded in the audit trail', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    const cookie = await login(store);
    const res = await handleAdmin(req('GET', '/admin/backup.json', { headers: { cookie } }), { env: ENV, store });
    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Disposition'], /attachment; filename="sauvegarde-gcitt-/);

    const payload = JSON.parse(res.body);
    assert.equal(payload.format, 'gcitt-backup-1');
    assert.equal(payload.leads.length, 1);
    assert.ok((await store.listAudit()).some((e) => e.action === 'sauvegarde'));
  } finally {
    cleanup();
  }
});

test('a restore reinserts what is missing and reports what it added', async () => {
  const { store, cleanup } = await seeded([lead({ firstName: 'Awa' })]);
  try {
    const cookie = await login(store);
    const backup = await store.exportAll();
    backup.leads.push({ ...backup.leads[0], id: 'importe', firstName: 'Koffi' });

    const res = await handleAdmin(
      req('POST', '/admin/restore', { headers: { cookie }, body: backup }),
      { env: ENV, store },
    );
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).added.leads, 1);
    assert.equal((await store.listLeads()).length, 2);
  } finally {
    cleanup();
  }
});

test('a file that is not a GCITT backup is refused', async () => {
  const { store, cleanup } = await seeded();
  try {
    const cookie = await login(store);
    for (const body of [{}, { leads: [] }, { format: 'autre-chose', leads: [] }]) {
      const res = await handleAdmin(req('POST', '/admin/restore', { headers: { cookie }, body }), {
        env: ENV,
        store,
      });
      assert.equal(res.status, 422);
      assert.match(JSON.parse(res.body).error, /sauvegarde GCITT/);
    }
  } finally {
    cleanup();
  }
});

test('a cross-origin restore is refused', async () => {
  const { store, cleanup } = await seeded();
  try {
    const cookie = await login(store);
    const res = await handleAdmin(
      req('POST', '/admin/restore', {
        headers: { cookie, origin: 'https://evil.example' },
        body: { format: 'gcitt-backup-1', leads: [] },
      }),
      { env: ENV, store },
    );
    assert.equal(res.status, 403);
  } finally {
    cleanup();
  }
});

test('the backup and the restore need a session like everything else', async () => {
  const { store, cleanup } = await seeded([lead()]);
  try {
    for (const [method, path] of [['GET', '/admin/backup.json'], ['POST', '/admin/restore'], ['GET', '/admin/api/audit']]) {
      const res = await handleAdmin(req(method, path), { env: ENV, store });
      assert.equal(res.status, 401, path);
    }
  } finally {
    cleanup();
  }
});

// ── filtering ───────────────────────────────────────────────────────────────

const rows = [
  { createdAt: '2026-03-01T10:00:00.000Z', firstName: 'Awa', lastName: 'Diallo', email: 'awa@example.com', stage: 'nouveau', cite: 'Cœur Joie', source: 'TikTok', country: 'France', message: 'Je visite en juillet' },
  { createdAt: '2026-03-05T10:00:00.000Z', firstName: 'Koffi', lastName: 'Agbo', email: 'koffi@example.com', stage: 'signe', cite: 'Bethel', source: 'Facebook', country: 'Bénin', message: '' },
  { createdAt: '2026-04-02T10:00:00.000Z', firstName: 'Mariam', lastName: 'Sow', email: 'mariam@example.com', stage: 'nouveau', cite: 'Bethel', source: 'TikTok', country: 'France', message: '' },
];

test('the free-text search covers the fields a salesperson types', () => {
  assert.equal(filterLeads(rows, { q: 'diallo' }).length, 1);
  assert.equal(filterLeads(rows, { q: 'KOFFI@EXAMPLE' }).length, 1, 'search is case-insensitive');
  assert.equal(filterLeads(rows, { q: 'juillet' }).length, 1, 'the message is searched too');
  assert.equal(filterLeads(rows, { q: '' }).length, 3, 'an empty search filters nothing');
  assert.equal(filterLeads(rows, { q: 'zzz' }).length, 0);
});

test('the column filters combine', () => {
  assert.equal(filterLeads(rows, { stage: 'nouveau' }).length, 2);
  assert.equal(filterLeads(rows, { cite: 'Bethel', source: 'TikTok' }).length, 1);
  assert.equal(filterLeads(rows, { stage: 'nouveau', country: 'Bénin' }).length, 0);
});

test('a bookmarked ?status= from the old dashboard still works', () => {
  // The five original statuses map onto the new stages on read, so an old
  // link keeps filtering the same set rather than returning nothing.
  assert.equal(filterLeads(rows, { status: 'nouveau' }).length, 2);
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
