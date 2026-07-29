# ADR-002 : Structure Agents Mastra

## Statut
Accepté

## Contexte
Le cœur de la plateforme d'onboarding repose sur l'intelligence artificielle pour automatiser, personnaliser et suivre l'intégration des employés. Mastra est le framework choisi pour définir et orchestrer ces agents.

## Décision
Nous définissons 3 agents principaux dans `src/agents/` :

1. **OnboardingOrchestrator**
   - **Rôle** : Chef d'orchestre de l'intégration. Il suit l'état global du processus, coordonne les actions et interagit avec les autres agents.
   - **Outils (Tools)** : `createEmployee`, `getEmployeeProfile`, `updateOnboardingStatus`, `getTaskList`.
   - **Workflow associé** : `EmployeeOnboarding`.

2. **QuestionnaireEngine**
   - **Rôle** : Spécialiste de l'évaluation et du feedback. Il génère des questionnaires personnalisés en fonction du profil de l'employé et évalue les réponses (QCM, texte libre).
   - **Outils (Tools)** : `generateQuestionnaire`, `evaluateResponse`.
   - **Workflow associé** : `QuestionnaireCycle`.

3. **NotificationAgent**
   - **Rôle** : Gestionnaire des communications. Il rédige, formatte et envoie les messages adaptés au bon canal (Email, Slack, in-app) et au bon moment.
   - **Outils (Tools)** : `sendNotification`, `scheduleReminder`, `getNotificationHistory`.
   - **Workflow associé** : `NotificationCycle`.

## Conséquences
- **Avantages** : Séparation claire des responsabilités entre les agents. Chaque agent a un prompt système (persona) précis et un ensemble d'outils limité, réduisant les hallucinations et améliorant la sécurité.
- **Inconvénients** : Nécessite une orchestration robuste pour coordonner les actions entre ces agents (via les workflows Mastra).
