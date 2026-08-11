# CLAUDE.md — Kisso Onboarding

> ⚠️ **CE FICHIER DÉCRIT LE DÉPÔT, PAS LA PRODUCTION.** Les deux divergent régulièrement, et
> confondre les deux a déjà coûté des heures de diagnostic. Avant toute conclusion sur un
> comportement observé dans Slack, vérifier ce qui tourne réellement :
> `npx vercel ls` (le déploiement `Production` le plus récent) puis `git log --oneline -1`.
> La branche de travail est `refactor/cleanup-20260810` — **`main` ne contient ni
> `server.apiRoutes` ni `slackEventsRoute`**, la production n'en vient donc pas.
>
> **État au 2026-08-11 :** mémoire conversationnelle, routage collant, marqueur de progression,
> garde-fous anti-URL, **livraison réelle de documents** (rendu PDF/DOCX, upload Slack, pièce
> jointe email, contexte Slack jusqu'aux tools), **verdict d'onboarding dégradé** et
> **déduplication Slack partagée** sont **dans le dépôt, pas encore en production** — aucun
> déploiement n'a suivi ce chantier. Deux DDL restent à appliquer à la main sur la Turso de
> production (`documents.content`, `slack_event_dedup`) et le scope Slack `files:write` n'est
> toujours pas accordé : voir `TODO.md`, section « Actions humaines ».

Plateforme d'onboarding intelligent (Kisso Industries) : agents Mastra orchestrant
l'intégration des nouveaux employés (guidelines, canaux Slack, provisioning comptes).

Documentation en français, **code et identifiants en anglais**.

## Stack technique

| Élément     | Valeur                                                      |
| ----------- | ----------------------------------------------------------- |
| Runtime     | Node.js `>=22.13.0`, ESM (`"type": "module"`)                |
| Langage     | TypeScript `6.0.3`, mode strict                              |
| Framework   | Mastra `@mastra/core` `1.57.x` (Agents / Tools / Workflows)  |
| LLM         | Groq `llama-3.3-70b-versatile` → fallback Mistral `mistral-large-latest` |
| DB          | Turso / LibSQL (`@libsql/client`) + Drizzle ORM `0.45.x`     |
| Validation  | Zod `3.25.76` (version **épinglée**, voir Pièges)            |
| Tests       | Vitest `4.1.10`                                              |
| Chat / Notif| `@slack/web-api` `8.x` ; email : SMTP via `nodemailer` (primaire), Brevo (`@getbrevo/brevo`) en repli |
| Documents   | `pdfmake` `0.3` (PDF) et `docx` `9.7.1` (DOCX) — deux renderers d'un même modèle logique |
| Déploiement | Vercel via `@mastra/deployer-vercel`                         |

## Commandes

```bash
npm run dev              # mastra dev — serveur local + playground
npm run build            # mastra build + scripts/fix-vercel-output.js
npm run build:prod       # typecheck + build (utilisé par vercel.json)
npm start                # tsx ./src/mastra/index.ts
npm run start:prod       # node .mastra/index.mjs

npm run typecheck        # tsc --noEmit
npm run lint             # eslint src (suffixé `|| true` — ne casse jamais le build)
npm run format           # prettier --write .

npm run test:unit        # vitest run          (vitest.config.ts)
npm run test:integration # vitest run --config vitest.config.integration.ts
npm run test:all         # unit puis integration
npm run smoke:slack      # node --env-file=.env scripts/smoke-slack.mjs
npm run smoke:email      # ⚠️ ENVOIE un vrai email — pas un dry-run
npm run test:scenarios   # node --env-file=.env scripts/production-scenarios.mjs

npm run verify:bundle    # audit du bundle Vercel (inclus dans `build`)
npm run db:generate      # drizzle-kit generate
npm run db:push          # drizzle-kit push (⚠️ se bloque sur libsql:// distant, voir Pièges)
npm run db:init          # DDL exporté depuis schema.ts → sqlite3 data/kisso.db
```

Après **chaque** modification de code : `npm run typecheck && npm run test:unit`.

## Architecture — Screaming Architecture par feature

Chaque bounded context vit sous `src/features/<feature>/` et suit les mêmes 3 couches :

```
src/features/<feature>/
├── domain/            # entités, value-objects, ports — TypeScript pur, ZÉRO import framework
│   ├── entities/
│   ├── value-objects/
│   └── ports/         # interfaces des repositories & services
├── application/       # ce que Mastra consomme
│   ├── agents/        # makeXxx(tools) => new Agent({...})
│   ├── tools/         # makeXxx(deps)  => createTool({...})
│   ├── workflows/     # createXxxWorkflow(deps)
│   ├── dtos/
│   └── mappers/
└── infrastructure/    # implémentations des ports
    ├── repositories/  # drizzle-*.repository.ts + in-memory-*.repository.ts (tests)
    ├── providers/     # adaptateurs externes (slack.adapter.ts, smtp.adapter.ts, brevo.adapter.ts)
    ├── services/
    └── handlers/      # entrées événementielles (Slack Events)
```

Features : `employee`, `onboarding`, `questionnaire`, `document`, `notification`, `conversation`.

**`conversation` (ajoutée le 2026-08-11) porte la mémoire conversationnelle.** Elle n'utilise
**pas** `@mastra/memory` : ce paquet dépend de `zod ^4` alors que le projet épingle `3.25.76`
(voir Pièges), et il ne sait plafonner qu'en **nombre de messages** — inadapté, un seul
tool-result pesait 2 506 tokens. Trois pièces :
- `domain/value-objects/conversation-id.ts` — clé du fil :
  `threadTs ? \`${channel}:${threadTs}\` : channel`. En DM `threadTs` est `undefined` par
  conception, donc le canal `D…` EST la conversation ; en canal, un thread est une conversation.
- `domain/services/token-window.ts` — fenêtrage **en tokens** (`CONVERSATION_TOKEN_BUDGET`
  = 1600, ratio 3,5 car./token). Ne coupe jamais une salve `user`+`assistant` : un tour
  `assistant` orphelin répondrait à une question invisible pour le modèle, ce qui est pire que
  pas de mémoire. Un tour dépassant 40 % du budget est tronqué, pas exclu.
- `domain/ports/conversation.repository.ts` — `CONVERSATION_TTL_MS` = 60 min, **TTL unique**
  gouvernant à la fois la mémoire et le routage collant.

**On ne stocke que du texte** — jamais de tool-call ni de tool-result. Le tour `user` est écrit
**après** `wrapAgentInput` et sous sa forme ASSAINIE (le texte brut ferait persister un faux
délimiteur, rejoué non encadré à chaque tour suivant) ; le tour `assistant` **après**
`sanitizeAgentOutput`, sinon l'unique filet anti-marqueurs serait contourné.

⚠️ L'historique est transmis en **messages structurés non encadrés**, et un SEUL bloc
`<kisso_XXXX_user_input>` existe par appel — celui du message courant.
`validateDelimiterIntegrity` rejette toute seconde balise ouvrante, donc
`history.map(wrapAgentInput).join()` lèverait `SecurityBlockError` sur chaque message.

La table `conversation_turns` a été **appliquée sur la Turso de production le 2026-08-11**
(`scripts/ddl-conversation-turns.sql`, table + 2 index vérifiés). La mémoire dégrade en
silence si elle est indisponible : le bot redevient amnésique mais répond toujours.

**`document` rend et livre réellement un fichier depuis le 2026-08-11.** Trois pièces, dans cet
ordre de dépendance :
- `domain/services/document-template.ts` — modèle logique **format-agnostique**
  (`buildDocumentOutline`) : blocs `heading | paragraph | bullets | fields`, dénominateur commun
  que PDF et DOCX savent tous deux rendre. Quatre gabarits dédiés (`contract`, `welcome_letter`,
  `certificate`, `guide`) plus un **générique** couvrant les 5 autres valeurs de `DocumentType`.
  Les templates vivaient auparavant en `TDocumentDefinitions` pdfmake : les dupliquer pour DOCX
  aurait garanti que deux rendus du même type finissent par ne plus dire la même chose.
- `domain/services/document-file.ts` — nom de fichier dérivé du titre par **liste blanche**
  (`[a-z0-9]` après décomposition NFD), jamais par liste noire : le titre est rédigé par un LLM à
  partir d'un texte utilisateur et sort du processus vers Slack et vers une pièce jointe.
  `../../etc/passwd` → `etc-passwd.docx`.
- `domain/ports/document-renderer.ts` — `render()` → `{ bytes: Uint8Array, filename, mimeType }`.
  `Uint8Array` et non `Buffer` : `domain` reste du TypeScript pur (garde-fou d'architecture), et
  un `Buffer` **est** un `Uint8Array`, la contrainte ne coûte rien au runtime.
  `PdfmakeService implements PdfService, DocumentRenderer` — l'ancienne méthode `generate()`
  écrivant sur disque est **conservée** pour `documentGenerationWorkflow`, seul appelant restant.
  `DocxService` est nouveau.

**Le contexte Slack descend jusqu'aux tools par `src/shared/slack-request-context.ts`.**
C'était le point bloquant recensé : un tool reçoit son `inputData` du modèle, et le modèle ne
connaît pas — et ne doit pas connaître — l'identifiant d'un canal. Le handler construit un
`RequestContext` (`buildSlackRequestContext`) passé à
`agent.generate(messages, { requestContext })` — ⚠️ en Mastra 1.57 c'est bien `requestContext`,
**plus `runtimeContext`** ; les tools le relisent par `readSlackContext(ctx.requestContext)`.
- **Coût en tokens : ZÉRO.** Le `RequestContext` est un canal d'injection de dépendances côté
  serveur ; il ne traverse ni le prompt, ni les schémas de tools, ni le tool-result.
- Le module est dans `src/shared/` parce que le producteur vit dans `notification/infrastructure`
  et les consommateurs dans les `application/tools` d'**autres** features : aucun des deux ne peut
  importer l'autre sans violer la règle de dépendance. Les trois clés sont le contrat entre les
  deux bords — les dupliquer en littéraux ferait qu'un renommage d'un seul côté couperait la
  livraison sans qu'aucun type ne bouge ni aucun test ne rougisse.
- **En DM, `threadTs` reste délibérément absent** : threader un DM enfouit le message hors de la
  conversation principale (le bot a paru muet des heures en production pour cette raison). Un
  fichier uploadé avec un `thread_ts` en DM serait pire — la personne verrait « voici ton
  document » sans jamais voir le document.
- `readSlackContext` ne lève **jamais** et rend `undefined` hors Slack (playground, route HTTP,
  workflow, test) : c'est le cas NORMAL de ces chemins, au tool de dégrader.

Transverse : `src/shared/` (logger, errors, retry, security, `slack-request-context`),
`src/infrastructure/database/`, `src/config/`, `src/api/`, `src/mastra/index.ts`.

**Règle de dépendance** : `domain` ne dépend de rien ; `application` dépend de `domain` ;
`infrastructure` implémente les ports du `domain`. Jamais l'inverse. Deux tests garde-fou
verrouillent cette règle : `tests/unit/quality/architecture.test.ts` et `code-architecture.test.ts`.

## Conventions de nommage

- **Fichiers** : `kebab-case.ts`, suffixé par le rôle — `*.repository.ts`, `*.adapter.ts`,
  `*.service.ts`, `*.handler.ts`, `*.dto.ts`, `*.mapper.ts`.
- **Factories** : tout composant Mastra est produit par une factory qui reçoit ses dépendances
  par injection — `makeCreateEmployee(repo)`, `makeOnboardingOrchestrator(tools)`,
  `createEmployeeOnboardingWorkflow(deps)`. **Jamais** d'instanciation au niveau module dans
  `features/` : le câblage se fait exclusivement dans `src/mastra/index.ts`.
- **Identifiants Mastra** : `camelCase`, et la clé du registre `agents: {}` doit être
  **identique** à l'`id` de l'agent — c'est ce que `mastra.getAgent(id)` résout.
  - Agents : `onboardingOrchestrator`, `questionnaireEngine`, `notificationAgent`
  - Workflows : `employeeOnboardingWorkflow`, `questionnaireCycleWorkflow`,
    `notificationCycleWorkflow`, `documentGenerationWorkflow`
- **Agents** : chaque `instructions` commence par `SYSTEM_SECURITY_PROMPT`
  (`src/shared/security/llm-guardrail.ts`) — garde-fou anti prompt-injection, non négociable.
- **Tests** : miroir de `src/` sous `tests/unit/` ; les repositories `in-memory-*` servent de
  doublure — ne pas mocker Drizzle à la main.

## Intégration Slack

- Workspace : **Kisso Ind.** (`TMLKC4EPP`, `kissohq.slack.com`)
- Bot : `@mastra` — `bot_user_id` `U0BMBEJTBMJ`, `bot_id` `B0BM9MK4G65`
- Endpoint Events API : `POST /slack/events` — **pas** `/api/slack-events`, voir ci-dessous
- Le routage message → agent vit dans
  `src/features/notification/infrastructure/handlers/slack-events.handler.ts`.
  **Quatre paliers, dans cet ordre :**
  1. **Intentions de l'orchestrateur** (prioritaire) —
     `crée|créer|création|cree|creer|ajoute|enregistre|retrouve|recherche|identifiant|document|tâche|tache|onboarding|pdf|guide|guideline|docx`
     → `onboardingOrchestrator`
  2. **Agent collant** — l'agent du dernier tour de la conversation, si celle-ci a moins de
     60 min (`CONVERSATION_TTL_MS`). Ajouté le 2026-08-11, voir ci-dessous.
  3. `questionnaire|évaluation|quiz|test` → `questionnaireEngine`
  4. `notification|rappel|email|message` → `notificationAgent`
  5. défaut → `onboardingOrchestrator`

  **Le palier 2 corrige le défaut central mesuré le 2026-08-11.** Le routage était recalculé
  sur le texte de CHAQUE message, isolément. Rejeu du fil réel : « Email: … » →
  `notificationAgent`, « As-tu envoyé le rapport ? » → orchestrateur, « Par email » →
  `notificationAgent`, « Donne le PDF alors » → orchestrateur. Le fil alternait
  **A → B → A → B → A** entre deux agents amnésiques. « Par email » répondait à une question
  posée par l'orchestrateur et arrivait chez un agent qui ne l'avait jamais posée — d'où le
  « Quel est l'objet de cette notification ? », qui est littéralement le schéma d'entrée de
  `sendNotification` redemandé à zéro.

  Le palier collant est placé **après** les intentions de l'orchestrateur (une demande
  explicite doit pouvoir sortir d'un fil, sinon une conversation collée sur le mauvais agent
  serait un piège sans issue) et **avant** les paliers thématiques (ce sont eux qui
  détournaient les réponses de suivi). Un identifiant d'agent inconnu du registre est ignoré :
  le suivre aveuglément ferait lever `getAgent` à chaque message et condamnerait le fil.

  `pdf`, `guide` et `guideline` ont été ajoutés au palier 1 : seul l'orchestrateur porte
  `generateDocument`, ils sont donc sans ambiguïté. `guideline` est listé séparément — le bord
  droit du motif (`(?![\p{L}])`) empêche `guide` de matcher dans « guideline ». « génère »
  reste volontairement exclu : il sert aussi `generateQuestionnaire`.

  **`docx` a rejoint la liste** quand `generateDocument` a su rendre ce format : une extension
  de fichier, servie par le seul orchestrateur, sans autre sens en français comme en anglais.
  **« word » a été examiné et volontairement ÉCARTÉ** — le critère de ce palier n'est pas
  « désigne un document » mais « sans ambiguïté », et `word` est un mot anglais courant. Le
  faux positif n'y est pas inoffensif : ce palier PRIME sur le palier collant, donc il
  **arrache** le message au fil en cours. Or « envoie-le en Word » n'a pas besoin de ce
  palier — c'est une réponse de suivi, exactement ce que le palier collant sait router.

  Le palier 1 a été ajouté le 2026-08-10 après une campagne en production : le mot **« email »**
  aiguillait vers `notificationAgent`, qui ne possède ni `createEmployee` ni `findEmployeeByEmail`.
  Or une demande de recherche par email contient nécessairement ce mot — **la fonctionnalité était
  structurellement inatteignable**, et les créations ne réussissaient que si la formulation évitait
  le mot. N'y ajouter que des termes sans ambiguïté : « profil », « statut » et « intégration » en
  sont **volontairement exclus** (ils captureraient « planifie un rappel : compléter son profil » ou
  « génère un questionnaire d'intégration »), et le repli par défaut étant déjà l'orchestrateur,
  les y mettre n'apporterait rien.

  La correspondance exige un **bord de mot des deux côtés**, avec pluriel toléré (`s?`). La garde
  ne portait que sur le bord gauche : `rappelle`, `messagerie`, `testez` déclenchaient tous un
  détournement, tandis que `emails` et `questionnaires` étaient ignorés.
- Setup complet : `docs/SLACK_BOT_SETUP.md`.

**Une route HTTP n'existe que si elle est déclarée dans `server.apiRoutes` de
`src/mastra/index.ts`** via `registerApiRoute()` (`@mastra/core/server`). Un fichier posé dans
`src/api/` n'est **jamais** monté automatiquement : sans déclaration, c'est du code mort.
C'était exactement la cause du bot silencieux — `index.ts` n'avait aucun bloc `server`, donc
`POST /api/slack-events` répondait 404. La route est aujourd'hui déclarée
(`apiRoutes: [slackEventsRoute]`).

**Le préfixe `/api` est réservé.** `@mastra/server` refuse toute route personnalisée commençant
par l'`apiPrefix` (défaut `/api`) — et c'est un **échec au démarrage**, pas un 404 :

```
Custom API route "/api/slack-events" must not start with "/api" —
that path is reserved for built-in Mastra routes.
```

L'endpoint Slack est donc monté sur **`/slack/events`** (`SLACK_EVENTS_PATH` dans
`src/api/slack-events.route.ts`). C'est cette URL — `https://<domaine>/slack/events` — qui va
dans le champ « Request URL » de l'app Slack.

**Marqueur de progression** (`src/features/notification/infrastructure/providers/slack-progress.ts`,
2026-08-11) : un run prend 2 à 17 s (jusqu'à ~21 s avec le back-off du dernier maillon), pendant
lesquelles le bot paraissait muet. `startProgress()` poste immédiatement « Je regarde ça, un
instant… », puis la réponse **remplace** ce message via `chat.update` — un seul message dans le
fil. Il ne bloque pas : la promesse du `postMessage` n'est attendue qu'à la conclusion, donc le
marqueur part en parallèle de l'appel LLM.
- **Ce n'est jamais un point de panne** : tout échec du marqueur est journalisé en `warn` et
  `resolve()` se rabat sur un `postMessage` normal. Le bot répond même sans indicateur.
- **`assistant.threads.setStatus` a été écartée** — c'est la seule vraie API « typing indicator »
  de Slack, mais elle n'opère que sur un *assistant thread*, conteneur créé par la fonctionnalité
  « Agents & AI Apps » que le manifeste Kisso n'active pas. Le scope n'est pas le blocage
  (`chat:write` suffit) : c'est le conteneur qui n'existe pas.
- **Pas de rafraîchissement périodique**, décision assumée : un timer courrait contre `resolve()`
  et une mise à jour en vol ÉCRASERAIT la réponse finale par le texte du marqueur.

**Upload de fichier — `SlackAdapter.uploadFile()` via `files.uploadV2`** (2026-08-11). Deux
pièges constatés dans les typings installés (`@slack/web-api` 8.0.0), aucun visible à la lecture :
- **Le permalink est DOUBLEMENT imbriqué.** `files.upload` (v1) rendait un unique objet `file`.
  La v2 est un enrobage client (`getUploadURLExternal` → PUT → `completeUploadExternal`) qui rend
  `{ ok, files: [<réponse completeUploadExternal>, …] }`, chaque réponse portant à son tour son
  propre tableau `files` : le lien est en `res.files[0].files[0].permalink`.
- **Le typage public ne le dit pas.** L'accesseur `client.files.uploadV2` est déclaré
  `MethodWithRequiredArgument<FilesUploadV2Arguments, WebAPICallResult>`, soit
  `{ ok, response_metadata? }` — le champ `files` **n'existe pas** pour TypeScript. Seule la
  méthode `WebClient.filesUploadV2()` porte le type riche. La lecture se fait donc depuis
  `unknown`, défensivement, et l'absence de permalink n'est **pas** un échec : le fichier est
  livré, le lien est un confort.
- `channel_id` et non `channels` (déprécié en v2), et `file: Buffer.from(bytes)` — le SDK refuse
  un `Uint8Array` nu et interpréterait une **chaîne** comme un CHEMIN à lire sur le disque,
  inutilisable sur Vercel.

⚠️ **Le scope `files:write` n'est PAS accordé au bot — c'est le SEUL obstacle restant entre le
dépôt et une livraison Slack réelle.** Il exige **deux gestes humains**, dans cet ordre :
1. ajouter `files:write` dans *OAuth & Permissions* ;
2. **réinstaller l'app dans le workspace** (*Settings → Install App → Reinstall to Workspace*,
   jusqu'au bouton *Allow*).

L'ajout seul ne propage **rien** : le jeton conserve les scopes de l'installation en cours —
c'est exactement le piège déjà vécu et documenté le 2026-08-08. Tant que ce n'est pas fait,
`files.uploadV2` répond `missing_scope`, `generateDocument` se rabat sur l'email, puis rend
`delivery: 'failed'` avec `reason: 'missing_scope'`. `SlackAdapter.uploadFile` retraduit ce
refus en une `Error` de prose qui nomme les deux gestes et conserve l'erreur d'origine dans
`cause` — d'où l'inspection de la **chaîne** de causes côté tool.

Contraintes Slack Events API à respecter dans tout handler :
1. Répondre `200` en **moins de 3 s** — traiter l'agent en tâche de fond, jamais avant l'ACK.
2. Vérifier la signature `X-Slack-Signature` / `X-Slack-Request-Timestamp` avec
   `SLACK_SIGNING_SECRET` (HMAC-SHA256 sur `v0:timestamp:body`, comparaison à temps constant,
   rejet si timestamp > 5 min).
3. Ignorer ses propres messages (`bot_id`, `subtype: bot_message`, `user === bot_user_id`),
   sinon boucle infinie.
4. Dédupliquer les retries via `X-Slack-Retry-Num` + `event_id`.

**Deux pièges de configuration côté app Slack** (aucun n'est visible dans le code, tous deux
rencontrés et corrigés) :
- **Socket Mode doit être désactivé.** Il est mutuellement exclusif avec la Request URL HTTP :
  tant qu'il est actif, Slack ouvre un WebSocket et n'envoie **aucune** requête à l'endpoint.
- **`app_mention` doit être abonné.** Le handler ne traite les mentions en canal que via
  `app_mention` et n'accepte `message` que si `channel_type === 'im'` — c'est précisément ce
  qui évite la double réponse (une mention émet les deux événements). Sans `app_mention`
  abonné, les mentions en canal ne déclenchent rien.

Abonnements actuels : `app_mention`, `message.im`, `message.channels`, `message.groups`.

**Le bot ne recevait AUCUN événement : la cause était l'INSTALLATION, pas la configuration.**
Résolu le 2026-08-08 par une réinstallation de l'app dans le workspace (*Settings → Install App →
Reinstall to Workspace*, en allant jusqu'au bouton *Allow*). Le manifeste était pourtant déjà
conforme — d'où plusieurs heures perdues à chercher côté config.

Deux réglages bloquaient réellement, dans cet ordre :
1. `features.app_home.messages_tab_enabled: false` → **aucun `message.im` n'est jamais émis**. Ce
   réglage vit dans **App Home**, pas dans Event Subscriptions, donc la page des abonnements
   paraissait parfaite. Corrigé via `apps.manifest.update`.
2. L'installation du workspace ne reflétait pas la config de l'app → **aucun `app_mention` non plus**.
   Seule la réinstallation propage.

**Méthode de diagnostic à réutiliser** (elle a tranché là où la console mentait) :
- La console Slack peut afficher un état différent de ce qui est stocké. **Se fier au manifeste
  réel** : générer un *App Configuration Token* (`api.slack.com/apps`, bas de la liste), le faire
  passer par `tooling.tokens.rotate` (le `xoxe-1-…` brut est un refresh token, `apps.manifest.export`
  le refuse avec `not_allowed_token_type`), puis lire le manifeste. Chaque rotation invalide la
  précédente — conserver le nouveau refresh token.
- **`vercel logs <url> --json`** est fiable et sub-30 s : valider l'instrument par une requête de
  contrôle avant d'affirmer « aucune livraison ». Les logs sont propres à chaque déploiement et
  repartent à zéro après un redéploiement.
- **`app_home_opened`** est la sonde idéale : aucun scope requis, indépendante de l'appartenance aux
  canaux et de l'onglet Messages. Si elle arrive, la livraison fonctionne et le problème est ailleurs.
- Le badge *Verified* ne prouve rien sur la livraison courante — seulement qu'un challenge a réussi
  un jour. Un `Save` sur une URL **inchangée** ne redéclenche aucune vérification.

**Appartenance aux canaux — vérifié le 2026-08-07 via `conversations.list` :** le bot n'est
membre que de **2 des 5** canaux listés. `chat.postMessage` échoue avec `not_in_channel`
partout ailleurs, et cet échec est **silencieux** pour l'utilisateur (le message d'erreur de
repli est posté dans le même canal inaccessible, donc échoue aussi — cf. `handleMessage`).

| Canal             | ID            | `is_member` |
| ----------------- | ------------- | ----------- |
| `#kisso-hq`       | `CMLKC4S5T`   | ✅ oui      |
| `#engineer-karyl` | `C0BJGBVB5HP` | ✅ oui (privé) |
| `#alerts-dev`     | `CMA1TPCN6`   | ❌ non      |
| `#random`         | `C09TRLL2KEW` | ❌ non      |
| `#signals`        | `C0AV1B23V0U` | ❌ non      |

Le scope `channels:join` est accordé mais **ne fait pas d'auto-join implicite** : il faut un
appel `conversations.join` explicite, qu'aucun code n'émet aujourd'hui.

Scopes réellement accordés au bot : `channels:join`, `chat:write`, `chat:write.customize`,
`im:write`, `channels:read`, `groups:read`, `users:read`, `users:read.email`,
`groups:write.invites`, `channels:manage`, `groups:write`, `app_mentions:read`,
`channels:history`, `groups:history`, `im:history`.
**`files:write` en est ABSENT** — c'est le blocage décrit plus haut, et le code l'assume déjà
(`src/mastra/index.ts` le commente au point de câblage).

## Variables d'environnement

`.env` à la racine (chargé par `dotenv` dans `src/mastra/index.ts`, et par
`--env-file=.env` pour les scripts).

| Variable                | Rôle                                             |
| ----------------------- | ------------------------------------------------ |
| `DATABASE_URL`          | **Requis** — LibSQL/Turso. Throw au boot si absent |
| `DATABASE_AUTH_TOKEN`   | Token Turso                                       |
| `GROQ_API_KEY`          | LLM primaire                                     |
| `MISTRAL_API_KEY`       | LLM fallback                                     |
| `SLACK_BOT_TOKEN`       | `xoxb-…` — WebClient + Events                    |
| `SLACK_SIGNING_SECRET`  | Vérification signature Events API                |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Envoi email **primaire**. Gmail : `SMTP_PASS` = mot de passe d'APPLICATION |
| `BREVO_API_KEY`         | Envoi email — **repli** uniquement (compte non activé, voir Pièges) |
| `NOTIFICATION_FROM`     | Expéditeur email                                 |
| `LOG_LEVEL`, `NODE_ENV` | `debug\|info\|warn\|error`, `development\|staging\|production\|test` |

Ne **jamais** logger la valeur d'une clé d'API — uniquement sa présence (`Boolean(...)`).
`src/config/index.ts` prétend valider le tout via Zod et basculer sur AWS Secrets Manager en
production, mais il n'est **jamais appelé** (voir Pièges).

Config morte, encore présente dans `.env` / Vercel et à purger : `RESEND_API_KEY`
(adaptateur supprimé), `GOOGLE_GEMINI_API_KEY`, `SLACK_USER_TOKEN`, `OPENAI_API_KEY`.

## Pièges connus

- **Garde-fou anti prompt-injection — BRANCHÉ le 2026-08-08** (l'ancienne note « placeholders jamais
  substitués » est caduque). Les agents passent désormais par `buildAgentInstructions()` et le texte
  Slack par `wrapAgentInput()`, tous deux dans `src/shared/security/llm-guardrail.ts`. Vérifié :
  plus aucun littéral `{DELIMITER_PREFIX}` ni `[[SESSION_MARKER]]`, et le même délimiteur
  (`<kisso_XXXX_user_input>`) borne l'entrée et est annoncé dans les instructions.
  - **Le marqueur est par PROCESSUS, pas par requête** : les `instructions` d'un `Agent` Mastra sont
    figées à la construction. Compromis assumé et commenté dans le module.
  - `KeyManager.KEY_ITERATIONS` valait `100000` — or `scryptSync` exige que `N` soit une puissance
    de 2, donc toute instanciation réelle levait `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`. Le bug était
    masqué tant que rien n'instanciait la classe. Corrigé à `16384` (2^14, RFC 7914).

- **PLAFOND GROQ 12 000 tokens/minute — c'est la limite qui casse la production aujourd'hui.**
  Mesuré le 2026-08-07 (`x-ratelimit-limit-tokens: 12000`, recharge continue à ~200 tok/s).
  Or **un seul appel agent consomme 3 384 tokens d'entrée** — non pas à cause du
  `SYSTEM_SECURITY_PROMPT` (1 308 caractères ≈ 374 tokens seulement), mais des **schémas JSON
  des outils**, réinjectés intégralement à chaque aller-retour. Un flux avec appel d'outil
  (question → tool call → tool result → réponse) fait 3 allers-retours cumulant l'historique,
  soit ~10–12 k tokens : le budget d'une minute entière est brûlé par **une seule requête**.
  - Symptôme : `POST /api/agents/:id/generate` → `HTTP 500 {"error":"Rate limit exceeded"}`.
    Un prompt trivial sans outil passe (3 384 tokens, testé 3×/3 OK) — c'est ce qui rend
    l'échec trompeusement intermittent, et ce qui fait « flotter » `npm run test:integration`
    entre 121/121 et 119/121 selon le quota résiduel du moment.
  - Ce n'est **PAS** un bug de la chaîne de fallback. Vérifié empiriquement le 2026-08-08 : avec
    une clé Groq invalide et une clé Mistral valide, **Mistral prend bien le relais**. Le `500`
    signifie donc que les DEUX fournisseurs ont échoué. Le message remonté est l'erreur BRUTE du
    **dernier** maillon (Mastra appelle le dernier avec `shouldThrowError: false`).
  - **Piège de journalisation Mastra** : le log `Upstream LLM API error` de FIN DE RUN attribue
    toujours l'erreur à `models[0]` (`getModel()` retourne inconditionnellement `#firstModel`), donc
    un échec Mistral apparaît sous `provider: 'groq.chat'`. C'est ce log trompeur qui a fait
    diagnostiquer à tort « Groq saturé » pendant des heures. Seul le log PAR TENTATIVE est fiable.
    `withChainFailureLogging()` dans `model-fallback.ts` journalise désormais le maillon réel.
  - **Coût réel par appel, mesuré en production le 2026-08-08 à étape unique** (après réduction) :
    `questionnaireEngine` 1 726, `onboardingOrchestrator` 3 308, `notificationAgent` 1 832 tokens
    d'entrée. Avant réduction : 1 936 / 3 979 / 7 849. Un flux de création d'employé (2 étapes)
    consomme 6 838 tokens et **passe désormais** — il échouait systématiquement avant.
  - **Second dégraissage, 2026-08-11** (`npx tsx _measure.mts`, ratio 3,5 car./token) :
    FLOOR `onboardingOrchestrator` 1 649 → **1 458**, `questionnaireEngine` 1 266 → **1 120**,
    `notificationAgent` 1 391 → **1 238**. Le bloc STYLE et le bloc ANTI-INVENTION sont
    factorisés dans `src/shared/agent-style.ts` — mais attention, **factoriser n'économise
    aucun token** (chaque agent envoie quand même son bloc) : le gain vient du
    RACCOURCISSEMENT, la factorisation sert à ne raccourcir qu'à un seul endroit.
  - **Le vrai poste de coût était le tool-result, pas l'historique.** `getEmployeeProfile`
    renvoyait `tasks` non borné avec les 19 colonnes de la table : **2 506 tokens** pour un
    seul retour, davantage que six messages utilisateur. Projeté et borné à 5 tâches / 6 champs
    via `src/features/employee/application/mappers/task-summary.mapper.ts` → **329 tokens**,
    et la taille est désormais **indépendante du nombre de tâches** (verrouillé par test).
    Deux tests garde-fou : `tests/unit/tools/tool-result-budget.test.ts` et
    `tests/unit/agents/agent-instructions-budget.test.ts`.
  - **Même défaut, en pire, sur `generateDocument` — corrigé le 2026-08-11.** Il retournait
    l'entité `Document` COMPLÈTE, `content` compris : il renvoyait au modèle, à ses frais, le
    texte que le modèle venait lui-même d'écrire, et ce texte restait ensuite dans l'historique
    de TOUS les tours suivants. Sur un guide réaliste : **685 → 39 tokens** en nominal (91 quand
    un `hint` de dégradation est joint). Le chiffre importe moins que la propriété : la taille ne
    dépend **plus du tout** de la longueur de `content` (test : Δ = 0 caractère entre un contenu
    de 10 et de 11 000 caractères), et le tool-result tient sous 60 tokens, verdict de livraison
    compris.
  - Bloc DOCUMENTS de `onboardingOrchestrator` **réécrit**, pas ajouté : 203 → 198 caractères
    (58 → 57 tokens), le préfixe étant repayé à chaque aller-retour. L'ancien texte constatait un
    vide fonctionnel (« il ne renvoie AUCUN fichier téléchargeable ») ; le garder aurait bridé la
    capacité en interdisant à l'agent d'annoncer ce qu'il vient de faire. Ajout de fond : lire le
    champ `delivery` du tool-result plutôt que supposer — c'est ce qui permet l'énoncé honnête
    « le document est prêt mais je n'ai pas pu te l'envoyer ».
  - ⚠️ `usage.inputTokens` **cumule toutes les étapes** : comparer deux mesures sans vérifier
    `steps.length` mène à des conclusions fausses.
  - Attendre ne suffit pas : réessayé à quota plein après 60 s → même `500`, en 21 s
    (le back-off du dernier maillon).
  - Correctifs possibles, par ordre d'efficacité : (1) passer Groq/Mistral sur un palier payant ;
    (2) réduire le nombre d'outils exposés par agent (6 sur `onboardingOrchestrator`) ou alléger
    leurs schémas — c'est le poste de coût dominant ; (3) accepter la dégradation et ne compter
    que sur le fallback.

- **Zod est épinglé à `3.25.76`** : le parseur de schémas du Vercel AI SDK casse sur certaines
  constructions. Éviter `z.discriminatedUnion` (utiliser `z.object`) et les regex à classes
  Unicode (`\p{L}`) dans les schémas de tools — plusieurs commits récents corrigent exactement ça.
- `npm run lint` se termine par `|| true` : il ne fait jamais échouer la CI. Lire la sortie.
- `vitest.config.integration.ts` est le **seul** config d'intégration (le doublon orphelin
  `vitest.integration.config.ts` a été supprimé). Il charge `.env` via `globalSetup` et travaille
  sur une base isolée `data/integration-test.db` — les tests d'intégration ne polluent plus
  `data/kisso.db`.
- **Le provider email est SMTP, pas Brevo.** `createEmailProvider()` dans `src/mastra/index.ts`
  choisit `SmtpAdapter` (nodemailer) dès que `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` sont tous
  renseignés, sinon il retombe sur `BrevoAdapter`. Détail et arbitrage : `docs/adr/006-*.md`.
- **Gmail exige un mot de passe d'APPLICATION** : le mot de passe du compte est refusé
  (`534-5.7.9 Application-specific password required`). Il faut un « App Password » de
  16 caractères, donc la validation en deux étapes activée. `SMTP_PASS` = ce mot de passe.
- **SMTP en serverless** : une connexion TCP, contrairement à une API HTTP — plus lent et plus
  fragile sur Vercel, la connexion ne survit pas au gel de la fonction. L'adaptateur utilise
  `pool: false` et des timeouts à 10 s pour échouer vite.
- **Pièces jointes email : 5 Mio sur le TOTAL, vérifiés AVANT toute E/S.**
  `EmailProvider.sendEmail` a gagné un 4ᵉ paramètre **optionnel** `attachments` (optionnel à
  dessein : `send-notification` et le workflow d'onboarding ne bougent pas et produisent le même
  message). La borne vit dans le **domaine**
  (`notification/domain/services/email-attachment-policy.ts`) et non dans un adaptateur : SMTP et
  Brevo doivent refuser exactement les mêmes envois, sinon un basculement de fournisseur
  changerait silencieusement ce que le produit accepte de livrer. Elle porte sur le total, pas
  sur chaque pièce — c'est le volume transféré qui fait expirer le socket. Raison du chiffre :
  `SMTP_TIMEOUT_MS` = 10 s, et le base64 ajoute +33 % sur le fil (5 Mio de binaire ≈ 6,7 Mio
  transférés, ~12 Mio de pic mémoire). `assertEmailAttachmentsFit` **lève** au lieu de rendre un
  booléen : un refus silencieux reproduirait exactement le piège `emailSent: false` /
  `status: 'success'`.
- **Pourquoi Brevo a été abandonné (historique, ne pas y revenir sans vérifier)** : la clé
  `BREVO_API_KEY` est valide (`GET /v3/account` → 200, plan gratuit, 300 crédits) mais
  `POST /v3/smtp/email` renvoie `403 permission_denied` — *"Your SMTP account is not yet
  activated"*. Le blocage est au niveau du **compte** : il se produit même avec l'expéditeur
  validé `sdan28399@gmail.com`, donc aucune modification de config ne le contourne. L'activation
  du compte transactionnel doit être demandée à Brevo. Par ailleurs `NOTIFICATION_FROM=noreply@kisso.com`
  n'est pas un expéditeur validé et `kisso.com` n'est pas un domaine vérifié.
- **L'échec d'email n'est plus silencieux — mais c'est `outcome` qu'il faut lire, PAS
  `run.status`** (corrigé le 2026-08-11 ; l'ancienne note « échec silencieux » est caduque pour
  le workflow). `employeeOnboardingWorkflow` ne connaissait que « réussi » / « échoué », donc un
  email jamais parti se rendait par un `emailSent: false` noyé dans un run `status: 'success'` —
  trois lecteurs successifs (rapports humains, `scripts/production-*.ts`, agents) y ont conclu à
  tort qu'un email était parti, d'où de faux « ✅ PASS ».
  - `src/features/onboarding/domain/value-objects/onboarding-outcome.ts` :
    `OnboardingOutcome` ∈ `completed | degraded | failed`, plus `degradedSteps: { step, reason }[]`.
    Le couple QUOI/POURQUOI est indissociable — un booléen dit qu'il faut réparer, jamais quoi.
  - **`run.status` reste `'success'`** : c'est un champ de Mastra, non modifiable. Le verdict vit
    dans la **charge utile**. `failed` ne figure jamais dans le résultat (un run en échec n'a pas
    de résultat) ; la valeur existe pour que les appelants qui traduisent `run.status` partagent
    le même vocabulaire.
  - **Trois** étapes best-effort inventoriées, pas seulement l'email : `onboardingTasks`,
    `welcomeEmail`, `slackInvite`. N'en traiter qu'une aurait laissé les deux autres dans le même
    angle mort, avec le même symptôme.
  - ⚠️ **« non applicable » ≠ « dégradé ».** Une invitation Slack sans provider ni canal de
    département n'était pas censée avoir lieu — et c'est le cas de **toute** soumission de la
    modale, qui passe `slackChannelId: null`. La compter comme dégradation aurait rendu
    « dégradé » l'état NORMAL et détruit le signal. En revanche, canal configuré + compte Slack
    introuvable **est** une dégradation : l'arrivant n'atterrit dans aucun canal.
  - On ne LÈVE pas : avorter le run pour une indisponibilité SMTP de trente secondes ferait
    perdre l'employé créé, ses tâches et son invitation. `Degraded` est un aboutissement.
  - Appelants alignés sur ce vocabulaire : `src/api/slack-interactions.route.ts`,
    `scripts/production-scenarios.mjs`, `scripts/production-test.ts`,
    `scripts/production-test-mocked.ts`, `docs/guides/tests-manuels.md`, `docs/SLACK_BOT_SETUP.md`.
  - **Le tool `sendNotification` n'a jamais eu ce défaut** (vérifié) : il échoue *bruyamment* sur
    la résolution du destinataire (`throw NotFoundError`) et, sur échec de transport, enregistre
    et **retourne** l'entité avec `status: 'failed'` / `sentAt: null`. L'issue est donc lisible
    dans le tool-result — il n'y a rien à corriger de ce côté.
- **`src/config/index.ts` est du code mort** : `getConfig()` n'est appelé nulle part. Ses
  garde-fous Zod (dont `BREVO_API_KEY.min(1)`) ne s'exécutent jamais. Son schéma `database.url`
  n'accepte que `file:` ou `postgresql://` alors que la vraie valeur est `libsql://` — le brancher
  tel quel ferait échouer le boot.
- **Les migrations `drizzle/` sont désynchronisées de `schema.ts`** : `0000_*.sql` crée
  `employees` avec 11 colonnes, le schéma en déclare 20. Appliquer `drizzle/` sur une base vierge
  échoue (`table employees has no column named phone`). `data/kisso.db` ne fonctionne que parce
  qu'elle a été construite par `drizzle-kit push`, jamais par le migrateur. `npm run db:generate`
  doit être relancé **dans un vrai TTY** (drizzle-kit pose des questions added-vs-renamed).
- **Drizzle IGNORE SILENCIEUSEMENT toute clé de `.values()` sans colonne déclarée** — et ça a
  déjà coûté des données. L'entité `Document` déclare `content: string`, `generateDocument`
  l'exige en entrée (`z.string().min(1)`)… et la table `documents` n'avait **aucune colonne**
  pour l'accueillir : la ligne s'écrivait avec `content` perdu, sans erreur ni avertissement, le
  `as unknown as` des mappers effaçant l'écart pour le compilateur. État constaté sur la Turso de
  production le 2026-08-11 : **6 lignes sur 6 sans contenu, irrécupérables**. Le symptôme
  s'observe aussi dans l'autre sens (colonne présente en base mais absente de `schema.ts`).
  - Colonne `content` ajoutée à `schema.ts`, DDL à appliquer **à la main** :
    `scripts/ddl-documents-content.sql`. ⚠️ **Ordre imposé — DDL d'abord, déploiement ensuite** :
    une fois `content` déclarée, Drizzle la NOMME dans l'INSERT, donc `generateDocument` échoue
    en `no such column: content` tant que la base n'est pas migrée. C'est le bon comportement
    (échec bruyant plutôt que perte muette), mais il faut respecter l'ordre.
  - `ALTER TABLE … ADD COLUMN` n'a pas de forme `IF NOT EXISTS` en SQLite : rejouer le fichier
    échoue avec `duplicate column name: content` — erreur bénigne, elle signifie que c'est fait.
  - Colonne **nullable** à dessein : les 6 lignes existantes n'ont pas de contenu à rétablir, un
    `NOT NULL` exigerait une valeur de remplissage, c'est-à-dire un document vide présenté comme
    complet. Le bloc « stockage » de la table (`storage_key`, `storage_bucket`, `file_name`,
    `file_size`, `mime_type`) décrit une référence S3/GCS qui **n'existe pas** : NULL sur 6
    lignes / 6, aucun bucket configuré nulle part. Tant qu'aucun stockage objet n'existe, la base
    EST le stockage.
- **`drizzle-kit push` se BLOQUE contre une base `libsql://` distante** (avec
  `dialect: 'sqlite'`) : pas d'erreur, il ne rend jamais la main. Le schéma de la Turso de
  production a dû être appliqué en exportant le DDL depuis `schema.ts` et en exécutant les
  69 statements directement (10 tables, 69 index). Avant cette opération la base de prod ne
  contenait **aucune** table applicative — seulement 38 tables internes `mastra_*` — et le bot
  déployé ne persistait rien.
- **Traitement Slack en tâche de fond — RÉSOLU** (l'ancienne note « non validé en serverless »
  est caduque). `scheduleBackgroundWork()` dans `src/api/slack-events.route.ts` déclare la
  promesse au lanceur Vercel via `globalThis[Symbol.for('@vercel/request-context')].get().waitUntil`,
  ce qui empêche le gel de la fonction avant la fin de l'appel LLM. Hors Vercel, le simple
  détachement suffit. Vérifié en production le 2026-08-07 :
  `POST /slack/events` avec `url_verification` signé → `200` + challenge renvoyé en 1,7 s ;
  timestamp décalé de −400 s → `401 stale_timestamp` ; `subtype: bot_message` → `200 {"ok":true}`
  sans traitement. Garde-fou d'observabilité : la route logge `Slack background work is detached
  on Vercel` en `error` si `waitUntil` venait à disparaître — c'est la ligne à chercher si le bot
  recommence à ne plus répondre. `maxDuration` est forcé à 60 s par `scripts/fix-vercel-output.js`.
- **Déduplication Slack — désormais à DEUX niveaux** (l'ancienne note « LRU en mémoire, non
  corrigé » est caduque *dans le dépôt* ; elle reste vraie en production tant que la table n'est
  pas appliquée).
  - Le LRU en mémoire est **par instance** : incapable par construction d'écarter un rejeu routé
    vers une AUTRE instance. C'est la cause de la **double réponse** du 2026-08-11 12:38 UTC
    (« Ton Guide en PDF est prêt » suivi de « Désolé, une erreur s'est produite ») — dans
    `handleMessage` les deux publications sont mutuellement exclusives, donc deux messages
    signifient **deux invocations** : l'instance A était occupée par le `waitUntil` de l'appel
    LLM, et le rejeu (`retryNum: 1`, provoqué par un ACK à 6,7 s sur démarrage à froid) est parti
    sur une instance neuve, au cache vide.
  - `claimEvent()` prend maintenant la clé d'abord localement (aucune E/S, cas le plus fréquent
    sur instance chaude), puis dans un **store partagé Turso** — table `slack_event_dedup`,
    la clé du handler (`ts:<channel>:<ts>` ou `id:<event_id>`) en PRIMARY KEY, ce qui rend la
    prise atomique via `INSERT … ON CONFLICT DO NOTHING`.
  - **Dégradation assumée** : store indisponible → repli sur le seul cache local et l'événement
    est **accepté**. Un doublon possible vaut mieux qu'un message perdu — le doublon est visible
    et corrigeable, le silence ne l'est pas. Ligne à chercher :
    `Shared Slack dedup unavailable — falling back to the per-instance cache` (en `error`).
  - Autres signatures de log : `Dropping duplicate Slack event (claimed by another instance)`,
    et `Reprocessing an abandoned Slack event` — symptôme d'une invocation tuée en vol, la grâce
    d'abandon ayant expiré.
  - ⚠️ **La table n'a PAS de script DDL et n'est appliquée nulle part.** Sans elle, la dégradation
    ci-dessus est le comportement permanent et la double réponse reste possible. Voir `TODO.md`.
- **`mastra.getAgent()` LÈVE, elle ne retourne jamais `undefined`** : `MastraError` d'id
  `MASTRA_GET_AGENT_BY_NAME_NOT_FOUND`. Un `if (!agent)` posé sur son résultat est du code
  MORT, et l'erreur retombe alors sur le message générique du catch. ⚠️ Piège dans le piège :
  `error.name` vaut `'Error'`, **pas** `'MastraError'` — reconnaître par
  `error instanceof MastraError && error.id === '…'` (import depuis `@mastra/core/error`).
- **`generateDocument` rend, enregistre, livre et rend compte** (2026-08-11 — l'ancienne note
  « aucun agent ne peut produire de PDF » est **caduque**). Il produit un fichier réel (PDF ou
  DOCX), l'enregistre, l'uploade dans le fil Slack d'où vient la demande ou l'envoie en pièce
  jointe, et retourne un **verdict**.
  - **Il n'existe toujours AUCUNE URL de téléchargement dans ce système** — le fichier est livré
    par upload. C'est l'histoire à retenir : sommé de livrer un document qu'il ne pouvait pas
    produire, le modèle a inventé la seule chose qu'il savait fabriquer, le faux lien
    `https://kisso.internal/docs/<uuid>/download` du 2026-08-11 (`grep kisso.internal` → **0
    occurrence** dans le dépôt). `sanitizeAgentOutput` retire toujours toute URL hors
    `ALLOWED_LINK_DOMAINS` et journalise les hôtes en `error` : ce garde-fou **reste actif**, il
    n'est pas rendu superflu par la capacité.
  - **Le permalink Slack est journalisé, jamais retourné au modèle.** Remettre une URL dans le
    contexte rouvrirait précisément la porte par laquelle le faux lien est passé — et le fichier
    est déjà dans le fil, le lien n'apporte rien.
  - `inputSchema` : `format` restreint de **10 à 2 valeurs** (`pdf`/`docx` — les seules qui aient
    un renderer), **défaut `pdf`** et non plus `txt` (un défaut `txt` produisait des documents
    que personne n'avait demandés dans ce format) ; nouveau champ `deliverTo`
    (`slack | email | none`, défaut `slack`). **Ni canal, ni thread, ni adresse dans le schéma** :
    le canal vient du `requestContext`, l'adresse de l'annuaire via `employeeId`. Le tool est
    atteignable depuis un message Slack arbitraire, donc toute valeur produite par le LLM est
    réputée contrôlée par un attaquant — même modèle de menace que `sendNotification`.
  - Verdicts rendus : `delivery` ∈ `slack | email | none | failed`, `reason` ∈
    `employee_not_found | no_slack_context | missing_scope | no_email | delivery_failed |
    not_rendered`, plus un `hint` **payé uniquement dans les cas dégradés**.
    ⚠️ `missing_scope` déclenche un repli sur l'email ; un échec Slack ordinaire
    (`not_in_channel`, panne passagère) **non** — une indisponibilité momentanée n'est pas une
    raison d'écrire à quelqu'un qui n'a rien demandé, alors qu'un scope manquant est un manque
    de configuration durable.
  - Le document est **toujours enregistré**, même quand la livraison échoue. Seule une livraison
    réussie pose `status: Sent` — c'est la seule trace persistée du départ d'un document.
  - `documentGenerationWorkflow` est inchangé : il utilise toujours `PdfmakeService.generate()`,
    qui écrit dans `./data/documents` et rend un chemin local — inutilisable sur Vercel. Les
    agents, eux, passent par `render()` qui ne touche jamais le disque.
- **`verify:bundle` et le câblage de `DocxService` vont ENSEMBLE.** Le garde-fou exige désormais
  `docx` (`--require pdfkit,pdfmake,js-md5,fontkit,docx` dans `package.json`), mais c'est
  l'**import statique** de `docx` par `DocxService`, atteignable depuis `src/mastra/index.ts`,
  qui le fait entrer dans le bundle : exiger sans câbler casse le build. L'import est volontairement
  statique là où `pdfmake.service.ts` passe par `createRequire` — c'est l'invisibilité du
  `require()` dynamique qui avait produit le `Cannot find module 'js-md5'` en production.
  Vérifié : build OK, `docx@9.7.1` et ses 5 dépendances (`hash.js`, `jszip`, `nanoid`, `xml`,
  `xml-js`) présents, smoke test PDF depuis le bundle → 7 082 octets, en-tête `%PDF-` valide.
- **Node tourne en v20.19.4** alors que `engines` exige `>=22.13.0` — divergence non résolue.
- `tests/unit/infrastructure/**` est exclu du run unitaire et rattaché à l'intégration.
- `src/features/document/domain/ports/employee.repository.ts` duplique le port de la feature
  `employee` : chaque feature possède ses propres ports, c'est intentionnel.

## Règles de travail

1. Lire l'intégralité d'un fichier avant de le modifier.
2. TDD : test rouge → vert → refactor.
3. Mettre à jour `TODO.md` et `CHANGELOG.md` après un changement significatif.
4. Ne pas modifier un ADR existant (`docs/adr/`) — en créer un nouveau.
5. Contexte complémentaire : `CONTEXT.md` (métier), `AGENT.md`, `docs/guides/`.
