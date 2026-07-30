/**
 * Passenger / cPanel entry point.
 *
 * Set this file as the "Application startup file" in the LWS panel. It exists
 * for one reason: to make a failed boot legible. A cPanel panel usually shows
 * nothing but "Erreur" when the app does not come up, so this wrapper logs
 * every step to logs/startup.log before handing over to server.js.
 *
 * Deliberately self-contained — no static imports of project files, so a
 * problem anywhere in lib/ is caught and reported rather than crashing before
 * the handlers are installed. For the same reason it uses no top-level await,
 * which keeps the file loadable by `require()` as well as by `import`.
 *
 * If your Passenger build cannot load ESM at all (it reports ERR_REQUIRE_ESM),
 * use app.cjs instead — same behaviour, CommonJS syntax.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOG = join(ROOT, 'logs', 'startup.log');

function note(message) {
  const line = `[${new Date().toISOString()}] [app.js] ${message}`;
  try {
    console.log(line);
  } catch {
    /* stdout closed */
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

note(`démarrage — node ${process.version}, cwd ${process.cwd()}`);
note(`racine application ${ROOT}`);
note(`PORT ${process.env.PORT ? `= ${process.env.PORT}` : 'non défini (3000 par défaut)'}`);

// Dynamic import so a failure inside the module graph is catchable. A static
// import would be hoisted above the handlers above and above this logging.
import('./server.js')
  .then(() => note('server.js chargé'))
  .catch((err) => {
    note(`ÉCHEC du chargement de server.js: ${err?.code ?? ''} ${err?.message ?? err}`);
    note(String(err?.stack ?? ''));
    note(`détails complets dans ${LOG}`);
    // Re-throw so Passenger records the failure rather than serving a
    // half-started process.
    process.exitCode = 1;
    throw err;
  });
