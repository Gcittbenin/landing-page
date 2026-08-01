/**
 * Prospect and event store.
 *
 * Append-only JSONL, no dependency and no database to provision. A landing
 * page produces tens to hundreds of leads, and an append-only log is the
 * safest shape at that size: a crash mid-write costs at most the last line,
 * never the file.
 *
 * Updates are appended as patches rather than rewriting the file, so history
 * is preserved and a concurrent read can never observe a half-written record.
 * State is reduced on load and kept in memory afterwards.
 *
 *   {"type":"lead","id":"...","createdAt":"...", ...}
 *   {"type":"patch","id":"...","at":"...","set":{"status":"Contacté"}}
 *
 * The data directory is deliberately outside the public allow-list in
 * server.js, so none of this is reachable over HTTP.
 */

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const LEAD_STATUSES = ['Nouveau', 'Contacté', 'En cours', 'Converti', 'Perdu'];

/**
 * Serialises writes. Node is single-threaded but `await` between read and
 * write is a yield point, so two overlapping requests could otherwise
 * interleave. Every mutation goes through this chain.
 */
function createQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    // Keep the chain alive even when a caller's promise rejects.
    tail = run.catch(() => {});
    return run;
  };
}

export function createStore({ dir = join(ROOT, 'data'), maxEvents = 20000 } = {}) {
  const leadsFile = join(dir, 'leads.jsonl');
  const eventsFile = join(dir, 'events.jsonl');
  const queue = createQueue();

  let leads = null; // id -> lead
  let events = null; // array, newest last

  async function ensureDir() {
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  }

  /** Parse a JSONL file, skipping any line a crash left truncated. */
  async function readLines(file) {
    if (!existsSync(file)) return [];
    const raw = await readFile(file, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // A partial final line is expected after an unclean shutdown.
        console.warn('[store] ligne illisible ignorée');
      }
    }
    return out;
  }

  async function load() {
    if (leads) return;
    const rows = await readLines(leadsFile);
    leads = new Map();
    for (const row of rows) {
      if (row.type === 'lead') {
        leads.set(row.id, { ...row });
      } else if (row.type === 'patch' && leads.has(row.id)) {
        Object.assign(leads.get(row.id), row.set, { updatedAt: row.at });
      }
    }
    events = (await readLines(eventsFile)).slice(-maxEvents);
  }

  return {
    /** Record a validated lead. Returns the stored record. */
    async addLead(lead) {
      return queue(async () => {
        await ensureDir();
        await load();
        const record = {
          type: 'lead',
          id: randomUUID(),
          status: 'Nouveau',
          createdAt: lead.submittedAt || new Date().toISOString(),
          ...lead,
        };
        await appendFile(leadsFile, JSON.stringify(record) + '\n');
        leads.set(record.id, { ...record });
        return record;
      });
    },

    /** Change a lead's status or notes. Appends a patch, never rewrites. */
    async patchLead(id, set) {
      return queue(async () => {
        await ensureDir();
        await load();
        if (!leads.has(id)) return null;
        const allowed = {};
        if (typeof set.status === 'string' && LEAD_STATUSES.includes(set.status)) {
          allowed.status = set.status;
        }
        if (typeof set.notes === 'string') allowed.notes = set.notes.slice(0, 2000);
        if (Object.keys(allowed).length === 0) return leads.get(id);

        const patch = { type: 'patch', id, at: new Date().toISOString(), set: allowed };
        await appendFile(leadsFile, JSON.stringify(patch) + '\n');
        Object.assign(leads.get(id), allowed, { updatedAt: patch.at });
        return leads.get(id);
      });
    },

    /** Newest first. */
    async listLeads() {
      await load();
      return [...leads.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },

    async getLead(id) {
      await load();
      return leads.get(id) ?? null;
    },

    /**
     * Record a front-end event (CTA click, WhatsApp open, form abandon…).
     * Bounded: the file is trimmed in memory, and the caller rate-limits.
     */
    async addEvent(event) {
      return queue(async () => {
        await ensureDir();
        await load();
        const record = { at: new Date().toISOString(), ...event };
        await appendFile(eventsFile, JSON.stringify(record) + '\n');
        events.push(record);
        if (events.length > maxEvents) events = events.slice(-maxEvents);
        return record;
      });
    },

    async listEvents({ limit = 500 } = {}) {
      await load();
      return events.slice(-limit).reverse();
    },

    /** Counts the dashboard needs, computed from what was actually recorded. */
    async stats({ days = 30 } = {}) {
      await load();
      const since = Date.now() - days * 86400000;
      const recent = (rows) => rows.filter((r) => Date.parse(r.createdAt || r.at) >= since);

      const allLeads = [...leads.values()];
      const periodLeads = recent(allLeads);
      const periodEvents = recent(events);

      const tally = (rows, key) => {
        const out = {};
        for (const r of rows) {
          const k = (typeof key === 'function' ? key(r) : r[key]) || '—';
          out[k] = (out[k] || 0) + 1;
        }
        return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
      };

      const pageViews = periodEvents.filter((e) => e.name === 'page_view').length;

      return {
        days,
        totalLeads: allLeads.length,
        periodLeads: periodLeads.length,
        byStatus: tally(allLeads, 'status'),
        bySource: tally(periodLeads, 'source'),
        byCite: tally(periodLeads, (l) => l.cite || '—'),
        byVilla: tally(periodLeads, (l) => l.villa || '—'),
        byCountry: tally(periodLeads, (l) => l.country || '—'),
        byDevice: tally(periodLeads, (l) => l.device || '—'),
        byBrowser: tally(periodLeads, (l) => l.browser || '—'),
        eventCounts: tally(periodEvents, 'name'),
        pageViews,
        // Conversion is leads over page views: the only rate the recorded
        // data actually supports. Anything else would be invented.
        conversionRate: pageViews > 0 ? +((periodLeads.length / pageViews) * 100).toFixed(2) : null,
        daily: (() => {
          const out = {};
          for (let i = days - 1; i >= 0; i--) {
            out[new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)] = 0;
          }
          for (const l of periodLeads) {
            const d = (l.createdAt || '').slice(0, 10);
            if (d in out) out[d]++;
          }
          return out;
        })(),
      };
    },

    /** Test seam. */
    _reset() {
      leads = null;
      events = null;
    },
  };
}

/** Everything a spreadsheet needs, in the order a salesperson reads it. */
export const CSV_COLUMNS = [
  ['createdAt', 'Date'],
  ['status', 'Statut'],
  ['firstName', 'Prénom'],
  ['lastName', 'Nom'],
  ['phone', 'Téléphone / WhatsApp'],
  ['email', 'Email'],
  ['country', 'Pays'],
  ['cite', 'Cité'],
  ['villa', 'Villa'],
  ['villaType', 'Type'],
  ['budget', 'Budget'],
  ['delai', 'Délai'],
  ['message', 'Message'],
  ['source', 'Source'],
  ['utmCampaign', 'Campagne'],
  ['device', 'Appareil'],
  ['browser', 'Navigateur'],
  ['ip', 'IP'],
  ['notes', 'Notes'],
];

/**
 * RFC 4180 CSV with a UTF-8 BOM and semicolon separators, which is what
 * Excel in a French locale opens correctly without an import wizard.
 */
export function toCsv(rows, columns = CSV_COLUMNS) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    // A leading =, +, - or @ makes Excel treat the cell as a formula.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const head = columns.map(([, label]) => esc(label)).join(';');
  const body = rows.map((r) => columns.map(([key]) => esc(r[key])).join(';'));
  return '﻿' + [head, ...body].join('\r\n');
}
