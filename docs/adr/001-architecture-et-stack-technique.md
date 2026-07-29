# ADR-001 : Architecture et Stack Technique

## Statut
Accepté

## Contexte
Le projet Kisso Onboarding nécessite une architecture robuste, maintenable et évolutive pour gérer l'intégration des nouveaux employés. Nous devons intégrer des agents d'intelligence artificielle via le framework Mastra tout en gardant une base de code propre et testable.

## Décision
Nous avons décidé d'adopter la **Clean Architecture** (Architecture Hexagonale).
- **Domain** : Entités métiers et ports (interfaces).
- **Application** : Cas d'utilisation (Use Cases).
- **Infrastructure** : Implémentations concrètes (BDD, API externes, envois de messages).
- **Présentation (Mastra)** : Agents, Outils (Tools) et Workflows qui exposent et orchestrent les cas d'utilisation.

### Stack Technique
- **Runtime** : Node.js (ESM)
- **Langage** : TypeScript en mode strict pour garantir la robustesse du code.
- **Framework IA** : Mastra (`@mastra/core`)
- **Modèles de langage** : OpenAI (`@ai-sdk/openai`) et Google Gemini (`@ai-sdk/google`).
- **Base de données** : SQLite (via `better-sqlite3`) gérée avec **Drizzle ORM** pour la sécurité et le typage fort.
- **Validation** : Zod pour valider toutes les entrées et schémas dynamiques.
- **Tests** : Vitest pour les tests unitaires et d'intégration.

## Conséquences
- **Avantages** : Séparation claire des responsabilités, code hautement testable, intégration IA facilitée par Mastra, base de données légère et rapide (SQLite).
- **Inconvénients** : Courbe d'apprentissage pour la Clean Architecture et la création de boilerplate (ports/adapters).
