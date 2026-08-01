/**
 * The /admin area: session login, prospect CRM, CSV export.
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
import { LEAD_STATUSES, toCsv } from './store.js';
import { loginPage, dashboardPage } from './admin-page.js';

const PREFIX = '/admin';

/** Failed logins per IP. Deliberately tighter than the public form's limit. */
const LOGIN_LIMIT = { max: 8, windowMs: 15 * 60 * 1000 };

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
  'country', 'cite', 'villa', 'source', 'message', 'notes',
];

/**
 * Apply the dashboard's filters. Exported so the CSV export and the table are
 * guaranteed to agree — an export that does not match what you are looking at
 * is worse than no export.
 */
export function filterLeads(leads, query = {}) {
  const term = String(query.q ?? '').trim().toLowerCase();
  const equals = ['status', 'cite', 'villa', 'source', 'country', 'device'];
  const from = query.from ? Date.parse(`${query.from}T00:00:00Z`) : NaN;
  // `to` is inclusive: a range ending today must contain today's leads.
  const to = query.to ? Date.parse(`${query.to}T23:59:59.999Z`) : NaN;

  return leads.filter((lead) => {
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
    statuses: LEAD_STATUSES,
    cites: collect('cite'),
    villas: collect('villa'),
    sources: collect('source'),
    countries: collect('country'),
    devices: collect('device'),
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

// ── the handler ─────────────────────────────────────────────────────────────

/**
 * @param {{method: string, path: string, query: object, headers: object, body: unknown, ip?: string}} req
 * @param {{env?: object, store: object, now?: number}} deps
 */
export async function handleAdmin(req, { env = process.env, store, now = Date.now() } = {}) {
  const auth = getAuth(env);

  // Rule 1: no password, no admin area at all.
  if (!auth.enabled) return notFound();

  const path = req.path.replace(/\/+$/, '') || PREFIX;
  const method = (req.method || 'GET').toUpperCase();
  const secure = isSecure(req.headers, env);
  const session = auth.verify(readCookie(headerOf(req.headers, 'cookie'), auth.cookieName));

  // ── login ────────────────────────────────────────────────────────────────
  if (path === `${PREFIX}/login`) {
    if (method !== 'POST') return html(405, loginPage(), { Allow: 'POST' });
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
      return json(401, { ok: false, error: 'Identifiants incorrects.' });
    }

    return json(200, { ok: true }, { 'Set-Cookie': auth.cookie(auth.issue(), { secure }) });
  }

  if (path === `${PREFIX}/logout`) {
    return json(200, { ok: true }, { 'Set-Cookie': auth.clearCookie({ secure }) });
  }

  // ── everything below needs a session ─────────────────────────────────────
  if (!session) {
    if (path === PREFIX && method === 'GET') return html(200, loginPage());
    return json(401, { ok: false, error: 'Session expirée. Reconnectez-vous.' });
  }

  if (path === PREFIX) {
    if (method !== 'GET') return html(405, dashboardPage(session.username), { Allow: 'GET' });
    return html(200, dashboardPage(session.username));
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

  if (path === `${PREFIX}/api/leads`) {
    if (method !== 'GET') return json(405, { ok: false, error: 'Méthode non autorisée.' }, { Allow: 'GET' });

    const all = await store.listLeads();
    const matching = filterLeads(all, req.query ?? {});
    const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 500);
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
    });
  }

  const leadMatch = /^\/admin\/api\/leads\/([\w-]{1,64})$/.exec(path);
  if (leadMatch) {
    const id = leadMatch[1];
    if (method === 'GET') {
      const lead = await store.getLead(id);
      return lead ? json(200, { ok: true, lead }) : json(404, { ok: false, error: 'Prospect introuvable.' });
    }
    if (method === 'POST' || method === 'PATCH') {
      if (!sameOrigin(req.headers)) return json(403, { ok: false, error: 'Origine non autorisée.' });
      const body = parseBody(req.body);
      if (body.status && !LEAD_STATUSES.includes(body.status)) {
        return json(422, { ok: false, error: 'Statut inconnu.', statuses: LEAD_STATUSES });
      }
      const lead = await store.patchLead(id, body);
      return lead ? json(200, { ok: true, lead }) : json(404, { ok: false, error: 'Prospect introuvable.' });
    }
    return json(405, { ok: false, error: 'Méthode non autorisée.' }, { Allow: 'GET, POST, PATCH' });
  }

  if (path === `${PREFIX}/api/stats`) {
    const days = Math.min(Math.max(Number(req.query?.days) || 30, 1), 365);
    return json(200, { ok: true, stats: await store.stats({ days }) });
  }

  if (path === `${PREFIX}/api/events`) {
    const limit = Math.min(Math.max(Number(req.query?.limit) || 200, 1), 2000);
    return json(200, { ok: true, events: await store.listEvents({ limit }) });
  }

  // ── export ───────────────────────────────────────────────────────────────
  if (path === `${PREFIX}/export.csv`) {
    const rows = filterLeads(await store.listLeads(), req.query ?? {});
    const stamp = new Date(now).toISOString().slice(0, 10);
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

  return notFound();
}
