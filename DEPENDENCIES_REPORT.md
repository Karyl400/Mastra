# DEPENDENCIES_REPORT.md

> ⚠️ **INSTANTANÉ HISTORIQUE DU 2026-08-10 — NE PAS LIRE COMME L'ÉTAT COURANT.**
> Produit à l'étape 1 de `REFACTOR_LOOP.md`. Les dépendances ont bougé depuis (`docx` ajouté le 2026-08-11).
> Ce document n'est **pas** mis à jour et n'a pas vocation à l'être : il vaut comme trace de ce
> qui était vrai ce jour-là. Pour l'état réel, dans cet ordre : `npx vercel ls` (ce qui tourne),
> `CLAUDE.md` (le dépôt), `CONTEXT.md` (l'intention), `TODO.md` (les dettes ouvertes).
> Banderole posée le 2026-08-14, après qu'un inventaire a montré que plusieurs de ces fichiers
> décrivaient des agents, des tools et des répertoires supprimés depuis — sans qu'aucun ne le dise.


> Produit à l'**Étape 1** de `REFACTOR_LOOP.md`, le 2026-08-10.
> Branche `refactor/cleanup-20260810`, à partir du checkpoint `checkpoint/prod-20260810`.

---

## 1. Méthode

`depcheck` n'est **pas installé** et n'a pas été ajouté : l'Étape 1.2 de la loop prescrit de toute
façon une vérification croisée par `grep`, qui est la source de vérité — `depcheck` produit des
faux positifs sur les imports dynamiques.

**Exclusions impératives** appliquées à tous les `grep` : `.history/`, `node_modules`, `venv`,
`.netlify`, `.vercel`, `.mastra`, `data`, `.git`.

> ⚠️ `.history/` contient des **copies de fichiers sources** (historique local VSCode). Sans cette
> exclusion, un `grep -r` y trouve des imports qui n'existent plus dans le code vivant, et une
> dépendance morte est conservée à tort. C'est le piège principal de cette étape sur ce dépôt.
> Ces 25 fichiers ont été désindexés au commit `af2c241`.

Contrôles complémentaires, au-delà du grep :

- `npm ls <paquet> --all` — vérifier qu'aucune n'est **transitive** (une suppression de
  `package.json` ne la retirerait pas de l'arbre).
- Balayage des **imports dynamiques** (`await import(…)`, `require(…)` à cible variable) qui
  échappent au grep : 18 sites trouvés, **tous à cible littérale**, aucun ne concerne les cibles.
- **Simulation sur copies** hors dépôt (`npm install --package-lock-only`, hors ligne puis en
  ligne) pour mesurer la dérive du lock avant toute écriture.

---

## 2. Rapport par dépendance

| Paquet | Occurrences code | Transitive ? | Confiance | Classe (loop) | Action |
|---|---|---|---|---|---|
| `@ai-sdk/google` | **0** | non — racine directe | **100 %** | 0 occurrence | ✅ désinstallé |
| `@ai-sdk/openai` | **0** | non — racine directe | **100 %** | 0 occurrence | ✅ désinstallé |
| `@getbrevo/brevo` | **0** | non — racine directe | **100 %** | 0 occurrence | ✅ désinstallé |
| `inngest` | **0** | non — racine directe | **100 %** | 0 occurrence | ✅ désinstallé |
| `@aws-sdk/client-secrets-manager` | 1 (import dynamique) | non — racine directe | 95 % | > 5 % | ⏸️ **reporté à l'Étape 2** |
| `resend` | — | — | — | — | ❎ **déjà absent** |

### Justificatifs

**`@ai-sdk/google` — 0 occurrence.** Seules traces hors `package.json` : des fichiers markdown
(`CHANGELOG.md`, `TODO.md`, `RECAP-PROJET.md`, `docs/adr/001-*.md`). `npm ls --all` →
`kisso-onboarding@0.1.0 └── @ai-sdk/google@3.0.103`, unique branche.

**`@ai-sdk/openai` — 0 occurrence.** Idem, unique branche racine.

**`@getbrevo/brevo` — 0 occurrence.** ⚠️ **Piège à ne pas reproduire** :
`src/features/notification/infrastructure/providers/brevo.adapter.ts` est du **code vivant**
(repli email, câblé dans `src/mastra/index.ts`), mais il **n'utilise pas le SDK** — il appelle
l'API en `fetch` brut sur `https://api.brevo.com/v3/smtp/email`. Un `grep -i brevo` naïf conclut
l'inverse. Le paquet npm est supprimable ; l'adaptateur reste.

**`inngest` — 0 occurrence.** Aucun `from 'inngest'` ni `require('inngest')` dans tout le dépôt
hors `package.json`/`package-lock.json`. Cité comme **piste future** (file durable) dans 8
documents, jamais importé. À lui seul il tirait **202 des 208 entrées supprimées** — tout le
cluster `@opentelemetry/*` d'auto-instrumentation, `protobufjs`, `@grpc/*`, `yargs`,
`@traceloop/*`, `temporal-polyfill`.

> Nuance honnête : une réinstallation ultérieure d'`inngest` ne restaurera **pas les mêmes 202
> versions transitives** — ses dépendances otel utilisent des plages ouvertes
> (`>=0.200.0 <0.300.0`). Sans conséquence puisqu'aucun code ne s'appuie dessus.

**`@aws-sdk/client-secrets-manager` — reporté.** Unique référence :
`src/config/index.ts:62`, `await import('@aws-sdk/client-secrets-manager')` dans
`loadFromSecretsManager()` → appelée par `loadConfig()` → appelée par `getConfig()`, **jamais
appelée**. C'est donc du code mort atteignable uniquement depuis du code mort.

> **Contrainte d'ordre** : `src/config/index.ts` doit être supprimé **avant ou en même temps** que
> le paquet. L'inverse casse le typecheck tant que le fichier existe. La suppression du fichier
> relevant de l'Étape 2, le paquet y est reporté pour que chaque étape reste réversible seule.

**`resend` — correction d'énoncé.** Le paquet **n'est plus dans `package.json`** de l'arbre de
travail, absent de `package-lock.json` et de `node_modules`. Il n'existe que dans HEAD
(`6d2577f`). Aucune action. Unique trace : un commentaire inerte dans
`scripts/fix-vercel-output.js:19`.

---

## 3. Exécution

Deux lots, conformément à l'arbitrage : 202 des 208 suppressions viennent d'`inngest` seul, et
scinder isole immédiatement le coupable en cas d'échec du gatekeeper.

```bash
cp package-lock.json /tmp/lock.before.json          # référence de dérive
npm uninstall @ai-sdk/google @ai-sdk/openai @getbrevo/brevo --offline   # lot 1
npm uninstall inngest --offline                                          # lot 2
```

`--offline` : la simulation a prouvé que le lock converge à l'identique sans accès au registre,
ce qui supprime le risque d'échec réseau en cours de reconstruction d'arbre.

### Anomalie rencontrée et résolue

`npm --dry-run` annonçait **« added 124 packages »**, en contradiction avec la simulation du
Conseil (0 ajout). Exécution suspendue, puis expérience de contrôle :

```
npm install --dry-run --offline   →  « added 124 packages »   (arbre INCHANGÉ)
```

Le compte est **identique dans les quatre scénarios** — lot 1 seul, lot 2 seul, les deux, et une
commande à vide. Ce sont **82 binaires optionnels d'autres plateformes** présents dans le lock
mais jamais installés ici (`darwin-x64`, `win32-x64-msvc`, `freebsd-x64`, `android-arm64`…) : un
seul concerne `linux-x64`. Artefact de comptage préexistant, orthogonal à la suppression.

---

## 4. Dérive mesurée — le contrôle qui compte

Comparaison du lock avant/après, entrée par entrée :

| Métrique | Prédit par la simulation | **Mesuré** |
|---|---|---|
| Entrées supprimées | 208 | **208** ✅ |
| Entrées **ajoutées** | 0 | **0** ✅ |
| **Versions modifiées** | 0 | **0** ✅ |

**Invariant critique préservé** : `zod` reste à **`3.25.76`**, épinglage exact. C'était le seul
scénario qui aurait justifié un NO-GO — le parseur de schémas du Vercel AI SDK casse sur d'autres
versions, ce qui a déjà coûté cinq tentatives de correction au projet.

Autres invariants vérifiés après coup : `@mastra/core@1.57.0`, `@opentelemetry/api@1.9.1`
(importé par 5 fichiers de `src/`), et `pdfkit`/`pdfmake`/`js-md5`/`fontkit` présents.

---

## 5. Gatekeeper — Étape 4

| Contrôle | Baseline | Après lot 1 | Après lot 2 |
|---|---|---|---|
| `npm run typecheck` | 0 erreur | **0 erreur** | **0 erreur** |
| `npm test` | 33 fichiers / 600 tests | **33 / 600** | **33 / 600** |
| `npx eslint src` | 0 erreur, 98 avert. | — | **0 erreur, 98 avert.** |
| `npm run build` | — | — | **exit 0** |

`npm run build` a été ajouté au gatekeeper sur recommandation du Conseil : ni `typecheck` ni les
tests unitaires n'exercent le bundler Mastra ni `verify:bundle`. Résultat :

```
✅ Fermeture transitive (passe 1) : 161 module(s) ajouté(s) au bundle.
✅ Audit du bundle : 637 paquets scannés, aucune dépendance obligatoire manquante.
✅ Module exigé présent : pdfkit@0.19.1 · pdfmake@0.3.11 · js-md5@0.8.3 · fontkit@2.0.4
✅ Chaîne PDF : pdfmake → pdfkit → js-md5 / fontkit / linebreak / png-js  résolus.
✅ Smoke test PDF depuis le bundle : 7082 octets, en-tête %PDF- valide.
```

**Aucun échec. Aucun arrêt d'urgence déclenché.**

---

## 6. Bilan

| Indicateur | Avant | Après | Δ |
|---|---|---|---|
| Dépendances déclarées | 29 | **25** | −4 |
| Entrées du lock | 1 128 | **920** | **−208** |
| Vulnérabilités **high** | **1** | **0** | **−1** |
| Vulnérabilités *moderate* | 7 | 4 | −3 |
| Vulnérabilités *low* | 1 | 2 | +1 |
| **Total advisories** | **9** | **6** | **−3** |

**Le gain le plus significatif n'était pas prévu explicitement** : `undici@5.29.0` — l'**unique
vulnérabilité *high*** du projet, 12 advisories cumulées (smuggling de requêtes, injection CRLF,
empoisonnement de file de réponses, épuisement mémoire) — n'était tiré que par `@ai-sdk/google`.
Sa disparition est un effet de bord de la suppression, sans aucune modification de code.

### Vulnérabilités restantes (6) — hors périmètre de cette étape

| Sévérité | Paquet | Nature |
|---|---|---|
| moderate | `drizzle-kit` (directe) | correctif **majeur** requis |
| moderate | `esbuild`, `@esbuild-kit/core-utils`, `@esbuild-kit/esm-loader` | chaîne transitive de `drizzle-kit` |
| low | `@mastra/core` (directe) | plage d'advisory ≤ `0.24.10-alpha.0` alors que la version installée est `1.57.0` — **vraisemblablement un faux positif** de résolution de plage |
| low | `@ai-sdk/provider-utils` | transitive |

Les quatre premières ne se règlent pas isolément : il faut monter `drizzle-kit` d'une version
majeure. Décision distincte, hors refactoring.

---

## 7. Rollback disponible

Vérifié avant exécution : `package.json` et `package-lock.json` étaient propres vis-à-vis de HEAD,
et identiques entre `af2c241` et le tag `checkpoint/prod-20260810`.

```bash
git checkout -- package.json package-lock.json
npm ci --offline
npm run typecheck && npm test && npm run build
```

Filet de secours : `cp /tmp/lock.before.json package-lock.json && npm ci`.
Recours ultime : le tag `checkpoint/prod-20260810`, poussé sur `origin`.
