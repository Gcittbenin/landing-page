/**
 * Lead validation and normalisation.
 *
 * Everything crossing this boundary is attacker-controlled. The rule is
 * allow-list only: fields we do not know are dropped, fields we do know are
 * length-capped, and the enumerated fields must match a known value.
 */

export const CITES = ['Cœur Joie', 'Bethel'];

export const VILLA_TYPES = ['F4', 'Duplex', 'Autre'];

export const VILLAS = [
  'Villa Fenou (F4)',
  'Villa Kafui (Duplex)',
  'Villa Bethel (F4)',
  'Villa Bethel (Duplex)',
  'Je ne sais pas encore',
];

/** Which cité and villa type each catalogue entry belongs to. */
export const VILLA_INDEX = {
  'Villa Fenou (F4)': { cite: 'Cœur Joie', type: 'F4' },
  'Villa Kafui (Duplex)': { cite: 'Cœur Joie', type: 'Duplex' },
  'Villa Bethel (F4)': { cite: 'Bethel', type: 'F4' },
  'Villa Bethel (Duplex)': { cite: 'Bethel', type: 'Duplex' },
};

const MAX = {
  name: 80,
  email: 160,
  phone: 24,
  message: 2000,
  short: 60,
  url: 300,
};

// Deliberately permissive but anchored: we are filtering typos and junk, not
// trying to out-parse RFC 5322.
const EMAIL_RE = /^[^\s@,;:<>()[\]\\]+@[^\s@.,;:<>()[\]\\]+(\.[^\s@.,;:<>()[\]\\]+)+$/;

// C0 and C1 control characters. \t \n \r are excluded here and handled
// per-field, since the message body is allowed to keep its line breaks.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Strip control characters, collapse runs of whitespace, trim, cap length. */
function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Same as clean() but keeps newlines, for the free-text message field. */
function cleanMultiline(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(CONTROL_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/**
 * Normalise a phone number to digits with a leading '+'.
 * Local Beninese numbers (no country code) are given the +229 prefix.
 */
export function normalisePhone(raw) {
  const trimmed = clean(raw, MAX.phone);
  if (!trimmed) return '';
  const hadPlus = trimmed.startsWith('+') || trimmed.startsWith('00');
  const digits = trimmed.replace(/\D/g, '').replace(/^00/, '');
  if (!digits) return '';
  if (hadPlus) return `+${digits}`;
  // 8-10 bare digits is a domestic Benin number; anything longer already
  // carries its own country code.
  return digits.length <= 10 ? `+229${digits}` : `+${digits}`;
}

const oneOf = (value, allowed) => {
  const v = clean(value, MAX.short);
  return allowed.includes(v) ? v : '';
};

/**
 * Validate a raw submission body.
 *
 * @returns {{ok: true, lead: object} | {ok: false, errors: Record<string,string>, spam?: boolean}}
 */
export function validateLead(body, { now = Date.now(), minFillMs = 0 } = {}) {
  const errors = {};
  const input = body && typeof body === 'object' ? body : {};

  const firstName = clean(input.firstName, MAX.name);
  if (firstName.length < 2) errors.firstName = 'Le prénom est requis.';

  const lastName = clean(input.lastName, MAX.name);
  if (lastName.length < 2) errors.lastName = 'Le nom est requis.';

  const email = clean(input.email, MAX.email).toLowerCase();
  if (!EMAIL_RE.test(email)) errors.email = 'Une adresse email valide est requise.';

  const phone = normalisePhone(input.phone);
  const phoneDigits = phone.replace(/\D/g, '').length;
  // +229 plus 8 digits is the shortest real number we expect; 15 digits is the
  // E.164 ceiling.
  if (phoneDigits < 8 || phoneDigits > 15) {
    errors.phone = 'Un numéro WhatsApp valide est requis.';
  }

  const villa = oneOf(input.villa, VILLAS);
  const known = VILLA_INDEX[villa];

  // The cité and villa type are implied by the catalogue entry. Trust the
  // catalogue over whatever the client sent, and only fall back to the
  // submitted values when the prospect did not pick a specific villa.
  const cite = known ? known.cite : oneOf(input.cite, CITES);
  const villaType = known ? known.type : oneOf(input.villaType, VILLA_TYPES);

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // Anti-spam: a form submitted faster than a person can type is a bot. This
  // runs after field validation so a slow human with a typo still gets a
  // useful error rather than a spam rejection.
  const openedAt = Number(input.formOpenedAt);
  if (minFillMs > 0 && Number.isFinite(openedAt) && openedAt > 0) {
    const elapsed = now - openedAt;
    // A negative elapsed time means a forged clock — treat it as suspicious.
    if (elapsed < minFillMs) {
      return { ok: false, errors: { _spam: 'Soumission trop rapide.' }, spam: true };
    }
  }

  return {
    ok: true,
    lead: {
      firstName,
      lastName,
      // Kept so the WhatsApp alert, the emails and the CRM all have one
      // display name without re-joining it in four places.
      name: `${firstName} ${lastName}`.trim(),
      email,
      phone,
      country: clean(input.country, MAX.short),
      cite,
      villa,
      villaType,
      delai: clean(input.delai, MAX.short),
      budget: clean(input.budget, MAX.short),
      message: cleanMultiline(input.message, MAX.message),
      source: clean(input.source, MAX.short) || 'Direct',
      sourceDetail: clean(input.sourceDetail, MAX.url),
      // Raw UTM parameters, kept alongside the resolved `source` label so
      // campaign reporting can join on the exact values the ad platform sent.
      utmSource: clean(input.utmSource, MAX.short),
      utmMedium: clean(input.utmMedium, MAX.short),
      utmCampaign: clean(input.utmCampaign, MAX.short),
      utmContent: clean(input.utmContent, MAX.short),
      utmTerm: clean(input.utmTerm, MAX.short),
      // Ad-platform click identifier (gclid / fbclid / ttclid), for offline
      // conversion import back into the ad account.
      clickId: clean(input.clickId, MAX.url),
      pageUrl: clean(input.pageUrl, MAX.url),
      screen: clean(input.screen, MAX.short),
      timezone: clean(input.timezone, MAX.short),
      language: clean(input.language, MAX.short),
      // Server-authoritative: a client-supplied timestamp is not evidence.
      submittedAt: new Date(now).toISOString(),
    },
  };
}

/** True when the honeypot field was filled — i.e. the submitter is a bot. */
export function isHoneypotTripped(body) {
  const value = body && typeof body === 'object' ? body.website : '';
  return typeof value === 'string' && value.trim().length > 0;
}
