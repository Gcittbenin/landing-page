/**
 * Request-level diagnostics for the administration console.
 *
 * Separate from logs/startup.log on purpose. That file answers "did the
 * application boot, and how"; this one answers "did this particular request
 * reach Node, and what did it do". Mixing them makes a boot problem hard to
 * find under a flood of request lines, and vice versa.
 *
 * ── The question this exists to settle ─────────────────────────────────────
 *
 * When a console URL answers 500, there are two possibilities, and they have
 * nothing in common:
 *
 *   A. the request reached Node and the handler threw;
 *   B. the request never reached Node, and Apache — or LiteSpeed, or a cache
 *      layer — produced the 500 itself.
 *
 * From outside, the two look identical. The counters below make them
 * distinguishable without any log access at all: only Node can increment them,
 * so a console request that leaves `adminRequests` unchanged never arrived.
 *
 * Admin traffic is a handful of requests a day, so logging all of it costs
 * nothing. The file is capped so an unattended site cannot fill a shared
 * host's quota, and writing never throws — a diagnostic that can break the
 * thing it observes is worse than no diagnostic.
 */

import { appendFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = join(ROOT, 'logs');
const LOG_FILE = join(LOG_DIR, 'requests.log');

/** Beyond this the file is restarted. A few thousand lines is plenty. */
const MAX_BYTES = 2 * 1024 * 1024;

let broken = false;
let written = 0;

/** Short enough to read aloud over the phone, long enough not to collide. */
export const newRequestId = () => randomUUID().slice(0, 8);

/**
 * Counters any endpoint can report.
 *
 * `admin` is the decisive one: it moves only when a request actually reached
 * this process.
 *
 * `events` and `eventsStored` answer the two questions an empty dashboard
 * raises, and they answer them from outside, with no log access:
 *
 *   events = 0        the beacons never arrive. The break is in front of Node
 *                     — Apache, LiteSpeed or a cache layer — not in the app.
 *   events > 0 but
 *   eventsStored = 0  they arrive and cannot be written. The break is the data
 *                     directory: missing, read-only, or out of quota.
 *
 * Without these, both look identical from a browser: /api/event answers 204
 * either way, because an analytics beacon must never surface as an error on
 * the page.
 */
export const counters = {
  total: 0,
  admin: 0,
  adminErrors: 0,
  events: 0,
  eventsStored: 0,
  storeErrors: 0,
};

export function countRequest(isAdmin) {
  counters.total++;
  if (isAdmin) counters.admin++;
}

export function countAdminError() {
  counters.adminErrors++;
}

/** An analytics beacon passed validation and was handed to the store. */
export function countEvent(stored) {
  counters.events++;
  if (stored) counters.eventsStored++;
}

/** A write to the store failed — lead or event alike. */
export function countStoreError() {
  counters.storeErrors++;
}

/**
 * Append one line. Never throws, never blocks on a full disk.
 *
 * Synchronous by design: an asynchronous write can be lost when the process
 * dies, and the lines that matter most are the ones written just before a
 * crash.
 */
export function logRequest(message) {
  if (broken) return;
  const line = `[${new Date().toISOString()}] ${message}\n`;

  try {
    mkdirSync(LOG_DIR, { recursive: true });

    // Only stat once, on the first write of a process; after that the running
    // total is enough and costs nothing.
    if (written === 0) {
      try {
        written = statSync(LOG_FILE).size;
      } catch {
        written = 0;
      }
    }

    if (written + line.length > MAX_BYTES) {
      rmSync(LOG_FILE, { force: true });
      written = 0;
      appendFileSync(LOG_FILE, `[${new Date().toISOString()}] — journal redémarré (taille maximale atteinte) —\n`);
    }

    appendFileSync(LOG_FILE, line);
    written += line.length;
  } catch {
    // A read-only filesystem must not turn every request into an exception.
    broken = true;
  }
}

/** Where the file is, so a message can point at it. */
export const REQUEST_LOG_PATH = LOG_FILE;

/** Test seam. */
export function _resetCounters() {
  for (const key of Object.keys(counters)) counters[key] = 0;
  written = 0;
  broken = false;
}
