/**
 * Startup diagnostics.
 *
 * cPanel/Passenger panels frequently report a failed boot as nothing more than
 * "Erreur", with stdout discarded. So every startup step is also appended to
 * logs/startup.log inside the application root, which survives whatever the
 * panel does with the process output.
 *
 * Nothing here ever logs a secret: only whether a variable is set.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = join(ROOT, 'logs');
const LOG_FILE = join(LOG_DIR, 'startup.log');

let fileLoggingBroken = false;

/**
 * Append a line to logs/startup.log and echo it to stdout.
 *
 * Never throws: a read-only filesystem or a missing permission must not be
 * the thing that stops the site from starting.
 */
export function logStartup(message, extra) {
  const line =
    `[${new Date().toISOString()}] ${message}` +
    (extra ? ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : '');

  try {
    console.log(`[startup] ${line}`);
  } catch {
    /* stdout closed by the process manager */
  }

  if (fileLoggingBroken) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // Say so once, then stop trying.
    fileLoggingBroken = true;
    try {
      console.warn(`[startup] logs/startup.log non accessible en écriture — logs console uniquement`);
    } catch {
      /* ignore */
    }
  }
}

/** Where the log is, so messages can point at it. */
export const STARTUP_LOG_PATH = LOG_FILE;

/**
 * A one-line summary of what is configured, for the boot log.
 *
 * Booleans only — this is written to a file inside the web root, so it must
 * never contain a token, a key or an address.
 */
export function environmentSummary(env = process.env) {
  const has = (name) => Boolean((env[name] ?? '').toString().trim());
  return {
    node: process.version,
    nodeEnv: env.NODE_ENV || '(non défini)',
    port: env.PORT ? `fourni par l'hébergeur (${env.PORT})` : 'absent → 3000 par défaut',
    cwd: process.cwd(),
    appRoot: ROOT,
    whatsapp: has('META_WHATSAPP_TOKEN') && has('META_PHONE_NUMBER_ID'),
    whatsappTemplate: has('META_WHATSAPP_TEMPLATE_NAME'),
    email: has('EMAIL_API_KEY') && has('EMAIL_DESTINATION'),
    crm: has('CRM_WEBHOOK_URL'),
    allowedOrigins: has('ALLOWED_ORIGINS'),
    trustProxy: (env.TRUST_PROXY ?? 'true').toLowerCase() !== 'false',
  };
}

/**
 * Turn a module-loading failure into something actionable.
 *
 * The interesting part of an import error is which specifier failed and from
 * where, and Node buries that in the stack.
 */
export function describeStartupError(err) {
  const lines = [
    `type    : ${err?.constructor?.name ?? typeof err}`,
    `code    : ${err?.code ?? '(aucun)'}`,
    `message : ${err?.message ?? String(err)}`,
  ];

  if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
    lines.push(
      'cause probable : un fichier manque sur le serveur. Vérifiez que lib/, api/ et',
      '                 vendor/ ont bien été envoyés avec la même arborescence.',
    );
  }
  if (err?.code === 'ERR_REQUIRE_ESM') {
    lines.push(
      'cause probable : le chargeur utilise require() sur un module ESM. Passez le',
      '                 fichier de démarrage à app.cjs.',
    );
  }
  if (err?.code === 'EADDRINUSE') {
    lines.push(
      'cause probable : le port est déjà occupé. Sous Passenger, ne lancez pas',
      "                 l'application à la main : elle est déjà démarrée.",
    );
  }
  if (err?.code === 'EACCES') {
    lines.push(
      "cause probable : l'hébergement interdit d'ouvrir ce port. Laissez PORT vide",
      '                 et laissez Passenger fournir le sien.',
    );
  }
  if (err?.stack) lines.push('', String(err.stack));
  return lines.join('\n');
}
