import test from 'node:test';
import assert from 'node:assert/strict';

import { validateLead, normalisePhone, isHoneypotTripped } from '../lib/validate.js';

const base = {
  firstName: 'Awa',
  lastName: 'Diallo',
  email: 'awa@example.com',
  phone: '+33612345678',
};

test('accepts a well-formed submission', () => {
  const r = validateLead(base);
  assert.equal(r.ok, true);
  assert.equal(r.lead.firstName, 'Awa');
  assert.equal(r.lead.lastName, 'Diallo');
  assert.equal(r.lead.name, 'Awa Diallo', 'the display name is composed server-side');
  assert.equal(r.lead.email, 'awa@example.com');
  assert.equal(r.lead.phone, '+33612345678');
  assert.equal(r.lead.source, 'Direct', 'source defaults to Direct');
  assert.ok(Date.parse(r.lead.submittedAt), 'submittedAt is an ISO date');
});

test('lower-cases and trims the email', () => {
  const r = validateLead({ ...base, email: '  AWA@Example.COM  ' });
  assert.equal(r.lead.email, 'awa@example.com');
});

test('rejects a missing name, bad email and short phone together', () => {
  const r = validateLead({ firstName: 'A', lastName: '', email: 'not-an-email', phone: '12' });
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.errors).sort(), ['email', 'firstName', 'lastName', 'phone']);
});

test('a client-supplied name field cannot override the composed one', () => {
  const r = validateLead({ ...base, name: 'Administrateur' });
  assert.equal(r.lead.name, 'Awa Diallo');
});

test('rejects an email with no dot in the domain', () => {
  assert.equal(validateLead({ ...base, email: 'awa@localhost' }).ok, false);
});

test('derives cité and villa type from the chosen villa', () => {
  const r = validateLead({ ...base, villa: 'Villa Kafui (Duplex)' });
  assert.equal(r.lead.cite, 'Cœur Joie');
  assert.equal(r.lead.villaType, 'Duplex');
});

test('the villa catalogue overrides a mismatched client-supplied cité', () => {
  // A tampered client claims Bethel while picking a Cœur Joie villa.
  const r = validateLead({ ...base, villa: 'Villa Fenou (F4)', cite: 'Bethel', villaType: 'Duplex' });
  assert.equal(r.lead.cite, 'Cœur Joie');
  assert.equal(r.lead.villaType, 'F4');
});

test('keeps cité and type when no specific villa is chosen', () => {
  const r = validateLead({ ...base, villa: 'Je ne sais pas encore', cite: 'Bethel', villaType: 'F4' });
  assert.equal(r.lead.cite, 'Bethel');
  assert.equal(r.lead.villaType, 'F4');
});

test('drops values outside the allow-lists', () => {
  const r = validateLead({ ...base, villa: '<script>alert(1)</script>', cite: 'Atlantide', villaType: 'F99' });
  assert.equal(r.lead.villa, '');
  assert.equal(r.lead.cite, '');
  assert.equal(r.lead.villaType, '');
});

test('strips control characters and caps field length', () => {
  const r = validateLead({ ...base, lastName: 'Dia\u0000\u0007 \t llo', message: 'x'.repeat(5000) });
  assert.equal(r.lead.lastName, 'Dia llo');
  assert.equal(r.lead.message.length, 2000);
});

test('keeps line breaks in the message but collapses long runs', () => {
  const r = validateLead({ ...base, message: 'Bonjour\r\n\n\n\nMerci' });
  assert.equal(r.lead.message, 'Bonjour\n\nMerci');
});

test('ignores unknown fields entirely', () => {
  const r = validateLead({ ...base, isAdmin: true, __proto__: { polluted: 1 } });
  assert.equal(r.lead.isAdmin, undefined);
});

test('server timestamp wins over any client-supplied date', () => {
  const now = Date.parse('2026-03-01T09:30:00Z');
  const r = validateLead({ ...base, submittedAt: '1999-01-01T00:00:00Z' }, { now });
  assert.equal(r.lead.submittedAt, new Date(now).toISOString());
});

test('flags a submission completed faster than a human could type', () => {
  const now = 1_000_000;
  const r = validateLead({ ...base, formOpenedAt: now - 500 }, { now, minFillMs: 3000 });
  assert.equal(r.ok, false);
  assert.equal(r.spam, true);
});

test('allows a submission that took long enough', () => {
  const now = 1_000_000;
  const r = validateLead({ ...base, formOpenedAt: now - 9000 }, { now, minFillMs: 3000 });
  assert.equal(r.ok, true);
});

test('field errors take precedence over the spam check', () => {
  const now = 1_000_000;
  const r = validateLead({ name: 'A', email: 'x', phone: '1', formOpenedAt: now }, { now, minFillMs: 3000 });
  assert.equal(r.ok, false);
  assert.equal(r.spam, undefined, 'a human with a typo gets a useful error, not a spam rejection');
});

test('a forged future clock is treated as suspicious', () => {
  const now = 1_000_000;
  const r = validateLead({ ...base, formOpenedAt: now + 60_000 }, { now, minFillMs: 3000 });
  assert.equal(r.spam, true);
});

test('a missing formOpenedAt does not trip the spam check', () => {
  const r = validateLead(base, { now: 1_000_000, minFillMs: 3000 });
  assert.equal(r.ok, true);
});

test('handles a non-object body', () => {
  for (const body of [null, undefined, 'string', 42, []]) {
    assert.equal(validateLead(body).ok, false);
  }
});

test('normalisePhone adds the Benin country code to local numbers', () => {
  assert.equal(normalisePhone('01 67 21 21 28'), '+2290167212128');
  assert.equal(normalisePhone('67212128'), '+22967212128');
});

test('normalisePhone preserves an explicit country code', () => {
  assert.equal(normalisePhone('+33 6 12 34 56 78'), '+33612345678');
  assert.equal(normalisePhone('0033612345678'), '+33612345678');
  assert.equal(normalisePhone('+229 01 67 21 21 28'), '+2290167212128');
});

test('normalisePhone returns empty for junk', () => {
  assert.equal(normalisePhone('abc'), '');
  assert.equal(normalisePhone(''), '');
  assert.equal(normalisePhone(null), '');
});

test('rejects a phone number longer than E.164 allows', () => {
  assert.equal(validateLead({ ...base, phone: '+1234567890123456789' }).ok, false);
});

test('honeypot detection', () => {
  assert.equal(isHoneypotTripped({ website: 'http://spam.example' }), true);
  assert.equal(isHoneypotTripped({ website: '   ' }), false);
  assert.equal(isHoneypotTripped({ website: '' }), false);
  assert.equal(isHoneypotTripped({}), false);
  assert.equal(isHoneypotTripped(null), false);
});
