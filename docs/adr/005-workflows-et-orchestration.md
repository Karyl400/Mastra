# ADR-005 : Workflows et Orchestration

## Statut
Accepté

## Contexte
Les agents Mastra ont besoin d'être orchestrés dans des workflows structurés (State Machines) pour assurer le bon déroulement d'un onboarding, de la création à la complétion.

## Décision
Nous définissons 4 workflows Mastra principaux (`src/workflows/`) :

1. **EmployeeOnboarding** (Workflow Maître)
   - **Déclencheur** : Ajout d'un nouvel employé.
   - **Étapes** : Création profil -> Génération des tâches -> Lancement du sous-workflow Questionnaire -> Validation manager -> Complétion.
   - **Agent** : `OnboardingOrchestrator`.

2. **QuestionnaireCycle**
   - **Déclencheur** : Étape de l'EmployeeOnboarding ou demande ponctuelle HR.
   - **Étapes** : Génération par l'IA -> Attente soumission -> Évaluation (evaluateResponse) -> Mise à jour du score.
   - **Agent** : `QuestionnaireEngine`.

3. **NotificationCycle**
   - **Déclencheur** : Événement système (rappel, étape validée, alerte).
   - **Étapes** : Rédaction par l'IA (formatage) -> Routage (Slack/Email/InApp) -> Envoi -> Enregistrement historique.
   - **Agent** : `NotificationAgent`.

4. **DocumentGeneration**
   - **Déclencheur** : Besoin contractuel ou compte rendu.
   - **Étapes** : Collecte des données -> Génération (Markdown/Texte) -> Sauvegarde / Export PDF.
   - **Agent** : (Peut être géré par l'OnboardingOrchestrator avec l'outil `generateDocument`).

## Conséquences
- **Avantages** : Séparation claire des processus métier longs en étapes distinctes, traçables et rejouables.
- **Inconvénients** : Nécessite de bien gérer l'état (State) entre les différentes étapes (steps) des workflows Mastra.
