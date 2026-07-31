# CHANGELOG.md — Kisso Onboarding

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
