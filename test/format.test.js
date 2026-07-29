import test from 'node:test';
import assert from 'node:assert/strict';

import {
  whatsappText,
  whatsappTemplateParams,
  emailHtml,
  emailText,
  describeProject,
  escapeHtml,
  formatDate,
  toTemplateParam,
} from '../lib/format.js';

const lead = {
  name: 'Awa Diallo',
  email: 'awa@example.com',
  phone: '+33612345678',
  country: 'France',
  cite: 'Cœur Joie',
  villa: 'Villa Kafui (Duplex)',
  villaType: 'Duplex',
  delai: 'Dans 3 à 6 mois',
  budget: 'Entre 60M et 90M FCFA',
  message: 'Bonjour,\nje souhaite visiter en juillet.',
  source: 'TikTok',
  sourceDetail: 'utm_source=tiktok',
  pageUrl: 'https://gcitt.com/',
  submittedAt: '2026-03-01T09:30:00Z',
};

test('the WhatsApp body matches the agreed format exactly', () => {
  const text = whatsappText(lead);
  assert.equal(
    text,
    [
      '🚨 NOUVEAU PROSPECT GCITT',
      '',
      '👤 Nom :',
      'Awa Diallo',
      '',
      '📱 Téléphone :',
      '+33612345678',
      '',
      '📧 Email :',
      'awa@example.com',
      '',
      '🏠 Projet recherché :',
      'Villa Kafui (Duplex) — Cité Cœur Joie',
      '',
      '💬 Message :',
      'Bonjour, je souhaite visiter en juillet.',
      '',
      '📅 Date :',
      '01/03/2026 à 10h30',
      '',
      '⚡ Action :',
      'Contacter rapidement ce prospect.',
    ].join('\n'),
  );
});

test('template parameters are single-line, as Meta requires', () => {
  const params = whatsappTemplateParams({ ...lead, message: 'Ligne 1\nLigne 2\t\tfin' });
  assert.equal(params.length, 6);
  for (const p of params) {
    assert.doesNotMatch(p, /[\n\r\t]/, `parameter contains a newline or tab: ${JSON.stringify(p)}`);
    assert.doesNotMatch(p, / {5}/, 'parameter contains 5+ consecutive spaces');
    assert.notEqual(p, '', 'Meta rejects empty parameters');
  }
});

test('an empty message becomes a placeholder rather than an empty parameter', () => {
  const params = whatsappTemplateParams({ ...lead, message: '' });
  assert.equal(params[4], 'Aucun message');
});

test('over-long messages are truncated with an ellipsis', () => {
  const out = toTemplateParam('x'.repeat(2000));
  assert.equal(out.length, 900);
  assert.ok(out.endsWith('…'));
});

test('dates render in Benin local time', () => {
  // 09:30 UTC is 10:30 in Africa/Porto-Novo (UTC+1, no DST).
  assert.equal(formatDate('2026-03-01T09:30:00Z'), '01/03/2026 à 10h30');
});

test('an invalid date renders as empty rather than "Invalid Date"', () => {
  assert.equal(formatDate('not-a-date'), '');
});

test('describeProject degrades gracefully', () => {
  assert.equal(describeProject(lead), 'Villa Kafui (Duplex) — Cité Cœur Joie');
  assert.equal(describeProject({ villa: '', cite: 'Bethel' }), 'Cité Bethel');
  assert.equal(describeProject({ villa: 'Villa Fenou (F4)', cite: '' }), 'Villa Fenou (F4)');
  assert.equal(describeProject({ villa: 'Je ne sais pas encore', cite: '', villaType: 'F4' }), 'Type F4');
  assert.equal(describeProject({}), 'Projet à définir');
});

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('the HTML email escapes hostile lead values', () => {
  const html = emailHtml({ ...lead, name: '<script>alert(1)</script>', message: '<b>hi</b>' });
  assert.ok(!html.includes('<script>'), 'raw script tag must not survive');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;b&gt;hi&lt;/b&gt;'));
});

test('the HTML email keeps message line breaks readable', () => {
  const html = emailHtml(lead);
  assert.ok(html.includes('Bonjour,<br>je souhaite visiter en juillet.'));
});

test('the HTML email offers a WhatsApp reply link to the prospect', () => {
  assert.ok(emailHtml(lead).includes('https://wa.me/33612345678'));
});

test('the text email lists every captured field', () => {
  const text = emailText(lead);
  for (const expected of [
    'Awa Diallo',
    '+33612345678',
    'awa@example.com',
    'France',
    'Cité Cœur Joie',
    'Villa Kafui (Duplex)',
    'Duplex',
    'Dans 3 à 6 mois',
    'Entre 60M et 90M FCFA',
    'TikTok',
    '01/03/2026 à 10h30',
  ]) {
    assert.ok(text.includes(expected), `missing from the email: ${expected}`);
  }
});

test('empty optional fields render as a dash, not "undefined"', () => {
  const text = emailText({ name: 'X', email: 'x@y.co', phone: '+229', submittedAt: lead.submittedAt });
  assert.ok(!text.includes('undefined'));
  assert.ok(text.includes('—'));
});
