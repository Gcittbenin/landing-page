/**
 * CommonJS fallback entry point.
 *
 * Identical in purpose and behaviour to app.js. Use this one if the Passenger
 * build on the host cannot load an ES module and reports ERR_REQUIRE_ESM — the
 * .cjs extension forces CommonJS regardless of "type": "module" in
 * package.json.
 *
 * Node 22 can require() an ES module directly, so app.js normally works and
 * this file is only insurance against an older loader.
 *
 * See app.js for the full explanation of how Passenger starts a Node
 * application and why the watchdog below exists. In short: Passenger does not
 * import an exported app object — it patches `http.Server.prototype.listen`
 * and treats the call as the start signal. If `listen()` is never reached,
 * Passenger waits rather than failing, holding the browser's connection open
 * until its own timeout, which a visitor sees as ERR_CONNECTION_TIMED_OUT.
 */

'use strict';

const { appendFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const http = require('node:http');

const ROOT = __dirname;
const LOG = join(ROOT, 'logs', 'startup.log');

/** How long to wait for listen() before declaring the boot failed. */
const LISTEN_TIMEOUT_MS = Number(process.env.STARTUP_TIMEOUT_MS) || 20000;

function note(message) {
  const line = `[${new Date().toISOString()}] [app.cjs] ${message}`;
  try {
    console.log(line);
  } catch (e) {
    /* stdout closed by the process manager */
  }
  try {
    mkdirSync(join(ROOT, 'logs'), { recursive: true });
    appendFileSync(LOG, line + '\n');
  } catch (e) {
    /* read-only filesystem — console only */
  }
}

process.on('uncaughtException', (err) => {
  note(`uncaughtException: ${(err && err.code) || ''} ${(err && err.message) || err}`);
  note(String((err && err.stack) || ''));
});
process.on('unhandledRejection', (err) => {
  note(`unhandledRejection: ${(err && err.code) || ''} ${(err && err.message) || err}`);
  note(String((err && err.stack) || ''));
});

// ── Environment ─────────────────────────────────────────────────────────────

note(`démarrage — node ${process.version}, cwd ${process.cwd()}`);
note(`racine application ${ROOT}`);
note(`PORT ${process.env.PORT ? `= ${process.env.PORT}` : 'non défini (3000 par défaut)'}`);

const passengerVars = Object.keys(process.env).filter((k) => k.indexOf('PASSENGER') === 0);
const underPassenger = passengerVars.length > 0 || 'PHUSION_PASSENGER' in process.env;
note(
  underPassenger
    ? `exécuté sous Passenger (${passengerVars.join(', ') || 'variables détectées'})`
    : "aucune variable Passenger détectée — l'application semble lancée hors Passenger",
);

// ── Watch listen() ──────────────────────────────────────────────────────────

let listening = false;
let watchdog = null;

const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function patchedListen() {
  // The *call* is what Passenger treats as the start signal, so it is also
  // what clears the watchdog. Waiting for the 'listening' event instead would
  // risk killing a perfectly healthy application if Passenger's own patched
  // listen() never emits it.
  listening = true;
  if (watchdog) clearTimeout(watchdog);

  const result = originalListen.apply(this, arguments);
  const server = this;

  server.once('listening', function () {
    const address = server.address();
    const where =
      typeof address === 'string'
        ? `socket ${address}`
        : address
          ? `${address.address}:${address.port} (${address.family})`
          : 'adresse inconnue';
    note(`listen() effectif sur ${where}`);
  });

  return result;
};

watchdog = setTimeout(function () {
  if (listening) return;
  note(`ÉCHEC : listen() n'a pas été atteint en ${LISTEN_TIMEOUT_MS} ms.`);
  note('Passenger attendrait indéfiniment et le navigateur afficherait un délai dépassé.');
  note("Causes usuelles : une exception pendant le chargement de server.js (voir plus haut),");
  note('un PORT refusé par l’hébergeur, ou une variable d’environnement manquante.');
  process.exit(1);
}, LISTEN_TIMEOUT_MS);

// ── Load the application ────────────────────────────────────────────────────

// import() works from CommonJS and is the supported way to load ESM here.
import(pathToFileURL(join(ROOT, 'server.js')).href)
  .then(function () {
    note('server.js chargé');
  })
  .catch(function (err) {
    note(`ÉCHEC du chargement de server.js: ${(err && err.code) || ''} ${(err && err.message) || err}`);
    note(String((err && err.stack) || ''));
    note(`détails complets dans ${LOG}`);
    if (watchdog) clearTimeout(watchdog);
    process.exit(1);
  });
