# Photos des cités et des villas

Déposez les fichiers ici, puis lancez **`npm run photos -- --ecrire`**.
Le dossier fait foi : `assets/villas.json` est mis en accord avec ce qui est
réellement sur le disque, et c'est ce fichier que la page lit.

## Où déposer quoi

```
uploads/villas/
├── coeur-joie/
│   ├── cite/            vues générales, rues, aériennes, scènes de vie
│   ├── fenou/           Villa Fenou F4
│   └── kafui/           Villa Kafui Duplex
├── bethel/
│   ├── cite/            vues générales, voiries, aériennes, architecture
│   ├── bethel-f4/       Villa Bethel F4
│   └── bethel-duplex/   Villa Bethel Duplex
└── familles/
    ├── fenou/           illustration « Imaginez votre vie ici » — Fenou
    ├── kafui/                                                     Kafui
    ├── bethel-f4/                                                 Bethel F4
    └── bethel-duplex/                                             Bethel Duplex
```

**Ne mélangez jamais les deux cités.** Une photo de Cœur Joie ne doit pas
apparaître chez Béthel, ni l'inverse. Un test automatique le vérifie et le
déploiement échoue si la règle est enfreinte.

## Ajouter des photos — la façon simple

1. Déposer les fichiers dans le bon dossier, nommés dans l'ordre voulu :

```
uploads/villas/coeur-joie/fenou/01-facade-avant.jpg
uploads/villas/coeur-joie/fenou/02-terrasse-entree.jpg
uploads/villas/coeur-joie/fenou/03-sejour.jpg
```

2. Lancer :

```sh
npm run photos              # montre ce qui serait fait, sans rien écrire
npm run photos -- --ecrire  # applique
npm test                    # vérifie
```

C'est tout. Le dossier fait foi : `assets/villas.json` est mis en accord avec
ce qui est réellement sur le disque, dans l'ordre des numéros. La première
photo devient la vignette de la carte.

**Le numéro décide de l'ordre.** `01-` d'abord, puis `02-`, etc.

**Le nom devient la légende.** `03-remise-des-cles.jpg` → « Remise des clés ».
Les accents sont rétablis automatiquement pour les mots courants (séjour,
façade, clés, arrière, d'ensemble…).

**Ce qui a été écrit à la main est conservé.** Si vous avez rédigé une légende
ou un texte alternatif dans `assets/villas.json`, le script n'y touche pas : il
ne remplit que ce qui manque.

**Retirer une photo du dossier la retire de la galerie.** Le dossier est la
source, pas une pile où l'on empile.

## Ajouter une photo à la main

Si vous préférez éditer le JSON directement, ajoutez une entrée dans le
`gallery` de la villa ou de la cité :

```json
{
  "src": "uploads/villas/coeur-joie/fenou/cuisine.jpg",
  "srcset": "",
  "alt": "Cuisine de la Villa Fenou F4",
  "caption": "Cuisine"
}
```

`alt` décrit l'image pour les personnes qui ne la voient pas — il est
obligatoire. `caption` s'affiche sous la photo dans la visionneuse.

## Un premier plan ingrat : le cadrage

Terre retournée, herbes, gravats devant la façade ? Inutile de retoucher le
fichier : ajoutez un `focus` à la vignette de la carte pour remonter le
cadrage.

```json
"card": {
  "src": "uploads/villas/coeur-joie/kafui/01-facade-avant.jpg",
  "focus": "center 30%"
}
```

`center 30%` garde le tiers supérieur — la façade — et écarte le sol. Les
valeurs utiles vont de `center 20%` (cadrage haut) à `center 50%` (centré, la
valeur par défaut). Cela n'agit que sur la vignette recadrée de la carte ; la
visionneuse montre toujours la photo entière.

Pour un vrai nettoyage de l'image, il faut recadrer ou retoucher le fichier
avant de le déposer — le site ne peut pas le faire.

## Version mobile : `srcset`

Facultatif. Laissé vide, la photo est servie telle quelle — correct, mais un
téléphone télécharge alors l'image pleine taille.

Pour l'éviter, déposer à côté du fichier une variante réduite (≈ 500 px de
large) portant le **même nom suffixé `-sm`** :

```
01-facade-avant.jpg
01-facade-avant-sm.jpg
```

`npm run photos` la reconnaît, lit les largeurs réelles des deux fichiers et
écrit le `srcset` correspondant. Rien à calculer.

## Remplacer une image temporaire par la photo officielle

Deux façons, au choix :

* **écraser le fichier** en gardant le même nom — rien à modifier ailleurs ;
* **déposer un nouveau fichier** et changer le `src` dans `assets/villas.json`.

Les visuels Béthel actuellement en place (`uploads/bethel-f4.png`,
`uploads/bethel-duplex.png`) sont des **perspectives d'architecte**, pas des
photographies. Elles sont annoncées comme telles dans les légendes et attendent
les vraies photos.

## « Imaginez votre vie ici » : deux cas, une seule règle

Le dossier `familles/<villa>/` alimente la section « Imaginez votre vie ici ».
Une image par villa, différente à chaque fois. La section n'apparaît pas tant
qu'aucune image n'est fournie — mieux vaut pas de section qu'une section vide.

Le champ `staged` décide de ce qui est affiché sous la photo :

| `staged` | Ce que c'est | Mention affichée |
| --- | --- | --- |
| `true` *(défaut)* | Mise en scène, modèles | « Mise en scène illustrative » |
| `false` | Vraie photo, **avec accord écrit** | aucune |

```json
"family": {
  "src": "uploads/villas/familles/bethel-duplex/01-remise-des-cles.jpg",
  "alt": "Remise des clés devant une villa Duplex à la Cité Béthel",
  "staged": false
}
```

**`staged: false` engage l'entreprise.** Il déclare que les personnes
reconnaissables sur la photo ont donné leur accord écrit pour la publication.
Sans cet accord, la photo ne doit pas être mise en ligne — quelle que soit sa
qualité.

Dans les deux cas, et sans exception : **aucun nom, aucune citation**. Une
photo n'est pas un témoignage. Étiqueter une vraie photo « mise en scène »
serait aussi faux que de présenter une mise en scène comme réelle ; c'est
pourquoi le champ existe et pourquoi sa valeur par défaut est la plus prudente.

**Les témoignages sont ailleurs** : `assets/temoignages.json`, avec de vraies
personnes, de vraies citations et l'accord écrit de publication. Les deux
systèmes ne se croisent jamais.

## Poids des fichiers

Viser **moins de 300 Ko** par photo. Toutes les images de galerie sont chargées
en différé (`loading="lazy"`) et ne partent qu'à l'ouverture de la visionneuse,
donc elles ne pèsent pas sur l'affichage initial de la page — mais une photo de
5 Mo reste 5 Mo à télécharger pour le prospect qui l'ouvre.
