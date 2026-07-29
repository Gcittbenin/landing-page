/**
 * Integration tests for the HTTP server, as the hosting runtime exercises it.
 *
 * A real process is spawned on an ephemeral port, so these cover what unit
 * tests cannot: PORT handling, static serving, compression negotiation, cache
 * headers, conditional requests, and the proxy-IP behaviour the rate limiter
 * depends on behind LWS's Apache.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 39_517;
const BASE = `http://127.0.0.1:${PORT}`;

let child;

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'production',
      MIN_FILL_MS: '0',
      RATE_LIMIT_MAX: '2',
      RATE_LIMIT_WINDOW_MS: '60000',
      // No Meta or email credentials: every channel is skipped, so the
      // endpoint answers 200 without making a single outbound call.
      META_WHATSAPP_TOKEN: '',
      EMAIL_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for the listening banner rather than a fixed sleep.
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 15_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('GCITT landing page')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[server.test] ${chunk}`));
    child.once('exit', (code) => reject(new Error(`server exited early with code ${code}`)));
  });
  await started;
});

test.after(async () => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
});

const get = (path, headers = {}) => fetch(BASE + path, { headers, redirect: 'manual' });

// ── PORT ────────────────────────────────────────────────────────────────────

test('the server honours process.env.PORT rather than a fixed port', async () => {
  // Reaching it at all on an ephemeral port proves PORT was read; the source
  // must not contain a hard-coded listen port either.
  const res = await get('/');
  assert.equal(res.status, 200);

  const source = readFileSync(root + 'server.js', 'utf8');
  assert.match(source, /process\.env\.PORT/);
  assert.doesNotMatch(source, /listen\(\s*\d{2,5}\s*[,)]/, 'server.js listens on a literal port');
});

// ── Static serving on the same origin as the API ────────────────────────────

test('serves the landing page at /', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const body = await res.text();
  assert.ok(body.includes('<title>Villas à vendre au Bénin'));
});

test('serves assets, uploads and vendor files with the right content types', async () => {
  const cases = [
    ['/assets/fonts.css', /text\/css/],
    ['/assets/responsive.css', /text\/css/],
    ['/assets/tracking.js', /javascript/],
    ['/assets/og-image.jpg', /image\/jpeg/],
    ['/assets/fonts/newsreader-normal-latin.woff2', /font\/woff2/],
    ['/vendor/react.production.min.js', /javascript/],
    ['/vendor/react-dom.production.min.js', /javascript/],
    ['/support.js', /javascript/],
    ['/uploads/Image%20COEUR-JOIE/HEVIE%20CJ%20.jpg', /image\/jpeg/],
    ['/uploads/bethel-f4.png', /image\/png/],
    ['/favicon.ico', /image\/x-icon/],
    ['/robots.txt', /text\/plain/],
    ['/sitemap.xml', /application\/xml/],
    ['/site.webmanifest', /application\/manifest\+json/],
  ];
  for (const [path, type] of cases) {
    const res = await get(path);
    assert.equal(res.status, 200, `${path} returned ${res.status}`);
    assert.match(res.headers.get('content-type'), type, `wrong type for ${path}`);
  }
});

test('the API and the page share one origin', async () => {
  const page = await get('/');
  const api = await fetch(`${BASE}/api/lead`, { method: 'POST' });
  assert.equal(page.status, 200);
  // Same host and port; POST is routed to the handler, not the static tree.
  assert.notEqual(api.status, 404);
});

// ── Compression ─────────────────────────────────────────────────────────────

test('text responses are compressed, and images are left alone', async () => {
  const html = await get('/', { 'Accept-Encoding': 'br, gzip' });
  assert.equal(html.headers.get('content-encoding'), 'br');
  assert.equal(html.headers.get('vary'), 'Accept-Encoding');

  const gzipOnly = await get('/support.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(gzipOnly.headers.get('content-encoding'), 'gzip');

  const plain = await get('/support.js', { 'Accept-Encoding': 'identity' });
  assert.equal(plain.headers.get('content-encoding'), null);

  // Already-compressed formats gain nothing and cost CPU.
  const jpeg = await get('/assets/og-image.jpg', { 'Accept-Encoding': 'br, gzip' });
  assert.equal(jpeg.headers.get('content-encoding'), null);
});

test('compression actually shrinks the payload', async () => {
  // fetch() transparently decompresses, so the decoded body is the same size
  // either way — Content-Length is what was actually sent over the wire.
  const plain = await get('/support.js', { 'Accept-Encoding': 'identity' });
  const brotli = await get('/support.js', { 'Accept-Encoding': 'br' });

  const plainSize = Number(plain.headers.get('content-length'));
  const brSize = Number(brotli.headers.get('content-length'));
  assert.ok(plainSize > 0 && brSize > 0, 'no Content-Length to compare');
  assert.ok(brSize < plainSize / 2, `brotli ${brSize} vs plain ${plainSize}`);

  // The decoded content must of course still be identical.
  assert.equal((await brotli.arrayBuffer()).byteLength, plainSize);
});

// ── Caching ─────────────────────────────────────────────────────────────────

test('cache lifetimes match the asset kind', async () => {
  const immutable = await get('/assets/fonts.css');
  assert.match(immutable.headers.get('cache-control'), /max-age=31536000, immutable/);

  const upload = await get('/uploads/bethel-f4.png');
  assert.match(upload.headers.get('cache-control'), /immutable/);

  const vendor = await get('/vendor/react.production.min.js');
  assert.match(vendor.headers.get('cache-control'), /immutable/);

  // The page must revalidate or edits never reach returning visitors.
  const page = await get('/');
  assert.match(page.headers.get('cache-control'), /must-revalidate/);

  const api = await fetch(`${BASE}/api/lead`, { method: 'POST' });
  assert.equal(api.headers.get('cache-control'), 'no-store');
});

test('conditional requests get a 304', async () => {
  const first = await get('/support.js');
  const etag = first.headers.get('etag');
  assert.ok(etag, 'no ETag issued');

  const second = await get('/support.js', { 'If-None-Match': etag });
  assert.equal(second.status, 304);
  assert.equal((await second.arrayBuffer()).byteLength, 0);
});

// ── Security ────────────────────────────────────────────────────────────────

test('security headers are present on every response', async () => {
  for (const path of ['/', '/assets/fonts.css', '/missing-page']) {
    const res = await get(path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(res.headers.get('referrer-policy'), /strict-origin/);
  }
});

test('hidden files, traversal and malformed URLs are refused', async () => {
  for (const path of ['/.env', '/.git/config', '/.gitignore']) {
    assert.equal((await get(path)).status, 403, `${path} should be forbidden`);
  }
  assert.equal((await get('/%2e%2e%2f%2e%2e%2fetc%2fpasswd')).status, 403);
  assert.equal((await get('/%zz')).status, 403);
  assert.equal((await get('/nope.txt')).status, 404);
});

test('static routes reject anything other than GET and HEAD', async () => {
  const res = await fetch(`${BASE}/`, { method: 'DELETE' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET, HEAD');
});

test('HEAD returns the headers without a body', async () => {
  const res = await fetch(`${BASE}/robots.txt`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

// ── The lead endpoint, end to end through the real server ───────────────────

const lead = (extra = {}) => ({
  name: 'Awa Diallo',
  email: 'awa@example.com',
  phone: '0167212128',
  villa: 'Villa Fenou (F4)',
  ...extra,
});

const postLead = (body, headers = {}) =>
  fetch(`${BASE}/api/lead`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('POST /api/lead accepts a valid submission', async () => {
  const res = await postLead(lead(), { 'X-Forwarded-For': '203.0.113.200' });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  // Nothing is configured in this test process, so every channel is skipped.
  assert.deepEqual(Object.keys(json.delivered).sort(), ['confirmation', 'crm', 'email', 'whatsapp']);
});

test('GET /api/lead is rejected', async () => {
  const res = await get('/api/lead');
  assert.equal(res.status, 405);
});

test('an oversized body is rejected before parsing', async () => {
  const res = await postLead(lead({ message: 'x'.repeat(40_000) }), {
    'X-Forwarded-For': '203.0.113.201',
  });
  assert.equal(res.status, 413);
});

test('a cross-origin submission is rejected', async () => {
  const res = await postLead(lead(), {
    Origin: 'https://evil.example',
    'X-Forwarded-For': '203.0.113.202',
  });
  assert.equal(res.status, 403);
});

// ── Proxy-aware rate limiting ───────────────────────────────────────────────
//
// The reason TRUST_PROXY exists. Behind LWS's Apache every request arrives
// from 127.0.0.1, so without reading X-Forwarded-For all visitors would share
// one bucket and a single spammer would lock out every prospect.

test('visitors behind the same proxy are rate-limited independently', async () => {
  const A = '198.51.100.10';
  const B = '198.51.100.11';

  assert.equal((await postLead(lead(), { 'X-Forwarded-For': A })).status, 200);
  assert.equal((await postLead(lead(), { 'X-Forwarded-For': A })).status, 200);

  const blocked = await postLead(lead(), { 'X-Forwarded-For': A });
  assert.equal(blocked.status, 429, 'the third request from A should be limited');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);

  // B shares the proxy but must not inherit A's exhausted quota.
  assert.equal(
    (await postLead(lead(), { 'X-Forwarded-For': B })).status,
    200,
    'a different visitor must not be blocked by A',
  );
});

test('the leftmost X-Forwarded-For entry identifies the client', async () => {
  const res = await postLead(lead(), { 'X-Forwarded-For': '198.51.100.20, 10.0.0.1, 127.0.0.1' });
  assert.equal(res.status, 200);
});
