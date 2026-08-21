# Audit TypeScript & Bonnes pratiques — `kisso-onboarding`

Relevé du 2026-08-21, branche `refactor/cleanup-20260810`. Lecture seule.
Tous les chiffres de ce rapport ont été **mesurés**, jamais estimés ; ce qui ne l'a pas été
porte la mention `HYPOTHÈSE`.

**Contexte d'entrée** : le typecheck, le lint et le formatage sont **tous les trois verts**
(0 erreur, 0 warning). Ce rapport ne conteste pas ce socle — il porte sur ce que ces trois
commandes ne regardent pas.

---

## Synthèse

| | |
|---|---|
| Défauts HAUTE | 4 |
| Défauts MOYENNE | 7 |
| Défauts BASSE | 6 |

Le fil qui relie les quatre défauts HAUTE : **les garde-fous de ce dépôt sont bons, mais leur
périmètre est plus étroit que ce qu'on croit.** `npm run test:unit` mesure un dépôt qui n'est pas
celui-ci ; `npm run lint` et `npm run typecheck` ignorent 8 146 lignes qui écrivent en production ;
la couverture affichée agrège une copie périmée. Aucun de ces écarts ne produit d'erreur — chacun
produit un **chiffre rassurant et faux**, ce qui est le mode de panne que ce dépôt traque partout
ailleurs.

---

# 1. Configuration TypeScript

### [HAUTE] Le bloc `paths` est mort, trompeur, et il porte à lui seul la dette `baseUrl` → TS 7

**Constat** — `tsconfig.json:14-20` déclare cinq alias :

| Alias | Cible | Répertoire |
|---|---|---|
| `@domain/*` | `src/domain/*` | **N'EXISTE PAS** |
| `@infrastructure/*` | `src/infrastructure/*` | existe |
| `@config/*` | `src/config/*` | **N'EXISTE PAS** (supprimé, cf. CLAUDE.md) |
| `@prompts/*` | `src/prompts/*` | **N'EXISTE PAS** |
| `@mastra/*` | `src/mastra/*` | existe (1 fichier : `index.ts`) |

`src/` ne contient que `api`, `features`, `infrastructure`, `mastra`, `shared`.

**Aucun alias n'est utilisé nulle part** — mesuré : `grep -rn "from '@domain/\|from '@infrastructure/\|from '@config/\|from '@prompts/" src/ tests/` → **0 occurrence**. Le dépôt importe
exclusivement en relatif (`../../../../shared/logger`).

**La collision `@mastra/*` est réelle et tracée.** `npx tsc --traceResolution` :

```
Module name '@mastra/core', matched pattern '@mastra/*'.
Trying substitution 'src/mastra/*', candidate module location: 'src/mastra/core'.
File '/home/karyl/mastra/src/mastra/core.ts' does not exist.
[...4 tentatives...]
======== successfully resolved to 'node_modules/@mastra/core/dist/index.d.ts' ========
```

Chacun des 6 imports `@mastra/*` du dépôt (`@mastra/core` ×4, `@mastra/libsql`, `@mastra/deployer-vercel`)
tente d'abord `src/mastra/<nom>` et ne retombe sur npm que **parce que le fichier n'existe pas**.
Créer `src/mastra/core.ts` — nom parfaitement naturel dans un répertoire qui s'appelle `mastra/` —
détournerait silencieusement tous les imports du paquet npm vers le fichier local. Le symptôme
serait un `Agent is not exported`, à des lieues de sa cause.

**Et c'est ce bloc qui coûte `ignoreDeprecations`.** Vérifié empiriquement en reproduisant la
config du projet dans `/tmp/dep` avec le `tsc` 6.0.3 du dépôt :

```
error TS5101: Option 'baseUrl' is deprecated and will stop functioning in TypeScript 7.0.
              Specify compilerOption '"ignoreDeprecations": "6.0"' to silence this error.
```

En retirant `baseUrl` mais en gardant `paths` : `error TS5090: Non-relative paths are not allowed
when 'baseUrl' is not set`. Les deux options sont donc solidaires, et `ignoreDeprecations: "6.0"`
(`tsconfig.json:12`) n'existe **que** pour elles. C'est un compte à rebours : à TS 7, `baseUrl`
cesse de fonctionner.

**Pourquoi ça compte** — trois alias sur cinq documentent une arborescence qui n'existe plus ; un
lecteur qui les croit écrit un import qui ne résoudra jamais. Le quatrième est un piège de
shadowing armé. Et l'ensemble maintient en vie une option condamnée. Les trois problèmes ont la
même solution.

**Recommandation** — **supprimer `paths` ET `baseUrl` ET `ignoreDeprecations`** du `tsconfig.json`.
Le typecheck reste vert (0 alias utilisé), la collision disparaît, la dette TS 7 est soldée, et
trois répertoires fantômes cessent d'être documentés. **Effort : faible** (3 lignes retirées,
vérifiable par `npm run typecheck`).

---

### [MOYENNE] `exactOptionalPropertyTypes` : 96 erreurs, dont 19 concentrées sur le handler Slack

**Constat** — coût mesuré de chaque option stricte absente (`npx tsc --noEmit --pretty false --<opt> | grep -c ': error TS'`).
⚠️ Le comptage naïf `grep -c 'error TS'` rend **0 partout** : `tsc` intercale des codes ANSI entre
`error` et `TS`. Il faut `--pretty false`.

| Option absente | Erreurs | dont `src/` | dont `tests/` |
|---|---:|---:|---:|
| `noPropertyAccessFromIndexSignature` | 323 | — | — |
| `exactOptionalPropertyTypes` | **96** | 52 | 44 |
| `noUncheckedIndexedAccess` | **82** | 9 | 73 |
| `noUnusedLocals` | 20 | **0** | 20 |
| `verbatimModuleSyntax` | 6 | 6 | 0 |
| `noImplicitOverride` | 2 | 2 | 0 |
| `noFallthroughCasesInSwitch` | **0** | 0 | 0 |
| `noUnusedParameters` | **0** | 0 | 0 |
| `noImplicitReturns` | **0** | 0 | 0 |
| `useUnknownInCatchVariables` | 0 | 0 | 0 (déjà actif via `strict`) |

Répartition d'`exactOptionalPropertyTypes` :

```
20  tests/unit/workflows/employee-onboarding.test.ts
19  src/features/notification/infrastructure/handlers/slack-events.handler.ts
 6  src/features/notification/infrastructure/providers/slack-workspace.service.ts
 4  src/shared/logger.ts
 3  src/features/recruitment/application/tools/schedule-candidate-interview.ts
```

**Pourquoi ça compte** — cette option distingue « propriété **absente** » de « propriété **présente
et valant `undefined`** ». Les 19 signalements du handler Slack ne sont pas cosmétiques : c'est
exactement le fichier où `threadTs` est **délibérément absent en DM** (décision documentée dans
CLAUDE.md, payée par « le bot a paru muet des heures en production »). Un exemple typé remonté par
la mesure :

```
slack-events.handler.ts:778 — Argument of type '{ channel: string; text: string | undefined; }'
is not assignable to parameter of type 'ChatPostMessageArguments'.
```

Le produit a une règle métier forte sur `absent ≠ undefined`, et le compilateur ne l'aide pas à la
tenir. Ces 19 erreurs sont l'endroit où la distinction est floue dans le code.

**Recommandation** — activer par étapes plutôt qu'en bloc :
1. **`noFallthroughCasesInSwitch`, `noUnusedParameters`, `noImplicitReturns`** : **0 erreur**, gain
   immédiat, zéro risque. **Effort : faible** (3 lignes). À faire aujourd'hui.
2. `noImplicitOverride` (2 erreurs, toutes dans `src/infrastructure/database/connection.ts`) et
   `verbatimModuleSyntax` (6, dans 3 mappers/repos Drizzle) : **effort faible**.
3. `exactOptionalPropertyTypes` : **effort moyen**, à traiter fichier par fichier en commençant par
   `slack-events.handler.ts` — c'est là que la valeur est, pas dans le compte.
4. `noPropertyAccessFromIndexSignature` (323) : **ne pas activer.** `HYPOTHÈSE` — l'essentiel vient
   des accès `process.env.X`, que ce dépôt fait partout au point d'usage par choix assumé. Le
   rapport bruit/signal serait celui de `sonarjs/todo-tag`.

---

### [BASSE] `noUncheckedIndexedAccess` : 9 erreurs seulement dans `src/`, dont 3 vraies

**Constat** — 82 erreurs, mais **73 sont dans `tests/`** et 9 seulement dans `src/`. Les trois plus
parlantes, dans `src/features/conversation/domain/services/token-window.ts:29-31` :

```ts
if (turns[start].role === 'assistant') {                       // TS2532 possibly 'undefined'
  while (start >= 0 && turns[start].role === 'assistant') start--;
  if (start < 0 || turns[start].role !== 'user') break;
```

La ligne 30 décrémente `start` puis la ligne 31 teste `start < 0` — la garde existe, mais **elle
arrive après** la lecture de la ligne 29. C'est du code qui fenêtre la mémoire conversationnelle
en tokens, et dont CLAUDE.md dit qu'« un tour `assistant` orphelin répondrait à une question
invisible pour le modèle ».

**Pourquoi ça compte** — 9 erreurs pour la totalité de `src/` est un coût dérisoire, et le fichier
touché est précisément celui dont un défaut d'indice produirait un symptôme non diagnosticable.

**Recommandation** — activer `noUncheckedIndexedAccess` **pour `src/` d'abord**. Les 73 erreurs de
`tests/` (majoritairement `result[0].x` sur un tableau qu'on vient d'asserter non vide) peuvent
attendre, ou être absorbées par `?.` / `!`. **Effort : faible pour `src/`, moyen pour l'ensemble.**

---

### [BASSE] `skipLibCheck: true` est justifié — ne pas le retirer

**Constat** — mesuré : `--skipLibCheck false` → **626 erreurs**, dont **382 dans le seul
`node_modules/@mastra/core/dist/workflows/builder/authoring-schema.d.ts`**, plus une cascade dans
les `_types/@internal_ai-sdk-v4|v5|v6` de `@mastra/core` et `@mastra/schema-compat`.

**Pourquoi ça compte** — ces erreurs sont dans les typings d'un fournisseur, non corrigeables ici,
et vraisemblablement liées au conflit de versions du SDK AI que ce dépôt gère déjà en épinglant Zod
à `3.25.76`. Le retrait de `skipLibCheck` rendrait le typecheck rouge en permanence.

**Recommandation** — **conserver**, et ajouter un commentaire dans `tsconfig.json` disant pourquoi
(626 / 382 `@mastra/core`). Aujourd'hui l'option est nue : rien n'empêche quelqu'un de « faire le
ménage » en la retirant. **Effort : faible.**

---

### [MOYENNE] `include` laisse 8 146 lignes hors du typecheck — voir §CI, défaut HAUTE

`tsconfig.json:22` → `"include": ["src/**/*", "tests/**/*"]`. Sont **hors** typecheck :
`scripts/` (40 fichiers, 8 146 lignes), `drizzle.config.ts`, `eslint.config.js`,
`vitest.config.ts`, `vitest.config.integration.ts`. Traité en détail au §5.

---

# 2. Typage

### Points de mesure

Relevé exhaustif sur `src/` (195 fichiers, 22 704 lignes) :

| Échappatoire | Compte |
|---|---:|
| `as any` | **0** |
| `: any` explicite | **0** |
| `<any>` / `any[]` | **0** |
| `Record<string, any>` | **0** |
| `@ts-ignore` | **0** |
| `@ts-expect-error` | **0** |
| `: Function` | **0** |
| index signature large (`[key: string]`) | **1** |
| assertion non nulle `!` | 11 |
| `as unknown as` | **8** |
| `Record<string, unknown>` | 18 |
| `eslint-disable` | 15 |

**C'est un résultat remarquable** et il faut le dire avant de critiquer les 8 cas restants : zéro
`any`, zéro suppression de diagnostic sur 22 704 lignes est rare. Les 15 `eslint-disable` sont
tous ciblés et documentés (4 `sonarjs/super-linear-regex`, 4 `security/detect-non-literal-regexp`,
3 `security/detect-unsafe-regex`, 2 `no-control-regex`, 1 `sonarjs/pseudo-random`) — ils
correspondent au lot ReDoS mesuré et remplacé par `llm-guardrail-redos.test.ts`.

Les 11 assertions `!` sont concentrées sur `excerpt-budget.ts` (4) et
`model-fact-summarizer.service.ts` (2), après un `split('|')` dont la longueur vient d'être testée
(`if (parts.length < 3) return null;` puis `parts[0]!`) — usage légitime.

---

### [MOYENNE] Trois `as unknown as` sur des lignes Drizzle rejouent le motif qui a coûté `documents.content`

**Constat** — les 8 occurrences :

```
src/features/onboarding/infrastructure/repositories/drizzle-onboarding.repository.ts:61
    return result as unknown as OnboardingProgress;
src/features/onboarding/infrastructure/repositories/drizzle-onboarding.repository.ts:100
    return results as unknown as OnboardingStep[];
src/features/knowledge/infrastructure/repositories/drizzle-message-archive.repository.ts:112
    return (rows as unknown as Row[]).map(toDomain);
src/features/onboarding/infrastructure/repositories/drizzle-onboarding.repository.ts:50
    return (result as unknown as { rowsAffected?: number }).rowsAffected ?? 0;
src/shared/validation.ts:60
src/shared/security/api-auth.ts:84          return null as unknown as ApiServiceUser;
src/api/slack-events.route.ts:246           c as unknown as SlackRouteContext
src/api/slack-interactions.route.ts:444     c as unknown as SlackInteractionsContext
```

Les deux derniers (contexte Hono) et `validation.ts:60` sont des adaptations de frontière
légitimes. **Les trois premiers sont la forme exacte de l'incident documenté.**

CLAUDE.md : *« Drizzle IGNORE SILENCIEUSEMENT toute clé de `.values()` sans colonne déclarée […]
le `as unknown as` des mappers effaçant l'écart pour le compilateur. État constaté sur la Turso de
production : 6 lignes sur 6 sans contenu, irrécupérables. »*

Le motif n'a pas disparu — il a changé de fichier. `drizzle-onboarding.repository.ts:61` rend la
ligne brute castée vers l'entité, **sans mapper**. Or l'écart est mesurable :

| `OnboardingProgress` (entité, `onboarding-progress.ts:3-11`) | table `onboarding_progress` (`schema.ts:320-345`) |
|---|---|
| `id`, `employeeId`, `status`, `currentStep`, `totalSteps`, `startedAt?`, `completedAt?` + `Timestamps` | les mêmes **+ `templateId`, `completionPercentage`, `blockedAt`, `blockReason`, `assignedBuddyId`, `metadata`** |

**9 champs déclarés, 14 colonnes en base.** En lecture, cinq colonnes entrent dans l'objet
« domaine » sans y être déclarées — invisibles au compilateur. En écriture,
`drizzle-onboarding.repository.ts:40-47` ne nomme que 6 colonnes dans `.set({…})`, et c'est
précisément la position où Drizzle jette en silence toute clé non déclarée.

Aggravant : **`drizzle-onboarding.repository.ts` est à 0 % de couverture** (16 statements, aucun
test).

**Pourquoi ça compte** — ce dépôt a déjà payé ce défaut en pertes de données irrécupérables en
production. Le compilateur ne peut rien voir tant que le cast est là, et aucun test ne passe sur ce
fichier. C'est le seul endroit de l'audit où un défaut latent a un précédent avéré.

**Recommandation** — remplacer les 3 casts par un vrai mapper `rowToOnboardingProgress(row)` /
`rowToOnboardingStep(row)` qui **nomme chaque champ** (comme `employee.mapper.ts` le fait déjà).
Le mapper explicite fait apparaître l'écart à la compilation au lieu de l'effacer. **Effort : faible**
(2 fonctions d'une dizaine de lignes). Ajouter un test d'aller-retour sur une base jetable :
**effort moyen**.

---

### [MOYENNE] Les classes d'erreur sont fragmentées : 3 hiérarchies parallèles, 21 `throw new Error` bruts

**Constat** — `src/shared/errors.ts` expose 6 classes, toutes dérivées d'`AppError` :

| Classe | Usages dans `src/` (hors `errors.ts`) | `throw` |
|---|---:|---:|
| `AppError` | 0 | 0 (base) |
| `SecurityBlockError` | 11 | 7 |
| `NotFoundError` | 6 | 4 |
| `ValidationError` | 5 | 3 |
| `ConflictError` | 5 | 3 |
| `ServiceUnavailableError` | 2 | 1 |

Mais **trois classes d'erreur vivent hors de ce fichier et n'héritent PAS d'`AppError`** :

```
src/features/knowledge/domain/ports/channel-history.port.ts:11  class ChannelUnavailableError extends Error
src/infrastructure/database/connection.ts:240                   class DatabaseConnectionError   extends Error
src/infrastructure/database/connection.ts:252                   class DatabaseMigrationError    extends Error
```

Et **21 `throw new Error(` bruts** subsistent dans `src/`, contre 20 `throw` typés.

**Pourquoi ça compte** — un `catch (e) { if (e instanceof AppError) … }` — la forme naturelle pour
un handler générique — **ne rattrape ni une panne de base, ni un canal indisponible**. Or ce sont
exactement les deux familles que le produit veut dégrader proprement (CLAUDE.md : « la mémoire
dégrade en silence si elle est indisponible »). Les 21 `Error` bruts sont dans le même cas : ils
n'ont ni `statusCode`, ni code stable, donc `userFacingFailure` ne peut les classer — ce qui
correspond au symptôme déjà instrumenté sous « Échec non classé » et laissé en cause indéterminée
dans `TODO.md`.

**Recommandation** — faire hériter les 3 classes orphelines d'`AppError` (`ChannelUnavailableError`
→ `ServiceUnavailableError` conviendrait même directement), puis passer en revue les 21 `throw new
Error` pour distinguer l'invariant interne (légitime) de l'échec attendu (à typer). **Effort :
faible** pour les 3 classes, **moyen** pour la revue des 21.

---

# 3. Lint

### État mesuré

`npm run lint` → **exit 0, 0 erreur, 0 warning.** L'affirmation de CLAUDE.md est exacte, et le
retrait du `|| true` (2026-08-14) a bien rendu à cette commande sa valeur de signal.
`npm run format:check` → **clean** sur `src/**/*.ts`.

### Les deux règles désactivées : l'instruction tient

**`sonarjs/todo-tag: off`** — justification vérifiée et **valide**. La règle matche le mot « TODO »
n'importe où dans un commentaire ; ce dépôt renvoie constamment à `TODO.md`, son registre de dettes.
7 des 9 erreurs étaient des faux positifs de ce seul motif. Le raisonnement (« une règle qui ne
produit que du bruit masque le signal qu'elle devait porter ») est correct, et la contrepartie —
retrait du `|| true` — a effectivement été livrée.

**`security/detect-object-injection: off`** — justification **valide et exemplaire**. Les 21
signalements ont été instruits un par un : 19 lectures dans des tables constantes
(`MIME_TYPES[format]`, `turns[start].role`), 2 défauts **réels corrigés plutôt que masqués**
(`agentHasTool` levait une `TypeError` sur cinq noms hérités d'`Object.prototype`). Et le
remplacement n'est pas rien : le bloc « nom hérité » de `tests/unit/agents/agent-capabilities.test.ts`
couvre le cas. C'est la bonne façon de désactiver une règle — mesurer, corriger le vrai, documenter.

**`no-empty: allowEmptyCatch`** — 3 `catch` vides déclarés, conforme à ce qui est annoncé.

### [HAUTE] `eslint.config.js` ignore `scripts/**` — et `lint-staged` ne rattrape rien

**Constat** — `eslint.config.js:10-19` : `ignores: ['tests/**', …, 'scripts/**', …]`.

Vérifié concrètement :

```
$ npx eslint scripts/set-role.mts
  0:0  warning  File ignored because of a matching ignore pattern
```

Et le filet supposé — `lint-staged` — ne s'applique pas non plus :

```
package.json lint-staged: {"*.ts": ["eslint --fix", "prettier --write"]}
$ micromatch.isMatch('scripts/set-role.mts', '*.ts')  →  false
```

Le glob `*.ts` **ne matche pas l'extension `.mts`**, qui est celle de la quasi-totalité de
`scripts/`. Même s'il la matchait, ESLint ignorerait le fichier.

**Bilan du périmètre réel de chaque garde-fou :**

| | `src/` | `tests/` | `scripts/` |
|---|:-:|:-:|:-:|
| `tsc --noEmit` | ✅ | ✅ | ❌ |
| `eslint` | ✅ | ❌ | ❌ |
| `prettier --check` | ✅ | ❌ | ❌ |
| tests | ✅ | — | ❌ |
| hook pre-commit | ✅ | ❌ | ❌ |

**Pourquoi ça compte** — `scripts/` fait **8 146 lignes réparties sur 40 fichiers**, et ces
fichiers **touchent la production réelle**. 12 d'entre eux ouvrent une connexion Turso ou un
`WebClient` Slack :

```
set-role.mts, probe-arrival.mts, prune-employees-without-slack.mts, probe-knowledge.mts,
show-directory.mts, apply-ddl.mts, knowledge-status.mts, smoke-slack.mjs, probe-erasure.mts,
probe-authz.mts, production-scenarios.mjs, verify-vercel-bundle.js
```

`probe-erasure.mts` **supprime réellement** (documenté : « vérifié le 2026-08-13 : 38 → 0 »).
`set-role.mts` écrit la colonne dont dépend toute la frontière d'autorisation. `apply-ddl.mts`
applique du DDL sur la Turso de production. Aucun de ces fichiers n'est typé-vérifié, ni linté, ni
testé, ni formaté. Une faute de frappe dans un `WHERE` y est indétectable avant l'exécution — et
l'exécution, c'est la production.

Ce n'est pas théorique : CLAUDE.md rapporte qu'une sonde a laissé « la **base de production
laissée sale**, réparée à la main depuis la sauvegarde » après un `FOREIGN KEY constraint failed`
qu'un typecheck n'aurait certes pas attrapé — mais qui illustre le niveau de risque du répertoire
le moins gardé du dépôt.

**Recommandation**, par ordre de rendement :
1. **Ajouter `scripts/**/*.{mts,mjs,js}` à l'`include` de `tsconfig.json`.** C'est le geste le plus
   rentable : le typecheck est déjà vert, il dirait immédiatement ce qui ne va pas.
   `HYPOTHÈSE` : un premier passage sera rouge (ces fichiers n'ont jamais été vérifiés) — mesurer
   avant de s'engager. **Effort : moyen**, dominé par la correction du premier lot.
2. **Retirer `scripts/**` des `ignores` d'ESLint**, quitte à y appliquer un jeu de règles allégé.
3. **Corriger le glob `lint-staged`** en `*.{ts,mts,mjs}` — sans quoi le hook ne verra jamais ces
   fichiers, quelle que soit la config ESLint. **Effort : faible** (1 ligne).

---

# 4. Tests et couverture

### [HAUTE] `npm run test:unit` exécute une copie périmée du dépôt — 155 fichiers de test fantômes

**Constat** — le run complet annonce :

```
Test Files  315 passed (315)
     Tests  4612 passed (4612)
  Duration  138.66s
```

Or `find tests -name '*.test.ts'` → **166 fichiers**. Les 149 autres viennent de `agent-marcel/`,
un répertoire à la racine qui est **une copie complète et plus ancienne du projet entier** :

```
agent-marcel/  →  src/ (175 fichiers TS), tests/ (155 fichiers), package.json, tsconfig.json,
                  vitest.config.ts, CLAUDE.md, TODO.md, scripts/, docs/, ngrok, venv/…
```

Il est **non versionné** — `.gitignore:34` contient `/agent-marcel/`, et `git ls-files agent-marcel`
rend **0**. Mais `vitest.config.ts:11-16` n'exclut que `node_modules`, `dist`, `tests/integration`
et `tests/unit/infrastructure` : rien n'empêche le glob de descendre dans `agent-marcel/tests/`.

Mesure de contrôle en restreignant au vrai dépôt :

```
$ npx vitest run --dir tests
Test Files  166   |  Tests  2436
```

**Soit 46 % des tests annoncés qui ne testent pas ce dépôt.**

**La couverture est atteinte de la même façon.** `vitest.config.ts:40` déclare
`include: ['src/**/*.ts']`, glob non ancré — il matche donc aussi `agent-marcel/src/**/*.ts`.
Recalcul depuis `coverage/coverage-summary.json` :

| | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|
| **Chiffre affiché** (pollué) | 86.76 % (10221/11780) | 79.31 % | 86.45 % | 88.13 % |
| **Réel, `src/` seul** | **85.63 %** (5405/6312) | **78.11 %** | **85.26 %** | **87.06 %** |
| Copie périmée `agent-marcel/src` | 88.08 % (4816/5468) | 80.71 % | 87.84 % | 89.36 % |

**5 468 des 11 780 statements du rapport (46 %) appartiennent au code mort.** Le rapport contient
194 fichiers de `src/` et **146 fichiers d'`agent-marcel/`**.

**Trois conséquences, la troisième étant la plus grave :**

1. **Le temps.** 138 s au lieu de 85 s — la moitié du temps de test est dépensée sur du code
   qu'aucun déploiement ne verra jamais.
2. **Le chiffre.** Toute décision prise sur « 86,76 % » porte sur un agrégat dont près de la moitié
   est étrangère au dépôt. Le seuil `src/shared/security/**` (85/80/85/85) est évalué deux fois, sur
   les deux copies, qui sont pour l'instant identiques (92.60 % chacune).
3. **La divergence locale/CI.** `agent-marcel/` étant gitignoré, **il n'existe pas sur le runner CI**.
   `npm run test:unit` exécute donc **deux jeux de tests différents** selon l'endroit. Le jour où la
   copie périmée devient rouge — c'est du code figé face à des dépendances qui bougent — le
   développeur verra une suite rouge désignant des fichiers qui ne sont pas dans son dépôt, et la CI
   restera verte. C'est le pire ordre : le signal local ment, et l'autorité (la CI) ne le contredit
   pas.

**Recommandation** — ajouter `'**/agent-marcel/**'` à `exclude` **et** à l'`exclude` de `coverage`
dans `vitest.config.ts`. **Effort : faible** (2 lignes). Puis rebaser toute cible de couverture sur
les vrais chiffres (85,63 % / 78,11 %). Idéalement, sortir ce répertoire de l'arborescence du dépôt.

---

### [HAUTE] `fact-curtain.test.ts` échoue 3 fois sur 3 en isolation et passe dans la suite complète

**Constat** — `tests/unit/knowledge/fact-curtain.test.ts:250` :

```
× la lecture des lignes rendues par le modèle > lit la forme demandée   5009ms
  → Test timed out in 5000ms.
```

Reproduit **3 fois sur 3** en isolation. Reproduit également en lançant tout `tests/unit/knowledge/`
(18 fichiers) : `1 failed | 17 passed`. Mais la suite complète (315 fichiers) passe à 100 %.

**Cause établie.** Le test appelle un helper qui fait un **import dynamique dans le corps du test** :

```ts
async function parse(text: string) {
  const { ModelFactSummarizer } =
    await import('../../../src/features/knowledge/infrastructure/services/model-fact-summarizer.service');
  const summarizer = new ModelFactSummarizer({
    agent: { generate: async () => ({ text }) } as never,   // ← faux agent, aucun réseau
  });
  return summarizer.summarize([{ id: 'a', text: 'x' }]);
}
```

Il ne s'agit **pas** d'un appel réseau : l'agent est injecté, donc `makeModelChain()` n'est jamais
évalué (court-circuit du `??`), et `summarize` est purement synchrone après ça. Ce n'est pas non
plus le coût d'import brut — mesuré sous `tsx` : **1 455 ms**.

C'est la **transformation Vite** du graphe : `vitest.config.ts:17-21` force
`server.deps.inline: [/@mastra\/core/]`, ce qui oblige Vitest à faire passer tout `@mastra/core`
par son pipeline. `model-fact-summarizer.service.ts:1` importe `@mastra/core/agent`. Ce coût est
payé **à l'intérieur du premier `it`**, donc **imputé au délai de 5 000 ms** de ce test.

Dans la suite complète, `pool: 'forks'` + `singleFork: true` (`vitest.config.ts:8-10`) font que tous
les fichiers partagent un même processus et un même cache de modules : un fichier antérieur a déjà
transformé le graphe, l'import est instantané, le test passe. **Le test ne passe que grâce au
travail d'un autre fichier.**

**Pourquoi ça compte** — c'est le fichier qu'un développeur lancera seul, parce que c'est ce qu'on
fait quand on débogue. Il obtiendra un `Timeout 5000ms` qui **ne désigne pas sa cause** — exactement
le mode de panne que CLAUDE.md documente déjà à trois reprises pour les doublures manquantes du
handler Slack. Et l'échec est ici structurel, pas dépendant de la charge machine : 3/3.

**Recommandation** — remonter l'import en **statique, en tête de fichier** (les 18 autres tests du
même fichier importent déjà `fact-curtain.service` statiquement, l'import dynamique n'apporte rien
ici). Le coût de transformation passe alors dans la phase `import` du fichier, hors du délai des
tests. **Effort : faible** (déplacer une ligne). À défaut, un `testTimeout` explicite sur ce
`describe` — mais ce serait masquer plutôt que corriger.

---

### [MOYENNE] La couverture n'est jamais mesurée en CI, et le seul seuil du projet n'y est jamais évalué

**Constat** — `vitest.config.ts:36-47` définit un unique seuil, bien choisi :

```js
thresholds: { 'src/shared/security/**': { statements: 85, branches: 80, functions: 85, lines: 85 } }
```

Le raisonnement associé est juste (« un seuil GLOBAL produirait un échec permanent que tout le monde
apprendrait à ignorer, soit exactement ce que faisait `npm run lint` avec son `|| true` »).

Mais : `npm run test:unit` = `vitest run`, **sans `--coverage`**. Et `.github/workflows/ci.yml`
exécute Lint → Format check → Typecheck → **Test (`npm run test:unit`)** → Build. **Aucune étape ne
lance la couverture.** Le seuil n'est donc évalué que si quelqu'un tape `npm run test:coverage` à la
main.

Mesure actuelle : `src/shared/security/**` est à **92.60 % / 85.43 % / 92.92 % / 93.44 %** — le
seuil passe confortablement. Le problème n'est pas la valeur, c'est que rien ne la surveille.

**Recommandation** — remplacer l'étape `Test` de la CI par `npm run test:coverage`, ou ajouter une
étape dédiée. Le seuil devient alors ce qu'il prétend être : un garde-fou. **Effort : faible**
(1 ligne de YAML). ⚠️ À faire **après** l'exclusion d'`agent-marcel/`, sinon le seuil sera évalué
sur les deux copies.

---

### [MOYENNE] `tests/unit/infrastructure/` est rattaché à l'intégration, que la CI ne lance pas

**Constat** — `vitest.config.ts:15` exclut `**/tests/unit/infrastructure/**` du run unitaire ;
`vitest.config.integration.ts:18` le réinclut :

```js
include: ['tests/integration/**/*.test.ts', 'tests/unit/infrastructure/**/*.test.ts']
```

Le répertoire contient **1 fichier, 54 lignes** : `drizzle-employee.repository.test.ts`. Mais
`ci.yml` ne lance **jamais** `npm run test:integration`.

**Conséquence** — ce test n'est exécuté par **aucun automate**. Il faut le lancer à la main, avec
`.env` chargé. Le calcul est net : le seul test qui exerce une implémentation Drizzle réelle est
aussi le seul que rien ne déclenche.

Et cela se voit dans la couverture — **les repositories Drizzle sont le point bas du dépôt** :

```
  0.0 %  src/features/knowledge/…/slack-channel-history.adapter.ts        (77 stmts)
  0.0 %  src/features/onboarding/…/drizzle-onboarding.repository.ts       (16 stmts)
  0.0 %  src/features/conversation/…/drizzle-conversation.repository.ts   (18 stmts)
  0.0 %  src/features/document/…/drizzle-document.repository.ts           (12 stmts)
  0.0 %  src/features/onboarding/…/drizzle-onboarding-interview.repository.ts (10 stmts)
  0.0 %  src/features/knowledge/…/drizzle-bot-memory.repository.ts         (9 stmts)
  0.0 %  src/features/notification/…/email-provider.factory.ts             (7 stmts)
  0.0 %  src/infrastructure/audit/audit-log.ts                             (3 stmts)
  0.0 %  src/features/employee/application/mappers/employee.mapper.ts      (2 stmts)
  7.4 %  src/features/knowledge/…/drizzle-message-archive.repository.ts   (27 stmts)
  8.7 %  src/features/knowledge/…/drizzle-knowledge-fact.repository.ts    (23 stmts)
 32.4 %  src/infrastructure/database/connection.ts                       (111 stmts)
```

C'est **cohérent avec la doctrine du dépôt** (« les repositories `in-memory-*` servent de doublure —
ne pas mocker Drizzle à la main ») et donc défendable. Mais c'est aussi **exactement la couche où
vit le défaut le plus cher de l'histoire du projet** (§2, `documents.content`), et où subsistent les
3 `as unknown as`. La stratégie de test protège bien le domaine et l'application, et laisse nu le
seul endroit dont une régression est silencieuse.

**Recommandation** — lancer `npm run test:integration` en CI sur une base jetable
(`vitest.config.integration.ts` construit déjà `data/integration-test.db` via son `globalSetup`, sans
toucher Turso — vérifié). Puis y ajouter un test d'aller-retour par repository Drizzle : écrire,
relire, **comparer champ à champ**. C'est le seul contrôle qui attrape une colonne oubliée.
**Effort : moyen.**

---

### Les tests de qualité : ce qu'ils verrouillent réellement

Six fichiers, `tests/unit/quality/` :

| Fichier | Ce qu'il verrouille réellement | Écart avec ce qu'on pourrait croire |
|---|---|---|
| `architecture.test.ts` (197 l.) | La règle de dépendance sur `src/features/*/domain` et `*/application`, avec un test anti-faux-négatif qui vérifie qu'il scanne bien les 8 features | ⚠️ **`FEATURES_DIR = src/features` (ligne 21) — `src/shared/` lui est totalement invisible**, alors qu'il pèse 7 715 lignes. CLAUDE.md le reconnaît déjà. Ce n'est pas un cycle (vérifié : `shared/` n'importe aucune feature) mais la garantie est plus étroite que son nom |
| `claimed-invariants.test.ts` (83 l.) | Que toute phrase « verrouillé par \`X\` » de `src/` cite un fichier existant | Portée **volontairement** étroite et **déclarée telle** (ligne 29). Ne couvre ni « la seule feature qui… » ni « délibérément absente », les deux autres formes que son propre en-tête désigne comme le défaut à traquer. Honnête, mais partiel |
| `tool-classification.test.ts` (89 l.) | Que tout outil câblé est classé lecteur **ou** acteur, jamais les deux, jamais ni l'un ni l'autre — dérivé d'`AGENT_TOOLS` | Solide. C'est le test dont CLAUDE.md dit qu'il « n'existait pas » alors que son en-tête l'annonçait ; il existe désormais |
| `assistant-persona.test.ts` (142 l.) | Aucune auto-désignation en outil/agent/IA dans tout `src/`, **plus** un test anti-faux-négatif vérifiant que les motifs reconnaissent ce qu'ils interdisent | Exemplaire — le second test est ce qui empêche le premier d'être vert et vide |
| `env-example-completeness.test.ts` (134 l.) | Bijection entre les `process.env` lus dans `src/` et `.env.example` — **dans les deux sens** | ⚠️ Ne lit que `src/`. Les variables lues **uniquement** par `scripts/` (8 146 lignes) échappent au contrôle |
| `taught-phrases.test.ts` (148 l.) | Que toute phrase que le produit apprend à taper est reconnue par un prédicat, et qu'il n'en enseigne pas trois pour la même chose | Bon garde-fou, difficile à obtenir autrement |

**Verdict** : cette famille de tests est le meilleur atout du dépôt, et elle applique
systématiquement le contrôle anti-faux-négatif (« scanne-t-il vraiment quelque chose ? ») que la
plupart des projets oublient. **Le point aveugle partagé par trois d'entre eux est le même que
celui du reste de la chaîne : `src/shared/` pour l'architecture, `scripts/` pour l'environnement.**

---

# 5. CI/CD

### [MOYENNE] La chaîne existe et elle est correcte — son seul trou est le périmètre

**Constat** — `.github/workflows/ci.yml` :

| Élément | État |
|---|---|
| Déclencheur | `push: branches: ['**']` + `pull_request` — **corrige** le défaut documenté (la CI ne visait que `main`/`master` alors que tout vit sur `refactor/cleanup-20260810`) ✅ |
| Node | `22.x`, aligné sur `engines` et sur le runtime Vercel forcé à `nodejs22.x` ✅ |
| Étapes | `npm ci` → Lint → Format check → Typecheck → Test → Build |

Les cinq étapes tournent réellement — aucune n'est suffixée `|| true`. Les deux commentaires du
fichier expliquent des décisions de périmètre et sont **exacts** (vérifié : `format:check` porte
sur `src/**/*.ts` et passe ; l'élargir à `.` reflowerait la prose française de `docs/`).

**Le hook pre-commit** (`.husky/pre-commit` → `npx lint-staged`) fonctionne, mais son glob `*.ts` ne
couvre ni `.mts` ni `.mjs` (§3), et ESLint ignore `tests/**` et `scripts/**` de toute façon. **Il ne
garde donc que `src/`.**

**Y a-t-il un garde-fou entre un commit et la production ?** Oui, et il est sérieux :
`vercel.json:2` → `buildCommand: npm run build:prod` → `tsc --noEmit && mastra build &&
fix-vercel-output.js && verify:bundle`. **Le typecheck est sur le chemin du déploiement**, ce qui
est plus que ce que fait la plupart des projets.

`scripts/verify-vercel-bundle.js:207-235` mérite d'être signalé comme un **point fort** : il
**importe réellement** `index.mjs` dans un sous-processus, et son traitement de l'erreur est
finement raisonné —

```js
env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./_verify-boot.db' },
…
const linkFailure = /Named export .* not found|ERR_MODULE_NOT_FOUND|Cannot find module|…/.test(output);
```

Il injecte une URL de base factice (car `src/mastra/index.ts:216` **lève** au chargement si
`DATABASE_URL` manque) et ne juge **que** la liaison ESM, laissant passer toute autre erreur. C'est
ce qui permet à l'étape `Build` de la CI de réussir **sans aucun secret** — vérifié, `ci.yml` n'a
pas de bloc `env:`. Le raisonnement (« le contraire ferait de ce contrôle un test d'intégration
déguisé, rouge pour des raisons sans rapport avec le déploiement ») est juste.

De même `scripts/fix-vercel-output.js:210-262` **vérifie** les crons de `vercel.json` sans les
recopier dans `.vercel/output/config.json`, et refuse au build une planification que le plan Hobby
rejetterait au déploiement. C'est la bonne place pour ce contrôle.

**Ce qui manque** :
- pas de `npm run test:integration` (donc `tests/unit/infrastructure/` jamais exécuté — §4) ;
- pas de couverture (donc le seul seuil du projet jamais évalué — §4) ;
- `scripts/` hors de toutes les étapes (§3).

**Recommandation** — ajouter deux étapes à `ci.yml` : `npm run test:integration` et une mesure de
couverture. **Effort : faible.**

---

# 6. Bonnes pratiques générales

### [MOYENNE] Trois dépendances mal placées, dont une native et une totalement inutilisée

**Constat** — usage réel mesuré par `grep` sur `src/`, `tests/`, `scripts/` et les configs :

| Paquet | `src/` | `tests/` | `scripts/` | Verdict |
|---|:-:|:-:|:-:|---|
| **`async-mutex` ^0.5.0** | 0 | 0 | 0 | ❌ **Aucune occurrence dans tout le dépôt** — à supprimer |
| **`ai` ^7.0.55** | 0 | 2 | 0 | ⚠️ Importé **uniquement par les tests** (`import { APICallError } from 'ai'` dans `model-fallback*.test.ts`). Vérifié : ce n'est **pas** un peer des `@ai-sdk/*` (leur seul peer est `zod`). → `devDependencies` |
| **`better-sqlite3` ^12.11.1** | 0 | 0 | 1 | ⚠️ Seul usage : `scripts/init-db.mjs:1`. C'est un module **natif** (compilation à l'install) en `dependencies` → `devDependencies` |
| `pdfkit` ^0.19.1 | 0 | 0 | 7 | ✅ Jamais importé, mais **déclaré à dessein** : dépendance transitive de `pdfmake` que `verify:bundle --require` et `fix-vercel-output.js` nomment pour l'épingler dans le bundle élagué |
| `@noble/hashes` ^2.2.0 | 0 | 0 | 1 | ✅ Même logique (`vercel-bundle-deps.js:21` l'explique : embarqué par la copie récursive de `pdfkit`) |
| `semver` | 0 | 0 | 1 | ✅ Déjà en `devDependencies` |

Les autres (`drizzle-orm` 21, `@slack/web-api` 6, `lru-cache` 3, `docx` 3, `pdfmake` 3,
`@opentelemetry/api` 3, `validator` 2, `sanitize-html` 1, `nodemailer` 1, les trois `@ai-sdk/*` 1
chacun) sont tous réellement importés.

**Pourquoi ça compte** — `dependencies` détermine ce qui est installé en production. `better-sqlite3`
y impose une compilation native sur le runner Vercel pour un script qui n'y tourne jamais.
L'élagage par atteignabilité de `fix-vercel-output.js` retire probablement ces paquets du bundle
final (`HYPOTHÈSE` — non vérifié, cela demanderait un build complet), mais le coût d'installation
au build, lui, est payé dans tous les cas.

**Recommandation** — supprimer `async-mutex` ; déplacer `ai` et `better-sqlite3` en
`devDependencies`. **Effort : faible.** Puis vérifier `npm run build` (les trois sont hors du graphe
d'atteignabilité, le bundle ne devrait pas bouger).

---

### [BASSE] Les niveaux de log sont cohérents, avec deux réserves mineures

**Constat** — répartition sur `src/` :

```
logger.error  105        console.log    2
logger.warn   112        console.error  4
logger.info    99
logger.debug   10
logger.fatal    0
```

L'usage est **discipliné** : `error` et `warn` dominent, ce qui correspond à une doctrine de
dégradation explicite (chaque fail-open est journalisé). `maskPii` couvre les champs de prose
humaine depuis le 2026-08-14, avec l'exclusion raisonnée de `message`.

Deux réserves :
- **6 appels `console.*` subsistent** dans `src/` — ils échappent à `maskPii` et au format JSON
  structuré. `HYPOTHÈSE` : probablement dans des chemins de bootstrap antérieurs à l'init du logger.
  À vérifier au cas par cas.
- `logger.debug` n'a que **10 appels pour 22 704 lignes**. Ce n'est pas un défaut en soi (le
  dépôt préfère `info`), mais `LOG_LEVEL=debug` n'apporte quasiment rien de plus qu'`info` —
  c'est un levier de diagnostic annoncé dans la table des variables d'environnement et
  pratiquement vide.

**Recommandation** — remplacer les 6 `console.*` par le logger si le contexte le permet.
**Effort : faible.**

---

### [BASSE] Code mort : `onboarding_steps` est déclaré supprimé mais reste entièrement câblé

**Constat** — CLAUDE.md affirme : *« Tout le suivi de TÂCHES a été supprimé le 2026-08-14 :
`getTaskList`, l'entité `Task`, son port, ses deux dépôts, […] et les `onboarding_steps` qui en
dérivaient 1:1. »*

Or l'inventaire dit autre chose. Le concept est **encore présent à six niveaux** :

```
src/features/onboarding/domain/entities/onboarding-progress.ts:13   interface OnboardingStep
src/features/onboarding/domain/ports/onboarding.repository.ts:7-9   findSteps / saveStep / updateStep
src/features/onboarding/infrastructure/repositories/drizzle-onboarding.repository.ts:64-100
src/features/onboarding/infrastructure/repositories/in-memory-onboarding.repository.ts:25-35
src/infrastructure/database/schema.ts:367                            table onboardingSteps
src/mastra/index.ts:84                                               new DrizzleOnboardingRepository()
```

Le dépôt Drizzle **est instancié et câblé** (`index.ts:84`). Les trois méthodes sont dans le port,
donc toute implémentation future doit les fournir. Et le seul test qui les mentionne
(`tests/unit/workflows/employee-onboarding.test.ts:140`) asserte… qu'elles **ne sont jamais
appelées** : `expect(deps.onboardingRepo.saveStep).not.toHaveBeenCalled()`.

C'est **cohérent** avec la décision de ne pas faire de `DROP` en base (« un `DROP` est
irréversible » — argument valide). Ce qui ne l'est pas, c'est de garder le **code d'écriture**
vivant et câblé : c'est la situation exacte de `discoverSlackWorkspace` avant sa suppression, que
CLAUDE.md décrit comme *« du code qu'un recâblage pourrait rebrancher sans le relire »*.

**Recommandation** — retirer `findSteps` / `saveStep` / `updateStep` du port et des deux
implémentations. Garder la table en base et `schema.ts` (documenter que c'est de l'archive). La
couverture de `drizzle-onboarding.repository.ts` passera mécaniquement de 0 % à une valeur réelle.
**Effort : faible.**

---

### [BASSE] Deux écarts de version entre le documenté et l'installé

**Constat** :

| | Documenté | Installé |
|---|---|---|
| Node | `engines: >=22.13.0`, CI en `22.x`, Vercel en `nodejs22.x` | **`v20.19.4`** en local |
| `@mastra/core` | `^1.57.0` (package.json), « 1.57.x » (CLAUDE.md) | **`1.59.0`** |
| TypeScript | `6.0.3` | `6.0.3` ✅ |
| Vitest | `4.1.10` | `4.1.10` ✅ |
| Zod | `3.25.76` épinglé | `3.25.76` ✅ |

L'écart Node est **déjà recensé** dans CLAUDE.md (« divergence non résolue »). Il n'est pas anodin :
le développement local tourne sur une version que `engines` déclare non supportée et que ni la CI ni
la production n'exécutent.

L'écart `@mastra/core` vient de la plage `^1.57.0` — comportement normal de npm, mais il signifie
que **toute la documentation qui dit « en Mastra 1.57 c'est bien `requestContext` »** décrit une
version qui n'est plus celle installée. `HYPOTHÈSE` : 1.59 n'a pas changé ce contrat, sinon les
tests seraient rouges — mais la doc devrait dire « ≥ 1.57 ».

**Recommandation** — passer le poste de développement en Node 22 (`nvm use 22`) ; noter dans
CLAUDE.md que `@mastra/core` installé est en 1.59. **Effort : faible.**

---

# Points forts

Ce dépôt fait plusieurs choses mieux que la moyenne, et il faut les nommer pour ne pas les casser
en appliquant les recommandations ci-dessus.

1. **Le typage est exceptionnellement propre.** Zéro `any` sous toutes ses formes, zéro
   `@ts-ignore`, zéro `@ts-expect-error`, zéro `: Function`, une seule index signature large, sur
   22 704 lignes. Les 11 assertions `!` sont toutes précédées de la garde correspondante. Les 15
   `eslint-disable` sont ciblés et documentés. C'est rare et cela ne s'obtient pas par hasard.

2. **`npm run lint` est redevenu un signal.** Le retrait du `|| true` s'est accompagné d'une
   instruction sérieuse des règles désactivées : `security/detect-object-injection` a été examinée
   21 fois, 2 vrais défauts ont été **corrigés plutôt que masqués**, et le remplacement est un test
   (`agent-capabilities.test.ts`, bloc « nom hérité »). C'est la bonne méthode.

3. **Les tests de qualité sont le meilleur atout du dépôt.** Six fichiers qui vérifient des
   propriétés qu'aucun type ne peut exprimer — règle de dépendance, invariants annoncés en
   commentaire, classification des outils, persona, complétude de `.env.example`, unicité des
   phrases enseignées. **Et ils portent presque tous un test anti-faux-négatif** (« scanne-t-il bien
   quelque chose ? », « les motifs reconnaissent-ils ce qu'ils interdisent ? »), ce que la plupart
   des projets oublient et qui est la différence entre un garde-fou et un test toujours vert.

4. **Le garde-fou de bundle est du vrai travail d'ingénierie.** `verify-vercel-bundle.js` importe
   réellement `index.mjs` dans un sous-processus, injecte un `DATABASE_URL` factice pour franchir le
   `throw` de démarrage, et ne juge **que** la liaison ESM — refusant explicitement de devenir un
   test d'intégration déguisé. C'est ce qui permet à l'étape `Build` de la CI de tourner sans aucun
   secret. Même qualité pour la vérification des crons dans `fix-vercel-output.js`.

5. **Le typecheck est sur le chemin du déploiement.** `vercel.json` → `build:prod` →
   `tsc --noEmit && …`. Peu de projets font ça.

6. **La CI a été réparée là où elle mentait.** Le déclencheur est passé à `branches: ['**']` — sans
   quoi elle n'aurait jamais tourné sur `refactor/cleanup-20260810`, où vit tout le développement.
   Le commentaire qui l'explique est dans le fichier.

7. **Le périmètre de `format:check` est un arbitrage assumé et correct**, pas un oubli : `src/**/*.ts`
   plutôt que `.`, pour ne pas reflower la prose française de `docs/`. Le raisonnement est écrit.

8. **La culture de commentaire fonctionne.** Chaque décision non évidente rencontrée pendant cet
   audit portait son POURQUOI, et dans tous les cas vérifiés (les deux règles ESLint désactivées, le
   périmètre de `format:check`, la garde d'import du bundle, le seuil de couverture unique) **la
   justification tenait à la vérification**. C'est ce qui a permis de qualifier ces points comme
   corrects plutôt que comme des défauts.

---

# Métriques

### Volume

| | Fichiers | Lignes |
|---|---:|---:|
| `src/` (TypeScript) | 195 | 22 704 |
| `tests/` (TypeScript) | 166 fichiers `.test.ts` | 34 870 |
| `scripts/` | 40 | 8 146 |
| **`agent-marcel/` (copie non versionnée)** | 175 `src` + 155 tests | — |

### Qualité statique

| Contrôle | Résultat |
|---|---|
| `npm run typecheck` | **0 erreur** ✅ |
| `npm run lint` | **0 erreur, 0 warning** (exit 0) ✅ |
| `npm run format:check` | **clean** ✅ |
| `as any` / `: any` / `@ts-ignore` / `Function` dans `src/` | **0** ✅ |
| `as unknown as` dans `src/` | 8 (dont 3 à risque) |
| assertions `!` dans `src/` | 11 |
| `eslint-disable` dans `src/` | 15 (tous ciblés et documentés) |

### Tests

| | Valeur |
|---|---|
| `npm run test:unit` **tel qu'exécuté** | 315 fichiers / **4 612 tests**, 138,66 s |
| **dont appartenant à ce dépôt** | **166 fichiers / 2 436 tests**, ~85 s |
| dont copie périmée `agent-marcel/` | 149 fichiers / ~2 176 tests |
| Tests instables | **1** — `fact-curtain.test.ts:250`, échec 3/3 en isolation |
| Suite d'intégration | non exécutée en CI |
| `tests/unit/infrastructure/` | 1 fichier, 54 lignes — **exécuté par aucun automate** |

### Couverture

| | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|
| **Chiffre affiché** (pollué par `agent-marcel/`) | 86,76 % | 79,31 % | 86,45 % | 88,13 % |
| **Réel — `src/` seul (194 fichiers)** | **85,63 %** | **78,11 %** | **85,26 %** | **87,06 %** |
| `src/shared/security/**` (seuil 85/80/85/85) | 92,60 % | 85,43 % | 92,92 % | 93,44 % ✅ |

Par répertoire (statements / branches, `src/` réel) :

```
src/infrastructure            45,0 %  /  30,6 %   ← point bas
src/api                       67,7 %  /  61,7 %
src/features/conversation     68,4 %  /  58,5 %
src/features/knowledge        73,1 %  /  62,3 %
src/features/employee         87,6 %  /  80,8 %
src/features/recruitment      88,0 %  /  81,6 %
src/features/notification     88,7 %  /  80,9 %
src/features/onboarding       89,4 %  /  79,4 %
src/shared                    91,6 %  /  84,7 %
src/features/document         91,9 %  /  80,8 %
src/features/directory        93,7 %  /  90,1 %
```

**9 fichiers de `src/` sont à 0 % de couverture** (154 statements au total), tous des adaptateurs ou
repositories d'infrastructure — voir §4.

### Coût d'activation des options strictes absentes

| Option | Erreurs | `src/` | `tests/` | Verdict |
|---|---:|---:|---:|---|
| `noFallthroughCasesInSwitch` | **0** | 0 | 0 | **activer maintenant** |
| `noUnusedParameters` | **0** | 0 | 0 | **activer maintenant** |
| `noImplicitReturns` | **0** | 0 | 0 | **activer maintenant** |
| `noImplicitOverride` | 2 | 2 | 0 | activer (effort faible) |
| `verbatimModuleSyntax` | 6 | 6 | 0 | activer (effort faible) |
| `noUnusedLocals` | 20 | **0** | 20 | activer (effort faible) |
| `noUncheckedIndexedAccess` | 82 | **9** | 73 | activer sur `src/` d'abord |
| `exactOptionalPropertyTypes` | 96 | 52 | 44 | par étapes, en commençant par `slack-events.handler.ts` |
| `noPropertyAccessFromIndexSignature` | 323 | — | — | **ne pas activer** |
| `skipLibCheck: false` | 626 (382 = `@mastra/core`) | — | — | **ne pas retirer** |

⚠️ **Note de méthode** : `npx tsc --noEmit --<opt> \| grep -c 'error TS'` rend **0 pour toutes les
options**. `tsc` insère des séquences ANSI entre `error` et `TS`. Le comptage exige `--pretty false`.
