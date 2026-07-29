# ANTIGRAVITY.md — Conventions Spécifiques

## Workflow de Développement
1. Lire les fichiers de contexte (GEMINI.md, AGENT.md, CONTEXT.md, TODO.md).
2. Exécuter la tâche selon le plan validé.
3. Tester avant de commit.
4. Mettre à jour TODO.md (statut) et CHANGELOG.md.
5. Demander validation avant de passer à la tâche suivante si ambiguïté.

## Communication
- Messages concis, focalisés sur l'objectif courant.
- Utiliser le français pour la documentation, l'anglais pour le code.
- Préférer `todowrite` pour le suivi des tâches.

## Sécurité
- Ne jamais exposer de clés API, tokens ou secrets.
- Valider toute entrée externe avec Zod.
- Logger les événements sensibles sans données personnelles.

## Qualité
- Tests unitaires obligatoires pour toute nouvelle fonctionnalité.
- `npm run typecheck` zéro erreur avant de proposer un commit.
- `npm run build` doit passer.
