/**
 * Passenger / cPanel entry point.
 *
 * Set this file as the "Application startup file" in the LWS panel.
 *
 * ── How Passenger starts a Node application ────────────────────────────────
 *
 * Passenger does **not** import an exported app object, and there is nothing
 * to `export` here. Its Node loader patches `http.Server.prototype.listen`,
 * loads this file, and considers the application started the moment `listen()`
 * is called — whatever port is requested. Passenger then discards that port
 * and binds its own Unix socket, which is why `process.env.PORT` matters far
 * less under Passenger than the fact that `listen()` happens at all.
 *
 * The practical consequence, and the reason for the watchdog below: if
 * `listen()` is never reached, Passenger does not fail — it *waits*, holding
 * the browser's connection open until its own startup timeout expires. From a
 * visitor's side that is not an error page, it is `ERR_CONNECTION_TIMED_OUT`.
 * A silent hang is therefore the failure mode worth engineering against.
 *
 * ── What this file does ────────────────────────────────────────────────────
 *
 *  1. Installs error handlers before anything else loads.
 *  2. Records whether it is running under Passenger, and what it was given.
 *  3. Watches `listen()` and logs the address actually bound.
 *  4. Fails loudly, and quickly, if `listen()` never happens.
 *
 * Deliberately self-contained: no static import of project files, so a problem
 * anywhere in lib/ is reported rather than crashing before the handlers exist.
 * No top-level await either, which keeps the file loadable by `require()` as
 * well as by `import`.
 *
 * If the Passenger build on the host cannot load ESM at all (it reports
 * ERR_REQUIRE_ESM), use app.cjs instead — identical behaviour, CommonJS.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOG = join(ROOT, 'logs', 'startup.log');

/** How long to wait for listen() before declaring the boot failed. */
const LISTEN_TIMEOUT_MS = Number(process.env.STARTUP_TIMEOUT_MS) || 20000;

function note(message) {
  const line = `[${new Date().toISOString()}] [app.js] ${message}`;
  try {
    console.log(line);
  } catch {
    /* stdout closed by the process manager */
  }
  try {
    mkdirSync(join(ROOT, 'logs'), { recursive: true });
    appendFileSync(LOG, line + '\n');
  } catch {
    /* read-only filesystem — console only */
  }
}

// Installed before anything else loads, so nothing can fail unobserved.
process.on('uncaughtException', (err) => {
  note(`uncaughtException: ${err?.code ?? ''} ${err?.message ?? err}`);
  note(String(err?.stack ?? ''));
});
process.on('unhandledRejection', (err) => {
  note(`unhandledRejection: ${err?.code ?? ''} ${err?.message ?? err}`);
  note(String(err?.stack ?? ''));
});

// ── Environment ─────────────────────────────────────────────────────────────

note(`démarrage — node ${process.version}, cwd ${process.cwd()}`);
note(`racine application ${ROOT}`);
note(`PORT ${process.env.PORT ? `= ${process.env.PORT}` : 'non défini (3000 par défaut)'}`);

/**
 * Are we actually running under Passenger?
 *
 * Worth knowing: if this says no while the panel claims the application is
 * started, the panel is running the app as a plain background process and
 * Apache is not forwarding anything to it — which looks exactly like a
 * timeout from outside.
 */
const passengerVars = Object.keys(process.env).filter((k) => k.startsWith('PASSENGER'));
const underPassenger = passengerVars.length > 0 || 'PHUSION_PASSENGER' in process.env;
note(
  underPassenger
    ? `exécuté sous Passenger (${passengerVars.join(', ') || 'variables détectées'})`
    : "aucune variable Passenger détectée — l'application semble lancée hors Passenger",
);

// ── Watch listen() ──────────────────────────────────────────────────────────

let listening = false;
let watchdog = null;

// Passenger patches this same method; wrapping it here observes the call
// whether or not the patch is in place, and reports what was really bound.
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function patchedListen(...args) {
  // The *call* is what Passenger treats as the start signal, so it is also
  // what clears the watchdog. Waiting for the 'listening' event instead would
  // risk killing a perfectly healthy application if Passenger's own patched
  // listen() never emits it.
  listening = true;
  if (watchdog) clearTimeout(watchdog);

  const result = originalListen.apply(this, args);

  this.once('listening', () => {
    const address = this.address();
    const where =
      typeof address === 'string'
        ? `socket ${address}`
        : address
          ? `${address.address}:${address.port} (${address.family})`
          : 'adresse inconnue';
    // Under Passenger this is the hijacked Unix socket, not the requested
    // port — seeing that here is the proof that Passenger took the handover.
    note(`listen() effectif sur ${where}`);
  });

  return result;
};

/**
 * The watchdog.
 *
 * Without it, a boot that never reaches `listen()` leaves Passenger waiting
 * and the visitor staring at a timeout with nothing written anywhere. Exiting
 * makes Passenger report a spawn failure, which the panel and the Apache error
 * log both surface.
 */
watchdog = setTimeout(() => {
  if (listening) return;
  note(`ÉCHEC : listen() n'a pas été atteint en ${LISTEN_TIMEOUT_MS} ms.`);
  note('Passenger attendrait indéfiniment et le navigateur afficherait un délai dépassé.');
  note("Causes usuelles : une exception pendant le chargement de server.js (voir plus haut),");
  note('un PORT refusé par l’hébergeur, ou une variable d’environnement manquante.');
  process.exit(1);
}, LISTEN_TIMEOUT_MS);

// ── Load the application ────────────────────────────────────────────────────

// Dynamic import so a failure inside the module graph is catchable. A static
// import would be hoisted above the handlers and the logging above.
import('./server.js')
  .then(() => note('server.js chargé'))
  .catch((err) => {
    note(`ÉCHEC du chargement de server.js: ${err?.code ?? ''} ${err?.message ?? err}`);
    note(String(err?.stack ?? ''));
    note(`détails complets dans ${LOG}`);
    if (watchdog) clearTimeout(watchdog);
    // Exit rather than linger: a process that will never listen must fail
    // visibly, not hold Passenger — and through it the visitor — waiting.
    process.exit(1);
  });
