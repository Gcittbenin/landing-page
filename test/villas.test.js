/**
 * assets/villas.json — la source unique du contenu des villas.
 *
 * Ce fichier n'est pas du code : c'est du contenu, édité par l'équipe
 * commerciale pour publier une photo ou corriger un prix. Il part en
 * production sans relecture de développeur, et la page le lit au chargement.
 * Une virgule en trop et la section villas est vide en ligne.
 *
 * Ces tests sont donc le garde-fou : ils tournent avant chaque déploiement
 * (voir .github/workflows/deploy.yml) et bloquent l'envoi FTP si le fichier
 * est cassé. Trois d'entre eux valent d'être expliqués :
 *
 *   - « formValue » doit correspondre à lib/validate.js. Le couplage est
 *     invisible dans le JSON : un libellé retouché à la main ferait passer le
 *     formulaire en 422 sans que rien ne l'annonce.
 *   - toute image citée doit exister sur le disque. Un chemin mal recopié
 *     donne une carte vide, et personne ne s'en aperçoit avant un prospect.
 *   - aucune photo d'une cité chez l'autre. C'est une exigence commerciale
 *     explicite de GCITT, pas une préférence esthétique.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VILLAS, VILLA_INDEX } from '../lib/validate.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const raw = readFileSync(join(ROOT, 'assets/villas.json'), 'utf8');

test('le fichier est du JSON valide', () => {
  assert.doesNotThrow(() => JSON.parse(raw));
});

const data = JSON.parse(raw);

/** Toutes les villas, à plat, avec leur cité. */
const allVillas = data.cites.flatMap((cite) => cite.villas.map((v) => ({ ...v, cite })));

/**
 * Une entrée de srcset : un chemin, puis une largeur.
 *
 * Le chemin peut contenir des espaces — les photos officielles s'appellent
 * « HEVIE CJ -sm.jpg ». Seul le dernier mot est le descripteur, et découper
 * sur tous les espaces tronquerait le chemin au premier. C'est exactement le
 * défaut que ce test a trouvé dans encodeSrcset().
 */
const SRCSET_ENTRY = /^(.+?)\s+(\d+w)$/;

const srcsetPaths = (srcset) =>
  String(srcset || '')
    .split(',')
    .map((part) => SRCSET_ENTRY.exec(part.trim()))
    .filter(Boolean)
    .map((m) => m[1]);

/** Toutes les images citées, quelle que soit leur place. */
function everyImage() {
  const out = [];
  for (const cite of data.cites) {
    for (const img of cite.gallery || []) out.push({ where: `cité ${cite.name}`, img });
    for (const v of cite.villas) {
      if (v.card) out.push({ where: `carte ${v.name}`, img: v.card });
      for (const img of v.gallery || []) out.push({ where: `galerie ${v.name}`, img });
      if (v.family && v.family.src) out.push({ where: `famille ${v.name}`, img: v.family });
    }
  }
  return out;
}

test('les deux cités sont présentes, avec deux villas chacune', () => {
  assert.equal(data.cites.length, 2);
  assert.deepEqual(data.cites.map((c) => c.id).sort(), ['bethel', 'coeur-joie']);
  for (const cite of data.cites) {
    assert.equal(cite.villas.length, 2, `${cite.name} devrait avoir 2 villas`);
    assert.ok(cite.name && cite.location && cite.blurb, `${cite.id} : champs de cité manquants`);
  }
});

test('chaque villa porte les champs dont la page a besoin', () => {
  assert.equal(allVillas.length, 4);
  for (const v of allVillas) {
    for (const field of ['id', 'name', 'tag', 'type', 'price', 'formValue', 'description']) {
      assert.ok(v[field], `${v.name || v.id} : « ${field} » manquant`);
    }
    assert.ok(Array.isArray(v.chips) && v.chips.length, `${v.name} : aucune caractéristique`);
    assert.ok(Array.isArray(v.specs) && v.specs.length, `${v.name} : aucun détail`);
    assert.ok(v.card && v.card.src, `${v.name} : aucune photo de carte`);
    assert.ok(Array.isArray(v.gallery), `${v.name} : « gallery » doit être un tableau`);
  }
});

test('les identifiants de villa sont uniques', () => {
  const ids = allVillas.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length, `doublon parmi : ${ids.join(', ')}`);
});

test('« formValue » correspond exactement au catalogue du serveur', () => {
  // Le lien que rien d'autre ne surveille. Si un libellé est retouché ici sans
  // l'être dans lib/validate.js, « Choisir cette villa » remplit le formulaire
  // avec une valeur que le serveur refuse : 422, et un prospect perdu.
  for (const v of allVillas) {
    assert.ok(
      VILLAS.includes(v.formValue),
      `« ${v.formValue} » (${v.name}) est absent de VILLAS dans lib/validate.js`,
    );
  }

  // Et la cité déduite côté serveur doit être celle où la villa est rangée ici.
  for (const v of allVillas) {
    const expected = v.cite.id === 'coeur-joie' ? 'Cœur Joie' : 'Bethel';
    assert.equal(
      VILLA_INDEX[v.formValue].cite,
      expected,
      `${v.name} est rangée dans ${v.cite.name} mais le serveur la rattache à ${VILLA_INDEX[v.formValue].cite}`,
    );
    assert.equal(VILLA_INDEX[v.formValue].type, v.type, `${v.name} : type incohérent`);
  }
});

test('toutes les images citées existent sur le disque', () => {
  const manquantes = [];
  for (const { where, img } of everyImage()) {
    if (!existsSync(join(ROOT, img.src))) manquantes.push(`${where} → ${img.src}`);

    // Le srcset aussi : un chemin faux y est ignoré en silence par le
    // navigateur, qui retombe sur src — la version mobile ne sert alors plus
    // à rien et personne ne le voit.
    for (const path of srcsetPaths(img.srcset)) {
      if (!existsSync(join(ROOT, path))) manquantes.push(`${where} (srcset) → ${path}`);
    }
  }
  assert.deepEqual(manquantes, [], 'fichiers introuvables :\n  ' + manquantes.join('\n  '));
});

test('chaque image porte un texte alternatif', () => {
  for (const { where, img } of everyImage()) {
    assert.ok(String(img.alt || '').trim(), `${where} : « alt » vide`);
  }
});

test('les descripteurs de srcset sont bien formés', () => {
  for (const { where, img } of everyImage()) {
    if (!img.srcset) continue;
    for (const part of img.srcset.split(',')) {
      assert.match(
        part.trim(),
        SRCSET_ENTRY,
        `${where} : « ${part.trim()} » devrait être « chemin largeur », ex. « photo.jpg 780w »`,
      );
    }
  }
});

test('aucune photo d’une cité n’apparaît chez l’autre', () => {
  // Exigence de GCITT, répétée à chaque sprint : les deux cités ne se
  // mélangent jamais. Un visuel de Cœur Joie sur une villa Béthel promet au
  // prospect quelque chose qu'il n'achètera pas.
  const marqueurs = {
    'coeur-joie': [/bethel/i],
    bethel: [/COEUR-JOIE/i, /coeur-joie/i, /FENOU/i, /KAFUI/i, /HEVIE/i],
  };

  for (const cite of data.cites) {
    const chemins = [
      ...(cite.gallery || []).map((i) => i.src),
      ...cite.villas.flatMap((v) => [v.card?.src, ...(v.gallery || []).map((i) => i.src)]),
    ].filter(Boolean);

    for (const chemin of chemins) {
      for (const interdit of marqueurs[cite.id] || []) {
        assert.ok(
          !interdit.test(chemin),
          `${cite.name} référence « ${chemin} », qui appartient à l’autre cité`,
        );
      }
    }
  }
});

test('les illustrations de familles restent des mises en scène, jamais des témoignages', () => {
  for (const v of allVillas) {
    const f = v.family || {};
    // Un « alt » qui nomme quelqu'un ou cite des propos ferait passer une
    // scène jouée pour un vrai client. Les vrais témoignages ont leur propre
    // fichier, avec accord écrit : assets/temoignages.json.
    assert.equal(typeof f.src, 'string', `${v.name} : « family.src » doit exister, même vide`);
    assert.ok(!('quote' in f), `${v.name} : une illustration ne porte pas de citation`);
    assert.ok(!('name' in f), `${v.name} : une illustration ne porte pas de nom`);
  }
});

test('une famille différente par villa', () => {
  const utilisees = allVillas.map((v) => v.family?.src).filter(Boolean);
  assert.equal(
    new Set(utilisees).size,
    utilisees.length,
    'deux villas partagent la même illustration : la répétition se voit tout de suite',
  );
});

test('les témoignages restent un système séparé', () => {
  // La galerie de familles ne doit jamais servir à remplir cette section.
  const temoignages = JSON.parse(readFileSync(join(ROOT, 'assets/temoignages.json'), 'utf8'));
  assert.ok(Array.isArray(temoignages.temoignages));
  assert.ok(!('temoignages' in data), 'villas.json ne doit pas porter de témoignages');
  assert.ok(!('familles' in temoignages), 'temoignages.json ne doit pas porter d’illustrations');
});

test('la page lit bien le fichier, et ne redéfinit pas les villas en dur', () => {
  const page = readFileSync(join(ROOT, 'GCITT - Cite Coeur Joie.dc.html'), 'utf8');
  assert.match(page, /fetch\('assets\/villas\.json'/, 'la page doit charger la source unique');

  // Le prix ne doit exister qu'à un seul endroit. S'il réapparaît dans le
  // corps de la page, la centralisation est déjà en train de se défaire.
  //
  // Le JSON-LD est exclu : « priceRange » y est une fourchette pour Google,
  // pas le prix d'une villa. Sa cohérence est vérifiée juste en dessous.
  // (Découper sur « <x-dc> » ne suffit pas : un commentaire du <head> cite la
  // balise, et indexOf tombait dessus — le JSON-LD restait dans le corps.)
  const corps = page.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
  for (const v of allVillas) {
    assert.ok(
      !corps.includes(v.price),
      `« ${v.price} » est écrit en dur dans la page alors qu'il vient de villas.json`,
    );
  }
});

test('la fourchette de prix du JSON-LD suit les villas', () => {
  // Couplage discret : cette ligne est lue par Google, jamais par un humain de
  // l'équipe. Elle resterait donc fausse pendant des mois après un changement
  // de tarif si rien ne la surveillait.
  const page = readFileSync(join(ROOT, 'GCITT - Cite Coeur Joie.dc.html'), 'utf8');
  const declaree = /"priceRange":\s*"([^"]+)"/.exec(page);
  assert.ok(declaree, 'le JSON-LD doit déclarer une fourchette de prix');

  const montants = allVillas.map((v) => Number(v.price.replace(/[^\d]/g, '')));
  const min = Math.min(...montants);
  const max = Math.max(...montants);
  const chiffres = declaree[1].match(/[\d\s ]+/g).map((n) => Number(n.replace(/[^\d]/g, ''))).filter(Boolean);

  assert.equal(chiffres[0], min, `la fourchette annonce ${chiffres[0]} alors que la villa la moins chère est à ${min}`);
  assert.equal(chiffres[1], max, `la fourchette annonce ${chiffres[1]} alors que la villa la plus chère est à ${max}`);
});

test('la ligne « Cité … » ne réapparaît pas au-dessus du titre du hero', () => {
  const page = readFileSync(join(ROOT, 'GCITT - Cite Coeur Joie.dc.html'), 'utf8');
  assert.ok(!page.includes('slide.eyebrow'), 'le libellé de localisation du hero doit rester supprimé');
  // Mais la localisation elle-même reste disponible dans les données.
  for (const cite of data.cites) {
    assert.ok(cite.location.trim(), `${cite.name} : la localisation doit rester renseignée`);
  }
});
