# AGENT.md — Guide pour l'Agent IA

## Projet
Kisso Onboarding — Plateforme d'onboarding intelligent pour Kisso Industries.

## Stack Technique
- Runtime : Node.js (ESM)
- Framework : Mastra (Agents, Tools, Workflows)
- Langage : TypeScript strict
- Base de données : SQLite (better-sqlite3) avec Drizzle ORM
- Validation : Zod
- Tests : Vitest
- LLM : OpenAI / Gemini via Mastra

## Structure

```
src/
├── agents/           # Agents Mastra (OnboardingOrchestrator, QuestionnaireEngine, NotificationAgent)
├── tools/            # Outils Mastra (8+ outils métier)
├── workflows/        # Workflows Mastra (4 workflows)
├── domain/           # Entités et ports
│   ├── entities/
│   └── ports/
├── application/      # Use-cases
│   └── use-cases/
├── infrastructure/   # Adaptateurs (db, notifications, etc.)
│   ├── db/
│   └── notifications/
├── config/           # Configuration et validation
├── prompts/          # Templates de prompts
└── shared/           # Types, constantes, helpers
docs/
├── adr/              # Architecture Decision Records
└── guides/           # Guides fonctionnels
tests/
├── unit/
├── integration/
└── e2e/
```

## Règles
1. Lire GEMINI.md avant toute modification.
2. Lire CONTEXT.md pour le contexte projet.
3. Lire TOUT le fichier avant de le modifier.
4. Mettre à jour TODO.md et CHANGELOG.md après chaque changement significatif.
5. Suivre le cycle TDD : test rouge → vert → refactor.
6. Ne pas modifier un ADR sans en créer un nouveau.
