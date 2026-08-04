/**
 * scripts/photos.mjs — l'import des photos.
 *
 * Ce script réécrit assets/villas.json, c'est-à-dire le contenu que les
 * prospects voient. Il tourne sur le poste de quelqu'un qui vient de déposer
 * vingt fichiers et veut les publier, pas sur le poste d'un développeur : une
 * erreur ici n'est pas rattrapée par une relecture.
 *
 * Ce qui est vérifié tient en trois idées :
 *
 *   - le dossier fait foi, mais les textes écrits à la main survivent ;
 *   - le srcset annonce les largeurs réelles des fichiers, pas des estimations ;
 *   - « staged » n'est jamais retourné tout seul. Passer une vraie photo de
 *     clients pour une mise en scène — ou l'inverse — est le seul défaut de ce
 *     script qui engagerait l'entreprise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Un PNG valide de la taille demandée, pour que la largeur lue soit vraie. */
function png(path, w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.concat(
    Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)])),
  );
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** Une copie jetable du projet, pour ne jamais écrire dans le vrai dépôt. */
function withProject(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gcitt-photos-'));
  try {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    cpSync(join(ROOT, 'assets/villas.json'), join(dir, 'assets/villas.json'));
    cpSync(join(ROOT, 'scripts/photos.mjs'), join(dir, 'scripts/photos.mjs'));

    const depose = (sousDossier, fichiers) => {
      const abs = join(dir, 'uploads/villas', sousDossier);
      mkdirSync(abs, { recursive: true });
      for (const [nom, w, h] of fichiers) png(join(abs, nom), w, h);
    };

    const lancer = (...args) =>
      execFileSync(process.execPath, [join(dir, 'scripts/photos.mjs'), ...args], {
        cwd: dir,
        encoding: 'utf8',
      });

    const lire = () => JSON.parse(readFileSync(join(dir, 'assets/villas.json'), 'utf8'));
    const ecrire = (data) =>
      writeFileSync(join(dir, 'assets/villas.json'), JSON.stringify(data, null, 2));

    const supprime = (chemin) => rmSync(join(dir, 'uploads/villas', chemin), { force: true });

    return fn({ depose, supprime, lancer, lire, ecrire });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const villaDe = (data, citeId, villaId) =>
  data.cites.find((c) => c.id === citeId).villas.find((v) => v.id === villaId);

test('sans --ecrire, rien n’est modifié', () => {
  withProject(({ depose, lancer, lire }) => {
    depose('coeur-joie/fenou', [['01-facade-avant.png', 1200, 800]]);
    const avant = JSON.stringify(lire());

    const sortie = lancer();
    assert.match(sortie, /simulation/);
    assert.equal(JSON.stringify(lire()), avant, 'le fichier ne doit pas bouger');
  });
});

test('les photos déposées deviennent la galerie, dans l’ordre des numéros', () => {
  withProject(({ depose, lancer, lire }) => {
    // Déposées dans le désordre : c'est le numéro qui décide, pas l'ordre du
    // système de fichiers.
    depose('coeur-joie/fenou', [
      ['03-sejour.png', 1200, 800],
      ['01-facade-avant.png', 1200, 800],
      ['02-terrasse.png', 1200, 800],
    ]);

    lancer('--ecrire');
    const fenou = villaDe(lire(), 'coeur-joie', 'fenou');

    assert.deepEqual(
      fenou.gallery.map((p) => p.caption),
      ['Façade avant', 'Terrasse', 'Séjour'],
    );
    // La première photo devient la vignette de la carte.
    assert.equal(fenou.card.src, 'uploads/villas/coeur-joie/fenou/01-facade-avant.png');
  });
});

test('les accents sont rétablis dans les légendes', () => {
  withProject(({ depose, lancer, lire }) => {
    depose('bethel/bethel-duplex', [
      ['01-remise-des-cles.png', 900, 600],
      ['02-vue-densemble.png', 900, 600],
      ['03-salle-de-bain.png', 900, 600],
    ]);

    lancer('--ecrire');
    const captions = villaDe(lire(), 'bethel', 'bethel-duplex').gallery.map((p) => p.caption);
    assert.deepEqual(captions, ['Remise des clés', 'Vue d’ensemble', 'Salle de bain']);
  });
});

test('un fichier -sm devient le srcset de son voisin, avec les largeurs réelles', () => {
  withProject(({ depose, lancer, lire }) => {
    depose('coeur-joie/kafui', [
      ['01-facade.png', 1600, 900],
      ['01-facade-sm.png', 480, 270],
    ]);

    lancer('--ecrire');
    const kafui = villaDe(lire(), 'coeur-joie', 'kafui');

    // Une seule entrée : la variante mobile n'est pas une photo de plus.
    assert.equal(kafui.gallery.length, 1);
    // Les largeurs sont lues dans les fichiers. Les annoncer de travers ferait
    // choisir la mauvaise image au navigateur.
    assert.equal(
      kafui.gallery[0].srcset,
      'uploads/villas/coeur-joie/kafui/01-facade-sm.png 480w, uploads/villas/coeur-joie/kafui/01-facade.png 1600w',
    );
  });
});

test('les légendes et textes alternatifs écrits à la main survivent', () => {
  withProject(({ depose, lancer, lire, ecrire }) => {
    depose('coeur-joie/fenou', [['01-facade-avant.png', 1200, 800]]);
    lancer('--ecrire');

    const data = lire();
    const fenou = villaDe(data, 'coeur-joie', 'fenou');
    fenou.gallery[0].caption = 'Façade sur rue, fin de journée';
    fenou.gallery[0].alt = 'La Villa Fenou F4 vue depuis la rue, au coucher du soleil';
    ecrire(data);

    // Deuxième passage : le script ne doit rien écraser.
    lancer('--ecrire');
    const apres = villaDe(lire(), 'coeur-joie', 'fenou').gallery[0];
    assert.equal(apres.caption, 'Façade sur rue, fin de journée');
    assert.equal(apres.alt, 'La Villa Fenou F4 vue depuis la rue, au coucher du soleil');
  });
});

test('retirer une photo du dossier la retire de la galerie', () => {
  withProject(({ depose, supprime, lancer, lire }) => {
    depose('coeur-joie/fenou', [
      ['01-facade.png', 1200, 800],
      ['02-sejour.png', 1200, 800],
      ['03-cuisine.png', 1200, 800],
    ]);
    lancer('--ecrire');
    assert.equal(villaDe(lire(), 'coeur-joie', 'fenou').gallery.length, 3);

    // Le dossier est la source, pas une pile où l'on empile : une photo
    // retirée du disque doit disparaître de la galerie, sinon le JSON
    // référencerait un fichier absent et la page afficherait un vide.
    supprime('coeur-joie/fenou/02-sejour.png');
    lancer('--ecrire');

    const fenou = villaDe(lire(), 'coeur-joie', 'fenou');
    assert.equal(fenou.gallery.length, 2);
    assert.deepEqual(fenou.gallery.map((p) => p.caption), ['Façade', 'Cuisine']);
  });
});

test('« staged » n’est jamais retourné par le script', () => {
  withProject(({ depose, lancer, lire, ecrire }) => {
    depose('coeur-joie/fenou', [['01-facade.png', 1200, 800]]);
    depose('familles/fenou', [['01-remise-des-cles.png', 1200, 800]]);

    // Premier passage : rien n'est déclaré, on annonce une mise en scène.
    // C'est la valeur prudente — jamais l'inverse.
    lancer('--ecrire');
    assert.equal(villaDe(lire(), 'coeur-joie', 'fenou').family.staged, true);

    // L'équipe déclare une vraie photo, publiée avec accord écrit.
    const data = lire();
    villaDe(data, 'coeur-joie', 'fenou').family.staged = false;
    ecrire(data);

    // Un nouveau passage ne doit pas la réétiqueter « mise en scène » : la
    // page afficherait alors une mention fausse sous une photo de vrais
    // clients, sans que personne ne relance le script pour s'en apercevoir.
    lancer('--ecrire');
    assert.equal(villaDe(lire(), 'coeur-joie', 'fenou').family.staged, false);
  });
});

test('le résultat reste valide pour la page', () => {
  withProject(({ depose, lancer, lire }) => {
    depose('coeur-joie/cite', [['01-vue-aerienne.png', 1600, 900]]);
    depose('coeur-joie/fenou', [['01-facade.png', 1200, 800]]);
    lancer('--ecrire');

    const data = lire();
    for (const cite of data.cites) {
      for (const v of cite.villas) {
        assert.ok(v.formValue, 'formValue ne doit jamais être perdu');
        assert.ok(v.price, 'price ne doit jamais être perdu');
        assert.ok(Array.isArray(v.specs) && v.specs.length, 'specs ne doit jamais être perdu');
        for (const img of v.gallery) {
          assert.ok(img.alt, 'chaque photo garde un texte alternatif');
        }
      }
    }
  });
});
