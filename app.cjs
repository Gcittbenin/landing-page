/**
 * CommonJS fallback entry point.
 *
 * Identical in purpose to app.js. Use this one if the Passenger build on the
 * host cannot load an ES module and reports ERR_REQUIRE_ESM — the .cjs
 * extension forces CommonJS regardless of "type": "module" in package.json.
 *
 * Node 22 can require() an ES module directly, so app.js normally works and
 * this file is only insurance against an older loader.
 */

'use strict';

const { appendFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = __dirname;
const LOG = join(ROOT, 'logs', 'startup.log');

function note(message) {
  const line = `[${new Date().toISOString()}] [app.cjs] ${message}`;
  try {
    console.log(line);
  } catch (e) {
    /* stdout closed */
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

note(`démarrage — node ${process.version}, cwd ${process.cwd()}`);
note(`racine application ${ROOT}`);
note(`PORT ${process.env.PORT ? `= ${process.env.PORT}` : 'non défini (3000 par défaut)'}`);

// import() works from CommonJS and is the supported way to load ESM here.
import(pathToFileURL(join(ROOT, 'server.js')).href)
  .then(() => note('server.js chargé'))
  .catch((err) => {
    note(`ÉCHEC du chargement de server.js: ${(err && err.code) || ''} ${(err && err.message) || err}`);
    note(String((err && err.stack) || ''));
    note(`détails complets dans ${LOG}`);
    process.exitCode = 1;
  });
