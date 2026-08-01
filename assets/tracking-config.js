/**
 * Marketing tag IDs.
 *
 * These are public identifiers — they ship to the browser by design, so they
 * belong here rather than in the server environment. Fill in the ones you use
 * and leave the rest empty; each tag only loads when its ID is present, so an
 * unconfigured tag costs nothing and makes no network request.
 */
window.GCITT_TRACKING = {
  // Google Analytics 4 — "G-XXXXXXXXXX"
  ga4: '',

  // Google Tag Manager — "GTM-XXXXXXX"
  // If you route GA4 and Meta Pixel through GTM, set this and leave the other
  // two empty to avoid double-counting.
  gtm: '',

  // Meta Pixel — the numeric pixel ID
  metaPixel: '',

  // Microsoft Clarity — the project ID, e.g. "abcd1234ef".
  // The dashboard already draws a click heatmap and a scroll-reach chart from
  // our own event log. Clarity adds session replay and rage-click detection,
  // which we deliberately do not collect ourselves — recording what a visitor
  // does keystroke by keystroke is a different order of data collection, and
  // it should be a conscious decision rather than a default.
  clarity: '',

  // Hotjar — the numeric site ID. Same reasoning as Clarity; set one or the
  // other, not both, or every session is recorded twice.
  hotjar: '',

  // Log every event to the console. Turn on to verify the wiring before the
  // real IDs exist; leave off in production.
  debug: false,
};
