/**
 * Sliding-window rate limiter.
 *
 * The default store is in-process, which on serverless means the limit applies
 * per warm instance rather than globally — it raises the cost of a flood
 * without being an absolute cap. It is the second of three anti-spam layers
 * (honeypot, fill-time, rate limit), not the only one.
 *
 * To make the limit global, pass a store backed by Redis or similar:
 * createRateLimiter({ store: myStore }) where the store implements
 * get(key) -> number[] and set(key, timestamps).
 */

const MAX_TRACKED_KEYS = 10_000;

function createMemoryStore() {
  const hits = new Map();
  return {
    get: (key) => hits.get(key),
    set(key, timestamps) {
      // Bound memory: a hostile caller rotating IPs must not grow the map
      // without limit. Map preserves insertion order, so the oldest key is
      // first.
      if (!hits.has(key) && hits.size >= MAX_TRACKED_KEYS) {
        hits.delete(hits.keys().next().value);
      }
      hits.set(key, timestamps);
    },
    delete: (key) => hits.delete(key),
    get size() {
      return hits.size;
    },
  };
}

export function createRateLimiter({ max = 5, windowMs = 600_000, store = createMemoryStore() } = {}) {
  return {
    /**
     * @returns {{allowed: boolean, remaining: number, retryAfterMs: number}}
     */
    check(key, now = Date.now()) {
      const cutoff = now - windowMs;
      const recent = (store.get(key) ?? []).filter((t) => t > cutoff);

      if (recent.length >= max) {
        store.set(key, recent);
        const retryAfterMs = Math.max(0, recent[0] + windowMs - now);
        return { allowed: false, remaining: 0, retryAfterMs };
      }

      recent.push(now);
      store.set(key, recent);
      return { allowed: true, remaining: max - recent.length, retryAfterMs: 0 };
    },
    store,
  };
}

/**
 * Best-effort client IP.
 *
 * X-Forwarded-For is only trustworthy behind a proxy that overwrites it —
 * true on Vercel, and true behind any correctly configured reverse proxy. The
 * leftmost entry is the client as seen by the edge.
 */
export function clientIp(headers, fallback = 'unknown') {
  const get = (name) =>
    typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];

  const forwarded = get('x-forwarded-for');
  if (forwarded) {
    const first = String(forwarded).split(',')[0].trim();
    if (first) return first;
  }
  return get('x-real-ip') || get('cf-connecting-ip') || fallback;
}
