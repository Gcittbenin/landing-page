/**
 * Tracking layer for the GCITT landing page.
 *
 * Loads whichever of GA4 / GTM / Meta Pixel have an ID in tracking-config.js,
 * then exposes one function the page calls for every conversion event:
 *
 *   window.gcittTrack(name, params)
 *
 * Events emitted by the page
 * ──────────────────────────────────────────────────────────────────────────
 *   whatsapp_click   a WhatsApp button was clicked  { location }
 *   form_start       first keystroke in the form    { }
 *   form_submit      submit pressed, request sent   { villa, cite, source }
 *   generate_lead    the API confirmed the lead     { villa, cite, source, value }
 *
 * `generate_lead` is the conversion to optimise campaigns against. It is the
 * GA4 recommended name, and it maps to the Meta Pixel standard event `Lead`.
 *
 * Everything degrades silently: with no IDs configured the calls are no-ops,
 * so the page works identically before and after the tags are set up.
 */
(function () {
  'use strict';

  var cfg = window.GCITT_TRACKING || {};

  // dataLayer must exist before GTM loads, and gtag() pushes onto it.
  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = window.gtag || gtag;

  function injectScript(src) {
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    document.head.appendChild(s);
    return s;
  }

  // ── Google Analytics 4 ────────────────────────────────────────────────────
  if (cfg.ga4) {
    injectScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(cfg.ga4));
    gtag('js', new Date());
    gtag('config', cfg.ga4, { send_page_view: true });
  }

  // ── Google Tag Manager ────────────────────────────────────────────────────
  if (cfg.gtm) {
    window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    injectScript('https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(cfg.gtm));
  }

  // ── Meta Pixel ────────────────────────────────────────────────────────────
  if (cfg.metaPixel) {
    /* eslint-disable */
    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n;
      n.loaded = true;
      n.version = '2.0';
      n.queue = [];
      t = b.createElement(e);
      t.async = true;
      t.src = v;
      s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    window.fbq('init', cfg.metaPixel);
    window.fbq('track', 'PageView');
  }

  // GA4 recommended name → Meta Pixel standard event. Anything not listed is
  // sent to Meta as a custom event via trackCustom.
  var META_STANDARD = {
    generate_lead: 'Lead',
    form_start: 'InitiateCheckout',
    contact: 'Contact',
    whatsapp_click: 'Contact',
  };

  /**
   * Send one event to every configured destination.
   *
   * @param {string} name    event name, GA4 snake_case
   * @param {object} [params] event parameters; undefined values are dropped
   */
  window.gcittTrack = function (name, params) {
    var data = {};
    if (params) {
      for (var key in params) {
        if (Object.prototype.hasOwnProperty.call(params, key) && params[key] != null && params[key] !== '') {
          data[key] = params[key];
        }
      }
    }

    if (cfg.debug) console.info('[gcitt-track]', name, data);

    // GTM / dataLayer — always pushed, so a GTM-only setup still sees
    // everything even with no GA4 or Pixel ID configured here.
    window.dataLayer.push(Object.assign({ event: name }, data));

    if (cfg.ga4 && typeof window.gtag === 'function') {
      window.gtag('event', name, data);
    }

    if (cfg.metaPixel && typeof window.fbq === 'function') {
      var standard = META_STANDARD[name];
      if (standard) window.fbq('track', standard, data);
      else window.fbq('trackCustom', name, data);
    }
  };

  /**
   * Where the visitor came from, for the "source d'acquisition" field.
   *
   * UTM parameters win when present — they are explicit and survive a
   * redirect. Otherwise the referrer host is matched against the channels that
   * matter to GCITT. Persisted in sessionStorage so the attribution is not
   * lost when the prospect navigates within the page before converting.
   */
  var REFERRERS = [
    [/(^|\.)google\./i, 'Google'],
    [/(^|\.)(facebook|fb)\./i, 'Facebook'],
    [/(^|\.)instagram\./i, 'Instagram'],
    [/(^|\.)tiktok\./i, 'TikTok'],
    [/(^|\.)(youtube|youtu\.be)/i, 'YouTube'],
    [/(^|\.)linkedin\./i, 'LinkedIn'],
    [/(^|\.)(bing|yahoo|duckduckgo|ecosia)\./i, 'Autre moteur'],
    [/(^|\.)(whatsapp|wa\.me)/i, 'WhatsApp'],
  ];

  var UTM_LABELS = {
    google: 'Google',
    'google-ads': 'Google',
    adwords: 'Google',
    facebook: 'Facebook',
    fb: 'Facebook',
    meta: 'Facebook',
    instagram: 'Instagram',
    ig: 'Instagram',
    tiktok: 'TikTok',
    youtube: 'YouTube',
    linkedin: 'LinkedIn',
    whatsapp: 'WhatsApp',
    email: 'Email',
    newsletter: 'Email',
  };

  var STORAGE_KEY = 'gcitt_attribution';

  function detectAttribution() {
    var params = new URLSearchParams(window.location.search);
    var utmSource = (params.get('utm_source') || '').toLowerCase().trim();
    var utmMedium = (params.get('utm_medium') || '').trim();
    var utmCampaign = (params.get('utm_campaign') || '').trim();

    // Ad-platform click IDs are proof of paid traffic even with no UTM tags.
    if (!utmSource) {
      if (params.get('gclid')) utmSource = 'google';
      else if (params.get('fbclid')) utmSource = 'facebook';
      else if (params.get('ttclid')) utmSource = 'tiktok';
    }

    if (utmSource) {
      var detail = ['utm_source=' + utmSource];
      if (utmMedium) detail.push('utm_medium=' + utmMedium);
      if (utmCampaign) detail.push('utm_campaign=' + utmCampaign);
      return {
        source: UTM_LABELS[utmSource] || utmSource.charAt(0).toUpperCase() + utmSource.slice(1),
        detail: detail.join(' · '),
      };
    }

    var ref = document.referrer || '';
    if (ref) {
      var host = '';
      try {
        host = new URL(ref).hostname;
      } catch (e) {
        host = '';
      }
      // A referrer from our own domain is internal navigation, not a source.
      if (host && host !== window.location.hostname) {
        for (var i = 0; i < REFERRERS.length; i++) {
          if (REFERRERS[i][0].test(host)) return { source: REFERRERS[i][1], detail: host };
        }
        return { source: 'Référent', detail: host };
      }
    }

    return { source: 'Direct', detail: '' };
  }

  function loadAttribution() {
    var stored = null;
    try {
      stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || 'null');
    } catch (e) {
      stored = null;
    }

    var fresh = detectAttribution();
    // Keep the first non-Direct attribution of the session: a prospect who
    // arrives from TikTok and later reloads the page directly is still a
    // TikTok lead.
    if (stored && stored.source && stored.source !== 'Direct' && fresh.source === 'Direct') {
      return stored;
    }

    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    } catch (e) {
      /* private browsing — attribution just won't persist */
    }
    return fresh;
  }

  window.gcittAttribution = loadAttribution();
})();
