# Déploiement sur LWS — https://nos-villas.gcitt.com

Guide de mise en ligne sur un hébergement LWS avec Node.js activé.

L'application est **autonome** : un seul processus Node sert la page, les
assets, les uploads **et** l'endpoint `POST /api/lead`, sur le même domaine.
Aucun reverse proxy à configurer au-delà de ce que fait déjà LWS, et **aucune
dépendance npm** à installer.

---

## 0. « Erreur » sans log au démarrage — à lire en premier

Si le panneau affiche seulement « Erreur » quand vous lancez le script `start`,
la cause la plus probable n'est pas un bug de l'application.

### Passenger démarre l'application tout seul

Sur un hébergement cPanel/Passenger, **on ne lance pas l'application avec
`npm start`**. Passenger la démarre lui-même, à la première requête HTTP, en
chargeant le fichier de démarrage indiqué dans le panneau.

Le bouton « Exécuter un script NPM » du panneau est fait pour des commandes qui
**se terminent** : `npm install`, `npm run build`, `npm test`. Un serveur HTTP,
par définition, ne se termine jamais : le lanceur attend sa fin, ne la voit pas
venir, et signale « Erreur » alors que l'application tourne peut-être très bien.

**Ce qu'il faut faire :**

1. Vérifiez que le fichier de démarrage du panneau est `app.js` (ou
   `server.js`). Enregistrez.
2. Cliquez sur **Redémarrer** l'application — pas sur « Exécuter le script
   start ».
3. Ouvrez `https://nos-villas.gcitt.com/healthz`. Une réponse comme
   `{"ok":true,"node":"v22.22.3",...}` signifie que tout fonctionne.

Un second cas classique : lancer `npm start` **à la main** alors que Passenger a
déjà démarré l'application. Le second processus tente d'ouvrir le même port et
meurt sur `EADDRINUSE`. Le message est maintenant explicite dans le journal.

### Où lire l'erreur réelle

L'application écrit désormais chaque étape de son démarrage dans un fichier, que
le panneau affiche quelque chose d'utile ou non :

```sh
cat ~/public_html/nos-villas/logs/startup.log
```

Un démarrage réussi ressemble à ceci :

```
[…] [app.js] démarrage — node v22.22.3, cwd /home/c2362524c/public_html/nos-villas
[…] [app.js] racine application /home/c2362524c/public_html/nos-villas
[…] [app.js] PORT = 41234
[…] server.js: modules chargés
[…] pas de .env — les variables viennent de l'environnement du processus
[…] environnement {"node":"v22.22.3","nodeEnv":"production",…,"whatsapp":false,"email":false}
[…] [app.js] server.js chargé
[…] en écoute sur port 41234 (production)
[…] PRÊT — l'application répond
```

Si la ligne `modules chargés` manque, le problème est un fichier absent ou un
import cassé — `app.js` aura noté lequel, avec son code d'erreur et sa pile.
Si `PRÊT` manque mais que `modules chargés` est là, c'est l'ouverture du port
qui a échoué, et la cause est nommée en clair.

Le journal ne contient **aucun secret** : uniquement des booléens indiquant si
telle intégration est configurée.

### Vérifier à la main, en SSH

```sh
cd ~/public_html/nos-villas
node app.js          # doit afficher les lignes ci-dessus puis rester actif
# dans un autre terminal :
curl -s http://127.0.0.1:3000/healthz
```

Si cela fonctionne en SSH mais pas via le panneau, le problème est la
configuration du panneau (fichier de démarrage, ou version de Node), pas le
code.

---

## 1. Résumé de la configuration

| Paramètre du panneau | Valeur |
| --- | --- |
| **Version de Node.js** | 22.x (testé sur 22 ; minimum requis **20.12**) |
| **Racine de l'application** | le dossier où le dépôt est déposé, ex. `nos-villas` ou `~/apps/nos-villas` |
| **URL de l'application** | `nos-villas.gcitt.com` (racine `/`, pas de sous-chemin) |
| **Fichier de démarrage** | `app.js` (ou `server.js` — voir §1.1) |
| **Mode** | `production` |
| **Commande de démarrage** | aucune — Passenger lance le fichier de démarrage lui-même (voir §0) |

### 1.1 Quel fichier de démarrage ?

| Fichier | Quand l'utiliser |
| --- | --- |
| **`app.js`** | **Par défaut.** Enveloppe `server.js` et journalise chaque étape du démarrage, ce qui rend un échec lisible même quand le panneau n'affiche que « Erreur ». |
| `app.cjs` | Si Passenger ne sait pas charger un module ES et rapporte `ERR_REQUIRE_ESM`. Même comportement, syntaxe CommonJS. |
| `server.js` | Fonctionne aussi (Node 22 sait charger l'ESM via `require`), mais sans le journal de démarrage. |

Les trois ont été testés dans les deux modes de chargement (`node <fichier>` et
`require(<fichier>)`, comme le fait Passenger).

Le minimum de 20.12 vient de `process.loadEnvFile()`, utilisé pour lire un
`.env` local. Sur LWS les variables viennent du panneau, donc cette fonction
n'est pas sollicitée — mais la contrainte reste déclarée dans `package.json`.

---

## 2. Version de Node.js

Sélectionnez **Node.js 22.x** dans le panneau. L'application n'utilise que des
modules natifs (`node:http`, `node:zlib`, `node:crypto`, `node:fs`), donc
aucune extension système ni compilation native n'est nécessaire.

---

## 3. Envoi des fichiers

Déposez le contenu du dépôt dans la racine de l'application, en conservant
l'arborescence :

```
racine de l'application/
├── app.js                         ← fichier de démarrage (recommandé)
├── app.cjs                        ← variante CommonJS, si ERR_REQUIRE_ESM
├── server.js                      ← le serveur lui-même
├── package.json
├── GCITT - Cite Coeur Joie.dc.html
├── support.js
├── favicon.ico
├── robots.txt
├── sitemap.xml
├── site.webmanifest
├── api/                           (adaptateur Vercel — inutilisé ici, sans effet)
├── assets/                        (CSS, polices, favicons, image de partage, tracking)
├── lib/                           (validation, WhatsApp, email, CRM, anti-spam)
├── uploads/                       (photos des villas et logo)
├── vendor/                        (React 18.3.1 auto-hébergé)
└── test/
```

Points d'attention :

- **Ne déposez pas de fichier `.env`.** Les variables se saisissent dans le
  panneau. Le serveur refuse d'ailleurs de servir tout fichier commençant par
  un point (`403`), `.env` et `.git` compris.
- **Ne créez pas de `.htaccess` à la racine de l'application.** cPanel en génère
  un avec les directives Passenger ; l'écraser casse l'application.
- **Le code serveur n'est pas téléchargeable.** La racine se trouvant sous
  `public_html` et Passenger routant *toutes* les requêtes vers Node, c'est
  `server.js` qui protège ses propres sources : il ne sert qu'une liste blanche
  (`assets/`, `uploads/`, `vendor/`, plus quelques fichiers racine) et répond
  `404` pour tout le reste — `lib/`, `api/`, `test/`, `package.json`,
  `server.js` lui-même. Des `.htaccess` restrictifs dans `lib/`, `api/`,
  `test/` et `docs/` ajoutent une seconde barrière si Passenger est arrêté et
  qu'Apache sert les dossiers directement.
- Le dossier `logs/` est créé automatiquement au premier démarrage.
- Les dossiers `uploads/` et `assets/` doivent conserver leurs **noms de
  fichiers exacts**, espaces compris (`HEVIE CJ .jpg`). Les chemins sont
  encodés dans le HTML ; un renommage casse les images.
- `api/lead.js` et `vercel.json` ne servent qu'à un déploiement Vercel. Ils
  sont inertes sur LWS ; vous pouvez les laisser.

---

## 4. Variables d'environnement

À saisir dans le panneau LWS, section variables d'environnement de
l'application. `.env.example` en contient la liste commentée.

### Indispensables

| Variable | Valeur | Rôle |
| --- | --- | --- |
| `NODE_ENV` | `production` | Mode production |
| `ALLOWED_ORIGINS` | `https://nos-villas.gcitt.com` | Seule origine autorisée à poster le formulaire |
| `SITE_URL` | `https://nos-villas.gcitt.com` | Liens dans l'email de confirmation |

**`PORT` est fourni automatiquement par LWS — ne le définissez pas vous-même.**
`server.js` lit `process.env.PORT` et n'utilise `3000` que s'il est absent (cas
du développement local). Un port en dur empêcherait l'application de démarrer.

### WhatsApp Business (Meta)

| Variable | Remarque |
| --- | --- |
| `META_WHATSAPP_TOKEN` | Token d'utilisateur système **permanent**, pas le token temporaire de 24 h |
| `META_PHONE_NUMBER_ID` | WhatsApp → Configuration de l'API |
| `META_BUSINESS_ACCOUNT_ID` | idem |
| `META_WHATSAPP_TEMPLATE_NAME` | `gcitt_nouveau_prospect`, **après approbation Meta** |
| `META_WHATSAPP_TEMPLATE_LANG` | `fr` |
| `GCITT_SALES_WHATSAPP` | `2290167212128` (chiffres uniquement, sans `+`) |
| `META_API_VERSION` | `v21.0` |

Sans `META_WHATSAPP_TEMPLATE_NAME`, les alertes ne partent que dans une fenêtre
de 24 h ouverte par le destinataire — donc en pratique, pas du tout. Voir
`docs/WHATSAPP.md`.

### Email

| Variable | Remarque |
| --- | --- |
| `EMAIL_API_KEY` | Clé Resend ou SendGrid |
| `EMAIL_PROVIDER` | `resend` ou `sendgrid` |
| `EMAIL_DESTINATION` | Boîte commerciale réellement relevée (plusieurs adresses séparées par des virgules) |
| `EMAIL_FROM` | `GCITT <notifications@gcitt.com>` — domaine **vérifié** chez le fournisseur |
| `EMAIL_SUBJECT` | `Nouveau prospect - Demande villa GCITT` |
| `EMAIL_CONFIRMATION_ENABLED` | `true` |
| `EMAIL_CONFIRMATION_SUBJECT` | `Votre demande a bien été reçue — GCITT BENIN` |
| `EMAIL_REPLY_TO` | Adresse qui reçoit les réponses des prospects |

### Coordonnées affichées au prospect

`GCITT_CONTACT_WHATSAPP`, `GCITT_CONTACT_PHONE`, `GCITT_CONTACT_EMAIL`,
`GCITT_WEBSITE`, `GCITT_ADDRESS`. Des valeurs par défaut correctes sont déjà
codées ; ne les renseignez que pour les modifier.

### Sécurité et anti-spam

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `RATE_LIMIT_MAX` | `5` | Soumissions autorisées par IP et par fenêtre |
| `RATE_LIMIT_WINDOW_MS` | `600000` | Durée de la fenêtre (10 min) |
| `MIN_FILL_MS` | `3000` | En dessous, la soumission est considérée robotisée |
| `TRUST_PROXY` | `true` | **Laissez à `true` sur LWS** — voir ci-dessous |

`TRUST_PROXY` mérite une explication. Sur LWS, Apache se place devant Node :
l'adresse vue par le processus est celle du proxy (`127.0.0.1`) pour *tous* les
visiteurs. Sans ce réglage, ils partageraient un unique compteur et un seul
spammeur bloquerait tous les prospects. Avec `TRUST_PROXY=true`, le serveur lit
l'en-tête `X-Forwarded-For` posé par Apache. Ne passez à `false` que si le
processus Node est exposé directement à Internet, cas où un client pourrait
forger l'en-tête pour contourner la limite.

### CRM (optionnel, pour plus tard)

`CRM_WEBHOOK_URL`, `CRM_WEBHOOK_TOKEN`.

---

## 5. Installation et démarrage

Depuis le terminal SSH de LWS, ou via les boutons du panneau :

```sh
cd ~/public_html/nos-villas
npm install --omit=dev   # ne télécharge rien : le projet n'a aucune dépendance
```

Puis, **dans le panneau**, cliquez sur **Redémarrer** l'application. Passenger
la lance lui-même à la première requête ; il n'y a pas de `npm start` à
déclencher. Voir §0 si le panneau affiche « Erreur ».

`npm start` reste utile **en SSH** pour un test manuel :

```sh
npm start                # écoute sur 3000 si PORT n'est pas défini
curl -s http://127.0.0.1:3000/healthz
```

`npm install` est **sans effet mais sans risque** : `dependencies` est vide, le
serveur n'utilisant que des modules natifs. Cela signifie aussi qu'aucune panne
de registre npm ne peut faire échouer un déploiement.

Vérification rapide avant de brancher le domaine :

```sh
npm test                 # 106 tests, sans dépendance
node --check server.js
```

Après **toute** modification des variables d'environnement, **redémarrez
l'application** depuis le panneau : elles sont lues une seule fois au
démarrage.

---

## 6. Domaine et HTTPS

1. Pointez `nos-villas.gcitt.com` vers l'hébergement (zone DNS LWS).
2. Rattachez le sous-domaine à l'application Node dans le panneau, à la racine
   `/`.
3. Activez le certificat SSL Let's Encrypt et forcez la redirection HTTP → HTTPS.

L'en-tête `Strict-Transport-Security` n'est **pas** émis par l'application :
c'est à l'hébergeur de le poser, une fois le HTTPS confirmé fonctionnel. Les
autres en-têtes de sécurité (`X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Permissions-Policy`) sont envoyés par `server.js`.

---

## 7. Ce que le serveur gère lui-même

Sur Vercel, `vercel.json` s'occupait des en-têtes. Ici Node est l'origine :
`server.js` applique donc directement

- **la compression** Brotli et gzip selon `Accept-Encoding` — le HTML passe de
  86 Ko à 16 Ko, `support.js` de 69 Ko à 17 Ko. Les JPEG, PNG, WOFF2 et ICO
  sont volontairement laissés tels quels, étant déjà compressés ;
- **le cache navigateur** : un an en `immutable` pour `/uploads`, `/assets` et
  `/vendor` ; une journée pour `support.js` ; revalidation systématique pour la
  page, sans quoi une modification ne parviendrait jamais aux visiteurs
  connus ; `no-store` sur `/api/lead` ;
- **les requêtes conditionnelles** : `ETag` et réponses `304` ;
- **les en-têtes de sécurité** ci-dessus ;
- **le refus** des fichiers cachés (`.env`, `.git`), des remontées de chemin,
  des URL mal encodées, et de tout ce qui ne figure pas dans la liste blanche
  des chemins publics ;
- **`/healthz`**, une sonde de vivacité qui ne divulgue aucune configuration.

Si Apache ajoute lui aussi de la compression, il n'y a pas de double
compression : voyant `Content-Encoding` déjà posé, il laisse la réponse
inchangée.

---

## 8. Vérification après mise en ligne

```sh
# L'application est vivante (le test le plus rapide)
curl -s https://nos-villas.gcitt.com/healthz

# La page répond et est compressée
curl -sI -H 'Accept-Encoding: br' https://nos-villas.gcitt.com/ | grep -i 'content-encoding\|cache-control'

# Les assets sont servis
curl -s -o /dev/null -w '%{http_code}\n' https://nos-villas.gcitt.com/assets/fonts.css
curl -s -o /dev/null -w '%{http_code}\n' https://nos-villas.gcitt.com/vendor/react.production.min.js
curl -s -o /dev/null -w '%{http_code}\n' "https://nos-villas.gcitt.com/uploads/Image%20COEUR-JOIE/HEVIE%20CJ%20.jpg"

# Fichiers SEO
curl -s -o /dev/null -w '%{http_code}\n' https://nos-villas.gcitt.com/robots.txt
curl -s -o /dev/null -w '%{http_code}\n' https://nos-villas.gcitt.com/sitemap.xml

# L'endpoint refuse bien GET (405) et les origines étrangères (403)
curl -s -o /dev/null -w '%{http_code}\n' https://nos-villas.gcitt.com/api/lead

# Un prospect de test complet
curl -X POST https://nos-villas.gcitt.com/api/lead \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://nos-villas.gcitt.com' \
  -d '{"name":"Test LWS","email":"votre@email.com","phone":"+33612345678","villa":"Villa Fenou (F4)","message":"Test de deploiement."}'
```

La réponse attendue au dernier appel :

```json
{"ok":true,"delivered":{"whatsapp":true,"email":true,"confirmation":true,"crm":false}}
```

`"crm": false` est normal tant que `CRM_WEBHOOK_URL` n'est pas configuré : une
intégration non configurée est *ignorée*, pas *en échec*.

Puis, dans le navigateur : soumettez le formulaire et vérifiez les **trois**
arrivées — WhatsApp sur la ligne commerciale, email interne, email de
confirmation au prospect.

---

## 9. En cas de problème

**L'application ne démarre pas.** Commencez par §0 : dans neuf cas sur dix le
panneau signale « Erreur » simplement parce qu'on lui a demandé d'exécuter
`npm start`, ce qui n'est pas la façon de démarrer une application Passenger.
Puis lisez `logs/startup.log`, qui nomme l'étape et la cause exactes. Vérifiez
enfin que le fichier de démarrage est `app.js` et que Node est ≥ 20.12.

**La page s'affiche mais reste vide.** `support.js` ou `/vendor/react*.js` ne
sont pas servis. Testez-les avec `curl` ; s'ils renvoient 404, l'arborescence
n'a pas été respectée à l'envoi.

**Les images sont cassées.** Un dossier ou un fichier a été renommé. Les noms
contiennent des espaces significatifs, `HEVIE CJ .jpg` inclus (avec l'espace
avant l'extension).

**Le formulaire renvoie 403.** `ALLOWED_ORIGINS` ne correspond pas au domaine
réellement servi. Il doit valoir exactement `https://nos-villas.gcitt.com`,
sans barre oblique finale.

**Le formulaire renvoie 502.** Un canal *configuré* a échoué. Les logs
détaillent lequel et pourquoi (`[lead] échec whatsapp : …`). Causes fréquentes :
token Meta expiré, template non approuvé, domaine d'envoi non vérifié chez le
fournisseur d'email.

**Tout le monde reçoit 429.** `TRUST_PROXY` est à `false` alors que
l'application est derrière Apache : tous les visiteurs partagent le compteur de
`127.0.0.1`. Repassez-le à `true`.

**Les notifications ne partent jamais, sans erreur.** L'hébergement bloque
peut-être les connexions sortantes. À tester en SSH :

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://graph.facebook.com/v21.0/
curl -sS -o /dev/null -w '%{http_code}\n' https://api.resend.com/
```

Un code HTTP quelconque signifie que la sortie fonctionne ; un blocage réseau
ou un timeout est à signaler au support LWS.

---

## 10. Limitation connue

Le compteur anti-spam est **en mémoire** : il est remis à zéro à chaque
redémarrage de l'application, et si LWS exécute plusieurs processus, chacun a
le sien. Combiné au honeypot et au contrôle de durée de saisie, cela suffit
largement au spam ordinaire. Pour une limite réellement globale, il faut un
magasin partagé (Redis) — l'interface à implémenter est décrite dans
`docs/DEPLOIEMENT.md`.

---

## 11. Déploiement automatique par FTP (GitHub Actions)

Le workflow `.github/workflows/deploy.yml` copie le dépôt vers l'hébergement à
chaque push. Une chose lui manque, et elle est facile à manquer :

> **Copier les fichiers ne redémarre pas l'application.** Le processus Node
> déjà lancé garde l'ancien code en mémoire. Sans redémarrage, un déploiement
> ne change rien à ce que voient les visiteurs.

Passenger surveille la date de modification de `tmp/restart.txt` : la toucher
suffit à lui faire relancer l'application à la requête suivante. Le fichier est
présent dans le dépôt ; il reste à le toucher après chaque envoi.

### Option A — laisser le workflow s'en charger

Ajoutez cette étape **après** l'étape « Déployer via FTP » :

```yaml
      - name: Redémarrer l'application Passenger
        uses: SamKirkland/FTP-Deploy-Action@v4.3.5
        with:
          server: ${{ secrets.FTP_SERVER }}
          username: ${{ secrets.FTP_USERNAME }}
          password: ${{ secrets.FTP_PASSWORD }}
          port: ${{ secrets.FTP_PORT }}
          server-dir: ${{ secrets.FTP_SERVER_DIR }}
          local-dir: ./tmp/
          # Un contenu différent à chaque exécution, pour que le fichier soit
          # bien réenvoyé : l'action ignore les fichiers inchangés.
          state-name: .ftp-deploy-restart-state.json
```

Cette approche a une limite : l'action ne réenvoie que les fichiers dont le
contenu a changé, et `tmp/restart.txt` est constant. Pour un redémarrage
garanti, faites-le varier juste avant l'envoi :

```yaml
      - name: Marquer le redémarrage
        run: echo "deploy ${{ github.sha }} $(date -u +%FT%TZ)" >> tmp/restart.txt
```

Placez cette étape **avant** l'étape de déploiement : le fichier part alors avec
le reste et sa date de modification change côté serveur.

### Option B — redémarrer à la main

Cliquez sur **Redémarrer** dans le panneau LWS après chaque déploiement, ou en
SSH :

```sh
touch ~/public_html/nos-villas/tmp/restart.txt
```

### Vérifier qu'un déploiement a bien pris

```sh
curl -s https://nos-villas.gcitt.com/healthz
```

`uptimeSeconds` doit être retombé à une petite valeur. S'il continue de croître,
l'ancien processus tourne toujours et le redémarrage n'a pas eu lieu.
