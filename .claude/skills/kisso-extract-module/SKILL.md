---
name: kisso-extract-module
description: Use when splitting a large file in the Kisso repo — especially slack-events.handler.ts (3600+ lines, 8 responsibilities). Enforces one extraction per commit with a green suite at each step, and protects the architecture dependency rule that two guard tests already lock.
---

# Extraction sûre d'un module — Kisso

## Le fichier visé

`src/features/notification/infrastructure/handlers/slack-events.handler.ts` — **3 658 lignes**,
et il porte simultanément la sécurité, la déduplication et le rationnement. C'est exactement
pourquoi on l'extrait **par étapes**, jamais d'un bloc : une régression dans une refonte massive
devient très difficile à localiser.

## La règle de dépendance — non négociable

```
domain  ← ne dépend de RIEN (TypeScript pur, zéro import framework)
application  ← dépend de domain
infrastructure  ← implémente les ports du domain
```

Jamais l'inverse. Deux tests garde-fou le verrouillent :
`tests/unit/quality/architecture.test.ts` et `code-architecture.test.ts`.

**Où va quoi :**

| Nature du code | Destination |
| --- | --- |
| Fonction pure, aucune E/S, aucun type Slack | `domain/services/` |
| Construction de Block Kit, appels Slack | `infrastructure/ui/` ou `providers/` |
| Utilisé par plusieurs features | `src/shared/` |

⚠️ Si les deux bords d'un module vivent dans des features différentes, il va dans `src/shared/` —
sinon l'un devrait importer l'autre et violer la règle. C'est la justification de
`slack-request-context.ts`.

## Procédure, une extraction = un commit

1. **Choisir un bloc ISOLÉ.** Commencer par les fonctions déjà `export`ées et déjà testées : leur
   extraction ne change aucun comportement et les tests existants la valident telle quelle.
2. **Vérifier les dépendances entrantes** avant de bouger quoi que ce soit :
   ```bash
   grep -rn "nomDuSymbole" src/ tests/ scripts/ | grep -v "handlers/slack-events.handler.ts"
   ```
3. **Déplacer**, sans rien réécrire. ⚠️ **Aucune amélioration au passage** — un déplacement et une
   modification dans le même commit rendent toute régression impossible à imputer.
4. **Emporter les commentaires.** Ils portent le POURQUOI, souvent un incident de production
   payé cher. Un commentaire perdu est une leçon perdue.
5. **Réexporter depuis le handler** si des tests importent le symbole depuis là : cela garde le
   commit petit. Le nettoyage des imports est un commit séparé.
6. **Vérifier** : lancer le skill `kisso-verify` (les quatre commandes).
7. **Commiter seul**, message expliquant ce qui bouge et ce qui NE bouge pas.

## Ordre proposé, du plus sûr au plus intriqué

1. `buildProfileButtonBlock`, `buildWelcomeBlocks`, `buildProfileInviteBlocks`, `greet`,
   `channelsLine` → `notification/infrastructure/ui/welcome-blocks.ts`
2. `detectUnsupportedCompletionClaim`, `readToolCallNames`, `hasActingToolCall`,
   `normalizeForClaims` → `notification/domain/services/claim-reconciliation.ts`
3. `sanitizeDisplayName`, `safeIdentifier`, `buildContextPreamble` →
   `notification/domain/services/context-preamble.ts`
4. `routeToAgent`, `matchesKeyword`, `ESCAPE_INTENTS`, `TOPIC_BANDS` →
   `notification/domain/services/agent-routing.ts`
5. `userFacingFailure` → `shared/user-facing-failure.ts`

## Ce qui RESTE dans le handler

Les dépôts paresseux et l'orchestration `accept` / `processEvent` / `handleMessage`. C'est sa
vraie responsabilité — l'extraire ne ferait que déplacer le problème.

⚠️ **Les dépôts sont paresseux à dessein** : le handler est instancié au chargement du module, et
ouvrir une connexion Drizzle à ce moment-là paierait la latence sur le chemin d'ACK, celui qui a
**3 secondes**. Ne jamais les remonter dans le constructeur « pour simplifier ».

## Signal d'alarme

Si une extraction demande de modifier un test **autrement que son chemin d'import**, elle change
le comportement. S'arrêter et le traiter comme un changement à part entière.
