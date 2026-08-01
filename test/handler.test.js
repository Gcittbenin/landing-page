import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleLead, _resetLimiter } from '../lib/handler.js';
import { createRateLimiter, clientIp } from '../lib/ratelimit.js';
import { createStore } from '../lib/store.js';

const ENV = {
  META_WHATSAPP_TOKEN: 'tok',
  META_PHONE_NUMBER_ID: '123',
  EMAIL_API_KEY: 'key',
  EMAIL_DESTINATION: 'commercial@gcitt.com',
  MIN_FILL_MS: '0',
  // Off by default here: the persistence test below opts back in with a temp
  // directory, so no other test touches the repository's data/ folder.
  LEAD_STORE: 'false',
};

const validBody = {
  firstName: 'Awa',
  lastName: 'Diallo',
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
  const res = await handleLead(post({ firstName: 'A', email: 'bad', phone: '1' }), { env: ENV, fetchImpl: okFetch() });
  assert.equal(res.status, 422);
  assert.equal(res.body.ok, false);
  assert.deepEqual(Object.keys(res.body.fields).sort(), ['email', 'firstName', 'lastName', 'phone']);
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

test('MIN_FILL_MS=0 really disables the timing check', async () => {
  // Regression guard: `0` used to fall through to the 3000 ms default, so a
  // fast submission was silently dropped as spam — a 200 with nothing sent,
  // which is the hardest kind of failure to notice.
  const fetchImpl = okFetch();
  const now = 1_000_000;
  const res = await handleLead(post({ ...validBody, formOpenedAt: now - 10 }), {
    env: { ...ENV, MIN_FILL_MS: '0' },
    fetchImpl,
    now,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.delivered.email, true, 'the lead was actually sent');
  assert.ok(fetchImpl.calls.length > 0);
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

// ── request context and persistence ─────────────────────────────────────────

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

/** Runs handleLead against a throwaway data directory. */
async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gcitt-store-'));
  const env = { ...ENV, LEAD_STORE: 'true', DATA_DIR: dir };
  try {
    await fn(env, () => createStore({ dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a validated lead is written to the store before the notifications go out', async () => {
  await withStore(async (env, open) => {
    const res = await handleLead(
      post(validBody, { headers: { 'user-agent': CHROME_UA } }),
      { env, fetchImpl: okFetch() },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.delivered.stored, true);

    const [lead] = await open().listLeads();
    assert.equal(lead.firstName, 'Awa');
    assert.equal(lead.lastName, 'Diallo');
    assert.equal(lead.status, 'Nouveau', 'a new lead starts at the first CRM stage');
    assert.equal(lead.ip, '203.0.113.1');
    assert.equal(lead.device, 'Ordinateur');
    assert.equal(lead.browser, 'Chrome 131');
    assert.equal(lead.os, 'macOS 10.15');
    assert.ok(lead.id, 'the record carries an id');
  });
});

test('the store keeps the lead even when every channel is down', async () => {
  await withStore(async (env, open) => {
    const failing = async () => ({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => '{}',
    });
    const res = await handleLead(post(validBody), { env, fetchImpl: failing });
    assert.equal(res.status, 502, 'the prospect is told the notification failed');
    assert.equal((await open().listLeads()).length, 1, 'but the lead is not lost');
  });
});

test('a bot submission is never written to the store', async () => {
  await withStore(async (env, open) => {
    await handleLead(post({ ...validBody, website: 'http://spam.example' }), { env, fetchImpl: okFetch() });
    assert.equal((await open().listLeads()).length, 0);
  });
});

test('the client cannot forge its own IP or device', async () => {
  await withStore(async (env, open) => {
    const res = await handleLead(
      post(
        { ...validBody, ip: '9.9.9.9', device: 'Mainframe', browser: 'Netscape', userAgent: 'nope' },
        { headers: { 'user-agent': CHROME_UA } },
      ),
      { env, fetchImpl: okFetch() },
    );
    assert.equal(res.status, 200);

    const [lead] = await open().listLeads();
    assert.equal(lead.ip, '203.0.113.1');
    assert.equal(lead.device, 'Ordinateur');
    assert.equal(lead.browser, 'Chrome 131');
    assert.equal(lead.userAgent, CHROME_UA);
  });
});

test('a store failure never costs the prospect their submission', async () => {
  // DATA_DIR points at a regular file, so the append fails with ENOTDIR.
  const dir = mkdtempSync(join(tmpdir(), 'gcitt-store-'));
  const notADirectory = join(dir, 'occupied');
  writeFileSync(notADirectory, 'not a directory');
  try {
    const env = { ...ENV, LEAD_STORE: 'true', DATA_DIR: notADirectory };
    const res = await handleLead(post(validBody), { env, fetchImpl: okFetch() });
    assert.equal(res.status, 200);
    assert.equal(res.body.delivered.stored, false);
    assert.equal(res.body.delivered.email, true, 'the notifications still went out');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the store can be switched off entirely', async () => {
  const res = await handleLead(post(validBody), { env: ENV, fetchImpl: okFetch() });
  assert.equal(res.body.delivered.stored, false);
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

test('the prospect confirmation is sent alongside the internal alerts', async () => {
  const fetchImpl = okFetch();
  const res = await handleLead(post(validBody), { env: ENV, fetchImpl });

  assert.equal(res.body.delivered.confirmation, true);
  // Meta once, sales email once, prospect confirmation once.
  assert.equal(fetchImpl.calls.length, 3);
  const recipients = fetchImpl.calls.filter((c) => c.url.includes('resend')).map((c) => c.body.to);
  assert.deepEqual(recipients.sort(), [['awa@example.com'], ['commercial@gcitt.com']].sort());
});

test('a failed confirmation does not fail the submission', async () => {
  // The prospect's mailbox bounces, but the sales team was still alerted, so
  // the prospect must not be shown an error.
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    const isConfirmation = url.includes('resend') && body.to?.[0] === 'awa@example.com';
    return {
      ok: !isConfirmation,
      status: isConfirmation ? 422 : 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(
        isConfirmation ? { message: 'Invalid recipient' } : { messages: [{ id: 'm' }], id: 'e' }),
    };
  };

  const res = await handleLead(post(validBody), { env: ENV, fetchImpl });
  assert.equal(res.status, 200, 'a bounced acknowledgement must not surface as an error');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.delivered.confirmation, false);
  assert.equal(res.body.delivered.email, true);
});

test('UTM parameters reach the notification channels', async () => {
  const fetchImpl = okFetch();
  await handleLead(
    post({
      ...validBody,
      source: 'TikTok',
      utmSource: 'tiktok',
      utmMedium: 'cpc',
      utmCampaign: 'diaspora_juillet',
      utmContent: 'video_a',
      utmTerm: 'villa benin',
      clickId: 'ttclid=ABC123',
    }),
    { env: ENV, fetchImpl },
  );

  const salesEmail = fetchImpl.calls.find(
    (c) => c.url.includes('resend') && c.body.to[0] === 'commercial@gcitt.com');
  for (const expected of ['tiktok', 'cpc', 'diaspora_juillet', 'video_a', 'ttclid=ABC123']) {
    assert.ok(salesEmail.body.text.includes(expected), `missing ${expected} from the sales email`);
  }
});

test('empty UTM rows are omitted for a direct visitor', async () => {
  const fetchImpl = okFetch();
  await handleLead(post(validBody), { env: ENV, fetchImpl });
  const salesEmail = fetchImpl.calls.find(
    (c) => c.url.includes('resend') && c.body.to[0] === 'commercial@gcitt.com');
  assert.ok(!salesEmail.body.text.includes('utm_medium'), 'blank UTM rows should be dropped');
  assert.ok(salesEmail.body.text.includes('Source d’acquisition : Direct'));
});
