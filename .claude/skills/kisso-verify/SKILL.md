---
name: kisso-verify
description: Use before claiming any change works in the Kisso repo — after editing code, before committing, before deploying, or whenever about to say "c'est bon / ça passe / tests verts". Runs the project's four verification commands in the required order and refuses to report success without pasting real output.
---

# Vérification de non-régression — Kisso

## Pourquoi cet ordre, et pourquoi les quatre

Chaque commande attrape une classe d'erreur que les autres laissent passer. En sauter une, c'est
livrer un défaut que ce dépôt a DÉJÀ payé au moins une fois.

```bash
npm run typecheck    # tsc --noEmit
npm run test:unit    # vitest run
npm run lint         # 0 erreur exigé (les warnings sont tolérés)
npm run build        # inclut verify:bundle
```

## Ce que chacune attrape

| Commande | Le défaut qu'elle seule voit |
| --- | --- |
| `typecheck` | Un refactor à moitié câblé — une méthode renommée dont un site d'appel reste en arrière. |
| `test:unit` | La régression de comportement. **Recompter à chaque lot — ne pas coder un chiffre ici.** Relevé du 2026-08-21 au soir : 168 fichiers, 2 455 tests. ⚠️ Tout compte antérieur à cette date est FAUX de moitié : `agent-marcel/`, un clone gitignoré du projet, apportait 152 fichiers de test, et il n'existe pas sur le runner. |
| `lint` | ⚠️ Ne se termine plus par `\|\| true` : **0 erreur est un critère de succès**. Il couvre `src` ET `scripts` depuis le 2026-08-21 — 8 146 lignes qui écrivent en production et que rien ne lisait. Warnings tolérés (16 au relevé du 2026-08-21, tous dans `scripts/`). |
| `build` | ⚠️ **La seule qui prouve que le bundle Vercel DÉMARRE.** `verify:bundle` importe réellement `index.mjs` — c'est le seul contrôle qui distingue une liaison ESM rompue d'un pair non satisfait inoffensif. Chercher la ligne `✅ Démarrage du bundle`. |

## Le piège que `build` existe pour attraper

Le bundle **ne démarrait pas en local pendant que le build sortait en vert** : le déployeur
Mastra épingle `@mastra/core` 0.24.9 et installe sa fermeture, que `fix-vercel-output.js` laissait
derrière en écrasant le noyau — `SyntaxError: Named export 'TTLCache' not found`, donc mort avant
la première instruction.

⚠️ **Ne jamais remplacer `verify:bundle` par une heuristique de version.** Essayé le 2026-08-12 :
elle dénonçait cinq écarts préexistants que la production fait tourner.

## Règles de compte rendu

1. **Coller la sortie réelle**, jamais un résumé de mémoire. « Les tests passent » sans le
   compte de tests n'est pas une vérification.
2. Si une commande échoue, **s'arrêter et le dire** — ne pas enchaîner sur les suivantes en
   espérant que ça compense.
3. Ne jamais écrire « tout est vert » si une commande n'a pas été lancée. Dire laquelle manque.

## Ce que ces quatre commandes ne prouvent PAS

- **Rien sur la production.** Le dépôt et la prod divergent régulièrement (`npx vercel ls`
  puis `git log --oneline -1`).
- **Rien sur la base de production.** Une colonne déclarée dans `schema.ts` mais absente de la
  Turso fait échouer l'INSERT au runtime : **DDL d'abord, déploiement ensuite**.
- **Rien sur la chaîne LLM.** Les tests moquent les fournisseurs. Seul un vrai message Slack
  **qui appelle un outil** le prouve — une salutation est un court-circuit déterministe et ne
  touche aucun modèle.
