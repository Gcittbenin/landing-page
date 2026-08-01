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

export function loginPage() {
  return page('admin-login.html');
}

export function dashboardPage(username = '') {
  return page('admin.html').replace('{{USERNAME}}', escapeHtml(username));
}
