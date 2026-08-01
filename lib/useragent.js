/**
 * User-agent parsing, kept deliberately small.
 *
 * The sales team needs to know roughly what a prospect was using — a phone or
 * a desktop, Chrome or Safari — not an exhaustive device database. A full UA
 * library is a dependency, a monthly update treadmill and a licence to audit,
 * for a field that only ever appears as a line in an email.
 *
 * So: order matters (Edge claims to be Chrome, Chrome claims to be Safari),
 * everything unknown degrades to an empty string rather than a wrong guess,
 * and the caller decides whether to show the row at all.
 */

/** Longest UA we will look at. Beyond this it is an attack, not a browser. */
const MAX_UA = 400;

// Checked in order; the first match wins. Later entries are the ones that
// impersonate earlier ones, so the specific brand must come first.
const BROWSERS = [
  [/\bEdg(?:e|A|iOS)?\/([\d.]+)/, 'Edge'],
  [/\bOPR\/([\d.]+)/, 'Opera'],
  [/\bOpera[ /]([\d.]+)/, 'Opera'],
  [/\bSamsungBrowser\/([\d.]+)/, 'Samsung Internet'],
  [/\bYaBrowser\/([\d.]+)/, 'Yandex'],
  [/\bUCBrowser\/([\d.]+)/, 'UC Browser'],
  [/\bFxiOS\/([\d.]+)/, 'Firefox'],
  [/\bFirefox\/([\d.]+)/, 'Firefox'],
  [/\bCriOS\/([\d.]+)/, 'Chrome'],
  [/\bChrome\/([\d.]+)/, 'Chrome'],
  [/\bVersion\/([\d.]+).*\bSafari\//, 'Safari'],
  [/\bSafari\/([\d.]+)/, 'Safari'],
];

const SYSTEMS = [
  [/\bWindows NT 10\.0/, 'Windows 10/11'],
  [/\bWindows NT 6\.3/, 'Windows 8.1'],
  [/\bWindows NT 6\.1/, 'Windows 7'],
  [/\bWindows(?: NT)?/, 'Windows'],
  [/\bAndroid ([\d.]+)/, 'Android'],
  [/\bAndroid/, 'Android'],
  // iPadOS 13+ reports as "Macintosh"; the touch check below corrects it.
  [/\b(?:iPhone|iPad|iPod).*?OS ([\d_]+)/, 'iOS'],
  [/\b(?:iPhone|iPad|iPod)/, 'iOS'],
  [/\bMac OS X ([\d_.]+)/, 'macOS'],
  [/\bMacintosh/, 'macOS'],
  [/\b(?:CrOS)/, 'ChromeOS'],
  [/\b(?:Ubuntu|Linux)/, 'Linux'],
];

/** Known crawler tokens. Not exhaustive — a heuristic for the event log. */
const BOT_RE = /\b(bot|crawler|spider|crawl|slurp|facebookexternalhit|preview|monitor|headless|curl|wget|python-requests|axios|okhttp)\b/i;

/**
 * @param {string} raw
 * @returns {{device: string, browser: string, os: string, bot: boolean, userAgent: string}}
 */
export function parseUserAgent(raw) {
  const ua = typeof raw === 'string' ? raw.slice(0, MAX_UA).trim() : '';
  if (!ua) return { device: '', browser: '', os: '', bot: false, userAgent: '' };

  let browser = '';
  for (const [re, name] of BROWSERS) {
    const m = re.exec(ua);
    if (!m) continue;
    // Only the major version: "Chrome 131" ages better in a CRM export than
    // "Chrome 131.0.6778.86", and it is all anyone reads.
    const major = (m[1] || '').split(/[._]/)[0];
    browser = major ? `${name} ${major}` : name;
    break;
  }

  let os = '';
  for (const [re, name] of SYSTEMS) {
    const m = re.exec(ua);
    if (!m) continue;
    const version = (m[1] || '').replace(/_/g, '.');
    // Windows names already carry their version; the others take the captured one.
    os = version && !name.includes(' ') ? `${name} ${version.split('.').slice(0, 2).join('.')}` : name;
    break;
  }

  // Tablet before mobile: an Android tablet's UA contains "Android" but not
  // "Mobile", and an iPad reports as a desktop Mac unless we look for touch.
  let device = 'Ordinateur';
  if (/\biPad\b/i.test(ua) || (/\bAndroid\b/i.test(ua) && !/\bMobile\b/i.test(ua))) {
    device = 'Tablette';
  } else if (/\bMacintosh\b/.test(ua) && /\bMobile\b/i.test(ua)) {
    device = 'Tablette'; // iPadOS 13+ desktop-mode
  } else if (/\b(?:iPhone|iPod|Mobile|Android|Windows Phone|IEMobile)\b/i.test(ua)) {
    device = 'Mobile';
  }

  const bot = BOT_RE.test(ua);
  if (bot) device = 'Robot';

  return { device, browser, os, bot, userAgent: ua };
}
