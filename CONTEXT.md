# Contexte Projet — Kisso Onboarding

## Vision
Plateforme d'onboarding intelligent pour Kisso Industries, orchestrant l'intégration des nouveaux employés via des agents IA conversationnels. L'objectif est de faciliter l'accueil en fournissant des guidelines (LinkedIn, X, etc.), en ajoutant l'employé aux bons canaux (Slack), et en provisionnant ses comptes (Email, Github, etc.). (Voir: `docs/guides/onboarding.md`)

## Acteurs
- **Employé** : suit son onboarding, répond aux questionnaires, reçoit des notifications.
- **HR** : configure les parcours, suit les progrès, déclenche des actions.
- **Manager** : valide des étapes, reçoit des alertes.

## Agents IA (3)
1. **OnboardingOrchestrator** : orchestre le parcours complet d'un employé.
2. **QuestionnaireEngine** : génère et valide des questionnaires dynamiques.
3. **NotificationAgent** : gère les notifications multi-canal.

## Workflows (4)
1. **EmployeeOnboarding** : parcours complet d'intégration.
2. **QuestionnaireCycle** : cycle de vie des questionnaires.
3. **DocumentGeneration** : génération de documents PDF/texte.
4. **NotificationCycle** : envoi et suivi des notifications.

## Outils (8+)
- createEmployee, getEmployeeProfile, updateOnboardingStatus, getTaskList, generateQuestionnaire, evaluateResponse, generateDocument, sendNotification, scheduleReminder, getNotificationHistory.

## Contraintes Techniques
- Clean Architecture (Screaming Architecture / Bounded Contexts par "Features").
- SOLID, TypeScript strict avec types purs (pas de framework dans le domaine).
- Mastra Agents/Tools/Workflows déployés sur Vercel (Serverless).
- Turso (LibSQL) + Drizzle ORM.
- Validation Zod.
- Authentification et RBAC prévus pour différencier les accès Employé, HR, Manager.

## Décisions Clés
- Questionnaires dynamiques (JSON runtime).
- Notifications multi-canal (email, Slack, in-app).
- Documentation en français, code en anglais.
- Sécurité LLM stricte avec Guardrails et validation humaine (`PENDING_APPROVAL`) pour les actions sensibles.
- Traçabilité totale via la table globale `AuditLogs`.
