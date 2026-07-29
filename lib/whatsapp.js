/**
 * WhatsApp Business Cloud API (Meta Graph API) notification channel.
 *
 * ── Template vs free-form ────────────────────────────────────────────────────
 * Meta only allows a free-form text message when the recipient has messaged
 * the business number within the last 24 hours. The GCITT sales line will not
 * normally have done so, which means a business-initiated alert needs an
 * approved message template.
 *
 * So: if META_WHATSAPP_TEMPLATE_NAME is set we send the template. Otherwise we
 * send free-form text, which works while testing and inside an open 24h
 * window, and fails with a clear, logged Meta error code outside one.
 *
 * docs/WHATSAPP.md has the exact template body to submit for approval.
 */

import { whatsappText, whatsappTemplateParams } from './format.js';

const TIMEOUT_MS = 10_000;

/** Meta error codes meaning "no open session, a template is required". */
const NEEDS_TEMPLATE = new Set([131047, 131026, 470]);

function buildTemplatePayload(to, lead, { templateName, templateLanguage }) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLanguage },
      components: [
        {
          type: 'body',
          parameters: whatsappTemplateParams(lead).map((text) => ({ type: 'text', text })),
        },
      ],
    },
  };
}

function buildTextPayload(to, lead) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { preview_url: false, body: whatsappText(lead) },
  };
}

/**
 * Send the new-prospect alert to the GCITT sales number.
 *
 * Never throws: a notification failure must not cost us the lead. The caller
 * records the result and still returns success to the prospect.
 *
 * @returns {Promise<{ok: boolean, skipped?: string, messageId?: string, error?: string, code?: number, status?: number}>}
 */
export async function sendWhatsAppAlert(lead, config, { fetchImpl = fetch } = {}) {
  const { token, phoneNumberId, salesNumber, apiVersion, templateName } = config;

  if (!token || !phoneNumberId) {
    return { ok: false, skipped: 'META_WHATSAPP_TOKEN / META_PHONE_NUMBER_ID absents' };
  }
  if (!salesNumber) {
    return { ok: false, skipped: 'GCITT_SALES_WHATSAPP absent' };
  }

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const payload = templateName
    ? buildTemplatePayload(salesNumber, lead, config)
    : buildTextPayload(salesNumber, lead);

  const post = async (body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }
      return { res, json };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const { res, json } = await post(payload);

    // Free-form rejected for want of an open session: retry as a template if
    // one happens to be configured. (Only reachable when the first attempt was
    // free-form, so this cannot loop.)
    const code = json?.error?.code;
    if (!res.ok && !templateName && NEEDS_TEMPLATE.has(code)) {
      return {
        ok: false,
        status: res.status,
        code,
        error:
          'Fenêtre de 24h fermée : un template approuvé par Meta est requis. ' +
          'Renseignez META_WHATSAPP_TEMPLATE_NAME (voir docs/WHATSAPP.md).',
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        code,
        error: json?.error?.message || `Meta a répondu ${res.status}`,
      };
    }

    return { ok: true, messageId: json?.messages?.[0]?.id };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      error: aborted ? `Délai dépassé après ${TIMEOUT_MS} ms` : String(err?.message || err),
    };
  }
}
