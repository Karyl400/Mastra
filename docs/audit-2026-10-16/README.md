# Audit complet — 2026-10-16

Branche `refactor/cleanup-20260810`, arbre de travail avec 12 fichiers modifiés non commités.
Toutes les valeurs ci-dessous ont été **mesurées ce jour** ; la commande est donnée à côté.
Le référentiel de règles (MUST/SHOULD/MAY) est `REGLES.md` à la racine, non versionné.

## 1. Mesures

| Contrôle | Commande | Résultat |
|---|---|---|
| Typage | `npx tsc --noEmit` | ✅ 0 erreur (`src`, `tests`, `scripts`) |
| Lint | `npm run lint` | ✅ 0 erreur, 0 warning |
| Format | `npm run format:check` | ❌ 2 fichiers (dont `src/shared/cancel-reminder.ts`) — **CI rouge** |
| Tests | `npx vitest run` | ❌ 2 995 / 2 996 — `design-docs-anchor-right-file.test.ts` (lié au WIP de `docs/conception/notification.md`) |
| Taille `src/` | — | 352 fichiers, 26 308 lignes, aucun fichier > 200 lignes |
| Fonctions > 100 lignes | AST TypeScript | ❌ **20** (51 au-delà de 60) |
| Cycles | `npx madge --circular --extensions ts src` | ❌ **3** |
| `any` | grep | ✅ 0 |
| `as unknown as` | grep | ⚠️ 6 |
| Directives (`eslint-disable`, `@ts-expect-error`) | grep | ⚠️ 21 (CLAUDE.md en annonce 10) |
| `process.env` | grep | ❌ lu dans 22 fichiers, aucun schéma central |
| `noUncheckedIndexedAccess` | `tsc --noUncheckedIndexedAccess` | 99 erreurs si activé |
| `exactOptionalPropertyTypes` | idem | 122 erreurs si activé |
| Vulnérabilités prod | `npm audit --omit=dev` | ❌ 21 (1 critique, 15 hautes, 5 modérées) |
| En-têtes HTTP de sécurité | grep | ❌ aucun (CSP/HSTS/nosniff) |

## 2. Ce qui fonctionne — de source sûre

Mesuré ce jour, pas recopié :
- **TypeScript strict complet** (`strict`, `noImplicitReturns`, `noUnused*`, `noImplicitOverride`,
  `verbatimModuleSyntax`), zéro `any`, `scripts/` inclus dans le typage.
- **Lint réellement bloquant** : `typescript-eslint` + `eslint-plugin-security` + `sonarjs`, 0/0.
- **Architecture par feature** (domain / application / infrastructure), règle de dépendance
  verrouillée par `tests/unit/quality/architecture.test.ts`, `shared/` inclus.
- **Plus aucun fichier > 200 lignes** dans `src/` (le handler de 2 912 lignes a été éclaté).
- **Suite de tests large** (206 fichiers, 2 996 tests) avec contrats partagés in-memory / Drizzle.
- **CI complète** (`ci.yml` : lint → format → typecheck → test → build) et pre-commit lint-staged.
- **Sécurité applicative sérieuse** : HMAC Slack à temps constant, garde `requestContext`,
  rédaction des instructions sur `/api/agents*`, garde d'exécution d'outils, routes cron et
  dashboard fail-closed, CORS `origin: []`, `maskPii`, anti-énumération, quarantaine des outils.
- **Doctrine « dériver plutôt que recopier »** (câblage agents→outils, frontière négative,
  chaîne de modèles) — c'est la meilleure propriété du dépôt.

## 3. Ce qui ne fonctionne pas

### P0 — bloquant, à corriger avant tout autre lot

1. **CI rouge aujourd'hui** : `format:check` échoue et un test de cohérence doc échoue. Le WIP
   non commité ne peut pas être poussé en l'état.
2. **`.gitignore` : le diff non commité supprime `/*.md`.** Les 17 `.md` racine passent en
   « non suivis » ; un `git add .` versionnerait `AUDIT_REPORT.md`, `CLAUDE.md`,
   `conversation_summary.md`, etc. — à l'encontre de la décision du 2026-08-20.
3. **La validation de démarrage ignore le LLM primaire.** `src/shared/startup-env-check.ts`
   liste `GROQ_API_KEY` comme « modèle primaire » et n'a aucune entrée pour
   `GOOGLE_GEMINI_API_KEY`. C'est exactement la panne silencieuse que CLAUDE.md décrit (le repli
   répond, rien ne signale le primaire perdu). La liste doit être **dérivée** de `resolveModelIds`.
4. **Vulnérabilités** : `shell-quote` (critique), `nodemailer` (directe, haute), `undici`,
   `@mastra/deployer-vercel` (directe). Même si plusieurs sont transitives côté outillage de
   build, `nodemailer` est sur le chemin d'exécution.

### P0 bis — comportement des agents et features (ajouté après relecture des registres)

> ⚠️ La première version de cet audit ne couvrait que la qualité du code : elle passait à côté
> du registre fonctionnel. Sources lues : `docs/audit-qa-2026-08-28/README.md` §8–9bis,
> `TODO.md`, `docs/tool-design-audit.md`, `docs/harness-audit.md`, `CHANGELOG.md` ; **chaque
> point ci-dessous a été revérifié dans le code ce jour**.

**État du plan QA du 2026-08-28 (14 lots)** — fermés d'après les commits `74066f8`,
`51ec426`, `2d57cdf`, `369d1af` : 0, 1, 2, 3, 5, 6, 7, 8a, 9, 11, 12. Le WIP non commité
traite 4 (`allSettled`), une partie de 14 et l'effacement de §9bis.1.
⚠️ `TODO.md` présente encore 4, 9 et 11 comme ouverts : c'est une liste recopiée, qui a dérivé.

| # | Constat (vérifié ce jour) | Tort | Gravité |
|---|---|---|---|
| F1 | ✅ **FERMÉ le 2026-10-16.** ~~Lot 10 ouvert.~~ `mayTouchRecord` (`shared/slack-request-context.ts:72`) renvoie `true` quand **aucun contexte** n'est fourni. Les écritures `sendNotification`, `generateDocument`, `scheduleReminder` et `updateOnboardingStatus` passent donc par `/api/agents/:id/generate` sans identité de demandeur. Les deux lectures RH ont reçu leur second verrou, pas les écritures. | Avec le jeton de service, un appelant envoie un email ou un document au nom de Marcel, à n'importe quel salarié | **Critique** |
| F2 | ✅ **FERMÉ le 2026-10-16.** ~~§9bis.1 à moitié traité.~~ Le `forget` utilise désormais `affectedRowsOrThrow` (WIP). **8 sites** gardent `rowsAffected ?? 0` : dedup, rate-limit, pinned-fact, pending-email (×2), directory, onboarding, conversation `pruneOlderThan`. | La prise de dédup ou de préparation d'email peut « échouer » sans bruit : un doublon, ou un envoi bloqué | Majeur |
| F3 | ✅ **FERMÉ le 2026-10-16.** ~~Lot 8b ouvert.~~ `shouldRememberTurn` n'existe pas. Les deux machines à états (profil et entretien) suivent toujours la même règle sans la partager. | C'est la famille qui a déjà produit **3 pertes de données silencieuses** | Majeur |
| F4 | **Idempotence par instance.** `shared/tool-idempotency.ts:16` utilise une `Map` en mémoire. À environ 19 messages par jour, chaque demande tombe sur une instance neuve. | Une personne qui redemande parce qu'elle n'a pas vu la réponse reçoit un second document ou email : c'est l'incident « 7 documents, 3 emails en 8 min » | Majeur |
| F5 | ✅ **FERMÉ le 2026-10-16.** ~~Lot 13 ouvert.~~ Aucune échéance partagée dans la boucle : l'`ingest` reste sur le chemin critique et le budget de 60 s est dépassable. | Un message tué en vol ne reçoit aucune réponse | Moyen |
| F6 | **Quota du modèle principal.** Gemini en palier gratuit : **20 requêtes par jour**, partagées entre Marcel et le second rideau de connaissance. Le passage à un palier payant (≈ 1–2 €/mois, décision du Conseil du 2026-08-15) n'est pas acté. | Vers le 20ᵉ message, tout le monde bascule sur Groq puis Mistral (4 req/min) | Majeur (décision humaine) |
| F7 | ⚠️ **Abonnements posés le 2026-10-16** par le propriétaire — livraison à constater. ~~Base de connaissance inerte.~~ `message.channels`/`message.groups` sont notés « en cours d'ajout » depuis le 2026-08-15 ; aucune preuve d'abonnement. Seuls les DM alimentent l'archive. | `searchKnowledge` ne sait presque rien des canaux | Moyen (geste console) |
| F7 bis | **Scopes relevés dans la console le 2026-10-16** : les scopes bot `channels:history`/`groups:history`/`im:history` sont accordés. Ils ne prouvent PAS l'abonnement aux événements, qui se règle séparément. Un **jeton utilisateur** reste autorisé (`users:write` pour la présence, `channels:write.invites`, `groups:write.invites`, `users:read.email`) alors que `SLACK_USER_TOKEN` est de la config morte. | Des droits d'invitation et d'annuaire sans aucun usage : moindre privilège violé | Moyen (retirer les User Token Scopes, réinstaller) |
| F8 | **Rétention.** `KNOWLEDGE_RETENTION_DAYS` est vide dans `.env.example` et non posée en production : les DM sont archivés **sans limite** et le manager peut les relire. `notifications` et `documents` n'ont aucune rétention (ADR-007 ne couvre que les candidats). | Une conservation illimitée que personne n'a décidée | Majeur (décision + 1 variable) |
| F9 | **Contrats d'outils.** 0 `outputSchema` sur 13 outils. Aucune reprise réseau dans `src/` (`resilientFetch` n'existe que dans `scripts/`). Aucun jeu d'évaluation sur la *décision* d'appeler un outil. | Une régression de comportement d'agent ne se voit qu'en production | Moyen |
| F10 | **Harness.** L'état conversationnel est reconstitué à partir du fil au lieu d'être persisté, et il n'y a aucune planification multi-étapes. | Cause racine des pertes de données. Une demande à 3 étapes échoue sans que personne ne le voie | Moyen (gros effort) |
| F11 | **Écart dépôt / production.** La branche avait 40 commits d'avance sur `origin`, non poussés, au 2026-08-23. Les correctifs du 2026-08-28 ne sont peut-être pas tous déployés. `test:scenarios` n'a pas été rejoué depuis. | On croit corrigé ce qui tourne encore en version fautive | À vérifier : `npx vercel ls` |
| F12 | **Décisions produit en attente** : laisser Marcel rejoindre un canal ; la règle d'issue sensible à l'ordre ; simplifier `SystemPromptVault` ; versionner ou non CLAUDE.md, TODO.md et CHANGELOG.md. | — | Décision du propriétaire |

### P1 — qualité structurelle (règles 37, 104, 107, 112)

5. **20 fonctions > 100 lignes.** Les plus longues :

   | Lignes | Fonction |
   |---|---|
   | 162 | `document/application/tools/generate-document.ts:31` |
   | 155 | `notification/infrastructure/handlers/agent-pipeline.ts:44` |
   | 153 | `dashboard/infrastructure/repositories/dashboard-fact-queries.ts:12` |
   | 148 | `notification/infrastructure/handlers/handle-message.ts:18` |
   | 134 | `notification/application/tools/send-notification.ts:54` |
   | 133 | `dashboard/domain/services/dashboard-snapshot.ts:43` |
   | 129 | `knowledge/application/tools/get-user-conversations.ts:34` |
   | 129 | `recruitment/application/tools/schedule-candidate-interview.ts:44` |
   | 124 | `knowledge/application/tools/search-knowledge.ts:38` |
   | 124 | `notification/application/tools/schedule-reminder.ts:22` |
   | 119 | `mastra/agent-tools.ts:20` |

   Note : pour les tools, la factory `makeXxx` englobe `execute` — on compte deux fois. Le
   motif de correction est unique : **`execute` délègue à un use-case nommé** (résoudre →
   autoriser → agir → rendre le verdict), chaque étape étant une fonction ≤ 40 lignes.
6. **3 dépendances circulaires** :
   `conversation-memory → handler-internals → interview-journey → …` et
   `expertise-sources ↔ find-expertise`. `handler-internals.ts` est un fourre-tout : son nom
   seul viole la responsabilité unique.
7. **Configuration dispersée** : `process.env` lu dans 22 fichiers (8 dans `connection.ts`).
   Pas de schéma unique validé au boot (règle 112 / S11).
8. **6 `as unknown as`**, dont `null as unknown as ApiServiceUser` (`api-auth.ts:84`) — un
   mensonge au compilateur sur un chemin d'authentification — et le contexte Hono des deux
   routes Slack.

### P2 — durcissement

9. **Pas d'en-têtes de sécurité** ; `/dashboard` assemble du HTML par `innerHTML` et y injecte
   `f[2]` sans `esc()` (`dashboard-page.script.ts:91`). Constant aujourd'hui, dangereux demain.
10. **Autorisation fail-open par défaut** : sans `AUTHZ_ENFORCE`, rien n'est refusé. Posée en
    production, mais un nouveau déploiement / une préview sans la variable est ouvert.
11. **Règles de lint manquantes** : `curly`, `max-lines-per-function`, `max-params`,
    `@typescript-eslint/no-floating-promises` (exige le lint typé), `import/no-cycle`.
12. **Directives** : 21 `eslint-disable`/`@ts-expect-error`, 4 `catch {}` autorisés globalement.
13. **Tests non hermétiques par construction** : un handler construit sans ses 8 doublures
    touche `data/kisso.db` ou slack.com. La correction est structurelle (une fabrique de test
    unique), pas une discipline.
14. **Rotation des secrets** non documentée (`MASTRA_API_TOKEN`, `CRON_SECRET`, `DASHBOARD_TOKEN`).

### P3 — hygiène (KISS / YAGNI)

15. **Documentation pléthorique** : 18 `.md` racine dont 10 déclarés « figés », CLAUDE.md de
    plusieurs milliers de lignes qui se corrige lui-même par strates (« ⚠️ cette phrase était
    fausse… »). La doc viole KISS et alimente la dérive qu'elle combat.
16. **Artefacts lourds à la racine** : `agent-marcel/` (477 Mo), `venv/` (358 Mo), `ngrok` +
    archive (44 Mo), `lint_output.txt`.
17. `@types/*` en `dependencies` ; 13 `enum` (string, acceptables — migration en unions MAY).
18. Commits récents très gros (« 218 fichiers deviennent 346 ») : règle 199.

## 4. Plan

Chaque lot = un commit, suite verte avant et après (`npm run typecheck && npm run lint &&
npm run format:check && npm run test:unit`), `REGLES.md` mis à jour (journal), et
`docs/conception/` mis à jour **dans le même commit** que le code.

### Lot 0 — remettre la CI au vert (½ jour)
- [ ] Décider du sort de `/*.md` dans `.gitignore` (rétablir la ligne, recommandé).
- [ ] `npx prettier --write` sur les 2 fichiers.
- [ ] Corriger l'ancrage dans `docs/conception/notification.md` (test `design-docs-anchor-right-file`).
- [ ] Commiter le WIP rappels en un lot cohérent.
- **Critère** : les 5 étapes de `ci.yml` passent en local.

### Lots fonctionnels — AVANT les lots de qualité 1 à 8
Dans cet ordre, chacun avec un test rouge d'abord :
- [x] **F-A (F1) — second verrou sur les 4 écritures**, plus une règle **dérivée** :
      un test parcourt `TOOL_EFFECTS` et exige que tout outil `act` appelle d'abord
      `hasIdentifiedRequester`, ce qui couvre aussi le 14ᵉ outil. Ne **pas** modifier
      `mayTouchRecord` (voir « Ce qu'il ne faut PAS faire », QA §9).
- [x] **F-B (F2) — finir §9bis.1** : `affectedRowsOrThrow` sur les 8 sites, puis un test
      quality qui interdit `rowsAffected ?? 0` dans `src/`.
- [x] **F-C (F3) — `shouldRememberTurn` partagé** entre les parcours profil et entretien.
- [ ] **F-D (F4) — idempotence en base**, sur le modèle de `slack_event_dedup`, avec une
      grâce de prise abandonnée (leçon `STRANDED_CLAIM_MS`). Lot dédié avec ses mesures.
- [x] **F-E (F5) — échéance partagée** dans la boucle, `ingest` hors du chemin critique.
- [ ] **F-F (F9) — `outputSchema` Zod** sur les 13 outils, en commençant par les 5 agissants.
- [ ] **Gestes humains (sans code)** : palier Gemini payant (F6) ; abonnement à
      `message.channels`/`message.groups`, vérifié par le manifeste réel (F7) ;
      `KNOWLEDGE_RETENTION_DAYS` ≥ 7 et décision de rétention pour `notifications`/`documents`
      dans un nouvel ADR (F8) ; `vercel ls` comparé à `git log`, puis push et déploiement (F11) ;
      rotation de `MASTRA_API_TOKEN` (préalable à F-A si le jeton a pu circuler).
- [ ] **Recaler `TODO.md`** : lots 4, 9, 11 fermés ; lot 10 et §9bis toujours ouverts.

### Lot 1 — configuration validée au démarrage (1 jour)
- [ ] `src/shared/config/env.ts` : un schéma Zod unique, `loadConfig(process.env)` → objet
      `readonly` typé ; erreurs agrégées, valeurs jamais journalisées.
- [ ] Clés LLM **dérivées** de `resolveModelIds()` (primaire = Gemini) ; test qui rougit si un
      maillon n'a pas sa clé déclarée.
- [ ] Remplacer les 22 lectures de `process.env` par l'injection de la config ; règle ESLint
      `no-restricted-properties` sur `process.env` hors de `config/`.
- **Critère** : `grep -rl process.env src` → 1 fichier.

### Lot 2 — dépendances (½ à 1 jour)
- [ ] `npm audit fix` (sans `--force`), puis traiter à la main `nodemailer`, `undici`,
      `@mastra/deployer-vercel` — vérifier `verify:bundle` (qui importe réellement le bundle).
- [ ] Déplacer `@types/*` en `devDependencies`.
- **Critère** : 0 critique, 0 haute sur le chemin d'exécution ; build et bundle verts.

### Lot 3 — cycles et responsabilité unique (1 jour)
- [ ] Éclater `handler-internals.ts` par responsabilité ; casser les 3 cycles.
- [ ] Ajouter `madge --circular` (ou `import/no-cycle`) à la CI.
- **Critère** : `madge` → 0 cycle, verrouillé en CI.

### Lot 4 — fonctions ≤ 100 lignes (2–3 jours, un commit par fichier)
- [ ] Motif unique pour les tools : `execute` → use-case en étapes nommées.
- [ ] `dashboard-fact-queries` / `dashboard-snapshot` : une fonction par famille de métriques.
- [ ] `agent-pipeline` / `handle-message` : pipeline d'étapes (`(ctx) => Promise<Outcome>`).
- [ ] Activer `max-lines-per-function: ['error', { max: 100, skipBlankLines: true, skipComments: true }]`
      puis descendre progressivement à 60 en `warn`.
- **Critère** : règle ESLint en `error`, 0 violation.

### Lot 5 — typage plus strict (2 jours)
- [ ] Supprimer les 6 `as unknown as` (garde de type ou type Hono correct ; `api-auth.ts:84`
      doit rendre `ApiServiceUser | null` honnêtement).
- [ ] Activer `noUncheckedIndexedAccess` (99 erreurs, par feature).
- [ ] Re-justifier ou supprimer chacune des 21 directives ; mettre CLAUDE.md à jour (10 → réel).
- [ ] Puis évaluer `exactOptionalPropertyTypes` (122).
- **Critère** : flag activé, `tsc` vert.

### Lot 6 — durcissement HTTP et lint typé (1 jour)
- [ ] `secureHeaders()` Hono (CSP stricte sans `unsafe-inline` pour `/dashboard`, HSTS, nosniff).
- [ ] Dashboard : rendu par `textContent`/nœuds DOM, ou `esc()` sur **tous** les champs.
- [ ] Lint typé (`parserOptions.projectService`) : `no-floating-promises`, `no-misused-promises`,
      `curly`, `max-params`.
- [ ] Refus de démarrer en production sans `AUTHZ_ENFORCE` (ou inversion : enforce par défaut,
      désactivation explicite).
- **Critère** : en-têtes présents sur toutes les réponses ; règles en `error`.

### Lot 7 — tests hermétiques (1 jour)
- [ ] Une fabrique `buildTestHandler(overrides)` qui fournit les 8 doublures ; interdire (test
      quality) la construction directe de `SlackEventsHandler` dans `tests/`.
- [ ] Échouer tout test qui ouvre `data/kisso.db` ou appelle slack.com (garde réseau vitest).

### Lot 8 — hygiène et documentation (1 jour)
- [ ] Sortir `agent-marcel/`, `venv/`, `ngrok*`, `lint_output.txt` du dépôt de travail.
- [ ] Archiver les 10 `.md` figés sous `docs/archive/` ; réduire CLAUDE.md à l'état COURANT
      (les historiques vont dans `CHANGELOG.md` / `docs/journal/`).
- [ ] Procédure de rotation des secrets (`docs/guides/`).

**Ordre** : Lot 0, puis **les lots fonctionnels F-A → F-C** (ils touchent des personnes),
puis 1 → 2, puis F-D/F-E/F-F mêlés aux lots 3–8. Les lots 0 → 1 → 2 sont indépendants de la structure et réduisent le risque immédiat ;
3 avant 4 (casser les cycles simplifie les extractions) ; 5–7 ensuite ; 8 en continu.
