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

// [label, accessor, optional]. Optional rows are dropped when empty rather
// than rendered as a dash — a direct visitor should not produce six blank UTM
// lines in the sales inbox.
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
  ['Détail de la source', (l) => l.sourceDetail, true],
  ['utm_source', (l) => l.utmSource, true],
  ['utm_medium', (l) => l.utmMedium, true],
  ['utm_campaign', (l) => l.utmCampaign, true],
  ['utm_content', (l) => l.utmContent, true],
  ['utm_term', (l) => l.utmTerm, true],
  ['Click ID', (l) => l.clickId, true],
  ['Page d’origine', (l) => l.pageUrl, true],
  ['Date de soumission', (l) => formatDate(l.submittedAt)],
];

const visibleRows = (lead) =>
  EMAIL_ROWS.filter(([, get, optional]) => !optional || get(lead));

/** Plain-text email body, for clients that reject HTML. */
export function emailText(lead) {
  const rows = visibleRows(lead).map(([label, get]) => `${label} : ${get(lead) || '—'}`);
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
  const rows = visibleRows(lead).map(([label, get]) => {
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

// ── Acknowledgement sent to the prospect ────────────────────────────────────

/** First name only — "Bonjour Awa" reads better than the full legal name. */
function firstName(fullName) {
  return String(fullName ?? '').trim().split(/\s+/)[0] || '';
}

/** The line describing what the prospect asked about. */
function projectLine(lead) {
  const villa = lead.villa && lead.villa !== 'Je ne sais pas encore' ? lead.villa : '';
  const cite = lead.cite ? `Cité ${lead.cite}` : '';
  if (villa && cite) return `${villa}, ${cite}`;
  if (villa) return villa;
  if (cite) return cite;
  return 'Votre projet de villa';
}

export function prospectEmailText(lead, contact) {
  return [
    `Bonjour ${firstName(lead.name)},`,
    '',
    'Nous avons bien reçu votre demande de rendez-vous et nous vous remercions',
    'de la confiance que vous accordez à GCITT BENIN.',
    '',
    `Votre projet : ${projectLine(lead)}`,
    `Reçue le : ${formatDate(lead.submittedAt)}`,
    '',
    'Un conseiller GCITT prendra contact avec vous dans les meilleurs délais',
    'pour étudier votre projet et répondre à toutes vos questions.',
    '',
    'En attendant, vous pouvez nous joindre directement :',
    `  WhatsApp  : ${contact.whatsapp}`,
    `  Téléphone : ${contact.phone}`,
    `  Email     : ${contact.email}`,
    `  Site      : ${contact.website}`,
    '',
    contact.address,
    '',
    'À très bientôt,',
    "L'équipe GCITT BENIN SA",
    'Générale du Commerce, de l\'Industrie, du Transport et des Travaux',
  ].join('\n');
}

/**
 * Responsive HTML acknowledgement.
 *
 * Table-based with inline styles, because Gmail, Outlook and the mobile
 * clients strip <style> blocks and ignore flexbox. The single media query is
 * a progressive enhancement — the layout already works without it.
 */
export function prospectEmailHtml(lead, contact) {
  const e = escapeHtml;
  const waDigits = String(contact.whatsapp ?? '').replace(/\D/g, '');

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Votre demande a bien été reçue — GCITT BENIN</title>
<style>
  @media only screen and (max-width:600px) {
    .wrap { width:100% !important; }
    .pad { padding-left:22px !important; padding-right:22px !important; }
    .h1 { font-size:23px !important; }
    .btn { display:block !important; width:100% !important; box-sizing:border-box; text-align:center; }
    .btn + .btn { margin-left:0 !important; margin-top:10px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-font-smoothing:antialiased">
  <!-- Preview line shown in the inbox list, hidden in the body. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">Un conseiller GCITT vous recontacte très prochainement au sujet de votre projet de villa.</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">

        <tr>
          <td class="pad" style="background:#12305c;padding:32px 36px">
            <div style="color:#ffffff;font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase">GCITT BENIN SA</div>
            <div class="h1" style="color:#ffffff;font-size:26px;font-weight:700;line-height:1.3;margin-top:10px">Merci pour votre confiance, ${e(firstName(lead.name))}.</div>
            <div style="color:#c3d2ea;font-size:15px;line-height:1.6;margin-top:10px">Votre demande de rendez-vous a bien été reçue.</div>
          </td>
        </tr>

        <tr>
          <td class="pad" style="padding:30px 36px 6px">
            <p style="margin:0 0 18px;color:#1c2430;font-size:15px;line-height:1.7">
              Nous vous remercions de l'intérêt que vous portez à nos cités.
              Un conseiller GCITT prendra contact avec vous <strong>dans les meilleurs délais</strong>
              pour étudier votre projet et répondre à toutes vos questions.
            </p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fb;border-left:3px solid #d21f2d;border-radius:8px;margin-bottom:22px">
              <tr><td style="padding:16px 18px">
                <div style="color:#5b6472;font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase">Votre projet</div>
                <div style="color:#12305c;font-size:17px;font-weight:700;margin-top:6px">${e(projectLine(lead))}</div>
                <div style="color:#5b6472;font-size:13px;margin-top:8px">Demande reçue le ${e(formatDate(lead.submittedAt))}</div>
              </td></tr>
            </table>

            <p style="margin:0 0 8px;color:#1c2430;font-size:15px;line-height:1.7">
              Vous n'avez rien d'autre à faire pour l'instant. Si vous souhaitez
              nous joindre plus rapidement, écrivez-nous directement sur WhatsApp.
            </p>
          </td>
        </tr>

        <tr>
          <td class="pad" style="padding:14px 36px 28px">
            <a class="btn" href="https://wa.me/${e(waDigits)}" style="display:inline-block;background:#1fa855;color:#ffffff;font-weight:700;font-size:15px;padding:14px 26px;border-radius:9px;text-decoration:none">💬 Écrire sur WhatsApp</a>
            <a class="btn" href="${e(contact.siteUrl)}/#villas" style="display:inline-block;margin-left:10px;background:#ffffff;color:#12305c;border:1.5px solid #12305c;font-weight:700;font-size:15px;padding:12.5px 24px;border-radius:9px;text-decoration:none">Revoir les villas</a>
          </td>
        </tr>

        <tr>
          <td class="pad" style="padding:0 36px 30px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e6e9ef">
              <tr><td style="padding-top:22px">
                <div style="color:#12305c;font-size:14px;font-weight:700;margin-bottom:12px">Nous contacter</div>
                <div style="color:#5b6472;font-size:14px;line-height:1.9">
                  WhatsApp : <a href="https://wa.me/${e(waDigits)}" style="color:#1f4e96;text-decoration:none">${e(contact.whatsapp)}</a><br>
                  Téléphone : <a href="tel:${e(String(contact.phone).replace(/\s/g, ''))}" style="color:#1f4e96;text-decoration:none">${e(contact.phone)}</a><br>
                  Email : <a href="mailto:${e(contact.email)}" style="color:#1f4e96;text-decoration:none">${e(contact.email)}</a><br>
                  Site : <a href="https://${e(contact.website)}" style="color:#1f4e96;text-decoration:none">${e(contact.website)}</a>
                </div>
                <div style="color:#8792a3;font-size:13px;line-height:1.7;margin-top:14px">${e(contact.address)}</div>
              </td></tr>
            </table>
          </td>
        </tr>

        <tr>
          <td class="pad" style="background:#0d2447;padding:22px 36px">
            <div style="color:#ffffff;font-size:13px;font-weight:700">GCITT BENIN SA</div>
            <div style="color:#7c8bab;font-size:12px;line-height:1.6;margin-top:5px">
              Générale du Commerce, de l'Industrie, du Transport et des Travaux<br>
              Certifié ISO 9001:2015 · +600 villas construites
            </div>
            <div style="color:#5f6f92;font-size:11px;margin-top:12px">
              Vous recevez cet email car une demande de rendez-vous a été envoyée depuis notre site avec cette adresse.
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
