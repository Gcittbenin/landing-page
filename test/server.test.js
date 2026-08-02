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
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 39_517;
const BASE = `http://127.0.0.1:${PORT}`;

// The spawned server writes real prospect records; keep them out of the repo.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'gcitt-server-'));

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
      DATA_DIR,
      ADMIN_PASSWORD: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for the readiness marker rather than a fixed sleep.
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 15_000);
    let seen = '';
    child.stdout.on('data', (chunk) => {
      seen += String(chunk);
      if (seen.includes('PRÊT')) {
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
  try {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  } finally {
    rmSync(DATA_DIR, { recursive: true, force: true });
  }
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
  firstName: 'Awa',
  lastName: 'Diallo',
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
  assert.deepEqual(
    Object.keys(json.delivered).sort(),
    ['confirmation', 'crm', 'email', 'stored', 'whatsapp'],
  );
  assert.equal(json.delivered.stored, true, 'the lead reaches the local store');
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

// ── Health check ────────────────────────────────────────────────────────────

test('/healthz reports liveness without leaking configuration', async () => {
  const res = await get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.node, /^v\d+/);
  assert.equal(typeof body.uptimeSeconds, 'number');

  // It must not become an inventory of the host's secrets.
  const serialised = JSON.stringify(body).toLowerCase();
  for (const forbidden of ['token', 'key', 'secret', 'whatsapp', 'email', 'password']) {
    assert.ok(!serialised.includes(forbidden), `/healthz mentions "${forbidden}"`);
  }
});

// ── Passenger entry points ──────────────────────────────────────────────────
//
// cPanel/Passenger loads the startup file with require(). These guard the two
// shims that make a failed boot legible, since the panel itself shows only
// "Erreur".

test('the startup log records a successful boot', async () => {
  const log = readFileSync(root + 'logs/startup.log', 'utf8');
  assert.match(log, /modules chargés/);
  assert.match(log, /en écoute sur/);
  assert.match(log, /PRÊT/);
  // Booleans only — never a value.
  assert.doesNotMatch(log, /META_WHATSAPP_TOKEN=\S/);
  assert.doesNotMatch(log, /EMAIL_API_KEY=\S/);
});

test('app.js and app.cjs exist and carry no external dependency', () => {
  for (const file of ['app.js', 'app.cjs']) {
    const src = readFileSync(root + file, 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const spec of [...imports, ...requires]) {
      assert.ok(
        spec.startsWith('node:') || spec.startsWith('.'),
        `${file} pulls in an external module: ${spec}`,
      );
    }
    // A static import of a project file would be hoisted above the crash
    // handlers, which is exactly what these shims exist to avoid.
    assert.doesNotMatch(src, /^\s*import\s+[^(]*from\s+['"]\.\/(server|lib)/m,
      `${file} statically imports project code`);
  }
});

test('package.json declares what the host needs', () => {
  const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'));
  assert.equal(pkg.scripts.start, 'node server.js');
  assert.equal(pkg.main, 'server.js');
  assert.ok(pkg.engines.node);
  // Zero dependencies is the property that makes npm install unable to fail.
  assert.deepEqual(pkg.dependencies, {});
});

test('source directories are protected from direct HTTP access', () => {
  for (const dir of ['lib', 'api', 'test', 'docs']) {
    const ht = readFileSync(`${root}${dir}/.htaccess`, 'utf8');
    assert.match(ht, /Require all denied/);
    assert.match(ht, /Deny from all/);
  }
});

// ── Public allow-list ───────────────────────────────────────────────────────
//
// The application root sits inside public_html on cPanel and Passenger routes
// every request to this process, so the server is the only thing standing
// between the internet and its own source.

test('server-side source is not downloadable', async () => {
  const hidden = [
    '/lib/config.js', '/lib/handler.js', '/lib/whatsapp.js', '/lib/email.js',
    '/lib/validate.js', '/lib/startup.js', '/api/lead.js', '/test/server.test.js',
    '/lib/store.js', '/lib/auth.js', '/lib/admin.js', '/lib/admin.html', '/lib/admin-login.html',
    '/package.json', '/package-lock.json', '/server.js', '/app.js', '/app.cjs',
    '/vercel.json', '/README.md', '/DEPLOIEMENT_LWS.md', '/docs/WHATSAPP.md',
  ];
  for (const path of hidden) {
    const res = await get(path);
    // 404 rather than 403: a 403 would confirm the file is there.
    assert.equal(res.status, 404, `${path} is reachable (${res.status})`);
  }
});

test('leaking lib/ would hand a spammer the anti-spam design', async () => {
  // Regression guard with the reason attached: lib/validate.js names the
  // honeypot field, so serving it defeats the honeypot.
  const res = await get('/lib/validate.js');
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.ok(!body.includes('website'), 'the honeypot field name leaked');
  assert.ok(!body.includes('isHoneypotTripped'));
});

// ── The analytics beacon ────────────────────────────────────────────────────

test('POST /api/event accepts a beacon and answers 204 with no body', async () => {
  const res = await fetch(`${BASE}/api/event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({ name: 'page_view', sid: 'test-session', path: '/' }),
  });
  assert.equal(res.status, 204);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('an unknown event name is still a 204, so nothing is probeable', async () => {
  const res = await fetch(`${BASE}/api/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'admin_login' }),
  });
  assert.equal(res.status, 204);
});

test('GET /api/event is refused', async () => {
  const res = await get('/api/event');
  assert.equal(res.status, 405);
});

// ── The admin area ──────────────────────────────────────────────────────────

test('/healthz says whether the console is switched on', async () => {
  // The one fact you cannot establish from outside: if this says the console
  // is on and the console itself answers 500, the request never reached Node.
  const res = await get('/healthz');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.admin, false, 'no ADMIN_PASSWORD in this test process');
  assert.ok(!JSON.stringify(body).includes('admin/'), 'the path is never disclosed');
});

test('/admin does not exist when no admin password is configured', async () => {
  // The spawned server runs with ADMIN_PASSWORD empty, which is how the site
  // ships. A dashboard nobody meant to deploy is worse than no dashboard.
  for (const path of ['/admin', '/admin/', '/admin/api/leads', '/admin/export.csv']) {
    const res = await get(path);
    assert.equal(res.status, 404, `${path} answered ${res.status}`);
  }
});

test('POST /admin/login is a 404 too, so the area cannot even be probed', async () => {
  const res = await fetch(`${BASE}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x' }),
  });
  assert.equal(res.status, 404);
});

test('everything the page actually needs is still public', async () => {
  const required = [
    '/', '/support.js', '/favicon.ico', '/robots.txt', '/sitemap.xml',
    '/site.webmanifest', '/assets/fonts.css', '/assets/responsive.css',
    '/assets/tracking.js', '/assets/tracking-config.js', '/assets/og-image.jpg',
    '/vendor/react.production.min.js', '/vendor/react-dom.production.min.js',
    '/uploads/bethel-f4.png',
  ];
  for (const path of required) {
    assert.equal((await get(path)).status, 200, `${path} should be public`);
  }
});
