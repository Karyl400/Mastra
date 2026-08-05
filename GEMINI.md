# GEMINI.md — Règles Projet Kisso Onboarding

## Architecture
- Clean Architecture : domain (entities, ports), application (use-cases), infrastructure (adapters), presentation (agents/tools/workflows Mastra).
- SOLID, DRY, KISS, YAGNI, Composition over Inheritance.
- Patterns autorisés si justifiés : Factory, Builder, Strategy, Adapter, Facade, Repository, Command, Observer.

## Conventions Code
- TypeScript strict : pas de `any`, pas de valeurs magiques, pas de duplication.
- Fichiers < 300 lignes ; nommage kebab-case pour fichiers, camelCase pour fonctions/variables, PascalCase pour classes/types.
- Exports nommés uniquement (pas de default export).

## Mastra
- Agents dans `src/agents/`, Tools dans `src/tools/`, Workflows dans `src/workflows/`.
- Utiliser `@mastra/core/agent`, `@mastra/core/tool`, `@mastra/core/workflow`.
- Structured Outputs, Validation, Prompt Templates obligatoires.

## Sécurité
- Validation entrées utilisateur (Zod).
- Secrets en variables d'environnement uniquement.
- Protection contre Prompt/Command/Token Injection.

## Documentation
- Code source en anglais.
- Documentation et commentaires en français dans `docs/`.
- ADR dans `docs/adr/`.
- TODO.md et CHANGELOG.md tenus à jour.
