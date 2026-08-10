# REFACTOR_PLAN.md — Plan de refactoring

> Produit à l'**Étape 0** de `REFACTOR_LOOP.md`. Statut : **EN ATTENTE DE VALIDATION**.
> Aucune modification n'a été effectuée. Aucun commit, aucune branche, aucune suppression.
>
> Établi le 2026-08-10 sur `/home/karyl/mastra`, branche `main` @ `6d2577f`.

---

## ⛔ Trois blocages à lever avant toute exécution

Le workflow de `REFACTOR_LOOP.md` ne peut pas être appliqué littéralement sur ce dépôt. Trois de
ses commandes causeraient une perte de données ou une fausse analyse. Je les signale avant tout
le reste, conformément à la règle « mieux vaut ne rien faire que de casser le build ».

### Blocage 1 — `git commit -am` NE SAUVEGARDERAIT PAS le code de production 🔴

**C'est le point le plus grave du dossier.**

Ce dépôt est dans un état atypique, établi et vérifié : **le code déployé en production n'existe
dans aucun commit**. `HEAD` instancie `new ResendAdapter(...)` et journalise
`process.env.RESEND_API_KEY` en clair, alors que la production envoie démontrablement par SMTP. Le
déploiement a donc été poussé depuis le répertoire local, pas depuis git.

État réel de l'arbre de travail :

| Catégorie | Nombre |
|---|---|
| Fichiers **non suivis** (`??`) | **37** |
| Fichiers modifiés (`M`) | 24 |
| Fichiers ajoutés (`A`) | 3 |
| Fichiers supprimés (`D`) | 2 |

`git commit -am` ne stage **que les fichiers déjà suivis**. Les 37 fichiers non suivis — dont
`src/api/slack-events.route.ts`, `src/shared/llm/model-fallback.ts`, les adaptateurs SMTP/Brevo,
les handlers Slack — **ne seraient pas sauvegardés**. Le checkpoint censé protéger le refactoring
laisserait dehors précisément ce qui tourne en production.

**Correctif proposé** : `git add -A` avant le commit. Voir la procédure §2.

### Blocage 2 — trois artefacts sont suivis par git et seraient re-commités 🟠

`.gitignore` les liste pourtant tous les trois. Mais **gitignore ne s'applique pas à un fichier
déjà indexé**.

| Chemin | Fichiers indexés | Problème |
|---|---|---|
| `.env.local` | 1 | contient un `VERCEL_OIDC_TOKEN` — poussé sur `origin/main` |
| `.history/` | **25** | historique local VSCode : instantanés de `fix-vercel-output.js` et `src/mastra/index.ts` |
| `lint_output.txt` | 1 | 16 Ko de sortie de lint |

**Vérification effectuée** : aucun motif de secret (`xoxb-`, `gsk_`, `xkeysib-`, JWT, URL libsql
avec token) dans les 25 fichiers `.history` indexés. Le risque n'est donc pas une fuite, c'est de
la pollution — et un piège d'analyse (voir blocage 3).

**Correctif proposé** : `git rm --cached` sur les trois **avant** le commit de checkpoint, sans
quoi le checkpoint les grave à nouveau dans l'historique.

### Blocage 3 — `.history/` fausserait toute analyse de code mort 🟠

`.history/` contient **des copies de fichiers sources**. Un `grep -r` de vérification croisée —
exactement ce que prescrit l'Étape 1.2 de la loop — y trouverait des imports et des références qui
n'existent plus dans le code vivant.

**Conséquence directe** : une dépendance réellement morte serait déclarée « encore utilisée » et
conservée à tort ; un fichier orphelin paraîtrait importé.

**Correctif proposé** : toute commande d'analyse exclut explicitement
`.history`, `node_modules`, `venv`, `.netlify`, `.vercel`, `.mastra`, `dist`, `data`.

---

## 1. Cartographie

### Volumétrie

| Zone | Contenu |
|---|---|
| `src/` | 82 fichiers TS, 10 639 lignes, 5 features + transverse |
| `tests/` | 39 fichiers de test |
| `scripts/` | 10 scripts (build, smoke, production) |
| `docs/` | 11 ADR + 3 guides + setup Slack |
| Racine | 13 fichiers `.md`, 8 fichiers de config |

### Poids disque non versionné

| Répertoire | Taille | Suivi par git | Commentaire |
|---|---|---|---|
| `venv/` | **358 Mo** | non | virtualenv Python (semgrep, mcp) — hors périmètre du projet Node |
| `.netlify/` | **113 Mo** | non | artefacts Netlify — **le projet déploie sur Vercel** |
| `ngrok` + `.tgz` | **45 Mo** | non | binaire de tunnel + son archive |
| `.history/` | 1,5 Mo | **25 fichiers oui** | historique VSCode |
| `data/` | 2,1 Mo | non | bases SQLite + 15 PDF générés |

**~516 Mo d'artefacts non versionnés à la racine.** Leur suppression disque est hors du périmètre
« refactoring » au sens strict — je la propose en option, séparément.

### Répertoires vides (8)

```
src/application/use-cases                          src/prompts
src/features/employee/application/workflows        src/shared/utils
src/features/notification/domain/value-objects     src/workflows
src/mastra/public/data                             tests/e2e
```

Vestiges de la structure pré-refonte « Screaming Architecture ». Trompeurs : on cherche les
workflows dans `src/workflows/`, ils sont dans `src/features/*/application/workflows/`.

### Plans existants

L'Étape 0.2 demande de scanner les `.md`. Résultat : **il n'existait pas de `REFACTOR_PLAN.md`**,
d'où ce document. Mais plusieurs plans existent et se recoupent avec ce refactoring :

| Fichier | Contenu pertinent |
|---|---|
| `TODO.md` | section « À faire » — purge de config morte, migrations, Node |
| `COMPETENCES_ET_ANALYSE.md` | P12 « Hygiène et dette » — liste déjà les dépendances mortes |
| `PLAN-ARCHITECTURE.md` | lots 0-10 — chevauche l'Étape 3 (découpage) |
| `CLAUDE.md` | pièges connus — **à lire avant toute modification** |

---

## 2. Étape 0.3 — Checkpoint git (procédure corrigée)

Proposition, à valider :

```bash
# 1. Désindexer les artefacts qui ne doivent plus être suivis
git rm --cached .env.local
git rm --cached -r .history
git rm --cached lint_output.txt

# 2. Créer la branche de travail
git checkout -b refactor/cleanup-20260810

# 3. Tout sauvegarder — y compris les 37 fichiers non suivis
git add -A
git commit -m "WIP: checkpoint before destructive cleanup

Sauvegarde de l'arbre de travail complet avant refactoring.
Inclut ~2900 lignes non commitées correspondant au code réellement
déployé en production (endpoint Slack, chaîne LLM de repli, provider SMTP).

Désindexe .env.local, .history/ et lint_output.txt, déjà couverts par
.gitignore mais restés suivis."
```

**Ce que ce commit fait, et qu'il faut accepter en connaissance de cause :**

- ✅ Il sauvegarde enfin le code de production — aujourd'hui un `git checkout .` le détruirait.
- ✅ Il retire `.env.local` du suivi (le jeton OIDC qu'il contient est expiré ; le risque était
  qu'un futur `vercel env pull` en régénère un valide et qu'un `git add -A` le recommette).
- ⚠️ Il **ne purge pas l'historique** : les anciens commits contiennent toujours `.env.local`.
  Une purge (`filter-repo`) est une opération distincte, à décider séparément.
- ⚠️ Il commite aussi les 13 `.md` de racine et les scripts non suivis. Si vous préférez un
  checkpoint plus étroit, dites-le — mais je le déconseille : l'intérêt du checkpoint est
  précisément de tout figer.

---

## 3. Étape 1 — Dépendances

### Outillage : `depcheck` n'est pas installé

Ni `depcheck`, ni `ts-prune`, ni `knip`. Les utiliser via `npx` implique un téléchargement réseau
et, pour certains, un ajout en `devDependencies`.

**Proposition** : s'en passer. L'Étape 1.2 de la loop prescrit de toute façon une **vérification
croisée par `grep`**, qui est la source de vérité — `depcheck` produit des faux positifs sur les
imports dynamiques et les plugins. L'analyse par grep a déjà été menée et est reproductible.

Si vous préférez exécuter `depcheck` malgré tout, dites-le : c'est une commande, mais elle ajoute
une dépendance réseau au processus.

### Analyse déjà établie (à re-vérifier au moment de l'exécution)

| Paquet | Occurrences dans `src/` + `scripts/` | Classe loop | Action |
|---|---|---|---|
| `@ai-sdk/google` | **0** | 0 occurrence | désinstaller |
| `@ai-sdk/openai` | **0** | 0 occurrence | désinstaller |
| `inngest` | **0** | 0 occurrence | désinstaller |
| `@getbrevo/brevo` | **0** | 0 occurrence | désinstaller — l'adaptateur Brevo appelle l'API en `fetch` brut, le SDK n'est jamais importé |
| `resend` | ? | à revérifier | ⚠️ `resend.adapter.ts` existe dans HEAD mais est **supprimé dans l'arbre de travail** — statut à trancher après le checkpoint |
| `@aws-sdk/client-secrets-manager` | 1 (import dynamique) | > 5 % | ⚠️ atteignable **uniquement** depuis `src/config/index.ts`, qui est du code mort. Traiter à l'Étape 2, pas ici |

**Bénéfice non évident** : `@ai-sdk/google` et `@ai-sdk/openai` portent chacun une vulnérabilité
`moderate`. Les retirer fait tomber **2 des 9 advisories** sans toucher une ligne de code.

**Point de validation (Étape 1.5)** : `DEPENDENCIES_REPORT.md` sera produit avec le taux de
confiance par paquet, et je m'arrêterai avant toute désinstallation.

---

## 4. Étape 2 — Code mort

### Cibles à confiance élevée

| Cible | Preuve | Risque |
|---|---|---|
| `src/shared/security/html-sanitizer` (sans extension) | doublon de `html-sanitizer.ts`, jamais importé | nul |
| `src/shared/security/html-sanitizer.ts~` | backup d'éditeur commité par erreur | nul |
| 8 répertoires vides | `find -type d -empty` | nul |
| `lint_output.txt` | artefact de sortie | nul |
| `conversation_summary.md` | ? | à qualifier |

### Cibles à trancher — je ne les toucherai pas sans accord explicite

| Cible | Pourquoi c'est délicat |
|---|---|
| **`api/index.ts`** (racine, 3 lignes) | Ré-exporte `src/mastra/index`. **Aucune référence** dans `src/`, `tests/`, `scripts/`, `vercel.json`. Probablement un vestige : `vercel.json` déclare `outputDirectory: .vercel/output` et `framework: null`, donc la convention Vercel `api/` ne devrait pas s'appliquer. **Mais si elle s'applique encore, sa suppression casse le déploiement.** Test requis avant suppression. |
| **`src/config/index.ts`** (70 lignes) | Code mort avéré : `getConfig()` sans appelant, schéma `database.url` qui rejette `libsql://`, et import de `@aws-sdk/client-secrets-manager` **absent de `package.json`**. Le supprimer libère aussi la dépendance AWS. Mais c'est une intention d'architecture — à supprimer ou à réécrire, pas les deux. |
| **283 assertions `expect(true).toBe(true)`** | Techniquement du code mort (47 % de la suite). Les retirer fait passer le compteur de 600 à ~317 tests. **Décision politique autant que technique** — hors périmètre par défaut, à confirmer. |
| **`drizzle/` (2 migrations)** | Désynchronisées de `schema.ts` (11 colonnes contre 20). Ni mortes ni fonctionnelles. **Ne pas toucher** dans ce refactoring. |

### Méthode

Croisement des fichiers sources avec les imports entrants, **en excluant** `.history`,
`node_modules`, `venv`, `.netlify`, `.vercel`, `.mastra`, `data`. Rapport dans
`DEAD_CODE_REPORT.md`, puis arrêt pour validation.

---

## 5. Étape 3 — Découpage architectural

### Cibles détectées par volumétrie

| Fichier | Lignes | Observation |
|---|---|---|
| `src/shared/security/llm-guardrail.ts` | **1 078** | le plus gros du projet, devant le schéma de base |
| `src/shared/validation.ts` | 817 | |
| `src/features/employee/application/tools/create-employee.ts` | 647 | |
| `src/shared/logger.ts` | 609 | |
| `src/shared/retry.ts` | 584 | |
| `src/infrastructure/database/schema.ts` | 561 | déclaratif — **ne pas découper** |
| `src/features/employee/application/dtos/task.dto.ts` | 556 | |

`src/shared/` pèse **4 294 lignes, soit 40 % du code** — presque autant que les cinq features
réunies. C'est le vrai gisement de cette étape.

### Réserve importante

L'Étape 3 est la seule **destructive et à haut risque** de la loop : elle déplace du code et
réécrit des imports. Or ce dépôt a deux caractéristiques qui l'aggravent :

1. **Les garde-fous d'architecture ne gardent rien.** `tests/unit/quality/code-architecture.test.ts`
   ne contient que des placeholders, et `architecture.test.ts` écrit littéralement
   `// we will assert true here, and assume it passes`. Un déplacement qui violerait la règle de
   dépendance **ne serait détecté par aucun test**.
2. **47 % de la suite ne teste rien.** Le filet de sécurité du refactoring est deux fois plus fin
   que le compteur ne le laisse croire.

**Recommandation** : ne pas exécuter l'Étape 3 avant d'avoir réparé le garde-fou d'architecture
(~40 lignes). Sinon le refactoring se ferait sans filet, sur le module de sécurité le plus
sensible du projet.

---

## 6. Étape 4 — Gatekeeper : deux corrections nécessaires

### `npm test` est sûr — vérifié

```
test  = vitest run          ← unitaires uniquement, PAS d'accès réseau
```

✅ Utilisable comme gatekeeper.

### ⛔ `npm run test:integration` ne doit JAMAIS être lancé automatiquement

Il **frappe le déploiement de production**, crée de vrais employés dans la Turso de production,
consomme du quota LLM réel et peut déclencher des envois. Il est explicitement hors du gatekeeper.

### ⚠️ `eslint . --fix` est dangereux ici — correction proposée

La loop prescrit `eslint . --fix`. Le projet définit `lint = eslint src --ext .ts || true`.

Trois problèmes :

1. **`.` au lieu de `src`** ferait linter `venv/` (358 Mo), `.history/`, `.netlify/`, `data/`,
   `scripts/`.
2. **`--fix` modifie les fichiers** — sur 98 avertissements, dont 12 concernent des regex de
   sécurité (`detect-unsafe-regex`, `super-linear-regex`) dans `llm-guardrail.ts`. Une correction
   automatique sur le module anti prompt-injection est exactement ce qu'il ne faut pas faire sans
   relecture.
3. **`|| true`** : le lint du projet ne peut structurellement pas échouer. Comme gatekeeper, il ne
   garde rien.

**Proposition** : gatekeeper = `npm run typecheck && npm test`, et `eslint src` **sans `--fix`**,
en lecture seule, dont la sortie est rapportée. Toute correction de lint devient une action
explicite et validée.

---

## 7. Ordre d'exécution proposé

| # | Action | Destructif ? | Validation requise |
|---|---|---|---|
| 0 | Checkpoint git corrigé (§2) | non | **oui — c'est le blocage 1** |
| 1 | Baseline : `typecheck` + `test` + `lint` → chiffres de référence | non | non |
| 2 | Suppression des répertoires vides et fichiers déchets | oui, trivial | oui |
| 3 | `DEPENDENCIES_REPORT.md` → désinstallation des 4 paquets à 0 occurrence | oui | **oui (Étape 1.5)** |
| 4 | `DEAD_CODE_REPORT.md` → suppression des fichiers orphelins | oui | **oui (Étape 2)** |
| 5 | Réparer le garde-fou d'architecture (~40 l.) | non | oui |
| 6 | Étape 3 — découpage SRP, un fichier à la fois | **oui, à risque** | **oui, par fichier** |

Gatekeeper après **chaque** action de 2 à 6 : `npm run typecheck && npm test`. Arrêt immédiat au
premier échec, stack trace affichée, correctif proposé, attente de votre feu vert.

---

## 8. Ce que je ne ferai pas sans instruction explicite

- Toucher `package.json`, `tsconfig.json`, `vercel.json`, `eslint.config.js`, `drizzle.config.ts`
  autrement que par `npm uninstall` validé.
- Supprimer `api/index.ts` avant vérification du comportement de déploiement.
- Purger l'historique git (`filter-repo`) — opération irréversible sur les commits existants.
- Toucher `drizzle/`.
- Supprimer les 283 tests placeholders.
- Lancer `test:integration`, `smoke:email`, `test:scenarios` — tous à effet de bord réel.
- Supprimer `venv/`, `.netlify/`, `ngrok` du disque (hors périmètre refactoring, proposé en option).
- Exécuter `eslint --fix`.

---

## 9. Décisions attendues

Rien ne démarre sans vos réponses.

| # | Décision | Options |
|---|---|---|
| **A** | **Checkpoint git** — validez-vous la procédure corrigée du §2 (`git rm --cached` × 3, puis `git add -A`) ? | oui / checkpoint plus étroit / autre |
| **B** | **`depcheck`** — l'installer via `npx` (réseau), ou s'en tenir à la vérification croisée par `grep` ? | grep seul (recommandé) / installer depcheck |
| **C** | **Étape 3 (découpage)** — l'exécuter maintenant, ou après réparation du garde-fou d'architecture ? | après réparation (recommandé) / maintenant / reporter |
| **D** | **Gatekeeper** — acceptez-vous `typecheck + test` avec `eslint` en lecture seule, sans `--fix` ? | oui / imposer `--fix` |
| **E** | **Périmètre optionnel** — traite-t-on les 516 Mo d'artefacts disque (`venv`, `.netlify`, `ngrok`) ? | oui / non / plus tard |

---

**Statut : aucune modification effectuée. En attente de validation.**
