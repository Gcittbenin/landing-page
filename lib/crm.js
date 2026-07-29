/**
 * CRM forwarding — the placeholder for the future CRM connection.
 *
 * Rather than committing to a vendor now, the lead is POSTed as JSON to
 * CRM_WEBHOOK_URL. That endpoint can be a CRM's native webhook, a Zapier/Make
 * catch hook, or a small adapter of your own. Swap the body shape here when
 * the CRM is chosen; nothing else in the codebase needs to change.
 */

const TIMEOUT_MS = 8_000;

export async function forwardToCrm(lead, config, { fetchImpl = fetch } = {}) {
  const { webhookUrl, token } = config;
  if (!webhookUrl) return { ok: false, skipped: 'CRM_WEBHOOK_URL absent' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ source: 'landing-page-gcitt', lead }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, error: `CRM a répondu ${res.status}` };
    return { ok: true };
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
