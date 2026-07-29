/**
 * Runtime configuration, read once from the environment.
 *
 * Nothing in here is ever sent to the browser — the frontend only ever talks to
 * /api/lead, and the API answers with a status, never with configuration.
 */

const num = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const list = (value) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(env = process.env) {
  return {
    whatsapp: {
      token: env.META_WHATSAPP_TOKEN ?? '',
      phoneNumberId: env.META_PHONE_NUMBER_ID ?? '',
      businessAccountId: env.META_BUSINESS_ACCOUNT_ID ?? '',
      // Graph API version. Pinned so a Meta release cannot silently change
      // the request or response shape under us.
      apiVersion: env.META_API_VERSION || 'v21.0',
      // Where the alert goes: the GCITT sales line, digits only, country code
      // first, no '+' (Meta rejects the plus sign in the `to` field).
      salesNumber: (env.GCITT_SALES_WHATSAPP || '2290167212128').replace(/\D/g, ''),
      // Set once the template below is approved by Meta. Without it we fall
      // back to a free-form text message, which only reaches the sales number
      // inside a 24h customer-service window. See docs/WHATSAPP.md.
      templateName: env.META_WHATSAPP_TEMPLATE_NAME ?? '',
      templateLanguage: env.META_WHATSAPP_TEMPLATE_LANG || 'fr',
    },

    email: {
      apiKey: env.EMAIL_API_KEY ?? '',
      to: list(env.EMAIL_DESTINATION),
      from: env.EMAIL_FROM || 'GCITT Landing <onboarding@resend.dev>',
      provider: (env.EMAIL_PROVIDER || 'resend').toLowerCase(),
      subject: env.EMAIL_SUBJECT || 'Nouveau prospect - Demande villa GCITT',

      // Acknowledgement sent to the prospect. On by default: a prospect who
      // gets nothing back assumes the form is broken.
      confirmationEnabled: (env.EMAIL_CONFIRMATION_ENABLED ?? 'true').toLowerCase() !== 'false',
      confirmationSubject:
        env.EMAIL_CONFIRMATION_SUBJECT || 'Votre demande a bien été reçue — GCITT BENIN',
      // Where a prospect's reply lands. Falls back to the sales inbox.
      replyTo: env.EMAIL_REPLY_TO || list(env.EMAIL_DESTINATION)[0] || '',
    },

    // Contact details shown to the prospect. Overridable so a change of number
    // does not need a code change.
    contact: {
      whatsapp: env.GCITT_CONTACT_WHATSAPP || '+229 01 67 21 21 28',
      phone: env.GCITT_CONTACT_PHONE || '+229 01 64 61 61 56',
      email: env.GCITT_CONTACT_EMAIL || 'contact@gcitt.com',
      website: env.GCITT_WEBSITE || 'www.gcitt.com',
      address:
        env.GCITT_ADDRESS ||
        'C/875 Aïdjèdo 1, Immeuble Basile Kossou, 03 BP 3803, Cotonou, Bénin',
      siteUrl: env.SITE_URL || 'https://nos-villas.gcitt.com',
    },

    security: {
      // Empty list = same-origin only (no Origin header check possible), which
      // is the correct default when the page and the API share a domain.
      allowedOrigins: list(env.ALLOWED_ORIGINS),
      rateLimit: {
        max: num(env.RATE_LIMIT_MAX, 5),
        windowMs: num(env.RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
      },
      // A human cannot complete this form in under three seconds; a bot can.
      minFillMs: num(env.MIN_FILL_MS, 3000),
    },

    // Reserved for the CRM step. When set, the lead is POSTed as JSON to this
    // URL after the notifications fire. Nothing else in the code assumes a
    // particular CRM.
    crm: {
      webhookUrl: env.CRM_WEBHOOK_URL ?? '',
      token: env.CRM_WEBHOOK_TOKEN ?? '',
    },
  };
}
