# Audit QA du 2026-08-28 — 976 points de vérification

> **Où lire quoi.** Ce fichier est le rapport. `constats-verifies.md` porte les preuves brutes
> d'exécution. La page HTML publiée en donne la version navigable.
>
> ⚠️ **Ce rapport est sous `docs/` et non à la racine, délibérément** : `.gitignore` porte
> `/*.md` avec `!README.md`, donc **tout `.md` de la racine est hors de git** — y compris
> `CLAUDE.md`, `TODO.md`, `CHANGELOG.md` et `AUDIT_REPORT.md`. C'est l'un des constats de cet
> audit (§ 4.1), et le placer à la racine l'aurait rendu invisible à la première revue.

## Résumé exécutif

**976 points vérifiés** sur 8 dimensions, par huit auditeurs indépendants puis un Conseil de six
voix. L'objectif demandé était 500 ; le chiffre réel est rapporté tel quel, sans rembourrage.

**L'état de santé mesuré est excellent, et les défauts trouvés sont ailleurs.**

| Mesure | Valeur | Commande |
| --- | --- | --- |
| `typecheck` | **0 erreur** | `npm run typecheck` |
| `lint` | **0 erreur, 0 warning** | `npm run lint` |
| `test:unit` | **202 fichiers / 2 869 tests, tous verts** | `npx vitest run` |
| couverture | **86,12 % statements · 79,76 % branches · 87,49 % lignes** | `vitest run --coverage` |
| `src/` | 218 fichiers, 24 804 lignes | `find` + `wc` |
| `any` dans `src/` | **ZÉRO sur 24 804 lignes** | grep exhaustif |
| sondes de production | **20/20 refus corrects**, aucune faille | curl signé / non signé |
| réponses déterministes en production | **5/5 conformes**, zéro token | `probe:replies` |

**Ce que cet audit établit, et qui n'était pas connu :**

1. Une **frontière d'autorisation contournable par l'absence** de contexte — confirmée exploitable
   en production.
2. Une **perte de données active** dans la base de connaissance, qui explique un symptôme mesuré
   en production et attribué jusqu'ici à une autre cause.
3. Le **mystère du quota** consigné comme « cause non établie » est **résolu**, et l'instrumentation
   posée pour le trouver partageait son angle mort.
4. Les **patronymes ouest-africains** cassent le parcours d'accueil — cas nominal, pas cas limite,
   pour une entreprise béninoise.
5. La **détresse n'est pas le premier court-circuit** : un long message de détresse reçoit
   « ton message est trop long ».
6. Le dépôt dérive à **3 % sur ce qu'il calcule et 68 % sur ce qu'il recopie** — sa propre doctrine,
   mesurée, sans exception trouvée.

## Méthode

Huit auditeurs en parallèle : sécurité, TypeScript, qualité/architecture, fonctionnel, résilience/
observabilité, dérive documentaire, méta-audit des garde-fous, sondes de production. Puis un Conseil
de six voix (Contrarian, First Principles, Expansionist, Outsider, Executor, Président).

**Trois niveaux de preuve, distingués partout :**

- **`[EXÉCUTÉ]`** — le vrai code du dépôt a tourné et sa sortie est reproduite. C'est le niveau
  exigé pour tout constat classé CRITIQUE.
- **`[LU]`** — fichier:ligne, raisonnement vérifiable, non exécuté.
- **`[NON-VÉRIFIABLE]`** — dit comme tel, jamais comblé par une supposition.

**Preuve par mutation** : 16 garde-fous ont été cassés un par un dans une copie jetable puis rejoués.
**9 mutations sur 10 tuées** — la majorité des garde-fous de ce dépôt sont réels. Les survivants sont
tous du côté des invariants documentaires.

## Ce qui n'a PAS été fait, et pourquoi

- **Aucun test de charge.** Le quota de modèle est d'environ 20 requêtes par jour ; une rafale
  rendrait le bot muet pour de vrais salariés jusqu'au lendemain.
- **`npm run test:integration` n'a pas été exécuté** : `live-integration.test.ts:51` **crée un
  employé « Jane Doe » dans la base de production** et brûle un appel de modèle. C'est un constat
  de l'audit, pas seulement une précaution (§ 4.3).
- **Aucune donnée personnelle réelle n'a été lue.** Le contournement d'autorisation a été confirmé
  avec une adresse **fictive**, ce qui suffit à prouver que l'outil s'exécute sans refus.
- **Les six « skills » demandés (`security-testing`, `performance-testing`, `code-quality`,
  `typescript-strictness`, `feature-testing`, `observability`) n'existent pas**, et les commandes
  `claude install` / `claude skill create` / `claude skills list` / `claude run` / `claude exec`
  non plus. Les sous-commandes réelles sont `agents, auth, doctor, gateway, import, install, mcp,
  plugin, project, setup-token, ultrareview, update`. Les huit dimensions ont donc été couvertes
  par des sous-agents outillés, pas par des skills installés.
- **`TEST_MODE`, les feature flags, Sentry et Datadog n'existent pas dans ce produit.** Les seuls
  interrupteurs réels sont `AUTHZ_ENFORCE`, `CRON_SECRET`, `DASHBOARD_TOKEN`,
  `KNOWLEDGE_RETENTION_DAYS` et `EMERGENCY_COUNTRY`.

---

# 1. Les sept constats CRITIQUES

Tous prouvés à l'exécution. Chacun porte la sortie réelle du code du dépôt.

## 1.1 La frontière d'autorisation s'ouvre par l'ABSENCE — exploité en production

`src/shared/slack-request-context.ts:152-160`

```ts
function mayTouchRecord(requestContext: unknown, targetEmployeeId: string | null) {
  const context = readSlackContext(requestContext);
  if (!context) return true;                 // ← AVANT tout contrôle de niveau
  if (target && context.employeeId === target) return true;
  return context.accessLevel === 'full';
}
```

`canReadPersonRecord`, `canPerformSideEffects`, `mayHoldKeyFor` et `mayReadOthersPrivateNotes`
délèguent **tous** à cette fonction. `AUTHZ_ENFORCE` est **sans effet** sur ce chemin : le
`return true` précède le contrôle de niveau.

⚠️ **CE DÉFAUT N'EST PAS NEUF — correction apportée par le Conseil, contre le premier jet de ce
rapport.** `docs/audit-2026-08-21/01-securite.md` le porte **verbatim**, classé **[HAUTE]**, avec le
même extrait de code et la même liste d'outils, depuis 7 jours. **Ce qui est neuf ici** : (a) la
preuve d'exploitabilité en production, (b) la correction du vecteur — l'audit du 21 soupçonnait
`/api/**/tools/*/execute` et le marquait `HYPOTHÈSE` ; **c'est faux, mesuré à 403** — le vrai chemin
est `/api/agents/:id/generate` ; (c) le compte exact de 7 outils, `find-employee-by-email` ayant été
manqué. **Le vrai constat à remonter n'est donc pas le trou : c'est qu'un `[HAUTE]` est resté ouvert
sept jours dans un fichier versionné que personne n'a rouvert.**

⚠️ **Le trou a été creusé par un bon correctif.** Le 2026-08-14, `createRequestContextGuard` a fermé
l'usurpation par valeur forgée en **refusant (400)** toute clé `slack*` fournie par un appelant HTTP.
Conséquence non vue : tout appel `/api/*` a donc **nécessairement** un contexte vide.

**`[EXÉCUTÉ]` — unitaire**

```
canReadPersonRecord(contexte vide,       dossier d'un TIERS) = true   ❌
canPerformSideEffects(contexte vide,     dossier d'un TIERS) = true   ❌
canReadPersonRecord(undefined,           dossier d'un TIERS) = true   ❌
CONTRÔLE canReadPersonRecord(ctx Slack readonly, TIERS)      = false  ✅
CONTRÔLE canReadPersonRecord(ctx Slack readonly, soi-même)   = true   ✅
```

Les deux contrôles prouvent que la règle est **juste quand le contexte existe**.

**`[EXÉCUTÉ]` — production**, avec une adresse **fictive** (aucune donnée réelle lue) :

```
POST /api/agents/onboardingOrchestrator/generate   (Bearer MASTRA_API_TOKEN)
« Donne-moi le profil de l'employé dont l'email est fictif-sonde-audit@exemple.invalid »
→ toolName: "getEmployeeProfile"   ← L'OUTIL A ÉTÉ EXÉCUTÉ, aucun refus
→ « Je n'ai pas trouvé de profil pour l'adresse email demandée. »
```

Avec une adresse **réelle**, le dossier RH serait rendu.

**Portée : 6 outils sur 13 n'ont aucun second verrou** — `getEmployeeProfile`,
`getNotificationHistory`, `generateDocument`, `sendNotification`, `scheduleReminder`,
`updateOnboardingStatus`.

⚠️ **UN TEST VERROUILLE CE DÉFAUT.** `tests/unit/shared/authorization-fail-open.test.ts:66-73`,
verbatim :

```ts
describe('ce que le correctif ne doit PAS casser', () => {
  it('reste passant HORS Slack — playground, route HTTP, workflow, test', () => {
    // `readSlackContext` rend `undefined` sur ces chemins : c'est leur cas NOMINAL […]
    expect(canReadPersonRecord(undefined, AUTRUI)).toBe(true);
    expect(canPerformSideEffects(undefined, AUTRUI)).toBe(true);
```

Le commentaire nomme **explicitement « route HTTP »** : l'auteur a *considéré* ce chemin et l'a jugé
nominal. **C'est la troisième occurrence dans ce dépôt de la famille qu'il documente lui-même** —
*« `status = Sent` était posé avant le `try`, et un test verrouillait ce mensonge »*.

**Conséquence sur le correctif** : il ne peut pas être livré sans amender ce test — et l'amender
demande de re-trancher ce que l'auteur avait tranché. La sortie retenue par le Conseil est de **ne
pas** toucher `mayTouchRecord` (le playground et les workflows en dépendent réellement), mais de
poser le second verrou **au bord de l'outil**.

✅ **La forme correcte existe déjà dans le dépôt**, appliquée à 4 outils :
`get-channel-history.ts:237`, `get-user-conversations.ts:115`, `search-knowledge.ts:248`
(`if (!slack?.slackUserId) return refuse('no_requester')`) et
`schedule-candidate-interview.ts:85-88` (`no_slack_context`).

## 1.2 Le second rideau de connaissance n'enregistrera JAMAIS rien

`src/features/knowledge/infrastructure/repositories/drizzle-message-archive.repository.ts:120`

```ts
return (rows as unknown as Row[]).map(toDomain);
```

`db.select().from(channelMessages)` rend les clés en **camelCase** (noms de propriété du schéma) ;
`interface Row` et `toDomain` lisent en **snake_case**. Le `as unknown as` est la **condition
d'existence** du bug — sans lui, `tsc` refuserait.

**`[EXÉCUTÉ]`** — base libsql jetable, une ligne insérée, vraie méthode du dépôt appelée :

```
✅ id          = m1
❌ channelId   = undefined
❌ slackUserId = undefined
✅ text        = "on a decide de partir sur postgres"
❌ threadTs    = undefined
❌ postedAt    = NaN
```

**La chaîne aval rend le défaut permanent** (`fact-curtain.service.ts:92-109`) :
l'insert viole `knowledge_facts.channel_id NOT NULL` → le `catch` avale en `warn` →
`markDistilled([...byId.keys()])` s'exécute **inconditionnellement, hors de la boucle** → les
messages sont marqués traités et **ne repasseront jamais**.

⚠️ **Ce défaut a déjà été mesuré en production et mal attribué.** `CLAUDE.md` consigne
`{"examined":5,"recorded":0,"rejected":5}`, l'impute au modèle qui recopiait mal un identifiant, et
le corrige en passant à un rang. **Le correctif par rang fonctionne** — `pending[index-1]` trouve
bien `source` — mais la vraie cause est le champ suivant, `source.channelId`. Rien n'a re-mesuré.

⚠️ **Aucun test ne peut le voir** : les 7 appels de `findPendingDistillation` dans `tests/` passent
par la doublure in-memory, qui n'a aucune traduction de nommage à faire.

### La mesure en production qui tranche — et qui AFFINE le constat

`[EXÉCUTÉ]` — `SELECT` en lecture seule sur la Turso de production, zéro token :

```
channel_messages (total)                       30
channel_messages DÉJÀ marqués distilled_at     19   ← PERDUS DÉFINITIVEMENT pour le niveau 2
channel_messages encore récupérables           11   ← la fenêtre est encore ouverte
knowledge_facts                                 9   ← PAS zéro
tables FTS5 en production   channel_messages_fts, knowledge_facts_fts   ← elles EXISTENT
```

**Ce que cela change** : `knowledge_facts` contient **9 faits**, écrits par le distillateur
**déterministe**, qui écrit directement sans passer par `findPendingDistillation`. **Seul le second
rideau** — le passage de modèle sur les messages non classés — emprunte le chemin cassé. L'énoncé
« le second rideau n'enregistrera jamais rien » est **exact**, mais plus étroit qu'il ne sonne : il
ne porte pas sur tout le niveau 2.

**Ce que cela confirme, et chiffre** : **19 messages sur 30 sont marqués traités et ne repasseront
jamais.** `drizzle-message-archive.repository.ts:105` `isNull(channelMessages.distilledAt)` est le
**seul** filtre de sélection.

> ⚠️ **Le correctif exige donc DEUX gestes, pas un** :
> 1. corriger le mapping ;
> 2. `UPDATE channel_messages SET distilled_at = NULL`.
>
> **Sans le second, on répare pour l'avenir et l'on laisse 19 lignes définitivement mortes.**
> Personne n'y pensera si ce n'est pas écrit ici.

⚠️ Au passage, `CLAUDE.md` affirme « `channel_messages` = 0 ligne, `knowledge_facts` = 0 ligne »
(relevé du 2026-08-21). **Réel aujourd'hui : 30 et 9.** Affirmation périmée de sept jours.

✅ **Une inquiétude levée** : les tables virtuelles FTS5 **existent bien** en production, donc
`search()` fonctionne. C'était une hypothèse de risque du Conseil, mesurée et écartée.

### Le défaut est UNIQUE, et la raison est plus fine qu'elle n'en a l'air

Les 7 `as unknown as` du dépôt et toutes ses interfaces `snake_case` ont été balayés.

`drizzle-knowledge-fact.repository.ts` a **exactement la même forme** — interface `Row` en
`snake_case`, `toDomain` en `snake_case` — et il est **correct** : ses deux seuls appelants sont
`db.all<Row>(sql\`…\`)`, du **SQL brut** qui sélectionne réellement en `snake_case`. Aucun chemin
par le query builder.

`drizzle-message-archive.repository.ts` est le seul où **le même fichier mélange les deux styles** :

```
:65-73    search()                  → db.all<Row>(sql`…`)   SQL brut, snake_case   ✅
:103-120  findPendingDistillation() → db.select().from(…)   query builder, camelCase
          …puis routé vers le MÊME toDomain écrit en snake_case                     ❌
```

> ⚠️ **Le défaut n'est donc pas « `as unknown as` sur du Drizzle ». C'est : un fichier mélange le SQL
> brut et le query builder en partageant un mapper** — et le double cast est ce qui permet au mélange
> de compiler.

**Conséquence pour le correctif** : ne **pas** retyper `Row` globalement, cela casserait `search()`,
qui est juste. Il faut **deux mappers, nommés** pour que la confusion ne soit plus possible. Les 6
autres doubles casts sont des pièges **armés**, pas des plaies ouvertes : aucun n'a d'interface cible
en `snake_case`.

## 1.3 L'échec de quota est présenté comme un bug — cause PLAUSIBLE, non établie

`CLAUDE.md` consigne : *« ⚠️ Mais `QUOTA_FAILURE` n'a PAS été rendu […] Cause non établie,
instrumentation posée. »* **Une cause compatible est identifiée — elle n'est PAS établie**, et le dire autrement serait
exactement l'affirmation non constatée que ce dépôt interdit. Le Conseil a corrigé le premier jet de
ce rapport sur ce point.

`src/shared/user-facing-failure.ts:37` — le parcours d'erreur fait `current = candidate.cause` et
**rien d'autre**. Or `RetryError` (le SDK `ai`, rendu quand les reprises sont épuisées, c'est-à-dire
le cas « les trois fournisseurs ont échoué ») range ses erreurs dans `.errors[]` / `.lastError`, et
**son constructeur n'accepte pas de `cause`** (`node_modules/ai/dist/index.d.ts:6968-6972`).

**`[EXÉCUTÉ]`** — vraie `RetryError` du SDK contenant un vrai `APICallError` 429 de Groq :

```
name                  = AI_RetryError
.cause                = undefined   ← le parcours s'arrête ICI, profondeur 0
.lastError.statusCode = 429         ← jamais lu
⇒ GENERIC_FAILURE ❌  « remonte-le, je ne peux pas me réparer tout seul »

CONTRÔLE — le MÊME 429 posé en .cause  ⇒ QUOTA_FAILURE ✅
```

⚠️ **CE QUI N'EST PAS PROUVÉ** : que l'erreur reçue lors de l'incident du 2026-08-19 **était** une
`RetryError`. `CLAUDE.md` décrit la forme inverse — *« le message remonté est l'erreur BRUTE du
dernier maillon »*. Si un `APICallError` nu arrive, `:27` trouve `statusCode === 429` **à la
profondeur 0** et rend bien `QUOTA_FAILURE`. Le correctif reste à faire (4 lignes, sûres dans tous
les cas) ; le diagnostic reste une hypothèse.

⚠️ **CE QUI EST ÉTABLI, et c'est le meilleur constat du dossier** : `describeErrorChain` (`:48-65`) —
l'instrumentation **posée pour trouver cette cause** — parcourt elle aussi `.cause` seul. **L'instrument
partageait l'angle mort de ce qu'il devait mesurer.** C'est pourquoi le log n'a jamais rien montré.

## 1.4 Les patronymes ouest-africains cassent le parcours d'accueil

`src/features/onboarding/domain/services/interview-chat.ts:66-67` — `isQuestionToBot`, motif
`^(?:…|ou|où|quand|…)` **sans frontière de mot ni ancre de fin**, testé **avant** le garde
`FIRST_PERSON`.

**`[EXÉCUTÉ]`** — vraie fonction du dépôt :

```
❌ classé QUESTION  « OUATTARA »   « Ouattara »   « Ouedraogo »
❌ classé QUESTION  « Oumar »      « Ousmane »    « Quandt »
❌ classé QUESTION  « oumar@kisso.com »          ← une ADRESSE EMAIL
✅ accepté          « Traoré »     « Karyl »      « Nazer »
```

Kisso Industries est au **Bénin**. Ouattara, Ouédraogo, Ousmane, Oumar sont parmi les patronymes
les plus courants d'Afrique de l'Ouest. **Ce n'est pas un cas limite, c'est le cas nominal.**

**Trois défauts indépendants se composent :**
1. le nom part chez le modèle (brûle le quota) au lieu d'être enregistré ;
2. `runAgentPipeline` (`:1642`) écrit le tour **sans** le garde `hasPendingOnboardingQuestion` que
   possède le chemin statique (`:1826`) ⇒ `pendingProfileStep` devient `null`, **l'état meurt**, et
   rien ne repose la question ;
3. le tour mémorisé sera plus tard apparié par `collectProfileAnswers` à la question en attente, où
   il **prime sur l'annuaire ET sur le dossier** ⇒ peut être écrit en base comme patronyme.

Même famille, `[EXÉCUTÉ]` : `skipsInterview` classe « passe mes journees sur les tickets » et
« non stop du support » comme des **refus** de répondre.

## 1.5 La détresse n'est pas le premier court-circuit — ET son détecteur refuse ce qui est long

**`[EXÉCUTÉ]`** — ordre réel de `DETERMINISTIC_REPLIES`, et conséquence mesurée :

```
0.bare_greeting  1.file_attachment  2.no_textual_content  3.over_length  4.DISTRESS  …

détresse de 9 400 caractères → court-circuit retenu : over_length
détresse + pièce jointe      → court-circuit retenu : file_attachment
```

Quelqu'un qui écrit un long message de détresse reçoit **« Ton message est trop long »**. Avec une
capture d'écran jointe : **« Je ne sais pas lire les pièces jointes »**.

C'est rare, mais c'est **le pire cas possible de ce produit** — et le dépôt a énormément investi sur
ce chemin : numéros vérifiés un par un avec leur source, trois numéros écartés parce qu'ils sont d'un
autre pays, corpus à deux colonnes, aucune variante autorisée. L'ordre du tableau annule une partie
de cet investissement.

⚠️ **DÉPLACER `distress` EN TÊTE NE CORRIGE RIEN — correction du Conseil contre le premier jet de ce
rapport ET contre une objection interne.** `[EXÉCUTÉ]` :

```
distress.ts:235   const MAX_DISTRESS_LENGTH = 2000;
distress.ts:316   if (raw.length === 0 || raw.length > MAX_DISTRESS_LENGTH) return null;
```

**Le détecteur lui-même refuse de regarder au-delà de 2 000 caractères.** Le message de 9 400
caractères tomberait donc quand même sur `over_length`. Un correctif qui rassure sans agir coûte
plus cher que le défaut.

**Deux gestes, non interchangeables :**
1. déplacer `distress` en position 0 → ferme le cas « pièce jointe » ;
2. remplacer le **refus** par une **troncature tête + queue** dans `distressKind` /
   `distressLanguage` → ferme le cas « message long ».

```ts
const probe = raw.length <= MAX ? raw : raw.slice(0, MAX / 2) + ' ' + raw.slice(-MAX / 2);
```

✅ **Le coût ne bouge pas** — le travail reste plafonné à 2 000 caractères, donc l'objection ReDoS
tombe par construction, et `over_length` reste actif pour tout le reste. **La queue est
indispensable** : dans un long message de détresse, la phrase qui compte arrive souvent en dernier.

## 1.6 Une faute de frappe coupe `searchKnowledge`

`src/features/notification/domain/services/agent-routing.ts`

```
:83   (?:d[ié]cid|convenu|dit|parl|discut)     ← contient i et é, « e » ABSENT
:84   [ée]t[ée]                                ← la forme CORRECTE, ligne suivante
```

**La preuve que c'est une faute de frappe est dans le fichier lui-même.**

**`[EXÉCUTÉ]`** — `routeToAgent` réel :

```
« qu'est-ce qu'on a decide hier »  → onboardingOrchestrator  ❌ (ne porte pas searchKnowledge)
« qu'est-ce qu'on a décidé hier »  → knowledgeAgent          ✅
« ce qui a ete decide »            → onboardingOrchestrator  ❌
« ce qui a été décidé »            → knowledgeAgent          ✅
```

Sur un clavier de téléphone, `searchKnowledge` n'est **jamais** atteint. **Cinquième occurrence du
piège de l'accent** dans ce dépôt.

## 1.7 Une panne de base accorde `full` à tout le monde

`src/features/directory/application/services/access-guard.ts`

```
:99   const found = await this.hasManager().catch(() => false);
:106  if (!found) { warnOnce('… NO employee carries the manager role …'); return false; }
:77   effective: enforced ? decision.level : 'full'
```

`hasManager()` lit `slack_directory`, donc **Turso**. Son échec rend `false`, donc `canEnforce()`
rend `false`, donc **`effective` vaut `'full'` pour chaque acteur**. `AUTHZ_ENFORCE=true` est posé
en production.

**Trois aggravants :** la garde des 60 s pose `lastManagerCheck` **avant** l'appel, donc après un
échec tous les appels de la minute suivante rendent `false` sans même retenter ; `managerSeen` ne se
cliquette qu'au **succès** (asymétrie dans le mauvais sens) ; et **le diagnostic ment** — il affirme
« aucun manager désigné, lance `npm run role:set` » alors que la cause est une base indisponible.

**La faute de conception** : confondre « aucun manager n'est désigné » (configuration, fail-open
correct) et « je n'ai pas pu le savoir » (panne, qui doit conserver la posture). Le `.catch` efface
la distinction en rendant le même `false`.

---

# 2. Les garde-fous — preuve par mutation

Seize garde-fous ont été **cassés un par un** dans une copie jetable, puis la suite rejouée.

## 2.1 ✅ Neuf mutations sur dix TUÉES

`guards-are-mounted` (garde renommé) · `tool-classification` (agent fantôme dans `AGENT_TOOLS`) ·
`dead-config-claims` (`SLACK_BOT_TOKEN` déclaré mort) · `comments-live-in-docs` (commentaire
réinséré) · `assistant-persona` (« Je suis un outil d'onboarding ») · `architecture` (import
framework dans un `domain/` — **rouge sur 2 tests, dont la transitivité par `shared/`**) ·
`agent-instructions-budget` · `metric-catalogue` · `get-notification-history`.

**La majorité des garde-fous de ce dépôt sont réels.** `tool-contracts`, `agents-carry-security-prompt`
et `architecture` sont mutant-sensibles dans les deux sens et portent chacun leur propre
anti-faux-négatif. C'est meilleur que la moyenne de ce que l'on trouve en production.

## 2.2 ⛔ `guards-are-mounted` vérifie le NOM, jamais le CHEMIN

`tests/unit/quality/guards-are-mounted.test.ts:72` — seule assertion :

```ts
const orphans = guards.filter((name) => !middlewareBlock.includes(`${name}(`));
```

Aucun `path` n'est vérifié. Changer `path: '/api/*'` → `'/api/agents/*'` sur `createAgentApiGuard`
laisse la suite **verte** — et `GET /api/agents` rendrait de nouveau les instructions des quatre
agents en clair. Or `CLAUDE.md` documente explicitement que le joker doit être `/api/*` *« parce
qu'un joker Hono ne couvre pas `/api/agents` SANS segment suivant, or c'est la pire des quatre
surfaces »*. **La décision fine que la doc documente est exactement celle que le test ne garde pas.**

Second vecteur : `mountableGuards()` fait un `readdirSync` **non récursif** et exige le nom
`create…Guard|Middleware`. `slack-signature.ts` et `api-auth.ts` sont **déjà hors portée**.

## 2.3 ⛔ `claimed-invariants` est désarmé deux fois

`tests/unit/quality/claimed-invariants.test.ts:50`

```ts
const LOCK_CLAIM = /[Vv]errouill(?:é|ee|é|és|ées|ée)?s?\s+par\s+`([^`]+)`/gu;
```

**Désarmement 1 — aveugle aux formes sans accent.** Le groupe répète `é` deux fois et n'a **aucune
branche `e` nue**. `[EXÉCUTÉ]` :

```
MATCH  « Verrouillé par `a.ts` »        MATCH  « verrouillée par `a.ts` »
MISS   « Verrouille par `a.ts` »        MISS   « verrouille par `a.ts` »
```

C'est la **quatrième occurrence** du piège de l'accent — et cette fois elle est **dans le garde-fou
écrit pour attraper les affirmations qui dérivent**.

**Désarmement 2 — le corpus est vide.** `[EXÉCUTÉ]` : `grep -rIoE "[Vv]errouill" src/` → **0**.
Depuis l'extraction des commentaires vers `docs/` le 2026-08-21, il n'y a plus rien à attraper. Ses
contrôles positifs vérifient que des **fichiers** sont lus, jamais qu'une **affirmation** a été
trouvée — le mode de panne exact qu'ils existent pour prévenir.

✅ La bonne forme est écrite **juste à côté** : `dead-config-claims.test.ts:73` fait
`expect(claimed.length).toBeGreaterThan(0)`.

*Nuance : le second bloc (`docs/`) est correctement gardé (`:164` >15 fichiers, `:169` >50 citations).
Seule la moitié `src/` est morte.*

## 2.4 ⛔ Deux autres garde-fous unidirectionnels

- **`agent-wiring-is-derived.test.ts:52`** — `if (!Object.hasOwn(AGENT_TOOLS, id)) continue;` :
  un agent câblé mais **absent d'`AGENT_TOOLS`** est silencieusement ignoré. Or cette table gouverne
  le routage par capacité, `READ_ONLY_TOOL_NAMES` et la réconciliation FAIT/NARRATION. Un cinquième
  agent serait routable **et invisible aux trois détecteurs**.
- **`DETERMINISTIC_REPLIES.action`** — union de 5 valeurs, `switch` de 4 `case`, **sans `default` ni
  exhaustivité `never`**. Une 13ᵉ entrée dont l'action n'est pas traitée : le miroir est satisfait,
  `isAnsweredWithoutModel` rend `true`, **`DAILY_RULE` exonère le message du quota**, et le message
  tombe jusqu'à `agent.generate()`. ~~Contournement gratuit du plafond quotidien~~ — **RECLASSÉ MINEUR par le Conseil.** Ce classement
  reposait sur le « 12 messages/jour » de `CLAUDE.md`, que cet audit prouve lui-même faux (`limit:
  200`, § 3.3). Le vrai goulot est le quota fournisseur (~20 req/j) et `WORKSPACE_TOKEN_RULE`
  (4 M tokens/j) — **ni l'un ni l'autre touché par le miroir**. Le `default` / `assertNever` reste à
  ajouter, mais c'est de l'hygiène de typage, pas une protection de budget.

## 2.5 ⛔ « Aucun prompt ne prescrit un marqueur interne » — deux littéraux sur douze surfaces

`CLAUDE.md` annonce cette garantie. Le test réel (`llm-guardrail.test.ts:714-724`) boucle sur **deux
littéraux écrits à la main** contre **une seule constante**. `INTERNAL_MARKERS` en contient **huit** ;
le test n'importe pas la constante et n'appelle jamais `containsInternalMarkers`. Non couverts :
`AGENT_STYLE_BLOCK`, `agentToolBoundary`, les blocs métier des 4 agents, le prompt du rideau, les 15
fichiers de `.describe()`, tous les `hint`, les réponses figées. **C'est l'incident du 2026-08-15,
rejouable sur 11 des 12 surfaces.**

## 2.6 ⛔ `schema.ts` ↔ `ddl-*.sql` : les tests ne PEUVENT pas voir la dérive

Les 7 tests qui montent une vraie base libsql **dérivent leur DDL de `schema.ts` lui-même**. Ils sont
**structurellement incapables** de détecter un écart entre le schéma et la base réelle. Deux écarts
mesurés :

- `embedding F32_BLOB(1024)` existe dans deux `ddl-*.sql` et **nulle part dans `schema.ts`**. Le jour
  où quelqu'un écrit `.values({ embedding })`, Drizzle le jette **en silence** — le sinistre
  `documents.content`, rejoué.
- Les tables virtuelles **FTS5** et leurs 6 déclencheurs n'existent que dans les DDL, alors que deux
  repositories émettent du `MATCH … ORDER BY bm25(…)` dessus. **Une base construite comme la suite la
  construit ne peut pas exécuter `search()`.** Ces chemins n'ont aucun test.

---

# 3. La dérive documentaire — 188 affirmations testées

## 3.1 Le résultat, et il confirme la doctrine du dépôt sans exception

| Catégorie | Testées | Fausses | Dérive |
| --- | ---: | ---: | ---: |
| Mécanismes **DÉRIVÉS** du code (`Object.keys`, `toolsWithEffect`, constantes nommées) | 62 | 2 | **3 %** |
| Chemins de fichiers et noms de symboles | 130 | 6 | **5 %** |
| Raisonnements de conception (le POURQUOI) | 41 | 3 | **7 %** |
| Listes **RECOPIÉES** à la main | 22 | 12 | **55 %** |
| **CHIFFRES** recopiés | 38 | 26 | **68 %** |

**Un chiffre écrit à la main a environ deux chances sur trois d'être faux. Un mécanisme dérivé, une
sur trente.** L'audit ne trouve aucune exception à cette loi.

## 3.2 Le gouvernail hors du dépôt — un facteur, PAS « la cause »

**`[EXÉCUTÉ]`** — `git ls-files` :

```
❌ HORS GIT : CLAUDE.md    ❌ HORS GIT : TODO.md
❌ HORS GIT : CHANGELOG.md ❌ HORS GIT : AUDIT_REPORT.md
✅ versionné : README.md
```

`.gitignore` porte `/*.md` avec `!README.md`. Conséquences :

1. **Aucun diff, aucune revue, aucune CI ne voit jamais `CLAUDE.md`.**
2. La « Carte des documents » renvoie à `AUDIT_REPORT.md §8` comme **la** liste des points ouverts —
   sur un clone, **ce fichier n'existe pas**.
3. La règle de travail n° 3 (« mettre à jour `TODO.md` et `CHANGELOG.md` ») porte sur des fichiers
   invisibles à toute revue.
4. `claimed-invariants.test.ts` scanne `DOC_ROOTS = ['docs', '.claude']` — **jamais la racine**.
5. **Un seul test lit réellement `CLAUDE.md`** : `dead-config-claims.test.ts`, sur **un paragraphe**.

⚠️ **Et c'est le seul paragraphe à instruction d'action qui n'a pas dérivé.** Le seul endroit
surveillé est le seul endroit juste.

⚠️ **MAIS LA THÈSE CAUSALE EST UN EXCÈS — correction du Conseil contre le premier jet.**
`.gitignore:26-27` porte son propre commentaire : *« Documents de travail à la racine : non versionnés
(décision du 2026-08-20). La documentation versionnée vit dans `docs/` »*. **C'est une décision
assumée, pas un accident.** Et la thèse est **réfutée par les mesures de cet audit lui-même** : les
68 % de dérive sur les chiffres recopiés existent **aussi à l'intérieur de `docs/`**, qui est
versionné, relu, et qui porte deux affirmations de sécurité fausses (§ 3.4). Versionner `CLAUDE.md`
n'aurait pas rendu vrai un « 12 messages/jour » tapé à la main. **La cause est la RECOPIE, pas
l'absence de diff.**

✅ **Ce qui survit intact et mérite MAJEUR** : la « Carte des documents » désigne `AUDIT_REPORT.md §8`
comme **la** liste des points ouverts, et ce fichier n'existe sur **aucun clone**. Un nouvel arrivant
est envoyé vers un fichier fantôme pour connaître l'état du projet.

## 3.3 Les affirmations fausses qui feraient AGIR de travers

| Affirmation | Réel |
| --- | --- |
| « `npm run lint` est suffixé `\|\| true` — ne casse jamais le build » | **Faux**, et auto-contredit 1 400 lignes plus bas. Enseigne d'ignorer un signal bloquant. |
| « Le routage a **quatre temps**, les listes sont CONTRACTUELLES » | **Cinq.** `agent-routing.ts:157` `asksForAScheduledReminder` court-circuite tout, y compris la bande d'échappement. |
| « une personne ayant atteint ses **12 messages du jour** » (×2) | `DAILY_RULE.limit = **200**`. Faux d'un ordre de grandeur, et sert d'argument à deux raisonnements de conception. |
| `documentGenerationWorkflow`, `PdfmakeService.generate()`, `PdfService` décrits **au présent** | **Zéro occurrence** des trois. Deux paragraphes protègent un fantôme. |
| « `createRequestContextGuard` monté **en PREMIER** » | Il est **troisième**. Un lecteur qui « rétablirait » l'ordre annoncé déplacerait un garde de sécurité sur la foi d'une phrase fausse. |
| « `@getbrevo/brevo` en repli » | Le paquet **n'est ni dans `package.json` ni dans `node_modules`**. `README.md` dit vrai et contredit `CLAUDE.md`. |
| « **9** court-circuits déterministes » | **12.** Trois ne sont nommés nulle part. |
| « Le routage vit dans `slack-events.handler.ts` » | Il vit dans `agent-routing.ts`. Envoie fouiller un fichier de 2 912 lignes. |

## 3.4 ⛔ Deux affirmations de SÉCURITÉ déjà fausses

1. **`docs/conception/knowledge.md:41`** — *« `channel` et `group` entrent, `im` et `mpim` non »*,
   sous le titre « Ce qui n'y entre JAMAIS ».
   **Réel** : `ARCHIVED_CHANNEL_TYPES = ['channel', 'group', 'im']`. **`im` est dedans.**
   C'est la page qu'on lit **avant** de toucher la garde d'ingestion, et elle nie la décision produit
   la plus lourde du dépôt — le manager relit les DM. `CLAUDE.md` dit l'inverse dans le même dépôt :
   **le dépôt se contredit sur une frontière de vie privée.**

2. **`CLAUDE.md` §recrutement** — *« AUCUNE écriture en base, et c'est un choix […] stocker l'adresse
   d'un NON-SALARIÉ créerait des données personnelles sans chemin d'effacement — le trou déjà
   recensé »*.
   **Réel** : `drizzle-pending-email.repository.ts:21-25` insère `to` (l'adresse du **candidat**),
   `candidateName`, `position`, `location`. **Le trou que la phrase déclare fermé est ouvert**, et la
   chaîne `forget` ne touche pas cette table.

## 3.5 Le code qui ment pendant que la doc dit vrai

Le prompt de `recruitmentAgent` promet encore *« la carte l'affiche pour relecture et il ne part
qu'après un clic »*. Le bouton a été retiré le 2026-08-19 et `CLAUDE.md` le documente correctement.
**C'est une consigne d'agent périmée** — la famille exacte de `READ_ONLY_TOOL_NAMES` gardant
`getTaskList`, en sens inverse.

---

# 4. Les autres constats significatifs

## 4.1 Ce qui est mesuré puis jeté — et une CORRECTION à `CLAUDE.md`

✅ **Trois des quatre affirmations de `CLAUDE.md` sur ce point sont FAUSSES — la donnée EST persistée :**

| Affirmation | Verdict | Preuve |
| --- | --- | --- |
| « la latence … puis jetée » | **FAUX** | persistée `handler:1466`, **relue** `dashboard-facts:90` |
| « le verdict FAIT/NARRATION … INCOMPTABLE » | **FAUX** | persisté `:1469-1470`, relu `:88` |
| « les appels d'outils ne sont journalisés nulle part » | **FAUX** | persistés `:1464-1465`, relus `:93-95` |
| « l'issue des invitations aux canaux … jetée » | **VRAI** | `welcome-channels.service.ts:83-113`, aucune écriture |

**Ce qui est réellement inobservable**, en revanche :

- **Quel maillon LLM a servi une réponse.** `withChainFailureLogging` ne journalise que dans le
  `.catch()` — un maillon qui **réussit** n'émet rien. Toute la doctrine de coût du dépôt repose sur
  cette distinction. ✅ **Réparable à coût quasi nul** : la sonde de production montre que la réponse
  porte `providerMetadata: { google: {...} }` — **le fournisseur est déjà dans l'objet**, il n'est
  simplement pas journalisé.
- **Le traitement complet d'un message.** `[EXÉCUTÉ]` : `logger.ts:381` évalue `randomUUID()` **une
  fois**, dans le constructeur du singleton de module ; `grep "logger.child(" src/` → **zéro
  appelant**. Le `requestId` est donc **constant par instance**. `audit_logs.request_id` est **NULL
  sur 100 % des lignes**, et son index porte sur une colonne toujours vide.
- **Toute tentative de prompt-injection détectée.** `[EXÉCUTÉ]` : `node_modules/@opentelemetry/`
  ne contient que `api` ; aucun `TracerProvider` ni `MeterProvider` n'est enregistré nulle part.
  L'API non enregistrée rend des no-op ⇒ **`injectionCounter.add(1)` n'incrémente rien**, les spans
  n'enregistrent rien, `traceId`/`spanId` sont toujours `undefined`.
- **Aucune alerte, aucun transport de logs hors de la machine.** `logger.transport` existe et le
  singleton est construit **sans**. Tout signal finit sur le stdout d'une fonction Vercel, remis à
  zéro à chaque redéploiement.

## 4.2 Le budget de temps de la fonction est structurellement dépassable

Constantes lues, séquencement vérifié :

```
model-fact-summarizer.service.ts:14   CALL_TIMEOUT_MS           = 20 000   (second rideau)
model-fallback.ts:148                 AGENT_GENERATE_TIMEOUT_MS = 40 000
intent-chain.ts:3                     MAX_CHAIN_LENGTH          = 2
fix-vercel-output.js:134              maxDuration               = 60 s

handler:1067  await this.ingest(envelope); await this.processEvent(envelope);   ← rideau SÉQUENTIEL
handler:2105  for (const [index, step] of steps.entries()) { await runAgentPipeline(…) }
```

**Pire cas : 20 + 40 + 40 = 100 s pour un plafond de 60 s.** Sans le rideau : 80 s.

⚠️ **La mort n'est pas une erreur, c'est un SILENCE** : aucun `catch` ne s'exécute, aucune ligne
n'est écrite. Huit états intermédiaires deviennent orphelins — dont un tour `user` sans tour
`assistant`, et un dossier employé créé sans `slack_directory.employee_id`, **c'est-à-dire la cause
racine du 2026-08-19 reproduite par un simple dépassement de durée**.

## 4.3 ⛔ `npm run test:integration` écrit en PRODUCTION

`tests/integration/live-integration.test.ts:51-88` fait un `POST` sur
`https://mastra-71ya.vercel.app/api/agents/onboardingOrchestrator/generate` et demande la **création
d'un employé « Jane Doe »**. Le `globalSetup` crée pourtant une base SQLite jetable — elle ne protège
**pas** ce fichier, qui sort par HTTP vers la Turso de production.

Conséquences : une vraie ligne employé + un appel de modèle sur les ~20 du jour.
✅ Il n'est **pas** dans la CI. Ce test n'a pas été exécuté pendant cet audit.

## 4.4 Autres constats notables

| Constat | Preuve | Gravité |
| --- | --- | --- |
| `excerpt-salience` écrit ses motifs **avec** accents et les teste sur du texte **non plié** ; `fact-distillation.ts:82` appelle `signalScore(raw)` **avant** le classifieur qui, lui, plie. Le portier aveugle annule le classifieur tolérant ⇒ **« on a decide de partir sur postgres » ne produit toujours aucun fait.** Le bug que `CLAUDE.md` déclare corrigé ne l'est qu'à moitié | `[LU]` | MAJEUR |
| `readAffectedRows → 0` **non testé** pour le dépôt notifications. Un driver sans `rowsAffected` ⇒ chaque prise devient un refus ⇒ **panne totale des rappels rapportée en `200 {ok:true, sent:0}`**. La même dégradation **est** testée pour la dédup Slack | `[LU]` | CRITIQUE |
| `method: 'GET'` de la route cron **verrouillée par aucun test**. La passer à `'POST'` laisse la suite verte et tue le cron en silence | `[LU]` | MAJEUR |
| `deliveredOn` calcule le jour **UTC**, `isDueForDispatch` juge le jour **LOCAL**. Entre 23:00Z et minuit, le bot annonce un jour que le dispatcher n'honorera pas | `[LU]` | MAJEUR |
| **Trois gardes d'idempotence par instance** (`tool-idempotency.ts`, `notifiedWindows`, `settledCards`) dans un runtime où le démarrage à froid **est** le cas nominal. La dédup Slack et la prise de rappel **ont** été promues en store partagé ; ces trois-là non | `[LU]` | MAJEUR |
| `notifiedWindows` (`slack-rate-limiter.ts:44`) est un `Set` **jamais vidé** — ni `max`, ni `ttl`, ni purge. Seul conteneur non borné du dépôt, voisin ligne 51 d'un `LRUCache` correctement configuré | `[EXÉCUTÉ]` | MINEUR |
| `mayTouchRecord` mis à part, **6 outils sur 13 dépendent uniquement de lui** ; 4 autres ont un second verrou | `[EXÉCUTÉ]` | (voir §1.1) |
| Le contrôle de santé au démarrage **ne peut pas journaliser son propre avertissement** : `connectionManager` est `null` à l'import, `healthCheck()` rend `false` sans lever, donc le `.catch()` ne se déclenche jamais et le booléen est jeté par `void` | `[LU]` | MINEUR |
| **Un octet NUL** dans `tests/unit/knowledge/excerpt-budget.test.ts` en fait le seul fichier que `grep -I` **saute en silence**. Tout audit par grep a un angle mort à cet endroit — celui-ci compris, jusqu'à ce qu'il soit comblé | `[EXÉCUTÉ]` | MINEUR |
| Le tableau de bord échoue plusieurs critères WCAG : aucun `<li>`, aucun ARIA, **aucun `<label for>`**, `innerHTML` remplacé toutes les 15 s **sans `aria-live`**, erreurs jamais annoncées, contraste `.card .src` à 3,17:1 | `[LU]` | MAJEUR |
| `namesItselfAsMachine` **n'est appelé nulle part dans `src/`** : la garantie de persona porte sur les chaînes en dur du dépôt, **jamais sur la sortie du modèle** | `[LU]` | MOYEN |
| `message.channels`/`.groups` **non abonnés** ⇒ la base de connaissance ne peut contenir que des DM. Geste humain dans la console Slack, pas correctif de code | `[LU]` | MAJEUR |
| Node local **v20.19.4** vs `engines >=22.13.0`. CI et Vercel sont en 22.x : **le local valide sur un runtime que la production n'exécute pas** | `[EXÉCUTÉ]` | MOYEN |
| `SSRF` : le portier d'ACK construit son URL de réexpédition par concaténation d'un `x-forwarded-host` **non validé**, en y joignant le corps brut et une signature Slack valide. Le commentaire justifie bien *pourquoi* l'hôte vient de la requête ; il manque la liste blanche de suffixes | `[LU]` — exploitabilité **NON-VÉRIFIABLE** (dépend de l'edge Vercel) | MAJEUR |

---

# 5. Ce qui fonctionne — et c'est la majorité

Un audit qui ne rapporte que les défauts ment par omission. Ce dépôt a des qualités **rares**.

## 5.1 Mesures irréprochables

- **Zéro `any` sur 24 804 lignes.** `grep -rnE '(:\s*any\b|\bas any\b|<any>|any\[\]|Promise<any>)' src/`
  → **0 occurrence**. Le code utilise `unknown` + narrowing partout où un `any` serait tentant.
- **Zéro `@ts-ignore`, zéro `@ts-nocheck`, zéro `@ts-expect-error`** dans `src/`, `tests/`, `scripts/`.
- **`typecheck` 0 · `lint` 0 erreur 0 warning · 2 869 tests verts · couverture 86 %.**
- **`tsconfig.json`** active `strict`, `noFallthroughCasesInSwitch`, `noImplicitReturns`,
  `noUnusedLocals/Parameters`, `isolatedModules`, `noImplicitOverride`, `verbatimModuleSyntax`,
  `allowUnreachableCode: false`. `scripts/` est bien dans `tsc` **et** dans `eslint`.

## 5.2 La sécurité en production tient — 20 sondes, 20 refus corrects

- Le HMAC Slack est **correct sur les quatre routes** : comparaison à temps constant, fenêtre de
  5 min bornée des deux côtés, corps signé lu **avant** parsing, **et le contrôle de fraîcheur passe
  avant le HMAC** (bon ordre : un rejeu est rejeté sans dépenser de crypto).
- ✅ **Aucune porte dérobée sur `/internal/slack/events`** — il re-vérifie la signature sur le corps
  réexpédié. C'était le point le plus risqué de la sonde, et il est propre.
- ✅ **Le garde de `requestContext` forgé est vivant et monté en premier** : `400` **avant** le `401`
  d'authentification, en nommant les deux clés refusées.
- ✅ **La rédaction du prompt système tient pour un porteur de jeton** : les 4 agents rendent
  `[instructions non divulguées]`, **zéro marqueur interne**.
- ✅ **La garde d'exécution d'outil refuse en `403`** avec un message explicite, et l'extraction de
  prompt est refusée **à l'entrée en `400`, sans appel de modèle**.
- ✅ **CORS non permissif** (aucun `Access-Control-Allow-Origin` à une origine hostile),
  `DASHBOARD_TOKEN` et `CRON_SECRET` réellement configurés et refusant **sur le fond**.
- ✅ **La page `/dashboard` ne porte aucune donnée** — vérifié : aucun email, aucun nom, aucun
  instantané inline. Toutes les injections `innerHTML` passent par `esc()`.
- **Aucun `sql.raw`** dans le dépôt. La requête FTS est construite par **liste blanche**, les
  opérateurs FTS5 sont structurellement inatteignables.
- **Aucun secret en dur** ; `.env` jamais commité ; **aucune valeur de clé d'API journalisée**.

## 5.3 Les mécanismes DÉRIVÉS — ce qu'il faut généraliser

Ce sont ceux qui n'ont pas dérivé, et la raison est toujours la même : **ils sont calculés, pas
recopiés.**

- `agentToolBoundary` dérivé d'`Object.keys(tools)` — une liste écrite à la main se serait
  désynchronisée au premier changement de câblage ; celle-ci ne le peut pas.
- `READ_ONLY_TOOL_NAMES` / `ACTING_TOOL_NAMES` désormais calculés depuis `TOOL_EFFECTS` : **le défaut
  historique de `getTaskList` ne peut plus se reproduire.**
- `isAnsweredWithoutModel` **dérive** de `DETERMINISTIC_REPLIES` : il n'y a plus deux listes.
- `KNOWN_AGENT_IDS = new Set(Object.keys(AGENT_TOOLS))`.
- `tool-contracts.test.ts` **ferme la boucle jusqu'au littéral `id:`** du fichier d'outil — le
  meilleur garde-fou du dépôt.
- `resolveModelIds` : source unique de la chaîne LLM, `PRIMARY_MODEL_ID` **dérivé**.
- `resolveAccess` : une seule implémentation, importée par le garde, la politique de divulgation
  **et** la sonde `probe:authz`.

## 5.4 Les honnêtetés dures, réellement tenues

- **Aucun chemin n'enregistre `Sent` avant que l'envoi ait réussi** — vérifié aux deux écrivains.
  Les trois « menteurs » historiques nommés dans `CLAUDE.md` sont réellement corrigés.
- Le repli email se déclenche sur **tout** échec Slack, et le verdict **nomme toujours
  `missing_scope`** quand c'est la cause première.
- `findPersonByName` ne rend **aucun identifiant** sur ambiguïté — l'appel suivant devient
  structurellement impossible, donc le modèle doit demander.
- La prise de rappel est un `UPDATE … WHERE` qui **rend un compte**, avec contrat partagé vérifié sur
  les **deux** implémentations, la Drizzle contre une vraie base libsql.
- Le corpus de détresse est **à deux colonnes** (ce qu'il faut attraper **et** ce qu'il faut
  épargner) : **0 faux négatif, 0 faux positif**. Trois numéros d'urgence ont été écartés à la
  vérification parce qu'ils sont d'un autre pays.
- `assertNoReadTools` fait **lever au démarrage** si on câble une lecture sur `recruitmentAgent`.

---

# 6. Le Conseil — six voix

## 6.1 Les SIX causes racines

Le premier diagnostic (« le piège de l'accent ») était **superficiel**. La délibération l'a corrigé
et le résultat est meilleur.

### RC1 — La normalisation est RECOPIÉE, pas DÉRIVÉE

**`[EXÉCUTÉ]`** :

```
src/shared/intent-text.ts → normalizeIntentText()   EXISTE et est CORRECT
7 modules l'importent : distress, forget, greeting, pin-fact, cancel-reminder,
                        profile-request, top-role-claim
12 pliages NFD MAISON coexistent dans src/
agent-routing.ts → ZÉRO usage du helper (.toLowerCase() seul)
```

**Aucun des cinq bugs d'accent n'est dans les sept modules qui utilisent le helper.** Les cinq sont
exactement les modules qui ont refait leur pliage ou n'en ont aucun.

La preuve la plus nette est dans `ESCAPE_INTENTS` lui-même :

```ts
'crée', 'créer', 'création', 'cree', 'creer', ...   // le produit cartésien recopié À LA MAIN
'résume', 'résumé', 'resume', 'resumé', ...
```

Ce n'est pas un oubli ponctuel : c'est une **stratégie**, appliquée consciemment pour compenser un
pliage absent, et qui échoue exactement là où la main s'est arrêtée — `decide`, `bloque`,
`verrouille`.

RC1 explique aussi le `switch` qui recopie 4 des 5 membres de l'union `action`, les 47 affirmations
périmées, les 68 % de chiffres faux et les 55 % de listes fausses.

### RC2 — L'inconnu est coercé vers le commode

**Le dépôt n'a aucune représentation de « je ne sais pas ».** Partout, l'échec de lecture produit une
valeur du **même domaine** qu'une lecture réussie — et c'est toujours celle qui laisse passer.

| Site | Ce qui est perdu | Ce que ça ouvre |
| --- | --- | --- |
| `slack-request-context.ts:154` `if (!context) return true` | « hors Slack » vs « contexte illisible » | 7 outils, dossier RH de n'importe qui |
| `access-guard.ts:99` `.catch(() => false)` | « aucun manager » vs « Turso muet » | `effective = 'full'` **pour tous** |
| `handler:2829` `catch { return undefined }` | erreur vs `readonly` | `undefined !== 'denied'` ⇒ autorisé |
| `drizzle-message-archive:120` `as unknown as Row[]` | « je ne connais pas la forme » | 4 champs sur 6 perdus |
| `fact-curtain.service.ts:103` | échec vs rejet légitime | `markDistilled` s'exécute quand même |
| `user-facing-failure.ts:37` `= candidate.cause` | `.errors[]` invisibles | panne réparable présentée comme bug |

⚠️ **Le correctif de sécurité du 2026-08-14 a converti une usurpation POSSIBLE en usurpation
SYSTÉMATIQUE.** En refusant toute clé `slack*` venue d'un appelant HTTP, il a **garanti** que tout
appel `/api/*` arrive dans la seule branche qui rend `true`. On a durci le contrôle de la **valeur**
et jamais celui de l'**absence**.

**Correction de chiffrage, mesurée** : ni 6 (première estimation) ni 8 (celle du Conseil) — **7**
outils sur les 9 qui appellent ces gardes n'ont aucun second verrou :
`find-employee-by-email`, `find-person-by-name`, `get-employee-profile`, `get-notification-history`,
`schedule-reminder`, `update-onboarding-status`, `send-notification`.
Deux en ont un : `generate-document`, `schedule-candidate-interview`.

⚠️ **`find-employee-by-email` est dans la liste des 7** — or `CLAUDE.md` écrit : *« Le chemin email
ne doit JAMAIS devenir un ORACLE […] sinon on énumère l'annuaire une adresse à la fois. »*
**Via `/api/*`, il en est un.**

### RC3 — L'état par instance dans un runtime sans instance

Promus en store partagé : **2** (dédup Slack, prise de rappel). Restés en mémoire : **5**
(`tool-idempotency`, `notifiedWindows`, `settledCards`, le LRU d'identité, `warnOnce`).

La raison de l'écart est visible : **les deux promus l'ont été après un incident OBSERVÉ**. Les cinq
autres n'ont jamais produit de symptôme visible, leur mode de panne étant un doublon silencieux ou
un avertissement absent.

### RC4 — Un contrôle dont le sujet peut devenir vide sans que le contrôle échoue

Ce n'est **pas** RC1 : ces mécanismes *sont* dérivés — d'un ensemble vide. Voir § 2.3 et 2.4.
Le contre-exemple est dans le même répertoire, écrit par la même main :
`dead-config-claims.test.ts:73` fait `expect(claimed.length).toBeGreaterThan(0)`.
**La bonne forme existe, à quinze mètres, et n'a pas été généralisée.**

### RC5 — L'instrument partage l'angle mort de ce qu'il mesure

La plus insidieuse, parce que **son symptôme est l'absence de symptôme**.

- `describeErrorChain`, **posé pour trouver le mystère du quota**, parcourt `.cause` seul — comme le
  code fautif.
- `healthCheck()` au démarrage ne peut **structurellement pas** émettre son propre avertissement.
- Toute la télémétrie OTel est no-op : le compteur de détection de prompt-injection n'incrémente rien.
- `warnOnce` de l'access-guard **nomme la mauvaise cause** et oriente vers le mauvais geste.

### RC6 — Le gouvernail est hors du dépôt

`.gitignore: /*.md`. Voir § 3.2.

⚠️ **Mais RC6 n'est pas suffisante**, et il faut le dire contre l'intuition : `docs/` **est**
versionné, relu — et porte quand même **deux affirmations de sécurité fausses** (§ 3.4). Le
versionnement rend la dérive **revuable**, pas **impossible**.

### Ce qu'aucune cause n'explique

**La détresse en 5ᵉ position** (§ 1.5) n'est ni une dérive, ni une absence, ni un recopiage. C'est une
décision jamais prise : l'ordre du tableau porte une sémantique de priorité que **rien n'énonce** —
contrairement à `ESCAPE_INTENTS`, où « l'ordre du tableau EST la priorité » est écrit noir sur blanc.

## 6.2 Le correctif structurel — rendre les familles IRREPRÉSENTABLES

> **Règle** : aucun `catch`, aucun `??`, aucun `!x`, aucun `as unknown as` ne doit produire une
> valeur du **même domaine** qu'une lecture réussie.

```ts
readSlackContext(rc): { kind: 'slack', ctx } | { kind: 'absent' } | { kind: 'unreadable' }
hasManager(): Promise<'yes' | 'no' | 'unknown'>
```

`mayTouchRecord` **ne compile plus** sans traiter les trois cas. `canEnforce` non plus — et l'auteur
découvre **en l'écrivant** que « aucun manager désigné » et « je n'ai pas pu le savoir » sont deux
choses, ce qui est exactement la faute de conception de `access-guard.ts:99`.

Cette seule discipline rend RC2 **inexprimable**, donc ferme **cinq critiques sur sept** par une
contrainte de typage.

✅ **Et le dépôt a déjà inventé ce mécanisme** : le tableau de bord distingue `no_data_yet` de
`not_persisted` — *« les afficher pareil transformerait une base neuve en diagnostic de panne »*.
C'est mot pour mot RC2, résolu, dans un coin, **jamais généralisé**.

**Second geste** : `makeGuardedTool({ requires: 'requester' | 'none' })` obligatoire, plus un test
qui énumère les `createTool` et exige que chacun déclare son exigence. Même raisonnement que
`agentToolBoundary` : ne pas demander à l'auteur de se souvenir, **dériver de la construction**.

**Sur `CLAUDE.md` dans git** : nécessaire, non suffisant. Le complément vient de la seule mesure qui
ne se discute pas — un chiffre écrit à la main a **~2 chances sur 3** d'être faux, un mécanisme
dérivé **1 sur 30**. La conclusion n'est pas « mieux relire les chiffres » :

> **Il n'existe aucune façon d'écrire un chiffre à la main qui reste juste.**

Donc : tout nombre et toute liste de `CLAUDE.md` doivent vivre dans un bloc balisé qu'un test
re-dérive — la forme exacte de `dead-config-claims.test.ts`, généralisée — et la prose non balisée
n'a plus le droit de porter un chiffre. Vérifiable par un test.

## 6.3 La loi générale

Le dépôt a découvert *« ce qui est DÉRIVÉ tient, ce qui est RECOPIÉ dérive »*. Cette loi est vraie et
**incomplète de deux moitiés** :

> ## Ce qu'on n'a pas constaté ne doit ni être affirmé, ni servir de valeur par défaut — et un contrôle qui ne prouve pas avoir trouvé quelque chose n'a rien constaté.

| Clause | État | Conséquence mesurée |
| --- | --- | --- |
| « ni être affirmé » | appliquée avec rigueur | **3 %** de dérive sur les mécanismes dérivés |
| « ni servir de valeur par défaut » | **jamais appliquée** | **5 critiques sur 7** |
| « un contrôle vide n'a rien constaté » | **jamais appliquée** | **4 garde-fous désarmés** |

**Un défaut, un `catch` et un `as` sont des affirmations.** Les soumettre à la règle que le dépôt
s'est déjà donnée fermerait cinq des sept critiques sans en discuter une seule individuellement.

---

# 7. Le décompte — 976 points

Répartition réelle des points numérotés, par dimension. **Le chiffre demandé était 500 ; celui-ci
est rapporté tel quel, sans rembourrage ni troncature.**

| Dimension | Préfixe | Points | Portée |
| --- | --- | ---: | --- |
| Fonctionnel | `FN-` | **262** | 12 parcours, 12 court-circuits, routage, cas limites, intégrations, i18n, accessibilité |
| Dérive documentaire | `DOC-` | **188** | 188 affirmations de `CLAUDE.md`/`README.md`/`CONTEXT.md` confrontées au code |
| Sécurité | `SEC-` | **150** | authz, injection, données, infra, pénétration statique |
| Résilience / observabilité | `AR-` | **110** | budget de tokens, requêtes, index, résilience, scalabilité, logs |
| TypeScript | `TS-` | **106** | config, typage avancé, écart type↔runtime |
| Qualité / architecture | `QA-` | **106** | statique, patterns, tests, doc, **+ 10 mutations** |
| Garde-fous (méta-audit) | `GRD-` + `M-` | **34** | 28 garde-fous + 6 preuves par mutation |
| Production (sondes) | `PROD-` | **20** | endpoints, en-têtes, CORS, traversée, région |
| **Total** | | **976** | |

**S'y ajoutent, hors numérotation** : la base de référence re-mesurée (typecheck, lint, 2 869 tests,
couverture par fichier), 4 sondes de production **authentifiées** (rédaction du prompt ×2, garde
d'outil, extraction refusée), 5 sondes déterministes **signées** en DM, et une vingtaine de
vérifications de premier ordre menées directement pour confirmer ou infirmer les constats des
auditeurs — dont **trois qui ont corrigé un auditeur** (le compte d'outils non gardés : 7, ni 6 ni 8).

## Verdicts, tous dimensions confondues

| Verdict | Sens |
| --- | --- |
| **PASS** | vérifié, avec sa preuve `fichier:ligne` ou son test nommé |
| **FAIL** | défaut réel, avec son scénario d'échec concret et sa gravité |
| **N/A** | ne s'applique pas à ce produit (une bonne partie du gabarit de la demande) |
| **NON-VÉRIFIABLE** | dit comme tel, jamais comblé par une supposition |

⚠️ **Un `PASS` sans preuve citée a été refusé partout.** C'est la règle que ce dépôt s'applique à
lui-même, et l'audit se l'est appliquée.

---

# 8. Le classement par TORT HUMAIN

Le classement technique n'est pas le classement du mal fait. Voici le second.

| # | Ce que la personne vit | Fréquence |
| --- | --- | --- |
| **1** | **Un salarié nommé Ouattara, Ouédraogo, Oumar ou Ousmane ne peut pas s'inscrire.** Marcel demande son nom, le prend pour une question, répond à côté. Elle recommence — c'est déterministe, ça ne peut pas mieux marcher au deuxième essai. Au troisième, elle abandonne. Ce qu'elle en conclut n'est pas « il y a un bug » : c'est **« leur système ne reconnaît pas mon nom »**. Et elle se heurte au mur **deux fois** sur quatre questions, car `oumar@kisso.com` est avalé aussi. Il existe une porte de sortie (« j'ai fini ») — **écrite nulle part** | Cas nominal au Bénin |
| **2** | **Un message de détresse un peu long reçoit « Ton message est trop long ».** Avec une capture d'écran : « Je ne sais pas lire les pièces jointes. » Quand la détresse *est* reconnue, la réponse est **excellente** — numéros béninois vérifiés, police distinguée du SAMU, promesse de confidentialité réellement tenue. **Tout ce travail est annulé par la position d'une ligne dans un tableau** | Rare, irréparable |
| **3** | **Chaque jour vers le 20ᵉ message, Marcel dit à tout le monde qu'il est cassé.** Le message juste existe et est bien écrit ; il ne sort jamais. Les sept personnes reçoivent une invitation à signaler un incident pour une situation normale qui se répare seule le lendemain | Quotidien, tout le monde |
| **4** | **Quelqu'un décrit son métier et Marcel répond « on laisse ça de côté ».** `[EXÉCUTÉ]` : « Non stop du support », « Passe mes journées sur les tickets » sont classés comme des **refus de répondre**. La personne a pris la peine d'écrire ; on lui dit qu'elle a choisi de se taire. Son guide sortira sans « Ton quotidien » ni « Ta façon de travailler » | Fréquent |
| **5** | **Une question tapée sans accent ne trouve rien.** Sur un clavier de téléphone, la recherche dans la mémoire n'est jamais atteinte | Quotidien |

## Ce qui fait le plus de mal à l'ENTREPRISE

- **Une panne de base ouvre les dossiers RH à tout le monde.** Pas besoin de jeton, pas besoin d'être
  développeur : n'importe laquelle des sept personnes, pendant l'incident, peut demander le dossier
  d'une autre **par Slack**. C'est le seul trou de sécurité qui atteigne vos gens directement.
- **Aucun message privé n'est jamais effacé.** Les DM sont archivés, le manager a le droit de les
  relire, et la variable qui déclencherait la purge **n'a jamais été posée** — elle est déclarée
  **vide** dans `.env.example`, donc la copier ne suffit pas. Chaque matin, le cron appelle
  fidèlement la purge, qui ressort aussitôt sans rien faire. **Rien n'a jamais été supprimé.** La
  lecture par le manager est une décision assumée ; **la conservation illimitée n'a été décidée par
  personne.**
- **Les données des candidats restent** — voir § 3.4.

## Les trois réparations avant lundi

1. **Le nom de famille** — une frontière de mot dans une expression régulière. *Pourquoi d'abord* :
   elle frappe à l'accueil, sur les noms les plus courants du pays, elle est déterministe, et ce
   qu'elle produit n'est pas de la frustration technique mais **un jugement sur l'entreprise**.
2. **La détresse en tête + la troncature du détecteur.** *Pourquoi* : c'est le pire cas du produit,
   la réponse est **déjà écrite et bonne**, et vous payez aujourd'hui pour un travail que l'ordre
   d'un tableau annule.
3. **Le message de quota** — suivre aussi `.lastError` et `.errors[]`. *Pourquoi* : c'est le défaut
   qui touche **le plus de personnes le plus souvent**, et il apprend à vos gens que Marcel est
   cassé alors qu'il ne l'est pas.

**Pourquoi ces trois-là plutôt que les failles de sécurité.** Les trois sont des accidents de
quelques caractères qui se déclenchent **tout seuls**, sur le chemin normal, sur des gens ordinaires,
un jour ordinaire. Les deux grandes failles demandent une condition qui n'est pas là en permanence :
un jeton de service entre des mains malveillantes, ou une panne de base. Elles sont **plus graves si
elles surviennent** ; elles sont **moins probables cette semaine**. Et surtout, elles ne se corrigent
pas bien en une heure un vendredi soir — l'une demande de reprendre sept outils, l'autre de
distinguer proprement deux états. **Bâclées, elles peuvent couper le produit pour tout le monde.**

⚠️ **Mais je ne les repousse pas plus loin.** Si vous ne devez en garder qu'une pour la semaine
suivante, prenez **la panne de base qui ouvre la frontière** : c'est la seule des deux qui atteigne
vos sept personnes sans jeton ni outil, par Slack, un jour de mauvais réseau. Et le fait qu'elle
**mente ensuite dans le journal** — en vous disant de désigner un manager alors que le vrai problème
est la base — est ce qui vous fera perdre le plus de temps le jour où elle se déclenche.

## Le défaut classé « mineur » qui ne l'est pas

Les garde-fous qui empêchent Marcel de produire deux fois le même document vivent **dans la mémoire
d'une instance**. Or à ~19 messages/jour, chaque message tombe presque toujours sur une instance
neuve, à la mémoire vide.

Ces garde-fous ont été construits après un incident que le projet a lui-même consigné : **sept
documents et trois emails identiques en huit minutes**. Ils protègent bien la boucle *à l'intérieur
d'une seule demande*. Ils ne protègent **pas** le cas où une personne redemande la même chose parce
qu'elle n'a pas vu passer la première réponse — c'est-à-dire **exactement le comportement humain qui
a produit l'incident**. C'est une protection qu'on croit avoir et qu'on n'a pas, sur un incident déjà
survenu. Deux mécanismes voisins ont été promus en base partagée pour cette raison précise ; ces
trois-là ont été oubliés.

---

# 9. Le plan de remédiation — 14 lots

Ordonnés par (gravité × certitude) ÷ effort, **sauf** là où une dépendance réelle l'impose. Chaque
lot respecte les règles du dépôt : **test rouge d'abord**, page `docs/conception/` **dans le même
commit**, `typecheck` + `test:unit` après chaque modification, **jamais** de modification d'un ADR
existant.

| # | Lot | Ferme | Effort | Prod |
| ---: | --- | --- | :---: | :---: |
| **0** | **Rendre la documentation visible à git** — `.gitignore` en liste nommée + racine dans `DOC_ROOTS`. Deux commits (versionner ; puis élargir le corpus, qui porte les corrections de citations) | § 3.2, § 3.3 | XS + M | — |
| **1** | **`test:integration` cesse d'écrire en production** — retirer le `POST` créant « Jane Doe », garder le `GET` sous `LIVE_SMOKE=1` | § 4.3 | XS | *retire* |
| **2** | **5ᵉ et 6ᵉ occurrences de l'accent** — `d[ié]cid` → `d[eié]cid` ; `excerpt-salience` plie son entrée ; `signalScore(normalizeIntentText(raw))` | § 1.6, § 4.4 | S | 1 appel |
| **3** | **`userFacingFailure` voit `.errors[]`** — parcours en LARGEUR sur `[cause, lastError, ...errors]`, borné, **et `describeErrorChain` appelle la MÊME fonction** | § 1.3 | XS | — |
| **4** | **`allSettled` sur l'annulation groupée** — rendre compte des annulations réussies même si l'une échoue | (mon code du 26/08) | XS | — |
| **5** | **Les 2 LECTURES RH exigent un demandeur** — moitié *exfiltration* de § 1.1, la plus grave, la moins chère | § 1.1 | M | 1 appel |
| **6** | **L'archive rend ses 6 champs + `distilled_at = NULL`** — et `markDistilled` ne marque plus ce qui a échoué **en écriture** | § 1.2 | S | 0 |
| **7** | **Détresse en position 0 + troncature tête/queue** — les DEUX gestes | § 1.5 | S | 0 |
| **8** | **Patronymes + mort de l'état** — 8a les prédicats (corpus à deux colonnes), 8b extraire `shouldRememberTurn` partagé entre les deux machines à états | § 1.4 | S + M | 0 |
| **9** | **`hasManager` rend `'unknown'`** — troisième état, la fenêtre de 60 s ne s'arme pas sur un échec, et le diagnostic **nomme la panne** | § 1.7 | S | 0 |
| **10** | **Les 5 ÉCRITURES + la règle DÉRIVÉE** — un test qui scanne les outils et exige que tout consommateur de la frontière ait d'abord exigé un demandeur : **couvre d'avance le 14ᵉ outil** | § 1.1 | M–L | 1 appel |
| **11** | **Réarmer les 3 garde-fous** — motif d'accent, anti-vide `> 0`, `path` vérifié, `continue` retiré, `default: assertNever` | § 2.2–2.4 | M | — |
| **12** | **Les 2 affirmations de sécurité fausses** — corriger `knowledge.md:41`, ajouter `pruneOlderThan` aux préparations de candidature, **nouvel ADR** sur leur rétention | § 3.4 | M | — |
| **13** | **Le budget de temps** — échéance partagée descendue dans la boucle, `ingest` hors du chemin critique, timeout **dérivé** du plafond | § 4.2 | M | 0 |
| **14** | **Conteneurs et gardes du démarrage à froid** — `notifiedWindows` borné, `healthCheck` qui touche vraiment la base, `readAffectedRows` qui lève, méthode `GET` verrouillée, `deliveredOn` en jour local | § 4.4 | S | 0 |

## Les dépendances réelles (mécaniques, pas des préférences)

| Avant | Après | Raison |
| --- | --- | --- |
| **0** | tous | « la page change dans le MÊME commit » est inapplicable à des fichiers hors git |
| **0** | 11 | l'anti-vide de `claimed-invariants` ne peut passer au vert que sur un corpus non vide |
| **1** | 2, 5, 8, 10 | toute vérification en production est faussée tant que la suite crée un employé |
| **5** | **9** | durcir `AUTHZ_ENFORCE` pendant que `mayTouchRecord` rend `true` sans contexte produit un état **trompeur** : refus depuis Slack, ouverture depuis `/api/*` — **indiscernable d'une frontière qui marche** |
| **5** | 10 | le helper de fixture `slackCtx()` est écrit au 5 et réutilisé par les 13 fichiers du 10 |
| **6** | 2 | on ne peut pas attribuer « `knowledge_facts` bas » à la distillation tant que l'archive rend `channelId: undefined`. **Mesurer l'un sans l'autre reconduirait le mauvais diagnostic du 2026-08-21** |

⚠️ **Note d'urgence, hors ordre** : le lot 10 est en position 10 par le **ratio**, pas par la
gravité. Le lot 5 fait passer la moitié *exfiltration* en position 5 précisément pour que le ratio ne
retarde pas ce qui fuit. **Si le `MASTRA_API_TOKEN` a pu circuler, sa rotation est un geste de dix
minutes indépendant de tout ce plan et n'attend aucun lot.**

**Budget total de vérification en production : 4 appels de modèle.** Tout le reste passe par les
sondes déterministes à zéro token qui existent déjà. Ni `smoke:email` (envoi réel) ni `probe-erasure`
(suppression réelle) ne sont requis par aucun lot.

## Ce qu'il ne faut PAS faire

1. **Ne pas déplacer la détresse sans borner son détecteur.** Le déplacement seul ne corrige **aucun**
   des deux cas mesurés et donne la conviction d'avoir réparé le pire chemin du produit. *Un
   correctif qui rassure sans agir coûte plus cher que le défaut.*
2. **Ne pas faire rendre `false` à `mayTouchRecord` sans contexte.** C'est le correctif « propre » et
   il est faux : `readSlackContext` rend `undefined` sur le playground, les workflows et tous les
   tests, où c'est le cas **nominal**. Le refermer là couperait le produit de lui-même, et la
   pression pour rouvrir viendrait le lendemain. Le second verrou appartient **au bord de l'outil**.
3. **Ne pas installer le SDK OpenTelemetry.** Le constat est juste, mais c'est de la latence par
   requête sur une fonction dont le lot 13 montre qu'elle dépasse déjà son plafond de temps. Le seul
   signal qui compte — `injectionCounter` — se persiste avec une colonne et un `INSERT`, comme la
   latence l'est déjà. **Même résultat pour un vingtième du coût.**
4. **Ne pas lancer de campagne de vérification en production.** 12 lots × une sonde chacun
   dépasseraient à eux seuls le quota journalier.
5. **Ne pas traiter le tableau de bord (WCAG) dans ce plan.** Constat exact, dette réelle — mais page
   en lecture seule, fail-closed, sans utilisateur affecté par une frontière ou une perte de donnée.
   L'y mettre la ferait concurrencer, sur les mêmes journées, l'exfiltration de dossiers RH et un
   parcours d'accueil qui casse sur les patronymes du pays.
6. **Ne pas corriger les 47 affirmations périmées dans une passe dédiée.** La mesure de ce dossier
   dit que les chiffres recopiés sont faux à 68 % : **une passe de réécriture produit des chiffres
   recopiés — elle reconduirait le défaut à son propre taux d'erreur.** Chaque lot corrige les
   affirmations qu'il touche ; le lot 11 réarme le mécanisme qui les attrape. Deux exceptions à
   corriger tout de suite : « `lint` est suffixé `|| true` » (enseigne d'ignorer un signal bloquant)
   et « 12 messages par jour » (sert d'argument à deux raisonnements de conception).
7. **Ne pas promouvoir les 3 gardes d'idempotence en store partagé dans ce plan.** Constat juste,
   mais c'est un changement de contrat de persistance sur le chemin nominal, avec un mode d'échec —
   une prise qui ne se termine jamais — dont le dépôt a **déjà payé l'apprentissage** sur les rappels
   (`STRANDED_CLAIM_MS`). Il mérite son lot et ses mesures, pas la fin d'une liste.

---

# 9 bis. Deux constats trouvés en fin d'audit

⚠️ **Une voix du Conseil — l'Expansionist, chargée de généraliser chaque famille de défaut — a
échoué sur une erreur réseau** (`Self-signed certificate detected`), comme deux autres agents. Le
balayage a donc été fait à la main, sur la famille la plus rentable : le **trou par absence**.

## 9bis.1 ⛔ L'effacement peut réussir en disant qu'il n'avait rien à effacer

Le motif `?? 0` sur un `unknown` a **onze** occurrences, pas quatre. L'une est sur le seul chemin
**irréversible** du produit.

```
handler:1225                          const removed = await repo.forget(scope);
drizzle-conversation.repository.ts:59  return (result as {rowsAffected?: number}).rowsAffected ?? 0;
forget.ts:74                          if (count === 0) → « Je n'avais rien retenu de nos échanges. »
```

> Si le pilote ne renseigne pas `rowsAffected`, **la suppression réussit** et Marcel répond
> « je n'avais rien retenu ». La personne croit qu'il n'y avait rien à effacer. **Tout vient d'être
> détruit.**

C'est la famille `emailSent: false` sous `status: 'success'` — appliquée à la pire donnée possible,
sur le seul geste qu'un faux positif ne rattrape pas. `[LU]` · **MAJEUR**

Inventaire complet : `drizzle-pinned-fact:49` · `drizzle-conversation:59,73` ·
`drizzle-onboarding:50` · `drizzle-slack-event-dedup:78` · `drizzle-rate-limit:23,34` ·
`drizzle-pending-email:53` · `drizzle-directory:139` · `handler:1230,2364`.

## 9bis.2 ⛔ « Le diagnostic ment » est une FAMILLE, pas un cas isolé

```ts
const linked = (await this.getDirectoryRepo()?.linkEmployee(slackUserId, employeeId)) ?? 0;
if (linked === 0) {
  logger.error('Annuaire NON relié — aucune ligne pour cette personne',
               { reason: 'no_directory_row', … });
```

L'opérateur `?.` fait que **l'absence de dépôt** produit `undefined ?? 0` = `0`, donc **le même
message**. Le diagnostic affirme « aucune ligne pour cette personne » alors que la cause peut être
« aucun dépôt injecté » ou « pilote sans `rowsAffected` ».

⚠️ **Et c'est précisément la cause racine du 2026-08-19** — `slack_directory.employee_id` non
écrite. Son message d'erreur oriente vers le mauvais coupable, **exactement comme `warnOnce` de
l'access-guard** (§ 1.7). Deux occurrences font une famille : *un message d'erreur qui affirme une
cause qu'il n'a pas constatée.* `[LU]` · **MOYEN**

---

# 10. Ce que cet audit s'est appliqué à lui-même

Ce dépôt exige de ne jamais affirmer un état qu'on n'a pas constaté. Le Conseil a appliqué cette
règle **à l'audit**, et l'a pris en défaut trois fois. Les trois corrections sont dans le texte
ci-dessus, à leur place, et non reléguées en note :

| Sur-classement retiré | § |
| --- | --- |
| « le contournement `/api/*` : **conséquence non vue** » — il était vu, verbatim, sept jours plus tôt | § 1.1 |
| « le mystère du quota : **RÉSOLU** » — cause compatible, **non établie** | § 1.3 |
| « `.gitignore` : **LA** cause mécanique de toute la dérive » — un facteur, réfuté par mes propres mesures | § 3.2 |

Et deux reclassements :

- ⬇️ le « contournement gratuit du plafond quotidien » → **MINEUR**, parce que le chiffre qui le
  fondait (« 12 messages/jour ») est prouvé faux **par cet audit lui-même** ;
- ⬆️ **la détresse remonte**, l'objection ReDoS qui la retenait ne tenant pas — et le remède est plus
  large que le déplacement, le détecteur refusant lui-même ce qui est long.

Un compte, enfin, que personne n'avait juste : **7** outils sans second verrou, ni 6 (premier jet) ni
8 (Conseil).

## La vérification de cet audit

`[EXÉCUTÉ]` après rédaction :

```
typecheck                    0 erreur
lint                         0 erreur, 0 warning
tests/unit/quality           16 fichiers / 107 tests, verts
suite complète               202 fichiers / 2 869 tests, verts
arbre de travail             seul ajout : docs/audit-qa-2026-08-28/
```

⚠️ **Ce rapport est lui-même dans le corpus que `claimed-invariants.test.ts` scanne**
(`DOC_ROOTS = ['docs', …]`). Le garde-fou a donc **validé chaque chemin de fichier cité ici** —
c'est la seule garantie que ce document ne reproduit pas le défaut qu'il mesure.

## La phrase à retenir

> **Un défaut, un `catch` et un `as` sont des affirmations.** Les soumettre à la règle que ce dépôt
> s'est déjà donnée fermerait cinq des sept constats critiques sans en discuter un seul
> individuellement.
