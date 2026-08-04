import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStore, toCsv, CSV_COLUMNS } from '../lib/store.js';
import { STAGE_IDS, FIRST_STAGE, stageLabel } from '../lib/pipeline.js';

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

test('a stored lead comes back with an id and the first pipeline stage', async () => {
  await withStore(async (store) => {
    const saved = await store.addLead(lead());
    assert.ok(saved.id);
    assert.equal(saved.stage, FIRST_STAGE);
    assert.equal(saved.firstName, 'Awa');
    assert.equal(saved.history.length, 1, 'the arrival is already in the history');
    assert.deepEqual(saved.comments, []);

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
    await store.patchLead(saved.id, { stage: 'contact', notes: 'Rappelé lundi' }, { by: 'Awa' });

    const lines = readFileSync(join(dir, 'leads.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'the original record is still on disk');
    assert.equal(JSON.parse(lines[0]).type, 'lead');
    assert.equal(JSON.parse(lines[1]).type, 'patch');

    const updated = await store.getLead(saved.id);
    assert.equal(updated.stage, 'contact');
    assert.equal(updated.notes, 'Rappelé lundi');
    assert.ok(updated.updatedAt);
    assert.equal(updated.history.length, 2, 'the move was appended to the history');
    assert.equal(updated.history[1].from, FIRST_STAGE);
    assert.equal(updated.history[1].by, 'Awa');
  });
});

test('patches are replayed when the file is read back from disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gcitt-store-'));
  try {
    const first = createStore({ dir });
    const saved = await first.addLead(lead());
    await first.patchLead(saved.id, { stage: 'signe' });

    // A second store shares nothing with the first but the file.
    const reopened = createStore({ dir });
    const [reloaded] = await reopened.listLeads();
    assert.equal(reloaded.id, saved.id);
    assert.equal(reloaded.stage, 'signe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only known stages and bounded notes are accepted', async () => {
  await withStore(async (store) => {
    const saved = await store.addLead(lead());

    await store.patchLead(saved.id, { stage: 'supprime' });
    assert.equal((await store.getLead(saved.id)).stage, FIRST_STAGE, 'unknown stage ignored');

    await store.patchLead(saved.id, { stage: 'perdu', id: 'hijacked', email: 'attacker@evil' });
    const after = await store.getLead(saved.id);
    assert.equal(after.stage, 'perdu');
    assert.equal(after.id, saved.id, 'the id cannot be patched');
    assert.equal(after.email, 'awa@example.com', 'arbitrary fields cannot be patched');

    await store.patchLead(saved.id, { notes: 'x'.repeat(5000) });
    assert.equal((await store.getLead(saved.id)).notes.length, 4000);
  });
});

test('patching an unknown id returns null instead of creating a record', async () => {
  await withStore(async (store) => {
    assert.equal(await store.patchLead('nope', { stage: 'perdu' }), null);
    assert.equal((await store.listLeads()).length, 0);
  });
});

test('every pipeline stage is accepted', async () => {
  await withStore(async (store) => {
    const saved = await store.addLead(lead());
    for (const stage of STAGE_IDS) {
      await store.patchLead(saved.id, { stage });
      assert.equal((await store.getLead(saved.id)).stage, stage);
    }
  });
});

test('the five original statuses still map onto the new stages', async () => {
  // Records written before the pipeline existed are read, not rewritten: the
  // log is append-only on purpose.
  await withStore(async (store, dir) => {
    const { appendFileSync } = await import('node:fs');
    await store.addLead(lead());
    appendFileSync(join(dir, 'leads.jsonl'),
      JSON.stringify({ type: 'lead', id: 'ancien', status: 'Converti', createdAt: '2026-01-01T00:00:00.000Z' }) + '\n');

    const reopened = createStore({ dir });
    const old = await reopened.getLead('ancien');
    assert.equal(old.status, 'Converti', 'the stored record is untouched');

    const { stageOf } = await import('../lib/pipeline.js');
    assert.equal(stageOf(old), 'signe', 'but it reads as the matching stage');
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

test('an empty store answers without failing', async () => {
  await withStore(async (store) => {
    const stats = await store.stats();
    assert.equal(stats.totalLeads, 0);
    assert.equal(stats.marketing.sessions, 0);
    assert.deepEqual(await store.listEvents(), []);
    assert.deepEqual(await store.listAudit(), []);
  });
});

test('writable() names the state of the data directory', async () => {
  await withStore(async (store) => {
    assert.equal(await store.writable(), 'ok');
  });

  // Every write path swallows its own error on purpose — a full disk must not
  // cost a prospect who has already filled in the form — so a broken data
  // directory used to show up only as a dashboard that stayed empty. These are
  // the two shapes that failure really takes on a shared host.
  const parent = mkdtempSync(join(tmpdir(), 'gcitt-store-'));
  try {
    // DATA_DIR pointing at a regular file: passes an access(W_OK) check and
    // then fails every append with ENOTDIR.
    const file = join(parent, 'pas-un-dossier');
    writeFileSync(file, '');
    assert.equal(await createStore({ dir: file }).writable(), 'pas un répertoire');

    // A directory that cannot be created at all.
    assert.equal(await createStore({ dir: join(file, 'data') }).writable(), 'absent');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('stats() hands the stored rows to the analytics module', async () => {
  // The arithmetic itself is covered in test/analytics.test.js against
  // fixtures; what matters here is that the store passes through what it has.
  await withStore(async (store) => {
    await store.addLead(lead({ source: 'TikTok' }));
    await store.addEvent({ name: 'page_view', sid: 'a' });

    const stats = await store.stats({ days: 30 });
    assert.equal(stats.totalLeads, 1);
    assert.equal(stats.stageCounts.nouveau, 1);
    assert.equal(stats.marketing.sessions, 1);
    assert.ok(Array.isArray(stats.cards) && stats.cards.length > 0);
    assert.ok(Array.isArray(stats.funnel));
    assert.ok(Array.isArray(stats.vitals));
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

// ── audit log ───────────────────────────────────────────────────────────────

test('administrative actions are recorded separately from visitor events', async () => {
  await withStore(async (store) => {
    await store.addAudit({ action: 'login', user: 'admin', detail: '203.0.113.1' });
    await store.addEvent({ name: 'page_view', sid: 'a' });

    const audit = await store.listAudit();
    assert.equal(audit.length, 1, 'the visitor event is not in the audit trail');
    assert.equal(audit[0].action, 'login');
    assert.ok(audit[0].at);
    assert.equal((await store.listEvents()).length, 1);
  });
});

test('the audit trail survives a reopen and is newest first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gcitt-store-'));
  try {
    const first = createStore({ dir });
    await first.addAudit({ action: 'login', user: 'admin' });
    await first.addAudit({ action: 'export_csv', user: 'admin' });

    const reopened = createStore({ dir });
    const audit = await reopened.listAudit();
    assert.deepEqual(audit.map((a) => a.action), ['export_csv', 'login']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── backup and restore ──────────────────────────────────────────────────────

test('a backup carries the leads, the events and the audit trail', async () => {
  await withStore(async (store) => {
    await store.addLead(lead());
    await store.addEvent({ name: 'page_view', sid: 'a' });
    await store.addAudit({ action: 'login', user: 'admin' });

    const backup = await store.exportAll();
    assert.equal(backup.format, 'gcitt-backup-1');
    assert.equal(backup.leads.length, 1);
    assert.equal(backup.events.length, 1);
    assert.equal(backup.audit.length, 1);
  });
});

test('restoring is additive and never deletes what is already there', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'gcitt-store-'));
  const dirB = mkdtempSync(join(tmpdir(), 'gcitt-store-'));
  try {
    const source = createStore({ dir: dirA });
    await source.addLead(lead({ firstName: 'Awa' }));
    const backup = await source.exportAll();

    const target = createStore({ dir: dirB });
    const kept = await target.addLead(lead({ firstName: 'Koffi' }));

    const added = await target.importAll(backup);
    assert.equal(added.leads, 1);

    const all = await target.listLeads();
    assert.equal(all.length, 2, 'the existing prospect is still there');
    assert.ok(all.some((l) => l.id === kept.id));
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('restoring the same backup twice creates no duplicate', async () => {
  await withStore(async (store) => {
    await store.addLead(lead());
    await store.addEvent({ name: 'page_view', sid: 'a' });
    const backup = await store.exportAll();

    const first = await store.importAll(backup);
    const second = await store.importAll(backup);
    assert.deepEqual(first, { leads: 0, events: 0, audit: 0 }, 'nothing to add to itself');
    assert.deepEqual(second, { leads: 0, events: 0, audit: 0 });
    assert.equal((await store.listLeads()).length, 1);
  });
});

test('a restored backup reloads from disk after a restart', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'gcitt-store-'));
  const dirB = mkdtempSync(join(tmpdir(), 'gcitt-store-'));
  try {
    const source = createStore({ dir: dirA });
    await source.addLead(lead({ firstName: 'Awa' }));
    const backup = await source.exportAll();

    await createStore({ dir: dirB }).importAll(backup);
    // A fresh store reads only what is on disk.
    const restarted = createStore({ dir: dirB });
    const all = await restarted.listLeads();
    assert.equal(all.length, 1);
    assert.equal(all[0].firstName, 'Awa');
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('a payload that is not a backup adds nothing', async () => {
  await withStore(async (store) => {
    for (const payload of [null, {}, { leads: 'nope' }, { leads: [{ noId: true }] }]) {
      assert.deepEqual(await store.importAll(payload), { leads: 0, events: 0, audit: 0 });
    }
    assert.equal((await store.listLeads()).length, 0);
  });
});

// ── CSV export ──────────────────────────────────────────────────────────────

test('the CSV opens correctly in a French Excel', () => {
  const csv = toCsv([lead({ stage: 'contact', createdAt: '2026-03-01T09:30:00.000Z' })]);
  assert.ok(csv.startsWith('﻿'), 'a UTF-8 BOM keeps the accents readable');
  const [head] = csv.slice(1).split('\r\n');
  assert.ok(head.includes(';'), 'semicolons are the French locale separator');
  assert.equal(head.split(';').length, CSV_COLUMNS.length);
  assert.ok(csv.includes('"Awa"') && csv.includes('"Diallo"'));
  // The stage is spelled out, not exported as its internal id.
  assert.ok(csv.includes('"' + stageLabel('contact') + '"'));
  assert.ok(!csv.includes('"contact"'));
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
