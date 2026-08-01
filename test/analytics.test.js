import test from 'node:test';
import assert from 'node:assert/strict';

import {
  overview,
  funnel,
  marketing,
  realtime,
  heatmap,
  webVitals,
  countByStage,
  startOfLocalDay,
  countryFromTimezone,
} from '../lib/analytics.js';

// A fixed "now" so every window is deterministic: 15 March 2026, 10:00 UTC,
// which is 11:00 in Benin — comfortably inside the local day either way.
const NOW = Date.parse('2026-03-15T10:00:00.000Z');
const DAY = 86400000;
const TODAY = startOfLocalDay(NOW);

const at = (offsetDays, hour = 12) =>
  new Date(TODAY + offsetDays * DAY + hour * 3600000 - 3600000).toISOString();

const lead = (extra = {}) => ({
  id: Math.random().toString(36).slice(2),
  firstName: 'Awa',
  lastName: 'Diallo',
  name: 'Awa Diallo',
  createdAt: at(0),
  stage: 'nouveau',
  source: 'TikTok',
  country: 'France',
  cite: 'Cœur Joie',
  villa: 'Villa Kafui (Duplex)',
  ...extra,
});

const view = (sid, offsetDays = 0, extra = {}) => ({
  at: at(offsetDays),
  name: 'page_view',
  sid,
  path: '/',
  device: 'Ordinateur',
  browser: 'Chrome 131',
  os: 'macOS',
  source: 'TikTok',
  tz: 'Europe/Paris',
  lang: 'fr-FR',
  ...extra,
});

const event = (name, sid, offsetDays = 0, extra = {}) => ({
  at: at(offsetDays),
  name,
  sid,
  device: 'Ordinateur',
  ...extra,
});

const card = (result, label) => result.cards.find((c) => c.label === label);

// ── the local day ───────────────────────────────────────────────────────────

test('the day starts at midnight in Benin, not at midnight UTC', () => {
  // 00:30 local on the 15th is 23:30 UTC on the 14th. A UTC-based cut-off
  // would file that visit under the wrong working day.
  const justAfterLocalMidnight = Date.parse('2026-03-14T23:30:00.000Z');
  assert.equal(startOfLocalDay(justAfterLocalMidnight), Date.parse('2026-03-14T23:00:00.000Z'));
  assert.equal(new Date(startOfLocalDay(NOW)).toISOString(), '2026-03-14T23:00:00.000Z');
});

// ── executive overview ──────────────────────────────────────────────────────

test('visitors are counted as sessions, per period', () => {
  const events = [
    view('a', 0), view('a', 0), // one person reloading
    view('b', 0),
    view('c', -1),
    view('d', -3),
    view('e', -20),
  ];
  const result = overview([], events, { now: NOW });

  assert.equal(card(result, "Visiteurs aujourd'hui").value, 2, 'a reload is not a second visitor');
  assert.equal(card(result, 'Visiteurs 7 jours').value, 4);
  assert.equal(card(result, 'Visiteurs 30 jours').value, 5, 'five people, six page views');
});

test('each card compares against the previous period of the same length', () => {
  const events = [
    view('a', 0), view('b', 0), view('c', 0), // today: 3
    view('d', -1), // yesterday: 1
  ];
  const today = card(overview([], events, { now: NOW }), "Visiteurs aujourd'hui");

  assert.equal(today.value, 3);
  assert.equal(today.previous, 1);
  assert.equal(today.delta, 200);
  assert.equal(today.direction, 'up');
  assert.equal(today.good, true);
});

test('a fall is flagged as a fall, and as bad news', () => {
  const events = [view('a', 0), view('b', -1), view('c', -1), view('d', -1), view('e', -1)];
  const today = card(overview([], events, { now: NOW }), "Visiteurs aujourd'hui");
  assert.equal(today.direction, 'down');
  assert.equal(today.good, false);
  assert.equal(today.delta, -75);
});

test('no previous data leaves the comparison blank rather than showing +0 %', () => {
  const today = card(overview([], [view('a', 0)], { now: NOW }), "Visiteurs aujourd'hui");
  assert.equal(today.value, 1);
  assert.equal(today.previous, 0);
  assert.equal(today.delta, null, '"+0 %" against an empty week reads as stagnation, which is wrong');
});

test('the conversion rate is leads over sessions', () => {
  const events = [view('a', -1), view('b', -2), view('c', -3), view('d', -4)];
  const leads = [lead({ createdAt: at(-1) })];
  const rate = card(overview(leads, events, { now: NOW }), 'Taux de conversion');
  assert.equal(rate.value, 25);
  assert.equal(rate.unit, '\u00a0%', 'a non-breaking space before the sign, as French typography requires');
});

test('with no traffic recorded the conversion rate is blank, not zero', () => {
  const rate = card(overview([lead()], [], { now: NOW }), 'Taux de conversion');
  assert.equal(rate.value, null);
  assert.match(rate.hint, /aucune session/);
});

test('WhatsApp and CTA clicks are counted over the month', () => {
  const events = [
    event('whatsapp_click', 'a', -2, { location: 'footer' }),
    event('whatsapp_click', 'b', -40),
    event('cta_click', 'a', -2, { label: 'Prendre rendez-vous' }),
    event('cta_click', 'b', -3, { label: 'Prendre rendez-vous' }),
  ];
  const result = overview([], events, { now: NOW });
  assert.equal(card(result, 'Clics WhatsApp').value, 1, 'the 40-day-old click is outside the window');
  assert.equal(card(result, 'Clics sur les CTA').value, 2);
});

test('time on page averages the engaged seconds, not the wall clock', () => {
  const events = [
    event('engagement', 'a', -1, { seconds: 40 }),
    event('engagement', 'b', -2, { seconds: 80 }),
  ];
  const result = overview([], events, { now: NOW });
  assert.equal(card(result, 'Temps moyen sur la page').value, 60);
  assert.equal(card(result, 'Temps moyen sur la page').unit, '\u00a0s');
});

test('scroll depth averages the deepest point of each session', () => {
  // One visitor reaching 90 % emits 25, 50, 75 and 90. Averaging the raw
  // milestones would report 60 and understate them.
  const events = [
    event('scroll', 'a', -1, { percent_scrolled: 25 }),
    event('scroll', 'a', -1, { percent_scrolled: 50 }),
    event('scroll', 'a', -1, { percent_scrolled: 75 }),
    event('scroll', 'a', -1, { percent_scrolled: 90 }),
    event('scroll', 'b', -1, { percent_scrolled: 50 }),
  ];
  assert.equal(card(overview([], events, { now: NOW }), 'Profondeur de scroll').value, 70);
});

test('a metric with nothing recorded reports null, never zero', () => {
  const result = overview([], [], { now: NOW });
  assert.equal(card(result, 'Temps moyen sur la page').value, null);
  assert.equal(card(result, 'Profondeur de scroll').value, null);
});

test('visitors online are those active in the last five minutes', () => {
  const events = [
    { at: new Date(NOW - 60_000).toISOString(), name: 'page_view', sid: 'a' },
    { at: new Date(NOW - 4 * 60_000).toISOString(), name: 'scroll', sid: 'b' },
    { at: new Date(NOW - 20 * 60_000).toISOString(), name: 'page_view', sid: 'c' },
  ];
  const result = overview([], events, { now: NOW });
  assert.equal(result.online, 2);
  assert.equal(card(result, 'Visiteurs en ligne').value, 2);
});

test('planned meetings count the stages from "rendez-vous" onwards, minus the lost ones', () => {
  const leads = [
    lead({ stage: 'nouveau' }),
    lead({ stage: 'rdv' }),
    lead({ stage: 'negociation' }),
    lead({ stage: 'signe' }),
    lead({ stage: 'perdu' }),
  ];
  assert.equal(card(overview(leads, [], { now: NOW }), 'Rendez-vous planifiés').value, 3);
});

test('the stage counters cover every column, including the empty ones', () => {
  const counts = countByStage([lead({ stage: 'rdv' }), lead({ stage: 'rdv' })]);
  assert.equal(counts.rdv, 2);
  assert.equal(counts.perdu, 0, 'an empty column still reports 0, not undefined');
  assert.equal(Object.keys(counts).length, 9);
});

test('a lead written with the old vocabulary lands in the right column', () => {
  const counts = countByStage([{ status: 'Converti' }, { status: 'Contacté' }, { stage: 'perdu' }]);
  assert.equal(counts.signe, 1);
  assert.equal(counts.contact, 1);
  assert.equal(counts.perdu, 1);
});

// ── funnel ──────────────────────────────────────────────────────────────────

test('the funnel counts sessions at each step and shows where they are lost', () => {
  const events = [
    view('a', -1), view('b', -1), view('c', -1), view('d', -1),
    event('section_view', 'a', -1, { section: 'villas' }),
    event('section_view', 'b', -1, { section: 'villas' }),
    event('section_view', 'c', -1, { section: 'villas' }),
    event('form_open', 'a', -1),
    event('form_open', 'b', -1),
    event('form_start', 'a', -1),
    event('form_submit', 'a', -1),
  ];
  const leads = [lead({ createdAt: at(-1), stage: 'signe' })];
  const steps = funnel(leads, events, { now: NOW });

  assert.deepEqual(steps.map((s) => s.value), [4, 3, 2, 1, 1, 1, 1, 1]);
  assert.equal(steps[0].shareOfPrevious, null, 'the first step has nothing above it');
  assert.equal(steps[1].shareOfPrevious, 75);
  assert.equal(steps[1].dropOff, 1);
  assert.equal(steps[2].shareOfTotal, 50);
});

test('the last funnel steps come from the CRM, not from the browser', () => {
  const leads = [
    lead({ createdAt: at(-1), stage: 'rdv' }),
    lead({ createdAt: at(-1), stage: 'livre' }),
    lead({ createdAt: at(-1), stage: 'perdu' }),
  ];
  const steps = funnel(leads, [], { now: NOW });
  const byLabel = Object.fromEntries(steps.map((s) => [s.label, s]));

  assert.equal(byLabel['Prospects enregistrés'].value, 3);
  assert.equal(byLabel['Rendez-vous planifiés'].value, 2, 'the lost lead is excluded');
  assert.equal(byLabel['Contrats signés'].value, 1);
  assert.equal(byLabel['Contrats signés'].source, 'CRM');
});

test('an empty funnel reports zeroes without dividing by zero', () => {
  const steps = funnel([], [], { now: NOW });
  assert.ok(steps.every((s) => s.value === 0));
  assert.ok(steps.every((s) => s.shareOfTotal === null));
});

// ── marketing ───────────────────────────────────────────────────────────────

test('acquisition is counted per session, not per page view', () => {
  const events = [
    view('a', -1, { source: 'TikTok' }),
    view('a', -1, { source: 'TikTok' }),
    view('b', -1, { source: 'Google' }),
  ];
  const m = marketing([], events, { now: NOW });
  assert.deepEqual(m.bySource, { TikTok: 1, Google: 1 });
  assert.equal(m.sessions, 2);
  assert.equal(m.pageViews, 3);
});

test('the visitor country is approximated from the timezone', () => {
  assert.equal(countryFromTimezone('Africa/Porto-Novo'), 'Bénin');
  assert.equal(countryFromTimezone('Europe/Paris'), 'France');
  assert.equal(countryFromTimezone('Antarctica/Troll'), '', 'an unlisted zone is not guessed at');

  const m = marketing([], [view('a', -1, { tz: 'Africa/Porto-Novo' }), view('b', -1, { tz: 'Antarctica/Troll' })], { now: NOW });
  assert.deepEqual(m.byCountryVisitors, { Bénin: 1 });
  assert.deepEqual(m.unresolvedTimezones, { 'Antarctica/Troll': 1 }, 'the unknown zone is reported, not dropped');
});

test('hours and weekdays are bucketed in Benin local time', () => {
  // 23:30 UTC is 00:30 the next day in Benin.
  const events = [{ at: '2026-03-14T23:30:00.000Z', name: 'page_view', sid: 'a' }];
  const m = marketing([], events, { now: NOW });
  assert.equal(m.byHour['00h'], 1);
  assert.equal(m.byWeekday.Dimanche, 1, '15 March 2026 is a Sunday');
});

test('every hour of the day is present, so the chart has no gaps', () => {
  const m = marketing([], [], { now: NOW });
  assert.equal(Object.keys(m.byHour).length, 24);
  assert.equal(Object.keys(m.byWeekday).length, 7);
});

test('the bounce rate counts sessions that did nothing but load the page', () => {
  const events = [
    view('a', -1), // bounced
    view('b', -1),
    event('scroll', 'b', -1, { percent_scrolled: 50 }),
    view('c', -1),
    event('cta_click', 'c', -1, { label: 'Prendre rendez-vous' }),
  ];
  const m = marketing([], events, { now: NOW });
  assert.equal(m.bounceRate, 33.3);
});

test('a browser version is dropped from the breakdown, the brand is not', () => {
  const events = [view('a', -1, { browser: 'Chrome 131' }), view('b', -1, { browser: 'Chrome 130' })];
  assert.deepEqual(marketing([], events, { now: NOW }).byBrowser, { Chrome: 2 });
});

test('CTA labels and WhatsApp positions are ranked', () => {
  const events = [
    event('cta_click', 'a', -1, { label: 'Prendre rendez-vous' }),
    event('cta_click', 'b', -1, { label: 'Prendre rendez-vous' }),
    event('cta_click', 'c', -1, { label: 'Découvrir les villas' }),
    event('whatsapp_click', 'a', -1, { location: 'bouton_flottant' }),
  ];
  const m = marketing([], events, { now: NOW });
  assert.deepEqual(m.byCta, { 'Prendre rendez-vous': 2, 'Découvrir les villas': 1 });
  assert.equal(Object.keys(m.byCta)[0], 'Prendre rendez-vous', 'ranked, biggest first');
  assert.deepEqual(m.byWhatsapp, { bouton_flottant: 1 });
});

test('the period window excludes older traffic', () => {
  const events = [view('a', -3), view('b', -40)];
  assert.equal(marketing([], events, { days: 30, now: NOW }).sessions, 1);
  assert.equal(marketing([], events, { days: 90, now: NOW }).sessions, 2);
});

// ── real time ───────────────────────────────────────────────────────────────

test('the live view lists one row per session, newest first', () => {
  const events = [
    { at: new Date(NOW - 120_000).toISOString(), name: 'page_view', sid: 'aaaaaaaa-1', path: '/', device: 'Mobile', browser: 'Safari 17', source: 'TikTok', tz: 'Africa/Porto-Novo' },
    { at: new Date(NOW - 30_000).toISOString(), name: 'scroll', sid: 'aaaaaaaa-1' },
    { at: new Date(NOW - 10_000).toISOString(), name: 'page_view', sid: 'bbbbbbbb-2', path: '/', device: 'Ordinateur' },
    { at: new Date(NOW - 30 * 60_000).toISOString(), name: 'page_view', sid: 'cccccccc-3' },
  ];
  const live = realtime(events, { now: NOW });

  assert.equal(live.visitors.length, 2, 'the half-hour-old session is gone');
  assert.equal(live.visitors[0].ref, 'bbbbbbbb');
  assert.equal(live.visitors[1].country, 'Bénin');
  assert.equal(live.visitors[1].device, 'Mobile', 'context from the first event carries forward');
  assert.equal(live.visitors[1].secondsOnSite, 90);
  assert.equal(live.visitors[1].lastEvent, 'scroll');
});

test('the live view never exposes the full session id', () => {
  const events = [{ at: new Date(NOW).toISOString(), name: 'page_view', sid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }];
  const [visitor] = realtime(events, { now: NOW }).visitors;
  assert.equal(visitor.ref.length, 8);
  assert.equal(visitor.sid, undefined);
});

// ── heatmap ─────────────────────────────────────────────────────────────────

test('clicks are aggregated into a grid with a relative intensity', () => {
  const events = [
    event('click', 'a', -1, { x: 2, y: 1, label: 'Prendre rendez-vous' }),
    event('click', 'b', -1, { x: 3, y: 1, label: 'Prendre rendez-vous' }),
    event('click', 'c', -1, { x: 97, y: 99, label: 'Footer' }),
  ];
  const h = heatmap(events, { now: NOW });

  assert.equal(h.total, 3);
  assert.equal(h.max, 2);
  const hot = h.cells.find((c) => c.column === 0 && c.row === 0);
  assert.equal(hot.count, 2, 'the two clicks under 5 % share one cell');
  assert.equal(hot.intensity, 1);

  const corner = h.cells.find((c) => c.column === 19 && c.row === 39);
  assert.equal(corner.count, 1);
  assert.equal(corner.intensity, 0.5);
  assert.deepEqual(h.byElement, { 'Prendre rendez-vous': 2, Footer: 1 });
});

test('a click outside the page bounds is clamped, not dropped', () => {
  const h = heatmap([event('click', 'a', -1, { x: 140, y: -20 })], { now: NOW });
  assert.equal(h.total, 1);
  assert.equal(h.cells[0].column, 19);
  assert.equal(h.cells[0].row, 0);
});

test('scroll reach shows the share of sessions that saw each depth', () => {
  const events = [
    view('a', -1), view('b', -1), view('c', -1), view('d', -1),
    event('scroll', 'a', -1, { percent_scrolled: 25 }),
    event('scroll', 'a', -1, { percent_scrolled: 90 }),
    event('scroll', 'b', -1, { percent_scrolled: 25 }),
    event('scroll', 'b', -1, { percent_scrolled: 50 }),
  ];
  const h = heatmap(events, { now: NOW });
  assert.equal(h.sessions, 4);
  assert.equal(h.scrollReach[25], 50, 'a and b of four sessions');
  assert.equal(h.scrollReach[50], 50, 'a reached 90, so it also reached 50');
  assert.equal(h.scrollReach[90], 25, 'only a');
});

test('with no traffic the scroll reach is blank rather than 0 %', () => {
  assert.equal(heatmap([], { now: NOW }).scrollReach[25], null);
});

// ── Core Web Vitals ─────────────────────────────────────────────────────────

test('each vital reports its 75th percentile and Google’s rating', () => {
  const events = [
    event('web_vital', 'a', -1, { metric: 'LCP', value: 1000 }),
    event('web_vital', 'b', -1, { metric: 'LCP', value: 1500 }),
    event('web_vital', 'c', -1, { metric: 'LCP', value: 2000 }),
    event('web_vital', 'd', -1, { metric: 'LCP', value: 9000 }),
  ];
  const lcp = webVitals(events, { now: NOW }).find((v) => v.metric === 'LCP');

  assert.equal(lcp.samples, 4);
  // The 75th percentile, not the average: one slow visit must not dominate.
  assert.equal(lcp.p75, 2000);
  assert.equal(lcp.rating, 'good');
});

test('a slow page is rated poor, a middling one needs improvement', () => {
  const poor = webVitals([event('web_vital', 'a', -1, { metric: 'LCP', value: 6000 })], { now: NOW });
  assert.equal(poor.find((v) => v.metric === 'LCP').rating, 'poor');

  const middling = webVitals([event('web_vital', 'a', -1, { metric: 'INP', value: 320 })], { now: NOW });
  assert.equal(middling.find((v) => v.metric === 'INP').rating, 'needs-improvement');
});

test('a vital nobody has measured reports null, not a made-up value', () => {
  const vitals = webVitals([], { now: NOW });
  assert.equal(vitals.length, 5);
  assert.ok(vitals.every((v) => v.p75 === null && v.rating === null && v.samples === 0));
});

test('CLS keeps its decimals, milliseconds are rounded', () => {
  const events = [
    event('web_vital', 'a', -1, { metric: 'CLS', value: 0.0847 }),
    event('web_vital', 'a', -1, { metric: 'FCP', value: 1234.56 }),
  ];
  const vitals = webVitals(events, { now: NOW });
  assert.equal(vitals.find((v) => v.metric === 'CLS').p75, 0.085);
  assert.equal(vitals.find((v) => v.metric === 'FCP').p75, 1235);
});
