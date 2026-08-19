# Plan — revue générale du Conseil, 2026-08-19

Six lentilles indépendantes (Contrarian, First Principles, Expansionist, Outsider, Executor,
et la synthèse) sur l'intégralité du projet : décisions prises, organisation du code, textes
lus par des humains, santé mesurée du dépôt.

Rien n'a été modifié pour produire ce document. Chaque constat porte une référence
`fichier:ligne` et une mention **VÉRIFIÉ** (commande lancée) ou **RELEVÉ** (rapporté par un
membre, non revérifié par la synthèse).

---

## Le fil qui tient tout

Ce dépôt s'est donné une règle et l'a appliquée avec une rigueur rare : **ne jamais affirmer un
état qu'on n'a pas constaté.** `emailSent: false` sous `status: 'success'`, `documents.content`
perdu en silence, un suivi de tâches qu'aucun mécanisme ne faisait avancer, `status: 'Sent'`
posé avant le `try` — quatre occurrences trouvées, nommées, corrigées.

Le Conseil a trouvé la cinquième, et elle est dans le code le plus récent : **le parcours
conversationnel livré le 2026-08-19 reproduit la famille de défaut que ce dépôt existe pour
empêcher**, six fois. Ce n'est pas une régression de discipline — c'est que la discipline a été
appliquée aux mécanismes qu'on écrivait, pas aux mécanismes qu'on venait de rendre
inatteignables en supprimant les modales.

Une seule cause racine explique les deux défauts les plus graves.

---

## [A] LA CAUSE RACINE — `slack_directory.employee_id` n'est jamais écrite en production

**VÉRIFIÉ.** `linkEmployee` est l'unique écrivain de cette colonne. Son unique appelant est
`directory-sync.service.ts:239`, dont l'unique point d'entrée est le script manuel
`scripts/sync-slack-directory.mts` — qui, en dry-run (le défaut), le remplace par un no-op.
`directorySync` est exporté de `src/mastra/index.ts:167` et son `.run()` n'est jamais appelé
depuis `src/`.

`submitProfile` (`slack-events.handler.ts:2940`) crée le dossier par `runOnboarding` et **ne
relie rien**. Le crochet existe pourtant et l'identifiant lui est fourni :

```ts
// run-onboarding.ts:71  et :167 — l'identifiant EST passé
readonly onRecordReady: (employeeId: string | undefined) => Promise<void>;
await deps.onRecordReady(result.result?.employeeId);

// slack-events.handler.ts:2954 — et il est jeté
onRecordReady: () => this.sayAndRemember(input, INTERVIEW_QUESTION_DAILY),
```

### Ce que cette seule ligne casse

**A.1 — L'entretien dit « Noté » et n'enregistre rien.** `persistInterviewAnswer:3231` :
`if (!answer || !this.interviewRepo || !input.employeeId || !input.user) return;` — sortie
silencieuse, sans log. `input.employeeId` vient de `resolveRequesterIdentity` →
`slack_directory.employee_id`, donc `undefined` pour quiconque a été créé par le chemin
conversationnel. La personne répond, lit « Noté. », puis « j'y mettrai ce que tu viens de me
dire », et `onboarding_interview` reste vide. Elle demandera son guide et recevra le gabarit
générique, sans qu'aucun champ du tool-result ne signale l'absence.

⚠️ **Pourquoi le test de production du 2026-08-19 n'a rien vu** : la ligne d'annuaire de Karyl
a été reliée par une exécution passée du script `--apply`. La feature fonctionne exactement
pour les personnes reliées à la main, et échoue en silence pour toutes les autres — c'est-à-dire
pour tout nouvel arrivant.

**A.2 — `AUTHZ_ENFORCE` est inactivable.** `canReadPersonRecord` accorde « son propre dossier,
toujours » sur `context.employeeId`. Le poser aujourd'hui couperait chacun de **son propre**
dossier. `CLAUDE.md` avertit d'un seul facteur (le domaine email de l'administratrice) ; celui-ci
n'est nulle part et son symptôme est identique.

### Correction

Passer l'identifiant à `onRecordReady` et appeler `linkEmployee(slackUserId, employeeId)`.
Deux lignes. Puis faire échouer bruyamment `persistInterviewAnswer` quand l'identifiant manque —
la sortie muette est ce qui a rendu le défaut invisible pendant qu'un test de production le
traversait.

**Coût : zéro token. Priorité : la plus haute du dossier.**

---

## [B] LES DÉTECTEURS PARTIELLEMENT DÉSARMÉS

**B.1 — La réconciliation FAIT/NARRATION est muette sur le chemin le plus fréquent. VÉRIFIÉ.**

`claim-reconciliation.ts:101-108` — `READ_ONLY_TOOL_NAMES` contient encore `getTaskList`
(supprimé le 2026-08-14) et ignore `findPersonByName` et `findExpertise` (ajoutés le même jour).
Un nom absent de la liste est réputé ACTEUR, donc `hasActingToolCall` rend `true` et le
détecteur se tait pour tout le tour. Or `findPersonByName` est câblé sur `onboardingOrchestrator`
**et** `notificationAgent` : c'est le premier geste de presque toute demande nommant quelqu'un.

Le commentaire au-dessus annonce un verrou — `tests/unit/quality/tool-classification.test.ts` —
qui **n'existe pas** (`tests/unit/quality/` ne contient qu'`architecture.test.ts`).

→ Corriger la liste **et écrire le test annoncé** : croiser `AGENT_TOOLS` avec
`READ_ONLY_TOOL_NAMES` ∪ acteurs assumés. Sans lui, la liste redivergera au prochain outil ;
elle vient de le faire deux fois en une journée.

**B.2 — Du texte contrôlé par un tiers entre non encadré chez un agent qui écrit dehors. VÉRIFIÉ.**

`find-person-by-name.ts:165` rend `title: member.title` brut ; `find-expertise.ts` rend `title`,
`dailyWork` et les noms d'affichage bruts. Aucun `wrapRetrievedContent`, aucun
`sanitizeDisplayName`. Or `schema.ts:823` le dit lui-même : « `title` est le poste DÉCLARATIF,
édité par son porteur » — donc éditable par n'importe qui, invité mono-canal compris, et
restitué en réponse à la question **d'un autre**.

`findExpertise` est protégé en aval par la quarantaine (`knowledgeAgent` n'a aucun outil de
sortie). **`findPersonByName` ne l'est pas** : `AGENT_TOOLS.notificationAgent` porte
`findPersonByName` ET `sendNotification`. C'est la conjonction lecture-de-tiers + écriture
externe qu'`outbound-tool-quarantine.ts` §4.2 interdit, atteinte par la porte que personne ne
gardait.

⚠️ Portée réelle à dire honnêtement : `sendNotification` résout l'adresse **côté serveur** depuis
l'annuaire, donc le pire cas n'est pas l'exfiltration vers l'extérieur mais un email interne au
contenu contrôlé, parti de l'adresse de l'entreprise. C'est sérieux, ce n'est pas une fuite.

→ Encadrer ces champs, et corriger `untrusted-excerpt.service.ts:25` qui affirme être « la seule
feature du dépôt qui fasse entrer du texte de tiers dans la fenêtre du modèle » — la phrase qui
a fait qu'on n'a pas regardé.

---

## [C] LE PARCOURS HUMAIN — trois blocages durs

**C.1 — La question de l'email professionnel est une boucle sans sortie. VÉRIFIÉ.**

`profile-chat.ts` n'a **aucun** chemin « passe », alors que l'entretien en a un. Un arrivant qui
n'a pas encore d'adresse `@kisso.com` — et il n'existe **aucun provisioning** dans ce système,
le dépôt le dit lui-même — répond honnêtement « je n'en ai pas encore », reçoit la même phrase,
et n'a pas d'issue. Le DM d'accueil lui a pourtant dit « prépare trois choses, **tu les as
déjà** ».

→ Accepter une adresse personnelle, ou permettre de passer, ou ne pas exiger l'email avant que
l'entreprise ne l'ait fournie. À trancher, mais pas à laisser.

**C.2 — Les court-circuits statiques interceptent les réponses aux questions en attente. VÉRIFIÉ.**

`findStaticReply` tourne ligne 2467, **avant** `maybeAdvanceOnboarding` ligne 2540. Seuls les
trois court-circuits *agissants* cèdent le pas (lignes 2856, 3143 — correctif du 2026-08-19,
appliqué à un seul des deux groupes).

Conséquences relevées, sur les modules réels :
- un intitulé de poste contenant « harcèlement » déclenche le **message de détresse** — dans un
  bot RH, « Chargée de mission harcèlement et discrimination » est un intitulé réel ;
- « Salut » ou « Test » comme prénom déclenche la salutation, seul court-circuit à
  `remembersTurn: true` : il **écrase le dernier tour assistant**, donc détruit la machine à états.

→ Étendre la cession du pas au groupe statique, en gardant la détresse prioritaire (c'est un
droit, pas un privilège) mais en n'avalant pas la réponse.

**C.3 — Le message de détresse oriente vers une institution française. VÉRIFIÉ.**

`distress.ts:170` : « parles-en à l'équipe RH de Kisso ou **à la médecine du travail** ». La
médecine du travail est française ; elle n'a pas de guichet identifiable à Lagos. On a corrigé le
3114 et laissé l'institution française dans la phrase suivante.

✅ Les deux numéros, eux, sont **confirmés** par recherche indépendante : `0800 0787 746` (SURPIN,
gratuit, 24h/24, membre de LifeLine International) et le `112` (numéro d'urgence national,
gratuit, tous réseaux). Réserve honnête : le déploiement du 112 n'est pas homogène selon les
États — cela ne justifie pas de le retirer.

→ Remplacer « la médecine du travail » par ce que Kisso a réellement, nommé, ou par rien.

---

## [D] LES PROMESSES SANS MÉCANISME

Toutes **VÉRIFIÉES**, toutes dans des textes en dur — donc hors de portée de `sanitizeAgentOutput`
et de la réconciliation.

| Texte | Promesse | Mécanisme |
|---|---|---|
| `interview-chat.ts:52` | « je m'en sers pour **te proposer les bons canaux** » | Aucun. `handler:3239` écrit `channels: existing?.channels ?? []` ; le seul écrivain était la modale, morte le 19 |
| `interview-chat.ts:156` | « Reviens quand tu veux, **je reprendrai où on en est** » | Aucun. L'état est le dernier tour assistant, TTL 60 min. Le texte de report ne matche aucun marqueur : `pendingInterviewStep` rend `null` immédiatement |
| `welcome-email.ts:108` | « un DM **avec un bouton pour compléter ton profil** » | Le bouton s'appelle « **C'est fait** ». `buildProfileButtonBlock` n'a plus aucun appelant, et son `action_id` n'est traité par aucune branche |
| `welcome-email.ts` (date) | « On t'attend le \<date\> » | `handler:2957` passe `startDateFromJoin(undefined, new Date())` : sur le chemin conversationnel, `startDate` = **aujourd'hui**, toujours. La règle « un champ absent fait disparaître sa phrase » est contournée parce que le champ est fabriqué en amont |
| `forget.ts:287` | nomme 3 exceptions | **Omet `onboarding_interview`** — la seule prose que la personne ait écrite sur elle-même, et qui reste consultable par `findExpertise` |

⚠️ **Et un usage non annoncé.** L'entretien annonce deux usages (canaux, guide). Il en a un
troisième : `findExpertise` restitue `dailyWork` **mot pour mot** à un collègue qui demande « qui
s'occupe de X ? ». Ce que la personne a écrit en confiance dans un questionnaire d'accueil devient
sa fiche publique. C'est un changement d'usage, et l'en-tête de `find-expertise.ts:41-49` disait
lui-même, avant qu'on l'y branche, qu'il « se demande avant de se coder ». La question a disparu
sans être tranchée.

→ Corriger les cinq textes (quelques dizaines de caractères, zéro token). Rouvrir la question du
consentement, ou l'annoncer dans la question elle-même.

---

## [E] LES ÉTATS QUI MENTENT

**E.1 — `onboarding_progress` enregistre « 0 sur 1 » à l'instant où l'unique étape est faite.**
`onboarding-plan.ts:71` pose `currentStep: 0` ; `buildOnboardingPlan` n'est appelé qu'**après**
que `createEmployeeStep` a persisté un profil complet — c'est-à-dire après la seule étape. Rien
ne l'avance : les seuls écrivains sont ce chemin et l'outil LLM `updateOnboardingStatus`.
C'est le défaut `ONBOARDING_TASKS` recréé sous forme réduite, dans le fichier dont l'en-tête
affirme l'avoir supprimé. → Une ligne dans `submitProfile`.

**E.2 — Toutes les lignes d'audit `SLACK_MESSAGE` disent `success`.** `audit-log.ts:71` applique
`status ?? 'success'` et `handler:2634` n'en passe aucun — écrit **avant** le budget, avant
l'agent, avant la publication, sans chemin de mise à jour. La colonne est **indexée** pour qu'un
humain filtre dessus. Les deux autres sites passent correctement `'denied'`, ce qui rend
l'omission lisible comme un oubli. Même forme que `status: 'Sent'` avant le `try`.

**E.3 — `findExpertise` rend un faux résultat silencieux dès sept personnes. VÉRIFIÉ.**
Zéro `sort()` dans le fichier : `experts.slice(0, 6)` retient les six dont l'identifiant
technique trie le plus bas — arbitraire mais **stable**, donc toujours les six mêmes. Et
`truncated: true` est un **champ séparé**, c'est-à-dire précisément la forme dont ce dépôt a
mesuré le 2026-08-14 qu'elle est ignorée par le modèle (l'expérience `coverage` puis `hint` sur
`getChannelHistory`). L'instruction de l'agent ne couvre pas le cas : elle parle d'« un nombre
d'extraits retenus », que `findExpertise` ne rend pas.
→ Trier par pertinence, et coller la couverture **dans** le contenu. Zéro token, ~20 lignes.
Le code existe déjà à côté (`excerpt-salience.ts`, `excerpt-budget.ts`).

**E.4 — Les homonymes sont fusionnés.** `find-expertise.ts:255` déduplique par nom normalisé :
deux « Jean Martin » n'en font qu'un, le second disparaît sans trace. `findPersonByName` traite
le même problème **correctement** (`reason: 'ambiguous'`, aucun identifiant). La règle a été
comprise et appliquée à un outil, pas à son voisin.

---

## [F] LA SANTÉ DU DÉPÔT — mesurée, et le préalable à tout

| Commande | Résultat |
|---|---|
| `typecheck` | exit 0 |
| `lint` | exit 0, **zéro warning** |
| `build` + `verify:bundle` | exit 0 — import ESM réel, PDF 7 082 o, DOCX 8 495 o |
| bundle | `index.func` 160 Mo / 8 766 fichiers ; `slack-ack.func` 24 Ko / 3 fichiers |
| `test:unit` ×3 | ✅ / **❌ 4 échecs** / ✅ — **un run sur trois est rouge** |

**Tous les échecs sont des `Timeout 5000ms`, jamais une assertion.** La cause documentée dans
`CLAUDE.md` est **périmée** : ce n'est ni `accessGuard` (à `null` partout), ni `auditSink`
(injecté, delta `audit_logs` mesuré = 0), ni la base.

**C'est une HUITIÈME dépendance non recensée. VÉRIFIÉ.**
`slack-events.handler.ts:628` — `workspaceProvider = options.workspaceProvider ?? new
SlackWorkspaceService(botToken)`. Trois fichiers ne l'injectent pas. `handleMessage` **await**
l'identité ligne 2552, avant les court-circuits agissants ligne 2573 ; `resolveRequesterIdentity`
part alors sur `users.info` vers slack.com — 0,72 à 1,65 s **par test**, le cache étant un LRU
par instance et chaque test refaisant `makeHandler()`.

⚠️ **Et les doublures d'annuaire ne l'empêchent pas** : `:1497` lit
`known.realName || firstName+lastName` et **jamais `displayName`**. Les doublures qui ne posent
que `displayName` laissent la garde `if (!resolved.displayName)` tirer. Les commentaires en tête
de ces fichiers, qui les déclarent hermétiques, sont faux.

⚠️ **Correction de ma propre conclusion du 2026-08-19** : j'avais attribué la flakiness à
`accessGuard` + `auditSink` et conclu sur cinq runs verts consécutifs. J'avais retiré deux coûts
sur trois ; les cinq verts étaient une amélioration prise pour une cause épuisée. `CLAUDE.md` dit
SEPT dépendances à neutraliser — il en faut **HUIT**.

**Correctif : une ligne par fichier** (`workspaceProvider: { getUserById: async () => null }`),
plus des doublures qui rendent `realName`. **30 minutes, et ça conditionne tout le reste** :
tant qu'un run sur trois est rouge sans cause visible, aucun refactor n'est vérifiable — le rouge
sera lu comme une régression, ou une vraie régression sera lue comme le flake connu.

---

## [G] L'ORGANISATION DU CODE — ce que les chiffres disent

**G.1 — Les défauts ont une adresse.** Sur 70 commits `fix`, **19 touchent
`slack-events.handler.ts`** (27 %), qui fait 3 554 lignes et **10,6 % de tout `src/`**. Il a reçu
**27 commits en 7 jours**, le plus fort churn du dépôt. Découper ce fichier n'est pas une
préférence esthétique.

⚠️ **Mais pas maintenant.** C'est aussi le fichier dont les tests flottent et qui est en chantier
permanent : un découpage entrerait en collision avec chaque correctif en vol, et le rouge produit
ne serait attribuable à rien. **On ne refactorise pas sous un filet qui clignote.**

**G.2 — `src/shared/` est une quatrième couche que rien ne gouverne.** 7 715 lignes — autant que
tout le `domain` des 8 features réunies. Sept des neuf prédicats de court-circuit y vivent
(1 301 lignes) avec **un seul consommateur**, `deterministic-replies.ts`, lui-même dans
`notification/domain/`. Ils ne sont partagés par personne.
Le test d'architecture ne couvre que `features/*/domain` et `features/*/application` :
`shared/` lui est invisible. Point mineur mais net — `CLAUDE.md:233` annonce **deux** tests
garde-fou ; le second, `code-architecture.test.ts`, **n'existe pas**.
⚠️ Vérifié : `shared/` n'importe **aucune** feature. C'est donc un problème de cohésion, pas de
cycle — à dire honnêtement avant de proposer quoi que ce soit.

**G.3 — L'architecture par ports est payée, mais pas pour la raison invoquée.** 23 ports
comportementaux, dont **2 seulement** ont plus d'une implémentation de production
(`EmailProvider`, `DocumentRenderer`). Les 8 entités du `domain` totalisent 378 lignes et sont
des types, sans invariant ni méthode. Ce qui est réellement payé n'est pas la substituabilité,
c'est **l'inversion de dépendance comme outil de test** (27 fichiers injectent des doublures) et
la garantie qu'aucun `import { db }` ne se glisse dans un prédicat pur — sans quoi un
court-circuit à zéro token redeviendrait une E/S sur le chemin des 3 secondes.

**G.4 — Aucun registre de migrations.** 18 tables dans `schema.ts`, 2 migrations Drizzle
désynchronisées et documentées comme cassées sur base vierge, **11 fichiers DDL appliqués à la
main**, et rien qui enregistre ce qui a été appliqué où. On ne peut ni construire un
environnement neuf, ni vérifier autrement qu'à l'œil que la production correspond au schéma.

**G.5 — 45 % de `src/` est du commentaire** (15 047 lignes sur 33 394). La culture est un actif
— mais le Conseil a trouvé **trois** défauts qu'un commentaire a masqués, et ils partagent une
forme : **le commentaire énonce une propriété globale que rien ne recalcule** (« la seule feature
qui… », « verrouillé par… », « délibérément absente »). Les commentaires locaux et vérifiables
sur place sont excellents. Ce sont les affirmations de portée qui coûtent.
→ Un test de 15 lignes : toute phrase « verrouillé par `X` » doit citer un fichier qui existe.
Il aurait attrapé [B.1] le jour même.

**G.6 — Le dépôt a 70 `fix` pour 25 `feat`**, et `CLAUDE.md` fait 1 622 lignes dont 99 portent un
⚠️ et **35 corrigent ses propres affirmations passées**. Chaque correction était juste ; leur
accumulation ne l'est plus. C'est le document d'accueil d'un nouveau contributeur.

---

## [H] DETTE ET CODE MORT — relevé, à trancher

**Code mort vérifié sans appelant** : `buildProfileButtonBlock` + `COMPLETE_PROFILE_ACTION_ID`,
`buildInterviewInviteBlocks` + `START_INTERVIEW_ACTION_ID`, `profile-modal.ts`,
`interview-modal.ts`, tout le traitement `view_submission`, `saveStep`/`updateStep`/`findSteps`,
`EmployeeRepository.update` (zéro appelant), l'export `directorySync` (jamais `.run()`).

⚠️ **Deux boutons construits sans handler** : leur `action_id` tombe sur
`logger.debug('block_actions sans action connue')` — et `LOG_LEVEL` vaut `info` par défaut, donc
un clic sans effet **et sans trace**. Pas de bug live (aucun appelant), mais deux pièges armés.

**Tables sans lecteur** : `documents` (écrite par `generateDocument`, lue par personne),
`audit_logs` (**écrite à chaque message, jamais lue, jamais purgée** — 14 809 lignes en local),
`slack_channels` / `slack_channel_members`, `employee_documents`, `questionnaire_responses`,
`tasks`, `onboarding_steps`, `questionnaires`.

**Colonnes inertes** : `completion_percentage` (indexée, jamais écrite),
`employees.onboarding_status` (indexée, jamais écrite — contredit `onboarding_progress`),
`employees.status` figé à `pending` **et projeté au LLM**, le bloc stockage de `documents`.

**Données personnelles sans chemin d'effacement** : `documents` (dont `content`, la base EST le
stockage), `notifications` (`subject` + `body`), `slack_directory`, `onboarding_interview`,
`audit_logs`.

⚠️ **Correction à porter au `TODO.md`** : il affirme que retirer la modale « emporte l'invitation
aux canaux, qui n'a aujourd'hui aucun autre chemin ». **C'est faux** —
`slack-events.route.ts:216` câble `welcomeChannels`, alimenté par `ONBOARDING_WELCOME_CHANNELS`,
**posée dans `.env`** : les nouveaux arrivants sont bien invités au `team_join`. Ce qui
disparaît réellement, c'est le **choix des canaux par la personne**, et seulement pour les gens
déjà présents. Le blocage de cette tâche était donc surestimé.

---

## [I] LA PROPOSITION D'AJOUT — un cron, et un seul

Le produit ne se manifeste **jamais** : toute interaction est *pull*. Il n'existe aucun
ordonnanceur — pas de `crons` dans `vercel.json`, `findPending()` sans site d'appel,
`directorySync` jamais invoqué, purges probabilistes. Sept fichiers écrivent la même phrase
(« il n'existe ni cron ni poller »), et **deux la font payer au modèle à chaque aller-retour**
(`notification-agent.ts:31`, `schedule-reminder.ts:63`).

**Un cron Vercel quotidien, sans aucun appel de modèle**, exécutant trois choses déjà écrites et
déjà testées :
1. `directorySync.run()` — écrit `employee_id` (ferme [A]), rattrape les départs (`deleted: true`
   n'est annoncé par aucun événement abonné) ;
2. drainer `notifications` où `status='scheduled'` — `scheduleReminder` cesse de mentir ;
3. purger `conversation_turns` et `audit_logs` sur une borne réelle.

**Coût en tokens : zéro.** Et il est **mieux qu'autofinancé** : il permet de supprimer les deux
consignes qui excusent la pièce manquante (~25 tokens repayés à chaque aller-retour).
⚠️ Réserve : le plan Vercel Hobby limite à 2 crons quotidiens — suffisant ici, mais non vérifié.

---

## SÉQUENCE

Un commit par lot, `typecheck && test:unit && lint` vert à chaque étape, test rouge d'abord
partout où un comportement change.

| Lot | Contenu | Coût | Pourquoi là |
|---|---|---|---|
| **0** | **Hermétiser les 3 fichiers de test** ([F]) — `workspaceProvider` stubbé, doublures en `realName` | 30 min | **Conditionne tout.** Aucun changement de production dans ce commit, sinon le vert n'est attribuable à rien |
| **1** | **La cause racine** ([A]) : lier l'annuaire à la création, échec bruyant si l'identifiant manque | 1–2 h | Débloque l'entretien ET `AUTHZ_ENFORCE` |
| **2** | **Les détecteurs** ([B.1] + le test manquant, [B.2] encadrement) | 2–3 h | Sécurité, et [B.1] se redésynchronisera sans son test |
| **3** | **Les blocages humains** ([C.1] boucle email, [C.2] ordre des court-circuits, [C.3] détresse) | 2–3 h | Ce sont des gens bloqués aujourd'hui |
| **4** | **Les promesses mortes** ([D], 5 textes) + [E.1] + [E.2] | 2 h | Quelques dizaines de caractères, zéro token |
| **5** | **`findExpertise`** ([E.3] tri + couverture inline, [E.4] homonymes) | 2 h | Seul faux résultat silencieux, déjà ouvert à 60 personnes |
| **6** | Hygiène `TODO.md` / `CLAUDE.md` : 3 tâches périmées, 2 rejets encodés en tâches, 3 chiffres faux, la 8ᵉ dépendance, les 2 tests d'architecture | 1 h | Une tâche périmée coûte plus qu'une tâche absente |
| **7** | `EmployeeRepository.update` (0 appelant), test « verrouillé par X existe » ([G.5]) | 1 h | Soustractif |
| **8** | Tests de caractérisation de `maskPii`, **puis** déplacement pur vers `shared/pii-masking.ts` | 4–5 h | ⚠️ Le `TODO.md` dit « les tests existants doivent passer inchangés » — **il n'y en a aucun**. 413 lignes du garde-fou de confidentialité couvertes à 0 % |
| **9** | Décodage unique des erreurs Slack — **en correctif, pas en refactor** | 2 h | Les 4 stratégies ne diffèrent pas par le style : deux adaptateurs sont en désaccord sur `channel_not_found` |
| **10** | Découper `execute` de `generate-document` | 3–5 h | Meilleure couverture du lot (55 `it(` sur 5 fichiers), risque faible |

### Ce qui ne doit PAS aller dans le même commit
- Le lot 0 et tout changement de production.
- Le déplacement de `pii-masking.ts` et la moindre reformulation du masquage — `git show --stat`
  doit montrer un déplacement pur.
- Le retrait de la modale et le découpage de la route : retirer d'abord, découper ensuite.
- L'unification du décodage d'erreurs et le découpage de `generate-document` (même ligne 146).
- ⚠️ **Jamais « harmoniser » les deux régimes d'ACK** — c'est écrit en tête de fichier.

### Reporté, avec la raison
- **`handleMessage`** : 27 commits en 7 jours, tests flottants. Après stabilisation.
- **Découpage de `slack-interactions.route.ts`** : après la décision modale — 40 % du fichier
  pourrait disparaître.
- **`ChatProvider`/ISP** : après `handleMessage`.

### Décisions qui ne m'appartiennent pas
1. **L'invitation aux canaux** — automatique via `ONBOARDING_WELCOME_CHANNELS` (déjà câblée), une
   troisième question conversationnelle, ou actée perdue. Conditionne le retrait de la modale.
2. **Le consentement sur `dailyWork`** — l'annoncer dans la question, ou retirer l'entretien de
   `findExpertise`. La question était ouverte dans le code et a disparu sans être tranchée.
3. **Le cron** ([I]).
4. **Les 316 lignes de crypto de `llm-guardrail.ts:147-462`** — inchangé, je n'y touche pas sans
   accord explicite.
5. **Payer le palier Groq.** ≈ 19 messages/jour aujourd'hui ; ≈ 1 à 2 €/mois pour le lever.
   ⚠️ Avant de payer, la mesure la moins chère et la plus décisive du projet : **combien de
   messages atteignent réellement `agent.generate()` ?** L'instrumentation existe
   (`Court-circuit deterministe (…)` en `info`), la mesure n'a jamais été faite.
   ⚠️ Et : **aucun `maxSteps` n'est configuré** — Mastra applique son défaut de **5 étapes**, soit
   jusqu'à ≈ 7 500 tokens pour un seul message. Le plafonner à 3 est un correctif à zéro risque.
