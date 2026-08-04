/**
 * Importe les photos déposées dans uploads/villas/ vers assets/villas.json.
 *
 *   npm run photos           affiche ce qui serait fait, sans rien écrire
 *   npm run photos -- --ecrire   applique
 *
 * ── Pourquoi ce script existe ──────────────────────────────────────────────
 *
 * Ajouter une photo demandait deux gestes : déposer le fichier, puis écrire
 * son chemin dans le JSON. Le second se perd — on dépose vingt photos et on en
 * déclare douze, ou on recopie un chemin de travers et la carte reste vide.
 * Ici le dossier fait foi : ce qui est sur le disque est ce qui s'affiche.
 *
 * Ce qui est écrit à la main n'est jamais écrasé. Une légende ou un texte
 * alternatif rédigé par l'équipe est conservé tel quel ; le script ne remplit
 * que ce qui manque, et se contente de deviner à partir du nom du fichier.
 * Retirer une photo du dossier la retire de la galerie — c'est voulu : le
 * dossier est la source, pas une pile où l'on empile.
 *
 * ── Nommage ────────────────────────────────────────────────────────────────
 *
 *   01-facade-avant.jpg      → légende « Façade avant », affichée en 1er
 *   02-sejour.jpg            → « Séjour »
 *   03-remise-des-cles.jpg   → « Remise des clés »
 *
 * Le numéro décide de l'ordre. Un fichier suffixé « -sm » est reconnu comme la
 * variante mobile de son voisin et devient son srcset au lieu d'une entrée à
 * part.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const JSON_PATH = join(ROOT, 'assets/villas.json');
const PHOTOS = 'uploads/villas';
const EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

const ecrire = process.argv.includes('--ecrire');

/** Où chaque galerie va chercher ses fichiers. */
const DOSSIERS = {
  'coeur-joie': { cite: 'coeur-joie/cite', fenou: 'coeur-joie/fenou', kafui: 'coeur-joie/kafui' },
  bethel: { cite: 'bethel/cite', 'bethel-f4': 'bethel/bethel-f4', 'bethel-duplex': 'bethel/bethel-duplex' },
};

/** « 03-remise-des-cles.jpg » → « Remise des clés ». */
const LEXIQUE = {
  cles: 'clés', cle: 'clé', sejour: 'séjour', arriere: 'arrière', exterieur: 'extérieur',
  interieur: 'intérieur', etage: 'étage', entree: 'entrée', cuisine: 'cuisine',
  chambre: 'chambre', salon: 'salon', terrasse: 'terrasse', jardin: 'jardin',
  garage: 'garage', facade: 'façade', aerienne: 'aérienne', vue: 'vue', nuit: 'nuit',
  jour: 'jour', escalier: 'escalier', balcon: 'balcon', voirie: 'voirie',
  environnement: 'environnement', remise: 'remise', des: 'des', avant: 'avant',
  densemble: 'd’ensemble', arrieree: 'arrière', piscine: 'piscine', sam: 'salle à manger',
  salle: 'salle', bain: 'bain', eau: 'eau', dressing: 'dressing', couloir: 'couloir',
};

/**
 * Un nom d'appareil photo ne dit rien.
 *
 * « IMG-20231009-WA0007.jpg », « IMG_8959.png », « DSC04412.jpg » : les
 * transformer en légende donnerait « Img 20231009 wa0007 » sous la photo, ce
 * qui est pire que pas de légende du tout. Mieux vaut n'en mettre aucune et
 * laisser parler l'image — la légende est facultative, le charabia ne l'est
 * pas.
 */
const NOM_SANS_SENS = /^(img|image|photo|dsc|dscn|dji|pxl|screenshot|capture|whatsapp|received|signal)[-_ ]?\d*([-_ ](wa)?\d+)*$/i;

function legendeDepuisNom(fichier) {
  const brut = basename(fichier, extname(fichier)).replace(/^\d+[-_]?/, '');
  if (!brut || NOM_SANS_SENS.test(brut.replace(/\s+copie$/i, ''))) return '';

  const mots = basename(fichier, extname(fichier))
    .replace(/^\d+[-_]?/, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((m) => LEXIQUE[m.toLowerCase()] ?? m);
  if (!mots.length) return '';
  const texte = mots.join(' ');
  return texte.charAt(0).toUpperCase() + texte.slice(1);
}

/** Largeur réelle du fichier, pour un srcset qui ne ment pas au navigateur. */
function largeur(chemin) {
  try {
    const d = readFileSync(chemin);
    if (d.slice(1, 4).toString('latin1') === 'PNG') return d.readUInt32BE(16);
    if (d[0] === 0xff && d[1] === 0xd8) {
      let i = 2;
      while (i < d.length) {
        if (d[i] !== 0xff) { i++; continue; }
        const m = d[i + 1];
        if (m >= 0xc0 && m <= 0xc3) return d.readUInt16BE(i + 7);
        if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        i += 2 + d.readUInt16BE(i + 2);
      }
    }
  } catch {
    /* format non lu : on s'en passe */
  }
  return 0;
}

function photosDe(dossier) {
  const abs = join(ROOT, PHOTOS, dossier);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];

  const fichiers = readdirSync(abs)
    .filter((f) => EXT.has(extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));

  const petites = new Set(fichiers.filter((f) => /-sm\.[a-z]+$/i.test(f)));

  return fichiers
    .filter((f) => !petites.has(f))
    .map((f) => {
      const src = `${PHOTOS}/${dossier}/${f}`;
      const sm = f.replace(/(\.[a-z]+)$/i, '-sm$1');
      let srcset = '';
      if (petites.has(sm)) {
        const lPetite = largeur(join(abs, sm));
        const lGrande = largeur(join(abs, f));
        if (lPetite && lGrande) {
          srcset = `${PHOTOS}/${dossier}/${sm} ${lPetite}w, ${src} ${lGrande}w`;
        }
      }
      return { src, srcset, caption: legendeDepuisNom(f) };
    });
}

/**
 * Fusionne le disque et l'existant.
 *
 * Le disque décide de la liste et de l'ordre ; le JSON garde ses textes.
 */
function fusionner(surDisque, existantes, sujet) {
  const parSrc = new Map((existantes || []).map((i) => [i.src, i]));
  return surDisque.map((photo) => {
    const ancien = parSrc.get(photo.src) || {};
    return {
      src: photo.src,
      srcset: ancien.srcset || photo.srcset || '',
      alt: ancien.alt || `${photo.caption || 'Photo'} — ${sujet}`,
      caption: ancien.caption || photo.caption || '',
    };
  });
}

// ── Exécution ───────────────────────────────────────────────────────────────

const data = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
const rapport = [];

for (const cite of data.cites) {
  const dossiers = DOSSIERS[cite.id] || {};

  const photosCite = photosDe(dossiers.cite || '');
  if (photosCite.length) {
    const avant = (cite.gallery || []).length;
    cite.gallery = fusionner(photosCite, cite.gallery, cite.name);
    rapport.push(`${cite.name} — galerie de la cité : ${avant} → ${cite.gallery.length}`);
  }

  for (const villa of cite.villas) {
    const photos = photosDe(dossiers[villa.id] || '');
    if (!photos.length) continue;

    const avant = (villa.gallery || []).length;
    villa.gallery = fusionner(photos, villa.gallery, villa.name);
    rapport.push(`${villa.name} : ${avant} → ${villa.gallery.length} photo(s)`);

    // La première photo devient la vignette de la carte, sauf si l'équipe en a
    // déjà choisi une qui figure toujours dans la galerie.
    const choisie = villa.gallery.some((p) => p.src === villa.card?.src);
    if (!choisie) {
      const cadrage = villa.card?.focus;
      villa.card = {
        src: villa.gallery[0].src,
        srcset: villa.gallery[0].srcset,
        alt: villa.gallery[0].alt,
        ...(cadrage ? { focus: cadrage } : {}),
      };
      rapport.push(`  ↳ vignette de la carte : ${villa.card.src}`);
    }

    // Illustration ou photo réelle de la remise des clés.
    const familles = photosDe(`familles/${villa.id}`);
    if (familles.length) {
      const ancien = villa.family || {};
      villa.family = {
        src: familles[0].src,
        srcset: ancien.srcset || familles[0].srcset || '',
        alt: ancien.alt || `${familles[0].caption || 'Famille'} — ${villa.name}`,
        // « staged » n'est pas cosmétique : il décide de la mention affichée.
        // Une vraie photo de clients étiquetée « mise en scène » serait un
        // mensonge, et une mise en scène présentée comme réelle un autre.
        // Le script ne tranche pas : il conserve ce qui est déclaré, et la
        // valeur par défaut est la plus prudente.
        staged: ancien.staged !== undefined ? ancien.staged : true,
      };
      rapport.push(`  ↳ « Imaginez votre vie ici » : ${villa.family.src} (staged: ${villa.family.staged})`);
    }
  }
}

if (!rapport.length) {
  console.log(`Aucune photo trouvée sous ${PHOTOS}/.`);
  console.log('Déposez les fichiers dans les dossiers décrits par uploads/villas/README.md.');
  process.exit(0);
}

console.log(rapport.join('\n'));

if (!ecrire) {
  console.log('\n— simulation, rien n’a été écrit. Relancez avec : npm run photos -- --ecrire');
} else {
  writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nassets/villas.json mis à jour. Vérifiez avec : npm test`);
}
