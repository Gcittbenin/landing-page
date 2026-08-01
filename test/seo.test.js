/**
 * Guards on the served HTML and the static SEO files.
 *
 * These assert against the raw file on disk, not a rendered DOM, because that
 * is exactly what a social crawler sees: Facebook, LinkedIn, WhatsApp and X do
 * not execute JavaScript, so anything they need must survive without it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(root + 'GCITT - Cite Coeur Joie.dc.html', 'utf8');
const SITE = 'https://nos-villas.gcitt.com';

// The served <head>, which is what a non-JS crawler can rely on. Anchored on
// the closing tag: the file's own comments mention <x-dc> and <head>, so
// searching for an opening tag would match prose.
const staticHead = html.slice(0, html.indexOf('</head>'));

test('the document declares French', () => {
  assert.match(html, /<html lang="fr">/);
});

test('the title is the agreed one and sits in the static head', () => {
  assert.ok(
    staticHead.includes(
      '<title>Villas à vendre au Bénin | Cités Cœur Joie &amp; Bethel - GCITT BENIN</title>',
    ),
    'title missing or not in the static head',
  );
});

test('the meta description is the agreed one and is within Google’s display limit', () => {
  const m = /<meta name="description" content="([^"]+)">/.exec(staticHead);
  assert.ok(m, 'no meta description');
  assert.ok(m[1].startsWith('Villas F4 et duplex modernes au Bénin'));
  assert.ok(m[1].includes('réservation sécurisée'));
  // Google cuts the snippet around 160 characters; a longer one is wasted.
  assert.ok(m[1].length >= 140 && m[1].length <= 160, `${m[1].length} caractères`);
});

test('canonical and robots are present', () => {
  assert.ok(staticHead.includes(`<link rel="canonical" href="${SITE}/">`));
  assert.match(staticHead, /<meta name="robots" content="index, follow/);
});

test('Open Graph is complete enough for a link preview', () => {
  for (const prop of [
    'og:type', 'og:site_name', 'og:locale', 'og:url', 'og:title',
    'og:description', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt',
  ]) {
    assert.ok(staticHead.includes(`property="${prop}"`), `missing ${prop}`);
  }
  // Facebook and LinkedIn require an absolute image URL.
  assert.ok(staticHead.includes(`content="${SITE}/assets/og-image.jpg"`));
});

test('Twitter Card uses the large summary format', () => {
  assert.ok(staticHead.includes('name="twitter:card" content="summary_large_image"'));
  for (const name of ['twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:alt']) {
    assert.ok(staticHead.includes(`name="${name}"`), `missing ${name}`);
  }
});

test('favicons and manifest are declared and the files exist', () => {
  for (const file of [
    'favicon.ico',
    'assets/favicon-16.png',
    'assets/favicon-32.png',
    'assets/apple-touch-icon.png',
    'assets/icon-192.png',
    'assets/icon-512.png',
    'assets/og-image.jpg',
    'site.webmanifest',
    'robots.txt',
    'sitemap.xml',
  ]) {
    assert.ok(existsSync(root + file), `missing file: ${file}`);
  }
  assert.ok(staticHead.includes('rel="apple-touch-icon"'));
  assert.ok(staticHead.includes('rel="manifest"'));
});

test('the OG image is exactly 1200x630, as the meta tags claim', () => {
  // JPEG SOF0/SOF2 marker carries the real dimensions.
  const buf = readFileSync(root + 'assets/og-image.jpg');
  let i = 2;
  let dims = null;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      dims = { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      break;
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  assert.deepEqual(dims, { w: 1200, h: 630 });
});

test('structured data is valid JSON and covers the required types', () => {
  const blocks = [...html.matchAll(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
  )];
  assert.ok(blocks.length > 0, 'no JSON-LD found');

  const types = new Set();
  for (const [, body] of blocks) {
    const parsed = JSON.parse(body); // throws if the JSON-LD is malformed
    for (const node of parsed['@graph'] ?? [parsed]) types.add(node['@type']);
  }

  for (const required of [
    'Organization', 'WebSite', 'WebPage', 'BreadcrumbList', 'RealEstateAgent', 'FAQPage',
  ]) {
    assert.ok(types.has(required), `missing @type ${required}`);
  }
});

test('JSON-LD prices match the prices shown on the page', () => {
  const [, body] = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  const graph = JSON.parse(body)['@graph'];
  const offers = graph.find((n) => n['@type'] === 'RealEstateAgent').makesOffer;
  const byName = Object.fromEntries(offers.map((o) => [o.name, o.price]));

  // Google penalises structured data that contradicts the visible page.
  assert.equal(byName['Villa Fenou (F4) — Cité Cœur Joie'], '49000000');
  assert.equal(byName['Villa Kafui (Duplex) — Cité Cœur Joie'], '80000000');
  assert.equal(byName['Villa Bethel (F4) — Cité Béthel'], '39000000');
  assert.equal(byName['Villa Bethel (Duplex) — Cité Béthel'], '72000000');

  for (const price of ['49 000 000 FCFA', '80 000 000 FCFA', '39 000 000 FCFA', '72 000 000 FCFA']) {
    assert.ok(html.includes(price), `price ${price} not visible on the page`);
  }
});

test('robots.txt allows crawling and points at the sitemap', () => {
  const robots = readFileSync(root + 'robots.txt', 'utf8');
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /^Allow: \/$/m);
  assert.ok(robots.includes(`Sitemap: ${SITE}/sitemap.xml`));
  assert.ok(robots.includes('Disallow: /api/'), 'the lead endpoint should not be indexed');
});

test('sitemap.xml is well-formed and lists the canonical URL', () => {
  const sitemap = readFileSync(root + 'sitemap.xml', 'utf8');
  assert.ok(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(sitemap.includes(`<loc>${SITE}/</loc>`));
  // Tag balance, as a cheap well-formedness check.
  const open = (sitemap.match(/<url>/g) || []).length;
  const close = (sitemap.match(/<\/url>/g) || []).length;
  assert.equal(open, close);
  assert.ok(open >= 1);
});

test('the manifest is valid JSON with icons that exist', () => {
  const manifest = JSON.parse(readFileSync(root + 'site.webmanifest', 'utf8'));
  assert.equal(manifest.lang, 'fr-FR');
  assert.ok(manifest.icons.length >= 2);
  for (const icon of manifest.icons) {
    assert.ok(existsSync(root + icon.src.replace(/^\//, '')), `missing icon ${icon.src}`);
  }
});

test('below-the-fold images are lazy and above-the-fold ones are not', () => {
  const imgs = html.match(/<img [^>]*>/g) ?? [];
  assert.ok(imgs.length >= 11, `only ${imgs.length} images`);

  // The hero is now a slider: its imagery is data-driven, and the priority /
  // loading hints are decided per slide in renderVals. The template tag must
  // therefore bind them rather than hard-code them.
  const heroTag = imgs.find((t) => t.includes('{{ img.src }}'));
  assert.ok(heroTag, 'hero slider image tag missing');
  assert.match(heroTag, /fetchpriority="\{\{ img\.priority \}\}"/);
  assert.match(heroTag, /loading="\{\{ img\.loading \}\}"/);

  const closing = imgs.find((t) => t.includes('FENOU NUIT (2).jpg'));
  assert.ok(closing.includes('loading="lazy"'));

  // The nav logo is the only eager static image; everything else defers.
  const statics = imgs.filter((t) => !t.includes('{{'));
  const eager = statics.filter((t) => !t.includes('loading="lazy"'));
  assert.equal(eager.length, 1, 'only the nav logo should load eagerly');

  // Intrinsic dimensions on every image, so nothing reflows as it loads.
  for (const tag of imgs) {
    assert.match(tag, /width="\d+"/, `no width on ${tag.slice(0, 70)}`);
    assert.match(tag, /height="\d+"/, `no height on ${tag.slice(0, 70)}`);
  }
});

test('no API key or token is referenced anywhere in the frontend', () => {
  const frontend = [
    'GCITT - Cite Coeur Joie.dc.html',
    'assets/tracking.js',
    'assets/tracking-config.js',
  ].map((f) => readFileSync(root + f, 'utf8')).join('\n');

  for (const forbidden of [
    'META_WHATSAPP_TOKEN', 'META_PHONE_NUMBER_ID', 'META_BUSINESS_ACCOUNT_ID',
    'EMAIL_API_KEY', 'CRM_WEBHOOK_TOKEN', 'process.env', 'graph.facebook.com',
    'api.resend.com', 'api.sendgrid.com',
  ]) {
    assert.ok(!frontend.includes(forbidden), `frontend references ${forbidden}`);
  }
});

// ── Responsive layout ───────────────────────────────────────────────────────

test('a responsive stylesheet is linked from the static head', () => {
  assert.ok(staticHead.includes('href="/assets/responsive.css"'));
  assert.ok(existsSync(root + 'assets/responsive.css'));
});

test('the responsive stylesheet never clips the root element', () => {
  const css = readFileSync(root + 'assets/responsive.css', 'utf8');
  // `overflow-x: hidden` on html collapses the root to viewport height and
  // kills vertical scrolling outright. It must not come back.
  assert.doesNotMatch(
    css.replace(/\/\*[\s\S]*?\*\//g, ''),
    /\bhtml\b[^{]*\{[^}]*overflow(-x)?\s*:\s*hidden/,
  );
});

test('the responsive stylesheet covers phone and tablet', () => {
  const css = readFileSync(root + 'assets/responsive.css', 'utf8');
  assert.match(css, /@media \(max-width: 1024px\)/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /prefers-reduced-motion/);
});

test('fonts are self-hosted, not fetched from Google', () => {
  assert.ok(!html.includes('fonts.googleapis.com'), 'still linking Google Fonts');
  assert.ok(!html.includes('fonts.gstatic.com'));
  assert.ok(staticHead.includes('href="/assets/fonts.css"'));

  const css = readFileSync(root + 'assets/fonts.css', 'utf8');
  const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 4);
  for (const u of urls) {
    assert.ok(u.startsWith('/assets/fonts/'), `${u} is not self-hosted`);
    assert.ok(existsSync(root + u.replace(/^\//, '')), `missing font file ${u}`);
  }
  // French needs œ (U+0152-0153), which lives in the latin subset.
  assert.ok(css.includes('U+0152-0153'));
});

test('React is self-hosted rather than pulled from unpkg', () => {
  assert.ok(existsSync(root + 'vendor/react.production.min.js'));
  assert.ok(existsSync(root + 'vendor/react-dom.production.min.js'));
  // The override must name the exact URLs support.js asks for, or it silently
  // falls back to the CDN.
  assert.ok(html.includes("'https://unpkg.com/react@18.3.1/umd/react.production.min.js': '/vendor/react.production.min.js'"));
  assert.ok(html.includes("'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js': '/vendor/react-dom.production.min.js'"));

  const support = readFileSync(root + 'support.js', 'utf8');
  assert.ok(support.includes('window.__resources'), 'support.js no longer honours the override');
});

test('large photos ship a small variant for phones', () => {
  const withSrcset = (html.match(/<img [^>]*srcset=[^>]*>/g) ?? []).length;
  assert.ok(withSrcset >= 8, `only ${withSrcset} images have srcset`);

  for (const rel of [
    'uploads/Image COEUR-JOIE/HEVIE CJ -sm.jpg',
    'uploads/Image COEUR-JOIE/FENOU HEVIEE-sm.jpg',
    'uploads/Image COEUR-JOIE/KAFUI NUIT-sm.jpg',
    'uploads/Image COEUR-JOIE/GCITT-sm.jpg',
    'uploads/bethel-f4-sm.png',
    'uploads/bethel-duplex-sm.png',
  ]) {
    assert.ok(existsSync(root + rel), `missing small variant: ${rel}`);
  }
});

test('the LCP image is preloaded with the same srcset the tag uses', () => {
  assert.match(staticHead, /<link rel="preload" as="image"[^>]*imagesrcset=/);
  assert.ok(staticHead.includes('fetchpriority="high"'));
});
