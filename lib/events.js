/**
 * First-party event collection.
 *
 * GA4 and the Meta Pixel already receive these events, but both are blocked by
 * ad blockers, both need a Google or Meta account to read, and neither can be
 * joined to a prospect record. This endpoint keeps a copy on our own server so
 * the dashboard can state a conversion rate computed from traffic we actually
 * recorded, rather than leaving it blank or inventing one.
 *
 * Deliberately narrow:
 *
 *  - the event name and every parameter key are allow-listed;
 *  - no IP address and no user agent string are stored — the aggregate device
 *    and browser are enough to read the numbers, and an event log is not a
 *    place to accumulate identifying data about people who never wrote to us;
 *  - the session id is a random value the browser keeps for one session only;
 *  - the endpoint always answers 204, so a blocked or failing beacon can never
 *    surface as an error on the page.
 */

import { createRateLimiter, clientIp } from './ratelimit.js';
import { parseUserAgent } from './useragent.js';
import { countEvent, countStoreError } from './reqlog.js';
import { logStartup } from './startup.js';

const MAX_BODY_BYTES = 4 * 1024;

/** What the page is allowed to record. Anything else is dropped in silence. */
export const EVENT_NAMES = new Set([
  'page_view',
  'section_view',
  'cta_click',
  'click',
  'select_item',
  'form_open',
  'form_start',
  'form_submit',
  'generate_lead',
  'whatsapp_click',
  'hero_slide_view',
  'scroll',
  'engagement',
  'web_vital',
]);

/** Parameter keys worth keeping, with their maximum length. */
const PARAM_KEYS = {
  location: 60,
  item_name: 80,
  villa: 80,
  cite: 40,
  source: 40,
  slide_index: 4,
  percent_scrolled: 4,
  // Which part of the page: the funnel and the section report are built on it.
  section: 40,
  // A readable name for what was clicked, for the CTA ranking and the heatmap.
  label: 80,
  // Click position as a percentage of the document — comparable between a
  // phone and a desktop, which raw pixels are not.
  x: 8,
  y: 8,
  // Seconds of engaged time, sent once as the page is left.
  seconds: 8,
  // Core Web Vitals, measured on the visitor's own device.
  metric: 12,
  value: 16,
  // Visitor context, kept on the first page_view of a session. The operating
  // system is not here: it is derived server-side from the user agent, where
  // the browser cannot misreport it.
  tz: 60,
  lang: 12,
};

// A full visit — page view, sections, scroll milestones, clicks, engagement,
// vitals — is 20 to 40 events. This ceiling leaves room for several people
// behind one office NAT while still stopping a script from filling the disk.
const EVENT_LIMIT = { max: 300, windowMs: 10 * 60 * 1000 };

let sharedLimiter = null;

/** Test seam: forget the per-IP counters. */
export function _resetEventLimiter() {
  sharedLimiter = null;
}

// Control characters would corrupt the JSONL file, one record per line.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;

const clean = (value, max) =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(CONTROL_RE, '').trim().slice(0, max)
    : '';

/** 204, no body. The page never learns whether the event was kept. */
const accepted = () => ({ status: 204, headers: { 'Cache-Control': 'no-store' }, body: '' });

/**
 * @param {{method: string, headers: object, body: unknown, ip?: string}} req
 * @param {{env?: object, store: object|null}} deps
 */
export async function handleEvent(req, { store } = {}) {
  if (req.method !== 'POST') {
    return { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' }, body: '' };
  }
  // Nothing to write to, or events switched off: accept and discard, so the
  // page behaves identically whether or not the store is enabled.
  if (!store) return accepted();

  const header = (name) =>
    typeof req.headers?.get === 'function' ? req.headers.get(name) : req.headers?.[name];

  // Same-origin only. A browser sets Origin on every fetch and sendBeacon, so
  // this keeps another site from writing into our analytics.
  const origin = header('origin');
  if (origin) {
    let sameHost = false;
    try {
      sameHost = new URL(origin).host === header('host');
    } catch {
      sameHost = false;
    }
    if (!sameHost) return accepted();
  }

  let body = req.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return accepted();
    try {
      body = JSON.parse(body);
    } catch {
      return accepted();
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return accepted();

  const name = clean(body.name, 40);
  if (!EVENT_NAMES.has(name)) return accepted();

  const ip = req.ip || clientIp(req.headers);
  if (!sharedLimiter) sharedLimiter = createRateLimiter(EVENT_LIMIT);
  if (!sharedLimiter.check(ip, Date.now()).allowed) return accepted();

  const agent = parseUserAgent(header('user-agent'));
  // A crawler is not a visit. Counting Googlebot as a page view would deflate
  // the conversion rate for no reason.
  if (agent.bot) return accepted();

  const params = {};
  for (const [key, max] of Object.entries(PARAM_KEYS)) {
    const value = clean(body[key], max);
    if (value) params[key] = value;
  }

  try {
    await store.addEvent({
      name,
      // Random, browser-generated, kept for one session. Enough to count
      // sessions; not enough to recognise anyone on a later visit.
      sid: clean(body.sid, 40),
      path: clean(body.path, 200),
      device: agent.device,
      browser: agent.browser,
      os: agent.os,
      ...params,
    });
    countEvent(true);
  } catch (error) {
    countEvent(false);
    countStoreError();
    // A console.warn is discarded by Passenger, so a data directory that is
    // missing or read-only used to fail in complete silence: the beacon still
    // answered 204, the page still worked, and the dashboard simply stayed
    // empty for weeks with nothing anywhere to say why. This line is the one
    // that names the cause.
    logStartup(`[event] « ${name} » NON ENREGISTRÉ : ${error?.code ?? ''} ${error?.message || error}`);
  }

  return accepted();
}
