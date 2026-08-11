# CHANGELOG.md — Kisso Onboarding

## [Unreleased] - 2026-08-11
### Changed (lot 0 — coût en tokens d'entrée)

Mesures au ratio **3,5 caractères/token** (calibré sur les relevés de production du projet),
via `_measure.mts` étendu aux 3 agents complets — instructions + tous les tools tels que câblés
dans `src/mastra/index.ts`.

| Agent                    | avant | après | gain |
| ------------------------ | ----- | ----- | ---- |
| `onboardingOrchestrator`  | 1649  | 1458  | −191 |
| `questionnaireEngine`     | 1266  | 1120  | −146 |
| `notificationAgent`       | 1391  | 1238  | −153 |
| **Somme**                 | 4306  | 3816  | **−490** |

- **Tool-results bornés et projetés** — le plus gros gain du lot.
  `getEmployeeProfile` rendait `tasks` **non borné**, avec les 19 champs de l'entité `Task`.
  Sur 12 tâches en base : **2 506 → 329 tokens** par appel. Nouveau
  `application/mappers/task-summary.mapper.ts` (`MAX_TASKS_IN_RESULT = 5`, projection sur
  `id/title/status/priority/dueDate`), appliqué à `getEmployeeProfile` **et** `getTaskList`.
  - La taille du résultat est désormais **indépendante du nombre de tâches** (verrouillé par test).
  - Troncature **signalée** (`totalTasks` / `shown`) : sans ces compteurs le modèle conclut qu'il
    a vu toute la liste. `getTaskList` filtre **avant** de tronquer, pour que `totalTasks` compte
    les tâches correspondant à la demande.
  - Effet de bord de sécurité : `metadata` et `description` ne partent plus dans le contexte du
    LLM. Même raisonnement que la projection du profil employé (commit `889ab66`), qui est
    **étendue, pas remplacée** — `progress` est projeté à son tour.
- **Blocs STYLE et ANTI-INVENTION factorisés** dans `src/shared/agent-style.ts`.
  ⚠️ La factorisation n'économise **aucun** token à l'exécution (chaque agent envoie quand même
  le bloc) : elle sert la maintenance. Le gain vient du **raccourcissement** — bloc STYLE
  ~170 → 80 tokens sur chacun des 3 agents. Le texte peut rester bref sur la mise en forme parce
  que le vrai garde-fou est du code : `sanitizeAgentOutput` convertit déjà markdown → mrkdwn et
  retire les emojis.
- **« URL / lien / chemin de fichier » ajouté à la liste ANTI-INVENTION.** La liste nommait
  « prénom, nom, email, identifiant, date, score » mais pas les URL : c'est le trou par lequel est
  passé le faux lien `https://kisso.internal/docs/<uuid>/download`.
- **Consigne documents sur l'orchestrateur** : `generateDocument` **enregistre** le document et ne
  rend ni fichier ni URL. Voir la note « livraison de PDF » dans `TODO.md` — la capacité attendue
  côté produit n'existe pas encore.
- **Instructions métier dégraissées** : elles ré-énuméraient les noms des tools, que le modèle
  reçoit déjà via les schémas. Les garde-fous issus de régressions réelles sont tous conservés
  (création d'employé impossible, résolution par email d'abord, déduplication par l'historique).
- **Schémas allégés** : `scheduleReminder` 232 → 183 tokens, `generateDocument` 212 → 172. Seuls
  des `.describe()` redondants avec le nom du champ ont été retirés — **aucun champ ni aucune règle
  de validation n'a bougé**. `format` est conservé sur `generateDocument` malgré son enum coûteux :
  c'est le seul point d'entrée par lequel un document pourra être demandé en `pdf`.

## [Unreleased] - 2026-08-11
### Added (lot 1 — mémoire conversationnelle)
- **Feature `conversation`** (`src/features/conversation/`), **sans `@mastra/memory`** :
  ce paquet dépend de `zod ^4.4.3` alors que le projet épingle `3.25.76` (le parseur de schémas
  du Vercel AI SDK casse au-delà), et surtout il ne sait plafonner qu'en **nombre de messages** —
  inadapté quand un seul retour d'outil pèse 979 tokens. Décision D2 de
  `docs/superpowers/specs/2026-08-11-memoire-conversationnelle-design.md`.
  - `domain/entities/conversation-turn.ts` — un tour = un message. **Texte seul** : jamais de
    tool-call ni de tool-result (décision D3, levier de −63 % sur la fenêtre).
  - `domain/value-objects/conversation-id.ts` — `deriveConversationId({ channel, threadTs })` :
    `threadTs ? \`${channel}:${threadTs}\` : channel`. En DM `threadTs` est `undefined` **par
    conception** (threader un DM avait rendu le bot silencieux), donc la clé est le canal `D…` ;
    en canal l'appelant passe `thread_ts ?? ts`, donc un thread est une conversation.
  - `domain/services/token-window.ts` — `selectWindow(turns, budgetTokens)` : fenêtrage **en
    tokens, jamais en messages**. Parcours du plus récent au plus ancien, rendu chronologique.
    Une **paire `user`/`assistant` n'est jamais coupée** (un assistant orphelin répondrait à une
    question invisible pour le modèle — pire que pas de mémoire). Un tour dépassant **40 % du
    budget est tronqué**, pas exclu, sinon un message géant avale la fenêtre. Constantes
    `CHARS_PER_TOKEN = 3.5` (calibré : en-tête de sécurité 1308 car. ≈ 374 tok mesurés en prod)
    et `CONVERSATION_TOKEN_BUDGET = 1000` (1253 réellement disponibles à K=3 sur
    `onboardingOrchestrator`, 20 % de marge pour l'incertitude ±10 % du ratio).
  - `domain/ports/conversation.repository.ts` — `append` / `recentTurns` / `prune`, plus
    `CONVERSATION_TTL_MS = 60 min`, **TTL unique** gouvernant mémoire ET routage collant (D1).
  - `infrastructure/repositories/` — implémentation Drizzle et doublure `in-memory`.
- **Table `conversation_turns`** dans `src/infrastructure/database/schema.ts`, index
  `(conversation_id, created_at)`. L'agent « collant » est l'`agent_id` du dernier tour : la
  requête de fenêtre le ramène déjà, pas de seconde table.
  - Écart assumé au style des 10 autres tables : `created_at` est un **INTEGER en millisecondes**
    (`mode: 'timestamp_ms'`) et non le `TEXT` `datetime('now')` habituel, dont la résolution à la
    seconde mettrait à égalité deux messages d'un même échange et rendrait l'ordre chronologique
    indéterminé — or c'est cet ordre dont dépend `selectWindow`.
  - DDL à appliquer **à la main** : `scripts/ddl-conversation-turns.sql`. Ni `npm run db:push`
    (se bloque indéfiniment contre une base `libsql://` distante) ni `npm run db:generate` (les
    migrations `drizzle/` sont désynchronisées de `schema.ts` et drizzle-kit exige un vrai TTY).

## [Unreleased] - 2026-08-08
### Changed (perf — coût en tokens d'entrée)
- **Réduction du coût en tokens système/tools des 3 agents**, `notificationAgent` en priorité :
  mesuré en production à 7 849 tokens d'entrée pour un message trivial (« ok »), au-dessus du
  plafond Groq (12 000 tokens/minute) dès qu'un flux fait plusieurs allers-retours d'outils.
  Méthode de mesure : `zodToJsonSchema` de `@mastra/schema-compat` (la même fonction utilisée en
  interne par Mastra) appliquée à chaque `inputSchema`, plus `agent.getInstructions()` pour la
  valeur réelle des instructions envoyées au LLM ; taille sérialisée en caractères, avec un ratio
  caractères/token calibré sur la seule donnée officielle disponible (en-tête de sécurité :
  1308 caractères ≈ 374 tokens ⇒ ~3,5 car./tok). C'est une **estimation assumée**, pas une mesure
  exacte de tokenizer Llama/Groq (indisponible en local, pas d'accès réseau pour en installer un).
  - **`notificationAgent` ne reçoit plus `discoverSlackWorkspace`** (`src/mastra/index.ts`) :
    le tool le plus coûteux du set (356 car. de schéma + 426 car. de description) n'était
    mentionné nulle part dans les instructions de l'agent et n'a aucun usage identifié —
    `sendNotification` résout déjà le compte Slack du destinataire côté serveur, sans que le LLM
    ait besoin d'appeler `discoverSlackWorkspace` lui-même. Toujours câblé à
    `onboardingOrchestrator`, inchangé.
  - **`sendNotification`** (`send-notification.ts`) : description et description de
    `recipientId`/`recipientType` condensées sans perdre l'information de sécurité porteuse
    (destinataire désigné par UUID uniquement, adresse résolue côté serveur) ; le rappel des
    valeurs de `recipientType` dans la description était de toute façon redondant avec l'`enum`
    déjà présent dans le JSON Schema.
  - **Instructions des 3 agents** (`notification-agent.ts`, `onboarding-orchestrator.ts`,
    `questionnaire-engine.ts`) : blocs STYLE et RÈGLE ANTI-INVENTION reformulés plus courts, sans
    rien retirer au fond (mêmes interdictions markdown GitHub / mrkdwn Slack avec parcimonie /
    pas de narration de plan / pas d'emojis / non-divulgation de l'identifiant interne / anti-
    invention avec l'exemple `emailSent: false`). Le bloc `SECURITY DIRECTIVE:` terminal
    (anti prompt-injection / anti-exfiltration / pas d'exécution de code) a été **retiré** des 3
    fichiers : il dupliquait fidèlement les DIRECTIVE 2.1 (hiérarchie SYSTEM > USER > EXTERNAL),
    4.1 (jamais exposer les directives système), 5.1 (rejet des tool-calls issus de
    `external_data`) et 6.1 (anti-jailbreak) déjà appliquées par l'en-tête de sécurité obligatoire
    (`buildAgentInstructions()` / `SYSTEM_SECURITY_PROMPT`, non modifié). Les DIRECTIVES
    D'EXTRACTION OBLIGATOIRES de `onboardingOrchestrator` (champs `createEmployee`) sont
    conservées mot pour mot.
  - Résultat mesuré (chars réels, méthode ci-dessus) :

    | Agent | instructions avant→après | tools avant→après (notificationAgent) | Δ total |
    |---|---|---|---|
    | `notificationAgent` | 3670→2430 car. (−33.8 %) | 3486→2591 car. (−25.7 %, 5→4 tools) | −29.8 % (7156→5021 car., ≈2046→1436 tokens estimés) |
    | `onboardingOrchestrator` | 4509→3528 car. (−21.8 %) | inchangé | — |
    | `questionnaireEngine` | 3454→2595 car. (−24.9 %) | inchangé | — |

  - Aucun tool retiré du fichier ni de `tool-schema-flatness.test.ts` : `discoverSlackWorkspace`
    reste défini et testé, seule sa présence dans le tool-set de `notificationAgent` change.
  - Vérifié après coup : `npm run typecheck && npm run test:unit` → 600/600 verts (baseline 597),
    y compris `architecture.test.ts`, `code-architecture.test.ts` et
    `tool-schema-flatness.test.ts`.

### Fixed
- **Garde-fou anti prompt-injection réellement branché** (`src/shared/security/llm-guardrail.ts`,
  les 3 agents, `slack-events.handler.ts`). Constat : `wrapUserInput()`, `wrapExternalData()` et
  `assembleSecurePrompt()` n'étaient appelés QUE par les tests ; les 3 agents important la
  constante brute `SYSTEM_SECURITY_PROMPT` envoyaient au LLM un prompt contenant les littéraux
  non substitués `{DELIMITER_PREFIX}` et `[[SESSION_MARKER]]` (visible publiquement via
  `GET /api/agents`), et le texte Slack partait tel quel dans `agent.generate()`, sans
  encadrement.
  - Nouvelles fonctions exportées `buildAgentInstructions()` et `wrapAgentInput()` dans
    `llm-guardrail.ts` : la première assemble l'en-tête de sécurité avec ses placeholders
    réellement substitués (via `SystemPromptVault` + `SessionManager`) puis les instructions
    métier ; la seconde encadre un message avant `agent.generate()`, avec le MÊME
    sessionId/SessionManager que la première (cohérence du `tagPrefix` annoncé dans les
    DIRECTIVE 3.1/3.2).
  - Marqueur de session tiré aléatoirement **une fois par processus** au démarrage : les
    `instructions` d'un `Agent` Mastra sont figées à la construction, donc un marqueur par
    requête n'est pas possible sans reconstruire l'agent à chaque message (voir commentaire
    de section 11 dans `llm-guardrail.ts` pour la justification complète et le compromis
    assumé).
  - `slack-events.handler.ts` passe désormais le texte Slack par `wrapAgentInput()` avant
    `agent.generate()`.
  - Bug latent corrigé au passage : `KeyManager.KEY_ITERATIONS = 100000` n'est pas une
    puissance de 2 — `scryptSync` l'exige et aurait levé `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`
    dès qu'un `KeyManager` réel (masterSecret, pas injecté) était instancié. Masqué jusqu'ici
    car rien n'instanciait `KeyManager` en dehors des tests (qui injectent leur propre
    `keyManager`). Corrigé à `16384` (2^14, minimum RFC 7914 pour un usage interactif).
- **Réponses Slack en DM ne sont plus enfouies dans un thread** (`slack-events.handler.ts`,
  `handleMessage`). `thread_ts = thread_ts ?? ts` threadait systématiquement, y compris en DM
  où ça masque la réponse hors de la conversation principale — le bot a semblé silencieux
  pendant des heures en production pour cette raison. Un DM ne threade désormais QUE si le
  message d'origine faisait déjà partie d'un thread (`thread_ts` présent et différent de `ts`).
  Les mentions en canal continuent de threader systématiquement (comportement inchangé).
- **Diagnostic de la bascule Groq → Mistral clarifié** (`src/shared/llm/model-fallback.ts`).
  Symptôme en production : `POST /api/agents/:id/generate` → `HTTP 500
  {"error":"Rate limit exceeded"}`. Vérifié empiriquement (agent réel, clé Groq invalide puis
  les deux clés invalides — script jetable, non versionné) : **la bascule fonctionne bien** ;
  ce n'était pas un bug de la chaîne elle-même. Le vrai problème était l'observabilité : Mastra
  émet deux logs `Upstream LLM API error` distincts, et celui de fin de run
  (`agent-Dj30gJa3.js:29829-29842`) lit `provider`/`modelId` via `capabilities.llm.getModel()`,
  qui retourne inconditionnellement le PREMIER modèle de la chaîne (`#firstModel`,
  `agent-Dj30gJa3.js:26004-26010`) — jamais celui qui a réellement produit l'erreur. Il peut
  donc attribuer l'échec du DERNIER maillon (ex. Mistral) au PREMIER (Groq) — reproduit dans
  `tests/unit/shared/model-fallback-chain-logging.test.ts` :
  `{ error: <échec mistral.chat>, provider: 'groq.chat', modelId: 'llama-3.3-70b-versatile' }`.
  C'est ce qui a fait perdre du temps en diagnostic : impossible de savoir, à la seule lecture du
  log, quel fournisseur avait réellement échoué.
  - Nouvelle fonction exportée `withChainFailureLogging()` : enveloppe chaque modèle de la
    chaîne (`Proxy` sur `doGenerate`/`doStream`) pour journaliser, via `src/shared/logger`
    (JSON structuré, PII masquée, respecte `LOG_LEVEL`), le `chainId`/`provider`/`modelId`
    **du maillon qui vient réellement d'échouer**, puis relance l'erreur inchangée — aucun
    changement de comportement pour Mastra, uniquement une observation fiable en plus,
    indépendante de la configuration du `logger` passé (ou non) à `new Agent()`.
  - La politique `maxRetries` existante (0 sur les maillons non terminaux, 1 sur le dernier) a
    été relue à la lumière du comportement réel de Mastra 1.57.0 (`executeStreamWithFallbackModels`,
    `agent-Dj30gJa3.js:23206` ; `shouldThrowError: !isLastModel`, `agent-Dj30gJa3.js:23578` ;
    `retries: modelSettings?.maxRetries ?? 2`, `agent-Dj30gJa3.js:22123`) : elle était déjà
    correcte, aucun changement de valeur.
  - Limites qui subsistent, documentées dans l'en-tête du fichier : si Mistral échoue aussi
    (429/5xx), l'erreur brute de Mistral remonte quand même au client (juste journalisée
    correctement désormais) — il n'y a pas de 3ᵉ maillon. Le basculement n'est jamais filtré par
    classe d'erreur : une erreur `context_length_exceeded` déclenche aussi l'essai de Mistral,
    utile seulement si sa fenêtre de contexte est plus grande.

### Changed
- **Style des réponses des 3 agents** (`onboarding-orchestrator.ts`, `questionnaire-engine.ts`,
  `notification-agent.ts`) : instructions métier réécrites pour imposer un français direct et
  concis, l'interdiction du markdown GitHub (`**gras**`, `###`, `---` — non rendu par Slack,
  affiché littéralement), le mrkdwn Slack avec parcimonie, l'absence de narration du plan
  interne ("Étape 1...", "Prochaines étapes"), et la non-divulgation de l'identifiant interne
  (« KISSO-AGENT-v3 », visible dans le bloc sécurité) à l'utilisateur. Les directives
  fonctionnelles (extraction obligatoire des champs `createEmployee`, etc.) et le bloc sécurité
  sont conservés intégralement.
  - Nouvelle règle explicite anti-invention : interdiction d'affirmer qu'une action a réussi
    sans confirmation du résultat du tool (notamment `emailSent: false` avec `status: 'success'`
    global — piège documenté dans `CLAUDE.md`), et interdiction d'inventer une donnée absente
    (nom, email, identifiant) — la demander à l'utilisateur à la place.

### Added
- **Tool `findEmployeeByEmail`** (`src/features/employee/application/tools/find-employee-by-email.ts`) :
  résout un employé à partir de son email professionnel. Corrige un trou fonctionnel observé en
  production — trace réelle : « Récupère les informations concernant Karyl SOUMAILA » → l'agent
  `onboardingOrchestrator` n'avait aucun tool pour passer d'un nom/email à un ID d'employé, se
  rabattait sur l'annuaire Slack, obtenait un ID Slack (pas un UUID), échouait à nouveau, et
  finissait par redemander manuellement département/poste/date de début à l'utilisateur. Aucun
  outil de résolution par email n'existait alors que `EmployeeRepository.findByEmail()` (port +
  implémentations Drizzle/in-memory) existait déjà et était simplement inutilisé par les tools.
  - Recherche insensible à la casse et robuste aux espaces parasites (normalisation
    trim + lowercase, en plus de `emailSchema` qui le fait déjà côté schéma).
  - Retourne `{ found: false }` — jamais une exception — quand l'email est inconnu :
    c'est précisément l'absence de ce comportement qui faisait dérailler l'agent
    (boucle d'erreurs `NotFoundError` → abandon → re-question à l'utilisateur).
  - Exposition volontairement minimale (audit sécurité : tout membre du workspace peut
    déclencher les tools) : uniquement `id`, `firstName`, `lastName`, `status`. Ni email,
    ni salaire, ni contact d'urgence, ni téléphone, ni métadonnées — voir commentaire du
    fichier. Le détail complet reste derrière `getEmployeeProfile(employeeId)`.
  - Câblé dans `src/mastra/index.ts` uniquement, dans la liste de tools de
    `onboardingOrchestrator` (le déclenchement observé en prod passait par cet agent, route
    par défaut de `slack-events.handler.ts`). Couvert par
    `tests/unit/tools/find-employee-by-email.test.ts` (TDD) et ajouté à
    `tests/unit/tools/tool-schema-flatness.test.ts`.

## [0.9.0] - 2026-08-07
### Added
- **Endpoint Slack Events monté** : `POST /slack/events`, déclaré dans `server.apiRoutes` de
  `src/mastra/index.ts` via `registerApiRoute()`. Jusqu'ici `src/api/slack-events*.ts` était du
  **code mort** — Mastra ne monte pas `src/api/` automatiquement et `index.ts` n'avait aucun bloc
  `server` : `POST /api/slack-events` répondait 404, ce qui explique le bot silencieux.
- **Vérification de signature Slack** (`src/shared/security/slack-signature.ts`) : HMAC-SHA256 sur
  `v0:{timestamp}:{rawBody}`, comparaison à temps constant (`timingSafeEqual`), fenêtre anti-rejeu
  de 5 minutes, **fail-closed** si `SLACK_SIGNING_SECRET` est absent. Vérifié en live :
  `url_verification` signé → `200 {"challenge":…}` en 2,4 s ; non signé → `401 missing_signature_headers`.
- **ACK Slack sous 3 s** : réponse immédiate, traitement de l'agent déporté en tâche de fond.
- **Déduplication des rejeux** Slack sur `event_id` (cache LRU en mémoire).
- **`SmtpAdapter`** (`nodemailer`) et sélecteur `createEmailProvider()` : SMTP dès que
  `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` sont tous renseignés, sinon repli Brevo.
- **ADR-006** — `docs/adr/006-fournisseur-email-smtp.md` : justification du passage à SMTP.

### Changed
- **Fournisseur email : Brevo → SMTP (Gmail).** `BREVO_API_KEY` est valide (`GET /v3/account` → 200)
  mais `POST /v3/smtp/email` renvoie `403 permission_denied` — *"Your SMTP account is not yet
  activated"* : blocage au niveau **compte**, reproduit même avec l'expéditeur validé, donc
  incontournable par configuration. Un email réel a été délivré via SMTP (`250 OK`).
- **Base Turso de production** : elle ne contenait **aucune** table applicative (uniquement 38 tables
  internes `mastra_*`), le bot déployé ne pouvait rien persister. `drizzle-kit push` se bloquant
  contre un `libsql://` distant, le DDL a été exporté depuis `schema.ts` et appliqué directement —
  **10 tables, 69 index, `employees` avec ses 20 colonnes**.
- `docs/SLACK_BOT_SETUP.md` : variables d'environnement réelles (SMTP au lieu de `RESEND_API_KEY`),
  et section dépannage étendue (freeze serverless, 401 de signature, double réponse, dédup).

### Fixed
- **Fuite de secret dans les logs** : `console.log('DEBUG ENV', { brevo: process.env.BREVO_API_KEY })`
  dans `src/mastra/index.ts` imprimait une clé API vivante. Remplacé par `hasBrevoKey: Boolean(…)`.
- **Configuration de l'app Slack** (côté Slack, pas côté code) : Socket Mode était activé — il est
  mutuellement exclusif avec la Request URL HTTP, Slack n'envoyait donc **aucune** requête — et
  `app_mention` n'était pas abonné, alors que le handler ne sert les mentions en canal que par cet
  événement. Request URL désormais « Verified ».
- **Faux positif de routage mot-clé** : `routeToAgent()` matchait `test` par sous-chaîne
  (`String.includes`), donc capturé par n'importe quel mot français contenant "test" ailleurs
  qu'en début de mot — "je conteste cette décision", "peux-tu attester de mon poste",
  "contestation", "protestation" partaient à tort vers `questionnaireEngine` au lieu du routage
  par défaut. Le matching exclut désormais un mot-clé immédiatement précédé d'une lettre
  (regex `(?<![\p{L}])`), sans toucher aux mots-clés eux-mêmes ni aux suffixes (pluriels,
  conjugaisons continuent de matcher). 6 tests ajoutés dans
  `tests/unit/handlers/slack-events.handler.test.ts`.

### Known issues
- `drizzle/0000_*.sql` déclare `employees` avec 11 colonnes contre 20 dans `schema.ts` : l'historique
  de migration n'est pas rejouable sur une base vierge. `npm run db:generate` est interactif et doit
  être relancé dans un vrai TTY.
- Traitement en tâche de fond **non testé en serverless** : Vercel peut geler la fonction dès l'ACK et
  tuer l'appel LLM en vol (symptôme « le bot ACK mais ne répond jamais »). Correctif durable : file
  durable (`inngest` déjà installé).
- La dédup LRU est **par instance** : elle ne protège pas d'un traitement double entre instances.
- Envoyer au nom de « Kisso » depuis une adresse `@gmail.com` dégrade la délivrabilité ; un domaine
  vérifié (SPF/DKIM/DMARC) reste le correctif propre.

## [0.1.3] - 2026-08-05
### Changed
- Migration de `better-sqlite3` vers `@libsql/client` (Turso).
- Architecture de déploiement orientée Serverless avec l'ajout de `@mastra/deployer-vercel`.
- Mise à jour de toutes les dépendances `@mastra/*` en version `1.56.0` (latest).
- Suppression du `Dockerfile` et de la configuration Fly.io.

## [0.8.0] - 2026-08-03
### Added
- **Slack Workspace Discovery** : port `SlackWorkspaceProvider`, `SlackWorkspaceService`, tool `discoverSlackWorkspace` (channels, members, invite).
- **PDF Generation** : `PdfmakeService` (pdfmake 0.3) avec templates contrat, lettre de bienvenue, certificat et guide.
- **Employee Onboarding** : étape Slack best-effort (find by email + invite channel) câblée au workflow.
- **Tests** : couverture unitaire tool/service Slack, PdfmakeService (4 templates), workflows `employee-onboarding` et `document-generation`.

### Fixed
- **PdfmakeService** : adaptation API pdfmake 0.3 (`createPdf` + VFS Roboto) — l’ancienne API `PdfPrinter` était incompatible.
- **document-generation** : sortie `documentPath` (chemin local) au lieu de `documentUrl` (URL invalide pour un fichier local).
- **createEmployee tests** : alignement sur le comportement réel (`ConflictError` thrown, validation UUID idempotency).

## [0.7.0] - 2026-07-31
### Fixed
- **TypeError in `validation.ts`**: Fixed `createEmployeeSchema.extend is not a function` (and identical bugs in `createTaskSchema`, `createNotificationSchema`, `createQuestionnaireSchema`). Root cause: `.refine()` wraps `z.object` in a `ZodEffects` which has no `.extend()` method. Fix: extract bare `z.object` bases as non-exported consts (`createEmployeeBaseSchema`, `createTaskBaseSchema`, `createNotificationBaseSchema`, `createQuestionnaireBaseSchema`); use `.extend()`/`.partial().extend()` on the bases, keep `.refine()`-wrapped versions as exports.

## [0.6.0] - 2026-07-30
### Added
- **Stratégie de Test & Tests de Sécurité** : Création de la liste de 500 tests (Test Strategy).
- **Implémentation de la Suite 1 (Sécurité)** : Tests unitaires de `llm-guardrail.ts` avec succès (15 tests contre Prompt Injection, Fuite de données, Token Flooding). Correction de la regex d'extraction des secrets.
- **Planification des bonnes pratiques** : Consolidation des décisions architecturales suite à l'analyse des agents.
- **Sécurité & Qualité** : Plan d'implémentation ajouté au `TODO.md` (RBAC, AuditLogs, ESLint, Prettier, CI/CD).

## [0.1.0] - 2026-07-28
- Architecture validée : 3 agents (OnboardingOrchestrator, QuestionnaireEngine, NotificationAgent), 8+ outils, 4 workflows.
- Planification complète du développement avec 8 tâches priorisées.

## [0.5.0] - 2026-07-29
### Added
- **Base de Données (Phase 8)** : Implémentation complète de Drizzle ORM avec `better-sqlite3`.
- **Infrastructure (Repositories)** : Remplacement de tous les mock repositories (InMemory) par des implémentations Drizzle ORM pour (`employee`, `task`, `document`, `notification`, `questionnaire`, `response`, `onboarding`).
- **Clean Architecture** : Respect strict du principe d'inversion des dépendances (les repositories `drizzle` implémentent les ports du domaine sans polluer les entités).
- **Scripts** : Ajout de `db:generate` et `db:push` dans le `package.json` pour la gestion des migrations avec Drizzle Kit.

## [0.4.0] - 2026-07-29
### Added
- **LLM Security Gateway** : Mise en place d'une architecture de défense de classe mondiale contre 30 vecteurs d'attaques LLM (OWASP, Injection directe/indirecte, Exfiltration, RAG Poisoning).
- **Guardrails** : Création de `prompt-defense.ts` et `llm-guardrail.ts` pour filtrer les entrées et sorties (Egress Filtering) et empêcher l'évasion des modèles (Token Flooding, Jailbreak).
- **Blindage des Agents** : Intégration du `SYSTEM_SECURITY_PROMPT` bloquant toute tentative de "Persona Override" et "Goal Hijacking".

## [0.3.1] - 2026-07-29
### Added
- Sécurisation des LLM : Ajout de directives Anti-Prompt Injection dans les agents Mastra.
- Amélioration de la qualité de code : Remplacement des erreurs génériques par `ValidationError` et `ConflictError`.
- TypeScript strict : Remplacement des derniers types `any` par `unknown`.
- Versioning initial : Dépôt local Git initialisé et commit des phases de Clean Architecture et de Sécurité.

## [0.3.0] - 2026-07-29
### Added
- Refonte complète de l'architecture selon les principes de Clean Architecture (Screaming Architecture / Bounded Contexts).
- Purification du domaine : retrait total de Zod des entités, création du Value Object `Email`, classes immuables avec `readonly`.
- Interfaces et Adaptateurs : `EmailProvider` (implémenté via `ResendAdapter`) et `ChatProvider` (implémenté via `SlackAdapter`).
- Logs JSON structurés avec obfuscation automatique des PII (ex: adresses e-mail masquées).

## [0.2.0] - 2026-07-29
### Added
- Implémentation des 4 workflows Mastra (`employeeOnboardingWorkflow`, `questionnaireCycleWorkflow`, `notificationCycleWorkflow`, `documentGenerationWorkflow`) en conformité avec l'API v1.53.0 (méthodes `createStep` et `.then()`).
- Définition stricte des schémas d'entrée/sortie (`inputSchema`, `outputSchema`) avec Zod pour les workflows.
- Export et enregistrement des workflows dans l'instance centrale Mastra.
- 3 agents Mastra (`OnboardingOrchestrator`, `QuestionnaireEngine`, `NotificationAgent`) configurés avec leurs outils respectifs.
- 10 outils Mastra fonctionnels avec signatures compatibles `@mastra/core` v1.53.0.
- Intégration API Resend pour l'envoi d'e-mails réels.
- Intégration Slack Web API pour l'envoi de messages Slack.
- Installation d'Inngest pour la planification de tâches asynchrones.
- Typecheck complet : 0 erreur TypeScript.

### Changed
- `send-notification.ts` : logique réelle multi-canal (Email via Resend, Slack via `@slack/web-api`, InApp en base).
- `.env.example` nettoyé (SMTP retiré, Resend/Inngest ajoutés, clés API retirées).
- `src/config/index.ts` : remplacé SMTP par Resend.
- `src/mastra/index.ts` : stubbé en attendant les étapes 6-7.

## [0.1.2] - 2026-07-29
### Added
- Composants partagés (types et interfaces métier).
- Validation de données via Zod (employé, questionnaire, notification, tâches).
- Gestion centralisée des variables d'environnement.
- Documentation d'architecture (`docs/guides/onboarding.md`).

## [0.1.1] - 2026-07-29
### Ajouté
- Structure des dossiers (Clean Architecture) initialisée dans `src/`, `docs/`, `tests/`.
- Installation des dépendances IA : `@ai-sdk/openai`, `@ai-sdk/google`.
- Rédaction des ADRs initiaux (001 à 005) dans `docs/adr/`.
- Fichier `.env` initialisé à partir de `.env.example`.

### Modifié
- Configuration `tsconfig.json` mise à jour pour éviter le warning de dépréciation de `baseUrl`.
- **Note** : La vérification TypeScript (`npm run typecheck`) échoue actuellement en raison d'un changement de signature de l'API `@mastra/core` (version 1.53.0) dans les outils existants. Les corrections seront apportées lors de l'étape 5 (Développer les outils Mastra).
