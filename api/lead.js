/**
 * Vercel serverless adapter for the lead endpoint.
 *
 * All the logic lives in lib/handler.js — this file only translates between
 * Vercel's req/res objects and the plain request/response shape the handler
 * speaks.
 */

import { handleLead } from '../lib/handler.js';

export default async function handler(req, res) {
  // Vercel parses JSON bodies automatically when Content-Type says so; the
  // handler accepts either a parsed object or a raw string.
  const result = await handleLead({
    method: req.method,
    headers: req.headers,
    body: req.body,
  });

  for (const [name, value] of Object.entries(result.headers)) {
    res.setHeader(name, value);
  }
  // A lead endpoint must never be cached, by the browser or by the edge.
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
}
