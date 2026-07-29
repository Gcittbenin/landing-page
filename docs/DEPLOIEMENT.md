# Déploiement

La landing page est statique ; seule la route `/api/lead` exécute du code
serveur. Deux modes sont prévus.

---

## Option A — Vercel (recommandé)

`vercel.json` et `api/lead.js` sont déjà en place : `api/lead.js` devient
automatiquement une fonction serverless, tout le reste est servi en statique.

```sh
npm i -g vercel
vercel link
```

Renseignez les variables (ou collez-les dans **Project Settings → Environment
Variables**) :

```sh
vercel env add META_WHATSAPP_TOKEN production
vercel env add META_PHONE_NUMBER_ID production
vercel env add META_BUSINESS_ACCOUNT_ID production
vercel env add META_WHATSAPP_TEMPLATE_NAME production
vercel env add GCITT_SALES_WHATSAPP production
vercel env add EMAIL_API_KEY production
vercel env add EMAIL_DESTINATION production
vercel env add EMAIL_FROM production
```

Puis :

```sh
vercel --prod
```

`vercel.json` définit déjà :

- la réécriture de `/` vers `GCITT - Cite Coeur Joie.dc.html` ;
- `Cache-Control: no-store` sur `/api/*` ;
- un cache long sur `/uploads/*` ;
- les en-têtes `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`
  et `Strict-Transport-Security`.

---

## Option B — Serveur Node autonome

```sh
cp .env.example .env      # puis renseigner les valeurs
node --env-file=.env server.js
```

`server.js` sert les fichiers statiques **et** expose `/api/lead`. Placez-le
derrière Nginx ou Caddy pour le TLS. Le serveur lit l'IP client dans
`X-Forwarded-For` : assurez-vous que le reverse proxy **écrase** cet en-tête
plutôt que de le concaténer, sinon la limitation de débit est contournable.

Exemple Nginx :

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header X-Forwarded-For $remote_addr;   # écrase, ne concatène pas
    proxy_set_header Host $host;
}
```

---

## Checklist avant mise en production

- [ ] `META_WHATSAPP_TOKEN` est un token d'**utilisateur système** permanent,
      pas le token temporaire de 24 h.
- [ ] `META_WHATSAPP_TEMPLATE_NAME` renseigné et le template **approuvé** par
      Meta (voir `docs/WHATSAPP.md`).
- [ ] `EMAIL_FROM` utilise un domaine **vérifié** chez le fournisseur d'emails,
      sinon les envois sont rejetés.
- [ ] `EMAIL_DESTINATION` pointe vers une boîte réellement relevée.
- [ ] Un prospect de test a bien déclenché **le WhatsApp et l'email**.
- [ ] Les identifiants de tracking sont renseignés dans
      `assets/tracking-config.js`.
- [ ] `.env` n'est pas commité (il est déjà dans `.gitignore`).
- [ ] `npm test` passe.

---

## Limitation connue : la limitation de débit

`lib/ratelimit.js` conserve son état **en mémoire**. Sur Vercel, chaque
instance serverless a donc son propre compteur : la limite s'applique par
instance chaude, pas globalement. Combinée au honeypot et au contrôle de durée
de saisie, elle suffit à décourager le spam ordinaire, mais elle ne constitue
pas un plafond absolu.

Pour une limite réellement globale, injectez un store partagé — l'interface
attendue est volontairement minimale :

```js
createRateLimiter({
  max, windowMs,
  store: {
    get(key) { /* -> number[] */ },
    set(key, timestamps) { /* ... */ },
  },
});
```

Un `store` adossé à Redis (Upstash, par exemple) suffit ; rien d'autre dans le
code n'a besoin de changer.

---

## Mise en ligne sur https://nos-villas.gcitt.com

### 1. DNS

Ajoutez le sous-domaine chez votre registrar, puis dans **Vercel → Project →
Settings → Domains**, ajoutez `nos-villas.gcitt.com`. Vercel affiche
l'enregistrement à créer :

```
CNAME   nos-villas   cname.vercel-dns.com.
```

Le certificat TLS est émis automatiquement une fois la propagation faite
(quelques minutes à quelques heures selon le TTL).

### 2. Variables d'environnement

Toutes dans **Settings → Environment Variables**, scope *Production*. Voir
`.env.example` pour la liste commentée.

Obligatoires pour que les notifications fonctionnent :

| Variable | Remarque |
| --- | --- |
| `META_WHATSAPP_TOKEN` | Token d'utilisateur système **permanent** |
| `META_PHONE_NUMBER_ID` | WhatsApp → Configuration de l'API |
| `META_BUSINESS_ACCOUNT_ID` | idem |
| `META_WHATSAPP_TEMPLATE_NAME` | `gcitt_nouveau_prospect`, après approbation Meta |
| `GCITT_SALES_WHATSAPP` | `2290167212128` |
| `EMAIL_API_KEY` | Resend ou SendGrid |
| `EMAIL_DESTINATION` | boîte commerciale réellement relevée |
| `EMAIL_FROM` | domaine **vérifié** chez le fournisseur |
| `ALLOWED_ORIGINS` | `https://nos-villas.gcitt.com` |
| `SITE_URL` | `https://nos-villas.gcitt.com` |

### 3. Après le premier déploiement

1. **Search Console** — ajoutez la propriété `nos-villas.gcitt.com`, soumettez
   `https://nos-villas.gcitt.com/sitemap.xml`, demandez l'indexation.
2. **Rich Results Test** — https://search.google.com/test/rich-results sur
   l'URL, pour valider les données structurées en conditions réelles.
3. **Partage social** — passez l'URL dans le
   [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug/),
   le [LinkedIn Post Inspector](https://www.linkedin.com/post-inspector/) et
   le validateur X. Ces outils mettent l'aperçu en cache : si vous changez
   l'image ou le titre plus tard, il faudra les rafraîchir manuellement.
4. **Prospect de test** — soumettez le formulaire et vérifiez les trois
   arrivées : WhatsApp sur la ligne commerciale, email interne, email de
   confirmation au prospect.
5. **Tracking** — renseignez les identifiants dans
   `assets/tracking-config.js`, redéployez, puis vérifiez dans GA4 (Temps réel)
   et dans le Meta Events Manager que `generate_lead` / `Lead` remonte bien.

### 4. Si le domaine sert aussi depuis un autre hébergeur

Le contrôle d'origine du endpoint rejette toute requête dont l'en-tête `Origin`
ne correspond pas à l'hôte. Si la page est servie depuis un domaine différent
de l'API, listez-le dans `ALLOWED_ORIGINS`, sinon les soumissions renverront
`403`.

---

## Limitation connue : rendu côté client

La page est un document `dc-runtime` : rien ne s'affiche tant que `support.js`
et React (~197 Ko) ne sont pas téléchargés et exécutés. C'est ce qui plafonne
le score Lighthouse mobile autour de 72 malgré toutes les optimisations
(images `srcset`, polices et React auto-hébergés, préchargement du LCP,
chargement différé sous la ligne de flottaison).

Le seul moyen de dépasser ce plafond est de **pré-rendre le HTML** au moment du
build : charger la page dans un navigateur headless, sérialiser le DOM obtenu,
et servir ce HTML statique en laissant `support.js` réhydrater ensuite. Cela
améliorerait aussi l'indexation du contenu dynamique (cartes villas, réponses
FAQ), aujourd'hui absent du HTML servi. Ce n'est pas mis en place ici parce que
cela transforme un déploiement statique sans dépendance en un déploiement avec
étape de build.

À noter : le contenu **statique** de la page (titre H1, textes des sections,
navigation, coordonnées du pied de page) est bien présent dans le HTML servi,
puisqu'il est écrit en dur dans le template. Seules les données injectées par
`renderVals()` dépendent de JavaScript.
