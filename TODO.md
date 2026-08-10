# TODO.md — Kisso Onboarding

## [1] Créer les fichiers de règles projet
- [x] GEMINI.md
- [x] AGENT.md
- [x] ANTIGRAVITY.md
- [x] CONTEXT.md
- [x] TODO.md
- [x] CHANGELOG.md
- [x] CLAUDE.md

## [2] Initialiser la structure de dossiers et dépendances
- [x] Créer les dossiers src/ (agents, tools, workflows, domain, application, infrastructure, config, prompts, shared)
- [x] Créer les dossiers docs/ (adr, guides) et tests/ (unit, integration, e2e)
- [x] Installer les dépendances npm (@mastra/core, @ai-sdk/openai, @ai-sdk/google, drizzle-orm, better-sqlite3, zod, vitest)
- [x] Mettre à jour .env.example avec les variables requises
- [x] Vérifier que tsc et vitest fonctionnent

## [3] Rédiger les ADR initiaux
- [x] ADR-001 : Architecture et Stack Technique
- [x] ADR-002 : Structure Agents Mastra
- [x] ADR-003 : Modèle de Données
- [x] ADR-004 : Stratégie de Notifications
- [x] ADR-005 : Workflows et Orchestration

## [4] Développer les composants partagés
- [x] Types et interfaces (employé, questionnaire, notification, document)
- [x] Configuration centralisée (env, constantes)
- [x] Validation Zod (schémas employé, questionnaire, notification)
- [x] Helpers et utilitaires

## [5] Développer les outils Mastra (10)
- [x] createEmployee, getEmployeeProfile, findEmployeeByEmail
- [x] updateOnboardingStatus, getTaskList
- [x] generateQuestionnaire, evaluateResponse
- [x] generateDocument
- [x] sendNotification (email + Slack API), scheduleReminder, getNotificationHistory
      — le provider email est passé de Resend → Brevo → SMTP, voir [12] et ADR-006

## [6] Développer les agents Mastra (3)
- [x] OnboardingOrchestrator
- [x] QuestionnaireEngine
- [x] NotificationAgent

### Étape 7 : Développement des Workflows Mastra (Machine à états) - [x]
- [x] Concevoir le flux principal (EmployeeOnboarding).
- [x] Concevoir le flux secondaire (QuestionnaireCycle).
- [x] Concevoir le flux tertiaire (NotificationCycle).
- [x] Concevoir le flux de clôture (DocumentGeneration).

## [7.5] Refonte Architecturale Enterprise (Clean Architecture) - [x]
- [x] Phase 1 : Réorganisation par Feature (Screaming Architecture)
- [x] Phase 2 : Purification du Domaine
- [x] Phase 3 : Inversion de Dépendances (Providers)
- [x] Phase 4 : Observabilité (Logs JSON & obfuscation)

## [7.6] LLM Security Gateway & Standards Mondiaux - [x]

- [x] Implémentation du `prompt-defense.ts` et `llm-guardrail.ts` contre les attaques (Direct Prompt Injection, RAG Poisoning, Exfiltration, etc.)
- [x] Blindage des 3 agents Mastra (`SYSTEM_SECURITY_PROMPT`)
- [x] Egress Filtering & Validation des entrées LLM
- [x] Versioning Git et validation TypeScript stricte

## [8] Initialisation et Configuration de la Base de Données (SQLite) - [x]
- [x] Création du schéma Drizzle (`schema.ts`)
- [x] Implémentation des Repositories (`drizzle-xxx.repository.ts`)
- [x] Connexion SQLite `better-sqlite3` (`connection.ts`)
- [x] Injection de dépendances mise à jour dans `index.ts`
- [x] Vérification typecheck et build

## [9] Sécurité, Qualité & CI/CD (Bonnes Pratiques)
- [ ] Configurer les outils de qualité de code (ESLint, Prettier, Husky, lint-staged)
- [ ] Créer le workflow GitHub Actions pour la CI/CD (`.github/workflows/ci.yml`)
- [ ] Mettre à jour le schéma de base de données pour inclure la table `AuditLogs`
- [ ] Ajouter le statut `PENDING_APPROVAL` pour les notifications sensibles et validations RH
- [ ] Rédiger les tests E2E avec Chaos Testing pour la sécurité LLM

## [10] Bug Fixes & Maintenance
- [x] Fix TypeError: `.extend()` on ZodEffects in `validation.ts` — extract bare `z.object` bases from `.refine()`-wrapped schemas

## [11] Slack Workspace Discovery & PDF Generation
- [x] Port `SlackWorkspaceProvider` + `SlackWorkspaceService` (@slack/web-api)
- [x] Tool `discoverSlackWorkspace` (listChannels, listMembers, findUserByEmail, inviteToChannel, getChannelMembers)
- [x] Injection agents + workflow `employee-onboarding` (invitation Slack best-effort)
- [x] `PdfmakeService` (pdfmake 0.3) — templates contrat / welcome_letter / certificate / guide
- [x] Wiring `document-generation` + remplacement stub dans `mastra/index.ts`
- [x] Tests unitaires : tool Slack, service Slack, PdfmakeService, workflows onboarding & documents

## [12] Mise en production — Slack, base Turso, email

### Fait
- [x] **Endpoint Slack monté.** Cause racine du bot muet : `src/api/slack-events*.ts` était du
      **code mort**. Mastra ne monte pas `src/api/` automatiquement — une route n'existe que
      déclarée dans `server.apiRoutes` via `registerApiRoute()`, et `src/mastra/index.ts`
      n'avait aucun bloc `server`. Résultat : `POST /api/slack-events` → 404.
- [x] **Endpoint déplacé sur `POST /slack/events`.** Le préfixe `/api` est **réservé** :
      `@mastra/server` refuse toute route personnalisée qui commence par l'`apiPrefix`, et
      c'est un **échec au démarrage**, pas un 404.
- [x] **Vérification de signature Slack** (`src/shared/security/slack-signature.ts`) :
      HMAC-SHA256 sur `v0:{timestamp}:{rawBody}`, comparaison `timingSafeEqual`, fenêtre
      anti-rejeu de 5 min, **fail-closed** si `SLACK_SIGNING_SECRET` est absent.
      Vérifié en live : `url_verification` signé → `200 {"challenge":…}` en 2,4 s ;
      non signé → `401 missing_signature_headers`.
- [x] **ACK sous 3 s** + traitement de l'agent en tâche de fond.
- [x] **Déduplication** des rejeux sur `event_id` (cache LRU).
- [x] **Configuration de l'app Slack corrigée** : Socket Mode désactivé (il est mutuellement
      exclusif avec la Request URL HTTP — tant qu'il est actif Slack n'envoie **rien**) et
      `app_mention` abonné (le handler ne sert les mentions en canal que par `app_mention`).
      Request URL « Verified ».
- [x] **Fuite de secret supprimée** : `console.log('DEBUG ENV', { brevo: process.env.BREVO_API_KEY })`
      dans `src/mastra/index.ts` imprimait une clé API vivante dans les logs. Remplacé par
      `hasBrevoKey: Boolean(…)`.
- [x] **Schéma appliqué sur la Turso de production.** Elle ne contenait **aucune** table
      applicative (seulement 38 tables internes `mastra_*`) : le bot déployé ne pouvait rien
      persister. `drizzle-kit push` **se bloque** contre un `libsql://` distant
      (`dialect: 'sqlite'`) ; contourné en exportant le DDL depuis `schema.ts` et en appliquant
      les 69 statements directement → **10 tables, 69 index, `employees` avec ses 20 colonnes**.
- [x] **Fournisseur email migré Brevo → SMTP (Gmail / nodemailer)** — `SmtpAdapter` +
      `createEmailProvider()` dans `src/mastra/index.ts`. Email réel délivré (`250 OK`).
      Voir `docs/adr/006-fournisseur-email-smtp.md`.
- [x] **Faux positif de routage mot-clé corrigé.** `routeToAgent()`
      (`src/features/notification/infrastructure/handlers/slack-events.handler.ts`) matchait
      `test` par sous-chaîne (`String.includes`) : "je conteste cette décision", "peux-tu
      attester de mon poste", "contestation", "protestation" partaient à tort vers
      `questionnaireEngine`. Le matching garde désormais un mot-clé uniquement s'il n'est pas
      immédiatement précédé d'une lettre (regex `(?<![\p{L}])`) — les suffixes (pluriels,
      conjugaisons : "questionnaires", "testé") continuent de matcher comme avant, seul
      l'embarquement en préfixe est exclu. Mots-clés eux-mêmes inchangés (toujours
      `questionnaire|évaluation|quiz|test` et `notification|rappel|email|message`, voir
      CLAUDE.md). TDD : test rouge ajouté dans `tests/unit/handlers/slack-events.handler.test.ts`
      avant le correctif.
- [x] **Trou fonctionnel corrigé : résolution employé par email.** Trace de production :
      « Récupère les informations concernant Karyl SOUMAILA » → l'agent n'avait aucun moyen de
      passer d'un nom/email à un ID d'employé, tentait l'annuaire Slack (ID Slack ≠ UUID),
      échouait deux fois, abandonnait et redemandait manuellement département/poste/date de
      début. Ajout du tool `findEmployeeByEmail`
      (`src/features/employee/application/tools/find-employee-by-email.ts`), câblé sur
      `onboardingOrchestrator` dans `src/mastra/index.ts`. Réutilise
      `EmployeeRepository.findByEmail()` (déjà présent, inutilisé par les tools). Renvoie
      `{ found: false }` — jamais d'exception — sur email inconnu ; expose uniquement
      `id`/`firstName`/`lastName`/`status` (audit sécurité : tout membre du workspace peut
      déclencher les tools). Voir CHANGELOG [Unreleased].
      - [x] `onboardingOrchestrator` mentionne désormais explicitement `findEmployeeByEmail`
        dans ses instructions métier (fait en même temps que la réécriture de style
        ci-dessous).
- [x] **Garde-fou anti prompt-injection réellement branché.** Les 3 agents n'importaient que
      la constante brute `SYSTEM_SECURITY_PROMPT` : `wrapUserInput()`, `wrapExternalData()` et
      `assembleSecurePrompt()` n'étaient appelés que par les tests, le prompt système réel
      contenait les littéraux non substitués `{DELIMITER_PREFIX}` / `[[SESSION_MARKER]]`
      (visible via `GET /api/agents`), et le texte Slack partait dans `agent.generate()` sans
      encadrement. Nouvelles fonctions `buildAgentInstructions()` / `wrapAgentInput()` dans
      `llm-guardrail.ts` (marqueur de session tiré une fois par processus — les `instructions`
      d'un `Agent` Mastra sont figées à la construction). Bug latent corrigé au passage :
      `KeyManager.KEY_ITERATIONS = 100000` n'est pas une puissance de 2, `scryptSync` l'exige
      (`ERR_CRYPTO_INVALID_SCRYPT_PARAMS` à la première instanciation réelle) — passé à `16384`.
      Voir CHANGELOG [Unreleased].
- [x] **Style « IA » retiré des réponses des 3 agents.** Constaté en prod : markdown GitHub non
      rendu par Slack (`**gras**`, `###`, `---`), ton robotique (narration du plan, sections
      "Prochaines étapes"), et l'identifiant interne « KISSO-AGENT-v3 » exposé à l'utilisateur.
      Instructions métier réécrites (mrkdwn Slack avec parcimonie, pas de narration du plan,
      identité interne non divulguée) ; directives fonctionnelles et bloc sécurité inchangés.
      Voir CHANGELOG [Unreleased].
- [x] **Interdiction d'affirmer un succès non vérifié / d'inventer une donnée.** Trace de prod :
      « Bienvenue chez Kisso, **John** ! Votre profil a été créé avec succès » — prénom inventé,
      création non confirmée. Aggravé par l'échec d'email **silencieux**
      (`emailSent: false` mais `status: 'success'`, voir CLAUDE.md). Règle ajoutée aux 3 agents :
      ne jamais affirmer un succès sans confirmation explicite du résultat du tool, ne jamais
      inventer une donnée absente — la demander à l'utilisateur. Ne corrige pas le silence de
      l'échec d'email lui-même (reste dans « À faire » ci-dessous, hors périmètre de ce
      correctif de prompt).
- [x] **DM ne threade plus systématiquement.** `thread_ts = thread_ts ?? ts` enfouissait la
      réponse hors de la conversation principale en DM — le bot a semblé silencieux pendant des
      heures en prod. Un DM ne threade désormais que si le message d'origine appartenait déjà à
      un thread ; les mentions en canal threadent comme avant.
- [x] **Bascule Groq → Mistral vérifiée empiriquement — elle fonctionnait déjà.** Symptôme prod :
      `HTTP 500 {"error":"Rate limit exceeded"}`. Testé avec un agent réel (clé Groq invalide,
      puis les deux clés invalides) : le repli se déclenche bien. Le vrai problème était que le
      log interne de Mastra pour le dernier maillon peut attribuer l'échec de Mistral au
      `provider`/`modelId` de Groq — diagnostiqué à tort comme « la bascule ne marche pas ».
      Ajout de `withChainFailureLogging()` dans `src/shared/llm/model-fallback.ts` : journalise
      chaque échec de maillon via `src/shared/logger`, avec le provider/modelId qui a **vraiment**
      échoué, sans changer le comportement de repli. Voir CHANGELOG [Unreleased].
- [x] **Coût en tokens d'entrée réduit sur les 3 agents (`notificationAgent` en priorité).**
      Mesuré en prod à 7 849 tokens d'entrée pour un message trivial — au-dessus du plafond Groq
      (12 000 tokens/minute) dès qu'un flux fait plusieurs allers-retours d'outils.
      `notificationAgent` perd `discoverSlackWorkspace` (jamais mentionné dans ses instructions,
      aucun usage identifié, tool le plus coûteux du set) ; instructions des 3 agents condensées
      (STYLE + RÈGLE ANTI-INVENTION reformulés plus courts, bloc `SECURITY DIRECTIVE:` terminal
      retiré car redondant avec l'en-tête de sécurité obligatoire). Mesuré (chars réels,
      `zodToJsonSchema` + `agent.getInstructions()`) : `notificationAgent` 7156→5021 car.
      (−29.8 %) ; instructions `onboardingOrchestrator` −21.8 %, `questionnaireEngine` −24.9 %.
      600/600 tests verts après coup. Voir CHANGELOG [Unreleased] pour le détail par tool/agent.

### À faire

**Base de données — bloquant pour toute base vierge**
- [ ] **Régénérer `drizzle/` dans un vrai TTY.** `0000_*.sql` déclare `employees` avec
      11 colonnes contre 20 dans `schema.ts` : rejouer l'historique de migration sur une base
      neuve échoue (`table employees has no column named phone`). `npm run db:generate` pose
      des questions interactives (added-vs-renamed) et **ne peut pas être scripté** — nécessite
      un humain devant un terminal.
- [ ] Vérifier ensuite que `AUTO_MIGRATE=true` sur une base vierge produit bien le schéma
      complet (aujourd'hui la prod n'a été construite que par application directe du DDL).

**Email**
- [ ] **Vérifier un vrai domaine** (SPF/DKIM/DMARC) et basculer `NOTIFICATION_FROM` sur
      `…@kisso.com`. Envoyer au nom de « Kisso » depuis une adresse `@gmail.com` est
      structurellement exposé au spam. `SmtpAdapter` fonctionnera tel quel avec le SMTP du
      domaine.
- [ ] Rendre l'échec d'email **visible** : `sendWelcomeEmail` avale l'erreur et pose
      `emailSent: false`, mais le workflow retourne `status: 'success'` — source de faux
      « ✅ PASS » dans les rapports de test.
- [ ] Décider du sort du repli Brevo : soit demander l'activation du compte transactionnel à
      Brevo (`403 permission_denied`, blocage au niveau **compte**), soit retirer
      `BrevoAdapter` et `BREVO_API_KEY`.

**Robustesse du bot Slack**
- [ ] **File durable pour le traitement en tâche de fond.** Risque réel et **non testé** :
      Vercel peut geler la fonction dès l'ACK envoyé et tuer l'appel LLM en vol — symptôme
      « le bot ACK mais ne répond jamais ». `inngest` est déjà une dépendance.
- [ ] **Déduplication multi-instance.** Le cache LRU sur `event_id` est en mémoire, donc
      **par instance** : plusieurs instances serverless concurrentes peuvent traiter deux fois
      le même rejeu. Déporter vers la base ou un cache partagé.
- [ ] **Pas de 3ᵉ maillon LLM.** Si Mistral échoue aussi (quota, panne), l'erreur brute de
      Mistral remonte quand même au client en `HTTP 500` — la bascule Groq → Mistral (voir
      `src/shared/llm/model-fallback.ts`) n'aide pas dans ce cas, elle ne fait que journaliser
      correctement lequel des deux a échoué. À évaluer : un 3ᵉ fournisseur, ou une réponse
      d'erreur générique côté API plutôt que le message brut du provider.

**Configuration et dette**
- [ ] **Câbler ou supprimer `src/config/index.ts`** — code mort : `getConfig()` n'est appelé
      nulle part, donc ses garde-fous Zod ne s'exécutent jamais. Le brancher **tel quel**
      casserait le boot : son schéma `database.url` n'accepte que `file:` ou `postgresql://`
      alors que la valeur réelle est `libsql://`.
- [ ] **Purger les variables mortes** de `.env` et de Vercel : `RESEND_API_KEY` (adaptateur
      supprimé), `GOOGLE_GEMINI_API_KEY`, `SLACK_USER_TOKEN`, `OPENAI_API_KEY`
      (lu uniquement par le `config/index.ts` mort).
- [ ] **Mettre à jour `.env.example`** : la section « CONFIG MORTE » y liste encore
      `SMTP_HOST/PORT/USER/PASS` comme inutilisés — ce sont désormais les variables du
      fournisseur email **principal**.
- [ ] **Passer Node en `>=22.13.0`** : l'environnement tourne sur v20.19.4 alors que
      `engines` exige 22.13.0.
