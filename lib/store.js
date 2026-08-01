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

import { FIRST_STAGE, isStage, stageOf, stageLabel } from './pipeline.js';
import * as analytics from './analytics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

// Roughly a thousand visits of history at 30–40 events each, a few megabytes
// on disk. Enough for the 30-day reports the dashboard shows, bounded so an
// unattended site cannot fill a shared host's quota.
const MAX_EVENTS = 50000;

export function createStore({ dir = join(ROOT, 'data'), maxEvents = MAX_EVENTS, maxAudit = 5000 } = {}) {
  const leadsFile = join(dir, 'leads.jsonl');
  const eventsFile = join(dir, 'events.jsonl');
  const auditFile = join(dir, 'audit.jsonl');
  const queue = createQueue();

  let leads = null; // id -> lead
  let events = null; // array, newest last
  let audit = null; // array, newest last

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
    audit = (await readLines(auditFile)).slice(-maxAudit);
  }

  return {
    /** Record a validated lead. Returns the stored record. */
    async addLead(lead) {
      return queue(async () => {
        await ensureDir();
        await load();
        const createdAt = lead.submittedAt || new Date().toISOString();
        const record = {
          type: 'lead',
          id: randomUUID(),
          stage: FIRST_STAGE,
          createdAt,
          ...lead,
          // The board is a record of what happened, so a lead starts with the
          // one event that is already true: it arrived.
          history: [{ at: createdAt, stage: FIRST_STAGE, by: 'Formulaire' }],
          comments: [],
        };
        await appendFile(leadsFile, JSON.stringify(record) + '\n');
        leads.set(record.id, { ...record });
        return record;
      });
    },

    /**
     * Change a lead's stage, notes or owner. Appends a patch, never rewrites.
     *
     * A stage change also appends to the lead's own history, so the fiche can
     * show how a deal moved without replaying the whole file.
     */
    async patchLead(id, set, { by = '' } = {}) {
      return queue(async () => {
        await ensureDir();
        await load();
        if (!leads.has(id)) return null;
        const current = leads.get(id);

        const allowed = {};
        // `status` is still accepted so an older client, or a bookmarked
        // request, keeps working against the new vocabulary.
        const requested = set.stage ?? set.status;
        const moved = typeof requested === 'string' && isStage(requested) && requested !== stageOf(current);
        if (moved) allowed.stage = requested;
        if (typeof set.notes === 'string') allowed.notes = set.notes.slice(0, 4000);
        if (typeof set.owner === 'string') allowed.owner = set.owner.slice(0, 80);
        if (Object.keys(allowed).length === 0) return current;

        const at = new Date().toISOString();
        if (moved) {
          const entry = { at, stage: allowed.stage, from: stageOf(current), by: by || 'Admin' };
          allowed.history = [...(current.history ?? []), entry].slice(-60);
        }

        const patch = { type: 'patch', id, at, set: allowed };
        await appendFile(leadsFile, JSON.stringify(patch) + '\n');
        Object.assign(current, allowed, { updatedAt: at });
        return current;
      });
    },

    /** Append an internal comment. Kept on the lead, not in a side table. */
    async addComment(id, { text, by = 'Admin' }) {
      return queue(async () => {
        await ensureDir();
        await load();
        if (!leads.has(id)) return null;
        const clean = String(text ?? '').trim().slice(0, 2000);
        if (!clean) return leads.get(id);

        const current = leads.get(id);
        const at = new Date().toISOString();
        const comments = [...(current.comments ?? []), { at, by, text: clean }].slice(-200);

        const patch = { type: 'patch', id, at, set: { comments } };
        await appendFile(leadsFile, JSON.stringify(patch) + '\n');
        Object.assign(current, { comments, updatedAt: at });
        return current;
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

    /**
     * Record an administrative action: who did what, and when.
     *
     * Separate from the visitor event log on purpose. One is traffic, the
     * other is accountability, and mixing them would make both harder to read
     * and the audit trail easy to bury under a flood of page views.
     */
    async addAudit({ action, user = '', target = '', detail = '' }) {
      return queue(async () => {
        await ensureDir();
        await load();
        const record = {
          at: new Date().toISOString(),
          action: String(action ?? '').slice(0, 40),
          user: String(user ?? '').slice(0, 80),
          target: String(target ?? '').slice(0, 80),
          detail: String(detail ?? '').slice(0, 300),
        };
        await appendFile(auditFile, JSON.stringify(record) + '\n');
        audit.push(record);
        if (audit.length > maxAudit) audit = audit.slice(-maxAudit);
        return record;
      });
    },

    async listAudit({ limit = 300 } = {}) {
      await load();
      return audit.slice(-limit).reverse();
    },

    /** Everything on disk, for the backup export. */
    async exportAll() {
      await load();
      return {
        exportedAt: new Date().toISOString(),
        format: 'gcitt-backup-1',
        leads: [...leads.values()],
        events: [...events],
        audit: [...audit],
      };
    },

    /**
     * Restore a backup.
     *
     * Additive by design: records whose id is already present are skipped, so
     * restoring the same file twice is harmless and restoring an old backup
     * onto a live base cannot delete the prospects that arrived since. There
     * is deliberately no "replace everything" mode — a wrong click there costs
     * the whole customer base.
     */
    async importAll(payload) {
      return queue(async () => {
        await ensureDir();
        await load();
        const added = { leads: 0, events: 0, audit: 0 };

        for (const lead of Array.isArray(payload?.leads) ? payload.leads : []) {
          if (!lead || typeof lead !== 'object' || !lead.id || leads.has(lead.id)) continue;
          const record = { ...lead, type: 'lead' };
          await appendFile(leadsFile, JSON.stringify(record) + '\n');
          leads.set(record.id, { ...record });
          added.leads++;
        }

        const known = new Set(events.map((e) => `${e.at}|${e.name}|${e.sid ?? ''}`));
        for (const event of Array.isArray(payload?.events) ? payload.events : []) {
          if (!event || typeof event !== 'object' || !event.at) continue;
          const key = `${event.at}|${event.name}|${event.sid ?? ''}`;
          if (known.has(key)) continue;
          known.add(key);
          await appendFile(eventsFile, JSON.stringify(event) + '\n');
          events.push(event);
          added.events++;
        }
        if (events.length > maxEvents) events = events.slice(-maxEvents);

        const knownAudit = new Set(audit.map((a) => `${a.at}|${a.action}|${a.target}`));
        for (const entry of Array.isArray(payload?.audit) ? payload.audit : []) {
          if (!entry || typeof entry !== 'object' || !entry.at) continue;
          const key = `${entry.at}|${entry.action}|${entry.target}`;
          if (knownAudit.has(key)) continue;
          knownAudit.add(key);
          await appendFile(auditFile, JSON.stringify(entry) + '\n');
          audit.push(entry);
          added.audit++;
        }
        if (audit.length > maxAudit) audit = audit.slice(-maxAudit);

        return added;
      });
    },

    /**
     * The figures the dashboard shows.
     *
     * The arithmetic lives in lib/analytics.js; this is the seam that hands it
     * the stored rows, so the aggregations can be tested on fixtures without a
     * filesystem.
     */
    async stats({ days = 30, now = Date.now() } = {}) {
      await load();
      const allLeads = [...leads.values()];
      return {
        days,
        totalLeads: allLeads.length,
        ...analytics.overview(allLeads, events, { now }),
        marketing: analytics.marketing(allLeads, events, { days, now }),
        funnel: analytics.funnel(allLeads, events, { days, now }),
        vitals: analytics.webVitals(events, { days, now }),
      };
    },

    /** Live visitors. Separate from stats() because it is polled far more often. */
    async realtime({ minutes = 5, now = Date.now() } = {}) {
      await load();
      return analytics.realtime(events, { minutes, now });
    },

    async heatmap({ days = 30, now = Date.now() } = {}) {
      await load();
      return analytics.heatmap(events, { days, now });
    },

    /** Test seam. */
    _reset() {
      leads = null;
      events = null;
      audit = null;
    },
  };
}

/** Everything a spreadsheet needs, in the order a salesperson reads it. */
export const CSV_COLUMNS = [
  ['createdAt', 'Date'],
  ['stage', 'Étape'],
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
  ['owner', 'Commercial assigné'],
  ['notes', 'Notes'],
];

/**
 * RFC 4180 CSV with a UTF-8 BOM and semicolon separators, which is what
 * Excel in a French locale opens correctly without an import wizard.
 */
export function toCsv(rows, columns = CSV_COLUMNS) {
  // The export is read by people, so the stage is spelled out rather than
  // exported as its internal id.
  const read = (row, key) => (key === 'stage' ? stageLabel(stageOf(row)) : row[key]);

  const esc = (v) => {
    const s = v == null ? '' : String(v);
    // A leading =, +, - or @ makes Excel treat the cell as a formula.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const head = columns.map(([, label]) => esc(label)).join(';');
  const body = rows.map((r) => columns.map(([key]) => esc(read(r, key))).join(';'));
  return '﻿' + [head, ...body].join('\r\n');
}
