import test from 'node:test';
import assert from 'node:assert/strict';

import { handleLead, _resetLimiter } from '../lib/handler.js';
import { createRateLimiter, clientIp } from '../lib/ratelimit.js';

const ENV = {
  META_WHATSAPP_TOKEN: 'tok',
  META_PHONE_NUMBER_ID: '123',
  EMAIL_API_KEY: 'key',
  EMAIL_DESTINATION: 'commercial@gcitt.com',
  MIN_FILL_MS: '0',
};

const validBody = {
  name: 'Awa Diallo',
  email: 'awa@example.com',
  phone: '+33612345678',
  villa: 'Villa Kafui (Duplex)',
  message: 'Bonjour',
};

/** Succeeds for every outbound call. */
const okFetch = () => {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ messages: [{ id: 'm' }], id: 'e' }),
    };
  };
  fn.calls = calls;
  return fn;
};

const post = (body, extra = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(extra.headers ?? {}) },
  body,
  ip: extra.ip ?? '203.0.113.1',
});

test.beforeEach(() => _resetLimiter());

test('rejects any method other than POST', async () => {
  const res = await handleLead({ method: 'GET', headers: {}, body: null }, { env: ENV, fetchImpl: okFetch() });
  assert.equal(res.status, 405);
  assert.equal(res.headers.Allow, 'POST');
});

test('accepts a valid lead and reports per-channel delivery', async () => {
  const fetchImpl = okFetch();
  const res = await handleLead(post(validBody), { env: ENV, fetchImpl });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.delivered.whatsapp, true);
  assert.equal(res.body.delivered.email, true);
  assert.equal(res.body.delivered.crm, false, 'no CRM configured');

  const hosts = fetchImpl.calls.map((c) => new URL(c.url).host);
  assert.ok(hosts.includes('graph.facebook.com'));
  assert.ok(hosts.includes('api.resend.com'));
});

test('parses a raw JSON string body', async () => {
  const res = await handleLead(post(JSON.stringify(validBody)), { env: ENV, fetchImpl: okFetch() });
  assert.equal(res.status, 200);
});

test('rejects malformed JSON', async () => {
  const res = await handleLead(post('{not json'), { env: ENV, fetchImpl: okFetch() });
  assert.equal(res.status, 400);
});

test('rejects a non-object body', async () => {
  for (const body of ['[1,2]', 'null', '"x"']) {
    const res = await handleLead(post(body), { env: ENV, fetchImpl: okFetch() });
    assert.equal(res.status, 400, `body ${body} should be rejected`);
    _resetLimiter();
  }
});

test('rejects an oversized body', async () => {
  const res = await handleLead(post(JSON.stringify({ ...validBody, message: 'x'.repeat(20_000) })), {
    env: ENV,
    fetchImpl: okFetch(),
  });
  assert.equal(res.status, 413);
});

test('returns field-level errors on invalid input', async () => {
  const res = await handleLead(post({ name: 'A', email: 'bad', phone: '1' }), { env: ENV, fetchImpl: okFetch() });
  assert.equal(res.status, 422);
  assert.equal(res.body.ok, false);
  assert.deepEqual(Object.keys(res.body.fields).sort(), ['email', 'name', 'phone']);
});

test('a tripped honeypot looks like success but sends nothing', async () => {
  const fetchImpl = okFetch();
  const res = await handleLead(post({ ...validBody, website: 'http://spam.example' }), { env: ENV, fetchImpl });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(fetchImpl.calls.length, 0, 'no notification should be sent for a bot');
});

test('a too-fast submission looks like success but sends nothing', async () => {
  const fetchImpl = okFetch();
  const now = 1_000_000;
  const res = await handleLead(post({ ...validBody, formOpenedAt: now - 200 }), {
    env: { ...ENV, MIN_FILL_MS: '3000' },
    fetchImpl,
    now,
  });

  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls.length, 0);
});

test('rate-limits a single IP and sets Retry-After', async () => {
  const env = { ...ENV, RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' };
  const fetchImpl = okFetch();

  for (let i = 0; i < 3; i++) {
    const res = await handleLead(post(validBody), { env, fetchImpl });
    assert.equal(res.status, 200, `request ${i + 1} should pass`);
  }

  const blocked = await handleLead(post(validBody), { env, fetchImpl });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['Retry-After']) > 0);
});

test('the rate limit is per IP', async () => {
  const env = { ...ENV, RATE_LIMIT_MAX: '1' };
  const fetchImpl = okFetch();

  assert.equal((await handleLead(post(validBody, { ip: '1.1.1.1' }), { env, fetchImpl })).status, 200);
  assert.equal((await handleLead(post(validBody, { ip: '1.1.1.1' }), { env, fetchImpl })).status, 429);
  assert.equal((await handleLead(post(validBody, { ip: '2.2.2.2' }), { env, fetchImpl })).status, 200);
});

test('a cross-origin post is rejected when it does not match the host', async () => {
  const res = await handleLead(
    post(validBody, { headers: { origin: 'https://evil.example', host: 'gcitt.com' } }),
    { env: ENV, fetchImpl: okFetch() },
  );
  assert.equal(res.status, 403);
});

test('a same-origin post is accepted', async () => {
  const res = await handleLead(
    post(validBody, { headers: { origin: 'https://gcitt.com', host: 'gcitt.com' } }),
    { env: ENV, fetchImpl: okFetch() },
  );
  assert.equal(res.status, 200);
});

test('ALLOWED_ORIGINS overrides the host check', async () => {
  const env = { ...ENV, ALLOWED_ORIGINS: 'https://www.gcitt.com' };
  const ok = await handleLead(
    post(validBody, { headers: { origin: 'https://www.gcitt.com', host: 'api.gcitt.com' } }),
    { env, fetchImpl: okFetch() },
  );
  assert.equal(ok.status, 200);

  _resetLimiter();
  const denied = await handleLead(
    post(validBody, { headers: { origin: 'https://other.example', host: 'api.gcitt.com' } }),
    { env, fetchImpl: okFetch() },
  );
  assert.equal(denied.status, 403);
});

test('a configured channel failing returns 502 with a WhatsApp fallback message', async () => {
  const failing = async () => ({
    ok: false,
    status: 500,
    headers: { get: () => null },
    text: async () => JSON.stringify({ error: { message: 'boom' } }),
  });
  const res = await handleLead(post(validBody), { env: ENV, fetchImpl: failing });

  assert.equal(res.status, 502);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /WhatsApp/);
  assert.equal(res.body.delivered.whatsapp, false);
});

test('an unconfigured channel is not treated as a failure', async () => {
  // No Meta or email credentials at all: nothing is configured, so nothing
  // failed, and the prospect still gets a success.
  const res = await handleLead(post(validBody), { env: { MIN_FILL_MS: '0' }, fetchImpl: okFetch() });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('responses never leak configuration', async () => {
  const res = await handleLead(post(validBody), { env: ENV, fetchImpl: okFetch() });
  const serialised = JSON.stringify(res.body);
  assert.ok(!serialised.includes('tok'));
  assert.ok(!serialised.includes('key'));
});

// ── rate limiter unit ───────────────────────────────────────────────────────

test('the limiter window slides', () => {
  const limiter = createRateLimiter({ max: 2, windowMs: 1000 });
  assert.equal(limiter.check('a', 0).allowed, true);
  assert.equal(limiter.check('a', 100).allowed, true);
  assert.equal(limiter.check('a', 200).allowed, false);
  // Once the window has passed, the caller is allowed again.
  assert.equal(limiter.check('a', 1300).allowed, true);
});

test('the limiter reports remaining attempts and a retry delay', () => {
  const limiter = createRateLimiter({ max: 2, windowMs: 1000 });
  assert.equal(limiter.check('a', 0).remaining, 1);
  assert.equal(limiter.check('a', 0).remaining, 0);
  assert.equal(limiter.check('a', 500).retryAfterMs, 500);
});

test('the limiter bounds its memory under key rotation', () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
  for (let i = 0; i < 10_050; i++) limiter.check(`ip-${i}`, i);
  assert.ok(limiter.store.size <= 10_000, `store grew to ${limiter.store.size}`);
});

test('clientIp prefers the leftmost X-Forwarded-For entry', () => {
  assert.equal(clientIp({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }), '203.0.113.9');
  assert.equal(clientIp({ 'x-real-ip': '198.51.100.4' }), '198.51.100.4');
  assert.equal(clientIp({}), 'unknown');
});
