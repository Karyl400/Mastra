# Audit Architecture & Cohérence — dépôt `kisso-onboarding`

Branche `refactor/cleanup-20260810`, 195 fichiers TS dans `src/` (22 704 lignes).
Vérifications exécutées : `npx tsc --noEmit` (0 erreur), `npm run lint` (0 warning, 0 erreur),
`npm run test:unit` (**315 fichiers, 4 612 tests, tous verts, 129 s**), et un graphe d'imports
complet construit pour l'occasion (`/home/karyl/.claude/jobs/cac3b69a/tmp/graph.mjs`, lecture seule).

**Verdict court** : la règle de dépendance annoncée tient là où le garde-fou regarde, et elle est
contournée là où il ne regarde pas. Les défauts trouvés ne sont pas des violations de style — ce
sont des **listes écrites à la main que le dépôt croit dérivées**, et du **code maintenu en vie par
ses seuls tests**, deux familles que ce dépôt a déjà identifiées et supprimées ailleurs.

---

## 1. Règle de dépendance

### [HAUTE] Le garde-fou d'architecture est aveugle à `src/shared/`, et `domain/` importe le framework à travers lui

**Constat.** `tests/unit/quality/architecture.test.ts:31` définit `FEATURES_DIR = src/features` et
ne scanne **jamais** rien d'autre (`domainFilesOf`, `collectTsFiles` partent tous de là). En direct,
`src/features/*/domain` est propre : zéro import de `@mastra/*`, `@slack/*`, `drizzle-orm`, `zod`,
`@libsql` — le test dit vrai.

Mais trois fichiers `domain/` importent `src/shared/`, qui lui importe le framework :

| Fichier `domain/` | importe | qui importe |
| --- | --- | --- |
| `src/features/employee/domain/value-objects/email.ts:1` | `shared/validation` | `zod` (`src/shared/validation.ts:1`) |
| `src/features/notification/domain/services/deterministic-replies.ts:20` | `shared/security/llm-guardrail` | `@opentelemetry/api` (`src/shared/security/llm-guardrail.ts:12`) |
| `src/features/document/domain/services/document-template.ts:2` | `shared/security/agent-output` | (propre) |

`deterministic-replies.ts` tire **1 115 lignes** de garde-fou, de crypto et d'instrumentation OTel
dans la fermeture du domaine **pour une seule constante numérique**, `MAX_USER_INPUT_LENGTH`.

Et `src/shared/` porte lui-même six imports de framework, dont
`src/shared/slack-request-context.ts:1` → `@mastra/core/request-context` et
`src/shared/security/api-auth.ts:2` → `@mastra/core/server`.

**Chiffrage de `src/shared/`** : **39 fichiers, 4 760 lignes**, contre **3 669 lignes** pour tout
`features/*/domain` réuni (8 features). `shared/` pèse donc **1,3×** l'ensemble des domaines, et
aucun test n'en surveille les dépendances.

⚠️ **Deux chiffres de `CLAUDE.md` sont faux** et doivent être corrigés : `src/shared/` n'a pas
7 715 lignes mais 4 760 ; et `deterministic-replies.ts` n'y vit pas — il est en
`src/features/notification/domain/services/deterministic-replies.ts` et fait **126 lignes**, pas
1 301. La conclusion qualitative (« `shared/` pèse autant que tout le domaine ») reste vraie ;
les nombres qui la portaient, non.

**Pourquoi ça compte.** La règle n'est pas « ne pas taper `import zod` dans `domain/` », c'est
« le domaine reste du TypeScript pur ». Un test qui ne vérifie que la forme littérale de l'import
laisse passer la seule manière réaliste de la violer : par un module transverse. C'est exactement
le mode de panne que le commentaire du test lui-même dénonce à propos de sa version précédente
(« détectait par `content.includes()` […] aveugle à un vrai import de `@mastra/core` »).

**Recommandation.**
1. Étendre `findViolations` à `src/shared/` et calculer la fermeture **transitive** des imports de
   `domain/` plutôt que ses imports directs (le graphe existe déjà, ~40 lignes). *(effort faible)*
2. Sortir `MAX_USER_INPUT_LENGTH` de `llm-guardrail.ts` vers un module de constantes sans
   dépendance. *(effort faible)*
3. `src/features/employee/domain/value-objects/email.ts` est par ailleurs **sans aucun consommateur**
   — le supprimer règle sa violation gratuitement. *(effort faible)*

### [MOYENNE] Quatre ports vivent dans `application/` au lieu de `domain/ports/`, et l'infrastructure les y importe

**Constat.** 25 ports sont sous `src/features/*/domain/ports/`. Quatre ne le sont pas :

- `src/features/directory/application/services/channel-coverage.service.ts:34` → `ChannelAccessSource`
- `src/features/directory/application/services/welcome-channels.service.ts:22` → `WelcomeChannelSource`
- `src/features/directory/application/services/directory-sync.service.ts:11` → `DirectorySyncSource`
- `src/features/knowledge/application/services/knowledge-ingestion.service.ts:11` → `KnowledgeIngestionPort`

Conséquence directe : `src/features/directory/infrastructure/providers/slack-channel-access.adapter.ts:1-6`
importe ses types depuis `../../application/services/…`. Le test d'architecture interdit
`application → infrastructure` et `domain → infrastructure`, mais **pas** `infrastructure → application` :
la violation passe.

**Pourquoi ça compte.** L'inversion de dépendance n'est acquise que si l'abstraction appartient à
la couche stable. Ici l'adaptateur Slack dépend d'un fichier de 326 lignes qui contient aussi de
la logique applicative — le déplacer, le renommer ou le scinder casse l'infrastructure.

**Recommandation.** Déplacer les quatre interfaces vers `domain/ports/`, ajouter au test
d'architecture une assertion « aucun fichier `infrastructure/` n'importe `application/` ».
*(effort faible)*

### [BASSE] Une feature d'infrastructure dépend d'une classe concrète d'une autre feature

**Constat.** `src/features/directory/infrastructure/providers/slack-channel-access.adapter.ts:7-14`
et `slack-member-source.adapter.ts` importent `SlackWorkspaceService` — une **classe concrète** —
depuis `src/features/notification/infrastructure/providers/slack-workspace.service.ts`, ainsi que
ses constantes `SLACK_MAX_PAGES` / `SLACK_PAGE_LIMIT`.

**Pourquoi ça compte.** `directory` ne peut plus être testée ni redéployée sans `notification`. Le
port `SlackWorkspaceProvider` existe pourtant (`notification/domain/ports/slack-workspace.port.ts`)
et est correctement utilisé ailleurs.

**Recommandation.** Dépendre du port ; si le pagineur doit être partagé, le remonter dans
`src/shared/`. *(effort faible)*

---

## 2. Cycles et couplage

### Cycles : **aucun**

Le graphe complet des 195 modules de `src/` (imports statiques, dynamiques et `require`) ne contient
**aucun cycle**. C'est un résultat solide et rare à cette taille — voir *Points forts*.

### [MOYENNE] `slack-events.handler.ts` est le hub réel du système : il importe 5 features sur 8, dont 4 couches `infrastructure`

**Constat.** Sur 54 imports inter-features de tout le dépôt, **24 partent du seul
`src/features/notification/infrastructure/handlers/slack-events.handler.ts`**. Il atteint
`conversation`, `directory`, `knowledge`, `onboarding` et `recruitment` — et quatre de ces imports
visent leur **couche infrastructure**, pas leur domaine :

```
slack-events.handler.ts → conversation/infrastructure/repositories/drizzle-conversation.repository
                        → conversation/infrastructure/repositories/drizzle-pinned-fact.repository
                        → directory/infrastructure/repositories/drizzle-directory.repository
                        → directory/infrastructure/providers/slack-member-source.adapter
```

**Pourquoi ça compte.** Ce n'est pas interdit par la règle écrite (infrastructure → infrastructure),
mais c'est ce qui rend le fichier irremplaçable : toute feature qui doit parler à un humain passe par
lui. Voir §3 et §4 pour la conséquence.

### Couplage de `src/shared/` — les modules les plus partagés

| Module | zones distinctes | imports | Verdict |
| --- | --- | --- | --- |
| `logger.ts` | 11 | 42 | légitime |
| `types.ts` | 6 | 25 | **noyau partagé** — voir ci-dessous |
| `slack-request-context.ts` | 6 | 12 | légitime (contrat producteur/consommateur documenté) |
| `errors.ts` | 5 | 10 | légitime |
| `security/llm-guardrail.ts` | 5 | 10 | légitime |
| `name-matching.ts` | 5 | 9 | légitime |

### [BASSE] `shared/types.ts` est un noyau partagé qui couple les 8 features par leurs énumérations

**Constat.** `src/shared/types.ts` (204 lignes) déclare `NotificationStatus`, `NotificationChannel`,
`RecipientType`, `DocumentType`, `DocumentFormat`, `DocumentStatus`, `Timestamps` — consommé par 6
zones. Or ces énumérations appartiennent chacune à **une** feature : `DocumentFormat` n'est lu que
par `document`, `NotificationStatus` que par `notification`.

**Pourquoi ça compte.** Ajouter une valeur à `DocumentFormat` recompile `notification`, `onboarding`
et `employee`, qui n'en ont que faire. C'est le contre-exemple exact de la Screaming Architecture
que le reste du dépôt applique bien.

**Recommandation.** Descendre chaque énumération dans le `domain/value-objects/` de sa feature et ne
laisser dans `shared/types.ts` que `Timestamps`. *(effort moyen — mécanique, ~25 sites)*

### [BASSE] Cinq modules `shared/` n'ont qu'un seul consommateur, tous dans `notification`

`shared/distress.ts` (406 l.), `shared/greeting.ts`, `shared/message-shape.ts`, `shared/profile-done.ts`
sont importés **uniquement** par
`src/features/notification/domain/services/deterministic-replies.ts` ;
`shared/emergency-lines.ts` uniquement par `shared/distress.ts`.

Ce n'est pas grave, mais `distress.ts` + `emergency-lines.ts` = 531 lignes de logique métier
mono-consommateur hébergées hors de toute feature, donc **hors du garde-fou d'architecture** (§1).
Les descendre sous `notification/domain/services/` les y ferait rentrer. *(effort faible)*

---

## 3. Taille et complexité

### Les 20 plus gros fichiers de `src/`

| # | Lignes | Fichier |
| --: | --: | --- |
| 1 | **2 626** | `src/features/notification/infrastructure/handlers/slack-events.handler.ts` |
| 2 | **1 115** | `src/shared/security/llm-guardrail.ts` |
| 3 | 750 | `src/infrastructure/database/schema.ts` |
| 4 | 720 | `src/features/document/application/tools/generate-document.ts` |
| 5 | 561 | `src/shared/logger.ts` |
| 6 | 467 | `src/features/knowledge/application/tools/search-knowledge.ts` |
| 7 | 449 | `src/api/slack-interactions.route.ts` |
| 8 | 406 | `src/shared/distress.ts` |
| 9 | 365 | `src/features/onboarding/application/workflows/employee-onboarding.ts` |
| 10 | 326 | `src/features/directory/application/services/channel-coverage.service.ts` |
| 11 | 319 | `src/features/document/domain/services/document-template.ts` |
| 12 | 315 | `src/features/notification/domain/services/claim-reconciliation.ts` |
| 13 | 308 | `src/infrastructure/database/connection.ts` |
| 14 | 296 | `src/features/notification/infrastructure/providers/slack-workspace.service.ts` |
| 15 | 280 | `src/mastra/index.ts` |
| 16 | 280 | `src/features/notification/infrastructure/services/slack-rate-limiter.ts` |
| 17 | 253 | `src/shared/security/agent-output.ts` |
| 18 | 251 | `src/api/slack-events.route.ts` |
| 19 | 236 | `src/features/notification/domain/services/reminder-dispatch.ts` |
| 20 | 230 | `src/features/notification/application/services/dispatch-due-reminders.ts` |

**Complexité cyclomatique/cognitive : zéro signalement.** `sonarjs/cognitive-complexity` est actif
en `warn` (`eslint.config.js:50`, seuil par défaut 15) et `npm run lint` sort **vide**. Malgré un
fichier de 2 626 lignes, aucune fonction ne dépasse le seuil — la découpe en méthodes courtes est
réelle, pas cosmétique.

### [HAUTE] `slack-events.handler.ts` : 2 626 lignes, 75 méthodes, 26 options, et il est son propre conteneur d'injection

**Constat.** Responsabilités portées par ce seul fichier, toutes distinctes :

1. Vérification / dédoublonnage / ACK des événements Slack (`accept`, `claimEvent`, `dedupKey`, `isStale`)
2. Limitation de débit et budget modèle (`checkRateLimit`, `chargeModelBudget`, `settlesWithoutModel`)
3. Routage vers agent (`routeToAgent`)
4. Neuf court-circuits déterministes (`runStaticReply`)
5. Mémoire conversationnelle + faits épinglés (`sayAndRemember`, `runPinFact`, `runErasure`)
6. Machine à états de complétion de profil (`runProfileStep`, `submitProfile`, `knownProfileAnswers`)
7. Machine à états d'entretien
8. Confirmation d'email de recrutement (`resolvePendingEmail`)
9. Accueil des arrivants (`handleTeamJoin`, `recordNewcomer`, `inviteToWelcomeChannels`)
10. Frontière d'autorisation (`enforceAuthorization`)
11. Ingestion connaissance
12. Réconciliation FAIT/NARRATION et notices accolées

Et surtout, **il fabrique ses propres dépendances**. `slack-events.handler.ts:478-583` :

```ts
private getDedupRepo()        { … new DrizzleSlackEventDedupRepository() }
private getConversationRepo() { … new DrizzleConversationRepository() }
private getPinnedFactRepo()   { … new DrizzlePinnedFactRepository() }
private getDirectoryRepo()    { … new DrizzleDirectoryRepository() }
private getAccessGuard()      { … new SlackAccessGuard({…}), new SlackMemberSource(new SlackWorkspaceService(this.botToken)) }
private getRateLimiter()      { … new SlackRateLimiter({ repository: new DrizzleRateLimitRepository(), … }) }
```

`getRateLimiter` lit en plus `process.env.SLACK_BURST_LIMIT`, `SLACK_DAILY_LIMIT`,
`SLACK_WORKSPACE_TOKEN_BUDGET` directement.

**Pourquoi ça compte.** C'est un **service locator**, et il contredit frontalement la convention
écrite du projet (« Jamais d'instanciation au niveau module dans `features/` : le câblage se fait
exclusivement dans `src/mastra/index.ts` »). Ce n'est pas une objection théorique : c'est la **cause
racine documentée** du piège de tests que `CLAUDE.md` détaille sur près d'une page — les « HUIT
dépendances » à neutraliser, les `250 ms` de SQLite par message, le `users.info` réel parti vers
slack.com avec le jeton de test, la suite rouge « un run sur trois par `Timeout 5000ms` ». Chaque
fabrication paresseuse est un défaut ouvert par construction : un test qui oublie une doublure ne
casse pas, il **ralentit**, et le rouge ne désigne jamais sa cause.

Note connexe : le vrai point de câblage n'est d'ailleurs pas `src/mastra/index.ts` mais
`src/api/slack-events.route.ts:101-124` (`getSlackEventsHandler`). La documentation est ici en retard
sur le code.

**Recommandation.**
1. **Ne pas découper le fichier d'abord.** Rendre les dépendances **obligatoires** dans le
   constructeur et déplacer les six `new Drizzle…` vers `getSlackEventsHandler`. Le fichier ne
   raccourcit que de ~110 lignes, mais toute la classe de lenteur de tests disparaît d'un coup, et
   la surface d'`options` passe de 26 optionnelles à une dépendance explicite. *(effort moyen)*
2. Ensuite seulement, extraire les **machines à états** (profil, entretien, email en attente) en
   services `application/` propres à leur feature : elles représentent ~700 lignes et sont déjà
   testables séparément. Le handler redescendrait sous 1 200 lignes. *(effort élevé)*

### [HAUTE] `llm-guardrail.ts` : ~400 lignes de crypto et de sessions maintenues en vie par leurs seuls tests

**Constat.** Sur 13 exports, **6 seulement** ont un consommateur dans `src/` :
`detectInjectionAttempts` (2), `MAX_USER_INPUT_LENGTH` (2), `securityRefusalMessage` (2),
`wrapExternalData` (2), `buildAgentInstructions` (10), `wrapAgentInput` (2).

Sont **morts en production** — zéro occurrence hors du fichier et de son propre test :
`normalizeForDetection`, `wrapUserInput`, `assembleSecurePrompt`, `createFixedSessionManager`,
`assertSecurityHeaderIntact`, et surtout les quatre classes internes
`KeyManager` (`:93`), `SystemPromptVault` (`:162`), `SessionManager` (`:356`),
`DelimiterGenerator` (`:456`) — soit **lignes 93 à 500**, plus les quatre instruments OpenTelemetry
de `:61-79` (`prompt.encryption.duration`, `prompt.decryption.duration`, `prompt.session.count`).
Leur unique appelant est `tests/unit/security/llm-guardrail.test.ts`.

**Pourquoi ça compte.** C'est **mot pour mot** la situation que le dépôt a déjà tranchée deux fois :
la feature `questionnaire` (« elle n'était plus maintenue en vie que par ses propres tests ») et
`discoverSlackWorkspace` (« un fichier qu'un futur recâblage aurait pu rebrancher sans le relire »).
Ici c'est pire à deux titres : (a) c'est le fichier **le plus sensible** du dépôt, celui qu'on relit
en cas d'incident, et 40 % de ce qu'on y lit ne s'exécute jamais ; (b) `KeyManager` a déjà produit
un bug réel (`ERR_CRYPTO_INVALID_SCRYPT_PARAMS`) **masqué précisément par le fait que rien
n'instanciait la classe** — le dépôt le documente et a corrigé le symptôme sans retirer la cause.
C'est aussi ce qui impose `@opentelemetry/api` à la fermeture de `domain/` (§1).

**Recommandation.** Supprimer `KeyManager`, `SystemPromptVault`, `SessionManager`, les trois
instruments OTel associés et `createFixedSessionManager`/`assembleSecurePrompt`/`assertSecurityHeaderIntact`,
avec leurs tests. `DelimiterGenerator` est à conserver si le délimiteur par processus en dépend —
vérifier son appelant réel avant. Attendu : **1 115 → ~650 lignes**, et un fichier dont tout ce qu'on
lit tourne. *(effort moyen)*

---

## 4. SOLID

### [MOYENNE] ISP — le handler type deux dépendances sur une **classe concrète** d'infrastructure

**Constat.** `src/features/notification/infrastructure/handlers/slack-events.handler.ts:253` et `:411` :

```ts
chatProvider?: Pick<SlackAdapter, 'sendBlocks'>;
```

`SlackAdapter` est la classe concrète (`notification/infrastructure/providers/slack.adapter.ts:45`),
qui `implements ChatProvider, FileUploadProvider`. La ligne voisine, elle, fait bien les choses :
`workspaceProvider?: Pick<SlackWorkspaceProvider, 'getUserById'>` — `SlackWorkspaceProvider` **est**
un port (`notification/domain/ports/slack-workspace.port.ts`).

Le `Pick<>` est le bon réflexe (ISP appliqué : on ne demande qu'une méthode) ; c'est la **cible** qui
est fausse. Un `sendBlocks` n'existe sur aucun port : `ChatProvider` ne déclare que `sendMessage`.

Second cas, plus discret : `slack-events.handler.ts:261-264` déclare un port **structurel anonyme**
en pleine interface d'options :

```ts
profileRepository?: { findByEmail(…); findById?(…) } | null;
```

C'est un 4ᵉ `EmployeeRepository` de fait, non nommé, non testé comme contrat.

**Pourquoi ça compte.** Tant qu'un port ne porte pas `sendBlocks`, aucun autre fournisseur de chat
ne peut servir ce chemin (voir §8). Et un port anonyme échappe aux suites de contrat partagées que
le dépôt utilise si bien ailleurs (`pending-email-repository.test.ts`).

**Recommandation.** Ajouter `sendBlocks` à `ChatProvider` (ou créer `BlockChatProvider` dans
`domain/ports/`) et nommer `profileRepository` en port. *(effort faible)*

### [HAUTE] Ports : dix méthodes déclarées n'ont aucun appelant en production, et deux d'entre elles sont le droit à l'effacement

25 ports inventoriés. Après recensement des appelants hors ports, hors implémentations, tous
répertoires confondus (`src/`, `scripts/`, `tests/`) :

| Port | Méthode | Appelants `src/` | Appelants `tests/` ou `scripts/` |
| --- | --- | --: | --- |
| `knowledge/…/message-archive.repository` | **`forgetUser`** | **0** | **aucun** |
| `knowledge/…/knowledge-fact.repository` | **`forgetUser`** | **0** | **aucun** |
| `knowledge/…/message-archive.repository` | **`prune`** | **0** | — |
| `knowledge/…/knowledge-fact.repository` | **`prune`** | **0** | — |
| `knowledge/…/knowledge-fact.repository` | `recent` | 0 | tests seuls |
| `onboarding/…/onboarding.repository` | `findSteps` | **0** | aucun |
| `onboarding/…/onboarding.repository` | `updateStep` | **0** | aucun |
| `onboarding/…/onboarding.repository` | `saveStep` | 0 | appelée par `updateStep` seul |
| `directory/…/channel.repository` | `listObservedMembers` | 0 | tests seuls |
| `directory/…/channel.repository` | `listChannelsObservedForUser` | 0 | tests seuls |
| `directory/…/channel.repository` | `listInventory` | 0 | `scripts/sync-slack-directory.mts` — **légitime** |
| `recruitment/…/interview-confirmation.presenter` | `fallbackText` | **0** | aucun |
| `employee/…/employee.repository` | `delete` | **0** | aucun |

Tous les ports ont au moins une implémentation câblée. **C'est la granularité des méthodes qui
diverge de l'usage, pas l'existence des ports.**

#### [HAUTE] Le droit à l'effacement ne couvre pas l'archive, alors que le code pour le faire existe et est testé

**Constat.** `slack-events.handler.ts:1189-1194` — la seule implémentation de l'effacement :

```ts
const removed = await repo.forget(scope);              // conversation_turns
removedFacts = (await this.getPinnedFactRepo()?.forget(user)) ?? 0;   // pinned_facts
```

`MessageArchiveRepository.forgetUser` et `KnowledgeFactRepository.forgetUser` sont implémentées
quatre fois (`drizzle-message-archive.repository.ts:78`, `drizzle-knowledge-fact.repository.ts:98`,
et les deux in-memory) et **appelées zéro fois, nulle part** — pas même dans un test.

Or depuis le 2026-08-21 **les DM sont archivés dans `channel_messages`** (`KnowledgeIngestionService`,
câblé en `src/api/slack-events.route.ts:109`), et `authorizeOtherMemoryRead` autorise le manager à
les relire. Le port le dit lui-même, `message-archive.repository.ts:52` :
*« `forgetUser` emporte l'archive d'une personne (c'est le droit à l'effacement, pas … ) »*.

Le texte rendu à l'utilisateur (`src/shared/forget.ts:99-103`) est **honnête** — il exclut
explicitement « les messages que j'ai archivés dans les canaux » — mais il dit « dans les canaux »
à quelqu'un qui vient d'écrire en DM, ce qui ne décrit pas ce qui est réellement conservé.

**Pourquoi ça compte.** Le sixième court-circuit est décrit comme « le seul qui AGISSE », et le
dépôt a fait l'effort d'une portée (`ForgetScope`) et d'une sonde de production. Ce que la personne
demande d'effacer est aujourd'hui conservé dans deux tables **et lisible par le manager**. La
méthode est écrite, testée par son implémentation, et jamais branchée : ce n'est pas un manque de
capacité, c'est un fil non tiré.

**Recommandation.** Brancher les deux `forgetUser` sur `runErasure` (portée DM ⇒ tout ce que la
personne a écrit ; portée fil ⇒ ses seuls messages), ajouter les comptes au message rendu, et
reformuler `ERASURE_SCOPE_NOTICE` pour ne plus dire « dans les canaux ». *(effort faible — les
quatre implémentations existent)*

#### [MOYENNE] Aucune rétention sur `channel_messages` ni `knowledge_facts`

**Constat.** `prune` est appelée pour trois tables — limiteur de débit
(`slack-events.handler.ts:948`), dédoublonnage (`:958`), tours de conversation (`:2442`) — et pour
**aucune** des deux tables de connaissance, alors que les deux ports la déclarent et que les quatre
implémentations existent.

**Pourquoi ça compte.** Ce sont les deux seules tables qui grossissent à chaque message reçu, DM
compris, sans borne. Le dépôt a déjà payé exactement ce défaut sur `conversation_turns` (« Le TTL de
60 min n'était appliqué qu'EN LECTURE […] les lignes restaient sur la Turso sans borne réelle ») et
l'a corrigé par un tirage sans état de probabilité 0,2 — le même remède s'applique tel quel.

**Recommandation.** Réutiliser `scheduleDedupPruneIfDue` / `DEFAULT_PRUNE_PROBABILITY` pour les deux
archives, ou brancher les deux `prune` sur le cron quotidien qui existe désormais
(`/internal/reminders/dispatch`) — c'est l'horloge extérieure qui manquait. *(effort faible)*

#### [MOYENNE] `findSteps` / `saveStep` / `updateStep` : un port et 40 lignes de dépôt survivent à un concept retiré

**Constat.** `src/features/onboarding/infrastructure/repositories/drizzle-onboarding.repository.ts:64-105`
implémente les trois méthodes contre la table `onboarding_steps`. Aucun appelant nulle part.
`CLAUDE.md` documente que tout le suivi de tâches — dont « les `onboarding_steps` qui en dérivaient
1:1 » — a été supprimé le 2026-08-14. Le port, l'entité `OnboardingStep`, le dépôt Drizzle et la
déclaration de table (`schema.ts:367`) ont survécu au retrait.

**Recommandation.** Retirer les trois méthodes du port, l'entité, les ~40 lignes de dépôt et la
déclaration `onboardingSteps` de `schema.ts`. **Ne pas `DROP` la table en production** — la doctrine
du dépôt sur ce point est explicite et juste. *(effort faible)*

### [MOYENNE] OCP — trois listes écrites à la main que le dépôt croit dérivées

Ce dépôt s'est donné une règle claire : *« ce dépôt DÉRIVE ses listes »*. Trois endroits ne la suivent
pas, et **`CLAUDE.md` affirme le contraire pour le premier**.

**1. `AGENT_TOOLS` est une seconde copie du câblage, jamais confrontée à la première.**
`src/shared/agent-capabilities.ts` déclare quels outils porte quel agent. Le câblage **réel** est
`src/mastra/index.ts:188-206` (`makeKnowledgeAgent({ searchKnowledge, getUserConversations, … })`).
Aucun test ne compare les deux : `tests/unit/agents/agent-instructions-budget.test.ts:62` fait
`const WIRING = AGENT_TOOLS` — il compare la table **à elle-même**.
`tests/unit/agents/agent-capabilities.test.ts:62` compare les clés à une liste écrite en dur.
La documentation affirme pourtant : *« déclare le câblage agent → outils UNE SEULE FOIS »* — c'est
faux, il y en a deux, et le routage par capacité (`agent-routing.ts:165`, `agentHasTool`) décide sur
la copie, pas sur l'original. Une divergence ne casse aucun test : elle envoie silencieusement un
message chez un agent qui ne porte pas l'outil exigé — **exactement le défaut du 2026-08-12 que le
palier 3 existe pour fermer**.

**2. `KNOWN_AGENT_IDS` est une troisième copie.**
`src/features/notification/domain/services/agent-routing.ts:133-138` réécrit à la main les quatre
identifiants, qui sont exactement `Object.keys(AGENT_TOOLS)`. Aucun test ne les rapproche. Un 5ᵉ
agent ajouté à `AGENT_TOOLS` mais oublié ici verrait son routage collant **silencieusement ignoré**
(`:161`) : le fil repartirait au défaut à chaque message, sans erreur.

**3. `DocumentFormat` déclare 10 valeurs pour 2 renderers.**
`src/shared/types.ts:128-139` déclare `Txt, Markdown, Html, Json, Csv, Xlsx, Pptx, Image` en plus de
`Pdf` et `Docx`. `generate-document.ts:89` restreint correctement à
`RENDERABLE_FORMATS = [Pdf, Docx]`, donc rien ne fuit vers le modèle — mais huit valeurs d'énumération
sans implémentation restent une invitation à l'erreur, du même genre que l'enum `channel` à 7 valeurs
de `sendNotification` déjà ramené à 2 pour cette raison.

**Recommandation.**
1. `KNOWN_AGENT_IDS = new Set(Object.keys(AGENT_TOOLS))` — une ligne. *(effort faible)*
2. Un test qui construit les quatre agents et compare leurs clés d'outils réelles à `AGENT_TOOLS`.
   Mastra rend `agent.tools` privé (constaté en commentaire dans deux tests) — passer par les
   factories, qui reçoivent l'objet en clair. *(effort faible)*
3. Réduire `DocumentFormat` à `Pdf | Docx`. *(effort faible)*

---

## 5. Duplication

**Point de méthode** : ce qui suit ne relève pas les duplications, mais celles dont les copies ont
**divergé**. Les duplications délibérées et déclarées (trois `EmployeeRepository`, un par feature —
`employee` 7 méthodes, `notification` 1, `document` 1) sont **correctes** et ne sont pas comptées :
elles sont exactement l'ISP bien appliqué, chaque feature ne demandant que ce qu'elle consomme.

**Ce qui est bien factorisé** (contrôlé, aucune copie trouvée) :
- construction du nom complet : `fullName()` unique, `src/shared/name-matching.ts:32` ;
- extraction de message d'erreur : `errorMessage()` existe, `src/shared/errors.ts:48`.

### [MOYENNE] Huit normalisations de texte différentes, dont l'une a déjà produit un bug de production

**Constat.** Huit fonctions distinctes replient les accents, toutes différentes :

| Fichier:ligne | Marques retirées | Apostrophes | Ponctuation |
| --- | --- | --- | --- |
| `src/shared/intent-text.ts:1` | `[̀-ͯ]` (sans `u`) | **écrasées** en espace | tout non-`[a-z0-9 ]` → espace |
| `src/shared/name-matching.ts:1` | `\p{M}+/gu` | conservées | conservée |
| `src/shared/profile-done.ts:1` | `\p{M}+/gu` | **unifiées** `’´\`` → `'` | conservée |
| `src/shared/confirmation.ts:13` | `\p{M}+/gu` | **unifiées** (fonction propre) | **finale retirée** |
| `src/features/knowledge/domain/services/text-search.ts:7` | `[̀-ͯ]` | conservées | conservée |
| `src/features/knowledge/domain/services/fact-distillation.ts:34` | `\p{M}+/gu` | unifiées | conservée ; **pas de `toLowerCase`** |
| `src/features/notification/domain/services/claim-reconciliation.ts:161` | `\p{M}+/gu` | `’` seule | conservée |
| `src/features/onboarding/domain/services/interview-chat.ts:33,71,92` | — | — | trois variantes locales |

**Elles ont divergé, et la divergence a coûté.** `CLAUDE.md` documente qu'une revue adverse a trouvé
que **« n'envoie pas » tapé sur un téléphone** (apostrophe typographique U+2019) n'était reconnu par
aucun motif de refus dans `confirmation.ts` — « le cas le plus fréquent était le cas non couvert ».
Ce bug **ne pouvait pas exister** dans `intent-text.ts`, qui écrase toute apostrophe ; et le correctif
apporté à `confirmation.ts` n'a été propagé ni à `claim-reconciliation.ts` (qui ne traite que `’`,
pas `´` ni `` ` ``) ni à `text-search.ts` (aucun traitement).

Corollaire visible : `src/shared/forget.ts:23-31` doit écrire ses motifs sous la forme
`'ce que je t ai dit'` **et** `'ce que je tai dit'` — une contorsion qui n'existe que parce que sa
normalisation (`intent-text`) écrase les apostrophes là où quatre autres les préservent.

Note connexe : `text-search.ts:10` utilise `[̀-ͯ]`, sous-ensemble strict de `\p{M}` — il ne
retire ni les diacritiques du bloc étendu, ni les marques d'autres écritures. C'est la même famille
que le piège `\b` en ASCII que le dépôt a rencontré **trois fois**.

**Recommandation.** Un module `shared/text-folding.ts` exposant des **primitives composables**
(`stripMarks`, `unifyApostrophes`, `stripPunctuation`, `collapseSpaces`) et réécrire les huit
fonctions comme des compositions nommées. Ne pas unifier en une seule fonction — les six politiques
sont légitimement différentes ; c'est leur **implémentation** qui doit être unique. *(effort moyen)*

### [MOYENNE] Deux modules de date française, deux politiques de fuseau

**Constat.** `src/shared/french-date.ts` (`formatFrenchDay`) et `src/shared/french-datetime.ts`
(`frenchDayLabel`) produisent **le même format** (`weekday, day, month, year`, `fr-FR`) avec des
fuseaux différents :

- `french-date.ts:12` → `timeZone: 'UTC'` **codé en dur**
- `french-datetime.ts:46` → `DISPLAY_TIMEZONE` (`Africa/Lagos`)

Et des replis divergents : `at.toISOString().slice(0,10)` contre `at.toISOString()` complet.

Consommateurs : `formatFrenchDay` sert l'**email de bienvenue**
(`onboarding/domain/services/welcome-email.ts:33`) et le **gabarit de document**
(`document/domain/services/document-template.ts:192`) ; `frenchDayLabel` sert le **préambule
d'identité** et la **remise des rappels**.

**Pourquoi ça compte.** Aujourd'hui il n'y a **pas de bug** : les deux ne formatent que
`employees.startDate`, une date sans heure, et Lagos étant à UTC+1 les deux rendent le même jour.
Mais c'est un piège armé : le jour où l'un des deux reçoit un horodatage, ou le jour où
`DISPLAY_TIMEZONE` passe à un décalage négatif, deux surfaces du produit afficheront deux jours
différents pour le même fait. C'est **littéralement le défaut que `reminder-dispatch.ts:113-125`
documente et corrige** (« à 23 h à Cotonou on est déjà demain en UTC+2 […] le symptôme serait un
rappel arrivé la veille ») — le correctif n'a jamais atteint `french-date.ts`.

**Recommandation.** Supprimer `french-date.ts` ; `formatFrenchDay` devient
`frenchDayLabel(new Date(v), 'UTC')` avec le fuseau **explicite au site d'appel** et commenté
(« date sans heure : UTC est le seul fuseau qui ne la déplace pas »). *(effort faible)*

### [BASSE] Deux vocabulaires de codes d'erreur Slack, reliés par une table de traduction

**Constat.** `notification/infrastructure/providers/slack-workspace.service.ts:204-224` décode en
`joined | already_member | not_public | archived | missing_scope | not_found | failed` ;
`directory/infrastructure/providers/slack-welcome-channel.adapter.ts:15-29` décode en
`already_in_channel | bot_not_in_channel | channel_not_found | missing_scope`, et maintient une
seconde table pour traduire le premier vocabulaire vers le second.

**Ce n'est pas un défaut de conception** — c'est une couche anti-corruption correcte, et
`welcome-channels.service.ts` consomme bien une union fermée. Une seule perte d'information :
`archived` **et** `not_found` sont tous deux repliés sur `channel_not_found`
(`slack-welcome-channel.adapter.ts:27-28`), alors qu'un canal archivé est une erreur de
configuration réparable et un canal introuvable un nom erroné. Le message rendu ne peut pas les
distinguer. *(effort faible : ajouter `channel_archived` à l'union)*

---

## 6. Cohérence des flux métier

### a. Nouvel arrivant — **cohérent**

`team_join` → `handleTeamJoin` (`:1058`) → `recordNewcomer` (`:1087`, écrit `slack_directory`) →
DM + invitation canaux (`inviteToWelcomeChannels`, `:1121`) → échange écrit
(`onboarding/domain/services/profile-chat.ts`, 4 questions) → `submitProfile` (`:2022`) →
`runOnboarding` → `employees` + `onboarding_progress` → `linkRequesterToRecord` (`:2092`,
`slack_directory.employee_id` **et** invalidation du cache LRU) → question d'entretien →
`onboarding_interview` → `generateDocument` lit l'entretien côté serveur.

Le chaînon qui manquait le 2026-08-19 (`employee_id` écrite par aucun chemin de production) est
**refermé** : `linkEmployee` est appelée depuis `submitProfile`, avant la première question
d'entretien, et l'échec est journalisé en `error` avec un motif nommé (`no_directory_row`), pas avalé.
Rien à signaler.

Seule remarque : deux machines à états (profil et entretien) coexistent dans le handler et
reconstituent chacune leur état en cherchant la question dans le dernier tour de l'assistant. Le
dépôt a déjà payé leur divergence une fois (relance qui ne repose pas la question). Elles restent
séparées — c'est le principal argument pour l'extraction recommandée au §3.

### b. Rappel — **cohérent, avec un état latent inatteignable**

`scheduleReminder` (`:92`, écrit `status: Scheduled` + `scheduledAt`) → `notifications` → cron
`vercel.json` → `remindersDispatchRoute` (déclaré, `src/mastra/index.ts:244`) →
`dispatchDueReminders` → `findPending()` (`Pending | Scheduled | Sending`) → extinction des périmés
→ `claimForDispatch` (UPDATE conditionnel + `rowsAffected`) → envoi → `releaseClaim` sur échec
réparable. La reprise des prises échouées (`isStrandedClaim`, 6 h) est présente et cohérente avec
`maxDuration`.

**[BASSE] Un statut lu que rien n'écrit.** `findPending()`
(`drizzle-notification.repository.ts:52-56`) interroge `NotificationStatus.Pending`. Or aucun
écrivain ne le pose : `send-notification.ts:127/135` écrit `Sent` ou `Failed` ;
`schedule-reminder.ts:92` écrit `Scheduled` ; `employee-onboarding.ts:258-262` écrase
explicitement le défaut. `Pending` n'existe que comme valeur de `createNotification`
(`notification.ts:26`).

C'est un piège armé, pas un bug : `save(createNotification(…))` sans écrasement produirait une ligne
que le cron ramasse **à chaque exécution, indéfiniment** — `isDueForDispatch` la rejette
(`!scheduledAt`, `:139`) mais `isStaleReminder` la rejette **aussi** (`Date.parse` → `NaN`, `:161`),
donc elle n'est ni envoyée, ni éteinte, ni oubliée.

Par ailleurs `NotificationStatus` déclare 9 valeurs ; 5 seulement sont écrites. `PendingApproval`,
`Delivered`, `Read` n'ont ni écrivain ni lecteur.

**Recommandation.** Retirer `Pending` de la liste de `findPending()` ou faire de `createNotification`
une fonction exigeant le statut. Réduire l'énumération aux 5 valeurs vivantes. *(effort faible)*

### c. Recherche de connaissance — **cohérent en code, incomplet en cycle de vie**

`slack-events.handler.ts` → `KnowledgeIngestionService.ingest` (`:37`) → `archive.archive()`
(`channel_messages`) → `distillFact` (code, zéro token) → `knowledge_facts` + `markDistilled` ;
si le code n'a rien classé → `runFactCurtain` (modèle, lots de 5, fenêtre 6 h, désignation par rang).
Lecture : `searchKnowledge` → `disclosure-policy` → repli lecture Slack en direct bornée
(6 canaux / 30 j / 60 messages) avec couverture annoncée.

Le chemin est complet et correctement câblé (`src/api/slack-events.route.ts:109-116`, `summarizer`
compris). Deux manques, tous deux déjà relevés ailleurs dans ce rapport :
- **aucune rétention** — `prune` sans appelant sur les deux tables (§4) ;
- **aucun effacement** — `forgetUser` sans appelant sur les deux tables (§4).

Ce sont les deux seules opérations de cycle de vie que ces ports déclarent, et ni l'une ni l'autre
n'est branchée. Les tables ne peuvent donc que croître, et rien ne peut en sortir.

---

## 7. Schéma de base

### [HAUTE] Les migrations `drizzle/` ne décrivent plus le schéma : 9 tables sur 21, 11 colonnes sur 20 pour `employees`

**Constat, chiffré.** `src/infrastructure/database/schema.ts` déclare **21 tables**. `drizzle/` en
crée **9** :

```
audit_logs, documents, employees, notifications, onboarding_progress,
onboarding_steps, questionnaire_responses, questionnaires, tasks
```

**Douze tables n'ont aucune migration** : `employee_documents`, `conversation_turns`,
`onboarding_interview`, `pinned_facts`, `pending_interview_email`, `slack_event_dedup`,
`slack_directory`, `rate_limit_counters`, `slack_channels`, `slack_channel_members`,
`channel_messages`, `knowledge_facts`. Ce sont **toutes les tables ajoutées depuis le 2026-08-11**,
c'est-à-dire toutes celles que le produit actuel utilise vraiment.

Pour `employees`, `drizzle/0000_petite_fantastic_four.sql` crée **11 colonnes**, `schema.ts` en
déclare **20** : manquent `phone`, `onboarding_status`, `emergency_contact_name`,
`emergency_contact_phone`, `emergency_contact_relationship`, `salary_amount`, `salary_currency`,
`metadata`, `deleted_at`. `deleted_at` est celle sur laquelle **les trois résolveurs filtrent** —
appliquer `drizzle/` sur une base vierge donne donc un schéma sur lequel le produit **ne peut pas
démarrer**, et pas seulement au sens du `phone` que `CLAUDE.md` cite.

Le remplacement de fait est `scripts/ddl-*.sql`, appliqué à la main, table par table, dans un ordre
que seuls les commentaires de `CLAUDE.md` conservent.

**Pourquoi ça compte.** Il n'existe plus aucun moyen reproductible de créer une base neuve. Ce n'est
pas théorique : l'audit de production du 2026-08-21 note qu'une sonde a laissé « la base de
production sale, réparée à la main depuis la sauvegarde ».

**Recommandation.** Régénérer un `0002_*.sql` **de rattrapage** avec `npm run db:generate` dans un
vrai TTY, en `IF NOT EXISTS` partout pour qu'il soit rejouable contre la Turso existante ; puis
ajouter au test de qualité une assertion « toute table de `schema.ts` apparaît dans `drizzle/` ou
dans un `scripts/ddl-*.sql` ». *(effort moyen)*

### [MOYENNE] Quatre tables mortes et une cinquième sans lecteur

**Constat.** Occurrences hors `schema.ts`, tout `src/` confondu :

| Table | Occurrences | Statut |
| --- | --: | --- |
| `tasks` | **0** | morte — suivi retiré le 2026-08-14 |
| `questionnaires` | **0** | morte — feature supprimée le 2026-08-14 |
| `questionnaire_responses` | **0** | morte — feature supprimée le 2026-08-14 |
| `employee_documents` | **0** | morte — **jamais** référencée, y compris dans `tests/` et `scripts/` |
| `onboarding_steps` | 6 | **écrite et lue par un dépôt sans appelant** (§4) |

`employee_documents` est la plus intéressante : contrairement aux trois autres, elle n'est le vestige
d'aucun retrait documenté. Elle a une migration (`drizzle/0000`), une déclaration
(`schema.ts:418`), et **zéro référence dans tout le dépôt** — jamais écrite, jamais lue, jamais
testée.

**Recommandation.** Retirer les cinq déclarations de `schema.ts` (**~140 lignes**). **Ne pas `DROP`
en production** — la doctrine du dépôt sur l'irréversibilité est juste, et la trace historique a de
la valeur. Ajouter un commentaire en tête de `schema.ts` nommant les tables volontairement
conservées côté serveur mais retirées du modèle. *(effort faible)*

### [BASSE] Le piège Drizzle « clé sans colonne » : cherché, non trouvé — mais quatre sites restent exposés

**Constat.** Quatre appels passent une **entité entière** à `.values()`, la forme exacte qui a
silencieusement perdu `documents.content` sur 6 lignes sur 6 :

- `drizzle-document.repository.ts:12` — `.values(row)`
- `drizzle-notification.repository.ts:16` — `.values(notification)`
- `drizzle-employee.repository.ts:61` — `.values(employee)`
- `drizzle-conversation.repository.ts:25` — `.values(saved)`

**Vérification champ par champ : aucune perte actuellement.** Les entités sont des sous-ensembles
stricts de leurs tables (`Document` 9 champs / 22 colonnes ; `Notification` 9 / 19 ; `Employee`
11 / 20). Le `data` de `createNotification` (`notification.ts:21`) est un **paramètre**, pas un champ.

Ce qui reste : ajouter un champ à l'une de ces quatre entités sans toucher `schema.ts` **rejouerait
le défaut à l'identique**, en silence, et le compilateur ne dirait rien. Deux dépôts amortissent en
plus l'écart par `as unknown as` (`drizzle-onboarding.repository.ts`,
`drizzle-message-archive.repository.ts`).

**Recommandation.** Un test de qualité qui, pour ces quatre couples entité/table, compare
`Object.keys` d'un objet témoin aux colonnes déclarées et échoue sur toute clé sans colonne. C'est
le seul garde-fou possible : Drizzle ne lèvera jamais. *(effort faible)*

### Colonnes déclarées jamais écrites

Vérifiées sans aucun écrivain dans `src/` : `employees.phone`, `.onboarding_status`,
`.emergency_contact_*` (3), `.salary_amount`, `.salary_currency`, `.metadata` ; `documents.template_id`,
`.description`, `.storage_key`, `.storage_bucket`, `.file_name`, `.file_size`, `.mime_type`,
`.version`, `.is_confidential`, `.expires_at`, `.signed_at`, `.viewed_at`, `.metadata`, `.deleted_at` ;
`notifications.priority`, `.template_id`, `.template_data`, `.error_message`, `.retry_count`,
`.delivered_at`, `.read_at`, `.metadata`.

Le bloc « stockage » de `documents` est déjà documenté comme décrivant un S3/GCS inexistant.
Les autres sont un modèle RH anticipé jamais rempli. **Priorité basse** — elles ne mentent à
personne tant qu'aucun lecteur ne les interroge, ce qui est le cas. À surveiller si un jour un tool
les expose au modèle : une colonne toujours nulle rendue dans un tool-result devient une invitation
à combler.

---

## 8. Évolutivité

| Extension | Points de friction réels | Effort |
| --- | --- | --- |
| **9ᵉ bounded context** | La liste en dur d'`architecture.test.ts:127` (voulue, bonne). Puis le câblage dans `src/mastra/index.ts`. Rien d'autre. | **faible** |
| **5ᵉ agent** | `AGENT_TOOLS`, `KNOWN_AGENT_IDS`, `ESCAPE_INTENTS`, `TOPIC_BANDS`, `agent-capabilities.test.ts:62` et la construction dans `index.ts` — **six listes**, dont trois recopiées à la main sans test croisé (§4). Une seule oubliée = routage silencieusement faux. | **moyen** |
| **3ᵉ format de document** | Excellent : `DocumentRenderer` est un port (`document/domain/ports/document-renderer.ts`), la sélection est un `renderers.find(c => c.format === format)` (`generate-document.ts:540`), `buildDocumentOutline` est format-agnostique. Il faut : implémenter le port, l'ajouter à `RENDERABLE_FORMATS:89`, à `documentMimeType`, au câblage, et à `verify:bundle --require`. | **faible** |
| **2ᵉ fournisseur de chat (Teams)** | **Le point dur.** Un handler de 2 626 lignes nommé `slack-events.handler.ts` qui mêle transport et métier ; `Pick<SlackAdapter,'sendBlocks'>` typé sur la classe concrète (§4) ; `sendBlocks` absent de tout port ; `src/shared/slack-request-context.ts` (12 imports, 6 zones) porte un contrat au nom du fournisseur ; `slack_directory` est la table d'identité **et** la table d'autorisation (`role`) ; la déduplication, la limitation de débit et le portier d'ACK sont tous spécifiques à Slack. | **élevé** |

**Recommandation pour Teams**, si c'est un horizon réel : ne pas commencer par abstraire. Commencer
par les deux gestes du §3 et du §4 — dépendances obligatoires dans le constructeur, et un port
`ChatProvider` qui porte `sendBlocks`. Ils sont utiles en eux-mêmes (ils ferment la classe de
lenteur de tests) et rendent le reste possible. Extraire ensuite les machines à états, qui ne
connaissent déjà rien de Slack sauf leur point d'appel.

---

## Points forts

Ils sont nombreux et ils comptent, parce qu'ils sont **vérifiés, pas déclarés**.

1. **Aucun cycle d'import** sur 195 modules. Rare à cette taille, et ce n'est pas un accident : la
   règle de dépendance est réellement suivie *à l'intérieur* des features.
2. **La règle de dépendance directe est intacte.** `domain/` n'importe aucun paquet de framework et
   aucune couche `infrastructure`, `application` n'importe aucune `infrastructure` — vérifié par
   grep indépendamment du test. Les deux tests garde-fous fonctionnent, y compris leur
   anti-faux-négatif (`:127`), et le commentaire qui explique pourquoi cette liste doit rester
   écrite en dur est juste.
3. **`npm run lint` rend zéro warning**, `cognitive-complexity` compris (seuil 15), malgré un fichier
   de 2 626 lignes. La découpe en méthodes courtes est réelle.
4. **4 612 tests verts en 129 s**, dont des suites de **contrat partagé** exécutées contre les DEUX
   implémentations d'un port (`pending-email-repository.test.ts`, `claimForDispatch` contre une vraie
   base libsql). C'est la bonne façon de tester une abstraction, et elle est peu répandue.
5. **Les concurrences sont traitées comme des prises qui rendent un compte** — `clear()`,
   `claimForDispatch`, `claimEvent`, tous par UPDATE/INSERT conditionnel avec lecture de
   `rowsAffected`, jamais par `find` puis `delete`. C'est correct, et c'est correct **partout**.
6. **Le verdict de dégradation est dans la charge utile, pas dans `run.status`**
   (`onboarding-outcome.ts`), avec le couple QUOI/POURQUOI indissociable. La distinction
   « non applicable ≠ dégradé » est exacte.
7. **Les court-circuits déterministes sont une table de données**
   (`DETERMINISTIC_REPLIES`), et le miroir de facturation en est **dérivé** — pas réécrit
   (`isAnsweredWithoutModel` prend la même table). C'est précisément ce que les trois listes du §4
   auraient dû faire.
8. **Chaque feature possède ses propres ports**, dimensionnés à son besoin (`EmployeeRepository` :
   7 méthodes dans `employee`, 1 dans `notification`, 1 dans `document`). C'est de l'ISP appliqué,
   pas de la duplication.
9. **`fullName()` et `errorMessage()` sont uniques** — les deux duplications que je cherchais en
   priorité n'existent pas.
10. **La culture du commentaire tient ses promesses.** Chaque décision surprenante porte l'incident
    qui l'a produite et la date. Cela a raccourci cet audit d'un facteur trois, et plusieurs constats
    ci-dessus ne sont pas des découvertes mais des **fils que le dépôt avait déjà à moitié tirés**
    (`forgetUser`, `prune`, `onboarding_steps`).

⚠️ **Une réserve de méthode, parce qu'elle porte sur ce dernier point.** Trois affirmations de
`CLAUDE.md` sont fausses et l'audit les a corrigées : `src/shared/` fait 4 760 lignes et non 7 715 ;
`deterministic-replies.ts` fait 126 lignes et vit dans `notification/domain`, pas dans `shared/` ;
et `agent-capabilities.ts` ne déclare **pas** le câblage « une seule fois ». Le garde-fou
`claimed-invariants.test.ts` vérifie qu'une phrase « verrouillé par `X` » cite un fichier existant —
il ne vérifie pas qu'un **chiffre** cité est encore vrai, ni qu'une propriété d'unicité en est une.
C'est la limite exacte du garde-fou actuel, et les trois cas trouvés sont dans son angle mort.

---

## Schéma de l'architecture réelle

Ce que le dépôt annonce : 8 features symétriques, câblées en un point.
Ce qu'il est : **7 features + 1 hub**, câblées en deux points.

```
                     ┌──────────────────────── ENTRÉES HTTP ────────────────────────┐
   Slack ──HMAC──▶ scripts/slack-ack-function (portier, 0 dépendance, fonction séparée)
                            │ rejoue vers /internal/…
                            ▼
   src/api/  slack-events.route.ts ★ CÂBLAGE RÉEL DU HANDLER (26 options)
             slack-interactions.route.ts
             reminders-dispatch.route.ts ◀── cron Vercel (CRON_SECRET, fail-closed)
                            │
   src/mastra/index.ts ★ CÂBLAGE DES AGENTS, TOOLS, WORKFLOW, MIDDLEWARES
                            │
   ┌────────────────────────┴─────────────────────────────────────────────────────┐
   ▼                                                                              ▼
╔══════════════════════════════════════════════════╗              4 agents Mastra
║  notification/infrastructure/handlers/            ║        onboardingOrchestrator
║  slack-events.handler.ts                          ║        notificationAgent
║  ── 2 626 lignes · 75 méthodes · 12 rôles ──      ║        knowledgeAgent
║  ACK · dédup · débit · routage · 9 court-circuits ║        recruitmentAgent
║  mémoire · profil · entretien · email · autorisa- ║              │
║  tion · ingestion · réconciliation                ║              │ AGENT_TOOLS
║                                                   ║              │ (copie n°2 du
║  ⚠ fabrique lui-même 6 dépôts Drizzle             ║              │  câblage, non
║    + SlackAccessGuard + SlackRateLimiter          ║              │  confrontée)
║    + lit process.env  ⇒ service locator           ║              ▼
╚═══════════════════════╤═══════════════════════════╝        agent-routing.ts
                        │ 24 des 54 imports inter-features    (copie n°3 :
      ┌────────┬────────┼────────┬──────────┬─────────┐        KNOWN_AGENT_IDS)
      ▼        ▼        ▼        ▼          ▼         ▼
 conversation directory knowledge onboarding recruitment  employee  document
   (353 l.)   (1 784)   (2 892)    (1 576)     (789)      (821)     (1 568)
      │          │         │          │          │           │         │
      └──────────┴─────────┴────┬─────┴──────────┴───────────┴─────────┘
                                │
   Chaque feature :  domain/ ─▶ application/ ─▶ infrastructure/   ✅ 0 cycle
                     └─ 25 ports ─┬─ 4 ports égarés en application/  ⚠
                                  └─ 10 méthodes sans appelant       ⚠

                                ▼
   ┌──────────────────── src/shared/  4 760 lignes, 39 fichiers ────────────────────┐
   │  ⚠ INVISIBLE au garde-fou d'architecture — et 1,3× tout le domaine réuni       │
   │                                                                                │
   │  logger(11 zones) types(6) slack-request-context(6) errors(5) llm-guardrail(5) │
   │  name-matching(5) …                                                            │
   │                                                                                │
   │  ⚠ llm-guardrail.ts 1 115 l. → ~400 l. mortes (KeyManager, Vault, Session)     │
   │  ⚠ importe zod · @mastra/core · @opentelemetry/api                             │
   └──────────────────────────────┬─────────────────────────────────────────────────┘
                                  │ ⚠ 3 fichiers domain/ importent shared/
                                  │   ⇒ zod et @opentelemetry entrent dans la
                                  ▼     fermeture du « TypeScript pur »
   src/infrastructure/database/schema.ts   21 tables déclarées
        ├─ 16 vivantes
        ├─  5 mortes (tasks, questionnaires×2, employee_documents, onboarding_steps)
        └─  drizzle/ n'en couvre que 9, et employees y a 11 colonnes sur 20  ⚠
             ⇒ aucune création de base reproductible
```

**Les trois arêtes à couper, dans cet ordre** :
1. handler → `new Drizzle*` (§3) — ferme la classe de lenteur de tests, ~110 lignes déplacées ;
2. `domain/` → `shared/` non surveillé (§1) — 2 fichiers à toucher, 1 test à étendre ;
3. les trois copies du câblage agent→outils (§4) — 1 ligne + 1 test.

Aucune ne demande de refonte. Toutes trois ferment un défaut que ce dépôt a déjà rencontré ailleurs
sous une autre forme.
