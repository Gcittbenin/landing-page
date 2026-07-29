import test from 'node:test';
import assert from 'node:assert/strict';

import { sendWhatsAppAlert } from '../lib/whatsapp.js';
import { sendLeadEmail, sendProspectConfirmation } from '../lib/email.js';
import { forwardToCrm } from '../lib/crm.js';
import { loadConfig } from '../lib/config.js';

const lead = {
  name: 'Awa Diallo',
  email: 'awa@example.com',
  phone: '+33612345678',
  country: 'France',
  cite: 'Cœur Joie',
  villa: 'Villa Kafui (Duplex)',
  villaType: 'Duplex',
  delai: '',
  budget: '',
  message: 'Bonjour',
  source: 'TikTok',
  sourceDetail: '',
  pageUrl: 'https://gcitt.com/',
  submittedAt: '2026-03-01T09:30:00Z',
};

/** A fetch double that records calls and replays a scripted response. */
function stubFetch({ status = 200, body = {}, headers = {} } = {}) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: async () => JSON.stringify(body),
    };
  };
  fn.calls = calls;
  return fn;
}

const waConfig = (overrides = {}) => ({
  ...loadConfig({
    META_WHATSAPP_TOKEN: 'test-token',
    META_PHONE_NUMBER_ID: '123456',
    GCITT_SALES_WHATSAPP: '2290167212128',
  }).whatsapp,
  ...overrides,
});

// ── WhatsApp ────────────────────────────────────────────────────────────────

test('WhatsApp: is skipped, not failed, when unconfigured', async () => {
  const res = await sendWhatsAppAlert(lead, waConfig({ token: '' }), { fetchImpl: stubFetch() });
  assert.equal(res.ok, false);
  assert.match(res.skipped, /META_WHATSAPP_TOKEN/);
});

test('WhatsApp: sends free-form text when no template is configured', async () => {
  const fetchImpl = stubFetch({ body: { messages: [{ id: 'wamid.TEST' }] } });
  const res = await sendWhatsAppAlert(lead, waConfig(), { fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(res.messageId, 'wamid.TEST');

  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://graph.facebook.com/v21.0/123456/messages');
  assert.equal(call.options.headers.Authorization, 'Bearer test-token');
  assert.equal(call.body.type, 'text');
  assert.equal(call.body.to, '2290167212128');
  assert.ok(call.body.text.body.startsWith('🚨 NOUVEAU PROSPECT GCITT'));
  assert.equal(call.body.text.preview_url, false);
});

test('WhatsApp: sends the approved template when one is configured', async () => {
  const fetchImpl = stubFetch({ body: { messages: [{ id: 'wamid.T' }] } });
  await sendWhatsAppAlert(lead, waConfig({ templateName: 'gcitt_nouveau_prospect' }), { fetchImpl });

  const { body } = fetchImpl.calls[0];
  assert.equal(body.type, 'template');
  assert.equal(body.template.name, 'gcitt_nouveau_prospect');
  assert.equal(body.template.language.code, 'fr');

  const params = body.template.components[0].parameters;
  assert.equal(params.length, 6);
  assert.deepEqual(params[0], { type: 'text', text: 'Awa Diallo' });
  assert.equal(params[3].text, 'Villa Kafui (Duplex) — Cité Cœur Joie');
});

test('WhatsApp: the sales number is stripped to digits', async () => {
  const fetchImpl = stubFetch({ body: { messages: [{ id: 'x' }] } });
  const config = loadConfig({
    META_WHATSAPP_TOKEN: 't',
    META_PHONE_NUMBER_ID: '1',
    GCITT_SALES_WHATSAPP: '+229 01 67 21 21 28',
  }).whatsapp;
  await sendWhatsAppAlert(lead, config, { fetchImpl });
  assert.equal(fetchImpl.calls[0].body.to, '2290167212128');
});

test('WhatsApp: a closed 24h window returns an actionable error', async () => {
  const fetchImpl = stubFetch({
    status: 400,
    body: { error: { code: 131047, message: 'Re-engagement message' } },
  });
  const res = await sendWhatsAppAlert(lead, waConfig(), { fetchImpl });

  assert.equal(res.ok, false);
  assert.equal(res.code, 131047);
  assert.match(res.error, /template approuvé par Meta/);
  assert.match(res.error, /META_WHATSAPP_TEMPLATE_NAME/);
});

test('WhatsApp: surfaces a generic Meta error', async () => {
  const fetchImpl = stubFetch({ status: 401, body: { error: { code: 190, message: 'Invalid token' } } });
  const res = await sendWhatsAppAlert(lead, waConfig(), { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal(res.error, 'Invalid token');
});

test('WhatsApp: a network failure is caught, never thrown', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const res = await sendWhatsAppAlert(lead, waConfig(), { fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.error, /ECONNREFUSED/);
});

// ── Email ───────────────────────────────────────────────────────────────────

const emailConfig = (env = {}) =>
  loadConfig({
    EMAIL_API_KEY: 'key_test',
    EMAIL_DESTINATION: 'commercial@gcitt.com',
    EMAIL_FROM: 'GCITT <no-reply@gcitt.com>',
    ...env,
  }).email;

test('email: is skipped when no API key is set', async () => {
  const res = await sendLeadEmail(lead, emailConfig({ EMAIL_API_KEY: '' }), { fetchImpl: stubFetch() });
  assert.match(res.skipped, /EMAIL_API_KEY/);
});

test('email: is skipped when no destination is set', async () => {
  const res = await sendLeadEmail(lead, emailConfig({ EMAIL_DESTINATION: '' }), { fetchImpl: stubFetch() });
  assert.match(res.skipped, /EMAIL_DESTINATION/);
});

test('email: builds the Resend payload with the required subject', async () => {
  const fetchImpl = stubFetch({ body: { id: 'email_1' } });
  const res = await sendLeadEmail(lead, emailConfig(), { fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(res.messageId, 'email_1');

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.resend.com/emails');
  assert.ok(call.body.subject.startsWith('Nouveau prospect - Demande villa GCITT'));
  assert.deepEqual(call.body.to, ['commercial@gcitt.com']);
  assert.equal(call.body.reply_to, 'awa@example.com', 'replying should reach the prospect');
  assert.ok(call.body.html.includes('Awa Diallo'));
  assert.ok(call.body.text.includes('Awa Diallo'));
});

test('email: supports several comma-separated recipients', async () => {
  const fetchImpl = stubFetch({ body: { id: 'e' } });
  await sendLeadEmail(lead, emailConfig({ EMAIL_DESTINATION: 'a@gcitt.com, b@gcitt.com' }), { fetchImpl });
  assert.deepEqual(fetchImpl.calls[0].body.to, ['a@gcitt.com', 'b@gcitt.com']);
});

test('email: builds the SendGrid payload and parses the From name', async () => {
  const fetchImpl = stubFetch({ status: 202, body: {}, headers: { 'x-message-id': 'sg-1' } });
  const res = await sendLeadEmail(lead, emailConfig({ EMAIL_PROVIDER: 'sendgrid' }), { fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(res.messageId, 'sg-1');

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.sendgrid.com/v3/mail/send');
  assert.deepEqual(call.body.from, { name: 'GCITT', email: 'no-reply@gcitt.com' });
  assert.deepEqual(call.body.personalizations[0].to, [{ email: 'commercial@gcitt.com' }]);
  assert.equal(call.body.content.length, 2);
});

test('email: an unknown provider is reported clearly', async () => {
  const res = await sendLeadEmail(lead, emailConfig({ EMAIL_PROVIDER: 'mailchimp' }), { fetchImpl: stubFetch() });
  assert.equal(res.ok, false);
  assert.match(res.skipped, /EMAIL_PROVIDER inconnu/);
});

test('email: surfaces a provider error', async () => {
  const fetchImpl = stubFetch({ status: 422, body: { message: 'Domain not verified' } });
  const res = await sendLeadEmail(lead, emailConfig(), { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.status, 422);
  assert.equal(res.error, 'Domain not verified');
});

// ── CRM ─────────────────────────────────────────────────────────────────────

test('CRM: skipped when no webhook is configured', async () => {
  const res = await forwardToCrm(lead, { webhookUrl: '', token: '' }, { fetchImpl: stubFetch() });
  assert.match(res.skipped, /CRM_WEBHOOK_URL/);
});

test('CRM: posts the lead with a bearer token when set', async () => {
  const fetchImpl = stubFetch({ body: {} });
  const res = await forwardToCrm(lead, { webhookUrl: 'https://crm.example/hook', token: 'secret' }, { fetchImpl });

  assert.equal(res.ok, true);
  const call = fetchImpl.calls[0];
  assert.equal(call.options.headers.Authorization, 'Bearer secret');
  assert.equal(call.body.source, 'landing-page-gcitt');
  assert.equal(call.body.lead.name, 'Awa Diallo');
});

// ── Prospect confirmation ───────────────────────────────────────────────────

const contact = {
  whatsapp: '+229 01 67 21 21 28',
  phone: '+229 01 64 61 61 56',
  email: 'contact@gcitt.com',
  website: 'www.gcitt.com',
  address: 'C/875 Aïdjèdo 1, Cotonou, Bénin',
  siteUrl: 'https://nos-villas.gcitt.com',
};

test('confirmation: goes to the prospect, not the sales inbox', async () => {
  const fetchImpl = stubFetch({ body: { id: 'c1' } });
  const res = await sendProspectConfirmation(lead, emailConfig(), contact, { fetchImpl });

  assert.equal(res.ok, true);
  const call = fetchImpl.calls[0];
  assert.deepEqual(call.body.to, ['awa@example.com']);
  assert.equal(call.body.subject, 'Votre demande a bien été reçue — GCITT BENIN');
  // A prospect who replies must reach a human, not a no-reply box.
  assert.equal(call.body.reply_to, 'commercial@gcitt.com');
});

test('confirmation: greets by first name and names the project', async () => {
  const fetchImpl = stubFetch({ body: { id: 'c' } });
  await sendProspectConfirmation(lead, emailConfig(), contact, { fetchImpl });

  const { html, text } = fetchImpl.calls[0].body;
  assert.ok(html.includes('Merci pour votre confiance, Awa.'), 'no first-name greeting');
  assert.ok(html.includes('Villa Kafui (Duplex), Cité Cœur Joie'));
  assert.ok(text.includes('Bonjour Awa,'));
  assert.ok(text.includes('Villa Kafui (Duplex), Cité Cœur Joie'));
});

test('confirmation: carries the GCITT contact details', async () => {
  const fetchImpl = stubFetch({ body: { id: 'c' } });
  await sendProspectConfirmation(lead, emailConfig(), contact, { fetchImpl });

  const { html } = fetchImpl.calls[0].body;
  for (const expected of [
    '+229 01 67 21 21 28',
    '+229 01 64 61 61 56',
    'contact@gcitt.com',
    'www.gcitt.com',
    'C/875 Aïdjèdo 1, Cotonou, Bénin',
    'https://wa.me/2290167212128',
  ]) {
    assert.ok(html.includes(expected), `confirmation is missing ${expected}`);
  }
});

test('confirmation: is responsive and renders in HTML-hostile clients', async () => {
  const fetchImpl = stubFetch({ body: { id: 'c' } });
  await sendProspectConfirmation(lead, emailConfig(), contact, { fetchImpl });
  const { html, text } = fetchImpl.calls[0].body;

  assert.ok(html.includes('@media only screen and (max-width:600px)'), 'no mobile breakpoint');
  assert.ok(html.includes('role="presentation"'), 'layout should be table-based for Outlook');
  assert.ok(html.includes('name="viewport"'));
  // A plain-text alternative for clients that strip HTML entirely.
  assert.ok(text.length > 200 && !text.includes('<'));
});

test('confirmation: escapes a hostile name', async () => {
  const fetchImpl = stubFetch({ body: { id: 'c' } });
  await sendProspectConfirmation(
    { ...lead, name: '<script>alert(1)</script> Diallo' }, emailConfig(), contact, { fetchImpl });
  const { html } = fetchImpl.calls[0].body;
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('confirmation: can be turned off', async () => {
  const fetchImpl = stubFetch({ body: {} });
  const res = await sendProspectConfirmation(
    lead, emailConfig({ EMAIL_CONFIRMATION_ENABLED: 'false' }), contact, { fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.skipped, /EMAIL_CONFIRMATION_ENABLED/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('confirmation: degrades when no villa was chosen', async () => {
  const fetchImpl = stubFetch({ body: { id: 'c' } });
  await sendProspectConfirmation(
    { ...lead, villa: 'Je ne sais pas encore', cite: '' }, emailConfig(), contact, { fetchImpl });
  assert.ok(fetchImpl.calls[0].body.html.includes('Votre projet de villa'));
});
