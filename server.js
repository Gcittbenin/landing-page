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

import { handleLead } from './lib/handler.js';
import { clientIp } from './lib/ratelimit.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const INDEX = 'GCITT - Cite Coeur Joie.dc.html';

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
  } catch (err) {
    console.warn('[server] .env present but unreadable:', err.message);
  }
}

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
 * avoids re-reading and re-compressing on every request. Entries are keyed by
 * path and never invalidated: a restart picks up any change, which is what a
 * deploy does anyway.
 */
const fileCache = new Map();

async function loadFile(filePath) {
  const cached = fileCache.get(filePath);
  if (cached) return cached;

  const raw = await readFile(filePath);
  const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  const entry = {
    raw,
    type,
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

/** Resolve a URL path to a file inside ROOT, or null if it escapes ROOT. */
function resolveStatic(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;

  const rel = normalize(decoded === '/' ? INDEX : decoded.replace(/^\/+/, ''));
  if (rel.startsWith('..') || rel.startsWith(sep) || rel.split(sep).includes('..')) return null;

  // .env, .git and friends must never be served, whatever the host config.
  if (rel.split(sep).some((part) => part.startsWith('.'))) return null;

  return join(ROOT, rel);
}

const server = createServer(async (req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0];

  try {
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

    // ── Static files ─────────────────────────────────────────────────────
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS });
      res.end();
      return;
    }

    const filePath = resolveStatic(urlPath);
    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('Forbidden');
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('Not found');
      return;
    }

    const entry = await loadFile(filePath);

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
    console.log(`[server] ${signal} — arrêt en cours`);
    server.close(() => process.exit(0));
    // Do not hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

server.listen(PORT, HOST, () => {
  const where = typeof PORT === 'number' ? `port ${PORT}` : `socket ${PORT}`;
  console.log(`[server] GCITT landing page — ${where} (${process.env.NODE_ENV || 'development'})`);
  console.log(`[server] proxy de confiance : ${TRUST_PROXY ? 'oui' : 'non'}`);
});
