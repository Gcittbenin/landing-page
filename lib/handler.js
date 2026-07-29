/**
 * The lead endpoint, independent of any HTTP framework.
 *
 * Takes a plain request description, returns a plain response description.
 * api/lead.js adapts it to Vercel; server.js adapts it to node:http; the tests
 * call it directly.
 */

import { loadConfig } from './config.js';
import { validateLead, isHoneypotTripped } from './validate.js';
import { createRateLimiter, clientIp } from './ratelimit.js';
import { sendWhatsAppAlert } from './whatsapp.js';
import { sendLeadEmail, sendProspectConfirmation } from './email.js';
import { forwardToCrm } from './crm.js';

const MAX_BODY_BYTES = 16 * 1024;

/**
 * The limiter is created once per module instance so its window survives
 * across invocations on a warm serverless container.
 */
let sharedLimiter = null;
function getLimiter(config) {
  if (!sharedLimiter) sharedLimiter = createRateLimiter(config.security.rateLimit);
  return sharedLimiter;
}

/** Test seam: drop the retained limiter state. */
export function _resetLimiter() {
  sharedLimiter = null;
}

const json = (status, body, headers = {}) => ({
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  body,
});

/**
 * Same-origin enforcement.
 *
 * With no ALLOWED_ORIGINS configured we accept requests that carry no Origin
 * header (same-origin form posts, server-to-server) and reject cross-origin
 * ones. Browsers set Origin on every fetch(), so this blocks a third-party
 * page from posting to the endpoint without needing CORS preflight to fail.
 */
function originAllowed(origin, allowedOrigins, selfHost) {
  if (!origin) return true;
  if (allowedOrigins.length > 0) return allowedOrigins.includes(origin);
  if (!selfHost) return true;
  try {
    return new URL(origin).host === selfHost;
  } catch {
    return false;
  }
}

/**
 * @param {{method: string, headers: object, body: unknown, ip?: string}} req
 * @returns {Promise<{status: number, headers: object, body: object}>}
 */
export async function handleLead(req, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const config = loadConfig(env);
  const header = (name) =>
    typeof req.headers?.get === 'function' ? req.headers.get(name) : req.headers?.[name];

  if (req.method !== 'POST') {
    return json(405, { ok: false, error: 'Méthode non autorisée.' }, { Allow: 'POST' });
  }

  if (!originAllowed(header('origin'), config.security.allowedOrigins, header('host'))) {
    return json(403, { ok: false, error: 'Origine non autorisée.' });
  }

  // ---- body ---------------------------------------------------------------
  let body = req.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      return json(413, { ok: false, error: 'Requête trop volumineuse.' });
    }
    try {
      body = JSON.parse(body);
    } catch {
      return json(400, { ok: false, error: 'Corps de requête JSON invalide.' });
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(400, { ok: false, error: 'Corps de requête JSON invalide.' });
  }

  // ---- anti-spam ----------------------------------------------------------
  // A tripped honeypot gets a 200: telling a bot it was detected only helps it
  // adapt. Nothing is sent and nothing is recorded as a lead.
  if (isHoneypotTripped(body)) {
    return json(200, { ok: true, received: true });
  }

  const ip = req.ip || clientIp(req.headers);
  const limit = getLimiter(config).check(ip, now);
  if (!limit.allowed) {
    const retryAfter = Math.ceil(limit.retryAfterMs / 1000);
    return json(
      429,
      { ok: false, error: 'Trop de demandes. Merci de réessayer dans quelques minutes.' },
      { 'Retry-After': String(retryAfter) },
    );
  }

  // ---- validation ---------------------------------------------------------
  const result = validateLead(body, { now, minFillMs: config.security.minFillMs });
  if (!result.ok) {
    if (result.spam) return json(200, { ok: true, received: true });
    return json(422, { ok: false, error: 'Données du formulaire invalides.', fields: result.errors });
  }
  const { lead } = result;

  // ---- fan-out ------------------------------------------------------------
  // Channels run in parallel and none of them can throw, so one failing
  // provider never blocks the others.
  const [whatsapp, email, confirmation, crm] = await Promise.all([
    sendWhatsAppAlert(lead, config.whatsapp, { fetchImpl }),
    sendLeadEmail(lead, config.email, { fetchImpl }),
    sendProspectConfirmation(lead, config.email, config.contact, { fetchImpl }),
    forwardToCrm(lead, config.crm, { fetchImpl }),
  ]);

  const delivered = {
    whatsapp: whatsapp.ok,
    email: email.ok,
    confirmation: confirmation.ok,
    crm: crm.ok,
  };

  // Log failures server-side with enough detail to debug, while the prospect
  // only ever sees a generic outcome.
  for (const [channel, res] of Object.entries({ whatsapp, email, confirmation, crm })) {
    if (res.ok) continue;
    if (res.skipped) console.warn(`[lead] ${channel} non configuré : ${res.skipped}`);
    else console.error(`[lead] échec ${channel} :`, { error: res.error, status: res.status, code: res.code });
  }

  // The lead is captured even if every channel is down, so the log line is the
  // last-resort record. It carries no secrets.
  console.info('[lead] reçu', {
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    project: lead.villa || lead.cite || '—',
    source: lead.source,
    submittedAt: lead.submittedAt,
    delivered,
  });

  // A configured channel failing is a 502: the prospect is told to use the
  // WhatsApp button instead, rather than being told everything is fine.
  //
  // The prospect acknowledgement is deliberately excluded. If it bounces —
  // a typo'd address, a full mailbox — the sales team has still been alerted
  // and the lead is safe, so showing the prospect an error would be wrong.
  const configuredFailed = [whatsapp, email].some((r) => !r.ok && !r.skipped);
  if (configuredFailed) {
    return json(502, {
      ok: false,
      error:
        'Votre demande a été enregistrée mais la notification a échoué. ' +
        'Merci de nous contacter directement sur WhatsApp.',
      delivered,
    });
  }

  return json(200, { ok: true, delivered });
}
