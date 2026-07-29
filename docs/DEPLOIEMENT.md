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
