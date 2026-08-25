# Audit Tool Design — les 13 outils de Marcel, module par module

> **Portée** : les 13 outils exposés aux 4 agents Mastra de ce dépôt, relus le **2026-08-25**
> contre la branche `refactor/cleanup-20260810`.
>
> **Méthode** : tout chiffre de ce document a été **compté sur le code**, jamais recopié d'un
> autre document. Quand une source du dépôt dit autre chose, l'écart est imprimé. Les commandes
> de re-mesure figurent en §0.3 — les rejouer avant de croire une ligne.
>
> **Grille** : les douze modules d'un cursus de *Tool Design* (introduction, function calling,
> outils simples, outils avancés et orchestration, API externes, sécurité, robustesse,
> récupération d'information, action sur le monde, agents multi-étapes, évaluation, études de
> cas). Pour chacun : **ce que le dépôt fait**, **ce qu'il ne fait pas**, et pourquoi — en
> séparant ce qui est un **choix argumenté** de ce qui est une **dette**.

---

## 0. L'inventaire mesuré

### 0.1 Les 13 outils

| Outil | Feature | Nature | Agents porteurs |
| --- | --- | --- | --- |
| `findEmployeeByEmail` | employee | lecture | orchestrateur, notification |
| `findPersonByName` | employee | lecture | orchestrateur, notification, knowledge |
| `getEmployeeProfile` | employee | lecture | orchestrateur, notification |
| `findExpertise` | knowledge | lecture | orchestrateur, notification, knowledge |
| `getChannelHistory` | knowledge | lecture agrégée | knowledge |
| `getUserConversations` | knowledge | lecture agrégée | knowledge |
| `searchKnowledge` | knowledge | lecture agrégée | knowledge |
| `getNotificationHistory` | notification | lecture | notification |
| `generateDocument` | document | **action** | orchestrateur |
| `sendNotification` | notification | **action** | notification |
| `scheduleReminder` | notification | **action** | notification |
| `updateOnboardingStatus` | onboarding | **action** | orchestrateur |
| `scheduleCandidateInterview` | recruitment | **action** (différée) | recrutement |

**8 lectures, 5 actions.** Cette partition n'est pas décorative : elle est réifiée en code dans
`READ_ONLY_TOOL_NAMES` / `ACTING_TOOL_NAMES`
(`src/features/notification/domain/services/claim-reconciliation.ts:83-100`) et c'est elle qui
décide si une phrase d'accompli est un fait ou une narration.

### 0.2 Le câblage

`src/shared/agent-capabilities.ts` déclare `AGENT_TOOLS` **une seule fois**. Le routage
message → agent en dérive, ainsi que le test de budget de prompt. Avant le 2026-08-14, ce
câblage était recopié à la main dans deux endroits qui avaient divergé, et les mesures de coût
qui en sortaient étaient fausses.

```
onboardingOrchestrator : 6 outils    notificationAgent : 7 outils
knowledgeAgent         : 5 outils    recruitmentAgent  : 1 outil
```

### 0.3 Les commandes de re-mesure

```bash
ls src/features/*/application/tools/*.ts | wc -l          # 13
grep -rc "outputSchema" src/features/*/application/tools/  # 0 partout
grep -rn "reason: '" src/features/*/application/tools/ | wc -l
grep -c "it(" tests/unit/tools/*.ts | awk -F: '{s+=$2} END {print s}'   # 199
```

---

## Module 1 — Introduction au Tool Design

### Ce qui est en place

**La doctrine de coût est écrite, chiffrée, et elle gouverne toutes les décisions d'outillage.**
Le plafond réel n'est pas le débit mais le quota journalier : mesuré à ≈ 19 messages/jour sur
Groq, ≈ 20 requêtes/jour sur le palier gratuit Gemini. La conséquence tirée est explicite et
contre-intuitive : *le poste dominant n'est pas la TAILLE du prompt mais le NOMBRE D'ÉTAPES*.
Une étape épargnée vaut ≈ 1 500 tokens ; un prompt raboté en vaut quelques dizaines.

Cette doctrine a produit des décisions d'outillage vérifiables :

- `getEmployeeProfile` et `getNotificationHistory` acceptent un **email** en plus de l'UUID,
  ce qui supprime l'aller-retour `findEmployeeByEmail`. Mesuré en production : 4 954 → 3 097
  tokens (−37 %) et 4 424 → 2 866 (−35 %).
- `sendNotification` est passé de **5 champs obligatoires à 3** — non pour la commodité, mais
  parce que chaque champ obligatoire sans défaut est une question posée à l'humain, donc un
  tour de dialogue, donc une requête pleine.
- La **fusion des 4 agents en un seul** a été examinée puis rejetée sur mesure : les schémas des
  outils réunis pèsent ≈ 1 622 tokens, davantage que le FLOOR entier de l'orchestrateur.

**Le principe directeur, énoncé et vérifié** : *une consigne d'agent est PROBABLE, le code est
GARANTI*. Le dépôt a mesuré plusieurs consignes en échec — la couverture des extraits, la
rédaction du contenu, la citation du destinataire, l'interdiction du markdown, le `hint` invitant
à appeler `getChannelHistory` — et les a chaque fois remplacées par du code.

⚠️ **Le compte, lui, a dérivé** : `CLAUDE.md` en donne **trois** valeurs différentes — « ce dépôt
en a mesuré **cinq** en échec », « ce dépôt l'a mesurée en échec **quatre** fois », et « c'est la
**TROISIÈME** consigne d'agent mesurée en échec ». Aucune n'est dérivée de quoi que ce soit.
C'est la forme exacte que `claimed-invariants.test.ts` traque — une propriété globale que rien ne
recalcule — appliquée à la phrase qui énonce la doctrine du dépôt. Relevé le 2026-08-25, non
corrigé ici : ce document constate, il ne réécrit pas `CLAUDE.md`.

### Ce qui manque

**Aucun document ne présentait, avant celui-ci, la surface d'outillage comme un tout.** Les
justifications vivaient dispersées dans `docs/conception/` (une page par feature) — ce qui est
cohérent avec la règle du dépôt, mais rend invisible ce qui se joue *entre* les outils : la
partition lecture/action, la quarantaine croisée, les 21 codes de `reason`. C'est précisément
le trou que ce fichier ferme.

---

## Module 2 — Fondamentaux des appels d'outils (function calling)

### Ce qui est en place

**La sérialisation en JSON Schema est verrouillée par un test qui balaie les 13 outils.**
`tests/unit/tools/tool-schema-flatness.test.ts` interdit tout nœud `allOf` / `anyOf` / `oneOf`
/ `$ref` dans un `inputSchema`. La raison est un bug de production à **100 % d'échec** :

```
APICallError: tool call validation failed: parameters for tool createEmployee
did not match schema: `/position`: expected object, but got string
```

Cause : `z.string().pipe(z.nativeEnum(X))` sérialise en `allOf`, un nœud sans `type` racine ;
le validateur de tool-calls de Groq le traite comme un `object` et rejette la chaîne pourtant
correcte. C'est la **5ᵉ occurrence** de cette classe de bug dans le dépôt — d'où le balayage
exhaustif plutôt qu'un correctif ponctuel.

**Le pinning de Zod à `3.25.76` est une décision de function calling, pas de dépendance.** Le
parseur de schémas du Vercel AI SDK casse sur `z.discriminatedUnion` et sur les regex à classes
Unicode `\p{L}`. Conséquence assumée : `@mastra/memory` est inutilisable (il exige `zod ^4`),
d'où une mémoire conversationnelle écrite à la main.

**Le nom de l'outil appelé est lu au bon endroit.** `readToolCallNames`
(`claim-reconciliation.ts:122`) lit `chunk.payload.toolName ?? chunk.toolName ?? chunk.name`.
Avant ce correctif, la lecture `call.toolName ?? call.name` rendait `"unknown"` sur **100 % des
appels** (19 runs de production) : le champ ajouté précisément pour distinguer une action d'une
narration ne répondait à aucune question.

**Les défauts de schéma sont utilisés comme instrument de coût**, pas de confort :
`channel` → `email`, `recipientType` → `employee`, `format` → `pdf`, `deliverTo` → `slack`.
L'énumération `channel` a été ramenée de **7 valeurs à 2** — les cinq autres (`in_app`, `teams`,
`push`, `sms`, `webhook`) n'ont aucun transport, et le « tu préfères quel canal ? » observé en
production était littéralement cette énumération remontée à l'humain.

**La dérogation d'invention vit dans le `.describe()`, par champ.**
`subject`, `body` (de `sendNotification` et `scheduleReminder`) et `title` (de
`generateDocument`) portent `.describe('rédige-le, ne le demande pas')`. Posée au niveau de
l'agent, cette consigne contredirait frontalement `AGENT_ANTI_INVENTION_BLOCK` et reviendrait à
tirer à pile ou face à chaque tour. La distinction est nette : **un email ou un UUID se
retrouvent, une prose se produit.**

### Ce qui manque

**AUCUN des 13 outils ne déclare d'`outputSchema`.** Compté : `grep -c outputSchema` rend `0`
sur les treize fichiers. Le seul `outputSchema` du dépôt est sur les étapes du workflow
`employee-onboarding.ts`.

C'est le manque le plus structurant de cet audit, et il faut être juste sur ses deux faces :

- **Ce qu'on ne perd pas.** Mastra n'utilise pas l'`outputSchema` d'un tool pour contraindre le
  modèle — il est descriptif. Son absence ne casse donc rien au runtime, et c'est pourquoi elle
  a pu passer inaperçue.
- **Ce qu'on perd réellement** : la forme du tool-result n'est vérifiée par *aucun type
  partagé*. Le budget de tool-result est verrouillé par un test qui mesure des **caractères**
  (`tool-result-budget.test.ts`), pas par un contrat. Et les 21 codes de `reason` — voir §7 —
  ne sont validés nulle part. Un outil peut donc rendre `reason: 'not_fond'` et rester vert.

**Aucun outil n'accepte de champ `dryRun` ni de mode simulation.** Pour les 5 outils agissants,
la seule façon de savoir ce qui va partir est de le faire partir. `scheduleCandidateInterview`
est la seule exception, et par construction (voir §9).

---

## Module 3 — Conception d'outils simples

### Ce qui est en place

**Le contrat d'échec est explicite et partagé : un résultat vide doit se distinguer d'un
identifiant qui ne désigne personne.** Sept outils de lecture portent un booléen `found`, et
`findPersonByName` va plus loin avec un `reason: 'no_match'`. Le défaut d'origine — `getTaskList`
rendant `{tasks: [], totalTasks: 0}` sur un UUID inconnu — était **indiscernable d'un employé
sans tâche**, et le modèle comblait.

**Les tool-results INSTRUISENT plutôt qu'ils n'échouent.** Champ `hint`, présent sur **11 outils**
sur 13, **payé uniquement dans les cas dégradés** — jamais sur le chemin nominal. C'est la
traduction directe de la doctrine de coût : un échec qui n'explique pas produit un tour de
dialogue, qui coûte plus que le `hint`.

**Une projection systématique, qui est aussi une mesure de confidentialité.**
`getEmployeeProfile` ne rend que les champs utiles : `metadata` et `salaryAmount` ne sortent
jamais. Trois défauts de la même famille ont été corrigés sur mesure :

| Outil | Avant | Après | Cause |
| --- | --- | --- | --- |
| `getEmployeeProfile` | 2 506 tokens | **333** | `tasks` non borné, 19 colonnes brutes |
| `getNotificationHistory` | ≈ 9 600 tokens | **177** | lignes Drizzle brutes, `body` non borné, `limit` à 50 |
| `generateDocument` | 685 tokens | **39** | l'entité complète, `content` compris |

⚠️ **La propriété qui compte n'est pas le chiffre mais l'INDÉPENDANCE** : la taille de ces
résultats ne dépend plus du nombre de lignes ni de la longueur du contenu. Vérifié par test :
Δ = 0 caractère entre un `content` de 10 et de 11 000 caractères.

**Le paramètre `limit` a été RETIRÉ du schéma de `getNotificationHistory`** — il ne servait qu'à
laisser le modèle choisir combien on lui facture. Un `ORDER BY` a été ajouté au passage : il n'y
en avait aucun, deux appels identiques pouvaient rendre deux ordres différents.

**L'ambiguïté ne rend AUCUN identifiant.** `findPersonByName` sur deux correspondances ne
renvoie pas deux UUID : rendre deux UUID reviendrait à laisser le modèle en choisir un,
c'est-à-dire le geste même qui a produit le bug de destinataire (10 documents enregistrés sous
le même UUID, « Bienvenue Awa » envoyé à l'adresse de Karyl). Sans identifiant, l'appel suivant
est **structurellement impossible** et le modèle doit demander.

### Ce qui manque

**Le vocabulaire de `reason` est une convention, pas un type.** 21 codes distincts recensés :

```
already_prepared · ambiguous · delivery_failed · directory_unavailable · document_not_found
employee_not_found · forbidden · link_domain_not_allowed · missing_identifier · no_email
no_match · no_onboarding_progress · no_slack_context · not_authorized · not_persisted
not_resolvable · person_not_found · person_not_resolved · placeholder_email · post_failed
recipient_not_found
```

Trois paires y disent visiblement la même chose sous des noms différents —
`employee_not_found` / `person_not_found` / `recipient_not_found`, et
`not_resolvable` / `person_not_resolved`. Aucune union TypeScript ne les déclare, aucun test ne
les énumère, rien ne les dérive. C'est exactement la forme que
`tests/unit/quality/claimed-invariants.test.ts` traque ailleurs — **une propriété globale que
rien ne recalcule** — appliquée ici au vocabulaire d'erreur.

**Le coût de ce manque est modéré et il faut le dire** : ces codes sont lus par le modèle en
prose, pas par du code. Une divergence de nom dégrade la qualité d'une réponse, elle ne casse
rien. C'est une dette de lisibilité, à traiter après celles de §7 et §11.

---

## Module 4 — Outils avancés et orchestration

### Ce qui est en place

**L'orchestration est déterministe et vit dans le handler, hors de portée du modèle.** Le
routage message → agent se décide en **quatre temps** (échappement symétrique → collant →
thématique → défaut), et le palier thématique est exprimé en **capacités**, pas en listes de
mots : chaque bande déclare l'outil qu'elle exige (`generateDocument`, `sendNotification`,
`getChannelHistory`, `findExpertise`) et le palier 3 peut déloger le palier 2 **à une seule
condition — l'agent qui mène le fil ne porte pas l'outil exigé**.

La règle est **dérivée d'`AGENT_TOOLS`** : déplacer un outil d'un agent à l'autre change le
routage tout seul. Elle est sûre dans les deux sens — elle ne peut jamais arracher un fil à un
agent qui sait répondre, ni le laisser chez un agent qui ne sait pas.

Le défaut qu'elle ferme est instructif : après « Envoie un rappel à Pamela », la demande
« Génère-moi le guide en PDF » **restait chez `notificationAgent`, qui n'a pas
`generateDocument`** — et en DM la clé de conversation est le canal, donc le verrou tenait une
heure sur tous les sujets. Un test rejouait cette campagne et **verrouillait le défaut**.

**Aucun mécanisme de passation entre agents n'existe, et la consigne qui le prétendait a été
supprimée.** « Pour une notification, passe la main à l'agent de notification » ordonnait
l'impossible, invitait à NARRER une délégation qui n'a jamais lieu, et était repayée à chaque
aller-retour. Deux tests protègent cette suppression.

**Un outil est câblé sur trois agents pour éviter un agent switch, et le calcul est publié.**
`findExpertise` coûte **+117 tokens** sur `knowledgeAgent`, **+75 par aller-retour** en moyenne.
Ce qu'il achète : demander « qui gère le support ? » au milieu d'une préparation de notification
n'arrache plus le fil — et les deux réponses les plus fausses de la campagne du 2026-08-11
venaient exactement de là. Le dépôt écrit noir sur blanc que **ce lot n'est pas autofinancé**.

⚠️ **La limite exacte de ce partage est une frontière de sécurité** : `getChannelHistory` et
`getUserConversations` restent au **seul** `knowledgeAgent`. Les réunir avec `generateDocument`
ou `sendNotification` formerait le canal d'exfiltration de §6. *Les PERSONNES oui, les CANAUX
non.*

**Un tool-idempotency partagé** (`src/shared/tool-idempotency.ts`) : LRU de 200 entrées, TTL
10 min, clé `(eventTs, toolId, …parts)`. Il ferme le cas des **7 documents et 3 emails
identiques en 8 minutes** observés en production.

### Ce qui manque

**Aucun plafond d'étapes.** Pas de `maxSteps`, pas de `stopWhen` sur `agent.generate()` — le
seul `maxSteps: 1` du dépôt est sur le résumeur de faits, qui n'est pas un agent exposé. La
seule borne est un `AbortSignal.timeout(40_000)` (`AGENT_GENERATE_TIMEOUT_MS`).

**Justification partielle, et elle tient** : le budget journalier mord bien avant qu'une boucle
d'outils puisse tourner longtemps, et une boucle est de toute façon coupée à 40 s. Mais c'est
une borne de **temps**, pas de **coût** : dix appels d'outils en 30 secondes passent, et chacun
est une requête pleine sur un quota qui se compte à la journée. **Un `maxSteps` explicite est un
manque réel**, peu coûteux à poser.

**L'idempotence ne couvre que 2 des 5 outils agissants** — `generateDocument` et
`scheduleCandidateInterview`. `sendNotification`, `scheduleReminder` et `updateOnboardingStatus`
n'en ont aucune. Le raisonnement implicite se défend (un rappel en double est visible et
annulable ; un document en double est un fichier posté) mais il n'est écrit nulle part, donc
rien ne le protège d'un changement d'avis silencieux.

**Le garde d'idempotence est PAR INSTANCE.** Même limite structurelle que le LRU de
déduplication Slack avant sa correction : deux invocations routées vers deux instances ne se
voient pas. La déduplication Slack a été promue en store partagé Turso pour cette raison exacte
(table `slack_event_dedup`, prise atomique par `INSERT … ON CONFLICT DO NOTHING`) ; l'idempotence
d'outil, elle, ne l'a pas été. Le symptôme serait le même : un doublon sur démarrage à froid.

---

## Module 5 — Intégration d'API externes

### Ce qui est en place

**Quatre intégrations réelles, chacune avec ses pièges documentés à l'endroit où ils mordent** :
Slack (`@slack/web-api` 8.x), SMTP (nodemailer) avec repli Brevo, Turso/LibSQL, et trois
fournisseurs LLM en chaîne.

**Les pièges retenus valent d'être cités, parce qu'aucun n'est visible à la lecture des
typings** :

- `files.uploadV2` rend un permalink **doublement imbriqué** : `res.files[0].files[0].permalink`.
  Et le typage public ne le dit pas — l'accesseur est déclaré `WebAPICallResult`, où le champ
  `files` **n'existe pas** pour TypeScript. La lecture se fait depuis `unknown`, défensivement,
  et l'absence de permalink **n'est pas un échec** : le fichier est livré, le lien est un confort.
- `file: Buffer.from(bytes)` — le SDK refuse un `Uint8Array` nu et interpréterait une **chaîne**
  comme un chemin disque, inutilisable sur Vercel.
- **Dans Hono, un middleware qui a appelé `next()` doit assigner `c.res`, pas retourner.** Ce
  piège a rendu `createCallerErrorMiddleware` inopérant depuis son écriture, et les tests
  unitaires **assertaient le retour**, donc restaient verts pendant que le code était mort.

**La chaîne de repli LLM est une source unique.** `resolveModelIds`
(`src/shared/llm/model-fallback.ts`) : Gemini → Groq → Mistral, **et l'ordre est le contrat**.
Ne pas recopier la chaîne ailleurs — quatre fichiers de tests l'avaient fait, et sont restés
verts en vérifiant qu'on demandait bien un modèle qui **n'existait plus**
(`llama-3.3-70b-versatile`, disparu du compte Groq le 2026-08-15).

⚠️ **Piège de journalisation Mastra** : le log `Upstream LLM API error` de fin de run attribue
toujours l'erreur à `models[0]`. Un échec Mistral apparaît donc sous `provider: 'groq.chat'`.
C'est ce log trompeur qui a fait diagnostiquer « Groq saturé » pendant des heures.
`withChainFailureLogging()` journalise désormais le maillon réel.

**Le repli d'un fournisseur ne change jamais silencieusement le contrat du produit.** Deux
applications de la même règle :

- La borne de 5 Mio sur les pièces jointes vit dans le **domaine**
  (`email-attachment-policy.ts`), pas dans un adaptateur : SMTP et Brevo doivent refuser
  exactement les mêmes envois.
- Depuis le 2026-08-24, `BrevoAdapter` reçoit le même `fromName` que `SmtpAdapter` — il n'en
  avait **aucun**. Un basculement de fournisseur aurait renommé l'expéditeur.

**`assertEmailAttachmentsFit` LÈVE au lieu de rendre un booléen** : un refus silencieux
reproduirait exactement le piège `emailSent: false` sous `status: 'success'`.

### Ce qui manque

**Aucun outil ne porte son propre timeout.** `grep -n "timeout\|AbortSignal"` sur les 13
fichiers rend **zéro**. Le seul garde-fou est le timeout global de 40 s sur `agent.generate()`,
qui couvre l'ensemble du run — pas l'appel Slack ou SMTP pris isolément.

**Aucune politique de back-off par outil, et c'est explicitement délibéré.** Le repli Mistral
plafonne en **requêtes** (4/min) : un back-off d'une seconde ajoute de la latence sans changer
l'issue. Le dépôt le dit et l'assume — il n'existe aucun module de reprise générique sous
`src/shared/`, contrairement à ce que `CLAUDE.md` affirmait jusqu'au 2026-08-24.

**Le corollaire est une vraie dette** : la reprise réseau existe dans `scripts/` (`resilientFetch`,
utilisé par 4 sondes) et **nulle part dans `src/`**. Un `UND_ERR_CONNECT_TIMEOUT` vers Turso a
déjà tué une sonde en production ; le même sur le chemin d'un outil produirait un échec sec.

---

## Module 6 — Sécurité des outils

### Ce qui est en place

C'est le module le mieux servi du dépôt, et de loin.

**Deux quarantaines croisées, appliquées à la CONSTRUCTION de l'agent** — la factory **lève au
démarrage**, jamais au runtime :

| Garde | Fichier | Interdit |
| --- | --- | --- |
| `assertNoOutboundTools` | `knowledge/domain/services/outbound-tool-quarantine.ts` | 16 préfixes d'écriture (`send`, `post`, `publish`, `upload`, `invite`, `generate`, `update`, `delete`…) sur `knowledgeAgent` |
| `assertNoReadTools` | `recruitment/domain/services/read-tool-quarantine.ts` | 5 préfixes de lecture (`find`, `get`, `list`, `read`, `search`) sur `recruitmentAgent` |

⚠️ **Il en faut DEUX parce que la conjonction interdite — lecture agrégée + écriture externe —
se forme par deux côtés.** Le scénario est cité mot pour mot dans le code : *« Envoie à ce
candidat un récapitulatif de ce qui se dit dans #engineer-karyl. »* C'est aussi pourquoi
`scheduleCandidateInterview` n'est **pas** posé sur `notificationAgent`, qui aurait été l'option
la moins chère : il porte déjà trois lectures.

**Une frontière d'autorisation, appliquée AVANT toute lecture en base.** `canReadPersonRecord`
garde `getEmployeeProfile`, `getNotificationHistory` et `generateDocument` ;
`canPerformSideEffects` garde `updateOnboardingStatus` et `scheduleReminder`. La règle est
écrite **une seule fois** (`mayTouchRecord`) : son propre dossier toujours, celui d'autrui au
niveau `full` ⟺ `slack_directory.role = 'manager'`.

Deux propriétés valent d'être relevées :

- **Les tests vérifient que le repository n'est JAMAIS appelé** sur un refus — le refus est un
  fait de code, pas une intention.
- **Le chemin email ne doit jamais devenir un ORACLE.** Il *doit* lire pour résoudre : il passe
  donc l'identifiant **résolu (ou `null`)** à la garde, si bien qu'un demandeur non autorisé
  reçoit le **même verdict** que l'adresse désigne quelqu'un ou personne. Sinon on énumère
  l'annuaire une adresse à la fois.

**Le `requestContext` est le seul canal de descente des droits.** Coût en tokens : **zéro** — il
ne traverse ni le prompt, ni les schémas, ni les tool-results. On ne décide pas d'un droit sur
une valeur qu'un attaquant écrit.

Ce canal était **forgeable par le corps HTTP** : Mastra fusionne `body.requestContext` et
n'écarte que `RESERVED_CONTEXT_KEYS`, où **aucune clé `slack*`** ne figure. Un porteur de
`MASTRA_API_TOKEN` se déclarait donc n'importe qui. `createRequestContextGuard` **refuse (400)**
au lieu d'assainir — retirer les clés en silence laisserait l'appel aboutir avec un contexte
différent de celui demandé, et une usurpation ressemblerait à un succès partiel. Il surveille un
**préfixe** (`slack`), pas une liste recopiée : les clés pas encore écrites sont couvertes
d'avance.

**Trois surfaces d'exécution directe fermées** : `createToolExecutionGuard` renvoie 403 sur
`/api/**/tools/*/execute`, la moitié restée ouverte d'un correctif antérieur — **le jeton de
service contournait la frontière en ne se déclarant personne**. Montage verrouillé par
`tests/unit/quality/guards-are-mounted.test.ts`.

**Le CONTENU produit par un outil est filtré, et à deux endroits.** `sanitizeAgentOutput` n'a
qu'un seul site d'appel — `response.text` : **les arguments de tool n'y passent jamais**. Or
`title` et `content` d'un document sont écrits intégralement par le modèle. Vérifié en générant
de vrais PDF et en décodant leur CMap : `kisso_a3f9`, `[SECURITY_BLOCK]`, `DIRECTIVE 3.1` et
`https://kisso.internal/…` s'imprimaient **intégralement, sans le moindre log**.

Le filtre est posé au seuil du **rendu** (`buildDocumentOutline`, couche `domain` — seul point
qu'aucun renderer ne peut contourner) **et** dans le tool, parce que la persistance et la
journalisation vivent hors du renderer. Contrat volontairement **différent** de celui de Slack :
on retire l'occurrence et on **garde** le document. Remplacer le livrable entier produirait un
PDF signé de l'entreprise ne contenant qu'un refus.

**Le texte de tiers qui entre par un outil est assaini.** `title` (poste déclaratif, édité par
son porteur) sortait **brut** de `findPersonByName`, câblé sur un agent qui porte
`sendNotification`. Verrouillé par `tests/unit/tools/untrusted-person-fields.test.ts`.

**Un lien de visio est REFUSÉ, pas retiré** — contrat inverse de celui de Slack, et délibéré :
un message Slack amputé de son lien reste utile, un email qui convoque « à [lien retiré] » est
activement nuisible.

**Le modèle ne fournit AUCUNE prose sortante dans `scheduleCandidateInterview`.** Le schéma n'a
pas de champ libre : nom, date ISO, poste, lieu. Sujet et corps viennent d'un **gabarit**. Le
pire cas d'une injection réussie est donc un spam d'invitation — **il n'y a rien à exfiltrer par
ce chemin**.

**Un identifiant qu'on demande au modèle est un identifiant qu'il peut inventer.**
`generateDocument.revises` est un **booléen**, jamais un UUID : le serveur résout la cible (le
dernier document de ce type pour cette personne). La première version demandait l'UUID et a
échoué en production — la mémoire ne stocke que du texte, donc au message suivant l'identifiant
n'est plus dans la fenêtre. Corollaire : l'oracle d'existence que cette version devait
neutraliser à la main **n'existe plus**.

### Ce qui manque

**Les deux quarantaines reposent sur des PRÉFIXES de nom, pas sur une propriété déclarée.** Un
outil nommé `archiveChannelDigest` ou `mailCandidate` passerait les deux gardes. C'est un choix
défendable — le préfixe est dérivé, donc il ne se périme pas comme une liste — mais il repose
sur une **convention de nommage que rien ne vérifie**. Un champ `sideEffect: 'read' | 'write'`
sur le tool serait le fait dur qui manque.

**La partition `READ_ONLY_TOOL_NAMES` / `ACTING_TOOL_NAMES` est une liste écrite à la main.**
Elle a **déjà été fausse** : elle gardait `getTaskList` après son retrait et ignorait
`findPersonByName` et `findExpertise` ajoutés le même jour — un nom inconnu valant ACTEUR, la
réconciliation FAIT/NARRATION se taisait sur le chemin le plus fréquent du produit. Et le test
annoncé dans son en-tête, `tool-classification.test.ts`, **n'existait pas**. Il existe
aujourd'hui, mais la liste reste **recopiée** au lieu d'être dérivée d'`AGENT_TOOLS` — c'est-à-dire
exactement la forme de défaut que ce dépôt corrige partout ailleurs.

**Aucun contrôle de débit par outil.** La limite vit dans `accept()`, en amont : elle plafonne
les **messages**, pas les **appels d'outil**. Un seul message peut donc déclencher plusieurs
envois d'email. Aucun incident ne l'a encore montré, mais rien ne l'empêche.

---

## Module 7 — Robustesse et fiabilité

### Ce qui est en place

**La doctrine centrale du dépôt est une doctrine de fiabilité d'outil** : *un outil ne doit
jamais annoncer un état qu'il n'a pas constaté.* Elle a une histoire mesurable — trois
occurrences du **même** défaut, chacune corrigée après avoir coûté des données ou un
diagnostic :

| Défaut | Symptôme | Correctif |
| --- | --- | --- |
| `status = Sent` posé **avant** le `try` | canaux non transportés repartaient « envoyé », horodatés, sans qu'un octet parte — **et un test verrouillait ce mensonge** | statut après l'E/S |
| `emailSent: false` sous `run.status: 'success'` | trois lecteurs successifs ont conclu à tort qu'un email était parti | `OnboardingOutcome` ∈ `completed \| degraded \| failed` + `degradedSteps: {step, reason}[]` |
| `documents.content` silencieusement perdu | Drizzle **ignore sans bruit** toute clé de `.values()` sans colonne — **6 lignes sur 6 sans contenu, irrécupérables** | colonne ajoutée, DDL appliqué, échec bruyant désormais |

⚠️ **Le couple QUOI/POURQUOI est indissociable** : un booléen dit qu'il faut réparer, jamais
quoi. Et **« non applicable » ≠ « dégradé »** — compter une invitation Slack jamais prévue comme
une dégradation aurait rendu « dégradé » l'état normal et détruit le signal.

**La prise est l'écriture, et elle rend un compte.** Deux applications :

- `clear()` de `pending_interview_email` : on efface **avant** d'envoyer et l'on n'envoie que si
  l'on a bien pris. Deux « oui » routés vers deux instances ne peuvent pas envoyer deux fois, la
  seconde rendant 0. Un `find` puis un `delete` conditionnel — la forme « naturelle » —
  rouvrirait cette course, **et son symptôme serait un candidat convoqué deux fois**.
- `claimForDispatch` d'un rappel : `UPDATE … WHERE status IN ('scheduled','pending')` et lecture
  de `rowsAffected`. Contrat vérifié sur les **deux** implémentations, la Drizzle contre une
  vraie base libsql — *« l'UPDATE n'a touché aucune ligne » ne se démontre pas contre une
  doublure.*

⚠️ **Une prise qui ne se termine jamais perdrait le rappel pour toujours** — pas une erreur, un
**silence**. `findPending()` rend donc aussi les `sending`, repris au-delà de 6 h. La grâce doit
dépasser très largement `maxDuration` (60 s) : la raccourcir rouvrirait la course.

**Sur échec de transport, on REND la prise** : rien n'est parti, réessayer est légitime. Mais
jamais sur un destinataire introuvable — rien ne le fera revenir d'ici demain, et le rappel
repartirait en échec tous les matins.

**La dégradation est nommée, jamais masquée.** `readSlackContext` ne lève **jamais** et rend
`undefined` hors Slack : c'est le cas *normal* du playground, d'une route HTTP, d'un workflow ou
d'un test — au tool de dégrader. Le repli email de `generateDocument` se déclenche sur **tout**
échec de livraison Slack (il ne portait que sur `missing_scope`, condition devenue morte depuis
que le scope est accordé) — mais le verdict reste honnête : `email` seulement si l'envoi a
réussi.

⚠️ **Aucun repli sur une création en cas d'échec de révision** : le modèle annoncerait « j'ai
corrigé » alors qu'il viendrait de produire un second document — **un mensonge fabriqué par le
repli**.

**Le détecteur de fausse promesse a dû bouger avec le câblage.** `onlyNonDeliveringTools` ne
contenait que `scheduleReminder` et n'avait de sens que tant que rien ne partait ; le cron l'a
rendu **faux dans l'autre sens** — il ferait démentir une phrase vraie. *Un détecteur encode le
câblage ; quand le câblage bouge, il ne devient pas inoffensif, il devient faux à l'envers.*

### Ce qui manque

**Le contrat d'échec n'est pas uniforme.** Trois outils lèvent (`sendNotification` ×3,
`scheduleReminder` ×3, `generateDocument` ×1) ; les dix autres rendent un verdict. La ligne de
partage se défend — on lève quand le destinataire est introuvable, parce qu'un échec silencieux
sur une résolution de personne est précisément le défaut corrigé plus haut — mais elle **n'est
écrite nulle part**, donc rien ne la protège.

**Aucun outil ne réessaie.** Un `chat.postMessage` sur un réseau qui hoquette échoue
définitivement. Justification partielle (§5 : le repli plafonne en requêtes) mais elle ne
couvre pas les E/S non-LLM — Slack et SMTP ne sont pas plafonnés en requêtes de la même façon.

**Aucun circuit-breaker.** Si Slack est en panne, les 5 outils agissants continueront d'essayer
message après message, chacun consommant son quota.

---

## Module 8 — Outils pour la récupération d'information

### Ce qui est en place

**La saillance plutôt que la récence, et c'est du code.** `selectExcerpts` ne triait que par
DATE : on rendait les 6 derniers messages. Or les 6 derniers messages d'un canal ne sont presque
jamais les 6 importants — ce sont « ok », « merci », « 👍 ». Le modèle recevait les accusés de
réception d'une décision dont il ne voyait pas l'énoncé, et devait combler.

`excerpt-salience.ts` note : décision (5), engagement (4), blocage (4), échéance (3), question
(2), mention (2), lien (1) ; pénalité sur les accusés de réception purs et les messages très
courts ; **récence en RANG**, non en durée — un canal calme sur trois semaines serait sinon
entièrement plat.

⚠️ **La propriété de budget est intacte** : la saillance change QUELS extraits passent, pas
COMBIEN. Un LLM trierait mieux, mais coûterait un aller-retour de plus par consultation.

**La COUVERTURE est collée au contenu quand le résultat est tronqué.** Sans elle, un modèle à
qui l'on montre 6 messages sur 31 répond « voici ce qui s'est dit » : il affirme une exhaustivité
que rien ne garantit.

⚠️ **Il a fallu TROIS formes, et les deux premières enseignent quelque chose.** Mesuré en
production sur le même canal : un champ de tool-result nommé `coverage` a été **purement
ignoré** ; le même texte renommé `hint` l'a été aussi. **Un champ séparé se lit comme une
métadonnée, quel que soit son nom.** La phrase est donc placée juste **avant** les extraits,
dans `conversation` — on ne peut plus la sauter. Résultat obtenu : *« Ces points sont extraits
de 6 messages sur 31, du 2026-07-20 au 2026-07-28. »*

⚠️ Elle reste **dehors** de la bannière `[UNTRUSTED EXTERNAL DATA]` : à l'intérieur, la
DIRECTIVE 5.1 la déclarerait non fiable et la dévaluerait.

**La lecture en direct avant de prétendre ne rien savoir.** Sur une base muette, `searchKnowledge`
relit Slack lui-même. C'était auparavant un `hint` invitant le modèle à appeler
`getChannelHistory` : une **consigne**, et ce dépôt en a mesuré plusieurs en échec (§1). *« Rien en base »
et « rien n'a été dit » sont deux choses différentes.*

⚠️ **La frontière tient par la CONSTRUCTION de la liste, pas par un filtre** : on part des canaux
dont le **demandeur** est membre (`users.conversations`), donc il n'y a rien à filtrer ensuite,
donc rien à oublier de filtrer. Ce chemin ne coûte **que sur un échec**, et il est borné :
6 canaux, 30 jours, 60 messages.

**Le constat qui relativise tout ce module** : au 2026-08-21, `channel_messages` = **0 ligne** et
`knowledge_facts` = **0 ligne**. Tables, index FTS et pipeline existaient depuis des semaines ;
`searchKnowledge` ne pouvait rendre que `nothing_known`, **et rien ne le signalait**. Ce qui
manquait n'était pas du code mais les **événements** — `message.channels` / `message.groups` ne
sont toujours pas abonnés côté console Slack.

⚠️ **Le piège `\b` en ASCII, rencontré trois fois.** `/\bbloqué\b/` ne matche **jamais** : `é`
n'y étant pas une lettre, la position entre `é` et `,` n'est pas une frontière. Idem `cassé`,
`décidé`, `validé`, `noté`, `échéance`. **Toujours `(?<![\p{L}])…(?![\p{L}])` avec `u`.**
Variante du même piège : les motifs de distillation sont écrits **sans accent** et le texte est
plié avant d'être testé — *« on a **decide** de partir sur postgres »* ne produisait aucun fait.

### Ce qui manque

**Aucune recherche sémantique.** Pas d'embeddings, pas de vecteurs — FTS lexical uniquement. Le
choix se défend sur le volume actuel (deux tables vides jusqu'au 2026-08-21) et sur le coût : un
index vectoriel demande un appel d'embedding par message ingéré, sur un quota qui se compte à la
journée. Mais il coûte sur les synonymes, et **rien ne mesure ce coût**.

**Aucune pagination.** Les bornes sont fixes (5 notifications, 6 canaux, 60 messages) et le
modèle ne peut pas demander la suite. C'est un choix de budget assumé — le `limit` a été
délibérément **retiré** d'un schéma — mais il n'existe aucun moyen d'atteindre le message 61.

**Deux lectures ne portent AUCUN `hint`** — `getUserConversations` et `searchKnowledge`
(compté : 0 chacune), quand les six autres en portent de 1 à 5. Sur celles-là, un résultat vide
n'instruit pas, et le modèle comble — le défaut même que le `hint` existe pour fermer.
---

## Module 9 — Outils pour l'action sur le monde

### Ce qui est en place

**Le patron d'action différée avec relecture humaine, appliqué au geste le plus irréversible du
produit.** `scheduleCandidateInterview` **n'envoie jamais**. Il rend
`status: 'awaiting_confirmation'`, enregistre la préparation et pose une question en texte ;
l'envoi vit dans `handleMessage`, **hors de portée du modèle**.

⚠️ **La table ne porte que des CHAMPS, jamais le corps.** Sujet et corps sont **re-rendus** au
« oui » et la date **re-validée** : les stocker ferait de ce chemin un moyen d'envoyer un texte
arbitraire à une adresse arbitraire — *la primitive que toute la feature est construite pour ne
pas offrir.*

⚠️ **Le bouton « Envoyer » a disparu**, remplacé par « oui » / « non ». Un clic ne réussit que si
la fonction Vercel est chaude, et à ≈ 19 messages/jour **le cas froid EST le cas nominal**
(5 229 ms mesurées à froid contre 3 000 accordées par Slack).

⚠️ **La question d'accueil PRIME sur le « oui ».** Les deux erreurs ne se valent pas : capturer
« oui » comme un prénom se corrige d'un message, **envoyer une invitation à un candidat ne se
corrige pas**. On diffère, en rappelant.

**La DATE est le seul champ transcrit depuis la phrase humaine**, donc le seul vecteur d'erreur
restant. Deux bornes l'encadrent — strictement future (attrape l'erreur d'ANNÉE, la plus
fréquente : un modèle écrit volontiers l'année de son entraînement) et moins d'un an. Elles ne
suffisent pas : c'est **l'affichage en toutes lettres** — « jeudi 20 août 2026 à 14:00
(UTC+01:00) » — qui rend l'erreur visible, et l'offset est **imprimé dans l'email**.

**Le modèle ne savait pas quel jour on est.** Sonde signée : « lundi prochain à 9h » →
« samedi 22 août 2026 à 08:00 ». La cause n'est pas une faiblesse du modèle : **rien**, dans
toute la fenêtre, ne disait la date. Le préambule porte désormais le **fait seul**, 17 tokens —
la consigne « calcule toute date relative à partir de là » a été écrite puis **retirée**,
`AGENT_ANTI_INVENTION_BLOCK` interdisant déjà d'inventer.

**On retire de quoi mentir, plutôt que d'interdire de mentir.** `scheduleReminder` rendait
`scheduledAt` brut et un libellé à l'heure près : deux occasions, pour le modèle, d'annoncer une
précision que rien ne tient (le plan Hobby ne garantit l'heure qu'à **±59 min** et n'autorise
qu'une exécution par jour). Il ne rend plus que `deliveredOn: 'le lundi 24 août 2026 au matin'`.

**Le rappel part réellement, et il a fallu une horloge extérieure.** Dans un serverless, **rien
ne s'exécute tant que personne ne frappe à la porte** : aucun `setTimeout` ne survit au gel.
`findPending()` était écrite, correcte, et sans appelant — **parce qu'il n'existait personne pour
l'appeler**. Le cron `vercel.json` ferme cela ; `CRON_SECRET` est **fail-closed** (503), à
l'inverse du fail-open qui gouverne le reste du dépôt : sans elle, la route serait une primitive
publique d'envoi de messages à des salariés.

**Aucun appel de modèle sur le chemin de remise.** Sujet et corps ont été rédigés au moment de
la demande, sous les yeux de la personne ; les refabriquer enverrait un texte que personne n'a
relu.

**`scheduleCandidateInterview` n'écrit AUCUNE donnée personnelle en base, et c'est un choix.**
`RecipientType` n'a pas de valeur honnête pour un candidat, et stocker l'adresse d'un
non-salarié créerait des données personnelles **sans chemin d'effacement**.

### Ce qui manque

**Aucun outil n'est réversible.** Il n'existe ni `cancelReminder`, ni `deleteDocument`, ni
`revokeNotification`. Un rappel programmé par erreur ne peut pas être annulé par le produit.
`generateDocument.revises` est la seule concession, et c'est une **révision**, pas une
annulation.

Le raisonnement implicite tient — un outil d'annulation est un outil d'écriture de plus, donc
une surface de plus à garder, et il faudrait résoudre sa cible sans demander d'UUID au modèle
(§6) — mais il n'est écrit nulle part, et **le manque est réel** : la seule sortie est
« repasse me le demander », ce qui est exactement le verdict que le propriétaire a rejeté à
propos des rappels (*« ce n'est pas le but d'un rappel »*).

**L'idempotence manque sur les trois outils agissants qui n'en ont pas** — voir §4.

**Aucune trace d'appel d'outil n'est persistée** — voir §11.

---

## Module 10 — Outils pour agents multi-étapes

### Ce qui est en place

**L'espace NÉGATIF est énoncé, dérivé, et c'est la correction la plus rentable du dépôt.** Un
agent ne recevait qu'une énumération **positive** de ses outils ; le vide était comblé par de la
prose inventée. Preuve par contraste : le seul refus correct de toute la campagne du 2026-08-11
est le seul dont la frontière était écrite noir sur blanc. Partout ailleurs : *« je peux lui
renvoyer le lien »* (aucun outil n'envoie de lien), *« je ne peux pas modifier un questionnaire
qu'elle n'a pas encore reçu »* (règle métier entièrement inventée), un rappel *« programmé pour
lundi 9h »* annoncé sans jamais appeler l'outil.

`agentToolBoundary(tools)` est **dérivé d'`Object.keys(tools)`**, jamais rédigé — le dépôt a
connu des instructions nommant des outils supprimés depuis longtemps. Coût : 38 à 48 tokens.

⚠️ Deux clauses ajoutées après mesure : **« ni n'a existé »** couvre la question à prémisse
fausse (*« pourquoi as-tu supprimé le compte de Awa ? »*) — la frontière ne parlait qu'au
présent. **« Pas de service générique »** couvre le hors-métier, que la règle anti-invention ne
rattrape pas : elle interdit d'inventer une **donnée** absente, or il n'y en a aucune à inventer,
donc le modèle obtempère et brûle un tour.

⚠️ C'est une **énumération négative**, jamais un « reste dans ton domaine » : les quatre agents
ont quatre domaines, et une consigne d'appartenance ferait refuser un rappel légitime.

**L'état multi-tours ne passe pas par les outils.** La mémoire ne stocke **que du texte** —
jamais de tool-call ni de tool-result. Conséquence directe et assumée : un identifiant rendu par
un tool-result **n'est plus dans la fenêtre au message suivant**, d'où la règle du booléen
`revises` (§6). Le fenêtrage est **en tokens**, pas en nombre de messages : un seul tool-result
pesait 2 506 tokens.

**Les tours d'un AUTRE agent sont marqués** `[autre agent]` dans l'historique rejoué (≈ 4 tokens,
zéro sur un fil homogène). Sans marque, un agent lit la voix d'un autre **comme la sienne** —
observé en production : l'orchestrateur a repris le motif de `notificationAgent` et redemandé
sujet, texte, canal.

**Neuf court-circuits déterministes répondent SANS aucun appel de modèle**, et `isAnsweredWithoutModel`
en est le **miroir exact**, vérifié entrée par entrée avec une charge d'essai par nom. Une
personne ayant atteint son quota recevait « J'ai atteint mon quota » pour un simple « bonjour » —
et l'aurait reçu pour « je ne vais pas bien ». Le neuvième manquait au miroir : le geste même qui
fait avancer l'accueil était **facturé alors qu'il ne coûte rien**.

⚠️ **L'entretien conversationnel CÈDE LE PAS à ces court-circuits.** Une question en attente
absorbait « oublie ce que je t'ai dit » : l'effacement n'avait pas lieu, **et** la phrase était
enregistrée comme la description du métier de la personne, champ imprimé dans un document à son
nom.

### Ce qui manque

**Pas de `maxSteps`** — voir §4, c'est le manque principal de ce module.

**Pas de plan explicite ni de raisonnement structuré.** L'enchaînement d'outils est laissé au
modèle, sans état intermédiaire inspectable. Choix cohérent avec la doctrine (un planificateur
est un aller-retour de plus) mais il rend un enchaînement raté **non reconstructible après coup**
— d'autant qu'aucune trace d'appel n'est persistée (§11).

**Pas de mémoire d'outil.** Deux appels identiques dans le même run refont le travail, sauf sur
les deux outils qui portent le run-guard.

---

## Module 11 — Évaluation et amélioration des outils

### Ce qui est en place

**199 tests unitaires répartis sur 20 fichiers sous `tests/unit/tools/`.** Trois d'entre eux ne
testent pas un outil mais une **propriété de la surface entière** :

| Test | Ce qu'il verrouille |
| --- | --- |
| `tool-schema-flatness.test.ts` | aucun `allOf`/`anyOf`/`oneOf`/`$ref` dans les 13 `inputSchema` |
| `tool-result-budget.test.ts` | la taille d'un tool-result ne dépend ni du nombre de lignes ni de la longueur du contenu |
| `untrusted-person-fields.test.ts` | aucun champ écrit par un tiers ne sort brut |

**Douze tests de qualité** sous `tests/unit/quality/` gardent la doctrine elle-même :
`agents-carry-security-prompt`, `agent-wiring-is-derived`, `architecture`, `assistant-persona`,
`claimed-invariants`, `comments-live-in-docs`, `dead-config-claims`,
`design-docs-anchor-real-code`, `env-example-completeness`, `guards-are-mounted`,
`taught-phrases`, `tool-classification`.

⚠️ **`claimed-invariants.test.ts` est la leçon de méthode du dépôt** : toute phrase « verrouillé
par `X` » doit citer un fichier qui existe. Les trois défauts les plus coûteux d'une revue
avaient été **masqués par un commentaire**, et ils partagent une forme — *le commentaire énonce
une propriété GLOBALE que rien ne recalcule*.

**L'évaluation se fait en production, avec des sondes qui ne coûtent aucun token.**
`probe-deterministic-replies.mts`, `probe-authz.mts` (lecture seule), `probe-arrival.mts`
(17 contrôles sur 17), `probe-erasure.mts` (⚠️ **supprime réellement**).

⚠️ **Deux scénarios de campagne avaient tort, et leurs erreurs sont de deux familles utiles.**
Le premier envoyait 5 900 caractères pour une borne à 8 000 : le scénario était **vert** et
n'avait qu'un `mustNot` — *un scénario sans assertion sur le comportement qu'il prétend vérifier
est décoratif*. Le second interdisait « le questionnaire a été généré » : le bot a produit un
vrai PDF, **sa phrase était exacte**. *Le pire usage d'un garde-fou est de démentir ce qui est
vrai.*

⚠️ **Le corpus à deux colonnes** (`distress.test.ts`) est le modèle d'évaluation le plus solide
du dépôt : les phrases que dirait quelqu'un en détresse **et** celles que dirait quelqu'un qui ne
l'est pas. N'en exercer qu'une moitié ne mesure rien. Résultat : 0 faux négatif, 0 faux positif,
contre 2 et 6.

### Ce qui manque

**LES APPELS D'OUTILS NE SONT PAS PERSISTÉS. C'est le manque le plus coûteux de cet audit.**

`writeAuditLog` (`src/infrastructure/audit/audit-log.ts`, table `audit_logs`) n'a **qu'un seul
appelant** — le handler Slack — et n'enregistre que trois actions :

```
RATE_LIMITED · AUTHZ_DENIED · SLACK_MESSAGE
```

Les 13 outils n'appellent que `logger.*` (de 3 à 21 appels ; `generateDocument` en compte 21).
Les logs Vercel sont **propres à chaque déploiement et repartent à zéro après un redéploiement**
— le dépôt le documente lui-même comme méthode de diagnostic.

Conséquence directe, et elle est mesurable : **on ne peut répondre à aucune de ces questions**
sur plus de quelques jours —

- quel outil a été appelé combien de fois ?
- lequel échoue le plus, et avec quel `reason` ?
- combien de fois `findPersonByName` a-t-il rendu `ambiguous` ?
- un enchaînement raté est-il reconstructible après coup ?

Or ce dépôt tire toutes ses décisions de mesures. **Il n'y a aucune mesure durable sur ses
propres outils** — la table existe, le point d'écriture existe, et les treize outils ne
l'appellent pas.

**Aucun jeu d'évaluation sur les appels d'outils.** Rien qui vérifie qu'une phrase donnée
déclenche le bon outil avec les bons arguments. Les tests couvrent le **comportement** d'un outil
appelé, jamais la **décision** de l'appeler — laissée au modèle, donc jamais mesurée. Les
campagnes de production le font, mais à la main.

**Aucune métrique de latence par outil.** Le handler mesure `durationMs` pour tout le run ; la
part d'un appel Slack ou SMTP n'est pas isolée.

---

## Module 12 — Études de cas

Trois cas de ce dépôt valent comme études, parce que dans chacun le correctif évident était le
mauvais.

### Cas 1 — `getEmployeeProfile` : le tool-result est payé plusieurs fois

**Constaté.** 2 506 tokens pour un profil. Le champ `tasks` sortait non borné, avec les
19 colonnes de la table.

**Ce qui rend le cas intéressant** : un tool-result n'est **pas payé une fois**. Il entre dans
l'historique et est **réémis à chaque aller-retour suivant**. Le coût réel est donc
`taille × nombre de tours restants` — ce qui n'apparaît sur aucune mesure d'un appel isolé.

**Retenu.** Projection + bornes : 333 tokens. Et surtout un test qui verrouille
l'**indépendance** — la taille ne dépend plus du nombre de lignes. *Le chiffre se périme, la
propriété non.*

⚠️ **Écarté** : laisser un `limit` au modèle. Ce paramètre ne sert qu'à laisser le modèle choisir
combien on lui facture.

### Cas 2 — La couverture des extraits : trois formes pour une phrase

**Constaté.** Montré 6 messages sur 31, le modèle répond « voici ce qui s'est dit ».

**Envisagé et mesuré en production** : un champ `coverage` → **ignoré**. Le même texte renommé
`hint` → **ignoré aussi**.

**Retenu.** La phrase est placée **dans le champ `conversation`, juste avant les extraits**.

**La leçon, générale** : *un champ séparé se lit comme une métadonnée, quel que soit son nom.*
Ce qui doit être lu doit être **dans le flux**, pas à côté. C'est le même constat que la
citation du destinataire (consigne d'agent mesurée en échec sur deux sondes, remplacée par une
phrase accolée par le code) et que la lecture en direct de `searchKnowledge` (un `hint` invitant
à appeler un autre outil, jamais suivi).

### Cas 3 — Les boutons Slack : le correctif n'était pas dans le code de l'outil

**Constaté.** Un clic signé, mesuré en production : **5 229 ms à froid**, 9 173 ms sur un
déploiement neuf, 684 ms à chaud. Slack accorde **3 secondes**.

**Envisagé, et écarté par la mesure** : le handler ACK sans la moindre E/S, l'import du graphe
applicatif ne prend que 0,82 s en local, Fluid Compute était déjà actif et la mémoire déjà au
maximum. **Les leviers évidents étaient déjà tirés.** Le reste était le téléchargement et le
dépaquetage de la fonction — 264 Mo, 20 447 fichiers.

**Retenu.** Un **portier d'ACK** : seconde fonction Vercel de 24 Ko, **zéro `node_modules`**, qui
vérifie le HMAC, répond, et rejoue la requête vers un chemin interne. Il **ne décide rien** :
aucune base, aucun appel Slack, aucun `action_id` connu de lui. Mesuré après déploiement :
734 ms de médiane.

⚠️ **Et ce qu'un portier ne sauve pas** : `views.open` a lieu **ensuite**, dans la fonction restée
froide, donc le `trigger_id` est périmé. Les quatre modales ont été **supprimées**, remplacées
par des échanges écrits à zéro token. *Le correctif de latence a changé la nature de
l'interface.*

⚠️ Les chiffres sont un **majorant** : `x-vercel-id: cpt1::iad1` — la requête entre au Cap, la
fonction tourne à Washington. Slack ne paie pas ce trajet. **Toute mesure de latence prise d'ici
doit être lue avec cette réserve.**

---

## Synthèse — ce qui manque, classé

### Dettes réelles, par coût décroissant

| # | Manque | Coût | Effort |
| --- | --- | --- | --- |
| 1 | **Les appels d'outils ne sont pas persistés** (`audit_logs` n'enregistre que 3 actions, aucune venant d'un outil) | on ne peut mesurer aucun outil au-delà de quelques jours — dans un dépôt qui décide **sur mesure** | faible : le point d'écriture existe |
| 2 | **Aucun `outputSchema`** sur les 13 outils | la forme du tool-result n'est vérifiée par aucun contrat ; les 21 `reason` ne sont validés nulle part | moyen |
| 3 | **Aucun `maxSteps` / `stopWhen`** | seule borne : 40 s. Dix appels d'outil en 30 s passent, et chacun est une requête pleine sur un quota journalier | très faible |
| 4 | **Idempotence sur 2 des 5 outils agissants**, et **par instance** | un doublon sur démarrage à froid — le cas nominal à ≈ 19 messages/jour | moyen (le patron `slack_event_dedup` existe déjà) |
| 5 | **`READ_ONLY_TOOL_NAMES` recopié** au lieu d'être dérivé d'`AGENT_TOOLS` | a **déjà** été faux, et le symptôme était un silence de la réconciliation FAIT/NARRATION | faible |
| 6 | **Aucun outil réversible** (pas de `cancelReminder`) | la seule sortie est « repasse me le demander » — le verdict que le propriétaire a rejeté | moyen |
| 7 | **Vocabulaire de `reason` non typé** — 21 codes, 5 synonymes apparents | dette de lisibilité ; ces codes sont lus en prose, pas par du code | faible |
| 8 | **Aucun timeout ni retry par outil**, aucune reprise réseau dans `src/` | un hoquet réseau produit un échec sec ; `resilientFetch` n'existe que dans `scripts/` | moyen |
| 9 | **Aucun jeu d'évaluation sur la DÉCISION d'appeler un outil** | les campagnes le font à la main, donc pas à chaque commit | élevé |
| 10 | **Quarantaines par préfixe de nom** | `archiveChannelDigest` passerait les deux gardes | faible (un champ `sideEffect`) |

### Absences délibérées, et pourquoi elles tiennent

- **Pas de recherche sémantique** — un embedding par message ingéré, sur un quota journalier.
  Réexaminer si le volume de `channel_messages` décolle.
- **Pas de pagination** — le `limit` a été retiré d'un schéma **exprès** : il ne servait qu'à
  laisser le modèle choisir combien on lui facture.
- **Pas de back-off générique** — le dernier maillon plafonne en **requêtes** (4/min) : une
  seconde d'attente ajoute de la latence sans changer l'issue.
- **Pas de passation entre agents** — aucun mécanisme n'existe ; la consigne qui le prétendait a
  été supprimée et deux tests protègent la suppression.
- **Pas d'`outputSchema` contraignant côté modèle** — Mastra ne s'en sert pas pour contraindre.
  Le manque de §2 porte sur le **contrat interne**, pas sur le function calling.
- **Pas de champ libre dans `scheduleCandidateInterview`** — le pire cas d'une injection réussie
  doit rester un spam d'invitation, jamais une fuite.
- **Pas de `dryRun`** — un mode simulation est un second chemin, donc un second endroit où le
  verdict peut mentir. Le dépôt a corrigé **trois fois** un verdict qui mentait.

### Ce que le dépôt fait mieux que la plupart

1. **Le câblage agent → outils est déclaré une seule fois** et le routage en dérive. Une
   divergence casse un test au lieu de fausser un chiffre en silence.
2. **Les quarantaines lèvent à la CONSTRUCTION**, pas au runtime : un câblage interdit ne
   démarre pas.
3. **Le budget de tool-result est verrouillé sur une PROPRIÉTÉ** (l'indépendance à la taille du
   contenu), pas sur un chiffre qui se périme.
4. **La partition lecture/action est réifiée** et sert à confronter ce que le modèle dit à ce
   qu'il a fait.
5. **Le refus tombe avant toute lecture en base**, et les tests le vérifient en assertant que le
   repository n'est jamais appelé.
6. **Chaque correctif d'outil porte sa mesure** — avant/après, en production, pas en intention.

---

## La ligne qui traverse cet audit

Ce que ce dépôt **dérive** est juste ; ce qu'il **recopie** a dérivé. Sans exception trouvée.

Les six forces ci-dessus sont toutes des **dérivations** — la frontière négative dérivée des
clés d'outils, le routage dérivé d'`AGENT_TOOLS`, le budget dérivé d'une propriété.

Les dettes 2, 5, 7 et 10 sont toutes des **recopies** — une liste de noms d'outils écrite à la
main, un vocabulaire de `reason` par convention, une quarantaine par préfixe.

Et la dette n° 1 est d'une troisième nature, la plus dangereuse : **un dépôt qui décide sur
mesure ne mesure pas ses propres outils.** Il mesure ses prompts, ses tool-results, sa latence,
ses quotas — et pas l'objet dont ce document parle.
