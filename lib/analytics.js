/**
 * Everything the dashboard shows, derived from what was actually recorded.
 *
 * One rule runs through this file: a number is either computed from stored
 * events or it is `null`. Nothing is estimated, extrapolated or filled in with
 * a plausible default. A blank cell tells the truth about missing tracking; a
 * fabricated one sends someone into a meeting with a made-up figure.
 *
 * Time is bucketed in Benin local time (UTC+1, no DST). "Aujourd'hui" has to
 * mean the working day the sales team is living, not a UTC window that ends at
 * 1 a.m. local.
 */

import { STAGES, STAGE_IDS, stageOf, stageLabel, WON_STAGES, CLOSED_STAGES } from './pipeline.js';

/** Benin is UTC+1 all year. */
const TZ_OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 86400000;

/** Milliseconds since the local midnight preceding `ts`. */
export function startOfLocalDay(ts) {
  const shifted = ts + TZ_OFFSET_MS;
  return shifted - (shifted % DAY_MS) - TZ_OFFSET_MS;
}

const at = (row) => Date.parse(row?.at ?? row?.createdAt ?? '') || 0;
const within = (rows, from, to) => rows.filter((r) => at(r) >= from && at(r) < to);
const distinct = (rows, key = 'sid') => new Set(rows.map((r) => r[key]).filter(Boolean)).size;

/** Count values, biggest first, so a chart renders in a useful order. */
export function tally(rows, key) {
  const out = new Map();
  for (const row of rows) {
    const value = (typeof key === 'function' ? key(row) : row[key]) || '';
    if (!value) continue;
    out.set(value, (out.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...out.entries()].sort((a, b) => b[1] - a[1]));
}

/**
 * A KPI card: the value, the same value over the previous period of equal
 * length, and which way it moved.
 *
 * `delta` is `null` — not 0 — when there is nothing to compare against. A
 * "+0 %" against an empty previous week reads as stagnation when it actually
 * means "first week of data".
 */
function kpi(label, value, previous, { unit = '', hint = '', invert = false } = {}) {
  let delta = null;
  if (previous > 0) delta = +(((value - previous) / previous) * 100).toFixed(1);
  else if (previous === 0 && value > 0) delta = null;

  let direction = 'flat';
  if (delta !== null && Math.abs(delta) >= 0.5) direction = delta > 0 ? 'up' : 'down';

  return {
    label,
    value,
    previous,
    delta,
    direction,
    // Most metrics are better when they rise; a bounce rate is not.
    good: direction === 'flat' ? null : (direction === 'up') !== invert,
    unit,
    hint,
  };
}

const eventsNamed = (events, name) => events.filter((e) => e.name === name);

/** Average of a numeric event field, or null when nothing was recorded. */
function average(rows, read) {
  const values = rows.map(read).filter((n) => Number.isFinite(n) && n >= 0);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * The deepest scroll each session reached, averaged.
 *
 * Averaging the raw milestones would be meaningless: one visitor who scrolls
 * to 90 % emits 25, 50, 75 and 90, which averages to 60 and understates them.
 */
function averageScrollDepth(events) {
  const deepest = new Map();
  for (const e of eventsNamed(events, 'scroll')) {
    const percent = Number(e.percent_scrolled);
    if (!e.sid || !Number.isFinite(percent)) continue;
    deepest.set(e.sid, Math.max(deepest.get(e.sid) ?? 0, percent));
  }
  if (deepest.size === 0) return null;
  return [...deepest.values()].reduce((a, b) => a + b, 0) / deepest.size;
}

/** Seconds on the page, from the engagement beacon sent as the page is left. */
function averageSeconds(events) {
  return average(eventsNamed(events, 'engagement'), (e) => Number(e.seconds));
}

/**
 * A bounce is a session that produced a page view and nothing else: no scroll
 * past the first milestone, no click, no form. Sessions with no engagement
 * beacon at all are still counted — leaving instantly is exactly what a bounce
 * looks like.
 */
function bounceRate(events) {
  const sessions = new Map();
  for (const e of events) {
    if (!e.sid) continue;
    if (!sessions.has(e.sid)) sessions.set(e.sid, new Set());
    sessions.get(e.sid).add(e.name);
  }
  if (sessions.size === 0) return null;

  let bounced = 0;
  for (const names of sessions.values()) {
    const engaged =
      names.has('cta_click') ||
      names.has('whatsapp_click') ||
      names.has('form_start') ||
      names.has('form_open') ||
      names.has('select_item') ||
      names.has('section_view') ||
      names.has('scroll');
    if (!engaged) bounced++;
  }
  return (bounced / sessions.size) * 100;
}

// ── executive overview ──────────────────────────────────────────────────────

/**
 * The cards on the landing screen of the dashboard.
 *
 * @param {object[]} leads
 * @param {object[]} events
 * @param {{now?: number}} options
 */
export function overview(leads, events, { now = Date.now() } = {}) {
  const today = startOfLocalDay(now);
  const windows = {
    today: [today, now + 1],
    yesterday: [today - DAY_MS, today],
    week: [today - 6 * DAY_MS, now + 1],
    previousWeek: [today - 13 * DAY_MS, today - 6 * DAY_MS],
    month: [today - 29 * DAY_MS, now + 1],
    previousMonth: [today - 59 * DAY_MS, today - 29 * DAY_MS],
  };

  const slice = (rows, name) => within(rows, windows[name][0], windows[name][1]);
  const views = eventsNamed(events, 'page_view');
  const visitors = (name) => distinct(slice(views, name));
  const leadCount = (name) => slice(leads, name).length;

  const monthEvents = slice(events, 'month');
  const previousMonthEvents = slice(events, 'previousMonth');

  const sessionsMonth = distinct(slice(views, 'month'));
  const sessionsPrevious = distinct(slice(views, 'previousMonth'));
  const rate = (count, sessions) => (sessions > 0 ? +((count / sessions) * 100).toFixed(2) : null);

  const stageCounts = countByStage(leads);
  const plannedMeetings = leads.filter((l) => {
    const stage = stageOf(l);
    return stage !== 'perdu' && STAGE_IDS.indexOf(stage) >= STAGE_IDS.indexOf('rdv');
  }).length;

  // Anyone whose last event is under five minutes old. Long enough to survive
  // a slow read of one section, short enough that the number means "now".
  const onlineSince = now - 5 * 60 * 1000;
  const online = distinct(events.filter((e) => at(e) >= onlineSince));

  const seconds = averageSeconds(monthEvents);
  const previousSeconds = averageSeconds(previousMonthEvents);
  const depth = averageScrollDepth(monthEvents);
  const previousDepth = averageScrollDepth(previousMonthEvents);

  const conversion = rate(leadCount('month'), sessionsMonth);
  const previousConversion = rate(leadCount('previousMonth'), sessionsPrevious);

  return {
    generatedAt: new Date(now).toISOString(),
    online,
    stageCounts,
    cards: [
      kpi("Visiteurs aujourd'hui", visitors('today'), visitors('yesterday'), { hint: 'vs hier' }),
      kpi('Visiteurs 7 jours', visitors('week'), visitors('previousWeek'), { hint: 'vs 7 jours précédents' }),
      kpi('Visiteurs 30 jours', visitors('month'), visitors('previousMonth'), { hint: 'vs 30 jours précédents' }),
      kpi("Prospects aujourd'hui", leadCount('today'), leadCount('yesterday'), { hint: 'vs hier' }),
      kpi('Prospects 30 jours', leadCount('month'), leadCount('previousMonth'), { hint: 'vs 30 jours précédents' }),
      kpi('Rendez-vous planifiés', plannedMeetings, null, {
        hint: 'étape « Rendez-vous planifié » et au-delà',
      }),
      kpi('Taux de conversion', conversion, previousConversion, {
        unit: '\u00a0%',
        hint: sessionsMonth > 0 ? `${leadCount('month')} prospects / ${sessionsMonth} sessions` : 'aucune session enregistrée',
      }),
      kpi(
        'Clics WhatsApp',
        eventsNamed(monthEvents, 'whatsapp_click').length,
        eventsNamed(previousMonthEvents, 'whatsapp_click').length,
        { hint: '30 jours' },
      ),
      kpi(
        'Clics sur les CTA',
        eventsNamed(monthEvents, 'cta_click').length,
        eventsNamed(previousMonthEvents, 'cta_click').length,
        { hint: '30 jours' },
      ),
      kpi('Temps moyen sur la page', seconds === null ? null : Math.round(seconds), previousSeconds === null ? null : Math.round(previousSeconds), {
        unit: '\u00a0s',
        hint: '30 jours',
      }),
      kpi('Profondeur de scroll', depth === null ? null : Math.round(depth), previousDepth === null ? null : Math.round(previousDepth), {
        unit: '\u00a0%',
        hint: 'moyenne du point le plus bas atteint',
      }),
      kpi('Visiteurs en ligne', online, null, { hint: 'activité dans les 5 dernières minutes' }),
    ],
  };
}

/** How many leads sit in each pipeline stage, in board order. */
export function countByStage(leads) {
  const counts = Object.fromEntries(STAGE_IDS.map((id) => [id, 0]));
  for (const lead of leads) counts[stageOf(lead)] = (counts[stageOf(lead)] ?? 0) + 1;
  return counts;
}

// ── conversion funnel ───────────────────────────────────────────────────────

/**
 * The visitor's path, each step counted in sessions.
 *
 * Steps are cumulative by construction: a session that submitted the form also
 * opened it. The last two steps come from the CRM rather than the event log —
 * a signed contract is not something a browser can report.
 */
export function funnel(leads, events, { days = 30, now = Date.now() } = {}) {
  const from = startOfLocalDay(now) - (days - 1) * DAY_MS;
  const periodEvents = within(events, from, now + 1);
  const periodLeads = within(leads, from, now + 1);

  const sessionsWith = (predicate) =>
    new Set(periodEvents.filter(predicate).map((e) => e.sid).filter(Boolean)).size;

  const steps = [
    { label: 'Visiteurs', value: sessionsWith((e) => e.name === 'page_view'), source: 'événements' },
    {
      label: 'Ont atteint les villas',
      value: sessionsWith((e) => e.name === 'section_view' && e.section === 'villas'),
      source: 'événements',
    },
    {
      label: 'Ont atteint le formulaire',
      value: sessionsWith((e) => e.name === 'form_open' || (e.name === 'section_view' && e.section === 'rendez-vous')),
      source: 'événements',
    },
    { label: 'Ont commencé le formulaire', value: sessionsWith((e) => e.name === 'form_start'), source: 'événements' },
    { label: 'Ont envoyé le formulaire', value: sessionsWith((e) => e.name === 'form_submit'), source: 'événements' },
    { label: 'Prospects enregistrés', value: periodLeads.length, source: 'CRM' },
    {
      label: 'Rendez-vous planifiés',
      value: periodLeads.filter((l) => STAGE_IDS.indexOf(stageOf(l)) >= STAGE_IDS.indexOf('rdv') && stageOf(l) !== 'perdu').length,
      source: 'CRM',
    },
    {
      label: 'Contrats signés',
      value: periodLeads.filter((l) => WON_STAGES.has(stageOf(l))).length,
      source: 'CRM',
    },
  ];

  const top = steps[0].value;
  return steps.map((step, index) => {
    const previous = index === 0 ? null : steps[index - 1].value;
    return {
      ...step,
      // Share of the very top of the funnel, and of the step just above — the
      // second is what points at the friction.
      shareOfTotal: top > 0 ? +((step.value / top) * 100).toFixed(1) : null,
      shareOfPrevious: previous ? +((step.value / previous) * 100).toFixed(1) : null,
      dropOff: previous ? previous - step.value : null,
    };
  });
}

// ── marketing ───────────────────────────────────────────────────────────────

/**
 * Timezone to country, for the visitors who never filled the form.
 *
 * A geo-IP database would be more precise and would also give cities, but it
 * is a dependency, a licence and a monthly update. The IANA zone the browser
 * already reports puts a visitor in the right country often enough to read a
 * trend, and it costs nothing. Anything unlisted is reported as its raw zone
 * rather than guessed at.
 */
const TZ_COUNTRY = {
  'Africa/Porto-Novo': 'Bénin',
  'Africa/Lagos': 'Nigéria',
  'Africa/Abidjan': "Côte d'Ivoire",
  'Africa/Accra': 'Ghana',
  'Africa/Lome': 'Togo',
  'Africa/Dakar': 'Sénégal',
  'Africa/Bamako': 'Mali',
  'Africa/Ouagadougou': 'Burkina Faso',
  'Africa/Niamey': 'Niger',
  'Africa/Douala': 'Cameroun',
  'Africa/Libreville': 'Gabon',
  'Africa/Kinshasa': 'RD Congo',
  'Europe/Paris': 'France',
  'Europe/Brussels': 'Belgique',
  'Europe/Zurich': 'Suisse',
  'Europe/London': 'Royaume-Uni',
  'Europe/Madrid': 'Espagne',
  'Europe/Rome': 'Italie',
  'Europe/Berlin': 'Allemagne',
  'America/Toronto': 'Canada',
  'America/Montreal': 'Canada',
  'America/New_York': 'États-Unis',
  'America/Chicago': 'États-Unis',
  'America/Los_Angeles': 'États-Unis',
};

export const countryFromTimezone = (tz) => TZ_COUNTRY[tz] ?? '';

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const WEEKDAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

export function marketing(leads, events, { days = 30, now = Date.now() } = {}) {
  const from = startOfLocalDay(now) - (days - 1) * DAY_MS;
  const periodEvents = within(events, from, now + 1);
  const periodLeads = within(leads, from, now + 1);
  const views = eventsNamed(periodEvents, 'page_view');

  // One row per session, so a visitor who reloads is not counted twice.
  const sessions = new Map();
  for (const view of views) {
    if (!view.sid || sessions.has(view.sid)) continue;
    sessions.set(view.sid, view);
  }
  const uniqueViews = [...sessions.values()];

  const localHour = (row) => new Date(at(row) + TZ_OFFSET_MS).getUTCHours();
  const localWeekday = (row) => WEEKDAYS[new Date(at(row) + TZ_OFFSET_MS).getUTCDay()];

  const byHour = Object.fromEntries(HOURS.map((h) => [String(h).padStart(2, '0') + 'h', 0]));
  for (const view of uniqueViews) byHour[String(localHour(view)).padStart(2, '0') + 'h']++;

  const byWeekday = Object.fromEntries(WEEKDAYS.map((d) => [d, 0]));
  for (const view of uniqueViews) byWeekday[localWeekday(view)]++;

  const seconds = averageSeconds(periodEvents);
  const depth = averageScrollDepth(periodEvents);
  const bounce = bounceRate(periodEvents);

  return {
    days,
    sessions: uniqueViews.length,
    pageViews: views.length,

    // Acquisition. Visitor-side attribution comes from the beacon; the lead
    // side is the same label carried on the prospect record, so the two
    // columns are directly comparable.
    bySource: tally(uniqueViews, 'source'),
    bySourceLeads: tally(periodLeads, 'source'),
    byCampaign: tally(periodLeads, 'utmCampaign'),

    // Geography. Countries the prospects declared, plus an approximation from
    // the visitor's timezone for everyone who never filled the form.
    byCountryLeads: tally(periodLeads, 'country'),
    byCountryVisitors: tally(uniqueViews, (e) => countryFromTimezone(e.tz)),
    unresolvedTimezones: tally(
      uniqueViews.filter((e) => e.tz && !countryFromTimezone(e.tz)),
      'tz',
    ),

    byDevice: tally(uniqueViews, 'device'),
    byBrowser: tally(uniqueViews, (e) => (e.browser || '').split(' ')[0]),
    byOs: tally(uniqueViews, 'os'),
    byLanguage: tally(uniqueViews, 'lang'),
    byHour,
    byWeekday,
    byPage: tally(views, 'path'),
    byCta: tally(eventsNamed(periodEvents, 'cta_click'), 'label'),
    byWhatsapp: tally(eventsNamed(periodEvents, 'whatsapp_click'), 'location'),
    bySection: tally(eventsNamed(periodEvents, 'section_view'), 'section'),

    averageSeconds: seconds === null ? null : Math.round(seconds),
    averageScroll: depth === null ? null : Math.round(depth),
    bounceRate: bounce === null ? null : +bounce.toFixed(1),
  };
}

// ── real time ───────────────────────────────────────────────────────────────

/** Who is on the site right now, one row per session. */
export function realtime(events, { minutes = 5, now = Date.now() } = {}) {
  const since = now - minutes * 60 * 1000;
  const live = new Map();

  for (const event of events) {
    const when = at(event);
    if (when < since || !event.sid) continue;
    const current = live.get(event.sid) ?? { sid: event.sid, firstSeen: when, events: 0 };
    live.set(event.sid, {
      ...current,
      lastSeen: when,
      events: current.events + 1,
      // The most recent non-empty value wins: a session's first page_view
      // carries the context, later events may not repeat it.
      path: event.path || current.path || '',
      device: event.device || current.device || '',
      browser: event.browser || current.browser || '',
      source: event.source || current.source || '',
      country: countryFromTimezone(event.tz) || current.country || '',
      tz: event.tz || current.tz || '',
      lastEvent: event.name,
    });
  }

  return {
    minutes,
    generatedAt: new Date(now).toISOString(),
    visitors: [...live.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((v) => ({
        ...v,
        // Short id: enough to tell two visitors apart on screen, not a
        // durable identifier.
        ref: v.sid.slice(0, 8),
        sid: undefined,
        secondsOnSite: Math.round((v.lastSeen - v.firstSeen) / 1000),
        lastSeenAt: new Date(v.lastSeen).toISOString(),
        firstSeen: undefined,
        lastSeen: undefined,
      })),
  };
}

// ── heatmap ─────────────────────────────────────────────────────────────────

/**
 * Click density, aggregated into a grid.
 *
 * Clicks are recorded as a percentage of the document, never as raw pixels:
 * a percentage is comparable between a phone and a 27-inch screen, and it is
 * what an overlay needs anyway. The grid is coarse on purpose — a heatmap is
 * read as "this area, not that one", and finer cells would only be noise.
 */
export function heatmap(events, { columns = 20, rows = 40, days = 30, now = Date.now() } = {}) {
  const from = startOfLocalDay(now) - (days - 1) * DAY_MS;
  const clicks = within(eventsNamed(events, 'click'), from, now + 1);

  const cells = new Map();
  let max = 0;
  for (const click of clicks) {
    const x = Number(click.x);
    const y = Number(click.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const column = Math.min(columns - 1, Math.max(0, Math.floor((x / 100) * columns)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((y / 100) * rows)));
    const key = `${column}:${row}`;
    const next = (cells.get(key) ?? 0) + 1;
    cells.set(key, next);
    if (next > max) max = next;
  }

  // Scroll reach: the share of sessions that ever saw each depth. This is what
  // shows the "ignored" part of the page — the zone below the last milestone
  // most visitors reach.
  const deepest = new Map();
  for (const e of within(eventsNamed(events, 'scroll'), from, now + 1)) {
    const percent = Number(e.percent_scrolled);
    if (!e.sid || !Number.isFinite(percent)) continue;
    deepest.set(e.sid, Math.max(deepest.get(e.sid) ?? 0, percent));
  }
  const sessions = distinct(within(eventsNamed(events, 'page_view'), from, now + 1));
  const reach = {};
  for (const milestone of [25, 50, 75, 90]) {
    const reached = [...deepest.values()].filter((d) => d >= milestone).length;
    reach[milestone] = sessions > 0 ? +((reached / sessions) * 100).toFixed(1) : null;
  }

  return {
    columns,
    rows,
    max,
    total: clicks.length,
    sessions,
    scrollReach: reach,
    byElement: tally(clicks, 'label'),
    cells: [...cells.entries()].map(([key, count]) => {
      const [column, row] = key.split(':').map(Number);
      return { column, row, count, intensity: max > 0 ? +(count / max).toFixed(3) : 0 };
    }),
  };
}

// ── Core Web Vitals ─────────────────────────────────────────────────────────

/** Google's thresholds. Below `good` is green, above `poor` is red. */
const VITAL_THRESHOLDS = {
  LCP: { good: 2500, poor: 4000, unit: 'ms', label: 'Largest Contentful Paint' },
  INP: { good: 200, poor: 500, unit: 'ms', label: 'Interaction to Next Paint' },
  CLS: { good: 0.1, poor: 0.25, unit: '', label: 'Cumulative Layout Shift' },
  FCP: { good: 1800, poor: 3000, unit: 'ms', label: 'First Contentful Paint' },
  TTFB: { good: 800, poor: 1800, unit: 'ms', label: 'Time to First Byte' },
};

/** The value below which 75 % of visits fall — the metric Google reports. */
function percentile75(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.75) - 1)];
}

export function webVitals(events, { days = 30, now = Date.now() } = {}) {
  const from = startOfLocalDay(now) - (days - 1) * DAY_MS;
  const measured = within(eventsNamed(events, 'web_vital'), from, now + 1);

  return Object.entries(VITAL_THRESHOLDS).map(([name, spec]) => {
    const values = measured
      .filter((e) => e.metric === name)
      .map((e) => Number(e.value))
      .filter((n) => Number.isFinite(n));

    const p75 = percentile75(values);
    let rating = null;
    if (p75 !== null) rating = p75 <= spec.good ? 'good' : p75 <= spec.poor ? 'needs-improvement' : 'poor';

    return {
      metric: name,
      label: spec.label,
      unit: spec.unit,
      samples: values.length,
      // Real visits, not a lab run: this is what Google's Core Web Vitals
      // report is built from, and it is the number that affects ranking.
      p75: p75 === null ? null : +p75.toFixed(spec.unit === 'ms' ? 0 : 3),
      rating,
      good: spec.good,
      poor: spec.poor,
    };
  });
}

/** Stage labels, for anything that renders a lead outside the board. */
export { STAGES, stageOf, stageLabel, CLOSED_STAGES };
