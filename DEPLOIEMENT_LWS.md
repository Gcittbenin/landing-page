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

1. Vérifiez que le fichier de démarrage du panneau est **`app.js`**.
   Enregistrez. **Jamais `server.js` directement** : c'est `app.js` qui pose
   les gestionnaires d'erreurs, journalise chaque étape dans
   `logs/startup.log` et surveille l'appel à `listen()`. Démarrer `server.js`
   seul contourne tout ce diagnostic.
2. Cliquez sur **Redémarrer** l'application — pas sur « Exécuter le script
   start ».
3. Ouvrez `https://nos-villas.gcitt.com/healthz`. Une réponse comme
   `{"ok":true,"node":"v22.22.3",...}` signifie que tout fonctionne.

Un second cas classique : lancer `npm start` **à la main** alors que Passenger a
déjà démarré l'application. Le second processus tente d'ouvrir le même port et
meurt sur `EADDRINUSE`. Le message est maintenant explicite dans le journal.

> **Le piège qui a coûté le plus cher.** Un processus lancé une fois par
> « Exécuter le script start » **survit indéfiniment**, indépendamment du
> fichier de démarrage affiché par le panneau, et **avec l'environnement figé
> au moment de son lancement**. Toute variable ajoutée ensuite lui est
> invisible. Le panneau peut donc afficher `startup_file = app.js` pendant
> qu'un `node server.js` de la semaine précédente sert réellement les
> requêtes.
>
> Pour le vérifier en SSH :
>
> ```sh
> ps -eo pid,lstart,args | grep -E "node (app|server)\.js" | grep -v grep
> ```
>
> Une date de lancement ancienne, ou `server.js` au lieu de `app.js`, signe le
> problème. Tuez le processus, puis **Redémarrer** dans le panneau — jamais
> « Exécuter le script start » pour un serveur.
>
> Depuis, `npm start` lance `node app.js` : les deux chemins sont devenus
> identiques et l'erreur n'est plus possible.

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
├── assets/                        (CSS, polices, favicons, image de partage, tracking)
├── lib/                           (validation, WhatsApp, email, CRM, anti-spam)
├── uploads/                       (photos des villas et logo)
└── vendor/                        (React 18.3.1 auto-hébergé)

Non déployés : api/ (adaptateur Vercel), test/, docs/, data/ et logs/ —
voir la liste « exclude » dans .github/workflows/deploy.yml.
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
| `MIN_FILL_MS` | `3000` | En dessous, la soumission est considérée robotisée (`0` désactive le contrôle) |
| `TRUST_PROXY` | `true` | **Laissez à `true` sur LWS** — voir ci-dessous |

`TRUST_PROXY` mérite une explication. Sur LWS, Apache se place devant Node :
l'adresse vue par le processus est celle du proxy (`127.0.0.1`) pour *tous* les
visiteurs. Sans ce réglage, ils partageraient un unique compteur et un seul
spammeur bloquerait tous les prospects. Avec `TRUST_PROXY=true`, le serveur lit
l'en-tête `X-Forwarded-For` posé par Apache. Ne passez à `false` que si le
processus Node est exposé directement à Internet, cas où un client pourrait
forger l'en-tête pour contourner la limite.

### Base des prospects et espace `/admin`

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `LEAD_STORE` | `true` | Enregistre chaque prospect dans `data/leads.jsonl` |
| `DATA_DIR` | `<projet>/data` | Où écrire ce fichier — doit être accessible en écriture |
| `ADMIN_PASSWORD` | *(vide)* | **Sans lui, `/admin` répond 404** |
| `ADMIN_PASSWORD_HASH` | *(vide)* | Variante hachée, pour ne pas mettre le mot de passe en clair dans le panneau |
| `ADMIN_USERNAME` | `admin` | Identifiant de connexion |
| `ADMIN_SESSION_SECRET` | *(aléatoire)* | Signature des cookies de session |
| `ADMIN_PATH` | `/admin` | Où répond la console. À changer si l'hébergeur réserve `/admin` |

Deux choses méritent d'être dites clairement.

**`/admin` n'existe pas tant qu'`ADMIN_PASSWORD` n'est pas défini.** Toutes les
routes répondent 404 — pas 403, qui confirmerait l'existence du tableau de
bord. C'est le comportement voulu : un dashboard mis en ligne par inadvertance
expose les noms, téléphones et adresses de tous les prospects.

**`ADMIN_SESSION_SECRET` n'est pas facultatif en pratique.** Sans lui, une clé
aléatoire est tirée à chaque démarrage : l'équipe est déconnectée à chaque
redémarrage de l'application, donc après chaque déploiement. Générez-la une
fois :

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**`/admin` est un chemin réservé chez beaucoup d'hébergeurs mutualisés.** Une
installation de type cPanel porte fréquemment un alias Apache pour `/admin`,
`/webmail` ou `/cpanel` : la requête est interceptée avant d'atteindre
Passenger, et le symptôme est une **erreur 500 qu'aucun journal applicatif
n'explique — parce que l'application n'a jamais été sollicitée**. Si c'est le
cas, déplacez la console :

```
ADMIN_PATH=/pilotage
```

Cela retire au passage une cible permanente d'attaque par force brute. Voir la
section « Diagnostiquer une erreur 500 » plus bas.

Pour ne pas laisser le mot de passe en clair dans le panneau LWS, calculez son
haché scrypt et renseignez `ADMIN_PASSWORD_HASH` à la place :

```sh
node -e "import('./lib/auth.js').then(m=>console.log(m.hashPassword('votre-mot-de-passe')))"
```

`data/` contient trois journaux en ajout seul : `leads.jsonl` (les prospects et
leurs changements d'étape), `events.jsonl` (le trafic) et `audit.jsonl` (qui a
fait quoi dans l'espace d'administration).

Ce dossier contient des données personnelles. Il est ignoré par git **et exclu
du déploiement FTP** : un envoi ne doit jamais écraser la base des prospects. Il
n'est pas non plus servi par HTTP — `server.js` ne sert que les chemins de sa
liste blanche, et `data/` n'en fait pas partie.

> **Sauvegardez.** L'onglet « Sauvegarde » de `/admin` télécharge un JSON
> complet. Un déploiement ne touche pas à `data/`, mais une suppression de
> compte, si. Le mode d'emploi complet de l'espace est dans
> `docs/PILOTAGE.md`.

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

`npm start` reste utile **en SSH** pour un test manuel. Il lance `node app.js`,
donc exactement ce que Passenger exécute :

```sh
npm start                # écoute sur 3000 si PORT n'est pas défini
curl -s http://127.0.0.1:3000/healthz
```

Pensez à l'arrêter (`Ctrl-C`) : un test manuel laissé en fond est précisément
ce qui produit un processus fantôme à l'environnement figé.

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
- **`/healthz`**, une sonde de vivacité qui ne divulgue aucune configuration ;
- **`/admin`**, l'espace prospects : session signée, cookie `HttpOnly ;
  SameSite=Strict ; Secure`, `no-store` sur chaque réponse, et 404 partout
  tant qu'`ADMIN_PASSWORD` n'est pas défini ;
- **`/api/event`**, le collecteur d'audience maison (pages vues, sections
  atteintes, clics et leur position, temps passé, Core Web Vitals). GA4 et le Pixel Meta sont
  bloqués par les bloqueurs de publicité et demandent un compte Google ou Meta
  pour être lus : cette copie sur notre propre serveur est ce qui permet au
  tableau de bord d'afficher un taux de conversion. Il répond **toujours 204**,
  n'enregistre **ni adresse IP ni chaîne User-Agent** — seuls l'appareil et le
  navigateur agrégés — ignore les robots, et n'accepte que les noms
  d'événements de sa liste blanche.

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

# L'espace prospects : 404 tant qu'ADMIN_PASSWORD n'est pas défini,
# 200 (page de connexion) une fois la variable posée et l'application relancée
curl -s -o /dev/null -w '%{http_code}\n' https://nos-villas.gcitt.com/admin

# Le collecteur d'audience répond 204
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://nos-villas.gcitt.com/api/event \
  -H 'Content-Type: application/json' -d '{"name":"page_view","sid":"test"}'
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

## 9 bis. Diagnostiquer une erreur 500

Une 500 peut venir de deux endroits, et la distinction change complètement la
correction. **Commencez par déterminer lequel** — une seule commande suffit.

### Étape 1 — l'application est-elle vivante ?

```sh
curl -s https://nos-villas.gcitt.com/healthz
```

Attendu : `{"ok":true,...,"admin":true}`.

- `admin:false` → **`ADMIN_PASSWORD` n'est pas défini** (ou l'application n'a
  pas redémarré depuis). Dans ce cas la console répond 404, pas 500.
- Pas de réponse du tout → l'application ne démarre pas : lisez
  `logs/startup.log`, la cause y est nommée.

### Étape 2 — qui émet la 500 ?

**Deux façons de trancher, l'une et l'autre définitives.**

#### a. L'en-tête `X-Request-Id`

```sh
curl -sI https://nos-villas.gcitt.com/pilotage | grep -i x-request-id
```

Node pose cet en-tête sur **toutes** ses réponses, y compris ses erreurs.

- **Un identifiant est présent** → la requête a atteint Node. Cas **A**, allez
  à l'étape 3 : l'identifiant vous donne la ligne exacte du journal.
- **Aucun en-tête** → la réponse n'a pas été produite par l'application. Cas
  **B** : c'est Apache, LiteSpeed ou un cache en amont. Allez à l'étape 4.

#### b. Les compteurs de `/healthz`

Plus robuste encore, car cela ne dépend d'aucun en-tête qu'un proxy pourrait
retirer. Trois commandes :

```sh
curl -s https://nos-villas.gcitt.com/healthz          # notez requests.admin
curl -s -o /dev/null https://nos-villas.gcitt.com/pilotage
curl -s https://nos-villas.gcitt.com/healthz          # relisez requests.admin
```

| `requests.admin` | Conclusion |
| --- | --- |
| **a augmenté** | La requête a atteint Node → cas **A** |
| **inchangé** | La requête n'est jamais arrivée → cas **B** |

Seul ce processus peut incrémenter ce compteur. `requests.adminErrors` indique
en plus combien d'exceptions la console a levées depuis le démarrage : s'il
reste à zéro alors que `/pilotage` renvoie 500, l'erreur ne vient pas d'elle.

### Étape 3 — la 500 vient de Node

Deux journaux, avec la même référence à huit caractères que celle renvoyée
dans `X-Request-Id` et affichée au visiteur.

**`logs/requests.log`** trace chaque requête de la console — entrée, appel du
gestionnaire, sortie ou exception :

```sh
grep -A 12 "xxxxxxxx" logs/requests.log
```

```
[…] [60a852e1] ENTRÉE  GET url="/pilotage" chemin="/pilotage" ADMIN_PATH="/pilotage" hôte=… proto=https
[…] [60a852e1] APPEL   handleAdmin()
[…] [60a852e1] SORTIE  HTTP 200 (4086 octets)
```

Une ligne `ENTRÉE` sans `SORTIE` ni `EXCEPTION` signifie que le gestionnaire
ne rend jamais la main. Une ligne `EXCEPTION` est suivie de la pile complète.

Ces lignes montrent aussi **la valeur exacte** de `req.url`, du chemin analysé
et d'`ADMIN_PATH` : si les deux derniers diffèrent, le point de montage n'est
pas celui que vous croyez.

**`logs/startup.log`** reçoit une copie des exceptions, parce que c'est le
fichier que tout le monde ouvre en premier :

```sh
grep -A 12 "ERREUR console \[xxxxxxxx\]" logs/startup.log
```

### Étape 4 — la 500 vient d'Apache

L'application n'a jamais reçu la requête. C'est le cas typique d'un **alias
Apache sur `/admin`** : beaucoup d'hébergements mutualisés en réservent le
chemin pour un panneau de contrôle.

Vérification en une commande — si un autre chemin fonctionne alors que
`/admin` échoue, le diagnostic est établi :

```sh
# 1. Déplacer la console dans le panneau LWS :
#      ADMIN_PATH=/pilotage
# 2. Redémarrer l'application (ou toucher tmp/restart.txt)
# 3. Tester :
curl -s -o /dev/null -w '%{http_code}\n' https://nos-villas.gcitt.com/pilotage
```

`200` sur `/pilotage` et `500` sur `/admin` : c'est bien Apache qui intercepte
`/admin`. Conservez `ADMIN_PATH=/pilotage` — la console est entièrement
relative à son point de montage, rien d'autre n'est à changer.

Le chemin retenu est journalisé à chaque démarrage :

```sh
grep "administration monté" logs/startup.log
```

---

## 9 ter. Seule `/` atteint Passenger — les autres chemins répondent 500

C'est le cas observé en production le 3 août : la racine répond `200` avec
`x-powered-by: Phusion Passenger` et un `x-request-id`, tandis que `/healthz`,
`/pilotage` et `/admin` répondent une page 500 générique d'Apache **sans**
aucun de ces deux en-têtes. La requête n'arrive donc jamais jusqu'à Node.

### Ce que la signature indique

Les trois chemins qui échouent n'ont qu'une seule propriété commune : **aucun
ne correspond à un fichier ou à un répertoire réel**. Le seul chemin qui
fonctionne, `/`, en est un. Autrement dit, Passenger n'est sollicité que pour
les requêtes qu'Apache sait déjà résoudre sur le disque — exactement ce que
produit un bloc Passenger absent ou incomplet dans le `.htaccess` du
répertoire racine de l'application, en particulier la directive
`PassengerBaseURI "/"` qui déclare que **tout** ce qui est sous `/` appartient
à l'application.

Ce n'est pas notre code : le dépôt ne contient aucun `.htaccess` racine. Les
quatre `.htaccess` du projet (`api/`, `docs/`, `lib/`, `test/`) sont portés par
des sous-répertoires, ne contiennent qu'un `Require all denied`, et deux
d'entre eux ne partent même pas au déploiement. Aucun ne peut concerner
`/healthz`.

### Le test qui départage

Une seule commande sépare les hypothèses restantes :

```sh
curl -sI https://nos-villas.gcitt.com/chemin-inexistant-au-hasard-9876
```

* **500** — la panne concerne *tous* les chemins sans équivalent sur le
  disque. C'est la portée de Passenger qui est en cause : bloc CloudLinux
  absent, tronqué, ou `PassengerBaseURI` mal déclaré.
* **404 d'Apache** — seuls les noms `healthz`, `pilotage` et `admin` sont
  interceptés. Chercher alors un `Alias`, une règle de réécriture, une entrée
  de cache (FastestCache) ou une règle mod_security portant sur ces noms.

### Le bloc à vérifier

Dans le `.htaccess` du répertoire racine de l'application (celui déclaré comme
« Application root » dans le panneau) :

```sh
cat ~/nos-villas.gcitt.com/.htaccess     # adapter au chemin réel
```

Il doit contenir, intact, le bloc généré par cPanel :

```apache
# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION BEGIN
PassengerAppRoot "/home/UTILISATEUR/nos-villas.gcitt.com"
PassengerBaseURI "/"
PassengerNodejs "/home/UTILISATEUR/nodevenv/nos-villas.gcitt.com/22/bin/node"
PassengerAppType node
PassengerStartupFile app.js
# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION END
```

Points de contrôle, dans l'ordre :

1. **`PassengerBaseURI "/"` est-il présent ?** Absent, ou fixé à autre chose,
   il explique à lui seul la signature ci-dessus.
2. **Le bloc est-il complet, marqueurs BEGIN et END compris ?** cPanel ne le
   reconnaît, et ne le régénère, que s'il est intact.
3. **Y a-t-il autre chose dans le fichier ?** Une règle `RewriteRule`, un
   `ErrorDocument`, un `Alias`, ou un bloc de cache placé **avant** le bloc
   Passenger peut détourner les chemins avant lui.
4. **`PassengerStartupFile` vaut-il bien `app.js` ?** Il doit correspondre au
   fichier de démarrage du panneau, et à `npm start`.

Ce fichier est **généré par l'hébergeur et ne doit pas être versionné**. Ne
l'ajoutez pas au dépôt : le déploiement FTP écraserait la version de cPanel et
casserait l'application — c'est précisément ce contre quoi les commentaires des
`.htaccess` du projet mettent en garde.

Si le bloc est absent ou abîmé, la remise en place propre passe par le panneau
LWS : **Setup Node.js App → l'application → Restart**, ou un cycle
Stop / Start, qui réécrit le bloc.

### Vérifier ensuite côté serveur

```sh
# le processus réellement actif et sa date de lancement
ps -eo pid,lstart,args | grep -i node | grep -v grep

# les erreurs Apache correspondant aux requêtes de test
tail -n 100 ~/logs/nos-villas.gcitt.com.error.log 2>/dev/null \
  || tail -n 100 /usr/local/apache/logs/error_log
```

### Si le bloc est présent et correct

Alors la configuration bloquante est hors de portée du compte, et il faut la
demander au support LWS. Message à transmettre :

> Le domaine nos-villas.gcitt.com héberge une application Node.js sous
> Passenger. `GET /` répond 200 avec l'en-tête
> `x-powered-by: Phusion Passenger 6.1.1` : l'application fonctionne. Mais tout
> chemin sans correspondance sur le disque — par exemple `/healthz` — répond une
> page 500 générique, sans en-tête Passenger, donc sans jamais atteindre
> l'application. Le bloc CLOUDLINUX PASSENGER CONFIGURATION du `.htaccess`
> racine est présent et contient `PassengerBaseURI "/"`. Merci de vérifier au
> niveau du vhost ce qui empêche la transmission des URI non résolues sur le
> système de fichiers : configuration Passenger du vhost, alias, règles de
> réécriture, LiteSpeed FastestCache, ou mod_security.

---

## 9 quater. Le tableau de bord est vide — auditer la chaîne analytics

La chaîne complète est :

```
navigateur → assets/tracking.js → POST /api/event → data/events.jsonl
           → lib/analytics.js → API de la console → tableau de bord
```

Un seul endpoint permet de situer la rupture sans accès aux journaux :

```sh
curl -s https://nos-villas.gcitt.com/healthz | python3 -m json.tool
```

Trois champs comptent :

| Champ | Signification |
| --- | --- |
| `storage` | `ok`, `lecture seule`, `pas un répertoire`, `absent` ou `désactivé` |
| `requests.events` | balises analytics **reçues** par Node depuis le démarrage |
| `requests.eventsStored` | balises **écrites** sur le disque |

Lecture :

* **`events` = 0 après une visite réelle** → les balises n'atteignent pas Node.
  La rupture est en amont : Apache/LiteSpeed, un cache, ou une règle sur
  `/api/`. Voir § 9 ter — `/api/event` est un chemin sans équivalent sur le
  disque, exactement la classe d'URL concernée.
* **`events` > 0 mais `eventsStored` = 0** → les balises arrivent et ne
  s'écrivent pas. Regarder `storage`, puis :
  ```sh
  grep "NON ENREGISTRÉ" logs/startup.log | tail
  ```
* **`eventsStored` > 0 et tableau de bord vide** → la rupture est côté console.
  Ouvrir l'onglet Réseau du navigateur sur `/pilotage` et relever le code des
  appels `\/pilotage/api/…` : ils doivent tous répondre `200` et
  `Cache-Control: no-store`.

Ces compteurs sont remis à zéro à chaque redémarrage de l'application, et ne
contiennent aucun chemin, aucune adresse et rien concernant un visiteur.

### Le piège du 204 : `curl` est un robot

`/api/event` répond **`204` quoi qu'il arrive** — c'est délibéré : une balise
analytics ne doit jamais faire apparaître une erreur sur la page. Un `204` ne
prouve donc **rien** sur l'enregistrement.

Et le collecteur écarte les robots, pour que Googlebot ne vienne pas gonfler le
nombre de visiteurs. `curl`, `wget`, `python-requests`, `axios` et `okhttp`
sont dans cette liste. Un test en `curl` nu répond `204` et n'écrit rien :
c'est exactement ce que montrent des compteurs restés à zéro alors que la
requête arrive bien.

**Il faut donc envoyer un vrai `User-Agent` de navigateur.**

```sh
NAVIGATEUR='Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'

curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -A "$NAVIGATEUR" \
  -H 'Content-Type: application/json' -H 'Origin: https://nos-villas.gcitt.com' \
  -d '{"name":"page_view","sid":"test-manuel","path":"/","source":"Direct","tz":"Africa/Porto-Novo","lang":"fr-FR"}' \
  https://nos-villas.gcitt.com/api/event
```

#### Charge utile minimale

Le seul champ **obligatoire** est `name`, et il doit figurer dans la liste
blanche de `lib/events.js` (`page_view`, `section_view`, `cta_click`, `click`,
`select_item`, `form_open`, `form_start`, `form_submit`, `generate_lead`,
`whatsapp_click`, `hero_slide_view`, `scroll`, `engagement`, `web_vital`) :

```json
{"name":"page_view"}
```

Mais un événement sans `sid` est enregistré et **ne compte pour rien** :
visiteurs, sessions, taux de rebond, tunnel, temps réel et heatmap sont tous
calculés par session. La charge utile minimale *utile* est donc :

```json
{"name":"page_view","sid":"<identifiant de session>"}
```

`Content-Type` n'est pas contrôlé. `Origin` est facultatif — s'il est présent,
il doit correspondre à l'hôte. Tout le reste (appareil, navigateur, système,
horodatage) est déduit côté serveur et ne peut pas être fourni par le client.

Ordre des rejets, tous silencieux et tous en `204` : méthode ≠ POST → `405` ;
base désactivée ; origine étrangère ; corps > 4 Ko ; JSON invalide ; `name`
inconnu ; quota de 300 événements / 10 min / IP dépassé ; **robot** ; puis
seulement l'écriture.

### Les compteurs sont par processus Passenger

`requests.events` et `requests.eventsStored` vivent dans la mémoire du
processus Node qui répond. Passenger entretient un **pool de processus** et en
choisit un par requête : une balise peut être comptée par un worker et
`/healthz` répondu par un autre, qui affichera `0`.

`/healthz` renvoie donc aussi son `pid`. Deux appels successifs :

* **même `pid`, `events` inchangé** → l'événement n'a pas été reçu par ce
  processus ;
* **`pid` différent** → les compteurs ne sont pas comparables, recommencez.

Ce que tous les workers partagent, c'est le fichier sur disque. **L'autorité,
c'est `data/events.jsonl` et la console**, pas les compteurs :

```sh
tail -3 data/events.jsonl
wc -l data/events.jsonl
```

Les compteurs sont un indice rapide ; le fichier est la preuve.

### La visite de contrôle

```sh
# 1. relever le point de départ
curl -s https://nos-villas.gcitt.com/healthz

# 2. ouvrir https://nos-villas.gcitt.com dans un navigateur,
#    faire défiler jusqu'aux villas, cliquer un bouton, puis fermer l'onglet

# 3. les compteurs doivent avoir bougé
curl -s https://nos-villas.gcitt.com/healthz
```

Le test automatisé qui rejoue exactement cette chaîne —
`page_view → session → interaction → lead → tableau de bord` — est
`test/pipeline.test.js` ; il tourne à chaque déploiement.

### Le répertoire `api/` ne doit pas exister sur le serveur

`api/lead.js` est l'adaptateur Vercel : `server.js` ne l'importe pas, il
appelle `lib/handler.js` directement. Le répertoire n'est donc plus envoyé par
le déploiement — mais l'exclusion n'efface pas ce qui s'y trouve déjà. À
supprimer une fois, par FTP ou par le gestionnaire de fichiers :

```
<racine de l'application>/api/
```

Raison : `api/` est le seul répertoire du projet dont le nom corresponde à des
URL réellement servies (`/api/lead`, `/api/event`), et il contient un
`.htaccess` en `Require all denied`. Si Apache résout ces URL sur le disque
avant de passer la main à Passenger, ce fichier répond 403 au formulaire et à
toute la collecte. Vérification :

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -A "$NAVIGATEUR" \
  -H 'Content-Type: application/json' -H 'Origin: https://nos-villas.gcitt.com' \
  -d '{"name":"page_view","sid":"test-manuel"}' \
  https://nos-villas.gcitt.com/api/event
```

`204` : la requête atteint Node. `403` : le `.htaccess` de `api/` s'applique —
la suppression du répertoire est la correction.

**`-A "$NAVIGATEUR"` n'est pas décoratif.** Voir « Le piège du 204 » ci-dessous :
sans lui, la commande répond `204` **et n'enregistre rien**.

---

## 9 quinquies. Vérifier qu'Apache ne sert pas les fichiers de l'application

Sous Passenger, toutes les requêtes doivent passer par Node, qui n'expose que
sa liste blanche. Si Apache sert les fichiers du répertoire lui-même, le code
et les données deviennent téléchargeables. À contrôler une fois :

```sh
for p in /lib/auth.js /lib/admin.html /data/leads.jsonl /.env /package.json; do
  printf '%-24s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' https://nos-villas.gcitt.com$p)"
done
```

**Les cinq doivent répondre 404.** Un `200` sur l'un d'eux signifie qu'Apache
court-circuite Passenger : il faut alors placer l'application hors du
répertoire web (`PassengerAppRoot` en dehors de `public_html`) et n'y exposer
que le point d'entrée. Contactez le support LWS avec ce constat précis.

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
