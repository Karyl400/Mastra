---
name: find-skills
description: Use at the start of any Kisso task when unsure which skill applies, or when the user asks "quel skill utiliser". Maps an intention to the right project skill and names the repo-specific traps that apply before touching anything.
---

# Quel skill pour quelle intention — Kisso

## Table d'orientation

| Ce que tu t'apprêtes à faire | Skill | Pourquoi |
| --- | --- | --- |
| Dire « c'est bon », committer, déployer | **`kisso-verify`** | Quatre commandes, dans l'ordre. `build` est la seule qui prouve que le bundle démarre. |
| Toucher aux événements Slack, au routage, ou « ça ne se déclenche pas en prod » | **`kisso-slack-contract`** | Un test vert ne prouve rien sur ce que Slack envoie réellement. |
| Ajouter/modifier une instruction d'agent, un schéma de tool, un tool-result | **`kisso-token-budget`** | Le budget se compte à la JOURNÉE : ≈ 19 messages. |
| Découper un gros fichier | **`kisso-extract-module`** | Une extraction par commit, suite verte à chaque étape. |
| Corriger un bug | `superpowers:systematic-debugging` puis le skill de domaine | Reproduire avant de proposer. |
| Écrire une fonctionnalité | `superpowers:test-driven-development` | Règle du dépôt : rouge → vert → refactor. |
| Concevoir avant de coder | `superpowers:brainstorming` | Avant tout travail créatif. |

## Avant de toucher au code, quel que soit le skill

1. **`CLAUDE.md` décrit le DÉPÔT, pas la PRODUCTION.** Les deux divergent régulièrement, et les
   confondre a déjà coûté des heures. Vérifier :
   ```bash
   npx vercel ls && git log --oneline -1
   ```
2. **Lire l'intégralité d'un fichier avant de le modifier** (règle de travail du projet).
3. **Les commentaires portent le POURQUOI**, souvent un incident payé cher. Beaucoup de
   « bizarreries » sont des choix documentés : lire le commentaire avant de crier au bug.
4. Après toute modification : `npm run typecheck && npm run test:unit`.

## Les quatre pièges qui reviennent le plus

- **`\b` raisonne en ASCII sans le drapeau `u`.** `/\bbloqué\b/` ne matche JAMAIS — `é` n'y est
  pas une lettre. Rencontré **trois fois**. Toujours `(?<![\p{L}])…(?![\p{L}])` avec `u`.
- **Drizzle ignore SILENCIEUSEMENT toute clé de `.values()` sans colonne déclarée.** Ça a déjà
  détruit 6 lignes de `documents.content`. **DDL d'abord, déploiement ensuite.**
- **Dans Hono, un middleware qui a appelé `next()` doit assigner `c.res`, pas retourner.** Deux
  middlewares ont été inopérants pendant des semaines, avec des tests verts qui assertaient le
  retour.
- **Une route n'existe que déclarée dans `server.apiRoutes`.** Un fichier posé dans `src/api/`
  n'est jamais monté automatiquement — c'était la cause du bot muet.

## Si aucun skill ne correspond

Le dire, et procéder normalement. Ne pas forcer un skill hors de son domaine : c'est le meilleur
moyen d'appliquer une check-list qui ne s'applique pas et de rater ce qui compte.
