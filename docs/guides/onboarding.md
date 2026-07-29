# Vision Globale : Plateforme d'Onboarding

## L'objectif de départ
L'objectif de cette plateforme est de faciliter l'accueil des nouvelles recrues au sein de l'entreprise. 
Concrètement, le système doit :
- Donner les guidelines (mise à jour du profil, LinkedIn, X, etc.).
- Ajouter le nouvel employé aux bons canaux de communication (ex: Slack).
- Provisionner les comptes nécessaires (Email, organisation Github, etc.).
- Effectuer un suivi régulier pour s'assurer que tout se passe bien.

## Scénario Concret : L'arrivée de Lucas, nouveau Développeur

Pour illustrer la collaboration de nos 3 agents (Orchestrateur, Questionnaire, Notification), voici un cas d'usage complet :

**1. Déclenchement (Jour J-7) :**
Les RH valident le contrat de Lucas. L'événement déclenche le workflow principal `EmployeeOnboarding`.

**2. L'Agent `OnboardingOrchestrator` entre en action :**
Cet agent est le chef de projet. Il analyse le profil de Lucas (Développeur) et génère son plan d'action :
*   **Provisioning :** L'Orchestrateur appelle les outils nécessaires pour créer l'adresse e-mail de Lucas et l'ajouter à l'organisation GitHub de l'entreprise.
*   **Création des tâches :** Il génère la to-do list de Lucas (ex: "Mettre à jour ton titre sur LinkedIn", "Uploader une photo de profil", "Lire le guide de contribution").

**3. L'Agent `NotificationAgent` prend le relais :**
*   L'Orchestrateur lui demande de souhaiter la bienvenue à Lucas.
*   Le `NotificationAgent` rédige un e-mail **personnalisé et chaleureux** incluant ses identifiants temporaires, les liens vers ses premières tâches, et les guidelines de l'entreprise concernant les réseaux sociaux (X, LinkedIn).
*   En parallèle, il envoie un message sur le channel Slack de l'équipe Tech : *"👋 Préparez-vous, Lucas nous rejoint la semaine prochaine !"*.

**4. Le Jour J (Arrivée de Lucas) :**
*   Lucas se connecte. Le `NotificationAgent` détecte sa connexion (via une routine de rappel) et lui envoie un message Slack avec un résumé de ce qu'il doit faire aujourd'hui.

**5. L'Agent `QuestionnaireEngine` (Jour J+3) :**
*   Il est temps de faire un "Rapport d'étonnement". L'Orchestrateur délègue cette tâche au `QuestionnaireEngine`.
*   Plutôt qu'un formulaire figé, le `QuestionnaireEngine` génère des questions dynamiques basées sur ce que Lucas a déjà accompli (ex: *"Tu as rejoint le Github hier, as-tu réussi à cloner le projet principal ?"*).
*   Lucas répond (texte libre). Le `QuestionnaireEngine` évalue sa réponse, détecte que Lucas bloque sur un accès AWS, et remonte l'information.

**6. Boucle de rétroaction (Orchestrateur) :**
*   L'Orchestrateur reçoit l'alerte du Questionnaire.
*   Il crée immédiatement une tâche pour le manager ("Donner l'accès AWS à Lucas") et demande au `NotificationAgent` de pinger le manager sur Slack.
