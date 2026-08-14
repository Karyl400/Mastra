# Kisso Onboarding — Récapitulatif complet du projet

> ⚠️ **INSTANTANÉ HISTORIQUE DU 2026-08-08 — NE PAS LIRE COMME L'ÉTAT COURANT.**
> Antérieur à la mémoire conversationnelle, à la livraison réelle de documents, au `knowledgeAgent`, à l'entretien post-profil et aux huit court-circuits déterministes.
> Ce document n'est **pas** mis à jour et n'a pas vocation à l'être : il vaut comme trace de ce
> qui était vrai ce jour-là. Pour l'état réel, dans cet ordre : `npx vercel ls` (ce qui tourne),
> `CLAUDE.md` (le dépôt), `CONTEXT.md` (l'intention), `TODO.md` (les dettes ouvertes).
> Banderole posée le 2026-08-14, après qu'un inventaire a montré que plusieurs de ces fichiers
> décrivaient des agents, des tools et des répertoires supprimés depuis — sans qu'aucun ne le dise.


> Document de reprise. Objectif : permettre à quelqu'un qui n'a jamais vu ce dépôt de
> comprendre **ce qui est construit, comment, pourquoi, ce qui a cassé, et ce qui reste à faire**.
> Dernière mise à jour : 2026-08-08.
>
> Documents complémentaires : `CLAUDE.md` (instructions de travail et pièges), `TODO.md`,
> `CHANGELOG.md`, `docs/adr/` (décisions d'architecture), `docs/SLACK_BOT_SETUP.md`.

---

## 1. En bref

Plateforme d'onboarding intelligent pour **Kisso Industries**. Des agents IA orchestrent
l'intégration des nouveaux employés : création de fiche, questionnaires, génération de
documents, notifications email et Slack, provisioning de canaux.

Le point d'entrée utilisateur est **Slack** : on écrit au bot en DM ou on le mentionne dans un
canal, il comprend l'intention et exécute.

**État au 2026-08-08 : opérationnel en production.** Le bot reçoit et répond aux DM et aux
mentions, appelle ses outils, et persiste réellement en base.

| Indicateur | Valeur |
| --- | --- |
| Fichiers TypeScript (`src/`) | 82 (~10 600 lignes) |
| Fichiers de tests | 39 |
| Tests unitaires | 600, tous verts |
| Bounded contexts (features) | 5 |
| Agents Mastra | 3 |
| Tools Mastra | 12 |
| Workflows Mastra | 4 |

---

## 2. Stack technique

| Couche | Choix | Version | Remarque |
| --- | --- | --- | --- |
| Runtime | Node.js, ESM | `>=22.13.0` requis | ⚠️ tourne en réalité sur **v20.19.4** |
| Langage | TypeScript strict | 6.0.3 | |
| Framework agents | `@mastra/core` | 1.57.x | Agents / Tools / Workflows |
| LLM primaire | Groq `llama-3.3-70b-versatile` | | palier gratuit, **12 000 tokens/min** |
| LLM de repli | Mistral `mistral-large-latest` | | bascule vérifiée fonctionnelle |
| Base de données | Turso / LibSQL + Drizzle ORM | 0.45.x | |
| Validation | Zod | **3.25.76 épinglé** | voir §11, piège majeur |
| Tests | Vitest | 4.1.10 | |
| Chat | `@slack/web-api` | 8.x | |
| Email | `nodemailer` (SMTP) primaire, Brevo en repli | | voir ADR-006 |
| Déploiement | Vercel via `@mastra/deployer-vercel` | | |

### Dépendances installées mais non utilisées

À purger ou à brancher — elles alourdissent le bundle sans rien apporter aujourd'hui :

- `@ai-sdk/google`, `@ai-sdk/openai` — aucun import dans `src/`. `@ai-sdk/google` tire par
  ailleurs `undici@5.29.0`, seule vulnérabilité *high* de `npm audit`.
- `@aws-sdk/client-secrets-manager` — utilisé uniquement par `src/config/index.ts`, lui-même
  jamais appelé.
- `inngest` — zéro référence. Serait pourtant le bon outil pour une file durable (§13).

---

## 3. Architecture — Screaming Architecture par feature

L'organisation crie le **métier**, pas la technique. On ne trouve pas `controllers/`,
`services/`, `models/` à la racine ; on trouve les cinq domaines de l'onboarding.

```
src/features/<feature>/
├── domain/            # entités, value-objects, ports — TypeScript pur, ZÉRO import framework
│   ├── entities/
│   ├── value-objects/
│   └── ports/         # interfaces des repositories & services
├── application/       # ce que Mastra consomme
│   ├── agents/        # makeXxx(tools) => new Agent({...})
│   ├── tools/         # makeXxx(deps)  => createTool({...})
│   ├── workflows/     # createXxxWorkflow(deps)
│   ├── dtos/
│   └── mappers/
└── infrastructure/    # implémentations des ports
    ├── repositories/  # drizzle-*.repository.ts + in-memory-*.repository.ts (tests)
    ├── providers/     # adaptateurs externes (slack, smtp, brevo)
    ├── services/
    └── handlers/      # entrées événementielles (Slack Events)
```

**Features** : `employee`, `onboarding`, `questionnaire`, `document`, `notification`.
**Transverse** : `src/shared/`, `src/infrastructure/database/`, `src/config/`, `src/api/`,
`src/mastra/index.ts`.

### La règle de dépendance

`domain` ne dépend de rien. `application` dépend de `domain`. `infrastructure` implémente les
ports du `domain`. **Jamais l'inverse.**

Ce n'est pas une intention : deux tests garde-fous l'imposent mécaniquement —
`tests/unit/quality/architecture.test.ts` et `code-architecture.test.ts`. Une violation fait
échouer la CI.

### Injection de dépendances par factory

Tout composant Mastra est produit par une factory qui reçoit ses dépendances en paramètre :
`makeCreateEmployee(repo)`, `makeOnboardingOrchestrator(tools)`,
`createEmployeeOnboardingWorkflow(deps)`.

**Aucune instanciation au niveau module dans `features/`.** Le câblage se fait *exclusivement*
dans `src/mastra/index.ts`. Conséquence pratique : les tests injectent un repository
`in-memory-*` et n'ont jamais besoin de mocker Drizzle.

---

## 4. Composants Mastra

### Agents

| Agent (`id` = clé du registre) | Rôle | Tools exposés |
| --- | --- | --- |
| `onboardingOrchestrator` | Agent principal du parcours d'intégration | 6 |
| `questionnaireEngine` | Génération et évaluation de questionnaires | 3 |
| `notificationAgent` | Emails, rappels, historique | 4 |

⚠️ **La clé du registre `agents: {}` doit être identique à l'`id` de l'agent** — c'est ce que
`mastra.getAgent(id)` résout.

### Tools (12)

`create-employee`, `find-employee-by-email`, `get-employee-profile`, `get-task-list`,
`update-onboarding-status`, `generate-questionnaire`, `evaluate-response`, `generate-document`,
`send-notification`, `schedule-reminder`, `get-notification-history`, `discover-slack-workspace`.

`discover-slack-workspace` existe et est testé, mais n'est **exposé à aucun agent** — retiré
volontairement (coût en tokens + faille d'autorisation, §7).

### Workflows (4)

`employeeOnboardingWorkflow`, `questionnaireCycleWorkflow`, `notificationCycleWorkflow`,
`documentGenerationWorkflow`.

⚠️ **Ils sont enregistrés mais inatteignables depuis Slack** : le routage
(`routeToAgent()`) n'envoie que vers les trois agents, jamais vers un workflow. C'est
aujourd'hui le principal gisement d'amélioration (§13).

---

## 5. La chaîne Slack, de bout en bout

```
Utilisateur Slack
   │  DM ou @mention
   ▼
Slack Events API ──POST──▶ https://<domaine>/slack/events
   │
   ▼
src/api/slack-events.route.ts
   1. lit le corps BRUT (obligatoire pour le HMAC)
   2. vérifie la signature HMAC-SHA256 (v0:timestamp:body), temps constant, rejet > 5 min
   3. répond au handshake url_verification
   4. accept() SYNCHRONE : filtrage + déduplication  ← avant l'ACK
   5. scheduleBackgroundWork() : waitUntil Vercel
   6. ACK 200 immédiat                                ← < 3 s imposées par Slack
   │
   ▼ (tâche de fond)
slack-events.handler.ts
   • routeToAgent(texte) → mots-clés → agent
   • wrapAgentInput(texte) → encadrement anti-injection
   • agent.generate(...)  → 2 à 20 s
   • chat.postMessage(...) → réponse dans Slack
```

### Points structurants

**Une route HTTP n'existe que si elle est déclarée dans `server.apiRoutes`** de
`src/mastra/index.ts` via `registerApiRoute()`. Un fichier posé dans `src/api/` n'est **jamais**
monté automatiquement. C'était la cause du tout premier « bot silencieux ».

**Le préfixe `/api` est réservé.** `@mastra/server` refuse toute route personnalisée commençant
par l'`apiPrefix` — et c'est un **échec au démarrage**, pas un 404. D'où le montage sur
`/slack/events`.

**`waitUntil` est indispensable en serverless.** Un simple `void promise` ne suffit pas : Vercel
gèle la fonction dès la réponse envoyée et tue l'appel LLM en vol. La route déclare la promesse
au lanceur via `globalThis[Symbol.for('@vercel/request-context')]`, sans ajouter la dépendance
`@vercel/functions`.

**Routage par mots-clés** : `questionnaire|évaluation|quiz|test` → `questionnaireEngine` ;
`notification|rappel|email|message` → `notificationAgent` ; défaut → `onboardingOrchestrator`.
Le matching exclut les mots-clés précédés d'une lettre, sinon « conteste » déclenchait
`questionnaireEngine`.

**Anti-double-réponse** : une mention en canal émet **deux** événements (`app_mention` *et*
`message`). Le handler n'accepte `message` que si `channel_type === 'im'` — un seul des deux
passe.

**Déduplication à statut** : le cache mémorise `in-flight` ou `done`, pas un simple booléen. Une
entrée `in-flight` périmée (> 60 s, soit le `maxDuration`) redevient rejouable — sinon un
traitement tué par le gel serverless perdait l'événement définitivement.

---

## 6. Configuration Slack — les réglages qui ne sont pas dans le code

Rien de ce qui suit n'est visible dans le dépôt, et chacun a coûté du temps.

| Réglage | Où | Effet si mal réglé |
| --- | --- | --- |
| **Socket Mode** | Settings → Socket Mode | S'il est actif, Slack ouvre un WebSocket et n'envoie **aucune** requête HTTP. Mutuellement exclusif avec la Request URL. |
| **`messages_tab_enabled`** | Features → App Home | À `false`, **aucun `message.im` n'est jamais émis**. Invisible depuis la page Event Subscriptions. |
| **Réinstallation** | Settings → Install App | Une modification de configuration ne prend effet qu'après réinstallation complète (jusqu'au bouton *Allow*). |
| **`app_mention` abonné** | Event Subscriptions | Sans lui, les mentions en canal ne déclenchent rien. |
| **Bot membre du canal** | `/invite @bot` | Sinon `chat.postMessage` échoue en `not_in_channel`, **silencieusement**. |

**Le badge *Verified* ne prouve rien sur la livraison courante** — seulement qu'un challenge a
réussi un jour. Un *Save* sur une URL **inchangée** ne redéclenche aucune vérification.

### Méthode de diagnostic (à réutiliser)

La console Slack peut afficher un état **différent** de ce qui est réellement stocké. Se fier au
manifeste :

1. Générer un *App Configuration Token* (`api.slack.com/apps`, bas de la liste).
2. Le jeton `xoxe-1-…` brut est un **refresh token** — `apps.manifest.export` le refuse avec
   `not_allowed_token_type`. Le passer d'abord par `tooling.tokens.rotate`.
3. Chaque rotation invalide la précédente : **conserver le nouveau refresh token**.
4. Lire le manifeste : `socket_mode_enabled`, `event_subscriptions.bot_events`,
   `features.app_home.messages_tab_enabled`.

Sondes complémentaires :
- `vercel logs <url> --json` est fiable et sub-30 s. **Valider l'instrument par une requête de
  contrôle** avant d'affirmer « aucune livraison ». Les logs repartent à zéro à chaque déploiement.
- `app_home_opened` est la sonde idéale : aucun scope requis, indépendante de l'appartenance aux
  canaux et de l'onglet Messages.

---

## 7. Sécurité

### Défense en profondeur

| Couche | Mécanisme | Fichier |
| --- | --- | --- |
| Transport Slack | HMAC-SHA256 sur `v0:ts:body`, comparaison à temps constant, fenêtre 5 min, **fail-closed** si secret absent | `shared/security/slack-signature.ts` |
| API HTTP | Bearer token comparé par digests SHA-256 + `timingSafeEqual`, fail-closed | `shared/security/api-auth.ts` |
| Prompt | En-tête de sécurité + encadrement de l'entrée utilisateur par délimiteurs | `shared/security/llm-guardrail.ts` |
| Erreurs | Requalification 500 → 400 des erreurs d'entrée, sur `/api/*` uniquement | `shared/security/caller-error-mapping.ts` |

**Sans le bloc `auth`, `checkRouteAuth()` laisse passer TOUTES les routes `/api/*`** — n'importe
qui sur Internet pilotait les agents. `/slack/events` en est exempt via `requiresAuth: false` et
s'authentifie par signature HMAC.

### Résultats de l'audit

Vérifiés sains : injection SQL (query builder paramétré partout), fuite de secrets dans les logs
(uniquement des `Boolean(...)` de présence), fuite de stack trace, SSRF.

**Corrigé** : `discoverSlackWorkspace` permettait à n'importe quel membre du workspace de faire
inviter n'importe qui dans un canal privé, avec les droits élevés du bot. Le tool n'est plus
exposé à aucun agent, et les scopes `channels:manage` / `groups:write` ne sont plus accordés.

**Non corrigé — la dette de sécurité principale** : il n'existe **aucune notion d'autorisation**.
Tout membre du workspace, y compris un invité externe, peut déclencher une écriture en base.
Correctif recommandé : allowlist d'identifiants Slack RH vérifiée dans le handler *avant* le
routage vers l'agent, et confirmation interactive avant tout outil à effet d'écriture.

**Non corrigé** : aucun rate limiting. La déduplication ne protège que contre les rejeux du même
`event_id`, pas contre un flux de nouveaux messages.

--

## 8. LLM — chaîne, repli, économie de tokens

### La chaîne

`makeModelChain()` construit `[Groq, Mistral]`. Mastra appelle tous les modèles sauf le dernier
avec `shouldThrowError: true` : **toute** erreur déclenche l'essai du suivant, sans filtrage par
classe d'erreur. Le dernier est appelé avec `shouldThrowError: false` — son erreur brute remonte
au client.

Politique `maxRetries` **asymétrique et délibérée** : `0` sur les maillons non terminaux (un 429
signifie « quota épuisé ici, maintenant » — basculer coûte moins cher qu'attendre), `1` sur le
dernier (il n'y a plus rien vers quoi basculer).

Le maillon Mistral est **omis** si `MISTRAL_API_KEY` est absente : un maillon sans identifiants
échouerait en erreur d'authentification qui, étant celle du dernier modèle, masquerait la vraie
erreur du primaire.

### Piège de journalisation Mastra

Le log `Upstream LLM API error` de **fin de run** attribue toujours l'erreur à `models[0]`
(`getModel()` retourne inconditionnellement `#firstModel`). **Un échec Mistral apparaît donc sous
`provider: 'groq.chat'`.** Seul le log *par tentative* est fiable. `withChainFailureLogging()`
journalise désormais le maillon réellement en cause.

### Économie de tokens

Plafond Groq gratuit : **12 000 tokens/minute**, recharge continue ~200 tok/s.

Coût d'entrée **par étape**, mesuré en production :

| Agent | Avant optimisation | Après |
| --- | --- | --- |
| `questionnaireEngine` | 1 936 | **1 726** |
| `onboardingOrchestrator` | 3 979 | **2 935** (−26 %) |
| `notificationAgent` | 7 849 | **1 832** (−77 %) |

Le poste de coût dominant n'est **pas** le prompt système (~374 tokens) mais les **schémas JSON
des tools**, réinjectés intégralement à chaque aller-retour. C'est inhérent aux API de complétion
stateless de Groq/Mistral, qui n'offrent pas de cache de prompt.

Leviers appliqués : retrait des tools non mentionnés dans les instructions de l'agent,
condensation des descriptions de schémas, suppression d'un bloc `SECURITY DIRECTIVE` redondant
avec l'en-tête obligatoire.

⚠️ **`usage.inputTokens` cumule toutes les étapes.** Comparer deux mesures sans vérifier
`steps.length` mène à des conclusions fausses — l'erreur a été commise pendant l'optimisation.

---

## 9. Données et persistance

Turso / LibSQL, accès via Drizzle ORM. 10 tables applicatives : `employees`, `tasks`,
`documents`, `notifications`, `questionnaires`, `questionnaire_responses`, `onboarding_progress`,
`onboarding_steps`, `employee_documents`, `audit_logs`. Plus 38 tables internes `mastra_*`.

### Deux pièges de migration

**Les migrations `drizzle/` sont désynchronisées de `schema.ts`** : `0000_*.sql` crée `employees`
avec 11 colonnes, le schéma en déclare 20. Appliquer `drizzle/` sur une base vierge **échoue**.
La base locale ne fonctionne que parce qu'elle a été construite par `drizzle-kit push`, jamais
par le migrateur.

**`drizzle-kit push` se BLOQUE contre une base `libsql://` distante** (avec
`dialect: 'sqlite'`) : pas d'erreur, il ne rend jamais la main. Le schéma de production a dû être
appliqué en exportant le DDL depuis `schema.ts` et en exécutant les 69 statements directement.

`audit_logs` et `employee_documents` existent en base mais n'ont **aucune référence applicative**.

---

## 10. Déploiement

`npm run build` = `mastra build` + `scripts/fix-vercel-output.js` + `npm run verify:bundle`.

Le bundler de `@mastra/deployer-vercel` fait sa propre analyse de dépendances et **oublie des
modules transitifs**. `fix-vercel-output.js` recopie manuellement les manquants (fermeture
transitive : 161 modules ajoutés au dernier build) et force `runtime: nodejs22.x` et
`maxDuration: 60`. `verify-vercel-bundle.js` audite le bundle et fait un smoke test PDF réel.

⚠️ Le compte Vercel porte **14 projets** dont un seul fonctionne (`mastra-71ya`). Six renvoient
`500 FUNCTION_INVOCATION_FAILED`, cinq `404`, un est protégé par *Deployment Protection*. À purger.

---

## 11. Pièges connus, non intuitifs

- **Zod est épinglé à `3.25.76`.** Le parseur de schémas du Vercel AI SDK casse sur certaines
  constructions. Éviter `z.discriminatedUnion` (utiliser `z.object`) et les regex à classes
  Unicode (`\p{L}`) **dans les schémas de tools**. Un test garde-fou verrouille cette contrainte :
  `tests/unit/tools/tool-schema-flatness.test.ts`.
- **`npm run lint` se termine par `|| true`** : il ne fait jamais échouer la CI. Lire la sortie.
- **L'échec d'email est SILENCIEUX** : l'étape `sendWelcomeEmail` capture l'erreur et pose
  `emailSent: false`, mais le workflow retourne quand même `status: 'success'`. Ne jamais conclure
  qu'un email est parti sans vérifier `emailSent`.
- **Gmail exige un mot de passe d'APPLICATION** (16 caractères, validation en deux étapes
  activée). Le mot de passe du compte est refusé.
- **`src/config/index.ts` est du code mort.** `getConfig()` n'est appelé nulle part. Son schéma
  `database.url` n'accepte que `file:` ou `postgresql://` alors que la vraie valeur est
  `libsql://` — le brancher tel quel ferait échouer le boot.
- **La déduplication `event_id` est un LRU en mémoire, donc par instance.** Deux instances
  serverless concurrentes peuvent traiter deux fois le même rejeu.
- **Brevo est abandonné** : la clé est valide mais `POST /v3/smtp/email` renvoie
  `403 permission_denied` — compte transactionnel non activé. Blocage au niveau du **compte**,
  aucune modification de config ne le contourne.

---

## 12. Journal des problèmes rencontrés et des solutions

C'est la section la plus instructive : chaque ligne a coûté du temps réel.

| # | Problème | Symptôme observé | Cause réelle | Solution |
| --- | --- | --- | --- | --- |
| 1 | Bot totalement silencieux | `POST /api/slack-events` → 404 | Aucun bloc `server` dans `index.ts` : la route n'était pas montée | Déclarer `slackEventsRoute` dans `server.apiRoutes` |
| 2 | Échec au démarrage | `Custom API route must not start with "/api"` | Le préfixe `/api` est réservé par `@mastra/server` | Monter sur `/slack/events` |
| 3 | ACK < 3 s mais aucune réponse | Aucun log après l'ACK | Vercel gèle la fonction et tue l'appel LLM en vol | `waitUntil` via `Symbol.for('@vercel/request-context')` |
| 4 | Double réponse aux mentions | Deux messages du bot | Une mention émet `app_mention` **et** `message` | N'accepter `message` que si `channel_type === 'im'` |
| 5 | Événements perdus | Un rejeu Slack ignoré alors que le premier traitement avait été tué | Déduplication booléenne | Cache à statut `in-flight` / `done`, avec péremption |
| 6 | Faux positif de routage | « je conteste » → `questionnaireEngine` | `String.includes('test')` | Exclusion des mots-clés précédés d'une lettre |
| 7 | Schémas de tools cassés | Erreur de parsing au démarrage | `z.discriminatedUnion` et regex `\p{L}` incompatibles avec le parseur Vercel AI SDK | `z.object`, regex simplifiées, test garde-fou |
| 8 | Emails jamais envoyés | `status: 'success'` malgré tout | Compte Brevo non activé + échec silencieux | Bascule sur SMTP (ADR-006) ; le silence reste à corriger |
| 9 | Base de prod vide | Le bot ne persistait rien | Aucune table applicative ; `drizzle-kit push` se bloque sur libsql distant | DDL exporté depuis `schema.ts`, 69 statements exécutés |
| 10 | Routes `/api/*` ouvertes | — | Sans bloc `auth`, `checkRouteAuth()` laisse tout passer | `createApiAuthConfig()`, fail-closed |
| 11 | Garde-fou anti-injection inopérant | `[[SESSION_MARKER]]` visible dans `GET /api/agents` | Seule la constante statique était importée ; `wrapUserInput()` n'était appelé que par les tests | `buildAgentInstructions()` + `wrapAgentInput()` sur le chemin de production |
| 12 | `scryptSync` inutilisable | `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` | `N = 100000` n'est pas une puissance de 2 | `16384` (2¹⁴, RFC 7914) |
| 13 | Réponses illisibles dans Slack | `**gras**` affiché littéralement | Markdown GitHub au lieu du mrkdwn Slack | Bloc STYLE dans les instructions des 3 agents |
| 14 | Agent inventant des données | « Bienvenue, John ! » sur un simple « Bonjour », puis écriture en base | Aucune règle contre la fabrication | Bloc anti-invention : ne jamais affirmer un succès non confirmé, ne jamais inventer une donnée |
| 15 | Agent tournant en rond sur les UUID | « L'ID doit être un UUID valide » en boucle | Aucun outil ne résolvait un employé par email | Tool `findEmployeeByEmail` |
| 16 | Réponses invisibles en DM | L'utilisateur croyait le bot muet | Le handler threadait systématiquement, y compris en DM | Pas de thread en DM sauf si le message en faisait déjà partie |
| 17 | **Aucun événement délivré** | Ni DM ni mention, pendant des heures | Deux verrous : `messages_tab_enabled: false`, puis installation non synchronisée avec la config | Correction du manifeste par API + **réinstallation complète** |
| 18 | `500 Rate limit exceeded` | Flux à plusieurs outils systématiquement en échec | Plafond Groq 12 000 tok/min contre 7 849 tokens par appel du `notificationAgent` | Réduction des schémas et des tools exposés (−77 %) |
| 19 | Diagnostic LLM faussé | « Groq saturé » alors que Mistral échouait | Log de fin de run de Mastra attribuant l'erreur à `models[0]` | `withChainFailureLogging()` |
| 20 | Directive morte | L'agent devait toujours fournir `slackChannelId` | Ce champ n'existe pas dans le schéma de `createEmployee` | Directive supprimée |

### Erreurs de méthode commises pendant le diagnostic

À retenir, elles sont plus instructives que les bugs eux-mêmes :

- **Conclure d'un effet à sa cause sans vérifier le maillon intermédiaire.** La présence de
  messages du bot dans Slack a été prise pour une preuve que Slack délivrait les événements. Ils
  venaient en réalité de scripts POSTant directement sur l'endpoint. Il fallait vérifier qu'un
  message *utilisateur* précédait chaque réponse.
- **Prendre l'absence de log pour une absence d'événement** sans avoir validé l'instrument. La
  bonne pratique : émettre une requête de contrôle et vérifier qu'elle apparaît.
- **Comparer deux mesures non normalisées.** `usage.inputTokens` cumule les étapes ; une
  comparaison entre un run à 1 étape et un run à 2 étapes a fait conclure à une régression de 66 %
  qui n'existait pas.
- **Faire confiance à l'interface de configuration.** La console Slack affichait un état différent
  de ce que le manifeste stockait réellement, à deux reprises.

---

## 13. Points d'amélioration, par priorité

### Priorité haute

1. **Autorisation.** Aucune notion d'identité ni de permission. Tout membre du workspace peut
   déclencher une écriture en base. → Allowlist d'identifiants Slack vérifiée dans le handler,
   avant le routage ; confirmation interactive avant tout outil à effet d'écriture.
2. **Brancher les workflows sur Slack.** Les quatre workflows existent, sont testés, et sont
   inatteignables. Un routage déterministe en amont (détecter qu'un message contient tous les
   champs requis) appellerait directement `employeeOnboardingWorkflow` **sans consommer un seul
   token**. C'est le seul changement qui lève durablement la contrainte du plafond LLM, au lieu de
   la comprimer.
3. **Échec d'email silencieux.** Le workflow doit refléter `emailSent: false` dans son statut.

### Priorité moyenne

4. **ACK Slack à froid : 5,2 à 5,7 s**, au-delà des 3 s imposées. Slack rejoue alors l'événement ;
   la déduplication l'encaisse, mais le premier message d'une session part en retry.
5. **Déduplication par instance.** Un store partagé (Redis / LibSQL) ou une file durable —
   `inngest` est déjà installé et inutilisé, et réglerait *simultanément* ce point et le risque de
   gel serverless.
6. **Rate limiting.** Rien n'empêche de brûler le quota LLM ou de déclencher des envois en masse.
7. **Migrations Drizzle désynchronisées.** Relancer `npm run db:generate` dans un vrai TTY.

### Priorité basse — hygiène

8. Purger `@ai-sdk/google` (vulnérabilité `undici` *high*), `@ai-sdk/openai`,
   `@aws-sdk/client-secrets-manager`.
9. Supprimer ou brancher `src/config/index.ts` (code mort).
10. **ADR dupliqués** : `001-architecture-et-stack-technique.md` *et* `ADR-001.md`, sur cinq
    numéros. Choisir une convention.
11. Supprimer les 13 projets Vercel morts.
12. Résoudre la divergence Node : `engines` exige `>=22.13.0`, l'environnement tourne en v20.19.4.
13. Six fichiers de règles pour IA à la racine (`CLAUDE.md`, `AGENT.md`, `GEMINI.md`,
    `ANTIGRAVITY.md`, …). Consolider.

---

## 14. Compétences mobilisées par le projet

### Ingénierie de l'IA

- **Conception d'agents outillés** : découpage agent / tool / workflow, injection de dépendances,
  définition de schémas d'entrée exploitables par un LLM.
- **Prompt engineering appliqué** : instructions métier, directives d'extraction, contrôle du
  style de sortie, règles anti-hallucination ancrées sur le résultat réel des tools.
- **Sécurité des LLM** : anti prompt-injection par délimiteurs, encadrement de l'entrée
  utilisateur non fiable, hiérarchie d'instructions, compréhension de ce qu'un garde-fou par
  prompt peut et ne peut pas garantir.
- **Économie de tokens** : mesure, attribution du coût (schémas de tools ≫ prompt système),
  arbitrage entre capacité exposée et budget.
- **Fiabilité multi-fournisseurs** : chaîne de repli, politique de retry asymétrique, diagnostic
  d'erreurs mal attribuées par le framework.

### Ingénierie logicielle

- **Architecture hexagonale / Screaming Architecture**, avec règle de dépendance **testée**.
- **TDD** : test rouge → vert → refactor, 600 tests unitaires, doublures `in-memory` plutôt que
  mocks de l'ORM.
- **Tests garde-fous** : verrouiller une contrainte non fonctionnelle (dépendances, platitude des
  schémas Zod) par un test qui casse la CI.
- **TypeScript strict**, Zod pour la validation de frontière.
- **Débogage systémique** : isoler un maillon dans une chaîne longue (Slack → Vercel → Mastra →
  LLM → base), valider ses instruments de mesure, distinguer corrélation et causalité.

### Intégration et systèmes distribués

- **Webhooks signés** : HMAC-SHA256, comparaison à temps constant, protection contre le rejeu.
- **Contraintes du serverless** : gel de fonction, `waitUntil`, démarrage à froid, état en mémoire
  non partagé entre instances.
- **Idempotence et déduplication** sous rejeu, avec gestion des traitements abandonnés.
- **Slack Events API** : cycle de vie d'une app, scopes, abonnements, manifeste, jetons de
  configuration.

### Données et infrastructure

- Drizzle ORM, SQLite / LibSQL distant, gestion de schéma et de migrations.
- Déploiement Vercel, correction manuelle d'un bundler défaillant, vérification de bundle.
- SMTP transactionnel, arbitrage entre fournisseurs.

### Méthode

- **Décisions tracées en ADR**, jamais modifiées rétroactivement.
- **Documentation vivante** : `CLAUDE.md` consigne les pièges au fur et à mesure, y compris les
  erreurs de raisonnement.
- **Délégation à des agents spécialisés** avec périmètres de fichiers disjoints, et protocole de
  challenge contradictoire avant validation d'une décision structurante.

---

## 15. Prise en main

### Commandes

```bash
npm run dev              # mastra dev — serveur local + playground
npm run build            # mastra build + patch bundle + audit
npm run build:prod       # typecheck + build (utilisé par vercel.json)
npm start                # tsx ./src/mastra/index.ts
npm run start:prod       # node .mastra/index.mjs

npm run typecheck        # tsc --noEmit
npm run lint             # eslint src (suffixé `|| true` — lire la sortie)
npm run format           # prettier --write .

npm run test:unit        # vitest run
npm run test:integration # vitest run --config vitest.config.integration.ts
npm run test:all         # unit puis integration

npm run smoke:slack      # sonde Slack
npm run smoke:email      # ⚠️ ENVOIE un vrai email
npm run db:generate      # drizzle-kit generate (exige un vrai TTY)
```

**Après chaque modification : `npm run typecheck && npm run test:unit`.**

### Variables d'environnement

`.env` à la racine, chargé par `dotenv` dans `src/mastra/index.ts`.

| Variable | Rôle |
| --- | --- |
| `DATABASE_URL` | **Requis** — LibSQL/Turso. Throw au boot si absent |
| `DATABASE_AUTH_TOKEN` | Token Turso |
| `GROQ_API_KEY` / `MISTRAL_API_KEY` | LLM primaire / repli |
| `SLACK_BOT_TOKEN` | `xoxb-…` |
| `SLACK_SIGNING_SECRET` | Vérification de signature Events API |
| `MASTRA_API_TOKEN` | Bearer des routes `/api/*` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Email primaire (Gmail : mot de passe d'**application**) |
| `NOTIFICATION_FROM` | Expéditeur email |
| `LOG_LEVEL`, `NODE_ENV` | |

**Ne jamais logger la valeur d'une clé d'API — uniquement sa présence (`Boolean(...)`).**

À purger : `RESEND_API_KEY`, `GOOGLE_GEMINI_API_KEY`, `SLACK_USER_TOKEN`, `OPENAI_API_KEY`.

### Règles de travail

1. Lire l'intégralité d'un fichier avant de le modifier.
2. TDD : test rouge → vert → refactor.
3. Mettre à jour `TODO.md` et `CHANGELOG.md` après un changement significatif.
4. Ne pas modifier un ADR existant — en créer un nouveau.
5. Ne jamais instancier un composant Mastra ailleurs que dans `src/mastra/index.ts`.
