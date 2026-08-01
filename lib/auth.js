/**
 * Admin authentication.
 *
 * Guards every prospect's name, phone number and email, so the defaults are
 * deliberately strict:
 *
 *  - No password configured means the whole admin area is switched off and
 *    answers 404. An accidentally-deployed dashboard is worse than none.
 *  - The password is stored as an scrypt hash. ADMIN_PASSWORD is accepted for
 *    convenience and hashed at boot, but never compared in clear.
 *  - The session cookie carries an HMAC of its own payload. A forged cookie
 *    cannot be produced without ADMIN_SESSION_SECRET.
 *  - Comparisons are timing-safe.
 *  - Failed logins are rate-limited per IP.
 *
 * node:crypto only — no dependency.
 */

import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHmac,
} from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // one working day
const COOKIE = 'gcitt_admin';

/** "salt:hash", both hex. */
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `${salt}:${derived.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  let derived;
  try {
    derived = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  } catch {
    return false;
  }
  const expectedBuf = Buffer.from(expected, 'hex');
  if (expectedBuf.length !== derived.length) return false;
  return timingSafeEqual(derived, expectedBuf);
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function createAuth(env = process.env) {
  const explicitHash = (env.ADMIN_PASSWORD_HASH ?? '').trim();
  const plain = (env.ADMIN_PASSWORD ?? '').trim();

  // Hashing at boot keeps the clear password out of every later comparison.
  const passwordHash = explicitHash || (plain ? hashPassword(plain) : '');

  // Without an explicit secret, sessions are signed with a per-boot random
  // key: everyone is logged out on restart, which is the safe failure.
  const secret = (env.ADMIN_SESSION_SECRET ?? '').trim() || randomBytes(32).toString('hex');
  const user = (env.ADMIN_USERNAME ?? 'admin').trim();
  const enabled = Boolean(passwordHash);

  const sign = (payload) => createHmac('sha256', secret).update(payload).digest();

  return {
    enabled,
    username: user,

    /** Why the admin is off, for the boot log. Never leaks the password. */
    status() {
      if (!enabled) return 'désactivé (ADMIN_PASSWORD non défini)';
      return env.ADMIN_SESSION_SECRET
        ? 'actif'
        : 'actif (ADMIN_SESSION_SECRET absent : sessions invalidées à chaque redémarrage)';
    },

    check(username, password) {
      if (!enabled) return false;
      // Compare the username in constant time too, so it cannot be probed.
      const a = Buffer.from(String(username ?? ''));
      const b = Buffer.from(user);
      const sameUser = a.length === b.length && timingSafeEqual(a, b);
      // Always run the hash, so a wrong username is not measurably faster.
      const samePass = verifyPassword(String(password ?? ''), passwordHash);
      return sameUser && samePass;
    },

    issue() {
      const expires = Date.now() + SESSION_TTL_MS;
      const payload = b64u(JSON.stringify({ u: user, e: expires }));
      return `${payload}.${b64u(sign(payload))}`;
    },

    verify(token) {
      if (typeof token !== 'string' || !token.includes('.')) return null;
      const [payload, mac] = token.split('.');
      let given;
      try {
        given = Buffer.from(mac, 'base64url');
      } catch {
        return null;
      }
      const expected = sign(payload);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

      let data;
      try {
        data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (!data || typeof data.e !== 'number' || Date.now() > data.e) return null;
      return { username: data.u };
    },

    cookieName: COOKIE,

    /**
     * Secure defaults. SameSite=Strict is the CSRF control: the browser will
     * not attach this cookie to a request originated by another site.
     */
    cookie(token, { secure = true } = {}) {
      const parts = [
        `${COOKIE}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ];
      if (secure) parts.push('Secure');
      return parts.join('; ');
    },

    clearCookie({ secure = true } = {}) {
      const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
      if (secure) parts.push('Secure');
      return parts.join('; ');
    },
  };
}

/** Read one cookie out of a Cookie header. */
export function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
