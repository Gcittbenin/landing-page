/**
 * Email notification channel.
 *
 * Two providers are supported out of the box, both plain REST + API key so
 * there is no SDK to install. Pick one with EMAIL_PROVIDER; the rest of the
 * code only ever sees sendLeadEmail().
 */

import {
  emailHtml,
  emailText,
  describeProject,
  prospectEmailHtml,
  prospectEmailText,
} from './format.js';

const TIMEOUT_MS = 10_000;

const PROVIDERS = {
  resend: {
    url: 'https://api.resend.com/emails',
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
    body: ({ from, to, subject, html, text, replyTo }) => ({
      from,
      to,
      subject,
      html,
      text,
      reply_to: replyTo,
    }),
    messageId: (json) => json?.id,
    error: (json) => json?.message || json?.error?.message,
  },

  sendgrid: {
    url: 'https://api.sendgrid.com/v3/mail/send',
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
    body: ({ from, to, subject, html, text, replyTo }) => ({
      personalizations: [{ to: to.map((address) => ({ email: address })) }],
      from: parseAddress(from),
      reply_to: { email: replyTo },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
    }),
    // SendGrid returns 202 with an empty body; the id is in a header.
    messageId: (_json, res) => res?.headers?.get?.('x-message-id'),
    error: (json) => json?.errors?.[0]?.message,
  },
};

/** '"GCITT" <a@b.com>' -> { name, email }; a bare address works too. */
function parseAddress(value) {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value ?? '');
  if (match) return { name: match[1].replace(/^"|"$/g, ''), email: match[2] };
  return { email: String(value ?? '').trim() };
}

/**
 * Send one message through the configured provider.
 *
 * Never throws, for the same reason as the WhatsApp channel: a notification
 * failure must not cost us the lead.
 *
 * @returns {Promise<{ok: boolean, skipped?: string, messageId?: string, error?: string, status?: number}>}
 */
async function send({ apiKey, provider, from, to, subject, html, text, replyTo }, fetchImpl) {
  if (!apiKey) return { ok: false, skipped: 'EMAIL_API_KEY absent' };
  if (!to || to.length === 0) return { ok: false, skipped: 'EMAIL_DESTINATION absent' };

  const spec = PROVIDERS[provider];
  if (!spec) {
    return {
      ok: false,
      skipped: `EMAIL_PROVIDER inconnu : "${provider}" (attendu : ${Object.keys(PROVIDERS).join(' | ')})`,
    };
  }

  const payload = spec.body({ from, to, subject, html, text, replyTo });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(spec.url, {
      method: 'POST',
      headers: spec.headers(apiKey),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await res.text();
    let json;
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      json = { raw };
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: spec.error(json) || `${provider} a répondu ${res.status}`,
      };
    }
    return { ok: true, messageId: spec.messageId(json, res) };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      error: aborted ? `Délai dépassé après ${TIMEOUT_MS} ms` : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Email the sales team a full summary of the lead. */
export function sendLeadEmail(lead, config, { fetchImpl = fetch } = {}) {
  return send(
    {
      apiKey: config.apiKey,
      provider: config.provider,
      from: config.from,
      to: config.to,
      // The project is in the subject so the sales inbox is triageable at a
      // glance without opening anything.
      subject: `${config.subject} — ${describeProject(lead)}`,
      html: emailHtml(lead),
      text: emailText(lead),
      // Replying to the alert reaches the prospect directly.
      replyTo: lead.email,
    },
    fetchImpl,
  );
}

/**
 * Acknowledge the request to the prospect.
 *
 * Deliberately separate from the internal alert: it goes to a different
 * recipient, and if it fails the lead is still safely captured, so the caller
 * treats it as non-blocking.
 */
export function sendProspectConfirmation(lead, config, contact, { fetchImpl = fetch } = {}) {
  if (!config.confirmationEnabled) {
    return Promise.resolve({ ok: false, skipped: 'EMAIL_CONFIRMATION_ENABLED=false' });
  }
  return send(
    {
      apiKey: config.apiKey,
      provider: config.provider,
      from: config.from,
      to: [lead.email],
      subject: config.confirmationSubject,
      html: prospectEmailHtml(lead, contact),
      text: prospectEmailText(lead, contact),
      // A prospect who replies should reach the sales team, not a no-reply box.
      replyTo: config.replyTo || undefined,
    },
    fetchImpl,
  );
}

export const SUPPORTED_EMAIL_PROVIDERS = Object.keys(PROVIDERS);
