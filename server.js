/**
 * Local development / self-hosted server.
 *
 * Serves the landing page as static files and exposes POST /api/lead through
 * the same handler the Vercel function uses. Dependency-free, node:http only.
 *
 *   node server.js            # http://localhost:3000
 *   PORT=8080 node server.js
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleLead } from './lib/handler.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const INDEX = 'GCITT - Cite Coeur Joie.dc.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function readBody(req, limitBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Resolve a URL path to a file inside ROOT, or null if it escapes ROOT. */
function resolveStatic(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = normalize(decoded === '/' ? INDEX : decoded.replace(/^\/+/, ''));
  if (rel.startsWith('..') || rel.startsWith(sep)) return null;
  return join(ROOT, rel);
}

const server = createServer(async (req, res) => {
  try {
    if (req.url?.split('?')[0] === '/api/lead') {
      let body = '';
      try {
        body = await readBody(req);
      } catch (err) {
        if (err.code === 'TOO_LARGE') {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Requête trop volumineuse.' }));
          return;
        }
        throw err;
      }

      const result = await handleLead({
        method: req.method,
        headers: req.headers,
        body,
        ip: req.socket.remoteAddress,
      });
      res.writeHead(result.status, { ...result.headers, 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result.body));
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }

    const filePath = resolveStatic(req.url ?? '/');
    if (!filePath) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal server error');
  }
});

server.listen(PORT, () => {
  console.log(`GCITT landing page → http://localhost:${PORT}`);
  console.log(`Lead endpoint      → POST http://localhost:${PORT}/api/lead`);
});
