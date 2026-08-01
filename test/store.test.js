import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStore, toCsv, CSV_COLUMNS, LEAD_STATUSES } from '../lib/store.js';

/** A store on a throwaway directory, cleaned up afterwards. */
function withStore(fn, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gcitt-store-'));
  return (async () => {
    try {
      return await fn(createStore({ dir, ...options }), dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

const lead = (extra = {}) => ({
  firstName: 'Awa',
  lastName: 'Diallo',
  name: 'Awa Diallo',
  email: 'awa@example.com',
  phone: '+33612345678',
  cite: 'Cœur Joie',
  villa: 'Villa Kafui (Duplex)',
  country: 'France',
  source: 'TikTok',
  submittedAt: new Date().toISOString(),
  ...extra,
});

test('a stored lead comes back with an id and the first CRM status', async () => {
  await withStore(async (store) => {
    const saved = await store.addLead(lead());
    assert.ok(saved.id);
    assert.equal(saved.status, 'Nouveau');
    assert.equal(saved.firstName, 'Awa');

    const all = await store.listLeads();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, saved.id);
  });
});

test('leads come back newest first', async () => {
  await withStore(async (store) => {
    await store.addLead(lead({ firstName: 'A', submittedAt: '2026-01-01T00:00:00.000Z' }));
    await store.addLead(lead({ firstName: 'C', submittedAt: '2026-03-01T00:00:00.000Z' }));
    await store.addLead(lead({ firstName: 'B', submittedAt: '2026-02-01T00:00:00.000Z' }));

    assert.deepEqual((await store.listLeads()).map((l) => l.firstName), ['C', 'B', 'A']);
  });
});

test('a status change is appended as a patch, never as a rewrite', async () => {
  await withStore(async (store, dir) => {
    const saved = await store.addLead(lead());
    await store.patchLead(saved.id, { status: 'Contacté', notes: 'Rappelé lundi' });

    const lines = readFileSync(join(dir, 'leads.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'the original record is still on disk');
    assert.equal(JSON.parse(lines[0]).type, 'lead');
    assert.equal(JSON.parse(lines[1]).type, 'patch');

    const updated = await store.getLead(saved.id);
    assert.equal(updated.status, 'Contacté');
    assert.equal(updated.notes, 'Rappelé lundi');
    assert.ok(updated.updatedAt);
  });
});

test('patches are replayed when the file is read back from disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gcitt-store-'));
  try {
    const first = createStore({ dir });
    const saved = await first.addLead(lead());
    await first.patchLead(saved.id, { status: 'Converti' });

    // A second store shares nothing with the first but the file.
    const reopened = createStore({ dir });
    const [reloaded] = await reopened.listLeads();
    assert.equal(reloaded.id, saved.id);
    assert.equal(reloaded.status, 'Converti');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only known statuses and bounded notes are accepted', async () => {
  await withStore(async (store) => {
    const saved = await store.addLead(lead());

    await store.patchLead(saved.id, { status: 'Supprimé' });
    assert.equal((await store.getLead(saved.id)).status, 'Nouveau', 'unknown status ignored');

    await store.patchLead(saved.id, { status: 'Perdu', id: 'hijacked', email: 'attacker@evil' });
    const after = await store.getLead(saved.id);
    assert.equal(after.status, 'Perdu');
    assert.equal(after.id, saved.id, 'the id cannot be patched');
    assert.equal(after.email, 'awa@example.com', 'arbitrary fields cannot be patched');

    await store.patchLead(saved.id, { notes: 'x'.repeat(5000) });
    assert.equal((await store.getLead(saved.id)).notes.length, 2000);
  });
});

test('patching an unknown id returns null instead of creating a record', async () => {
  await withStore(async (store) => {
    assert.equal(await store.patchLead('nope', { status: 'Perdu' }), null);
    assert.equal((await store.listLeads()).length, 0);
  });
});

test('every CRM status is accepted', async () => {
  await withStore(async (store) => {
    const saved = await store.addLead(lead());
    for (const status of LEAD_STATUSES) {
      await store.patchLead(saved.id, { status });
      assert.equal((await store.getLead(saved.id)).status, status);
    }
  });
});

test('concurrent writes are serialised, so no record is lost', async () => {
  await withStore(async (store, dir) => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => store.addLead(lead({ firstName: `P${i}` }))));

    assert.equal((await store.listLeads()).length, 40);
    const lines = readFileSync(join(dir, 'leads.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 40);
    // Every line must be complete JSON — an interleaved write would corrupt one.
    for (const line of lines) JSON.parse(line);
  });
});

test('a line left truncated by a crash is skipped, not fatal', async () => {
  await withStore(async (store, dir) => {
    const saved = await store.addLead(lead());
    appendFileSync(join(dir, 'leads.jsonl'), '{"type":"lead","id":"trunca');

    const reopened = createStore({ dir });
    const all = await reopened.listLeads();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, saved.id);
  });
});

test('an empty store reports zeroes rather than failing', async () => {
  await withStore(async (store) => {
    const stats = await store.stats();
    assert.equal(stats.totalLeads, 0);
    assert.equal(stats.periodLeads, 0);
    assert.equal(stats.conversionRate, null, 'no page views means no rate to report');
    assert.deepEqual(await store.listEvents(), []);
  });
});

test('stats tally the dimensions the dashboard shows', async () => {
  await withStore(async (store) => {
    await store.addLead(lead({ source: 'TikTok', cite: 'Cœur Joie', country: 'France', device: 'Mobile' }));
    await store.addLead(lead({ source: 'TikTok', cite: 'Bethel', country: 'France', device: 'Mobile' }));
    await store.addLead(lead({ source: 'Direct', cite: 'Bethel', country: 'Bénin', device: 'Ordinateur' }));

    const stats = await store.stats({ days: 30 });
    assert.equal(stats.totalLeads, 3);
    assert.deepEqual(stats.bySource, { TikTok: 2, Direct: 1 });
    assert.deepEqual(stats.byCite, { Bethel: 2, 'Cœur Joie': 1 });
    assert.deepEqual(stats.byCountry, { France: 2, Bénin: 1 });
    assert.deepEqual(stats.byDevice, { Mobile: 2, Ordinateur: 1 });
    assert.deepEqual(stats.byStatus, { Nouveau: 3 });
    // Ordered by count, so the dashboard renders the top source first.
    assert.equal(Object.keys(stats.bySource)[0], 'TikTok');
  });
});

test('the conversion rate is computed only from recorded page views', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 4; i++) await store.addEvent({ name: 'page_view' });
    await store.addLead(lead());

    const stats = await store.stats();
    assert.equal(stats.pageViews, 4);
    assert.equal(stats.conversionRate, 25);
  });
});

test('the daily series covers the whole period, including days with no lead', async () => {
  await withStore(async (store) => {
    await store.addLead(lead());
    const stats = await store.stats({ days: 7 });
    const days = Object.keys(stats.daily);
    assert.equal(days.length, 7);
    assert.deepEqual([...days].sort(), days, 'the series is in chronological order');
    assert.equal(stats.daily[days[6]], 1, "today's lead lands on the last day");
  });
});

test('leads older than the period are counted in the total but not in the period', async () => {
  await withStore(async (store) => {
    const old = new Date(Date.now() - 90 * 86400000).toISOString();
    await store.addLead(lead({ submittedAt: old }));
    await store.addLead(lead());

    const stats = await store.stats({ days: 30 });
    assert.equal(stats.totalLeads, 2);
    assert.equal(stats.periodLeads, 1);
  });
});

test('the event log is bounded and returned newest first', async () => {
  await withStore(
    async (store) => {
      for (let i = 0; i < 12; i++) await store.addEvent({ name: 'cta_click', label: `e${i}` });
      const events = await store.listEvents();
      assert.equal(events.length, 10, 'trimmed to maxEvents');
      assert.equal(events[0].label, 'e11');
      assert.ok(events[0].at, 'each event is timestamped server-side');
    },
    { maxEvents: 10 },
  );
});

// ── CSV export ──────────────────────────────────────────────────────────────

test('the CSV opens correctly in a French Excel', () => {
  const csv = toCsv([lead({ status: 'Nouveau', createdAt: '2026-03-01T09:30:00.000Z' })]);
  assert.ok(csv.startsWith('﻿'), 'a UTF-8 BOM keeps the accents readable');
  const [head] = csv.slice(1).split('\r\n');
  assert.ok(head.includes(';'), 'semicolons are the French locale separator');
  assert.equal(head.split(';').length, CSV_COLUMNS.length);
  assert.ok(csv.includes('"Awa"') && csv.includes('"Diallo"'));
});

test('a cell that looks like a formula is neutralised', () => {
  // Excel would otherwise execute =HYPERLINK(...) on open.
  const csv = toCsv([{ firstName: '=HYPERLINK("http://evil","clic")' }], [['firstName', 'Prénom']]);
  assert.ok(csv.includes(`"'=HYPERLINK`), 'the leading = is escaped');
  assert.ok(!csv.includes('"=HYPERLINK'));
  for (const dangerous of ['+', '-', '@']) {
    assert.ok(toCsv([{ a: `${dangerous}cmd` }], [['a', 'A']]).includes(`"'${dangerous}cmd"`));
  }
});

test('quotes inside a value are doubled, not dropped', () => {
  const csv = toCsv([{ message: 'Il a dit "oui"' }], [['message', 'Message']]);
  assert.ok(csv.includes('"Il a dit ""oui"""'));
});

test('missing values export as empty cells, never as "undefined"', () => {
  const csv = toCsv([{ firstName: 'Awa' }]);
  assert.ok(!csv.includes('undefined'));
  assert.ok(!csv.includes('null'));
});
