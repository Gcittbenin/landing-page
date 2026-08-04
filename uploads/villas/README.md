# Photos des cités et des villas

Un seul fichier décide de ce qui s'affiche : **`assets/villas.json`**.
Déposer une image ici ne suffit pas — il faut aussi ajouter son chemin dans ce
fichier. C'est le seul endroit à modifier.

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

## Ajouter une photo à une villa

1. Déposer le fichier, par exemple `uploads/villas/coeur-joie/fenou/cuisine.jpg`.
2. Ajouter une entrée dans `assets/villas.json`, dans le `gallery` de la villa :

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

C'est tout. Rien à modifier dans le HTML ni dans le JavaScript.

## Ajouter une photo à une cité

Identique, dans `uploads/villas/<cité>/cite/`, puis dans le `gallery` de la
cité (au même niveau que `villas`), et non dans celui d'une villa.

## Version mobile : `srcset`

Facultatif. Laissé vide, la photo est servie telle quelle — correct, mais un
téléphone télécharge alors l'image pleine taille.

Pour l'éviter, préparer une variante réduite (≈ 500 px de large) suffixée
`-sm`, puis :

```json
"srcset": "uploads/villas/coeur-joie/fenou/cuisine-sm.jpg 500w, uploads/villas/coeur-joie/fenou/cuisine.jpg 1600w"
```

Les largeurs annoncées (`500w`, `1600w`) doivent être les largeurs réelles des
fichiers, sinon le navigateur choisit mal.

## Remplacer une image temporaire par la photo officielle

Deux façons, au choix :

* **écraser le fichier** en gardant le même nom — rien à modifier ailleurs ;
* **déposer un nouveau fichier** et changer le `src` dans `assets/villas.json`.

Les visuels Béthel actuellement en place (`uploads/bethel-f4.png`,
`uploads/bethel-duplex.png`) sont des **perspectives d'architecte**, pas des
photographies. Elles sont annoncées comme telles dans les légendes et attendent
les vraies photos.

## Les familles : des illustrations, pas des clients

Le dossier `familles/` reçoit des **mises en scène illustratives** destinées à
la section « Imaginez votre vie ici ». Elles ne sont jamais présentées comme de
vrais propriétaires : aucun nom, aucune citation, aucun témoignage ne leur est
associé, et chaque image porte la mention « Mise en scène illustrative ».

La section n'apparaît pas tant qu'aucune image n'est fournie — mieux vaut pas
de section qu'une section vide.

Pour l'activer, remplir le champ `family` de la villa concernée :

```json
"family": {
  "src": "uploads/villas/familles/fenou/famille-01.jpg",
  "srcset": "",
  "alt": "Famille devant une villa F4, remise symbolique des clés"
}
```

Une famille différente par villa : composition, âges, tenues et posture
distinctes, pour qu'aucune répétition visuelle ne saute aux yeux.

**Les vrais témoignages clients sont ailleurs** : `assets/temoignages.json`,
avec de vraies personnes, de vraies citations et l'accord écrit de publication.
Les deux systèmes ne se croisent jamais.

## Poids des fichiers

Viser **moins de 300 Ko** par photo. Toutes les images de galerie sont chargées
en différé (`loading="lazy"`) et ne partent qu'à l'ouverture de la visionneuse,
donc elles ne pèsent pas sur l'affichage initial de la page — mais une photo de
5 Mo reste 5 Mo à télécharger pour le prospect qui l'ouvre.
