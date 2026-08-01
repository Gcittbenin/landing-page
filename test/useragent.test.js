import test from 'node:test';
import assert from 'node:assert/strict';

import { parseUserAgent } from '../lib/useragent.js';

const pick = ({ device, browser, os }) => ({ device, browser, os });

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  edge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  samsung:
    'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  ipad:
    'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  opera:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0',
  facebookCrawler: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  headless:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

test('identifies the desktop browsers', () => {
  assert.deepEqual(pick(parseUserAgent(UA.chromeMac)), {
    device: 'Ordinateur',
    browser: 'Chrome 131',
    os: 'macOS 10.15',
  });
  assert.deepEqual(pick(parseUserAgent(UA.chromeWindows)), {
    device: 'Ordinateur',
    browser: 'Chrome 130',
    os: 'Windows 10/11',
  });
  assert.deepEqual(pick(parseUserAgent(UA.firefox)), {
    device: 'Ordinateur',
    browser: 'Firefox 130',
    os: 'Linux',
  });
});

test('brands that impersonate Chrome are not reported as Chrome', () => {
  // Edge, Opera and Samsung Internet all carry "Chrome/…" in their UA string.
  assert.equal(parseUserAgent(UA.edge).browser, 'Edge 130');
  assert.equal(parseUserAgent(UA.opera).browser, 'Opera 114');
  assert.equal(parseUserAgent(UA.samsung).browser, 'Samsung Internet 23');
});

test('Chrome is not reported as Safari', () => {
  // Every Chromium UA ends with "Safari/537.36".
  assert.match(parseUserAgent(UA.chromeMac).browser, /^Chrome/);
  assert.equal(parseUserAgent(UA.safariIphone).browser, 'Safari 17');
});

test('separates mobiles, tablets and desktops', () => {
  assert.equal(parseUserAgent(UA.safariIphone).device, 'Mobile');
  assert.equal(parseUserAgent(UA.chromeAndroid).device, 'Mobile');
  // An Android tablet's UA contains "Android" but not "Mobile".
  assert.equal(parseUserAgent(UA.androidTablet).device, 'Tablette');
  assert.equal(parseUserAgent(UA.ipad).device, 'Tablette');
  assert.equal(parseUserAgent(UA.chromeMac).device, 'Ordinateur');
});

test('reads the mobile operating systems', () => {
  assert.equal(parseUserAgent(UA.safariIphone).os, 'iOS 17.5');
  assert.equal(parseUserAgent(UA.chromeAndroid).os, 'Android 14');
});

test('flags crawlers so they never look like prospects', () => {
  for (const ua of [UA.facebookCrawler, UA.googlebot, UA.headless]) {
    const parsed = parseUserAgent(ua);
    assert.equal(parsed.bot, true, ua);
    assert.equal(parsed.device, 'Robot');
  }
  assert.equal(parseUserAgent(UA.chromeMac).bot, false);
});

test('a headless browser is named, not mistaken for Safari', () => {
  // "HeadlessChrome/…" has no word boundary before "Chrome", so a \bChrome\/
  // rule misses it and the UA falls through to the generic Safari pattern.
  assert.equal(parseUserAgent(UA.headless).browser, 'Chrome (headless) 131');
});

test('an unknown or missing user agent degrades to empty, never to a guess', () => {
  assert.deepEqual(parseUserAgent(''), { device: '', browser: '', os: '', bot: false, userAgent: '' });
  assert.deepEqual(parseUserAgent(null), { device: '', browser: '', os: '', bot: false, userAgent: '' });
  assert.equal(parseUserAgent(undefined).device, '');

  const odd = parseUserAgent('SomethingEntirelyNew/1.0');
  assert.equal(odd.browser, '');
  assert.equal(odd.os, '');
  assert.equal(odd.device, 'Ordinateur', 'the device still degrades to the safe default');
});

test('a hostile user agent is truncated, not stored whole', () => {
  const parsed = parseUserAgent('x'.repeat(10_000));
  assert.equal(parsed.userAgent.length, 400);
});
