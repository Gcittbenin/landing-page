# Notification WhatsApp Business (Meta Cloud API)

Chaque prospect validé déclenche une alerte WhatsApp vers la ligne commerciale
GCITT. Ce document explique comment obtenir les identifiants, faire approuver
le template, et diagnostiquer les erreurs.

---

## 1. Pourquoi un template est nécessaire

Meta n'autorise un message **texte libre** que si le destinataire a écrit au
numéro de l'entreprise dans les **24 heures** précédentes.

L'alerte GCITT est un message *sortant*, envoyé vers la ligne commerciale qui
n'a en général rien écrit au numéro de l'application. On est donc **hors de la
fenêtre de 24 h**, et Meta exige un **template approuvé**.

Le code gère les deux cas :

| `META_WHATSAPP_TEMPLATE_NAME` | Comportement |
| --- | --- |
| vide | Message texte libre. Fonctionne en test et dans une fenêtre de 24 h ouverte. **Ne pas utiliser en production.** |
| renseigné | Template approuvé. Fonctionne en permanence. |

Si le texte libre est refusé faute de fenêtre ouverte, l'API renvoie une erreur
explicite (code Meta `131047`, `131026` ou `470`) et le log serveur indique
qu'il faut renseigner `META_WHATSAPP_TEMPLATE_NAME`.

---

## 2. Obtenir les identifiants

1. Créez une application sur [developers.facebook.com](https://developers.facebook.com/)
   → **Créer une app** → type **Entreprise**.
2. Ajoutez le produit **WhatsApp**.
3. Dans **WhatsApp → Configuration de l'API**, relevez :
   - **Identifiant du numéro de téléphone** → `META_PHONE_NUMBER_ID`
   - **Identifiant du compte WhatsApp Business** → `META_BUSINESS_ACCOUNT_ID`
4. Générez un **token permanent** : **Paramètres de l'entreprise → Utilisateurs
   système** → créez un utilisateur système, donnez-lui le rôle admin sur le
   compte WhatsApp Business, puis **Générer un nouveau token** avec les
   autorisations `whatsapp_business_messaging` et
   `whatsapp_business_management` → `META_WHATSAPP_TOKEN`.

> Le token affiché dans l'onglet « Configuration de l'API » expire au bout de
> 24 h. Il sert aux essais, jamais à la production.

Le numéro qui **reçoit** les alertes est `GCITT_SALES_WHATSAPP` : indicatif
pays en tête, chiffres uniquement, sans `+` ni espaces
(`2290167212128`). Ce numéro doit être un compte WhatsApp actif.

---

## 3. Template à faire approuver

Dans **WhatsApp Manager → Modèles de message → Créer un modèle** :

- **Nom** : `gcitt_nouveau_prospect`
- **Catégorie** : `Utility` (et non `Marketing` : c'est une notification
  interne, la catégorie `Utility` est moins chère et approuvée plus vite)
- **Langue** : Français (`fr`)
- **En-tête** : aucun
- **Pied de page** : aucun
- **Boutons** : aucun

**Corps du message**, à copier tel quel :

```
🚨 NOUVEAU PROSPECT GCITT

👤 Nom :
{{1}}

📱 Téléphone :
{{2}}

📧 Email :
{{3}}

🏠 Projet recherché :
{{4}}

💬 Message :
{{5}}

📅 Date :
{{6}}

⚡ Action :
Contacter rapidement ce prospect.
```

**Exemples** demandés par Meta lors de la soumission :

| Variable | Exemple |
| --- | --- |
| `{{1}}` | `Awa Diallo` |
| `{{2}}` | `+33612345678` |
| `{{3}}` | `awa@example.com` |
| `{{4}}` | `Villa Kafui (Duplex) — Cité Cœur Joie` |
| `{{5}}` | `Bonjour, je souhaite visiter en juillet.` |
| `{{6}}` | `01/03/2026 à 10h30` |

Une fois le modèle **approuvé** :

```
META_WHATSAPP_TEMPLATE_NAME=gcitt_nouveau_prospect
META_WHATSAPP_TEMPLATE_LANG=fr
```

L'ordre des variables est fixé par `whatsappTemplateParams()` dans
`lib/format.js`. Si vous modifiez le corps du template, modifiez cette fonction
en conséquence — un test vérifie que les six paramètres restent alignés.

### Contraintes Meta sur les paramètres

Un paramètre de template ne peut contenir **ni retour à la ligne, ni
tabulation, ni plus de quatre espaces consécutifs**, et ne peut pas être vide.
`toTemplateParam()` s'en charge : le message du prospect est aplati sur une
seule ligne, tronqué à 900 caractères, et remplacé par `Aucun message` s'il est
vide. **Le message intégral reste toujours dans l'email.**

---

## 4. Vérifier l'intégration

```sh
# 1. Renseignez .env, puis démarrez le serveur
npm start                # lance node app.js

# 2. Envoyez un prospect de test
curl -X POST http://localhost:3000/api/lead \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Test Prospect",
    "email": "test@example.com",
    "phone": "+33612345678",
    "villa": "Villa Fenou (F4)",
    "message": "Ceci est un test."
  }'
```

Réponse attendue :

```json
{ "ok": true, "delivered": { "whatsapp": true, "email": true, "crm": false } }
```

`"crm": false` est normal tant que `CRM_WEBHOOK_URL` n'est pas configuré : une
intégration non configurée est *ignorée*, pas *en échec*.

---

## 5. Erreurs Meta courantes

| Code | Signification | Correctif |
| --- | --- | --- |
| `131047` | Fenêtre de 24 h fermée | Renseigner `META_WHATSAPP_TEMPLATE_NAME` |
| `131026` | Message non délivrable | Le numéro destinataire n'a pas de compte WhatsApp actif |
| `132001` | Template introuvable | Vérifier le nom **et** la langue (`fr` vs `fr_FR`) |
| `132000` | Nombre de paramètres incorrect | Le corps du template ne contient plus 6 variables |
| `190` | Token invalide ou expiré | Générer un token d'utilisateur système permanent |
| `100` | Paramètre invalide | Souvent `to` mal formé : chiffres uniquement, sans `+` |
| `133010` | Numéro non enregistré | Terminer l'enregistrement du numéro dans WhatsApp Manager |

Les échecs sont journalisés côté serveur avec le code et le message Meta. Le
prospect, lui, ne voit jamais ces détails : il reçoit une invitation à passer
par WhatsApp.

---

## 6. Ce que voit le prospect en cas de panne

Si un canal **configuré** échoue, l'API répond `502` et le formulaire affiche :

> Votre demande a été enregistrée mais la notification a échoué. Merci de nous
> contacter directement sur WhatsApp.

C'est délibéré : mieux vaut réorienter le prospect vers WhatsApp que lui
afficher une confirmation alors que personne n'a été prévenu. Le prospect reste
dans tous les cas enregistré dans les logs serveur (`[lead] reçu`), qui font
office de dernier filet de sécurité.
