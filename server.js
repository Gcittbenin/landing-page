/**
 * HTTP server — production (LWS / any Node host) and local development.
 *
 * Serves the landing page, its assets and uploads, and exposes POST /api/lead
 * through the same handler the Vercel function uses. One process, one domain,
 * no reverse-proxy configuration required beyond what the host already does.
 *
 * Dependency-free: node:http and node:zlib only.
 *
 *   npm start                 # honours PORT, defaults to 3000
 *   PORT=8080 npm start
 *
 * On LWS the panel supplies PORT and the environment variables; see
 * DEPLOIEMENT_LWS.md.
 *
 * Note on headers: on Vercel, vercel.json applies the caching, compression and
 * security headers. Here Node is the origin, so this file has to apply them
 * itself — the two must be kept in step.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { createHash } from 'node:crypto';

import { handleLead, getStore } from './lib/handler.js';
import { handleAdmin } from './lib/admin.js';
import { handleEvent } from './lib/events.js';
import { loadConfig } from './lib/config.js';
import { clientIp } from './lib/ratelimit.js';
import { logStartup, environmentSummary, describeStartupError, STARTUP_LOG_PATH } from './lib/startup.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const INDEX = 'GCITT - Cite Coeur Joie.dc.html';

// First thing after the imports resolve. If this line never appears in
// logs/startup.log, the failure is in the module graph, not in this file —
// app.js will have recorded which import failed.
logStartup('server.js: modules chargés');

/**
 * Load a .env file when one is present.
 *
 * On LWS the variables come from the panel and no .env exists, so this is a
 * no-op there. It keeps `npm start` working locally without the
 * --env-file flag, which a Passenger-style host will not pass.
 */
if (existsSync(join(ROOT, '.env')) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(join(ROOT, '.env'));
    logStartup('.env chargé depuis la racine de l\'application');
  } catch (err) {
    logStartup(`.env présent mais illisible (ignoré) : ${err.message}`);
  }
} else {
  logStartup('pas de .env — les variables viennent de l\'environnement du processus');
}

// What is and is not configured. Booleans only, never values.
logStartup('environnement', environmentSummary());

/**
 * Passenger and most panels pass a TCP port, but some pass a Unix socket path.
 * A numeric value is used as a port; anything else is handed to listen() as-is.
 */
const RAW_PORT = process.env.PORT ?? '';
const PORT = /^\d+$/.test(String(RAW_PORT).trim()) ? Number(RAW_PORT) : (RAW_PORT || 3000);
const HOST = process.env.HOST || undefined;

/**
 * Whether to believe X-Forwarded-For.
 *
 * On a shared host the app always sits behind Apache/nginx, so the socket
 * address is the proxy's (127.0.0.1) and every visitor would otherwise share
 * one rate-limit bucket — one spammer would lock out every prospect. Set
 * TRUST_PROXY=false only if the process is exposed directly to the internet,
 * where a client could forge the header to dodge the limit.
 */
const TRUST_PROXY = (process.env.TRUST_PROXY ?? 'true').toLowerCase() !== 'false';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.pdf': 'application/pdf',
};

/** Types worth compressing. JPEG, PNG, WOFF2 and ICO are already compressed. */
const COMPRESSIBLE = /^(text\/|application\/(json|xml|manifest\+json)|image\/svg)/;

const YEAR = 31_536_000;

/**
 * Cache-Control per path, mirroring vercel.json.
 *
 * Assets under /uploads, /assets and /vendor are effectively content-addressed
 * — their names change when their contents do — so they get a year. The page
 * itself must revalidate, or edits never reach returning visitors.
 */
function cacheControl(urlPath) {
  if (/^\/(uploads|assets|vendor)\//.test(urlPath)) {
    return `public, max-age=${YEAR}, immutable`;
  }
  if (urlPath === '/favicon.ico') return 'public, max-age=604800';
  if (urlPath === '/support.js') return 'public, max-age=86400';
  if (/^\/(robots\.txt|sitemap\.xml|site\.webmanifest)$/.test(urlPath)) {
    return 'public, max-age=3600';
  }
  return 'public, max-age=0, must-revalidate';
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
};

/**
 * Compressed and hashed file cache.
 *
 * The site is a few dozen small files, so holding the encoded bytes in memory
 * avoids re-reading and re-compressing on every request.
 *
 * Entries are invalidated when the file's mtime or size changes. That matters:
 * the FTP deploy overwrites files under a long-running process, and a cache
 * that only cleared on restart would keep serving the previous version until
 * someone remembered to restart Passenger.
 */
const fileCache = new Map();

async function loadFile(filePath, stamp) {
  const cached = fileCache.get(filePath);
  if (cached && cached.stamp === stamp) return cached;

  const raw = await readFile(filePath);
  const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  const entry = {
    raw,
    type,
    stamp,
    etag: `"${createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"`,
    gzip: null,
    br: null,
  };

  // Below ~1 KB the framing overhead outweighs the saving.
  if (COMPRESSIBLE.test(type) && raw.length > 1024) {
    entry.gzip = gzipSync(raw, { level: 9 });
    entry.br = brotliCompressSync(raw, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    });
  }

  fileCache.set(filePath, entry);
  return entry;
}

function negotiate(acceptEncoding, entry) {
  const accept = String(acceptEncoding || '');
  if (entry.br && /\bbr\b/.test(accept)) return { body: entry.br, encoding: 'br' };
  if (entry.gzip && /\bgzip\b/.test(accept)) return { body: entry.gzip, encoding: 'gzip' };
  return { body: entry.raw, encoding: null };
}

function readBody(req, limitBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];

    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limitBytes) {
        aborted = true;
        // Stop reading, but leave the socket open: the caller still has to
        // write the 413. Destroying here would abort the connection before
        // the client could read the response, which surfaces as an opaque
        // network error instead of a clear status.
        req.pause();
        reject(Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/**
 * What may be served over HTTP.
 *
 * An allow-list, not a deny-list. The application root sits inside the web
 * root on cPanel and Passenger routes *every* request to this process, so
 * without this the server would happily hand out lib/handler.js — which would
 * tell a spammer the honeypot field name and the anti-spam thresholds. No
 * credentials live in the source, but there is no reason to publish it either.
 *
 * Adding a public file means adding it here.
 */
const PUBLIC_DIRS = ['assets', 'uploads', 'vendor'];
const PUBLIC_FILES = new Set([
  INDEX,
  'support.js',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  'site.webmanifest',
]);

function isPublic(rel) {
  const parts = rel.split(sep);
  if (parts.length === 1) return PUBLIC_FILES.has(parts[0]);
  return PUBLIC_DIRS.includes(parts[0]);
}

/**
 * Resolve a URL path to a servable file inside ROOT.
 *
 * @returns {{path: string} | {reject: number}} the file, or the status to send
 */
function resolveStatic(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return { reject: 403 }; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return { reject: 403 };

  const rel = normalize(decoded === '/' ? INDEX : decoded.replace(/^\/+/, ''));

  // Escaping the root is hostile; say so.
  if (rel.startsWith('..') || rel.startsWith(sep) || rel.split(sep).includes('..')) {
    return { reject: 403 };
  }
  // Dotfiles (.env, .git, .htaccess) are never public.
  if (rel.split(sep).some((part) => part.startsWith('.'))) return { reject: 403 };

  // Anything outside the allow-list is reported as absent rather than
  // forbidden: a 403 would confirm the file exists.
  if (!isPublic(rel)) return { reject: 404 };

  return { path: join(ROOT, rel) };
}

const STARTED_AT = Date.now();

/** 1x1 transparent GIF, for the placeholder response above. */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const server = createServer(async (req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0];

  try {
    // ── Health check ─────────────────────────────────────────────────────
    // Lets the host, and you, confirm the process is alive without loading
    // the page. Carries no configuration and no secrets.
    if (urlPath === '/healthz') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...SECURITY_HEADERS,
      });
      res.end(
        JSON.stringify({
          ok: true,
          node: process.version,
          env: process.env.NODE_ENV || 'development',
          uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
        }),
      );
      return;
    }

    // ── Lead endpoint ────────────────────────────────────────────────────
    if (urlPath === '/api/lead') {
      let body = '';
      try {
        body = await readBody(req);
      } catch (err) {
        if (err.code === 'TOO_LARGE') {
          // Close the connection once the response is out, so an oversized
          // upload is cut short rather than drained in full.
          res.writeHead(413, {
            'Content-Type': 'application/json; charset=utf-8',
            Connection: 'close',
            ...SECURITY_HEADERS,
          });
          res.end(JSON.stringify({ ok: false, error: 'Requête trop volumineuse.' }), () => {
            req.destroy();
          });
          return;
        }
        throw err;
      }

      const result = await handleLead({
        method: req.method,
        headers: req.headers,
        body,
        // Behind a proxy the socket address is the proxy's, so the forwarded
        // header is the only way to tell prospects apart.
        ip: TRUST_PROXY
          ? clientIp(req.headers, req.socket.remoteAddress)
          : req.socket.remoteAddress,
      });

      res.writeHead(result.status, {
        ...result.headers,
        ...SECURITY_HEADERS,
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(result.body));
      return;
    }

    // ── Analytics beacon ─────────────────────────────────────────────────
    // Answers 204 whatever happens: a page must never show an error because
    // its analytics call failed. Reads at most 4 KB.
    if (urlPath === '/api/event') {
      let body = '';
      try {
        body = await readBody(req, 4 * 1024);
      } catch (err) {
        if (err.code !== 'TOO_LARGE') throw err;
        req.destroy();
        return;
      }

      const result = await handleEvent(
        {
          method: req.method,
          headers: req.headers,
          body,
          ip: TRUST_PROXY ? clientIp(req.headers, req.socket.remoteAddress) : req.socket.remoteAddress,
        },
        { store: getStore(loadConfig(process.env)) },
      );

      res.writeHead(result.status, { ...result.headers, ...SECURITY_HEADERS });
      res.end();
      return;
    }

    // ── Admin area ───────────────────────────────────────────────────────
    // Answers 404 for everything when ADMIN_PASSWORD is unset, so a site
    // deployed without one has no dashboard at all — see lib/admin.js.
    if (urlPath === '/admin' || urlPath.startsWith('/admin/')) {
      let body = '';
      if (req.method === 'POST' || req.method === 'PATCH') {
        // A restore carries the whole prospect base; everything else is a
        // status change or a comment.
        const limit = urlPath === '/admin/restore' ? 8 * 1024 * 1024 : 64 * 1024;
        try {
          body = await readBody(req, limit);
        } catch (err) {
          if (err.code !== 'TOO_LARGE') throw err;
          res.writeHead(413, {
            'Content-Type': 'application/json; charset=utf-8',
            Connection: 'close',
            ...SECURITY_HEADERS,
          });
          res.end(JSON.stringify({ ok: false, error: 'Requête trop volumineuse.' }), () => req.destroy());
          return;
        }
      }

      const result = await handleAdmin(
        {
          method: req.method,
          path: urlPath,
          query: Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams),
          headers: req.headers,
          body,
          ip: TRUST_PROXY ? clientIp(req.headers, req.socket.remoteAddress) : req.socket.remoteAddress,
        },
        { store: getStore(loadConfig(process.env)) },
      );

      res.writeHead(result.status, { ...result.headers, ...SECURITY_HEADERS });
      res.end(req.method === 'HEAD' ? undefined : result.body);
      return;
    }

    // ── Unhydrated template placeholders ─────────────────────────────────
    // Chromium's preload scanner reads the raw HTML before the runtime binds
    // anything, so it queues the literal `{{ img.src }}` as a URL — at high
    // priority for the hero, since that tag carries fetchpriority. Answering
    // with a 1x1 transparent GIF costs 43 bytes, keeps the console clean and
    // stops the browser racing a request that can never succeed. The runtime
    // overwrites the src a moment later.
    if (urlPath.includes('{{') || urlPath.includes('%7B%7B')) {
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': PIXEL.length,
        'Cache-Control': 'public, max-age=86400',
        ...SECURITY_HEADERS,
      });
      res.end(req.method === 'HEAD' ? undefined : PIXEL);
      return;
    }

    // ── Static files ─────────────────────────────────────────────────────
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS });
      res.end();
      return;
    }

    const resolved = resolveStatic(urlPath);
    if (resolved.reject) {
      res.writeHead(resolved.reject, {
        'Content-Type': 'text/plain; charset=utf-8',
        ...SECURITY_HEADERS,
      });
      res.end(resolved.reject === 403 ? 'Forbidden' : 'Not found');
      return;
    }
    const filePath = resolved.path;

    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('Not found');
      return;
    }

    // mtime + size identifies the version on disk; a deploy changes both.
    const entry = await loadFile(filePath, `${info.mtimeMs}:${info.size}`);

    // Conditional request: nothing to send if the client already has it.
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, {
        ETag: entry.etag,
        'Cache-Control': cacheControl(urlPath),
        ...SECURITY_HEADERS,
      });
      res.end();
      return;
    }

    const { body, encoding } = negotiate(req.headers['accept-encoding'], entry);
    const headers = {
      'Content-Type': entry.type,
      'Content-Length': body.length,
      'Cache-Control': cacheControl(urlPath),
      ETag: entry.etag,
      Vary: 'Accept-Encoding',
      ...SECURITY_HEADERS,
    };
    if (encoding) headers['Content-Encoding'] = encoding;

    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    console.error('[server]', urlPath, err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    }
    res.end('Internal server error');
  }
});

// A single bad request must never take the whole site down with it.
process.on('uncaughtException', (err) => console.error('[server] uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('[server] unhandledRejection', err));

// Passenger and most process managers stop the app with SIGTERM.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logStartup(`${signal} reçu — arrêt en cours`);
    server.close(() => process.exit(0));
    // Do not hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

/**
 * A failure to bind is the most common way this app dies on shared hosting,
 * and the least self-explanatory. Name the cause instead of dumping a stack.
 */
server.on('error', (err) => {
  logStartup(`ÉCHEC de l'écoute sur ${typeof PORT === 'number' ? `le port ${PORT}` : PORT}`);
  logStartup(describeStartupError(err));

  if (err.code === 'EADDRINUSE') {
    logStartup(
      "le port est déjà pris. Sous Passenger l'application est démarrée " +
        'automatiquement : ne la lancez pas une seconde fois à la main.',
    );
  }
  if (err.code === 'EACCES') {
    logStartup(
      "l'hébergement refuse ce port. Ne définissez pas PORT vous-même : " +
        'laissez Passenger fournir le sien.',
    );
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const where = typeof PORT === 'number' ? `port ${PORT}` : `socket ${PORT}`;
  logStartup(`en écoute sur ${where} (${process.env.NODE_ENV || 'development'})`);
  logStartup(`proxy de confiance : ${TRUST_PROXY ? 'oui' : 'non'}`);
  logStartup(`journal de démarrage : ${STARTUP_LOG_PATH}`);
  logStartup('PRÊT — l\'application répond');
});
