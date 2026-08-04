/**
 * End-to-end test of the analytics pipeline, one real process, one real visit.
 *
 *   navigateur → tracking.js → /api/event → data/events.jsonl
 *              → lib/analytics.js → API de la console → tableau de bord
 *
 * Every other test in this suite covers one link. This one covers the joins
 * between them, which is where the failure that matters actually lives: each
 * piece can be correct on its own while the chain still delivers an empty
 * dashboard. That is exactly what happened in production — the beacons were
 * rejected by Apache before Node ever saw them, and nothing in the application
 * was in a position to notice.
 *
 * So the assertions here are deliberately about identity, not shape: the same
 * session id has to come back out of the dashboard API, and the counters have
 * to prove the events were written rather than merely accepted.
 *
 * The scenario is the one a prospect actually performs:
 *
 *   page_view → session → sections → scroll → clic → WhatsApp → lead
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 39_521;
const BASE = `http://127.0.0.1:${PORT}`;

/** Mounted somewhere other than /admin, as production is. */
const ADMIN = '/pilotage';
const PASSWORD = 'mot-de-passe-de-test-pipeline';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'gcitt-pipeline-'));

/** One visitor, one session, for the whole file. */
const SID = randomUUID();

/** A real phone, so the user agent parser reports a device rather than a blank. */
const UA =
  'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Mobile Safari/537.36';

let child;
let cookie = '';

test.before(async () => {
  child = spawn(process.execPath, ['app.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'production',
      DATA_DIR,
      ADMIN_PATH: ADMIN,
      ADMIN_PASSWORD: PASSWORD,
      ADMIN_SESSION_SECRET: 'secret-de-test-pipeline-0123456789',
      // The form is filled by a script here, not by a human typing.
      MIN_FILL_MS: '0',
      // No credentials: every notification channel is skipped and the endpoint
      // answers without a single outbound call.
      META_WHATSAPP_TOKEN: '',
      EMAIL_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 15_000);
    let seen = '';
    child.stdout.on('data', (chunk) => {
      seen += String(chunk);
      if (seen.includes('PRÊT')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[pipeline.test] ${chunk}`));
    child.once('exit', (code) => reject(new Error(`server exited early with code ${code}`)));
  });
});

test.after(async () => {
  try {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  } finally {
    rmSync(DATA_DIR, { recursive: true, force: true });
  }
});

/** One beacon, exactly as assets/tracking.js sends it. */
async function beacon(name, extra = {}) {
  const res = await fetch(`${BASE}/api/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE, 'User-Agent': UA },
    body: JSON.stringify({ name, sid: SID, path: '/', ...extra }),
  });
  return res;
}

/** An authenticated call to the console API. */
async function console_(path) {
  const res = await fetch(BASE + ADMIN + path, { headers: { Cookie: cookie } });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

const health = () => fetch(`${BASE}/healthz`).then((r) => r.json());

// ── 1. the page really loads the tracker ────────────────────────────────────

test('la landing page charge assets/tracking.js', async () => {
  const res = await fetch(BASE + '/', { headers: { 'User-Agent': UA } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /src="assets\/tracking\.js"/);
});

test('tracking.js est servi et définit gcittTrack, gcittSessionId et le collecteur', async () => {
  const res = await fetch(`${BASE}/assets/tracking.js`);
  assert.equal(res.status, 200);
  const source = await res.text();

  // The three things the page depends on. A rename here breaks the pipeline
  // silently — the page keeps working, the dashboard just stops filling up.
  assert.match(source, /window\.gcittTrack\s*=\s*function/);
  assert.match(source, /window\.gcittSessionId\s*=\s*sessionId/);
  assert.match(source, /var BEACON_URL = '\/api\/event'/);
});

// ── 2. the visit ────────────────────────────────────────────────────────────

test('une visite complète est acceptée par /api/event', async () => {
  const visit = [
    ['page_view', { source: 'Facebook', tz: 'Africa/Porto-Novo', lang: 'fr-FR' }],
    ['section_view', { section: 'villas' }],
    ['section_view', { section: 'rendez-vous' }],
    ['form_open', { section: 'rendez-vous' }],
    ['scroll', { percent_scrolled: '25' }],
    ['scroll', { percent_scrolled: '50' }],
    ['scroll', { percent_scrolled: '75' }],
    ['click', { label: 'Voir les villas', x: '48.2', y: '61.5' }],
    ['cta_click', { label: 'Voir les villas' }],
    ['whatsapp_click', { location: 'hero' }],
    ['form_start', {}],
    ['engagement', { seconds: '95' }],
    ['web_vital', { metric: 'LCP', value: '1840' }],
  ];

  for (const [name, params] of visit) {
    const res = await beacon(name, params);
    // 204 whatever happens: the endpoint must never surface an error on the
    // page. Which is why the counters below, not this status, are the proof.
    assert.equal(res.status, 204, `${name} devrait répondre 204`);
  }

  const after = await health();
  assert.equal(after.storage, 'ok', 'le répertoire de données doit être accessible en écriture');
  assert.equal(
    after.requests.events,
    visit.length,
    'chaque balise doit avoir été comptée par le process Node',
  );
  assert.equal(
    after.requests.eventsStored,
    visit.length,
    'chaque balise comptée doit aussi avoir été écrite sur le disque',
  );
  assert.equal(after.requests.storeErrors, 0);
});

test('les événements sont écrits dans data/events.jsonl', () => {
  const file = join(DATA_DIR, 'events.jsonl');
  assert.ok(existsSync(file), 'events.jsonl doit exister');

  const rows = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const mine = rows.filter((row) => row.sid === SID);
  assert.equal(mine.length, 13);

  // Derived server-side from the user agent, never taken from the body.
  const view = mine.find((row) => row.name === 'page_view');
  assert.equal(view.device, 'Mobile');
  assert.equal(view.browser, 'Chrome 126');
  assert.match(view.os, /^Android/);
  assert.equal(view.source, 'Facebook');
});

// ── 3. the lead, carrying the same session ──────────────────────────────────

test('le formulaire enregistre un prospect porteur du même sid', async () => {
  const res = await fetch(`${BASE}/api/lead`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE, 'User-Agent': UA },
    body: JSON.stringify({
      firstName: 'Awa',
      lastName: 'Test-Pipeline',
      phone: '+22901672121',
      email: 'awa@example.com',
      country: 'Bénin',
      cite: 'Cité Cœur Joie',
      villa: 'Villa F4',
      source: 'Facebook',
      sid: SID,
      formLoadedAt: Date.now() - 30_000,
    }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.delivered.stored, true, 'le prospect doit être écrit sur le disque');

  await beacon('generate_lead', { villa: 'Villa F4', cite: 'Cité Cœur Joie', source: 'Facebook' });
});

// ── 4. the console reads what was collected ─────────────────────────────────

test('connexion à la console', async () => {
  const res = await fetch(BASE + ADMIN + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /=/);
});

test('aucune API du tableau de bord ne répond 401, 403, 404 ni 500', async () => {
  const paths = [
    '/api/overview',
    '/api/stats?days=30',
    '/api/realtime',
    '/api/heatmap?days=30',
    '/api/events?limit=300',
    '/api/audit?limit=50',
    '/api/leads?limit=100',
    '/api/seo',
    '/api/ping',
  ];

  for (const path of paths) {
    const res = await console_(path);
    assert.equal(res.status, 200, `${path} a répondu ${res.status}`);
    assert.equal(res.body.ok, true);
    // Personal data must not sit in a proxy or a browser cache — and an
    // analytics dashboard served from a cache is a dashboard that lies.
    assert.equal(res.headers.get('cache-control'), 'no-store', `${path} doit être no-store`);
  }
});

test('le même événement est visible côté collecte et côté tableau de bord', async () => {
  const stored = readFileSync(join(DATA_DIR, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((row) => row.sid === SID);

  const { body } = await console_('/api/events?limit=2000');
  const shown = body.events.filter((row) => row.sid === SID);

  // The identity that matters: not "the dashboard has some events" but "the
  // dashboard has these events".
  assert.equal(shown.length, stored.length);
  assert.deepEqual(
    shown.map((e) => e.name).sort(),
    stored.map((e) => e.name).sort(),
  );
});

test('les indicateurs du tableau de bord reflètent la visite', async () => {
  const { body } = await console_('/api/stats?days=30');
  const stats = body.stats;

  const card = (needle) => stats.cards.find((c) => c.label.toLowerCase().includes(needle));
  assert.equal(card('visiteurs aujourd')?.value, 1);
  assert.equal(card('prospects aujourd')?.value, 1);
  assert.equal(card('whatsapp')?.value, 1);
  assert.equal(card('cta')?.value, 1);
  assert.equal(card('temps moyen')?.value, 95);
  assert.equal(card('profondeur')?.value, 75);

  // Marketing: channel, geography, device, browser, hours, top CTA.
  assert.equal(stats.marketing.sessions, 1);
  assert.deepEqual(stats.marketing.bySource, { Facebook: 1 });
  assert.deepEqual(stats.marketing.byDevice, { Mobile: 1 });
  assert.deepEqual(stats.marketing.byCountryVisitors, { Bénin: 1 });
  assert.equal(stats.marketing.byCta['Voir les villas'], 1);
  assert.equal(stats.marketing.bySection.villas, 1);

  // The funnel, computed from events and from the CRM, not from an estimate.
  const visitors = stats.funnel.find((s) => s.label === 'Visiteurs');
  const registered = stats.funnel.find((s) => s.label === 'Prospects enregistrés');
  assert.equal(visitors.value, 1);
  assert.equal(registered.value, 1);

  // Core Web Vitals, from the field measurement the browser sent.
  const lcp = stats.vitals.find((v) => v.metric === 'LCP');
  assert.equal(lcp.samples, 1);
  assert.equal(lcp.p75, 1840);
});

test('le temps réel et la heatmap voient la même session', async () => {
  const live = await console_('/api/realtime');
  assert.equal(live.body.realtime.visitors.length, 1);
  assert.equal(live.body.realtime.visitors[0].device, 'Mobile');
  assert.equal(live.body.realtime.visitors[0].source, 'Facebook');

  const heat = await console_('/api/heatmap?days=30');
  assert.equal(heat.body.heatmap.total, 1, 'le clic enregistré doit apparaître dans la heatmap');
  assert.equal(heat.body.heatmap.cells.length, 1);
  assert.equal(heat.body.heatmap.byElement['Voir les villas'], 1);
  // 75 % reached, so the 25 and 50 milestones are complete and 90 is not.
  assert.equal(heat.body.heatmap.scrollReach['75'], 100);
  assert.equal(heat.body.heatmap.scrollReach['90'], 0);
});

test('la fiche prospect rattache la session au prospect', async () => {
  const list = await console_('/api/leads?limit=100');
  assert.equal(list.body.total, 1);

  const lead = list.body.leads[0];
  assert.equal(lead.sid, SID);

  const fiche = await console_(`/api/leads/${lead.id}`);
  assert.equal(fiche.status, 200);
  // The join is the session id: this is what lets the fiche show the pages
  // read and the buttons pressed before the form was sent.
  assert.equal(fiche.body.activity.visits, 1);
  assert.ok(
    fiche.body.activity.interactions.some((e) => e.name === 'whatsapp_click'),
    'le clic WhatsApp doit apparaître dans le parcours du prospect',
  );
  assert.ok(fiche.body.activity.events.length >= 13);
});

// ── 5. live, without a redeploy ─────────────────────────────────────────────

test('les données apparaissent sans redémarrage ni redéploiement', async () => {
  const before = (await console_('/api/events?limit=2000')).body.events.length;

  await beacon('cta_click', { label: 'Réserver une visite' });

  const after = (await console_('/api/events?limit=2000')).body.events;
  assert.equal(after.length, before + 1);
  assert.equal(after[0].label, 'Réserver une visite', "l'événement le plus récent est en tête");

  // And the aggregation follows, in the same process, with no cache in between.
  const stats = (await console_('/api/stats?days=30')).body.stats;
  assert.equal(stats.marketing.byCta['Réserver une visite'], 1);
});

test('le collecteur refuse une origine étrangère sans jamais le dire', async () => {
  const before = (await health()).requests.eventsStored;

  const res = await fetch(`${BASE}/api/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://exemple-hostile.test' },
    body: JSON.stringify({ name: 'page_view', sid: randomUUID() }),
  });

  // Same 204 as a legitimate beacon: the caller learns nothing.
  assert.equal(res.status, 204);
  assert.equal((await health()).requests.eventsStored, before, 'rien ne doit être écrit');
});
