# DEAD_CODE_REPORT.md

> ⚠️ **INSTANTANÉ HISTORIQUE DU 2026-08-10 — NE PAS LIRE COMME L'ÉTAT COURANT.**
> Produit à l'étape 2 de `REFACTOR_LOOP.md`. Une large part de ce qu'il signalait a depuis été supprimée — et d'autres morceaux sont morts après lui, donc il est à la fois périmé et incomplet.
> Ce document n'est **pas** mis à jour et n'a pas vocation à l'être : il vaut comme trace de ce
> qui était vrai ce jour-là. Pour l'état réel, dans cet ordre : `npx vercel ls` (ce qui tourne),
> `CLAUDE.md` (le dépôt), `CONTEXT.md` (l'intention), `TODO.md` (les dettes ouvertes).
> Banderole posée le 2026-08-14, après qu'un inventaire a montré que plusieurs de ces fichiers
> décrivaient des agents, des tools et des répertoires supprimés depuis — sans qu'aucun ne le dise.


> Produit à l'**Étape 2** de `REFACTOR_LOOP.md`, le 2026-08-10.
> Branche `refactor/cleanup-20260810`, commits `a707244`, `1fb8a58`, `ab56831`.

---

## 1. Méthode

Croisement des fichiers sources avec leurs imports entrants, **en excluant impérativement**
`.history/`, `node_modules`, `venv`, `.netlify`, `.vercel`, `.mastra`, `data`, `.git`.

> ⚠️ `.history/` contient des **copies de fichiers sources**. Sans cette exclusion, un `grep -r`
> y trouve des imports morts et déclare « encore utilisé » un fichier orphelin. Ces 25 fichiers
> ont été désindexés au commit `af2c241`.

Chaque suppression a été suivie du gatekeeper (`typecheck` + `npm test`), avec arrêt immédiat
prévu en cas d'échec. Aucun arrêt n'a été déclenché.

---

## 2. Code mort éliminé

### 2.A — Doublons `html-sanitizer` *(commit `a707244`)*

| Fichier | Preuve |
|---|---|
| `src/shared/security/html-sanitizer` *(sans extension)* | Ancienne version de `html-sanitizer.ts`. Les 4 consommateurs (`task.dto.ts`, `employee.dto.ts`, `create-employee.ts`, `validation.ts`) importent `'…/html-sanitizer.js'`. En `moduleResolution: bundler`, TypeScript ne teste que `.ts` / `.tsx` / `.d.ts` — ce fichier n'était **ni compilé, ni linté, ni importable**. |
| `src/shared/security/html-sanitizer.ts~` | Backup d'éditeur, commité seul par le commit nommé `correction4`. Version obsolète basée sur `isomorphic-dompurify`, paquet désinstallé depuis. |

### 2.B — `src/config/` *(commit `a707244`)*

Code mort avéré : `getConfig()`, `resetConfig()`, `ConfigSchema` et le type `Config` n'ont
**aucun consommateur** hors du fichier lui-même. L'alias `@config/*` a 0 usage. Le répertoire ne
contenait que `index.ts` — supprimé en entier.

Trois défauts qui confirment qu'il n'aurait pas pu être branché tel quel :
- son schéma `database.url` rejette `libsql://` **dans ses deux branches**, alors que c'est la
  valeur réelle en production ;
- il importait `@aws-sdk/client-secrets-manager`, **absent de `package.json`** avant cette étape ;
- `.strict()` combiné à `openai.apiKey.min(1)` aurait fait échouer le boot.

**Dépendance libérée** : `@aws-sdk/client-secrets-manager`, dont l'unique référence était le
`await import()` de la ligne 62. **23 entrées de lock** retirées.

> **Ordre imposé, et il l'est réellement** : le fichier supprimé **avant** le paquet. L'inverse
> produit `TS2307: Cannot find module` sur l'import dynamique tant que le fichier existe, donc
> `typecheck` rouge, donc `build:prod` rouge.

### 2.C — 381 assertions placeholders *(commit `1fb8a58`)*

Cinq fichiers **100 % placeholders**, vérifié par comptage : dans chacun, *nombre de blocs `it()`*
= *nombre d'appels `expect()`* = *nombre de `expect(true).toBe(true)`*, et aucun n'importait le
moindre module de `src/` — leur seul `import` était `{ describe, it, expect } from 'vitest'`.

| Fichier supprimé | Assertions | Réelles |
|---|---|---|
| `tests/unit/workflows/workflows-e2e.test.ts` | 98 | **0** |
| `tests/unit/quality/code-architecture.test.ts` | 98 | **0** |
| `tests/unit/security/llm-guardrail.extended.test.ts` | 85 | **0** |
| `tests/unit/infrastructure/infra-db.test.ts` *(exclu du run unitaire)* | 99 | **0** |
| `tests/unit/setup.test.ts` | 1 | **0** |
| **Total** | **381** | **0** |

**Conversion en `it.todo()` écartée.** Les noms sont des compteurs générés
(`103. Test case for Workflows E2E & State Machines`, `104.`, `105.`…), sans intention
documentée. Les convertir aurait remplacé un mensonge sur la couverture par un mensonge sur la
roadmap.

### 2.D — Répertoires vides *(aucun commit)*

Huit vestiges de la refonte « Screaming Architecture » :

```
src/application/use-cases                     src/prompts
src/features/employee/application/workflows   src/shared/utils
src/features/notification/domain/value-objects  src/workflows
src/mastra/public/data                        tests/e2e
```

**Aucun commit produit** : git ne versionne pas les répertoires vides, donc ils n'existaient déjà
pas dans le checkout CI. Nettoyage du working copy local uniquement. Ils étaient trompeurs — on
cherche les workflows dans `src/workflows/`, ils sont dans `src/features/*/application/workflows/`.

### 2.E — `api/index.ts` *(commit isolé `ab56831`)*

Le seul point qui n'était pas tranchable statiquement.

**Ce n'était pas un vestige inoffensif — le fichier n'aurait jamais pu fonctionner :**

```ts
import { mastra } from '../src/mastra/index';   // spécifieur SANS extension
export default mastra;                          // un OBJET, pas une fonction
```

Deux erreurs fatales indépendantes : le paquet est `"type": "module"`, donc un spécifieur relatif
sans extension lève `ERR_MODULE_NOT_FOUND` sous Node ESM ; et une fonction Vercel Node exige un
export par défaut **callable**, or `mastra` est une instance. Il piégeait le prochain lecteur en
se présentant comme le point d'entrée Vercel.

**Validation par preuve différentielle locale**, sans aucun contact avec la production :

```
build AVEC api/   → manifeste .vercel/output : 51 631 lignes
build SANS api/   → manifeste .vercel/output : 51 631 lignes
diff              → IDENTIQUES
```

Le manifeste comprend la liste triée des fichiers de sortie, le contenu de `config.json` et celui
de `.vc-config.json`.

> **Le déploiement preview a été explicitement écarté comme méthode de validation.**
> `DATABASE_URL` et `DATABASE_AUTH_TOKEN` étaient scopés `Production, Preview` : un preview aurait
> booté contre la **Turso de production**, et `LibSQLStore` y initialise ses tables au démarrage —
> ce n'est pas une connexion passive. Ce scope a été corrigé séparément (voir §5).

---

## 3. Le garde-fou d'architecture — réparé, pas supprimé *(commit `1fb8a58`)*

`tests/unit/quality/architecture.test.ts` était le **seul fichier mixte** du lot : un test réel
(401) et un placeholder assumé (421).

**L'ancienne version ne verrouillait rien :**
- le test 401 ne scannait que `src/features/employee/domain` — **5 fichiers sur 20**, une feature
  sur cinq ;
- sa détection était un `content.includes()` sur le texte brut : un commentaire contenant le mot
  « infrastructure » l'aurait fait échouer à tort, tandis qu'un `import { Agent } from
  '@mastra/core'` serait passé sans bruit ;
- le test 421 se terminait littéralement par
  `// For the sake of the exercise, we will assert true here, and assume it passes`.

**La nouvelle version** découvre les features dynamiquement, parse les **quatre formes réelles**
de dépendance (`import … from`, `export … from`, `import()`, `require()`), et échoue en listant
les coupables. Elle embarque une **méta-assertion anti-faux-négatif** : si le scan cesse de
trouver des fichiers, le garde-fou casse au lieu de passer au vert à vide.

**Validée par test de mutation** — un garde-fou qui passe ne prouve rien s'il ne peut pas échouer :

| Mutation injectée dans `domain/entities/employee.ts` | Résultat |
|---|---|
| `import { Agent } from '@mastra/core/agent'` | ✅ détecté, fichier et import nommés |
| `import … from '../../infrastructure/repositories/…'` | ✅ détecté |

Fichier restauré à l'identique après chaque mutation, 3/3 verts.

> `CLAUDE.md` affirme depuis l'origine que « deux tests garde-fou verrouillent cette règle ».
> C'était faux : l'un était vide, l'autre couvrait une feature sur cinq. **C'est vrai à partir de
> ce commit.** Cette ligne de `CLAUDE.md` reste à corriger.

Résultat du scan sur l'état actuel : **20 fichiers `domain/` sur 5 features, 0 violation**.

---

## 4. Baseline recalibrée

| Contrôle | Avant | Après |
|---|---|---|
| `npm run typecheck` | 0 erreur | **0 erreur** |
| `npm test` — fichiers | 33 | **29** |
| `npm test` — tests | 600 | **319** |
| `npx eslint src` | 0 erreur, 98 avert. | à remesurer |
| `npm run build` | exit 0 | **exit 0** |

**Le chiffre honnête est plus bas ; il n'est pas moins bon.** 600 comprenait 283 assertions qui
n'exécutaient aucune ligne de `src/`. Toute comparaison ultérieure doit partir de **319 / 29**.

---

## 5. Hors périmètre, traité en cours de route

Un audit de l'environnement Vercel, déclenché par l'analyse d'`api/index.ts`, a révélé que
**`DATABASE_URL`, `DATABASE_AUTH_TOKEN` et `SLACK_BOT_TOKEN` étaient accessibles aux déploiements
preview** — et que les previews Git sont actifs. Chaque push de branche déployait donc contre la
base de production.

Corrigé :

| Action | Résultat |
|---|---|
| Secrets re-scopés `Production` seule | 8 variables (`DATABASE_*`, `SLACK_BOT_TOKEN`, `SMTP_*`) |
| Variables mortes supprimées | `RESEND_API_KEY`, `GOOGLE_GEMINI_API_KEY`, `SLACK_USER_TOKEN`, `OPENAI_API_KEY` |
| Déploiements preview supprimés | 5 |
| Variables Vercel | 19 → **14** |

**Piège découvert** : `vercel env rm NOM preview` sur une variable dont l'entrée **unique** couvre
deux environnements supprime **l'entrée entière**, production comprise. Il faut supprimer puis
ré-ajouter avec la portée voulue. Sur une variable ayant des **entrées séparées** par
environnement, le retrait est en revanche chirurgical. Le test a été mené sur `SLACK_BOT_TOKEN`
— le moins critique des trois — ce qui a transformé une panne potentielle en restauration de
neuf secondes.

---

## 6. Restant identifié, non traité

| Élément | Pourquoi non traité |
|---|---|
| **Alias `tsconfig.json`** — les 5 ont **0 usage réel** | `tsconfig.json` est un fichier de configuration ; hors périmètre sans instruction explicite. ⚠️ **`@mastra/*` → `src/mastra/*` shadowe le scope npm `@mastra/core`** : inoffensif uniquement parce que `src/mastra/core.ts` n'existe pas. Créer ce fichier casserait le projet d'un coup. `@domain/*` et `@config/*` pointent désormais vers du vide. |
| `tests/security/llm-gateway/llm-guardrail.test.ts` — 5 tests de théâtre | Ramassé par le run unitaire alors qu'il vit hors de `tests/unit/`. `validateLLMOutput` y est la **fonction identité**, puis testée avec `.toBeDefined()`. Les tests « should block system prompt leakage » et « should block secret leakage » **ne bloquent rien et ne peuvent pas échouer**. Non validé par l'utilisateur. |
| Trous de couverture de `llm-guardrail.ts` | Préexistants, non créés par cette étape. API publique jamais testée : `wrapExternalData()`, `assembleSecurePrompt()`, `SystemPromptVault`, `DelimiterGenerator`, **`KeyManager`** — précisément la classe où `KEY_ITERATIONS = 100000` levait `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`. Corrigé à `16384`, **toujours pas verrouillé par un test**. |
| 6 vulnérabilités npm restantes | 4 forment la chaîne `drizzle-kit → @esbuild-kit/* → esbuild` : correctif **majeur** requis, décision distincte. |
| `.env.local` dans l'historique git | Retiré du suivi, mais présent dans les commits antérieurs poussés sur `origin`. Le jeton OIDC qu'il contient est expiré. Une purge (`filter-repo`) est une opération distincte. |

---

## 7. Rollback

| Cible | Commande |
|---|---|
| `api/index.ts` | `git revert ab56831` |
| Tests placeholders + garde-fou | `git revert 1fb8a58` |
| `src/config` + `@aws-sdk` | `git revert a707244` puis `npm install` |
| Dépendances (Étape 1) | `git revert b55bbdf` puis `npm install` |
| Répertoires vides | `mkdir -p …` — aucun état git à restaurer |
| **Global** | `git reset --hard checkpoint/prod-20260810` puis `npm ci` |

Le tag `checkpoint/prod-20260810` est poussé sur `origin`. Une sauvegarde hors git existe dans
`~/kisso-safety-20260810-095359` (archive du worktree, bundle git complet, `.env`, base SQLite
consolidée avec son WAL).
