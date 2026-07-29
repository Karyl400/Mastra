# ADR-003 : Modèle de Données

## Statut
Accepté

## Contexte
L'application doit stocker des informations sur les employés, leurs parcours d'onboarding, les questionnaires (questions et réponses) et l'historique des notifications. La base de données choisie est SQLite avec Drizzle ORM.

## Décision
Nous structurons les données en plusieurs entités principales (tables) :

1. **Employees**
   - `id` (UUID, PK)
   - `name`, `email`, `role`, `department`, `startDate`
   - `status` (Enum: 'PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED')
   - `createdAt`, `updatedAt`

2. **Questionnaires**
   - `id` (UUID, PK)
   - `employeeId` (FK -> Employees)
   - `type` (Enum: 'TECHNICAL', 'CULTURE', 'HR')
   - `content` (JSONB) - Stocke la structure dynamique générée par le LLM (questions, type de réponse attendue).
   - `status` (Enum: 'PENDING', 'SUBMITTED', 'EVALUATED')
   - `score` (Integer, nullable)
   - `feedback` (Text, nullable) - Retour de l'agent.
   - `createdAt`, `updatedAt`

3. **Notifications**
   - `id` (UUID, PK)
   - `employeeId` (FK -> Employees, nullable si notification globale)
   - `channel` (Enum: 'EMAIL', 'SLACK', 'IN_APP')
   - `type` (Enum: 'REMINDER', 'ALERT', 'WELCOME', 'FEEDBACK')
   - `content` (Text)
   - `status` (Enum: 'PENDING', 'SENT', 'FAILED')
   - `sentAt` (Timestamp)
   - `createdAt`

4. **Tasks** (pour la TaskList)
   - `id` (UUID, PK)
   - `employeeId` (FK -> Employees)
   - `title`, `description`
   - `status` (Enum: 'TODO', 'IN_PROGRESS', 'DONE')
   - `dueDate`
   - `createdAt`, `updatedAt`

## Conséquences
- **Avantages** : L'utilisation de colonnes JSON (`content` dans Questionnaires) permet une grande flexibilité pour les questionnaires générés dynamiquement par l'IA sans avoir à modifier le schéma relationnel.
- **Inconvénients** : Les requêtes complexes sur le contenu des questionnaires devront être faites via les opérateurs JSON de SQLite.
