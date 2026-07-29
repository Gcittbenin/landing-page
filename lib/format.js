/**
 * Rendering a validated lead for each notification channel.
 */

/** Escape text destined for an HTML email body. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Human-readable timestamp in Benin local time (UTC+1, no DST).
 * Intl with a fixed zone keeps this correct wherever the function runs.
 */
export function formatDate(iso, timeZone = 'Africa/Porto-Novo') {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} à ${get('hour')}h${get('minute')}`;
}

/** "Villa Kafui (Duplex) — Cité Cœur Joie", degrading gracefully. */
export function describeProject(lead) {
  const villa = lead.villa && lead.villa !== 'Je ne sais pas encore' ? lead.villa : '';
  const cite = lead.cite ? `Cité ${lead.cite}` : '';
  if (villa && cite) return `${villa} — ${cite}`;
  if (villa) return villa;
  if (cite) return cite;
  if (lead.villaType) return `Type ${lead.villaType}`;
  return 'Projet à définir';
}

/**
 * Collapse a value to a single line for use as a WhatsApp template parameter.
 *
 * Meta rejects parameters containing newlines, tabs, or more than four
 * consecutive spaces, so the prospect's message has to be flattened. The
 * unabridged text is always in the email.
 */
export function toTemplateParam(value, { max = 900, fallback = '—' } = {}) {
  const flat = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return fallback;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The six template parameters, in the order the approved template expects. */
export function whatsappTemplateParams(lead) {
  return [
    toTemplateParam(lead.name),
    toTemplateParam(lead.phone),
    toTemplateParam(lead.email),
    toTemplateParam(describeProject(lead)),
    toTemplateParam(lead.message, { fallback: 'Aucun message' }),
    toTemplateParam(formatDate(lead.submittedAt)),
  ];
}

/**
 * The free-form WhatsApp body. Identical in wording to the approved template,
 * so the sales team sees the same alert either way.
 */
export function whatsappText(lead) {
  const [name, phone, email, project, message, date] = whatsappTemplateParams(lead);
  return [
    '🚨 NOUVEAU PROSPECT GCITT',
    '',
    '👤 Nom :',
    name,
    '',
    '📱 Téléphone :',
    phone,
    '',
    '📧 Email :',
    email,
    '',
    '🏠 Projet recherché :',
    project,
    '',
    '💬 Message :',
    message,
    '',
    '📅 Date :',
    date,
    '',
    '⚡ Action :',
    'Contacter rapidement ce prospect.',
  ].join('\n');
}

const EMAIL_ROWS = [
  ['Nom complet', (l) => l.name],
  ['Téléphone / WhatsApp', (l) => l.phone],
  ['Email', (l) => l.email],
  ['Pays de résidence', (l) => l.country],
  ['Cité souhaitée', (l) => (l.cite ? `Cité ${l.cite}` : '')],
  ['Villa sélectionnée', (l) => l.villa],
  ['Type de villa', (l) => l.villaType],
  ['Délai du projet', (l) => l.delai],
  ['Budget estimatif', (l) => l.budget],
  ['Source d’acquisition', (l) => l.source],
  ['Détail de la source', (l) => l.sourceDetail],
  ['Page d’origine', (l) => l.pageUrl],
  ['Date de soumission', (l) => formatDate(l.submittedAt)],
];

/** Plain-text email body, for clients that reject HTML. */
export function emailText(lead) {
  const rows = EMAIL_ROWS.map(([label, get]) => `${label} : ${get(lead) || '—'}`);
  return [
    'NOUVEAU PROSPECT GCITT',
    '',
    ...rows,
    '',
    'Message du prospect :',
    lead.message || '(aucun message)',
    '',
    'Action : contacter rapidement ce prospect.',
  ].join('\n');
}

/** HTML email body. All interpolated values are escaped. */
export function emailHtml(lead) {
  const rows = EMAIL_ROWS.map(([label, get]) => {
    const value = get(lead);
    return `<tr>
        <td style="padding:9px 14px;border-bottom:1px solid #e6e9ef;color:#5b6472;font-size:13px;white-space:nowrap">${escapeHtml(label)}</td>
        <td style="padding:9px 14px;border-bottom:1px solid #e6e9ef;color:#12305c;font-size:14px;font-weight:600">${escapeHtml(value || '—')}</td>
      </tr>`;
  }).join('\n');

  const message = escapeHtml(lead.message || '(aucun message)').replace(/\n/g, '<br>');
  const waLink = `https://wa.me/${lead.phone.replace(/\D/g, '')}`;

  return `<!doctype html>
<html lang="fr">
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table role="presentation" style="max-width:640px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border-collapse:collapse;width:100%">
    <tr>
      <td style="background:#12305c;padding:24px 28px">
        <div style="color:#fff;font-size:19px;font-weight:700">🚨 Nouveau prospect GCITT</div>
        <div style="color:#c3d2ea;font-size:13px;margin-top:5px">Landing page Cité Cœur Joie / Bethel</div>
      </td>
    </tr>
    <tr>
      <td style="padding:22px 28px 8px">
        <table role="presentation" style="width:100%;border-collapse:collapse">${rows}</table>
      </td>
    </tr>
    <tr>
      <td style="padding:8px 28px 22px">
        <div style="color:#5b6472;font-size:13px;margin-bottom:6px">Message du prospect</div>
        <div style="background:#f8f9fb;border-left:3px solid #d21f2d;border-radius:6px;padding:14px 16px;color:#1c2430;font-size:14px;line-height:1.6">${message}</div>
      </td>
    </tr>
    <tr>
      <td style="padding:0 28px 28px">
        <a href="${escapeHtml(waLink)}" style="display:inline-block;background:#1fa855;color:#fff;font-weight:700;font-size:14px;padding:13px 22px;border-radius:8px;text-decoration:none">💬 Répondre sur WhatsApp</a>
        <a href="mailto:${escapeHtml(lead.email)}" style="display:inline-block;margin-left:10px;background:#12305c;color:#fff;font-weight:700;font-size:14px;padding:13px 22px;border-radius:8px;text-decoration:none">✉️ Répondre par email</a>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
