/**
 * The two admin HTML documents.
 *
 * They live as real .html files next to this module rather than as template
 * literals, so an editor treats them as markup and the client-side JavaScript
 * inside them needs no backtick gymnastics. They sit in lib/, which is outside
 * the static allow-list in server.js — the dashboard is never served as a file,
 * only through the authenticated handler.
 */

import { readFileSync } from 'node:fs';

import { escapeHtml } from './format.js';

// Read once. A deploy replaces the process, so there is nothing to invalidate.
const cache = new Map();
function page(name) {
  if (!cache.has(name)) cache.set(name, readFileSync(new URL(name, import.meta.url), 'utf8'));
  return cache.get(name);
}

/**
 * The console can be mounted somewhere other than /admin (ADMIN_PATH), so its
 * own URLs are injected rather than hard-coded. `{{BASE}}` is substituted
 * everywhere, including inside the client-side JavaScript.
 *
 * The value is validated in server.js before it reaches here — it can only
 * contain path-safe characters — so it needs no escaping beyond the quote
 * stripping below, which is belt and braces.
 */
const safeBase = (base) => String(base ?? '/admin').replace(/['"\\<>]/g, '');

export function loginPage(base = '/admin') {
  return page('admin-login.html').replaceAll('{{BASE}}', safeBase(base));
}

export function dashboardPage(username = '', base = '/admin') {
  return page('admin.html')
    .replaceAll('{{BASE}}', safeBase(base))
    .replace('{{USERNAME}}', escapeHtml(username));
}
