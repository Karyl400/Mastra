# Audit de sécurité — dépôt `kisso-onboarding`

Branche `refactor/cleanup-20260810`, audit en **lecture seule**, 2026-08-21.
Aucun fichier du dépôt n'a été modifié ; aucun script réseau, base ou envoi n'a été exécuté.
`npx tsc --noEmit` : **0 erreur**. `npm run lint` : **0 warning, 0 erreur**.

> Méthode : chaque constat a été vérifié dans le code, et le commentaire qui l'entoure a été lu
> avant qualification. Quand un comportement est un choix documenté, je le dis et je discute la
> justification au lieu de la traiter comme un défaut.

---

## Constats

### [HAUTE] `scheduleReminder` écrit en base une prose de modèle qui n'est JAMAIS assainie, et le cron la livre un jour plus tard

**Constat.**
`src/features/notification/application/tools/schedule-reminder.ts:87-88` stocke `subject` et
`body` **bruts**, tels que le modèle les a produits :

```ts
subject: data.subject,
body: data.body,
```

`src/features/notification/application/services/dispatch-due-reminders.ts:180-188` les ressort
tels quels, en Slack (`` `${preamble}\n\n*${reminder.subject}*\n\n${reminder.body}` ``) comme en
email (`textEmailBody(\`${preamble}\n\n${reminder.body}\`)`).

Aucun appel à `sanitizeNotificationBody` sur ce chemin — alors que son voisin de gravité
`sendNotification` l'appelle (`send-notification.ts:119`, via `safeNotificationBody`), et que
tout le dépôt est construit autour de l'idée que la sortie du modèle est filtrée exactement une
fois, au bon endroit.

**Pourquoi ça compte.** Le filtre manquant est celui qui retire (a) les marqueurs internes
(`INTERNAL_MARKERS`, `agent-output.ts:17-27`) et (b) **toute URL hors `ALLOWED_LINK_DOMAINS`**
(`agent-output.ts:5`). Or le contexte du modèle contient, par conception, du texte non fiable :
extraits de canaux, faits distillés, messages Slack d'autrui. Une injection réussie dans ce
contenu peut donc faire écrire au modèle un rappel contenant un lien vers un domaine arbitraire,
qui sera remis **par email, à un salarié, le lendemain matin, sans qu'aucun humain ne relise**.
Le chemin `sendNotification` est fermé, celui-ci ne l'est pas : c'est la même primitive,
temporisée. C'est aussi le seul chemin sortant du produit sur lequel personne n'est présent au
moment de l'envoi — donc celui où un lien de hameçonnage a le plus de chances d'aboutir.

À noter que la faille est *récente au sens fonctionnel* : tant que « aucun automate ne reprenait
le statut `Scheduled` », rien ne partait et le défaut dormait. Le cron du 2026-08-21 l'a réveillé.
C'est exactement la leçon que le dépôt a déjà tirée pour `onlyNonDeliveringTools` — *« un
détecteur encode le câblage ; quand le câblage bouge, il devient faux »* — appliquée ici à un
assainisseur plutôt qu'à un détecteur.

**Recommandation.** Assainir **à l'écriture** dans `scheduleReminder` (et non seulement à la
remise) : le texte stocké doit déjà être propre, sans quoi une base relue par un futur code
ressortirait le marqueur. Assainir **aussi** à la remise, comme `generateDocument` filtre à deux
endroits pour la même raison (persistance et journalisation vivent hors du renderer). Un test de
non-régression du type « une URL hors liste blanche dans un rappel n'atteint jamais le
transport » verrouillerait le contrat sur les deux implémentations.

---

### [HAUTE] Le `subject` de `sendNotification` échappe au seul filtre de sortie, alors que le `body` y passe

**Constat.** `src/features/notification/application/tools/send-notification.ts:119-125` :

```ts
const safe = safeNotificationBody(data.body, { ... });   // body assaini
...
await emailProvider.sendEmail(destination, data.subject, textEmailBody(safe.text));
await chatProvider.sendMessage(destination, `*${data.subject}*\n\n${safe.text}`);
```

`data.subject` (jusqu'à 200 caractères, `z.string().min(1).max(200)`, et le `.describe()` ordonne
explicitement au modèle de le **rédiger**) part sans passer par `sanitizeNotificationBody`.

**Pourquoi ça compte.** Le sujet est la partie la plus visible d'un email et la ligne en gras
d'un message Slack. Un marqueur interne y ressortirait tel quel ; surtout, une URL hors liste
blanche y survivrait alors qu'elle est retirée deux caractères plus loin dans le corps. C'est une
asymétrie dans une défense que ce dépôt a délibérément construite, pas une défense absente : le
correctif est d'une ligne.

Point positif à relever au passage : `textEmailBody` (`email-body.ts:29-33`) **échappe le HTML**
avant de construire la version `html` — l'injection HTML dans un email est donc fermée. Et
`subject` figure dans `PII_KEYS`, donc la journalisation (`send-notification.ts:79`) le masque.

**Recommandation.** Appliquer `sanitizeNotificationBody` (ou une variante `sanitizeSubject` sans
placeholder de repli) à `subject` sur les deux transports, et sur `scheduleReminder` en même
temps. Étendre le test `promised-delivery` / `notification-output-channel` au sujet.

---

### [HAUTE] Un porteur de `MASTRA_API_TOKEN` contourne toute la frontière d'autorisation — non par usurpation, mais par ABSENCE de contexte

**Constat.** La règle centrale, `src/shared/slack-request-context.ts:144-152` :

```ts
function mayTouchRecord(requestContext, targetEmployeeId) {
  const context = readSlackContext(requestContext);
  if (!context) return true;          // ← pas de contexte Slack ⇒ autorisé
  ...
  return context.accessLevel === 'full';
}
```

`canReadPersonRecord` et `canPerformSideEffects` délèguent tous deux à cette fonction.
`readSlackContext` rend `undefined` dès que la clé `slackChannel` est absente
(`slack-request-context.ts:178-179`).

Or Mastra expose, sous `/api/*`, `POST /api/tools/:toolId/execute` et
`POST /api/agents/:agentId/tools/:toolId/execute` (vérifié dans
`node_modules/@mastra/server/dist/docs/references/reference-server-routes.md`). Ces routes sont
protégées par `createApiAuthConfig` — fail-closed, bien —, mais une fois le jeton présenté,
**aucune règle RBAC ne s'applique** : `coreAuthMiddleware`
(`node_modules/@mastra/server/dist/helpers-GyeAi5YN.js:352-356`) ne consulte
`defaultAuthConfig.rules` que si `server.rbac` est configuré, ce que `src/mastra/index.ts` ne fait
pas. Le jeton donne donc accès à tous les outils.

`createRequestContextGuard` (`src/shared/security/request-context-guard.ts`) refuse bien de laisser
un appelant **se déclarer** quelqu'un (toute clé `slack*` dans le corps ⇒ 400). Mais il n'y a rien
à refuser quand l'appelant ne se déclare **personne** : le contexte est vide, `mayTouchRecord`
rend `true`, et `getEmployeeProfile`, `getNotificationHistory`, `generateDocument`,
`sendNotification`, `scheduleReminder`, `updateOnboardingStatus` s'exécutent **sans aucune
vérification**, sur l'identifiant de n'importe qui.

**Pourquoi ça compte.** Le dépôt a fermé, le 2026-08-14, exactement le défaut voisin, avec cette
formule : *« le jeton de service valait l'usurpation totale, ce qui n'est pas ce qu'un jeton de
service est censé valoir »*. Le correctif a fermé la **forge** et laissé ouverte la **vacance**,
qui est strictement plus puissante — se déclarer manager exige de connaître les clés ; ne rien
déclarer n'exige rien. Le fail-open est documenté et justifié (« playground, route HTTP, workflow,
test — c'est leur cas NORMAL, au tool de dégrader »), et cette justification tient pour le
*playground local*. Elle ne tient plus pour une route de production atteignable avec un bearer
unique, non scopé, non tournant, partagé entre tous les usages.

**Recommandation.** Séparer les deux mondes. Soit `createApiAuthConfig` pose lui-même un
`slackAccessLevel: 'readonly'` par défaut dans le `RequestContext` du service (ce qui referme le
fail-open sans toucher aux tools), soit `mayTouchRecord` distingue « hors Slack » de « sur
`/api` » via un marqueur posé par le garde. Et déclarer `server.rbac` ou des `rules` pour que le
jeton ne vaille pas *toutes* les routes. À défaut, restreindre les routes `/api/*` au strict
nécessaire (le dépôt n'a semble-t-il aucun consommateur légitime de `/api/tools/*/execute`).
`HYPOTHÈSE` : je n'ai pas pu émettre de requête pour confirmer qu'un `execute` aboutit
réellement en production — le raisonnement est établi sur le code du paquet installé.

---

### [MOYENNE] `channel_messages` et `knowledge_facts` : un droit à l'effacement implémenté, jamais appelé, et aucune purge

**Constat.** Les deux dépôts exposent `forgetUser(slackUserId)` et `prune(before)` :
`drizzle-message-archive.repository.ts:78,88` et `drizzle-knowledge-fact.repository.ts:98,108`,
déclarés dans les ports (`message-archive.repository.ts:13-14`,
`knowledge-fact.repository.ts:23-24`).

**Aucun appelant, nulle part** — vérifié sur `src/` et `scripts/` : le court-circuit d'effacement
(`slack-events.handler.ts:1188-1198`) n'appelle que `ConversationRepository.forget` et
`PinnedFactRepository.forget`. `prune` n'est invoqué que pour le limiteur de débit, la
déduplication Slack et les tours de conversation (`slack-events.handler.ts:948,958,2442`).

Depuis le 2026-08-21, **les DM sont archivés** dans `channel_messages`
(`slack-events.handler.ts:2498-2512`), et `authorizeOtherMemoryRead` permet au manager de les
relire. Il y a donc une archive intégrale et permanente des messages privés de chacun, sans
borne de rétention et sans geste d'effacement exécutable.

**Pourquoi ça compte.** Ce n'est pas un mensonge du produit : `ERASURE_SCOPE_NOTICE`
(`src/shared/forget.ts:99-104`) **nomme explicitement** ce qui n'est pas couvert, « les messages
que j'ai archivés dans les canaux », et renvoie vers `ESCALATION_CONTACT`. C'est la bonne
honnêteté et il faut le porter au crédit du dépôt. Mais la personne à qui l'on renvoie **n'a
aucun moyen d'exécuter la demande** : pas de script, pas de commande npm, pas de route. Elle
devrait écrire du SQL à la main sur la Turso de production. Une méthode implémentée, testée, et
sans appelant est de la même famille que `findPending()` avant le cron : *« correcte, et
n'ayant aucun site d'appel parce qu'il n'existait personne pour l'appeler »*.

**Recommandation.** Deux gestes, peu coûteux :
1. brancher `forgetUser` sur les deux dépôts dans le court-circuit d'effacement — la portée « mes
   propres messages » est exactement ce que `forgetUser(slackUserId)` implémente déjà, et la
   phrase de `ERASURE_SCOPE_NOTICE` rétrécirait d'autant ;
2. à défaut, exposer un script `npm run knowledge:forget -- --user <U…>` (dry-run par défaut,
   même forme que `role:set` et `probe-erasure`), pour que l'escalade ait une main.
Et poser une rétention : le cron quotidien existe désormais, `prune` a enfin quelqu'un pour
l'appeler.

---

### [MOYENNE] `findPersonByName` et `findEmployeeByEmail` : deux oracles d'annuaire sans aucune garde

**Constat.** Recensement exhaustif des 13 tools sous `src/features/*/application/tools/` :

| Tool | Garde | Écrit ? |
|---|---|---|
| `getEmployeeProfile` | `canReadPersonRecord`, **avant** toute lecture sur le chemin UUID (`:78`) ; après résolution sur le chemin email, avec l'id résolu **ou `null`** (`:55`) — anti-oracle correct | non |
| `getNotificationHistory` | idem (`:87`, `:111`) | non |
| `generateDocument` | `canReadPersonRecord` (`:315`) — **mais après** le cache d'idempotence, voir plus bas | oui |
| `sendNotification` | `canPerformSideEffects` (`:60`), avant toute lecture | oui |
| `scheduleReminder` | `canPerformSideEffects` (`:36`), avant toute lecture | oui |
| `updateOnboardingStatus` | `canPerformSideEffects` (`:27`), avant toute lecture | oui |
| `scheduleCandidateInterview` | `canPerformSideEffects` (`:81`) + quarantaine inverse au démarrage | oui |
| `getChannelHistory` | `authorizeChannelRead` (`:101`), appartenance vérifiée en direct | non |
| `getUserConversations` | `authorizeMemoryRead` / `authorizeOtherMemoryRead` (`:129-130`) | non |
| `searchKnowledge` | idem (`:259`, `:271`) | non |
| **`findPersonByName`** | **aucune** | non |
| **`findEmployeeByEmail`** | **aucune** (lit seulement l'`employeeId` du demandeur pour un `hint`, `:120`) | non |
| **`findExpertise`** | **aucune** | non |

`findPersonByName` (`find-person-by-name.ts:53-63, 83-94`) rend, pour n'importe quel nom :
l'**UUID interne** (`employee.id`), prénom, nom, **poste**, statut ; ou, depuis l'annuaire,
`slackUserId`, `title`, `employeeId`. `findEmployeeByEmail` (`:79-88`) rend le même UUID pour
n'importe quelle adresse.

**Pourquoi ça compte.** L'UUID ne donne pas la lecture du dossier : `getEmployeeProfile` refuserait
ensuite. La fuite est plus modeste — mais elle est réelle et de deux natures :
- **énumération** : `findEmployeeByEmail` répond `found: true/false` sur une adresse arbitraire.
  C'est précisément l'oracle que `getEmployeeProfile` a été retravaillé pour ne pas être (« sinon
  on énumère l'annuaire une adresse à la fois »). La même précaution n'a pas été portée ici ;
- **données personnelles** : poste et statut d'un tiers sont rendus sans regarder qui demande.

Ces trois tools sont exposés à `onboardingOrchestrator` et `notificationAgent` (et
`findExpertise` à trois agents), donc atteignables depuis n'importe quel message Slack, par
n'importe qui — invité mono-canal compris.

Il y a une contrepartie sérieuse, et elle est documentée : sans résolution de personne, « un agent
ne peut RIEN faire », et le câblage manquant a déjà produit une boucle sans sortie. `findExpertise`
ne rend d'ailleurs que des **noms**, jamais un identifiant ni une adresse — c'est explicitement
écrit dans sa `description` et respecté par le code. Le compromis est donc défendable pour
`findExpertise` ; il l'est moins pour les deux autres, qui rendent un identifiant.

**Recommandation.** Ne pas ajouter de garde bloquante (elle casserait le produit), mais réduire
la surface : ne rendre l'UUID que si le demandeur est le sujet **ou** de niveau `full` — dans les
autres cas rendre `found: true` avec le seul nom, ce qui suffit à l'agent pour poursuivre le
dialogue et retire la clé. Et faire passer `findEmployeeByEmail` par la même discipline
anti-oracle que `getEmployeeProfile` : verdict identique que l'adresse désigne quelqu'un ou
personne, pour un demandeur non autorisé.

---

### [MOYENNE] Le coffre-fort cryptographique de `llm-guardrail.ts` est un théâtre — mais il porte une pièce réelle qu'il ne faut pas jeter avec

**Constat.** ~400 lignes (`KeyManager`, `SystemPromptVault`, scrypt N=16384, HKDF, AES-256-GCM,
rotation de clés, HMAC à temps constant, cache LRU, métriques OpenTelemetry) servent à chiffrer
puis déchiffrer immédiatement **une constante littérale du même fichier** :

- `SYSTEM_PROMPT_TEMPLATE` est écrit en clair à `llm-guardrail.ts:944-966` et **exporté**
  sous le nom `SYSTEM_SECURITY_PROMPT` (`:1113`) ;
- `llm-guardrail.ts:1061-1063` : `new SystemPromptVault({ masterSecret:
  process.env.SYSTEM_PROMPT_VAULT_SECRET || randomBytes(32).toString('hex') })` puis
  `applicationVault.encrypt(SYSTEM_PROMPT_TEMPLATE)` ;
- `buildAgentInstructions` (`:1090`) déchiffre aussitôt.

Clair et chiffré coexistent dans le même processus, dérivés du même module. La clé, en l'absence
de `SYSTEM_PROMPT_VAULT_SECRET`, est aléatoire **par démarrage** : elle ne peut donc rien protéger
au repos, puisque rien n'est stocké entre deux démarrages. Contre qui ce chiffrement défend-il ?
Contre personne : un attaquant capable de lire la mémoire du processus lit le clair ; un
développeur a le source ; l'attaquant Slack, lui, ne touche jamais ce chemin. `assembleSecurePrompt`,
`SystemPromptVault`, `DelimiterGenerator` et `KeyManager` n'ont **aucun consommateur hors du
module** (vérifié sur tout `src/`).

Ce qui **protège réellement**, et qu'il faut nommer :
1. `assertSecurityHeaderIntact` (`:1069-1086`) — **fail-closed** : si les sentinelles manquent ou
   si un placeholder n'a pas été substitué, on **lève** `ServiceUnavailableError` plutôt que de
   construire un agent désarmé. C'est la vraie garantie, et elle ne doit rien à la crypto ;
2. `wrapUserInput` / `detectInjectionAttempts` / `validateDelimiterIntegrity` — le délimiteur par
   processus, aléatoire et non devinable, plus le rejet de toute seconde balise ouvrante ;
3. `sanitizeAgentOutput` + `containsInternalMarkers`, côté sortie.

Coût du théâtre : un `scryptSync(N=16384)` synchrone à l'import (quelques dizaines de ms sur
chaque démarrage à froid — sur un produit dont le cas nominal EST le démarrage à froid, et qui a
mesuré 5,2 s de latence d'ACK, ce n'est pas rien), plus ~400 lignes qu'il faut relire à chaque
audit. Coût aggravant : `SYSTEM_PROMPT_VAULT_SECRET` figure dans `.env.example:119`, ce qui invite
un opérateur à croire qu'y poser une valeur protège quelque chose.

**Pourquoi ça compte.** Pas parce que c'est dangereux — ça ne l'est pas — mais parce que ce dépôt
s'est donné pour règle de ne jamais affirmer une propriété qu'il ne peut pas constater. Un coffre
qui chiffre son propre contenu littéral **affirme une confidentialité qui n'existe pas**, et c'est
la seule pièce du fichier qui ne pourrait pas répondre à la question « qu'est-ce qui échoue si je
la retire ? ». C'est exactement le critère qui a fait supprimer `discoverSlackWorkspace` et la
feature `questionnaire`.

**Recommandation.** Remplacer les trois classes par un retour direct de la constante, en
**conservant intégralement** `assertSecurityHeaderIntact`, `injectSessionMarkers`,
`DelimiterGenerator.generate` et la substitution `{DELIMITER_PREFIX}` — ce sont eux qui font le
travail. Retirer `SYSTEM_PROMPT_VAULT_SECRET` de `.env.example` et de Vercel. Si le retrait paraît
risqué, la question à trancher est celle du dépôt : *écrire le test qui rougirait si le coffre
disparaissait*. S'il n'existe pas, il n'y a rien à casser.

---

### [MOYENNE] `logger` : la prose de l'utilisateur est masquée par `PII_KEYS`, sauf là où elle est le plus sensible

**Constat.** `maskPii` couvre bien les champs de prose ajoutés le 2026-08-14 — `text`, `content`,
`body`, `subject`, `fact`, `dailywork`, `workstyle` sont dans `PII_KEYS`
(`src/shared/logger.ts:157-166`). Mais le masquage est **par nom de clé** et deux sites d'appel
contournent la liste en nommant autrement :

- `src/shared/security/llm-guardrail.ts:828` :
  `inputPreview: input.substring(0, 200)` — **200 caractères du message brut de l'utilisateur**,
  journalisés en `error` à chaque détection d'injection. `inputPreview` n'est pas une clé PII.
  C'est le chemin sur lequel les messages les plus atypiques (donc les plus identifiants)
  atterrissent ;
- `src/features/document/application/tools/generate-document.ts:277` : `title` — prose écrite par
  le modèle à partir du texte de l'utilisateur, contenant très souvent le nom de la personne
  (« Guide d'accueil de … »).

Deux remarques secondaires, sans gravité :
- `PII_VALUE_PATTERNS` (`:169-178`) est **ancré** (`^…$`) : une adresse email *à l'intérieur*
  d'une chaîne plus longue n'est pas masquée. C'est cohérent avec un masquage par clé, mais cela
  signifie que le filet de valeur ne rattrape jamais le filet de clé ;
- `logger.ts:224-225` contient un `return masked;` dupliqué (mort) ; et l'entrée `'e-mail'` de
  `PII_KEYS` est inatteignable, `isPiiKey` retirant déjà `-` avant la comparaison (`:311`).

L'exclusion délibérée de `message` est documentée dans `CLAUDE.md` et le raisonnement est juste
(c'est le champ des erreurs partout dans le dépôt ; le masquer supprimerait le diagnostic).

**Pourquoi ça compte.** La politique de masquage existe précisément pour que les journaux Vercel —
lisibles par quiconque a accès au projet — ne contiennent pas ce que les gens écrivent au bot. Deux
clés mal nommées suffisent à la contourner, et le test `logger-pii-keys.test.ts` vérifie la liste,
pas les **sites d'appel**. C'est la même forme que les défauts que le dépôt appelle « invariant
énoncé que rien ne recalcule ».

**Recommandation.** Renommer `inputPreview` → `textPreview` (ou ajouter `preview`/`inputpreview`/
`title` à `PII_KEYS`) : la clé suffit, il n'y a pas de code à changer. Mieux : un test de qualité,
dans l'esprit de `claimed-invariants.test.ts`, qui scanne les littéraux d'objet passés à `logger.*`
dans `src/` et échoue sur un nom de clé qui ressemble à de la prose (`*preview*`, `*title*`,
`*snippet*`, `*excerpt*`) sans être dans `PII_KEYS`.

---

### [BASSE] `generateDocument` : le cache d'idempotence est consulté AVANT le refus d'autorisation

**Constat.** `src/features/document/application/tools/generate-document.ts:292-325` : le
`runGuard.get(dedupKey)` et le `return { ...previous.result }` (lignes 292-313) précèdent le
`canReadPersonRecord` (ligne 315).

La clé (`resolveDeliveryIntent`, `:445-452`) est `conversationKey ‖ employeeId ‖ type ‖ title ‖
format ‖ deliverTo`, où `conversationKey` vaut `channel` ou `channel:threadTs`. Deux personnes
d'un même fil de canal partagent donc la clé : après qu'un manager a produit un document sur X,
un non-autorisé du même fil qui formule exactement la même demande reçoit le verdict mis en
cache (dont `recipient`, le nom de la personne, et l'identifiant du document) au lieu du refus.

**Pourquoi ça compte.** L'exposition est étroite — le verdict, pas le contenu ; aucune re-livraison
n'a lieu, le `return` est anticipé — et exige un fil partagé plus une formulation identique. Mais
le dépôt tient par ailleurs une règle explicite : « le refus est rendu **avant toute lecture en
base**, et les tests le vérifient en assertant que le repository n'est jamais appelé ». Le cache
n'est pas la base, mais il est une lecture, et il précède la frontière. Les deux autres tools
gardés (`getEmployeeProfile`, `getNotificationHistory`) n'ont pas cette inversion.

**Recommandation.** Déplacer le bloc `canReadPersonRecord` **au-dessus** du `runGuard.get`. Aucun
comportement légitime ne change : un demandeur autorisé consulte le cache exactement comme avant.

---

### [BASSE] `authorizeCron` compare le secret par `!==` alors que le dépôt dispose d'une comparaison à temps constant

**Constat.** `src/api/reminders-dispatch.route.ts:48` :

```ts
if (header !== `Bearer ${secret}`) { ... }
```

Le dépôt possède `constantTimeEquals` (`src/shared/security/api-auth.ts:18-22`, sha256 puis
`timingSafeEqual`, correct y compris sur des longueurs différentes) et `safeEqual` dans le
portier (`scripts/slack-ack-function/index.mjs:58-63`). Les deux autres frontières
(signature Slack, jeton API) sont à temps constant ; celle-ci ne l'est pas.

**Pourquoi ça compte.** L'exploitation réelle est peu plausible : comparaison de chaînes V8 sur un
réseau public, bruit de latence de plusieurs ordres de grandeur au-dessus du signal, et le CDN
Vercel ajoute 0,3 à 2,3 s de variance (mesurée par le dépôt lui-même). Le vrai coût est la
**dissonance** : trois secrets, deux traitements. C'est le genre d'écart qui devient un défaut le
jour où quelqu'un recopie le mauvais des deux modèles.

Le reste de cette route est exemplaire : fail-closed en 503 sans `CRON_SECRET`, 401 sur mauvais
en-tête, refus journalisé en `error`, aucun appel de modèle, prise atomique via `rowsAffected`.

**Recommandation.** `constantTimeEquals(header ?? '', \`Bearer ${secret}\`)`. Une ligne.

---

### [BASSE] `createAgentApiGuard` : rédaction limitée à deux noms de champ et à six niveaux de profondeur

**Constat.** `src/shared/security/agent-api-guard.ts` :
- `PROMPT_FIELDS = new Set(['instructions'])` (`:10`) et `AGENT_TEXT_FIELDS = new Set(['text'])`
  (`:12`) — un champ nommé `systemPrompt`, `system`, `prompt` ou `defaultInstructions` ne serait
  pas rédigé ;
- `MAX_DEPTH = 6` (`:14`) : au-delà, `redactValue` rend la valeur telle quelle (`:110`) ;
- la rédaction ne s'applique qu'aux réponses `application/json` (`:92`) — les réponses `/stream`
  ne peuvent pas l'être, ce qui est **documenté** et compensé par le refus **à l'entrée**.

**Pourquoi ça compte.** La liste des champs est **écrite à la main** contre une forme de réponse
qui appartient à `@mastra/server` et qui bougera à la prochaine montée de version. C'est
exactement le motif que le dépôt combat ailleurs en dérivant ses listes
(`agentToolBoundary` dérivé de `Object.keys(tools)`, `TOPIC_BANDS` dérivé de `AGENT_TOOLS`). Le
risque immédiat est faible : `/api/*` est de toute façon derrière `MASTRA_API_TOKEN`, fail-closed,
et ce garde est une défense en profondeur. Mais rien ne signalera sa péremption.

**Recommandation.** Inverser le critère : au lieu d'une liste de clés, rédiger **toute chaîne**
d'une réponse `/api/agents*` qui contient une sentinelle du prompt système
(`'---BEGIN IMMUTABLE DIRECTIVES---'`, `'DIRECTIVE '`), c'est-à-dire dériver la détection du
prompt lui-même — qui, lui, est une constante du dépôt. Porter `MAX_DEPTH` à ~12 ou le supprimer
(la profondeur est déjà bornée par la taille de la réponse). Ajouter un test qui échoue si
`GET /api/agents` rend une chaîne contenant une sentinelle.

---

### [BASSE] `createRequestContextGuard` ne lit que les corps JSON, et jamais les `GET`

**Constat.** `src/shared/security/request-context-guard.ts:33` : `if (!raw || raw.method === 'GET'
|| raw.method === 'HEAD') return [];` — et `:36-40` : tout corps que `raw.clone().json()` ne sait
pas parser (form-encoded, multipart) est traité comme sans clés forgées.

**Pourquoi ça compte.** C'est correct **aujourd'hui** : les schémas Mastra déclarent
`requestContext` comme un champ du corps JSON (`agents-DD4PJgsF.js:243, 312-313, 321, 328, 408,
505`), et j'ai vérifié qu'aucun en-tête ni paramètre de requête n'alimente le `RequestContext`
dans le paquet installé. La remarque est de robustesse : le garde surveille bien un **préfixe** et
non une liste de clés (excellent choix, il couvre les clés pas encore écrites), mais il ne couvre
qu'un seul **transport**.

**Recommandation.** Aucun changement urgent. Si un jour Mastra accepte `requestContext` par
en-tête ou par `?requestContext=`, ce garde ne le verra pas — le noter dans son en-tête, qui
documente déjà finement le `clone()`.

---

### [BASSE] `/slack/interactions` ne vérifie pas `SLACK_TEAM_ID`, contrairement à `/slack/events`

**Constat.** `SlackEventsHandler.checkTeamId` (`slack-events.handler.ts:854-875`) rejette un
événement dont `team_id` ne correspond pas — fail-open documenté quand la variable est absente.
`handleSlackInteractionRequest` (`src/api/slack-interactions.route.ts:377-425`) n'a **aucun
équivalent**, alors que le payload porte `payload.team?.id` (le champ est même déclaré dans
l'interface, `:47`, et jamais lu).

**Pourquoi ça compte.** La signature HMAC prouve que Slack a émis la requête, pas depuis quel
workspace — c'est le raisonnement même de l'en-tête de `SLACK_TEAM_ID` dans `.env.example:72-76`.
La défense en profondeur existe d'un côté et manque de l'autre. Portée réelle très limitée
(l'app n'est installée que sur un workspace) et la variable est de toute façon fail-open.

À signaler dans la même zone : `answerProfileDone` (`slack-interactions.route.ts:312-323`) lit
l'email dans le `value` du bouton et rend le verdict de complétude du dossier correspondant. C'est
une branche **héritée** que plus aucun code n'émet, et le risque « un témoin clique en canal » est
précisément ce qui a fait rendre `profile-request.ts` DM-only — c'est donc connu et assumé.

**Recommandation.** Ajouter le même `checkTeamId` sur les interactions, en partageant la fonction
plutôt qu'en la réécrivant — « deux machines à états qui suivent la même règle sans la partager
finissent par diverger », le dépôt l'a payé le 2026-08-21.

---

### [BASSE] Le portier d'ACK construit son URL de réexpédition depuis un en-tête de la requête

**Constat.** `scripts/slack-ack-function/index.mjs:150-151` :

```js
const host = req.headers['x-forwarded-host'] ?? req.headers.host;
const url = `https://${host}${target}`;
```

**Pourquoi ça compte.** Le choix est **documenté et bon** : une URL fixée en variable ferait
traiter un événement de prévisualisation par le code de production, « et le symptôme serait
"ça marche" ». Et le `fetch` n'a lieu qu'**après** la vérification HMAC, donc seul un porteur du
secret de signature peut l'atteindre — ce qui rend le SSRF théorique. Sur Vercel,
`x-forwarded-host` est posé par la plateforme. Je le signale uniquement parce que la sûreté repose
entièrement sur une garantie de plateforme non exprimée dans le code.

**Recommandation.** Une assertion bon marché : refuser un `host` qui ne se termine pas par
`.vercel.app` ni par le domaine de production. Le comportement de prévisualisation est préservé,
la garantie devient locale.

---

### [BASSE] Dépendances : 6 vulnérabilités, toutes hors chemin de production ; et Node tourne deux majeures en dessous de `engines`

**Constat.** `npm audit` : **2 faibles, 4 modérées**, aucune haute ni critique.

| Paquet | Sévérité | Chemin | Correctif |
|---|---|---|---|
| `@ai-sdk/provider-utils` ≤3.0.97 (via `@mastra/core`) | faible | **production** | `npm audit fix` (non cassant) |
| `esbuild` ≤0.24.2 → `@esbuild-kit/*` → `drizzle-kit` | modérée | **devDependency** | seulement via `drizzle-kit@0.18.1`, majeure régressive |

L'avis `esbuild` (GHSA-67mh-4wv8-2f99) ne porte que sur le **serveur de développement** d'esbuild ;
`drizzle-kit` est en `devDependencies` et n'est jamais exécuté par la fonction déployée.
Rétrograder de `0.31.10` à `0.18.1` pour cela serait disproportionné — et `db:push` est déjà
inutilisable contre une base `libsql://` distante.

L'avis `@ai-sdk/provider-utils` (GHSA-866g-f22w-33x8, consommation de ressources non contrôlée,
CVSS 4.3) est le seul qui touche du code de production, et il est corrigeable sans casse.

Par ailleurs :
- **`node --version` = v20.19.4**, alors que `package.json` exige `>=22.13.0` et que
  `fix-vercel-output.js` force `nodejs22.x` en production. `.npmrc` ne pose pas
  `engine-strict=true` : rien n'échoue, on développe et on teste simplement sur un runtime que la
  production n'exécute pas. La CI, elle, est bien en `22.x` (`.github/workflows/ci.yml`) — c'est
  le poste local qui diverge ;
- `zod` est **épinglé à `3.25.76`**, exactement comme documenté, pour une raison précise (le
  parseur de schémas du Vercel AI SDK). C'est un choix, pas une dette ;
- aucun paquet abandonné parmi les dépendances directes ; `sanitize-html` 2.17.5, `nodemailer` 9,
  `@slack/web-api` 8 sont à jour.

**Recommandation.** Passer `npm audit fix` (le seul avis de production est non cassant).
Laisser `drizzle-kit` en l'état et le noter comme accepté. Aligner le Node local en 22.13+, ou
poser `engine-strict=true` dans `.npmrc` pour que l'écart cesse d'être silencieux.

---

### [BASSE] `EMERGENCY_COUNTRY` est lue par le code mais absente de `.env.example` — le test de complétude ne peut pas la voir

**Constat.** `src/shared/emergency-lines.ts:116-117` lit `env.EMERGENCY_COUNTRY`. Le fichier
`.env.example` ne la mentionne pas (0 occurrence). Le garde-fou
`tests/unit/quality/env-example-completeness.test.ts` confronte `.env.example` aux
`process.env.X` **littéraux** de `src/` : ici la lecture passe par un paramètre
(`env: NodeJS.ProcessEnv = process.env`), donc elle échappe au scan.

**Pourquoi ça compte.** La variable gouverne **quel numéro d'urgence est donné à une personne en
détresse**. Ce n'est pas une option de confort : le dépôt a écarté trois numéros faux à la
vérification précisément parce qu'un mauvais numéro « consomme le seul geste que la personne aura
peut-être la force de faire ». Un opérateur qui déploie au Nigeria ne trouvera pas comment le dire.
C'est aussi un trou dans un garde-fou que le dépôt croit exhaustif — la famille de défaut qu'il
traque (« l'invariant énoncé que rien ne recalcule »).

**Recommandation.** Ajouter `EMERGENCY_COUNTRY=` à `.env.example` avec les valeurs acceptées et la
raison du défaut `BJ`. Et étendre le scan du test aux lectures indirectes : `env.X` sur un
paramètre typé `NodeJS.ProcessEnv` est un motif reconnaissable et déjà employé par
`api-auth.ts`, `access-guard.ts` et `startup-env-check.ts`.

---

### [BASSE] En-têtes HTTP : ni HSTS ni CSP

**Constat.** `src/shared/security/http-headers.ts:5-9` pose `x-content-type-options: nosniff`,
`x-frame-options: DENY`, `referrer-policy: no-referrer`, sur `path: '*'`. Absents :
`strict-transport-security` et `content-security-policy`.

**Pourquoi ça compte.** Faible : les surfaces servies sont du JSON et Vercel impose HTTPS avec son
propre HSTS sur les domaines `*.vercel.app`. Le seul cas où une CSP compterait est le playground
Mastra, qui n'est servi qu'en développement.

**Recommandation.** Ajouter `strict-transport-security: max-age=63072000; includeSubDomains` —
gratuit, et cela cesse de dépendre d'une garantie de plateforme. La CSP n'a pas d'objet ici.

---

## Points forts

Ce dépôt porte un travail de sécurité sérieux, et plusieurs pièces sont meilleures que la moyenne
de ce que je vois.

- **La signature Slack est correcte de bout en bout.** HMAC-SHA256 sur `v0:timestamp:body`,
  fenêtre de 5 min, comparaison `timingSafeEqual` avec égalisation de longueur **avant** l'appel
  (`slack-signature.ts:64-73`) — le piège classique (`timingSafeEqual` lève sur des longueurs
  différentes, et comparer les longueurs d'abord réintroduit la fuite) est explicitement traité, y
  compris dans le portier (`index.mjs:53-63`). Le portier **re-vérifie**, et la route interne
  re-vérifie encore : la frontière tiendrait si le portier disparaissait, et c'est écrit noir sur
  blanc dans son en-tête.
- **Aucun secret dans le dépôt.** `git ls-files` ne trace aucun `.env` ; aucun `.env` n'a jamais
  été commité (`git log --all -- .env` est vide) ; le balayage de tous les blobs suivis pour
  `xox*`, `sk-*`, `gsk_*`, `AIza*`, `eyJ*.`, clés privées PEM et `AKIA*` ne rend **rien**. Les
  seules occurrences sont des `'xoxb-test-token'` de test et un `xoxb-votre-bot-token` de
  documentation. Le `.gitignore` est réfléchi (`.env*` avec exception explicite et commentée pour
  `.env.example`, qui ne porte aucune valeur).
- **`/api/*` est fail-closed.** `createApiAuthConfig` refuse tout tant que `MASTRA_API_TOKEN` fait
  moins de 32 caractères, le journalise une fois en `error`, et `reportMissingCriticalEnv` le
  signale au démarrage avec sa **conséquence** écrite en toutes lettres. La comparaison passe par
  sha256 + `timingSafeEqual`, donc à temps constant même sur des longueurs différentes.
  `cors: { origin: [], credentials: false }` complète.
- **La route cron est le bon fail-closed.** 503 sans `CRON_SECRET`, 401 sur mauvais en-tête, refus
  journalisé en `error`, aucun appel de modèle sur le chemin, prise atomique par `rowsAffected`
  avec grâce d'abandon (`STRANDED_CLAIM_MS`) — et le raisonnement inverse (« pourquoi ce fail-closed
  alors que tout le reste est fail-open ») est écrit au-dessus.
- **Zéro injection SQL.** Toutes les requêtes passent par Drizzle ou par le template `sql` (donc
  paramétrées) ; j'ai lu les quatre requêtes FTS brutes et les valeurs y sont bien liées. Et
  `toMatchQuery` (`fts-query.ts`) neutralise la **syntaxe FTS5** — la classe de bug que presque
  tout le monde manque : les termes sont extraits par `[\p{L}\p{N}]`, guillemetés, les `"` doublés,
  et le nombre de termes borné à 8. Ni `*`, ni `NEAR`, ni filtre de colonne ne peuvent passer.
- **`buildDocumentFilename` est une liste blanche, pas une liste noire** (`[a-z0-9]` après
  décomposition NFD) : la traversée de chemin est structurellement impossible, pas filtrée. Le
  raisonnement — « le titre est rédigé par un LLM et sort du processus » — est le bon.
- **Le HTML des emails est échappé** (`email-body.ts:6-13`) avant d'accueillir la prose du modèle.
- **La frontière d'autorisation est écrite une seule fois.** `mayTouchRecord` est le point unique
  dont `canReadPersonRecord` et `canPerformSideEffects` dérivent ; `resolveAccess` est importée
  par `probe:authz` plutôt que recopiée, avec la bonne justification (« une seconde copie de la
  règle dirait un jour autre chose que la première »). Le refus tombe **avant toute lecture** dans
  10 des 11 tools gardés, et le chemin email de `getEmployeeProfile` passe l'identifiant résolu
  **ou `null`**, ce qui rend le verdict identique que l'adresse désigne quelqu'un ou personne —
  l'anti-oracle est fait correctement, ce qui est rare.
- **Le garde refuse d'appliquer tant qu'aucun manager n'est désigné**, avec re-contrôle toutes les
  60 s. C'est la bonne façon de rendre un interrupteur d'autorisation sûr à activer.
- **`assertNoOutboundTools`** lève **au démarrage** si un outil de sortie est câblé sur un agent
  de lecture agrégée : une règle d'architecture rendue mécanique plutôt que documentaire.
- **`assertSecurityHeaderIntact`** est un fail-closed franc : plutôt qu'un agent désarmé, une
  `ServiceUnavailableError`.
- La règle **« une consigne est PROBABLE, le code est GARANTI »**, appliquée cinq fois après cinq
  mesures d'échec en production, est la meilleure décision d'ingénierie du dépôt et elle a des
  conséquences directes en sécurité (le `recipient` nommé par le code, le refus expliqué par le
  `RequestContext`, l'heure de rappel retirée de la fenêtre du modèle).
- `typecheck` et `lint` sont verts, `|| true` a été retiré de `lint`, et la CI tourne enfin sur la
  branche où le code vit — trois choses qui donnent du poids à tout le reste.

---

## Ce que je n'ai pas pu vérifier

1. **La production.** Aucune commande réseau, base ou déploiement n'a été exécutée. Je n'ai pas
   pu confirmer que `AUTHZ_ENFORCE=true`, `CRON_SECRET`, `MASTRA_API_TOKEN` et `SLACK_TEAM_ID`
   sont réellement posés sur Vercel, ni qu'un manager est désigné dans `slack_directory.role`.
   **Sans manager désigné, ou sans `AUTHZ_ENFORCE`, toutes les gardes recensées plus haut rendent
   `full` à tout le monde et ne refusent rien** — le code est correct, l'effet dépend entièrement
   de la configuration. `npm run probe:authz` (lecture seule) est le geste qui trancherait.
2. **`POST /api/tools/:toolId/execute` avec un jeton valide** (constat HAUTE n°3) : le
   raisonnement s'appuie sur le code de `@mastra/server` installé et sur sa documentation de
   routes, pas sur une requête émise. Le chaînage — jeton valide → pas de règle RBAC → contexte
   Slack vide → `mayTouchRecord` rend `true` — est solide mais mérite une confirmation empirique
   sur un déploiement de prévisualisation.
3. **La suite de tests n'a pas été exécutée.** `npm run test:unit` n'est pas dans les commandes
   autorisées ; je n'ai donc pas pu vérifier que les 1 801 tests annoncés passent, ni observer les
   comportements que seuls les tests exercent.
4. **La configuration de l'app Slack** (abonnements, scopes, Socket Mode,
   `messages_tab_enabled`) : non observable depuis le dépôt. `CLAUDE.md` est la seule source, et
   il documente lui-même que deux affirmations de cette section ont été fausses par le passé.
5. **Le contenu réel des tables de production** — volume de `channel_messages`, ancienneté des
   lignes, nombre de personnes concernées par l'absence de purge (constat MOYENNE n°1). L'impact
   RGPD dépend de ces chiffres, que je n'ai pas.
6. **Le comportement de `x-forwarded-host` sur Vercel** : je n'ai pas de preuve documentaire que
   la plateforme écrase toujours cet en-tête entrant. Le constat est marqué `HYPOTHÈSE` en
   conséquence.
7. **Analyse dynamique** : aucun fuzzing des motifs de `llm-guardrail.ts` (le dépôt a son propre
   banc, `llm-guardrail-redos.test.ts`, sur 89 charges adverses — je n'ai pas pu le lancer), et
   aucune évaluation de la **couverture réelle** de `detectInjectionAttempts` face à des
   formulations d'extraction en français hors des 26 motifs déclarés. Une revue de motifs par
   lecture, sans exercice sur des phrases que des gens diraient vraiment, est précisément ce que
   le dépôt a appris à ne pas croire.
