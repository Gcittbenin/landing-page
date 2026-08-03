import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';

import {
  logRequest,
  newRequestId,
  countRequest,
  countAdminError,
  counters,
  REQUEST_LOG_PATH,
  _resetCounters,
} from '../lib/reqlog.js';

test.beforeEach(() => {
  _resetCounters();
  rmSync(REQUEST_LOG_PATH, { force: true });
});

test.after(() => rmSync(REQUEST_LOG_PATH, { force: true }));

test('a request id is short enough to read aloud and stable in shape', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const id = newRequestId();
    assert.match(id, /^[0-9a-f]{8}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 200, 'no collision over 200 draws');
});

test('the console counter moves only for console requests', () => {
  countRequest(false);
  countRequest(false);
  countRequest(true);

  assert.equal(counters.total, 3);
  assert.equal(counters.admin, 1, 'this is what distinguishes "never arrived" from "failed"');
  assert.equal(counters.adminErrors, 0);

  countAdminError();
  assert.equal(counters.adminErrors, 1);
});

test('a line is written, timestamped, one record per line', () => {
  logRequest('[abcd1234] ENTRÉE GET /pilotage');
  logRequest('[abcd1234] SORTIE HTTP 200');

  const lines = readFileSync(REQUEST_LOG_PATH, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[abcd1234\] ENTRÉE/);
  assert.match(lines[1], /SORTIE HTTP 200$/);
});

test('the file is capped, so an unattended site cannot fill the disk', () => {
  // 2 MB ceiling; a 4 KB line reaches it in about five hundred writes.
  const padding = 'x'.repeat(4000);
  for (let i = 0; i < 700; i++) logRequest(`[${i}] ${padding}`);

  const size = readFileSync(REQUEST_LOG_PATH).length;
  assert.ok(size < 2.1 * 1024 * 1024, `${size} octets`);
  assert.match(readFileSync(REQUEST_LOG_PATH, 'utf8'), /journal redémarré/);
});

test('logging never throws, whatever it is handed', () => {
  // A diagnostic that can break the thing it observes is worse than none.
  for (const value of [undefined, null, 0, {}, [], Symbol('x')]) {
    assert.doesNotThrow(() => logRequest(String(value)));
  }
  assert.ok(existsSync(REQUEST_LOG_PATH));
});
