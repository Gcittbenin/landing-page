/**
 * The /admin console: session login, pipeline, analytics, SEO, audit, backup.
 *
 * Framework-independent like lib/handler.js — it takes a plain request
 * description and returns a plain response description, so server.js only has
 * to write bytes and the tests can call it directly.
 *
 * Two rules shape everything here:
 *
 *  1. Without ADMIN_PASSWORD the area does not exist. Every route answers 404,
 *     including the login page. An admin dashboard nobody meant to deploy is
 *     worse than no dashboard.
 *  2. Every response is `no-store`. This is personal data — names, phone
 *     numbers, email addresses — and it must not sit in a proxy or a browser
 *     cache after the session ends.
 */

import { createAuth, readCookie } from './auth.js';
import { createRateLimiter } from './ratelimit.js';
import { toCsv } from './store.js';
import { STAGES, STAGE_IDS, isStage, stageOf, stageLabel } from './pipeline.js';
import { auditSeo } from './seo.js';
import { loginPage, dashboardPage } from './admin-page.js';

/**
 * Where the console is mounted.
 *
 * Configurable because `/admin` is a reserved path on a good many shared
 * hosts: an Apache alias for a control panel can intercept it before the
 * request ever reaches Node, and the symptom is a 500 that no amount of
 * application logging will explain. Moving the console also removes a
 * permanent brute-force target.
 */
const DEFAULT_PREFIX = '/admin';

/** Failed logins per IP. Deliberately tighter than the public form's limit. */
const LOGIN_LIMIT = { max: 8, windowMs: 15 * 60 * 1000 };

/** A restore payload is the whole prospect base; it needs room. */
const MAX_RESTORE_BYTES = 8 * 1024 * 1024;

let sharedAuth = null;
let sharedLoginLimiter = null;

export function getAuth(env = process.env) {
  if (!sharedAuth) sharedAuth = createAuth(env);
  return sharedAuth;
}

/** Test seam: forget the cached auth and the login attempt counters. */
export function _resetAdmin() {
  sharedAuth = null;
  sharedLoginLimiter = null;
}

const html = (status, body, headers = {}) => ({
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  body,
});

const json = (status, data, headers = {}) => ({
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  },
  body: JSON.stringify(data),
});

/** Not found, in the shape a static 404 would take. Never says "forbidden". */
const notFound = () => ({
  status: 404,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  body: 'Not found',
});

// ── filtering ───────────────────────────────────────────────────────────────

/** Fields a free-text search looks at. */
const SEARCH_FIELDS = [
  'firstName', 'lastName', 'name', 'email', 'phone',
  'country', 'cite', 'villa', 'source', 'message', 'notes', 'owner',
];

/**
 * Apply the dashboard's filters. Exported so the CSV export, the table and the
 * Kanban board are guaranteed to agree — an export that does not match what
 * you are looking at is worse than no export.
 */
export function filterLeads(leads, query = {}) {
  const term = String(query.q ?? '').trim().toLowerCase();
  const equals = ['cite', 'villa', 'source', 'country', 'device', 'owner'];
  const from = query.from ? Date.parse(`${query.from}T00:00:00Z`) : NaN;
  // `to` is inclusive: a range ending today must contain today's leads.
  const to = query.to ? Date.parse(`${query.to}T23:59:59.999Z`) : NaN;
  // `status` is still honoured so an older bookmark keeps working.
  const stage = query.stage || query.status || '';

  return leads.filter((lead) => {
    if (stage && stageOf(lead) !== stage) return false;

    for (const key of equals) {
      const wanted = query[key];
      if (wanted && String(lead[key] ?? '') !== String(wanted)) return false;
    }

    if (Number.isFinite(from) || Number.isFinite(to)) {
      const at = Date.parse(lead.createdAt ?? '');
      if (!Number.isFinite(at)) return false;
      if (Number.isFinite(from) && at < from) return false;
      if (Number.isFinite(to) && at > to) return false;
    }

    if (!term) return true;
    return SEARCH_FIELDS.some((field) => String(lead[field] ?? '').toLowerCase().includes(term));
  });
}

/** Distinct values per column, so the filter dropdowns only offer real options. */
function facets(leads) {
  const collect = (key) =>
    [...new Set(leads.map((l) => l[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
  return {
    stages: STAGES,
    cites: collect('cite'),
    villas: collect('villa'),
    sources: collect('source'),
    countries: collect('country'),
    devices: collect('device'),
    owners: collect('owner'),
  };
}

/**
 * A lead as the dashboard reads it: with its stage resolved and spelled out,
 * whichever vocabulary the record was written with.
 */
const present = (lead) => ({
  ...lead,
  stage: stageOf(lead),
  stageLabel: stageLabel(stageOf(lead)),
});

/**
 * Everything a session did, attached to the prospect it belongs to.
 *
 * The join is the session id the browser generated: the lead carries the one
 * that was active when the form was sent, so the fiche can show which pages
 * that person read and what they clicked before writing to us.
 */
export function leadActivity(lead, events) {
  if (!lead?.sid) return { sessions: 0, visits: 0, pages: [], interactions: [], events: [] };

  const mine = events.filter((e) => e.sid === lead.sid);
  const pages = new Map();
  for (const event of mine.filter((e) => e.name === 'page_view')) {
    pages.set(event.path || '/', (pages.get(event.path || '/') ?? 0) + 1);
  }

  const interactions = mine
    .filter((e) => ['cta_click', 'whatsapp_click', 'select_item', 'form_start', 'form_open', 'section_view'].includes(e.name))
    .slice(-40);

  return {
    sessions: 1,
    visits: mine.filter((e) => e.name === 'page_view').length,
    pages: [...pages.entries()].map(([path, count]) => ({ path, count })),
    interactions,
    events: mine.slice(-80),
  };
}

// ── request helpers ─────────────────────────────────────────────────────────

const headerOf = (headers, name) =>
  typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];

/**
 * A mutation must come from our own page.
 *
 * The session cookie is SameSite=Strict, so a browser will not attach it to a
 * cross-site request in the first place; this is the belt to that pair of
 * braces, and it also covers a client that ignores SameSite.
 */
function sameOrigin(headers) {
  const origin = headerOf(headers, 'origin');
  if (!origin) return true; // curl, or a same-origin form post
  const host = headerOf(headers, 'host');
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function parseBody(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // A plain <form> post, for a browser with JavaScript disabled.
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

/**
 * Whether to mark the cookie Secure.
 *
 * Secure cookies are dropped by the browser over plain HTTP, which would make
 * the dashboard impossible to use on http://localhost during development.
 * Production is always HTTPS, so this only ever relaxes in development.
 */
function isSecure(headers, env) {
  if ((env.ADMIN_COOKIE_SECURE ?? '').toLowerCase() === 'false') return false;
  const proto = headerOf(headers, 'x-forwarded-proto');
  if (proto) return String(proto).split(',')[0].trim() === 'https';
  const host = String(headerOf(headers, 'host') ?? '');
  return !/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
}

/** Audit entries must never stop a request from succeeding. */
async function record(store, entry) {
  try {
    await store.addAudit(entry);
  } catch (error) {
    console.warn('[admin] audit non enregistré :', error?.message || error);
  }
}

// ── the handler ─────────────────────────────────────────────────────────────

/**
 * @param {{method: string, path: string, query: object, headers: object, body: unknown, ip?: string}} req
 * @param {{env?: object, store: object|null, now?: number}} deps
 */
export async function handleAdmin(req, { env = process.env, store, now = Date.now(), prefix = DEFAULT_PREFIX } = {}) {
  const auth = getAuth(env);

  // Rule 1: no password, no admin area at all.
  if (!auth.enabled) return notFound();

  const PREFIX = prefix || DEFAULT_PREFIX;
  const path = String(req.path ?? '').replace(/\/+$/, '') || PREFIX;

  // The handler owns its own routing contract rather than trusting the caller
  // to have filtered. Without this, anything outside the console fell through
  // to the session gate below and answered 401 — which would tell an attacker
  // that a path exists when it does not.
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return notFound();
  const method = (req.method || 'GET').toUpperCase();
  const secure = isSecure(req.headers, env);
  const session = auth.verify(readCookie(headerOf(req.headers, 'cookie'), auth.cookieName));

  // ── login ────────────────────────────────────────────────────────────────
  if (path === `${PREFIX}/login`) {
    if (method !== 'POST') return html(405, loginPage(PREFIX), { Allow: 'POST' });
    if (!sameOrigin(req.headers)) return json(403, { ok: false, error: 'Origine non autorisée.' });

    if (!sharedLoginLimiter) sharedLoginLimiter = createRateLimiter(LOGIN_LIMIT);
    const limit = sharedLoginLimiter.check(req.ip || 'unknown', now);
    if (!limit.allowed) {
      return json(
        429,
        { ok: false, error: 'Trop de tentatives. Réessayez dans quelques minutes.' },
        { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) },
      );
    }

    const body = parseBody(req.body);
    if (!auth.check(body.username, body.password)) {
      // One message for a wrong user and a wrong password alike: naming which
      // one was wrong tells an attacker half the answer.
      if (store) await record(store, { action: 'login_refuse', user: String(body.username ?? '').slice(0, 40), detail: req.ip || '' });
      return json(401, { ok: false, error: 'Identifiants incorrects.' });
    }

    if (store) await record(store, { action: 'login', user: auth.username, detail: req.ip || '' });
    return json(200, { ok: true }, { 'Set-Cookie': auth.cookie(auth.issue(), { secure }) });
  }

  if (path === `${PREFIX}/logout`) {
    if (session && store) await record(store, { action: 'logout', user: session.username });
    return json(200, { ok: true }, { 'Set-Cookie': auth.clearCookie({ secure }) });
  }

  // ── everything below needs a session ─────────────────────────────────────
  if (!session) {
    if (path === PREFIX && method === 'GET') return html(200, loginPage(PREFIX));
    return json(401, { ok: false, error: 'Session expirée. Reconnectez-vous.' });
  }

  if (path === PREFIX) {
    if (method !== 'GET') return html(405, dashboardPage(session.username, PREFIX), { Allow: 'GET' });
    return html(200, dashboardPage(session.username, PREFIX));
  }

  // ── data ─────────────────────────────────────────────────────────────────
  // With LEAD_STORE=false there is nothing to read. Say so plainly rather than
  // throwing: the operator turned it off, this is not an error state.
  if (!store) {
    return json(503, {
      ok: false,
      error: "La base des prospects est désactivée (LEAD_STORE=false). Aucun prospect n'est enregistré.",
    });
  }

  if (path === `${PREFIX}/api/overview`) {
    const stats = await store.stats({ days: 30, now });
    return json(200, {
      ok: true,
      overview: {
        generatedAt: stats.generatedAt,
        online: stats.online,
        cards: stats.cards,
        stageCounts: stats.stageCounts,
        totalLeads: stats.totalLeads,
      },
      stages: STAGES,
    });
  }

  if (path === `${PREFIX}/api/stats`) {
    const days = Math.min(Math.max(Number(req.query?.days) || 30, 1), 365);
    const stats = await store.stats({ days, now });
    return json(200, { ok: true, stats });
  }

  if (path === `${PREFIX}/api/realtime`) {
    return json(200, { ok: true, realtime: await store.realtime({ now }) });
  }

  if (path === `${PREFIX}/api/heatmap`) {
    const days = Math.min(Math.max(Number(req.query?.days) || 30, 1), 365);
    return json(200, { ok: true, heatmap: await store.heatmap({ days, now }) });
  }

  if (path === `${PREFIX}/api/seo`) {
    const stats = await store.stats({ days: 30, now });
    return json(200, { ok: true, seo: await auditSeo({ vitals: stats.vitals }) });
  }

  if (path === `${PREFIX}/api/leads`) {
    if (method !== 'GET') return json(405, { ok: false, error: 'Méthode non autorisée.' }, { Allow: 'GET' });

    const all = (await store.listLeads()).map(present);
    const matching = filterLeads(all, req.query ?? {});
    const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 1000);
    const offset = Math.max(Number(req.query?.offset) || 0, 0);

    return json(200, {
      ok: true,
      total: matching.length,
      totalUnfiltered: all.length,
      limit,
      offset,
      leads: matching.slice(offset, offset + limit),
      // Computed over everything, not over the current page, so the dropdowns
      // do not shrink as you filter.
      facets: facets(all),
      stageCounts: Object.fromEntries(
        STAGE_IDS.map((id) => [id, matching.filter((l) => l.stage === id).length]),
      ),
    });
  }

  const route = (suffix) =>
    new RegExp(`^${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${suffix}$`).exec(path);

  const commentMatch = route('/api/leads/([\\w-]{1,64})/comment');
  if (commentMatch) {
    if (method !== 'POST') return json(405, { ok: false, error: 'Méthode non autorisée.' }, { Allow: 'POST' });
    if (!sameOrigin(req.headers)) return json(403, { ok: false, error: 'Origine non autorisée.' });

    const body = parseBody(req.body);
    const lead = await store.addComment(commentMatch[1], { text: body.text, by: session.username });
    if (!lead) return json(404, { ok: false, error: 'Prospect introuvable.' });
    await record(store, {
      action: 'commentaire',
      user: session.username,
      target: lead.name || lead.id,
    });
    return json(200, { ok: true, lead: present(lead) });
  }

  const leadMatch = route('/api/leads/([\\w-]{1,64})');
  if (leadMatch) {
    const id = leadMatch[1];
    if (method === 'GET') {
      const lead = await store.getLead(id);
      if (!lead) return json(404, { ok: false, error: 'Prospect introuvable.' });
      const events = await store.listEvents({ limit: 20000 });
      return json(200, { ok: true, lead: present(lead), activity: leadActivity(lead, events) });
    }
    if (method === 'POST' || method === 'PATCH') {
      if (!sameOrigin(req.headers)) return json(403, { ok: false, error: 'Origine non autorisée.' });
      const body = parseBody(req.body);
      const requested = body.stage ?? body.status;
      if (requested && !isStage(requested)) {
        return json(422, { ok: false, error: 'Étape inconnue.', stages: STAGES });
      }

      const before = await store.getLead(id);
      if (!before) return json(404, { ok: false, error: 'Prospect introuvable.' });
      const previousStage = stageOf(before);

      const lead = await store.patchLead(id, body, { by: session.username });
      if (!lead) return json(404, { ok: false, error: 'Prospect introuvable.' });

      if (requested && stageOf(lead) !== previousStage) {
        await record(store, {
          action: 'changement_etape',
          user: session.username,
          target: lead.name || id,
          detail: `${stageLabel(previousStage)} → ${stageLabel(stageOf(lead))}`,
        });
      } else {
        await record(store, {
          action: 'modification_fiche',
          user: session.username,
          target: lead.name || id,
        });
      }

      return json(200, { ok: true, lead: present(lead) });
    }
    return json(405, { ok: false, error: 'Méthode non autorisée.' }, { Allow: 'GET, POST, PATCH' });
  }

  if (path === `${PREFIX}/api/events`) {
    const limit = Math.min(Math.max(Number(req.query?.limit) || 200, 1), 2000);
    return json(200, { ok: true, events: await store.listEvents({ limit }) });
  }

  if (path === `${PREFIX}/api/audit`) {
    const limit = Math.min(Math.max(Number(req.query?.limit) || 200, 1), 2000);
    return json(200, { ok: true, audit: await store.listAudit({ limit }) });
  }

  /**
   * The notification poll.
   *
   * Deliberately tiny: the dashboard asks "anything newer than this?" every
   * few seconds, and the answer is one number plus, at most, the newest lead.
   * Server-sent events would be more elegant, but Apache in front of Passenger
   * buffers them, and a stalled stream is a dashboard that silently stops
   * updating — worse than a poll that always works.
   */
  if (path === `${PREFIX}/api/ping`) {
    const leads = await store.listLeads();
    const since = Date.parse(String(req.query?.since ?? '')) || 0;
    const fresh = leads.filter((l) => Date.parse(l.createdAt ?? '') > since);
    return json(200, {
      ok: true,
      now: new Date(now).toISOString(),
      total: leads.length,
      newCount: since ? fresh.length : 0,
      latest: fresh.length > 0 ? present(fresh[0]) : null,
      online: (await store.realtime({ now })).visitors.length,
    });
  }

  // ── export and backup ────────────────────────────────────────────────────
  if (path === `${PREFIX}/export.csv`) {
    const rows = filterLeads((await store.listLeads()).map(present), req.query ?? {});
    const stamp = new Date(now).toISOString().slice(0, 10);
    await record(store, {
      action: 'export_csv',
      user: session.username,
      detail: `${rows.length} prospect(s)`,
    });
    return {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="prospects-gcitt-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      },
      body: toCsv(rows),
    };
  }

  if (path === `${PREFIX}/backup.json`) {
    const payload = await store.exportAll();
    const stamp = new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    await record(store, {
      action: 'sauvegarde',
      user: session.username,
      detail: `${payload.leads.length} prospect(s), ${payload.events.length} événement(s)`,
    });
    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="sauvegarde-gcitt-${stamp}.json"`,
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify(payload),
    };
  }

  if (path === `${PREFIX}/restore`) {
    if (method !== 'POST') return json(405, { ok: false, error: 'Méthode non autorisée.' }, { Allow: 'POST' });
    if (!sameOrigin(req.headers)) return json(403, { ok: false, error: 'Origine non autorisée.' });

    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESTORE_BYTES) {
      return json(413, { ok: false, error: 'Sauvegarde trop volumineuse.' });
    }

    const payload = parseBody(req.body);
    if (payload?.format !== 'gcitt-backup-1') {
      return json(422, {
        ok: false,
        error: "Ce fichier n'est pas une sauvegarde GCITT (champ « format » absent ou inconnu).",
      });
    }

    const added = await store.importAll(payload);
    await record(store, {
      action: 'restauration',
      user: session.username,
      detail: `${added.leads} prospect(s), ${added.events} événement(s) ajoutés`,
    });
    return json(200, { ok: true, added });
  }

  return notFound();
}
