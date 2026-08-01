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
 *   scroll           25/50/75/90 % reached          { percent_scrolled }
 *
 * Every event is also POSTed to /api/event, our own collector, which is what
 * feeds the conversion rate on the /admin dashboard. See sendBeacon below.
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

  // ── Framed? Then this is a preview, not a visit ───────────────────────────
  //
  // The /admin heatmap renders the real page in an iframe underneath the click
  // grid, so the grid sits on something recognisable. Without this guard every
  // opening of that tab would file a page view, a set of Core Web Vitals and a
  // scroll depth — the dashboard would be inflating the very numbers it shows.
  //
  // The landing page is never legitimately framed, so the check is safe. A
  // cross-origin frame throws on `window.top`, which is also a frame.
  var framed;
  try {
    framed = window.top !== window.self;
  } catch (e) {
    framed = true;
  }

  if (framed) {
    // The page component calls these; give it inert versions rather than
    // letting it hit an undefined function.
    window.gcittTrack = function () {};
    window.gcittSessionId = function () { return ''; };
    window.gcittAttribution = { source: 'Direct', detail: '', utm: {} };
    return;
  }

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

  // ── Session-replay heatmaps, if one is configured ─────────────────────────
  //
  // Our own event log already feeds a click heatmap and a scroll-reach chart
  // in /admin. These are for what we deliberately do not collect ourselves:
  // session replay and rage-click detection. Neither loads unless an ID is
  // set, so the page is byte-for-byte identical without them.

  if (cfg.clarity) {
    /* eslint-disable */
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', cfg.clarity);
    /* eslint-enable */
  }

  if (cfg.hotjar) {
    /* eslint-disable */
    (function (h, o, t, j, a, r) {
      h.hj = h.hj || function () { (h.hj.q = h.hj.q || []).push(arguments); };
      h._hjSettings = { hjid: Number(cfg.hotjar), hjsv: 6 };
      a = o.getElementsByTagName('head')[0];
      r = o.createElement('script'); r.async = 1;
      r.src = t + h._hjSettings.hjid + j + h._hjSettings.hjsv;
      a.appendChild(r);
    })(window, document, 'https://static.hotjar.com/c/hotjar-', '.js?sv=');
    /* eslint-enable */
  }

  // GA4 recommended name → Meta Pixel standard event. Anything not listed is
  // sent to Meta as a custom event via trackCustom.
  var META_STANDARD = {
    generate_lead: 'Lead',
    form_start: 'InitiateCheckout',
    contact: 'Contact',
    whatsapp_click: 'Contact',
  };

  // Sent to GA4 and the dataLayer but not to the Pixel: scroll milestones are
  // volume without signal for ad optimisation, and they burn Pixel event quota.
  var GA_ONLY = { scroll: true };

  // ── First-party copy ──────────────────────────────────────────────────────
  //
  // GA4 and the Pixel are both blocked by ad blockers and both need a Google
  // or Meta account to read. A copy on our own server is what lets the /admin
  // dashboard state a conversion rate at all — and it is the only one that
  // survives a prospect who blocks third-party tags.
  //
  // The endpoint answers 204 whatever happens, so nothing here can surface as
  // an error on the page. Parameters the server does not recognise are
  // dropped there, not here: the allow-list lives in one place.

  var BEACON_URL = '/api/event';
  var SESSION_KEY = 'gcitt_sid';

  /** A random id kept for one browser session. Never sent anywhere else. */
  function sessionId() {
    try {
      var existing = window.sessionStorage.getItem(SESSION_KEY);
      if (existing) return existing;
      var fresh =
        window.crypto && window.crypto.randomUUID
          ? window.crypto.randomUUID()
          : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
      window.sessionStorage.setItem(SESSION_KEY, fresh);
      return fresh;
    } catch (e) {
      // Private browsing: the visit is still counted, just not de-duplicated.
      return '';
    }
  }

  function sendBeacon(name, data) {
    var payload = JSON.stringify(
      Object.assign({ name: name, sid: sessionId(), path: window.location.pathname }, data),
    );
    try {
      // sendBeacon survives the page being closed, which fetch() does not.
      if (navigator.sendBeacon) {
        navigator.sendBeacon(BEACON_URL, new Blob([payload], { type: 'application/json' }));
        return;
      }
      fetch(BEACON_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(function () {});
    } catch (e) {
      /* analytics must never break the page */
    }
  }

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

    if (cfg.metaPixel && typeof window.fbq === 'function' && !GA_ONLY[name]) {
      var standard = META_STANDARD[name];
      if (standard) window.fbq('track', standard, data);
      else window.fbq('trackCustom', name, data);
    }

    sendBeacon(name, data);
  };

  // The page_view is sent further down, once loadAttribution() has run: the
  // source is the one field on it that cannot be recovered afterwards.

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

  var CLICK_ID_PARAMS = [
    ['gclid', 'google'],
    ['gbraid', 'google'],
    ['wbraid', 'google'],
    ['fbclid', 'facebook'],
    ['ttclid', 'tiktok'],
    ['li_fat_id', 'linkedin'],
    ['msclkid', 'bing'],
  ];

  function detectAttribution() {
    var params = new URLSearchParams(window.location.search);
    var get = function (name) {
      return (params.get(name) || '').trim();
    };

    var utmSource = get('utm_source').toLowerCase();
    var utmMedium = get('utm_medium');
    var utmCampaign = get('utm_campaign');
    var utmContent = get('utm_content');
    var utmTerm = get('utm_term');

    // Ad-platform click IDs are proof of paid traffic even with no UTM tags,
    // and they are what the ad account needs for offline conversion import.
    var clickId = '';
    for (var c = 0; c < CLICK_ID_PARAMS.length; c++) {
      var value = get(CLICK_ID_PARAMS[c][0]);
      if (value) {
        clickId = CLICK_ID_PARAMS[c][0] + '=' + value;
        if (!utmSource) utmSource = CLICK_ID_PARAMS[c][1];
        break;
      }
    }

    var utm = {
      utmSource: utmSource,
      utmMedium: utmMedium,
      utmCampaign: utmCampaign,
      utmContent: utmContent,
      utmTerm: utmTerm,
      clickId: clickId,
    };

    if (utmSource) {
      var detail = [];
      if (utmMedium) detail.push('utm_medium=' + utmMedium);
      if (utmCampaign) detail.push('utm_campaign=' + utmCampaign);
      if (utmContent) detail.push('utm_content=' + utmContent);
      if (clickId) detail.push(clickId.split('=')[0]);
      return {
        source: UTM_LABELS[utmSource] || utmSource.charAt(0).toUpperCase() + utmSource.slice(1),
        detail: detail.join(' · ') || 'utm_source=' + utmSource,
        utm: utm,
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
          if (REFERRERS[i][0].test(host)) {
            return { source: REFERRERS[i][1], detail: host, utm: utm };
          }
        }
        return { source: 'Référent', detail: host, utm: utm };
      }
    }

    return { source: 'Direct', detail: '', utm: utm };
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


  // ── Session context and the page view ─────────────────────────────────────
  //
  // Sent once the attribution is known, because `source` is the one field on
  // a page_view that cannot be reconstructed after the fact. Everything else
  // the server derives itself from the request.

  function sessionContext() {
    var tz = '';
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (e) {
      tz = '';
    }
    return {
      source: (window.gcittAttribution || {}).source || '',
      tz: tz,
      lang: navigator.language || ''
    };
  }

  // The form sends this with the lead, which is what lets the prospect's
  // fiche show the pages and clicks that preceded the submission.
  window.gcittSessionId = sessionId;

  sendBeacon('page_view', sessionContext());

  // ── Sections seen ─────────────────────────────────────────────────────────
  //
  // What the funnel is built on: not "did they load the page" but "did they
  // ever get as far as the villas". IntersectionObserver rather than scroll
  // arithmetic, so the browser does the work off the main thread.

  (function trackSections() {
    if (!('IntersectionObserver' in window)) return;

    var seen = {};
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var id = entry.target.id;
          if (!id || seen[id]) return;
          seen[id] = true;
          sendBeacon('section_view', { section: id });
          if (id === 'rendez-vous') sendBeacon('form_open', { section: id });
          observer.unobserve(entry.target);
        });
      },
      // A quarter of the section on screen counts as reached: a section that
      // merely brushes the viewport edge during a fast scroll does not.
      { threshold: 0.25 }
    );

    function observeAll() {
      var sections = document.querySelectorAll('section[id], [data-section]');
      for (var i = 0; i < sections.length; i++) observer.observe(sections[i]);
    }

    // The page is rendered by a runtime, so the sections do not exist at parse
    // time. One deferred pass picks them up without polling.
    if (document.readyState === 'complete') setTimeout(observeAll, 400);
    else window.addEventListener('load', function () { setTimeout(observeAll, 400); });
  })();

  // ── Clicks ────────────────────────────────────────────────────────────────
  //
  // Two things at once: a readable label for the CTA ranking, and a position
  // for the heatmap. The position is a percentage of the document, never a
  // pixel count — a percentage is the only form that is comparable between a
  // phone and a 27-inch screen, and it is what an overlay needs anyway.

  (function trackClicks() {
    /** The nearest thing a person would call "what I clicked". */
    function describe(target) {
      var node = target;
      for (var depth = 0; node && depth < 5; depth++, node = node.parentElement) {
        if (node.getAttribute && node.getAttribute('data-track')) return node.getAttribute('data-track');
        var tag = (node.tagName || '').toLowerCase();
        if (tag === 'a' || tag === 'button') {
          var text = (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim();
          return text.slice(0, 60) || tag;
        }
      }
      return '';
    }

    /** Is this a call to action, or just a click somewhere on the page? */
    function isCta(target) {
      var node = target;
      for (var depth = 0; node && depth < 5; depth++, node = node.parentElement) {
        if (!node.classList) continue;
        if (node.classList.contains('gc-btn') || node.classList.contains('gc-fab')) return true;
      }
      return false;
    }

    document.addEventListener(
      'click',
      function (event) {
        var doc = document.documentElement;
        var height = doc.scrollHeight || 1;
        var width = doc.clientWidth || 1;
        var label = describe(event.target);

        sendBeacon('click', {
          label: label,
          x: Math.round((event.clientX / width) * 1000) / 10,
          y: Math.round((((window.scrollY || doc.scrollTop) + event.clientY) / height) * 1000) / 10
        });

        // A CTA click is the one the marketing report ranks, so it is a
        // separate event rather than a filter over every click on the page.
        if (label && isCta(event.target)) sendBeacon('cta_click', { label: label });
      },
      { passive: true, capture: true }
    );
  })();

  // ── Engaged time ──────────────────────────────────────────────────────────
  //
  // Only time the tab was actually visible is counted. A page left open in a
  // background tab for an hour is not an hour of interest, and counting it
  // would make the average meaningless.

  (function trackEngagement() {
    var visibleSince = document.visibilityState === 'visible' ? Date.now() : 0;
    var accumulated = 0;
    var sent = false;

    function total() {
      return Math.round((accumulated + (visibleSince ? Date.now() - visibleSince : 0)) / 1000);
    }

    function flush() {
      if (sent) return;
      var seconds = total();
      // Under two seconds is a bounce or a bot, not a visit worth averaging.
      if (seconds < 2 || seconds > 3600) return;
      sent = true;
      sendBeacon('engagement', { seconds: seconds });
    }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        visibleSince = Date.now();
        return;
      }
      if (visibleSince) accumulated += Date.now() - visibleSince;
      visibleSince = 0;
      // Hiding the tab is the last reliable moment on mobile: iOS often never
      // fires pagehide or unload at all.
      flush();
    });
    window.addEventListener('pagehide', flush);
  })();

  // ── Core Web Vitals ───────────────────────────────────────────────────────
  //
  // Field data from real visits, measured with PerformanceObserver — no
  // library. This is what Google's own Core Web Vitals report is built from,
  // and unlike a Lighthouse score it reflects the phones and connections our
  // prospects actually have.

  (function trackVitals() {
    if (!('PerformanceObserver' in window)) return;

    function report(metric, value) {
      if (!Number.isFinite(value)) return;
      sendBeacon('web_vital', { metric: metric, value: Math.round(value * 1000) / 1000 });
    }

    function observe(type, handler, options) {
      try {
        var observer = new PerformanceObserver(function (list) {
          list.getEntries().forEach(handler);
        });
        observer.observe(Object.assign({ type: type, buffered: true }, options || {}));
        return observer;
      } catch (e) {
        // An unsupported entry type throws; the other metrics still report.
        return null;
      }
    }

    // TTFB and FCP are single values, available early.
    observe('navigation', function (entry) {
      report('TTFB', entry.responseStart);
    });
    observe('paint', function (entry) {
      if (entry.name === 'first-contentful-paint') report('FCP', entry.startTime);
    });

    // LCP and CLS keep changing until the page is left, so only the final
    // value is worth sending.
    var lcp = 0;
    observe('largest-contentful-paint', function (entry) {
      lcp = entry.startTime;
    });

    var cls = 0;
    observe('layout-shift', function (entry) {
      // Shifts the visitor caused by interacting are not penalised by Google.
      if (!entry.hadRecentInput) cls += entry.value;
    });

    // INP: the worst interaction delay the visitor actually felt.
    var inp = 0;
    observe('event', function (entry) {
      if (entry.duration > inp) inp = entry.duration;
    }, { durationThreshold: 40 });

    var flushed = false;
    function flushVitals() {
      if (flushed) return;
      flushed = true;
      if (lcp) report('LCP', lcp);
      if (cls) report('CLS', cls);
      if (inp) report('INP', inp);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushVitals();
    });
    window.addEventListener('pagehide', flushVitals);
  })();

  /**
   * Scroll depth.
   *
   * GA4's enhanced measurement only reports a single 90% milestone. Four
   * thresholds give a usable drop-off curve for a long landing page, which is
   * what tells you whether prospects ever reach the form.
   *
   * Each threshold fires at most once per page view. The listener is passive
   * and rAF-throttled so it never blocks scrolling, and it detaches itself
   * once the deepest threshold is reached.
   */
  (function trackScrollDepth() {
    var thresholds = [25, 50, 75, 90];
    var fired = {};
    var ticking = false;

    function measure() {
      ticking = false;
      var doc = document.documentElement;
      var scrollable = doc.scrollHeight - window.innerHeight;
      if (scrollable <= 0) return;

      var percent = ((window.scrollY || doc.scrollTop) / scrollable) * 100;
      for (var i = 0; i < thresholds.length; i++) {
        var t = thresholds[i];
        if (percent >= t && !fired[t]) {
          fired[t] = true;
          // GA4's reserved parameter name for its own scroll event.
          window.gcittTrack('scroll', { percent_scrolled: t });
        }
      }
      if (fired[90]) window.removeEventListener('scroll', onScroll);
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(measure);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    // A short page, or one restored mid-scroll, may already be past a
    // threshold before the first scroll event.
    measure();
  })();
})();
