# TODO.md — Kisso Onboarding

## [1] Créer les fichiers de règles projet
- [x] GEMINI.md
- [x] AGENT.md
- [x] ANTIGRAVITY.md
- [x] CONTEXT.md
- [ ] TODO.md
- [ ] CHANGELOG.md

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
- [x] createEmployee, getEmployeeProfile
- [x] updateOnboardingStatus, getTaskList
- [x] generateQuestionnaire, evaluateResponse
- [x] generateDocument
- [x] sendNotification (Resend + Slack API), scheduleReminder, getNotificationHistory

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
