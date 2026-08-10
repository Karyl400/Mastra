# Rapport de Test — Kisso Onboarding Platform

**Date d'exécution** : 7 août 2026, 11h30 – 12h00 (UTC+1 / WAT)
**Portée** : poste local + déploiement Vercel `mastra-71ya.vercel.app` + Slack `Kisso Ind.` + Turso (base de production)
**Identifiants** : réels, lus depuis `.env`. Aucun mock, aucune valeur de secret n'apparaît dans ce rapport.
**Identité de test unique** : `karylsoumaila1@gmail.com`

> **Règle de rédaction de ce rapport** : rien n'est marqué « OK » sans une observation
> directe citée. Les constats repris d'une vérification antérieure de la même session,
> et non ré-exécutés ici, sont explicitement étiquetés *(hérité)*. Un point non vérifié
> est écrit « non vérifié » — jamais « OK ».

---

## 1. Résumé exécutif

| Suite | Commande | Fichiers | Tests | OK | KO | Durée |
| ----- | -------- | -------- | ----- | -- | -- | ----- |
| Typecheck | `npx tsc --noEmit` | — | — | propre *(hérité)* | 0 | — |
| Tests unitaires | `npm run test:unit` | 26 | 469 | **469** | **0** | 26,5 s |
| Tests d'intégration (1ʳᵉ exécution) | `npm run test:integration` | 6 | 118 | **118** | **0** | 37,4 s |
| Tests d'intégration (ré-exécution du seul test live) | `npx vitest run --config vitest.config.integration.ts tests/integration/live-integration.test.ts` | 1 | 2 | 1 | **1** | 15,8 s |
| Smoke Slack | `npm run smoke:slack` | — | 3 | **3** | 0 | ~3 s |
| Smoke Email (dry) | `npm run smoke:email -- --dry` | — | 1 | **1** | 0 | ~3 s |
| Smoke Email (envoi réel, 1 message) | `npm run smoke:email -- --to=karylsoumaila1@gmail.com` | — | 2 | **2** | 0 | ~4 s |
| Lint | `npm run lint` | 25 fichiers signalés | — | 0 erreur | 93 avertissements | ~20 s |

**Statut global : PARTIELLEMENT VALIDÉ, avec une régression de reproductibilité.**

La suite d'intégration est passée à **118/118 au premier essai**, mais ce vert **n'est
pas reproductible** : la ré-exécution du seul test live a échoué en **HTTP 500
`{"error":"Rate limit exceeded"}`**. Le résultat de cette suite dépend donc de l'état
d'un service externe (quota LLM), pas seulement du code. Voir § 4.1.

---

## 2. Ce qui a été réellement exécuté

1. `npm run test:unit` — suite unitaire complète, hors `tests/unit/infrastructure/**`.
2. `npm run test:integration` — 6 fichiers :
   - `tests/integration/live-integration.test.ts` (**frappe le déploiement Vercel de production**)
   - `tests/integration/infrastructure/drizzle-employee-repository.test.ts`
   - `tests/unit/infrastructure/drizzle-employee.repository.test.ts`
   - `tests/unit/infrastructure/infra-db.test.ts`
   - `tests/unit/infrastructure/pdfmake.service.test.ts`
   - `tests/unit/infrastructure/slack-workspace.service.test.ts`
3. Ré-exécution isolée de `live-integration.test.ts` (test de reproductibilité).
4. `npm run smoke:slack` — opérations Slack en **lecture seule**.
5. `npm run smoke:email -- --dry` puis **un seul** envoi réel.
6. `npm run lint`.
7. Inspection directe de la base Turso de production (requêtes SQL en lecture) pour
   vérifier ce que les tests ont réellement persisté — et non ce qu'ils prétendent avoir fait.

**Non ré-exécuté ici** *(hérité de la vérification antérieure de la session)* :
`npx tsc --noEmit` (propre), le handshake signé Slack `POST /slack/events`
(challenge signé → 200 renvoyant le challenge ; non signé → 401), l'inventaire des
scopes OAuth Slack, le `403` Brevo, et les logs Vercel `ENV CHECK { emailProvider: 'smtp' }`.

---

## 3. Détail par suite

### 3.1 Unitaires — 469/469 OK

```
Test Files  26 passed (26)
     Tests  469 passed (469)
  Duration  26.48s
```

Un avertissement Vitest 4 subsiste, sans effet sur les résultats :
`DEPRECATED test.poolOptions was removed in Vitest 4` — l'option est encore présente
dans `vitest.config.ts` et **n'est donc plus appliquée**.

### 3.2 Intégration — 118/118 OK au premier essai

```
Test Files  6 passed (6)
     Tests  118 passed (118)
  Duration  37.40s
```

Cette exécution a produit un **effet de bord réel en production** (§ 7) : le test live
a fait créer un employé par l'agent déployé, ligne effectivement persistée dans Turso.

### 3.3 Ré-exécution du test live — 1 échec

```
API Error: {"error":"Rate limit exceeded"}
AssertionError: expected 500 to be 200
```

Le test `should expose the deployment and list its agents` reste vert
(`GET /api/agents` → 200). C'est le test de création d'employé qui tombe.

### 3.4 Smoke Slack — 3/3 OK (lecture seule)

- `auth.test` : bot `mastra` connecté à `Kisso Ind.` (`TMLKC4EPP`)
- `conversations.list` : 5 channels — `#alerts-dev` `CMA1TPCN6`, `#kisso-hq` `CMLKC4S5T`,
  `#random` `C09TRLL2KEW`, `#signals` `C0AV1B23V0U`, `#engineer-karyl` `C0BJGBVB5HP` (privé)
- `users.list` : 6 humains (bots exclus)

Aucun message posté, aucune invitation émise.

### 3.5 Smoke Email — SMTP Gmail OK

Dry run puis envoi réel unique, tous deux depuis le poste local :

```
SMTP_HOST = smtp.gmail.com   SMTP_PORT = 587 (STARTTLS)
SMTP_PASS = présent (16 caractères)      <- valeur jamais affichée
OK transporter.verify() — identifiants acceptés
OK sendMail (1 message -> karylsoumaila1@gmail.com)
   réponse serveur = "250 2.0.0 OK  1786100205 …"
```

L'acceptation par Gmail (`250`) prouve la remise au serveur sortant. La **réception**
dans la boîte du destinataire n'a pas pu être constatée depuis cet environnement :
à confirmer manuellement (y compris le dossier spam).

---

## 4. Échecs — cause racine et classification

| # | Test / commande | Symptôme observé | Cause racine | Classification |
| - | --------------- | ---------------- | ------------ | -------------- |
| 1 | `live-integration.test.ts > should successfully ping the API and create an employee` (ré-exécution) | Vercel renvoie `500 {"error":"Rate limit exceeded"}` | Quota LLM amont épuisé sur le déploiement. La chaîne `Groq → repli Mistral` n'a pas absorbé le dépassement et l'erreur remonte en 500 au client. | **(b) état d'un service externe** — pas un défaut du code applicatif, mais **une fragilité réelle de production** |

Aucun échec de catégorie **(a) bug de code** ni **(c) test cassé** n'a été observé.

**Aucune assertion n'a été modifiée, affaiblie ou supprimée. Aucun fichier de test n'a
été touché durant ce run.** Le seul fichier modifié est `TEST_REPORT.md`.

### 4.1 Précisions sur l'échec n° 1

- La chaîne exacte `Rate limit exceeded` **n'existe nulle part dans `src/`**
  (`grep -rn "Rate limit exceeded" src/` → aucun résultat). Elle provient donc du
  serveur Mastra ou du fournisseur LLM amont, pas d'un garde-fou maison. **L'origine
  précise (Groq vs couche serveur Mastra) n'a pas pu être déterminée** : la lecture des
  logs Vercel n'était pas accessible dans cet environnement.
- Les deux exécutions étaient espacées de **22 minutes** (11h35 → 11h57). Un quota de
  palier gratuit est l'explication la plus plausible, non confirmée.
- **Ce test n'est pas idempotent** : il crée toujours le même employé
  (`karylsoumaila1@gmail.com`). Le premier passage a inséré la ligne ; tout passage
  ultérieur devrait heurter un `ConflictError` sur email dupliqué.
- **L'inventaire des variables d'environnement Vercel (`vercel env ls production`) n'a
  pas pu être consulté durant ce run.** On ne peut donc pas affirmer que
  `MISTRAL_API_KEY` est présente ou absente en production — c'est **non vérifié**.

### 4.2 Faiblesse d'assertion à corriger — risque de faux positif résiduel

`tests/integration/live-integration.test.ts` valide la création d'employé ainsi :

```ts
expect(responseText).toMatch(/(succès|créé|created|successfully|ajouté)/);
```

C'est une **regex sur de la prose produite par un LLM**, jamais une vérification de
l'état de la base. Une réponse du type « cet employé a **déjà** été **créé** » ou
« impossible de **créer**… » satisfait la regex. Le test peut donc virer au vert sans
qu'aucune ligne n'ait été écrite — exactement la classe de défaut qui avait produit le
faux « PASS » du rapport précédent.

**Ici, ce n'était pas un faux positif** : la ligne a bien été écrite en base, et elle a
été vérifiée directement en SQL (§ 5). Mais la garantie vient de ce contrôle manuel,
**pas du test**. Le test n'a délibérément pas été modifié (hors périmètre de ce run) ;
le correctif est listé en § 9.

---

## 5. Prouvé de bout en bout, avec identifiants réels

Chaque ligne renvoie à une observation directe faite pendant ce run, sauf mention *(hérité)*.

| Chaîne | Preuve |
| ------ | ------ |
| **Agent déployé → outil `createEmployee` → écriture Turso de production** | `POST https://mastra-71ya.vercel.app/api/agents/onboardingOrchestrator/generate` → 200, puis contrôle SQL direct : `employees` contient `Jane Doe / karylsoumaila1@gmail.com / Engineering / Backend Developer`, `created_at = 2026-08-07T10:35:20.743Z` (= 11h35 locale, pendant la suite d'intégration). **La chaîne complète LLM → tool-calling → persistance distante fonctionne en production.** |
| **Déploiement Vercel joignable** | `GET /api/agents` → 200, expose `onboardingOrchestrator` (assertion du test live, verte aux deux exécutions) |
| **Schéma applicatif présent sur Turso** | contrôle SQL : **10 tables applicatives** (`employees`, `notifications`, `onboarding_progress`, `documents`, `employee_documents`, `tasks`, `questionnaires`, `questionnaire_responses`, `onboarding_steps`, `audit_logs`) et **69 index applicatifs**. `employees` possède bien ses **20 colonnes**. C'était le blocage n° 1 du rapport précédent : **il est levé.** |
| **SMTP Gmail depuis le poste local** | `transporter.verify()` OK + `sendMail` accepté `250 2.0.0 OK`, `messageId=<f9681ae8-…@gmail.com>` |
| **SMTP Gmail depuis une fonction Vercel** *(hérité)* | ligne persistée dans `notifications` de Turso, vérifiée en SQL pendant ce run : `channel=email`, `subject="Kisso - validation SMTP depuis Vercel"`, `status="sent"`, `sent_at=2026-08-07T02:50:45.320Z`, `error_message=null`. **L'egress SMTP depuis le serverless est donc prouvé**, et la trace est en base. |
| **Slack API en lecture** | `auth.test`, `conversations.list`, `users.list` — 3/3 |
| **Endpoint Slack `POST /slack/events`** *(hérité)* | challenge signé → 200 renvoyant le challenge ; requête non signée → 401. La vérification HMAC est active en production. |
| **Persistance locale / repositories Drizzle** | 118 tests d'intégration verts sur `data/integration-test.db`, base jetable reconstruite à chaque run |
| **Appels LLM Groq / Mistral** | exercés indirectement via l'agent déployé (succès à 11h35, quota dépassé à 11h57) |

---

## 6. Ce qui reste BLOQUÉ ou NON PROUVÉ

### 6.1 Le bot Slack ne peut pas encore recevoir d'événement — blocage de configuration, pas de code

Le token OAuth du bot ne porte pas les scopes `app_mentions:read`, `im:history`,
`channels:history`, `groups:history`. Sans eux, Slack **n'émettra aucun événement** vers
`/slack/events`, quelle que soit la qualité du handler.

**Ce n'est pas un défaut du code.** L'endpoint est déployé, monté sur la bonne route et
répond correctement au handshake signé (§ 5). Le handler, sa vérification de signature,
son anti-boucle et sa déduplication sont couverts par les tests unitaires — tous verts.
La correction est une **réinstallation de l'app Slack** avec les scopes ajoutés,
actuellement en cours côté utilisateur. Rien à modifier dans le dépôt.

**Conséquence pour ce rapport : le trajet « message Slack réel → agent → réponse dans le
canal » n'a pas pu être exercé.** Il reste **non prouvé**.

### 6.2 Traitement en tâche de fond en serverless — non testé

Le handler ACK en moins de 3 s puis poursuit l'appel LLM en arrière-plan. Vercel peut
geler la fonction dès la réponse envoyée et tuer l'appel en vol. Symptôme attendu :
« le bot accuse réception mais ne répond jamais », sans erreur dans les logs.

Ce risque **n'a pas pu être évalué** : il faut d'abord que Slack délivre de vrais
événements (§ 6.1). Tant que 6.1 n'est pas levé, ce risque reste **entièrement ouvert**,
et c'est le candidat n° 1 pour le prochain incident « bot silencieux ».

### 6.3 Rate limit LLM en production — reproduit, non mitigé

Cf. § 4.1. Le déploiement renvoie **500** à l'utilisateur final quand le quota amont est
atteint. Deux appels de test à 22 minutes d'intervalle ont suffi à le déclencher. Le
repli Mistral n'a pas absorbé le dépassement — soit qu'il ne soit pas configuré en
production (**non vérifiable durant ce run**), soit qu'il ne soit pas déclenché sur ce
type d'erreur.

### 6.4 Brevo — bloqué au niveau du compte, insoluble par le code

`BREVO_API_KEY` est valide (`GET /v3/account` → 200) mais `POST /v3/smtp/email` renvoie
`403 permission_denied` — « Your SMTP account is not yet activated » *(hérité)*.
Le blocage est **au niveau du compte Brevo** et se produit même avec l'expéditeur validé.
Aucune modification de configuration ne le contourne : l'activation doit être demandée
à Brevo.

**Impact réel : nul aujourd'hui.** Brevo n'est plus que le repli ; le fournisseur primaire
est SMTP Gmail, prouvé fonctionnel en local **et** en serverless (§ 5). À traiter comme
une dette, pas comme un blocage.

### 6.5 Migrations Drizzle désynchronisées du schéma — confirmé pendant ce run

Vérifié directement :

- `drizzle/0000_petite_fantastic_four.sql` crée `employees` avec **11 colonnes**
  (`id, first_name, last_name, email, department, position, start_date, status,
  manager_id, created_at, updated_at`).
- La table `employees` réellement en production sur Turso en compte **20** — les
  manquantes étant `phone`, `onboarding_status`, `emergency_contact_name/phone/relationship`,
  `salary_amount`, `salary_currency`, `metadata`, `deleted_at`.

Appliquer `drizzle/` sur une base vierge produit donc un schéma que l'ORM ne sait pas
requêter. La base de production ne fonctionne que parce que son DDL a été appliqué
directement depuis `schema.ts`, jamais par le migrateur. **Il n'existe aujourd'hui aucun
chemin de reconstruction reproductible de la base.**
`npm run db:generate` exige un vrai TTY (drizzle-kit pose des questions
« ajoutée vs renommée ») : non traité ici.

### 6.6 Points explicitement non vérifiés

- Réception effective de l'email dans la boîte `karylsoumaila1@gmail.com` (seule
  l'acceptation `250` par le serveur sortant est prouvée).
- Inventaire des variables d'environnement Vercel (`vercel env ls`) — inaccessible.
- Logs d'exécution Vercel — inaccessibles.
- `npx tsc --noEmit` — non ré-exécuté ici ; propre lors du contrôle antérieur de la session.
- Workflows `questionnaireCycleWorkflow`, `documentGenerationWorkflow`,
  `notificationCycleWorkflow` **contre le déploiement** : non exercés (seuls leurs tests
  unitaires le sont).

---

## 7. Effets de bord réellement provoqués par ce run

Inventaire exhaustif, y compris ce qui a touché la production.

| Effet | Détail |
| ----- | ------ |
| **Email réel envoyé : 1** | Destinataire `karylsoumaila1@gmail.com`, expéditeur `k88905177@gmail.com`, sujet « Kisso Onboarding — test SMTP », accepté `250 2.0.0 OK`. **Aucun autre envoi, aucune boucle.** |
| **Écriture en base de PRODUCTION (Turso) : 1 ligne** | `employees` : `Jane Doe / karylsoumaila1@gmail.com`, `id acef7bbf-…`, `created_at 2026-08-07T10:35:20.743Z`. Créée par le test live via l'agent déployé. **À supprimer si la base doit rester propre.** |
| **Appels LLM sur le déploiement de production : 2** | un succès (11h35), un rejeté pour quota (11h57). Ils ont pu écrire des traces dans les tables internes `mastra_*`. |
| **Messages Slack postés : 0. Invitations émises : 0.** | Uniquement de la lecture : `auth.test`, `conversations.list`, `users.list`. Slack est resté strictement en lecture seule. |
| **Base locale `data/integration-test.db`** | reconstruite deux fois par `global-setup.ts` (base jetable, comportement nominal). |
| **Base locale `data/kisso.db`** | **non modifiée** — horodatage inchangé (7 août 01h32). L'isolation des tests d'intégration fonctionne. |
| **Fichiers du dépôt modifiés** | `TEST_REPORT.md` uniquement. Aucun fichier sous `src/`, `tests/`, `scripts/`, `.env*`. |
| **Secrets** | aucune valeur de secret n'a été affichée, écrite ni journalisée. `SMTP_PASS` n'apparaît que sous la forme « présent (16 caractères) ». |

---

## 8. Lint — 93 avertissements, 0 erreur

`npm run lint` se termine par `|| true` : il ne fait **jamais** échouer la CI. Sortie réelle :

```
✖ 93 problems (0 errors, 93 warnings)
```

Répartition par règle :

| Occurrences | Règle |
| ----------- | ----- |
| 28 | `@typescript-eslint/no-unused-vars` |
| 11 | `sonarjs/unused-import` |
| 9 | `sonarjs/prefer-single-boolean-return` |
| 7 | `security/detect-object-injection` |
| 6 | `@typescript-eslint/no-explicit-any` |
| 6 | `sonarjs/super-linear-regex` |
| 6 | `security/detect-non-literal-regexp` |
| 4 | `sonarjs/pseudo-random` |
| 4 | `security/detect-unsafe-regex` |
| 3 | `security/detect-non-literal-fs-filename` |
| 2 | `sonarjs/regex-complexity` |
| 2 | `sonarjs/no-default-utility-imports` |
| 2 | `sonarjs/cognitive-complexity` |
| 1 | `sonarjs/no-redundant-boolean`, `sonarjs/no-duplicated-branches`, `no-control-regex` |

**Ce qui mérite un regard, et non un `--fix` :**

- **`src/shared/security/llm-guardrail.ts` concentre 4 `security/detect-unsafe-regex` et
  6 `sonarjs/super-linear-regex`.** Des regex à backtracking super-linéaire dans le module
  *anti prompt-injection* sont une surface ReDoS : ces motifs s'appliquent par construction
  à une entrée hostile. C'est le seul avertissement à valeur sécurité réelle du lot.
- 39 avertissements sur 93 (`no-unused-vars` + `unused-import`) sont du code mort — bruit,
  mais bruit qui masque les 10 précédents.
- Les `detect-object-injection` sont, à la lecture, des accès indexés sur des clés internes :
  probables faux positifs.

---

## 9. Actions requises, par priorité

**Bloquant**

1. **Terminer la réinstallation de l'app Slack** avec `app_mentions:read`, `im:history`,
   `channels:history`, `groups:history` — sans cela, aucun événement n'atteint le bot (§ 6.1).
2. **Une fois 1 fait, tester le trajet complet** message Slack → agent → réponse, pour
   trancher le risque « tâche de fond tuée par le gel de la fonction » (§ 6.2). C'est le
   seul moyen de le valider.
3. **Traiter le rate limit LLM en production** (§ 6.3) : vérifier que `MISTRAL_API_KEY` est
   bien présente côté Vercel, s'assurer que le repli se déclenche sur erreur de quota, et
   renvoyer autre chose qu'un 500 nu à l'utilisateur.

**Fiabilité des tests**

4. **Corriger `tests/integration/live-integration.test.ts`** (§ 4.2) : remplacer la regex
   sur la prose du LLM par une vérification de l'état réel (relecture de l'employé en base,
   ou appel à un endpoint de lecture), et rendre le test idempotent (email unique par run,
   ou nettoyage). En l'état, il peut virer au vert sans rien avoir créé.
5. Retirer `test.poolOptions` de `vitest.config.ts` : supprimé en Vitest 4, donc inopérant
   aujourd'hui — la configuration ne fait pas ce qu'elle prétend faire.

**Dette**

6. Régénérer les migrations Drizzle dans un vrai TTY (§ 6.5) pour restaurer un chemin de
   reconstruction reproductible de la base.
7. Demander à Brevo l'activation du compte transactionnel, ou retirer complètement
   l'adaptateur de repli (§ 6.4).
8. Traiter les regex à backtracking de `llm-guardrail.ts` (§ 8) — surface ReDoS sur une
   entrée par nature hostile.
9. Supprimer la ligne `employees` de test créée en production (§ 7) si la base doit rester propre.
10. Purger le code mort signalé par le lint (39 avertissements), pour que les signaux utiles ressortent.

---

## 10. Écarts avec le rapport précédent

| Affirmation précédente | Constat du 7 août, 12h00 |
| ---------------------- | ------------------------ |
| « Tests unitaires : 461 (25 fichiers) » | **469 (26 fichiers)** — la suite a grossi |
| « Intégration : 118, 1 échec (`Mistral API key is missing`) » | **118/118 au premier essai.** Le 500 réapparaît en ré-exécution, mais avec un message différent (`Rate limit exceeded`) : la cause a changé de nature, elle n'est plus attribuable à une clé manquante — et la présence de `MISTRAL_API_KEY` sur Vercel n'a pas pu être vérifiée ici |
| « Le schéma applicatif n'existe pas sur Turso » | **Résolu.** 10 tables applicatives, 69 index, `employees` à 20 colonnes, vérifiés en SQL |
| « Aucun envoi d'email possible » | **Résolu.** Le fournisseur est désormais SMTP Gmail, prouvé en local (`250 OK`) et en serverless (ligne `notifications` `status='sent'` en base) |
| « BREVO_API_KEY absente de `.env` — BLOQUANT email » | Plus bloquant : Brevo est devenu un repli. Le blocage `403` demeure, au niveau du compte |
| « Emails envoyés : 0 » | **1 email réel envoyé** durant ce run (§ 7) |
| « Faux positif : Création employé complet PASS alors que le workflow mourait sur `ConflictError` » | Le faux positif d'origine est corrigé côté `scripts/production-test.ts`. **Mais la même classe de défaut subsiste dans `live-integration.test.ts`** (§ 4.2) : assertion sur de la prose LLM, jamais sur l'état de la base. Signalée, non corrigée — hors périmètre de ce run |
