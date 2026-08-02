# Espace de pilotage — mode d'emploi

> **L'adresse de la console.** Par défaut `/admin`. Si l'hébergeur réserve ce
> chemin — symptôme : une erreur 500 sur `/admin` alors que le site répond —
> elle se déplace avec la variable `ADMIN_PATH` (par exemple `/pilotage`). La
> procédure de diagnostic complète est dans `DEPLOIEMENT_LWS.md`, section
> « Diagnostiquer une erreur 500 ».

L'espace `/admin` sert trois métiers à la fois : la direction lit l'onglet
**Accueil**, le commerce vit dans **Pipeline** et **Prospects**, le marketing
dans **Marketing**, **Parcours** et **SEO**.

Ce document explique ce que chaque chiffre veut dire — et, tout aussi
important, **d'où il vient**. Un tableau de bord dont on ne sait pas comment il
calcule finit par être ignoré ou, pire, cru sur parole.

---

## Le principe qui gouverne tout l'espace

> Un chiffre est soit calculé à partir d'événements réellement enregistrés,
> soit affiché « — ».

Rien n'est estimé, extrapolé ni complété par une valeur plausible. Une case
vide dit la vérité sur un suivi manquant ; une case remplie au jugé envoie
quelqu'un en réunion avec un chiffre inventé.

C'est pourquoi le taux de conversion affiche « — » et non « 0 % » tant
qu'aucune session n'a été enregistrée : 0 % se lirait comme une catastrophe
alors que cela signifie « pas encore de données ».

Les journées sont découpées à **l'heure du Bénin (UTC+1)**. « Aujourd'hui »
correspond à la journée de travail de l'équipe, pas à une fenêtre UTC qui
s'achèverait à 1 h du matin.

---

## 1. Accueil

Douze cartes, chacune avec sa valeur, son évolution et le sens de la variation.

| Carte | Source | Précision |
| --- | --- | --- |
| Visiteurs (jour / 7 j / 30 j) | événements `page_view` | comptés en **sessions** : un visiteur qui recharge trois fois compte pour un |
| Prospects (jour / 30 j) | formulaires reçus | |
| Rendez-vous planifiés | CRM | fiches à l'étape « Rendez-vous planifié » ou au-delà, hors « Perdu » |
| Taux de conversion | prospects ÷ sessions | le seul ratio que les données permettent |
| Clics WhatsApp / CTA | événements | sur 30 jours |
| Temps moyen | événement `engagement` | **temps visible uniquement** : un onglet laissé ouvert en arrière-plan ne compte pas |
| Profondeur de scroll | événements `scroll` | moyenne du **point le plus bas** atteint par session |
| Visiteurs en ligne | tous événements | activité dans les 5 dernières minutes |

**La flèche et le pourcentage** comparent à la période précédente de même
durée : aujourd'hui vs hier, 7 jours vs les 7 précédents, 30 jours vs les 30
précédents. Quand la période précédente est vide, aucune flèche n'est
affichée — « +0 % » face à une semaine sans données se lirait comme une
stagnation.

---

## 2. Pipeline

Neuf colonnes, de « Nouveau prospect » à « Projet livré », plus « Perdu ».
Faites glisser une fiche d'une colonne à l'autre.

Chaque déplacement écrit deux traces : une ligne dans **l'historique de la
fiche** (avec l'étape de départ, l'étape d'arrivée, la date et l'auteur) et une
entrée dans le **journal d'audit**.

« Perdu » est délibérément hors du flux linéaire : une affaire peut être perdue
depuis n'importe quelle étape, et la compter comme une progression fausserait
tous les entonnoirs qui suivent.

**Les anciennes fiches ne sont pas perdues.** Les cinq statuts d'origine sont
traduits à la lecture : Nouveau → Nouveau prospect, Contacté → Premier contact,
En cours → Négociation, Converti → Contrat signé, Perdu → Perdu. Le fichier sur
disque n'est jamais réécrit ; c'est un journal en ajout seul, et c'est ce qui
garantit qu'un arrêt brutal coûte au plus la dernière ligne.

---

## 3. Prospects

Recherche plein texte (nom, email, téléphone, message, commercial) et filtres
combinables. **L'export CSV respecte exactement les filtres affichés** — un
export qui ne correspond pas à ce que l'on regarde est pire que pas d'export.

Le CSV s'ouvre directement dans un Excel français : séparateur point-virgule,
BOM UTF-8 pour les accents, et les cellules commençant par `=`, `+`, `-` ou `@`
sont neutralisées pour qu'Excel ne les exécute pas comme des formules.

### La fiche prospect

Tout ce que le formulaire a transmis, plus le contexte de la visite (appareil,
navigateur, système, écran, fuseau horaire, adresse IP), l'étape, le commercial
assigné, les notes, un fil de commentaires, l'historique des étapes et **le
parcours du visiteur sur le site**.

Ce dernier est rapproché par identifiant de session : il n'existe que pour les
prospects arrivés **après** la mise en place du suivi. Pour les fiches
antérieures, la section affiche « Aucun parcours rattaché » plutôt qu'un vide
ambigu.

---

## 4. Marketing

Acquisition, géographie, appareils, navigateurs, systèmes, heures et jours de
visite, temps moyen, profondeur de scroll, taux de rebond, pages consultées,
CTA cliqués.

Deux colonnes d'acquisition, à lire ensemble : **visiteurs** (ce que la source
amène) et **prospects** (ce que la source convertit). Une source qui amène
beaucoup de visiteurs et peu de prospects coûte de l'argent.

**Le taux de rebond** compte les sessions qui n'ont rien fait d'autre que
charger la page : ni défilement, ni clic, ni formulaire.

### Géographie : ce qui est mesuré et ce qui ne l'est pas

- **Pays déclarés par les prospects** — le champ du formulaire. Fiable.
- **Pays estimés des visiteurs** — déduit du fuseau horaire du navigateur. Une
  approximation utile pour lire une tendance, pas une géolocalisation. Les
  fuseaux non reconnus sont listés tels quels plutôt que devinés.
- **Villes** — non disponibles. Cela demanderait une base GeoIP : une
  dépendance, une licence et une mise à jour mensuelle. Le jour où le besoin
  est réel, c'est ce fichier de correspondance qu'il faudra remplacer, pas
  l'architecture.

---

## 5. Parcours

### L'entonnoir

Huit étapes, chacune comptée en sessions. Les cinq premières viennent des
événements du navigateur, les trois dernières du CRM — un contrat signé n'est
pas quelque chose qu'un navigateur peut rapporter.

Le pourcentage indique la part **conservée depuis l'étape précédente** ; c'est
lui qui pointe le frottement. Le nombre en rouge, ce sont les visiteurs perdus
à cette étape précise.

### La heatmap

Les clics sont enregistrés en **pourcentage de la page**, jamais en pixels :
un pourcentage est comparable entre un téléphone et un écran 27 pouces, et
c'est de toute façon ce dont une superposition a besoin.

La grille est posée **sur la page réelle**, chargée à l'échelle dans un cadre :
une zone chaude se reconnaît comme « le bouton Prendre rendez-vous » et non
comme « la case 7,12 ». La case à cocher « Afficher la page dessous » permet de
revenir à la grille seule.

Chaque case couvre 5 % de la largeur et 2,5 % de la hauteur. Plus la case est
rouge, plus la zone est cliquée ; une case vide est une zone ignorée.

L'aperçu n'enregistre rien : `tracking.js` détecte qu'il est dans un cadre et
se met en sommeil. Sans cela, chaque ouverture de cet onglet gonflerait les
chiffres que l'onglet affiche.

À côté, la **profondeur atteinte** : la part des sessions ayant vu 25, 50, 75
et 90 % de la page. C'est ce qui dit si les prospects arrivent jusqu'au
formulaire.

### Enregistrement de session (Clarity / Hotjar)

Non activé par défaut. La heatmap et la profondeur de scroll ci-dessus sont
calculées à partir de nos propres données. Ce que nous ne collectons
délibérément pas, c'est le **rejeu de session** — enregistrer ce qu'un visiteur
fait frappe par frappe est un autre ordre de collecte, qui doit être une
décision consciente et non un réglage par défaut.

Pour l'activer, renseignez `clarity` ou `hotjar` dans
`assets/tracking-config.js`. L'un ou l'autre, pas les deux, sans quoi chaque
session est enregistrée en double.

---

## 6. SEO

Un score sur 100, calculé à partir de quinze contrôles pondérés effectués sur
**le fichier réellement servi**, avec pour chaque échec la correction à
apporter.

### Core Web Vitals

Mesurées sur les appareils des vrais visiteurs (`PerformanceObserver`, sans
bibliothèque), pas en laboratoire. La valeur affichée est le **75ᵉ centile** :
c'est exactement ce que Google utilise pour le classement, et cela reflète les
téléphones et les connexions qu'ont réellement nos prospects.

### Ce qui n'est pas affiché, et pourquoi

- **Score Lighthouse** — une mesure de laboratoire sur un appareil simulé. Les
  Core Web Vitals ci-dessus sont la même chose en mieux : des mesures réelles.
- **Pages indexées** — ce chiffre n'existe que dans Google Search Console. Il
  faut y vérifier le domaine puis fournir des identifiants d'API. Aucune
  estimation fiable n'est possible sans cela.
- **Liens externes** — non testés. Cela demanderait une requête réseau par lien
  à chaque ouverture du tableau de bord, et une panne temporaire chez un tiers
  s'afficherait comme une erreur de notre site. Les liens **internes** et les
  fichiers locaux, eux, sont bien vérifiés.

---

## 7. Temps réel

Les sessions ayant émis un événement dans les 5 dernières minutes, rafraîchies
toutes les 10 secondes. La référence affichée fait 8 caractères : assez pour
suivre une visite dans le journal, pas assez pour constituer un identifiant
durable.

---

## 8. Journal

Deux tableaux côte à côte, volontairement séparés.

- **Journal d'audit** : qui a fait quoi, et quand. Connexions (réussies et
  refusées), changements d'étape, modifications de fiche, commentaires, exports
  CSV, sauvegardes, restaurations.
- **Événements visiteurs** : le trafic.

Les mélanger rendrait les deux illisibles et permettrait d'enterrer une trace
d'audit sous un flot de pages vues.

Le mot de passe d'une tentative de connexion refusée n'est jamais journalisé.

---

## 9. Sauvegarde

**Téléchargez la sauvegarde régulièrement et conservez-la hors de
l'hébergement.** Un déploiement ne touche pas au dossier `data/` — il est exclu
des envois FTP — mais une suppression de compte, si.

La restauration est **additive** : les fiches déjà présentes sont conservées,
seules les absentes sont réinsérées. Restaurer deux fois le même fichier ne
crée pas de doublon, et restaurer une vieille sauvegarde ne supprime jamais les
prospects arrivés depuis.

Il n'existe volontairement **pas** de mode « tout remplacer » : un clic de trop
sur un tel bouton coûterait l'intégralité du fichier client.

---

## Notifications

Le tableau de bord interroge le serveur toutes les 15 secondes. À l'arrivée
d'un nouveau prospect, une notification apparaît et les chiffres se mettent à
jour sans rechargement.

Un sondage court plutôt qu'un flux SSE : Apache met en tampon un flux
server-sent events devant Passenger, et un flux bloqué est un tableau de bord
qui cesse silencieusement de se mettre à jour — bien pire qu'un sondage qui
fonctionne toujours.

L'alerte WhatsApp Business et l'email à l'équipe commerciale partent déjà à la
réception du formulaire ; voir `docs/WHATSAPP.md`.
