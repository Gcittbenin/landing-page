/**
 * SEO audit, run against the files actually being served.
 *
 * Not a crawler and not a Lighthouse run: it reads the HTML on disk, the
 * robots.txt and the sitemap.xml, and checks the things that are true or false
 * regardless of any third-party service. Every check states what it found and,
 * when it fails, what to do about it — a score with no remedy is decoration.
 *
 * What this deliberately does not do:
 *
 *  - It does not report a Lighthouse performance score. Lighthouse is a lab
 *    run on a simulated device; the dashboard shows Core Web Vitals measured
 *    on real visitors instead, which is what Google actually ranks on.
 *  - It does not report indexed pages. That number only exists inside Google
 *    Search Console and requires its API and a verified property.
 *
 * Both are stated as such in the report rather than filled with a guess.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = 'GCITT - Cite Coeur Joie.dc.html';

/** Attribute value of the first tag matching a pattern. */
function attr(html, pattern, name) {
  const tag = pattern.exec(html)?.[0];
  if (!tag) return '';
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  return match ? match[1].trim() : '';
}

const meta = (html, name) =>
  attr(html, new RegExp(`<meta[^>]+name\\s*=\\s*["']${name}["'][^>]*>`, 'i'), 'content');

const property = (html, name) =>
  attr(html, new RegExp(`<meta[^>]+property\\s*=\\s*["']${name}["'][^>]*>`, 'i'), 'content');

/** Decode the handful of entities that matter for a length check. */
const decode = (value) =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/**
 * One check.
 *
 * `weight` is how much the check counts towards the score; a missing title
 * costs more than a missing Twitter card because it costs more in reality.
 */
const check = (id, label, status, detail, { weight = 1, fix = '' } = {}) => ({
  id,
  label,
  status, // 'pass' | 'warn' | 'fail' | 'info'
  detail,
  weight,
  fix,
});

function auditTitle(html) {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '');
  if (!title) {
    return check('title', 'Balise Title', 'fail', 'Absente', {
      weight: 3,
      fix: 'Ajouter un <title> décrivant la page en 50 à 60 caractères.',
    });
  }
  // Google truncates around 60 characters on desktop; short titles waste the
  // most valuable line of the result page.
  if (title.length > 65) {
    return check('title', 'Balise Title', 'warn', `${title.length} caractères — tronquée dans Google`, {
      weight: 3,
      fix: 'Raccourcir à 60 caractères maximum en gardant les mots-clés au début.',
    });
  }
  if (title.length < 30) {
    return check('title', 'Balise Title', 'warn', `${title.length} caractères — trop courte`, {
      weight: 3,
      fix: 'Étoffer à 50–60 caractères pour occuper toute la ligne du résultat.',
    });
  }
  return check('title', 'Balise Title', 'pass', `${title.length} caractères — ${title}`, { weight: 3 });
}

function auditDescription(html) {
  const description = decode(meta(html, 'description'));
  if (!description) {
    return check('description', 'Meta Description', 'fail', 'Absente', {
      weight: 3,
      fix: 'Ajouter une description de 140 à 160 caractères, avec un appel à l’action.',
    });
  }
  if (description.length > 165) {
    return check('description', 'Meta Description', 'warn', `${description.length} caractères — tronquée`, {
      weight: 3,
      fix: 'Réduire à 160 caractères : au-delà, Google coupe la phrase.',
    });
  }
  if (description.length < 110) {
    return check('description', 'Meta Description', 'warn', `${description.length} caractères — trop courte`, {
      weight: 3,
      fix: 'Étoffer à 140–160 caractères pour occuper les deux lignes disponibles.',
    });
  }
  return check('description', 'Meta Description', 'pass', `${description.length} caractères`, { weight: 3 });
}

function auditOpenGraph(html) {
  const required = ['og:title', 'og:description', 'og:image', 'og:url', 'og:type'];
  const missing = required.filter((name) => !property(html, name));
  if (missing.length === 0) {
    return check('og', 'Open Graph', 'pass', 'Titre, description, image, URL et type présents', { weight: 2 });
  }
  return check('og', 'Open Graph', missing.length >= 3 ? 'fail' : 'warn', `Manquant : ${missing.join(', ')}`, {
    weight: 2,
    fix: 'Les réseaux sociaux ne rendent pas le JavaScript : ces balises doivent être dans le <head> statique.',
  });
}

function auditTwitter(html) {
  const card = meta(html, 'twitter:card');
  const image = meta(html, 'twitter:image');
  if (card && image) {
    return check('twitter', 'Twitter Cards', 'pass', `card = ${card}`, { weight: 1 });
  }
  return check('twitter', 'Twitter Cards', 'warn', card ? 'Image absente' : 'Absentes', {
    weight: 1,
    fix: 'Ajouter twitter:card = summary_large_image et twitter:image.',
  });
}

function auditStructuredData(html) {
  const blocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  if (blocks.length === 0) {
    return {
      check: check('schema', 'Données structurées', 'fail', 'Aucun bloc JSON-LD', {
        weight: 2,
        fix: 'Ajouter au minimum Organization et les Product de chaque villa.',
      }),
      types: [],
    };
  }

  const types = [];
  let invalid = 0;
  for (const [, raw] of blocks) {
    try {
      const parsed = JSON.parse(raw);
      const collect = (node) => {
        if (Array.isArray(node)) return node.forEach(collect);
        if (!node || typeof node !== 'object') return;
        if (node['@type']) types.push(...[].concat(node['@type']));
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') collect(value);
        }
      };
      collect(parsed);
    } catch {
      invalid++;
    }
  }

  const unique = [...new Set(types)].sort();
  if (invalid > 0) {
    return {
      check: check('schema', 'Données structurées', 'fail', `${invalid} bloc(s) JSON-LD invalides`, {
        weight: 2,
        fix: 'Un JSON-LD mal formé est ignoré en entier par Google. Vérifier avec le test des résultats enrichis.',
      }),
      types: unique,
    };
  }

  return {
    check: check('schema', 'Données structurées', 'pass', `${blocks.length} bloc(s) — ${unique.join(', ')}`, {
      weight: 2,
    }),
    types: unique,
  };
}

function auditHeadings(html) {
  const h1 = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)];
  const h2 = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)];
  const strip = (value) => decode(value.replace(/<[^>]*>/g, '').replace(/\{\{[^}]*\}\}/g, '').replace(/\s+/g, ' ').trim());

  const checks = [];
  if (h1.length === 1) {
    checks.push(check('h1', 'Balise H1', 'pass', strip(h1[0][1]).slice(0, 90), { weight: 2 }));
  } else if (h1.length === 0) {
    checks.push(
      check('h1', 'Balise H1', 'fail', 'Aucun H1', {
        weight: 2,
        fix: 'Une page doit porter exactement un H1, qui reprend la promesse principale.',
      }),
    );
  } else {
    checks.push(
      check('h1', 'Balise H1', 'warn', `${h1.length} H1 sur la page`, {
        weight: 2,
        fix: 'Garder un seul H1 et rétrograder les autres en H2.',
      }),
    );
  }

  checks.push(
    h2.length >= 3
      ? check('h2', 'Balises H2', 'pass', `${h2.length} sections titrées`, { weight: 1 })
      : check('h2', 'Balises H2', 'warn', `${h2.length} H2`, {
          weight: 1,
          fix: 'Titrer chaque section en H2 : c’est la structure que Google lit pour les liens de site.',
        }),
  );

  return { checks, headings: { h1: h1.map((m) => strip(m[1])), h2: h2.map((m) => strip(m[1])) } };
}

function auditImages(html) {
  const tags = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const withoutAlt = tags.filter((tag) => !/\balt\s*=/i.test(tag));
  const emptyAlt = tags.filter((tag) => /\balt\s*=\s*["']\s*["']/i.test(tag));

  if (tags.length === 0) {
    return check('alt', 'Attributs ALT', 'info', 'Aucune balise <img> statique', { weight: 1 });
  }
  if (withoutAlt.length > 0) {
    return check('alt', 'Attributs ALT', 'fail', `${withoutAlt.length} image(s) sur ${tags.length} sans alt`, {
      weight: 2,
      fix: 'Décrire chaque image : c’est à la fois un critère SEO et une obligation d’accessibilité.',
    });
  }
  // A decorative image is legitimately alt="" — flagged, not failed.
  return check(
    'alt',
    'Attributs ALT',
    'pass',
    `${tags.length} image(s), toutes décrites${emptyAlt.length ? ` (${emptyAlt.length} décorative(s))` : ''}`,
    { weight: 2 },
  );
}

function auditHead(html) {
  const checks = [];
  const lang = attr(html, /<html[^>]*>/i, 'lang');
  checks.push(
    lang
      ? check('lang', 'Langue déclarée', 'pass', `lang = ${lang}`, { weight: 1 })
      : check('lang', 'Langue déclarée', 'fail', 'Attribut lang absent sur <html>', {
          weight: 1,
          fix: 'Ajouter lang="fr" : sans lui, Google peut servir la page au mauvais public.',
        }),
  );

  const canonical = attr(html, /<link[^>]+rel\s*=\s*["']canonical["'][^>]*>/i, 'href');
  checks.push(
    canonical
      ? check('canonical', 'URL canonique', 'pass', canonical, { weight: 2 })
      : check('canonical', 'URL canonique', 'warn', 'Absente', {
          weight: 2,
          fix: 'Déclarer <link rel="canonical"> pour éviter le contenu dupliqué entre www et non-www.',
        }),
  );

  const robots = meta(html, 'robots');
  const blocked = /noindex/i.test(robots);
  checks.push(
    blocked
      ? check('robots-meta', 'Meta robots', 'fail', `noindex actif — la page est exclue de Google (${robots})`, {
          weight: 3,
          fix: 'Retirer noindex avant la mise en ligne.',
        })
      : check('robots-meta', 'Meta robots', 'pass', robots || 'index, follow (défaut)', { weight: 1 }),
  );

  const viewport = meta(html, 'viewport');
  checks.push(
    viewport
      ? check('viewport', 'Viewport mobile', 'pass', viewport, { weight: 2 })
      : check('viewport', 'Viewport mobile', 'fail', 'Absent', {
          weight: 2,
          fix: 'Sans viewport, Google considère la page comme non adaptée au mobile.',
        }),
  );

  return checks;
}

async function auditRobots() {
  const path = join(ROOT, 'robots.txt');
  if (!existsSync(path)) {
    return check('robots', 'robots.txt', 'fail', 'Fichier absent', {
      weight: 2,
      fix: 'Créer robots.txt et y déclarer l’URL du sitemap.',
    });
  }
  const body = await readFile(path, 'utf8');
  if (!/sitemap\s*:/i.test(body)) {
    return check('robots', 'robots.txt', 'warn', 'Présent, mais ne référence pas le sitemap', {
      weight: 2,
      fix: 'Ajouter une ligne « Sitemap: https://…/sitemap.xml ».',
    });
  }
  if (/^\s*Disallow:\s*\/\s*$/im.test(body)) {
    return check('robots', 'robots.txt', 'fail', 'Disallow: / — tout le site est bloqué', {
      weight: 3,
      fix: 'Retirer la règle Disallow: / avant la mise en ligne.',
    });
  }
  return check('robots', 'robots.txt', 'pass', 'Présent, sitemap déclaré', { weight: 2 });
}

async function auditSitemap() {
  const path = join(ROOT, 'sitemap.xml');
  if (!existsSync(path)) {
    return {
      check: check('sitemap', 'sitemap.xml', 'fail', 'Fichier absent', {
        weight: 2,
        fix: 'Générer un sitemap listant au minimum la page d’accueil.',
      }),
      urls: [],
    };
  }
  const body = await readFile(path, 'utf8');
  const urls = [...body.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim());
  return {
    check:
      urls.length > 0
        ? check('sitemap', 'sitemap.xml', 'pass', `${urls.length} URL déclarée(s)`, { weight: 2 })
        : check('sitemap', 'sitemap.xml', 'warn', 'Présent mais vide', {
            weight: 2,
            fix: 'Y déclarer au moins l’URL de la page d’accueil.',
          }),
    urls,
  };
}

/**
 * Broken links.
 *
 * Two kinds are checkable without leaving the machine: an anchor pointing at
 * an id that does not exist on the page, and a local file referenced by a path
 * that is not on disk. External links are not fetched — a hundred outbound
 * requests on every dashboard load would be slow, and a remote 503 would show
 * up here as our own broken link.
 */
function auditLinks(html) {
  const ids = new Set([...html.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));

  const broken = [];
  const external = new Set();

  for (const [, href] of html.matchAll(/\shref\s*=\s*["']([^"']+)["']/gi)) {
    const value = href.trim();
    if (!value || value.startsWith('mailto:') || value.startsWith('tel:') || value.startsWith('data:')) continue;
    if (/^https?:\/\//i.test(value)) {
      external.add(value.split('?')[0]);
      continue;
    }
    if (value.startsWith('#')) {
      const target = decodeURIComponent(value.slice(1));
      if (target && !ids.has(target)) broken.push({ href: value, reason: 'ancre inexistante' });
      continue;
    }
    // A template placeholder is resolved at runtime, not on disk.
    if (value.includes('{{')) continue;
    const relative = normalize(decodeURIComponent(value.replace(/^\/+/, '')).split('?')[0]);
    if (relative && !relative.startsWith('..') && !existsSync(join(ROOT, relative))) {
      broken.push({ href: value, reason: 'fichier introuvable' });
    }
  }

  // Local sources too: a missing image is a broken link a visitor sees.
  for (const [, src] of html.matchAll(/\ssrc\s*=\s*["']([^"']+)["']/gi)) {
    const value = src.trim();
    if (!value || /^(https?:)?\/\//i.test(value) || value.startsWith('data:') || value.includes('{{')) continue;
    const relative = normalize(decodeURIComponent(value).split('?')[0].replace(/^\/+/, ''));
    if (relative && !existsSync(join(ROOT, relative))) {
      broken.push({ href: value, reason: 'fichier introuvable' });
    }
  }

  return {
    check:
      broken.length === 0
        ? check('links', 'Liens internes', 'pass', 'Aucun lien cassé détecté', { weight: 2 })
        : check('links', 'Liens internes', 'fail', `${broken.length} lien(s) cassé(s)`, {
            weight: 2,
            fix: 'Corriger les cibles listées ci-dessous.',
          }),
    broken,
    externalCount: external.size,
  };
}

/**
 * Run the whole audit.
 *
 * @param {{vitals?: object[]}} context real-user Core Web Vitals, when available
 */
export async function auditSeo({ vitals = [] } = {}) {
  const html = await readFile(join(ROOT, INDEX), 'utf8');

  const schema = auditStructuredData(html);
  const headings = auditHeadings(html);
  const sitemap = await auditSitemap();
  const links = auditLinks(html);

  const checks = [
    auditTitle(html),
    auditDescription(html),
    ...auditHead(html),
    auditOpenGraph(html),
    auditTwitter(html),
    schema.check,
    ...headings.checks,
    auditImages(html),
    await auditRobots(),
    sitemap.check,
    links.check,
  ];

  // A warning is a half-failure: it costs points without pretending the page
  // is broken. `info` checks are excluded from the score entirely.
  const scored = checks.filter((c) => c.status !== 'info');
  const total = scored.reduce((sum, c) => sum + c.weight, 0);
  const earned = scored.reduce(
    (sum, c) => sum + c.weight * (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0),
    0,
  );
  const score = total > 0 ? Math.round((earned / total) * 100) : null;

  const measured = vitals.filter((v) => v.p75 !== null);
  const vitalsScore =
    measured.length > 0
      ? Math.round(
          (measured.filter((v) => v.rating === 'good').length / measured.length) * 100,
        )
      : null;

  return {
    generatedAt: new Date().toISOString(),
    score,
    grade: score === null ? null : score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D',
    checks,
    headings: headings.headings,
    schemaTypes: schema.types,
    sitemapUrls: sitemap.urls,
    brokenLinks: links.broken,
    externalLinks: links.externalCount,
    vitals,
    vitalsScore,
    // Said in the report rather than left as a blank the reader has to
    // interpret. Both need a third party we have deliberately not added.
    unavailable: [
      {
        label: 'Score Lighthouse',
        why: "Lighthouse est une mesure de laboratoire exécutée sur un appareil simulé. Le tableau de bord affiche à la place les Core Web Vitals mesurées chez les vrais visiteurs, qui sont ce que Google utilise pour le classement.",
      },
      {
        label: 'Pages indexées',
        why: "Ce chiffre n'existe que dans Google Search Console. Il faut y vérifier le domaine, puis fournir des identifiants d'API — aucune estimation fiable n'est possible sans cela.",
      },
      {
        label: 'Liens externes',
        why: "Les liens sortants ne sont pas testés : cela demanderait une requête réseau par lien à chaque ouverture du tableau de bord, et une panne temporaire chez un tiers s'afficherait comme une erreur de notre site.",
      },
    ],
  };
}
