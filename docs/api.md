# Endpoints HTTP

> Source de vérité : `server.apiRoutes` dans `src/mastra/index.ts`. Un fichier posé dans
> `src/api/` n'est **jamais** monté automatiquement — sans déclaration dans ce tableau, c'est
> du code mort. Ce document décrit le dépôt ; en cas de doute sur ce qui tourne, vérifier le
> déploiement `Production` (`npx vercel ls`) avant d'en conclure quoi que ce soit.

Ce serveur expose **deux familles de routes**, avec **deux authentifications différentes** :

| Famille | Chemins | Authentification | Déclarée où |
| ------- | ------- | ---------------- | ----------- |
| Webhooks Slack | `/slack/events`, `/slack/interactions`, `/internal/slack/events`, `/internal/slack/interactions` | **Signature HMAC-SHA256 Slack** | `server.apiRoutes` (ce dépôt) |
| Routes Mastra intégrées | `/api/*` | **Bearer `MASTRA_API_TOKEN`** | `@mastra/server` (le framework) |

Les deux familles ne se recouvrent pas et ne partagent aucun mécanisme d'authentification.
Le préfixe `/api` est **réservé** par `@mastra/server` : une route personnalisée qui commence
par lui fait échouer le **démarrage** du serveur (pas un 404). C'est la raison pour laquelle
les webhooks Slack vivent sous `/slack/…` et `/internal/slack/…`.

---

## 1. `POST /slack/events`

Webhook Slack Events API. C'est cette URL — `https://<domaine>/slack/events` — qui va dans le
champ *Request URL* de l'app Slack.

- **Fichier** : `src/api/slack-events.route.ts` (`SLACK_EVENTS_PATH`)
- **Méthode** : `POST` uniquement
- **`requiresAuth`** : `false` — le Bearer Mastra ne s'applique pas ; l'authentification est la
  signature Slack, vérifiée dans le handler lui-même.
- **Corps attendu** : JSON (`application/json`)

### Authentification

`verifySlackSignature` (`src/shared/security/slack-signature.ts`) : HMAC-SHA256 de
`v0:<timestamp>:<corps brut>` avec `SLACK_SIGNING_SECRET`, comparaison à **temps constant**,
rejet si le timestamp est décalé de plus de 5 minutes.

En-têtes requis : `X-Slack-Request-Timestamp` et `X-Slack-Signature`.
En-têtes lus mais optionnels : `X-Slack-Retry-Num` (déduplication des rejeux).

### Codes de réponse

| Code | Corps | Quand |
| ---- | ----- | ----- |
| `200` | `{"ok":true}` | Événement accusé. **N'implique PAS qu'il a été traité** : l'ACK part avant l'agent, le travail se poursuit en tâche de fond via `waitUntil`. C'est aussi la réponse quand l'événement est délibérément ignoré (doublon, message de bot, hors périmètre) — la raison est journalisée, pas rendue. |
| `200` | `{"challenge":"…"}` | Handshake `url_verification` de Slack. |
| `400` | `{"error":"invalid_json"}` | Le corps n'est pas du JSON analysable. |
| `401` | `{"error":"unauthorized","reason":"…"}` | Signature absente, invalide ou périmée. |

Valeurs possibles de `reason` sur un 401, dans l'ordre où elles sont testées :
`missing_signing_secret`, `missing_signature_headers`, `invalid_timestamp`, `stale_timestamp`,
`invalid_signature`.

⚠️ **`missing_signing_secret` est un défaut de CONFIGURATION du serveur, pas du client.** Il
rend le même 401 que les autres — délibérément : distinguer les deux renseignerait un
attaquant sur l'état de la configuration. La ligne de log, elle, le distingue.

### Contraintes Slack tenues par cette route

1. ACK en moins de **3 s** — mesuré à chaque requête, journalisé en `warn` au-delà de 1,5 s et
   en `error` au-delà de 3 s (`classifyAckLatency`).
2. Signature vérifiée avant toute autre chose.
3. Ses propres messages ignorés (`bot_id`, `subtype: bot_message`, `user === bot_user_id`).
4. Rejeux dédupliqués (`X-Slack-Retry-Num` + clé partagée en base).

---

## 2. `POST /slack/interactions`

Webhook d'interactivité Slack (clic de bouton, soumission de modale).

- **Fichier** : `src/api/slack-interactions.route.ts` (`SLACK_INTERACTIONS_PATH`)
- **Méthode** : `POST` uniquement
- **`requiresAuth`** : `false`
- **Corps attendu** : `application/x-www-form-urlencoded`, champ `payload=<json>`

C'est ce **format** qui justifie une route distincte de `/slack/events`, pas une préférence
d'organisation : la route Events ne sait lire que du JSON.

### Authentification

Identique à `/slack/events` — même fonction `verifySlackSignature`, mêmes en-têtes, même
fenêtre de 5 minutes.

### Codes de réponse

| Code | Corps | Quand |
| ---- | ----- | ----- |
| `200` | *(vide)* | Interaction accusée. Couvre `block_actions`, `view_submission`, le `ssl_check=1` de Slack, et tout type d'interaction non traité (journalisé en `debug`). |
| `400` | `{"error":"missing_payload"}` | Le champ `payload` est absent du formulaire. |
| `400` | `{"error":"invalid_payload"}` | Le champ `payload` n'est pas du JSON analysable. |
| `401` | `{"error":"unauthorized","reason":"…"}` | Mêmes `reason` que `/slack/events`. |

⚠️ Le `200` de succès a un **corps vide** (`new Response(null, { status: 200 })`), là où
`/slack/events` rend `{"ok":true}`. Slack accepte les deux ; la différence est réelle et
n'est pas à « harmoniser » sans vérifier ce qu'attend chaque API.

⚠️ **Il ne reste aucun bouton sur le chemin nominal du produit.** Les branches
`block_actions` subsistent pour les cartes **déjà postées** dans Slack, que rien ne rappelle ;
aucun code n'en émet plus. Une `view_submission` reçue est acquittée puis suivie d'un DM
disant que **rien n'a été retenu** — les modales ont été supprimées, et laisser la fenêtre se
fermer comme sur un succès serait le pire des deux comportements.

---

## 3. `POST /internal/slack/events`
## 4. `POST /internal/slack/interactions`

- **Fichiers** : mêmes que ci-dessus (`SLACK_EVENTS_WORK_PATH`, `SLACK_INTERACTIONS_WORK_PATH`)
- **Méthode**, **authentification**, **corps attendu**, **codes de réponse** : **strictement
  identiques** à `/slack/events` et `/slack/interactions` respectivement.

Ce ne sont pas d'autres routes : ce sont les **mêmes**, montées une seconde fois sur un autre
chemin. Le code le dit littéralement — une seule fabrique, appelée deux fois :

```ts
export const slackEventsRoute     = slackEventsRouteAt(SLACK_EVENTS_PATH);
export const slackEventsWorkRoute = slackEventsRouteAt(SLACK_EVENTS_WORK_PATH);
```

### Pourquoi un second chemin existe

Un clic de bouton SIGNÉ sur `/slack/interactions`, mesuré en production le 2026-08-19 :
**5 229 ms** à froid, 9 173 ms sur un déploiement neuf, 684 ms à chaud. Slack accorde
**3 secondes**. À ≈ 19 messages par jour, le démarrage à froid **est** le cas nominal.

Le correctif est un **portier d'ACK** : une seconde fonction Vercel sans aucune dépendance
(`scripts/slack-ack-function/index.mjs`, 24 Ko, zéro `node_modules`). Le routage Vercel
(`scripts/fix-vercel-output.js`) lui envoie `^/slack/(events|interactions)$`. Le portier
vérifie le HMAC, répond à Slack, puis **réexpédie la requête telle quelle** — corps brut
inchangé, `X-Slack-Signature` et `X-Slack-Request-Timestamp` recopiés — vers
`https://<hôte de la requête>/internal/slack/…`, où la fonction applicative la retraite.

⚠️ **Le chemin doit être DIFFÉRENT, sinon c'est une boucle.** La règle de routage Vercel se
décide sur le chemin : réexpédier vers `/slack/events` referait matcher la règle, la requête
reviendrait au portier, et le symptôme serait un bot définitivement muet avec des ACK
impeccables.

⚠️ **L'hôte de réexpédition vient de la requête** (`x-forwarded-host`), jamais d'une variable
d'environnement : sur un déploiement de prévisualisation, une URL de production ferait traiter
l'événement par le mauvais code — et le symptôme serait « ça marche ».

⚠️ **`url_verification` est répondu PAR LE PORTIER**, jamais réexpédié : Slack attend le
`challenge` **dans** la réponse, et un aller-retour rendrait un 200 vide, donc une URL refusée.

### Ce n'est PAS une porte dérobée

C'est la question que ce chemin appelle, et la réponse est vérifiable :

1. **Même handler, même fabrique.** `/internal/slack/events` n'est pas une variante allégée :
   `slackEventsRouteAt` produit les deux, avec la même vérification de signature sur le même
   corps brut. Il n'existe aucune branche de code qui saute un contrôle parce que le chemin
   commence par `/internal`.
2. **Un POST non signé y reçoit `401`.** Vérifié en production le 2026-08-19, sur les **quatre**
   endpoints — `/slack/events`, `/slack/interactions` et leurs jumelles `/internal` (campagne
   des déploiements `88hb6shko` → `ne5gg9sag` → `65utw20ho`).
3. **La frontière tiendrait sans le portier.** Si la règle de routage Vercel disparaissait, les
   requêtes arriveraient directement sur `/slack/…` et seraient vérifiées exactement pareil. Le
   portier achète de la LATENCE, il n'achète aucun droit.
4. **Le portier ne décide de rien.** Il n'ouvre aucune base, n'appelle jamais l'API Slack, et ne
   connaît aucun `action_id`. Son seul jugement est le HMAC — le même que celui d'en face.

Ce que le portier vérifie, avec ses propres `reason` (il ne partage pas le code TypeScript,
étant une fonction sans dépendance) : `missing_signature_headers`, `stale_timestamp`,
`signature_mismatch`. Il rend `405` sur toute méthode autre que `POST`.

⚠️ Le littéral `/internal/slack/…` est donc écrit **deux fois**, de part et d'autre de la
frontière JS/TS (`index.mjs` et les deux routes). Une divergence entre les deux ne casserait
aucun type et ne ferait rougir aucun test : le symptôme serait un bot muet.

---

## 5. Routes Mastra intégrées — `/api/*`

Elles ne sont **pas** déclarées par ce dépôt : `@mastra/server` les monte lui-même
(`/api/agents`, `/api/agents/:id`, `/api/agents/:id/stream`, `/api/workflows/…`, etc.).

### Authentification

**Bearer `MASTRA_API_TOKEN`** (`src/shared/security/api-auth.ts`) :

- En-tête `Authorization: Bearer <token>`.
- Le jeton attendu doit faire au moins **32 caractères** ; en dessous, il est traité comme
  absent.
- Comparaison à temps constant sur des empreintes SHA-256.
- **Fail-closed** : variable absente ou trop courte ⇒ **toutes** les routes `/api/*` répondent
  `401`, et une ligne `error` le dit une fois. Un service qui s'ouvrirait faute de
  configuration serait exactement le contraire de ce qu'on veut.
- `GET /api/agents` sans jeton → `401`, vérifié en production le 2026-08-19.

### Middlewares, dans l'ordre de montage

| Ordre | Chemin | Rôle | Effet observable |
| ----- | ------ | ---- | ---------------- |
| 1 | `*` | `createSecurityHeadersMiddleware` | Ajoute `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer` sur **toutes** les réponses, webhooks Slack compris. |
| 2 | `/api/*` | `createRequestContextGuard` | **`400`** si le corps porte une clé préfixée `slack` dans `requestContext`. |
| 3 | `/api/*` | `createAgentApiGuard` | Rédige `instructions` et les marqueurs internes ; refuse à l'entrée les demandes d'extraction de prompt. |
| 4 | `/api/*` | `createCallerErrorMiddleware` | Requalifie certains `500` en **`400`** (entrée de workflow invalide, par exemple). |

⚠️ **Le garde de `requestContext` REFUSE, il n'assainit pas.** Mastra fusionne
`body.requestContext` dans le contexte serveur et n'écarte que ses propres clés réservées —
`slackEmployeeId` et `slackAccessLevel`, sur lesquelles se décident les droits, n'en font pas
partie. Un porteur du jeton de service pouvait donc se déclarer n'importe qui. Le garde
surveille le **préfixe** `slack`, pas une liste recopiée, et rend `400` plutôt que de laisser
l'appel aboutir avec un contexte silencieusement différent de celui demandé.

⚠️ **CORS est fermé** : `cors: { origin: [], credentials: false }`. Aucune origine navigateur
n'est autorisée.

⚠️ `/slack/events` et ses jumelles ne sont **pas** concernées par les middlewares 2 à 4 : elles
sont montées hors du préfixe `/api` et s'authentifient par signature. C'est le seul producteur
légitime des clés `slack*`.

---

## Récapitulatif

| Méthode | Chemin | Auth | Codes |
| ------- | ------ | ---- | ----- |
| `POST` | `/slack/events` | HMAC Slack | `200`, `400`, `401` |
| `POST` | `/slack/interactions` | HMAC Slack | `200`, `400`, `401` |
| `POST` | `/internal/slack/events` | HMAC Slack | `200`, `400`, `401` |
| `POST` | `/internal/slack/interactions` | HMAC Slack | `200`, `400`, `401` |
| `*` | `/api/*` | Bearer `MASTRA_API_TOKEN` | `401` sans jeton ; `400` sur `requestContext` forgé |

Servi par le portier d'ACK (fonction Vercel séparée), pas par l'application :
`405` sur toute méthode autre que `POST` vers `/slack/events` et `/slack/interactions`.

⚠️ **Aucune de ces routes ne sert un document.** Il n'existe **aucune URL de téléchargement**
dans ce système : un document est livré par upload dans le fil Slack, ou en pièce jointe
d'email. Un lien de la forme `https://kisso.internal/docs/<uuid>/download` a été observé en
production — il était **inventé par le modèle**, et `sanitizeAgentOutput` retire aujourd'hui
toute URL hors liste blanche.
