# Point d'Avancement : Agent d'Onboarding (OnboardingOrchestrator)

*Date : 29 Juillet 2026*
*Objet : Mise à jour sur les fonctionnalités et le plan d'implémentation de l'Agent d'Onboarding, requise avant 14h00.*

## 1. Objectif de l'Agent
L'**OnboardingOrchestrator** est le chef d'orchestre de l'intégration des employés chez Kisso Industries. Son rôle est de suivre l'état global du processus, de coordonner les actions requises (création de profil, affectation de tâches) et d'interagir avec les autres agents (QuestionnaireEngine et NotificationAgent).

## 2. Fonctionnalités Prévues
Afin de remplir son rôle, l'agent sera doté des fonctionnalités suivantes :
- **Gestion de l'Employé** : Création et consultation des profils (via les outils `createEmployee` et `getEmployeeProfile`).
- **Suivi de Progression** : Mise à jour du statut de l'onboarding au fur et à mesure que l'employé accomplit ses tâches (`updateOnboardingStatus`).
- **Gestion des Tâches** : Consultation de la liste des tâches (todo, in_progress, done) de l'employé (`getTaskList`).
- **Orchestration des Workflows** : Initialisation du workflow principal (`EmployeeOnboarding`) et délégation des sous-étapes aux agents spécialisés.

## 3. Plan d'Implémentation & Prochaines Étapes
Voici le détail des points prévus pour le développement de l'agent afin de faciliter le suivi :

- [ ] **Étape 1 : Refonte des Outils (Tools)**
  - Mettre à jour la signature de la méthode `execute` pour s'aligner sur `@mastra/core` (v1.53.0).
  - Implémenter et tester la logique métier des outils `createEmployee`, `getEmployeeProfile`, `updateOnboardingStatus` et `getTaskList`.
- [ ] **Étape 2 : Configuration du Prompt Système (Persona)**
  - Rédiger les instructions (`instructions` dans Mastra) pour définir le ton, les limites et le comportement de l'orchestrateur.
- [ ] **Étape 3 : Création de l'Agent Mastra**
  - Instancier l'agent `OnboardingOrchestrator` dans `src/agents/onboarding-orchestrator.ts`.
  - Lui attacher ses outils dédiés.
- [ ] **Étape 4 : Intégration au Workflow (EmployeeOnboarding)**
  - Définir les étapes (`Step`) du workflow d'onboarding.
  - Interfacer l'agent avec le workflow pour qu'il prenne des décisions à chaque transition d'état.
- [ ] **Étape 5 : Tests d'Intégration**
  - Simuler un parcours d'onboarding complet avec l'agent et vérifier les appels en base de données.

## 4. Statut Actuel
L'architecture de base, le modèle de données (ADRs validés) et les dossiers sont en place. Nous entamons actuellement la finalisation des composants partagés (Types, Schemas Zod) avant d'attaquer directement la refonte des outils (Étape 1 ci-dessus). 
L'agent sera prêt à être intégré d'ici la fin de notre itération sur les workflows.
