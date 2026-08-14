# CHANGELOG.md — Kisso Onboarding

## [Unreleased] - 2026-08-14 (3) — lot 3, et les dettes que les `.md` portaient depuis deux jours

Deux moitiés. La première ferme des dettes **recensées et laissées ouvertes** dans `TODO.md` —
dont une faille d'usurpation. La seconde est le lot 3 : « qui peut faire quoi », et
l'atteignabilité du `knowledgeAgent`.

### Security — `requestContext` était forgeable par le corps HTTP sur `/api/*`

Recensé le 2026-08-12, resté ouvert. Mastra fusionne `body.requestContext` dans le contexte
serveur et n'écarte que `RESERVED_CONTEXT_KEYS` — vérifié dans le paquet installé
(`@mastra/server/dist/constants-*.js`) : la liste tient `mastra__*` et `organizationId`, et
**aucune clé `slack*`**.

Or c'est sur ces clés que se décident les droits : `slackEmployeeId` gouverne
`canReadPersonRecord` (dossier RH, historique de notifications, document au nom d'autrui) et
`slackAccessLevel` gouverne `getUserConversations` et `canPerformSideEffects`. Un porteur de
`MASTRA_API_TOKEN` se déclarait donc n'importe qui. La route n'est pas anonyme — mais **le jeton
de service valait l'usurpation totale**, ce qui n'est pas ce qu'un jeton de service est censé
valoir. L'invariant écrit en tête de `slack-request-context.ts` (« une valeur que le modèle ne
peut pas écrire ») ne tenait en réalité que sur `/slack/events`.

`createRequestContextGuard` (`src/shared/security/request-context-guard.ts`), monté **en
premier** dans `server.middleware` :
- il **REFUSE** en 400 au lieu d'assainir. Retirer les clés en silence laisserait l'appel
  aboutir : les tools dégraderaient proprement (`readSlackContext` rend `undefined` hors Slack,
  c'est leur cas nominal) et rendraient une réponse plausible — une tentative d'usurpation
  ressemblerait à un succès partiel et ne laisserait aucune trace lisible ;
- il surveille un **PRÉFIXE**, pas une liste recopiée. La liste réelle s'allonge
  (`slackEmployeeId` y est arrivée le 2026-08-13) ; une copie couvrirait les clés d'aujourd'hui
  et laisserait passer celles de demain, en silence. Un test vérifie que **toutes** les clés
  déclarées portent ce préfixe ;
- ⚠️ le corps est lu via `Request.clone()` — sans quoi le flux serait consommé et toute requête
  `/api/*` légitime partirait ensuite sur un corps vide. Un test le verrouille.

### Fixed — le palier collant a cessé d'être un piège (routage par CAPACITÉ)

`TODO.md` [0 bis] le disait sans détour : *« le palier collant a DÉPLACÉ l'état absorbant, il ne
l'a pas supprimé »*. Après « Envoie un rappel à Pamela » (échappement `rappel` →
`notificationAgent`), « Génère-moi le guide en PDF » **restait chez `notificationAgent`, qui n'a
pas `generateDocument`** — et en DM la clé de conversation est le canal, donc le verrou tenait
une heure sur tous les sujets.

La règle ne porte plus sur la PRIORITÉ des bandes mais sur le CÂBLAGE :

    le fil est conservé, SAUF si l'agent qui le mène ne porte pas l'outil demandé.

Sûre dans les deux sens : elle n'arrache jamais un fil à un agent qui sait répondre (donc ne
rejoue pas le défaut du 2026-08-11), ni ne le laisse chez un agent qui ne sait pas (donc ferme
celui du 2026-08-12). Et elle est **dérivée** de `AGENT_TOOLS`, pas rédigée.

⚠️ **Un test verrouillait le défaut** et a dû être retourné : il asseyait « Donne le PDF alors »
restant chez `notificationAgent`, justifié par « un agent qui promet une capacité qu'il n'a
pas » — or c'est l'inverse, l'orchestrateur PORTE `generateDocument`.

⚠️ **`email` / `message` ne délogent JAMAIS**, et c'est une correction, pas une prudence : un
test de non-régression du 2026-08-11 l'a attrapé pendant l'implémentation. `generateDocument`
porte `deliverTo: 'email'`, donc l'orchestrateur sert « Par email » sans `sendNotification` ;
l'en déloger rejouait exactement l'alternance A → B → A. D'où la règle d'admission : le terme
doit désigner une capacité servie par **exactement un** agent.

### Added — `knowledgeAgent` est enfin atteignable

Ses seules portes d'entrée étaient `conversation` et `historique`. « Résume ce qui s'est dit
dans #kisso-hq » partait au défaut, donc chez un agent sans aucun outil de canal — et **toute la
`disclosure-policy.ts` était du code mort sur la phrase que quelqu'un dirait vraiment**. Rien ne
fuyait, mais ce n'était pas la politique qui l'empêchait, c'était l'inaccessibilité.

Ajout en **bande 3** (l'endroit sûr — elle ne peut pas détourner une réponse de suivi) de
`résume|résumé|resume|resumé`, et du **jeton de canal `<#C…>`** : meilleur signal que tout
mot-clé, produit par le client Slack, jamais tapé, et il survit à `cleanText`.

### Added — `findExpertise` : « qui peut faire quoi »

Le workspace savait déjà qui fait quoi (`slack_directory.title`, 40 lignes ;
`employees.position`, 2 lignes) ; **aucun tool ne savait l'interroger**. « Qui s'occupe du
backend ? » n'avait donc qu'une réponse possible, celle que le modèle inventait.

- **Deux sources**, comme `findPersonByName` : Awa n'a aucune ligne d'annuaire, les quatre
  autres personnes vivantes n'ont pas de dossier. Une seule source laisse la moitié du workspace
  introuvable — le relevé l'impose, ce n'est pas une précaution.
- **Aucun identifiant, aucune adresse** dans le résultat. La question est posée au PLURIEL :
  rendre des UUID inviterait le modèle à en choisir un, le geste exact qui a envoyé le document
  d'Awa à l'adresse de Karyl. Sans identifiant, l'appel suivant est structurellement impossible.
- **Le poste déclaré, et lui seul.** `onboarding_interview.dailyWork` serait plus riche, mais
  la table comptait **0 ligne** — l'inclure n'ajouterait aucune recall — et une personne l'a
  écrit dans un entretien dont l'objet annoncé est son guide et ses canaux : en faire un index
  interrogeable par ses collègues est un changement d'usage, qui se demande avant de se coder.
  Un poste Slack, lui, est déjà visible de tout le workspace.
- Rapprochement par **préfixe de mot** (`matchesName`, partagé) : « postgres » retrouve
  « PostgreSQL », « api » ne retrouve pas « rapide ». Résultat borné en NOMBRE **et en longueur
  d'étiquette** — borner la liste seule laisse la taille dépendre des intitulés, défaut qui a
  déjà coûté 9 600 tokens à `getNotificationHistory`.

### Changed — le câblage agent → outils est déclaré UNE SEULE FOIS

`src/shared/agent-capabilities.ts`. Il était recopié à la main dans la constante `WIRING` du
test de budget et dans `_measure.mts`, et **les deux copies avaient dérivé** — elles ignoraient
`findEmployeeByEmail` sur deux agents sur trois, donc toute mesure de FLOOR qui s'y fiait était
fausse. `CLAUDE.md` le signalait sans que personne ne puisse le voir. Le routage s'en sert
désormais : une divergence casse un test de routage au lieu de fausser un chiffre en silence.

### Fixed — dettes `TODO.md` fermées, et trois entrées qui étaient FAUSSES

- `maskPii` couvre désormais la prose écrite par un humain : `text`, `content`, `body`, `fact`,
  `dailyWork`, `workStyle`. ⚠️ `message` reste exclu — c'est le champ des messages d'erreur, le
  masquer supprimerait le diagnostic au lieu de protéger quelqu'un.
- « imagine / suppose … **que tu es** » est détecté comme redéfinition de rôle. L'exigence de
  « que tu es » sépare l'attribution d'identité de la simple hypothèse : « imagine qu'on ajoute
  un canal » ne déclenche pas — trois phrases de trafic RH nominal le verrouillent.
- Six scripts gagnent une entrée npm (`directory:sync`, `directory:show`, `directory:prune`,
  `db:ddl`, `probe:replies`, `probe:erasure`).
- ⚠️ **`npm run lint` mentait, et `|| true` le masquait.** `TODO.md` affirmait « 0 erreur, 104
  warnings » : il y avait **9 erreurs**, muettes. Sept étaient des faux positifs de
  `sonarjs/todo-tag` — la règle cherche des `// TODO:` abandonnés mais matche le mot n'importe
  où dans un commentaire, donc elle se déclenchait sur les renvois à `TODO.md`, que la culture
  de commentaires du dépôt cite constamment. Règle désactivée, la neuvième erreur corrigée,
  `|| true` **retiré** : `lint` est redevenu un signal (0 erreur, 113 warnings).
- ⚠️ **`src/config/index.ts` n'existe plus** — le répertoire entier est absent, `getConfig` a
  zéro occurrence. La tâche « câbler ou supprimer » et les **trois** mentions de `CLAUDE.md`
  invitaient à trancher sur un fichier supprimé. Conséquence à connaître : il n'existe aucune
  validation centralisée de l'environnement.
- ⚠️ **`SlackRateLimiter.prune()` A un site d'appel** — l'entrée décrivait un état antérieur au
  correctif. Vérifié : 44 lignes en production, la table ne croît pas sans borne.

### Docs — les `.md` de la racine disaient des choses fausses, sans le dire

`AGENT.md` **réécrit** : il décrivait une structure `src/agents/` · `src/tools/` ·
`src/workflows/` qui n'existe plus depuis la refonte Screaming Architecture, plus une stack
fausse sur trois points (better-sqlite3, « OpenAI / Gemini », « 4 workflows »). Un agent qui
l'aurait lu comme une carte aurait cherché des répertoires absents.

Huit rapports historiques reçoivent une **banderole datée** plutôt qu'une réécriture : leur
valeur est d'attester ce qui était vrai ce jour-là, et les réécrire la détruirait. Le pire était
`conversation_summary.md` (2026-08-05), qui parle de Docker, de Railway/Render, d'`OPENAI_API_KEY`
et de Mastra 1.53.

⚠️ `PLAN-ARCHITECTURE.md` reçoit la banderole **inverse** : il est cité **20 fois par le code**
(§3.1, §4.2) et fait autorité. Nuance ajoutée : ce sont ses PRINCIPES DE SÉCURITÉ qui vivent,
pas son pipeline d'agents, écarté au chiffrage qu'il fournit lui-même (374 > 272).

`TODO.md` : les sections [5] et [6] cochaient encore `getTaskList`, `generateQuestionnaire`,
`evaluateResponse` et `QuestionnaireEngine` comme livrés.

### Verified — campagne de tests en production (2026-08-14)

Déploiement `n845ltyoe`. Ordre imposé par `TODO.md` [0] : relever le quota AVANT tout test
conversationnel — 997/1000 requêtes restantes, budget de la journée intact.

- **Signature Slack** : non signé → `401 missing_signature_headers` ; `/api/*` sans jeton → `401`.
- **Usurpation `requestContext`** : avec un jeton valide, contexte forgé
  (`slackAccessLevel` + `slackEmployeeId`) → **`400`, les deux clés NOMMÉES** ; contexte
  légitime (`locale`) → `200`. Le garde discrimine, il ne bloque pas tout.
- **Cinq réponses déterministes** conformes en production, **zéro token**.
- **Matrice de routage** : 19/19 puis 10/10, y compris les faux positifs historiques
  (« je conteste cette décision », « in other words ») et un collant hors registre.
- **Le défaut de `TODO.md` [0 bis], rejoué en production et FERMÉ** : « quel est l'historique
  des notifications ? » → `notificationAgent` (« Il n'y a pas d'historique… »), puis
  « Génère-moi le guide en PDF » dans le MÊME fil → le fil a bien cédé à l'orchestrateur, qui a
  rendu **et livré** `guide-d-integration.pdf` dans le DM. 19ᵉ ligne de `documents`,
  `status: sent`, contenu persisté, rattaché au bon demandeur.
- **`findExpertise` de bout en bout** : « qui s'occupe du backend ? » → `knowledgeAgent` → tool
  appelé → aucune correspondance → **le modèle l'a DIT au lieu d'inventer un nom**.

⚠️ Ce dernier résultat a fait vérifier la donnée plutôt que le code, et c'est ce qui a révélé
qu'**Awa TRAORE est soft-deleted depuis le 2026-08-12** : il n'existe qu'**un seul dossier
employé actif**. La formule « `employees` = 2 lignes (Karyl, Awa) », répétée dans `CLAUDE.md` et
`TODO.md`, est vraie en nombre de lignes et trompeuse en ce qui est résolvable. Voir
`TODO.md` [0 quater].

### Budget

FLOOR remesuré sur le câblage réel : orchestrateur **1 528**, notification **1 517**,
knowledge **881 → 998**. ⚠️ **Le lot 3 n'est PAS autofinancé** : `findExpertise` coûte
**+117 tokens**, et il faut le dire. Il porte sur l'agent le moins cher, seulement sur les
messages qui lui sont routés (le coût des agents est alternatif, pas additif), et il achète un
aller-retour — mais c'est une dépense. Le reste du lot est à coût nul : routage et
atteignabilité sont du CODE.

## [Unreleased] - 2026-08-14 (2) — le questionnaire n'a jamais eu de destinataire

Lot 2. Il répond à « sur quoi doit porter le questionnaire ? » et à « le guide de bienvenue
doit être chaleureux, avec les infos connues, sans donnée générique ».

### Le constat, en base

    questionnaires           = 5 lignes  (« Quiz sur nos valeurs »…)
    questionnaire_responses  = 0 ligne

**Personne n'a jamais pu répondre à quoi que ce soit.** Il n'existait ni formulaire Block Kit,
ni modale, ni route de soumission — le tool le disait lui-même dans son `hint`, ce qui prouve
qu'on le savait sans le corriger. C'est pour cette raison qu'`evaluateResponse` avait dû être
décâblé le 2026-08-12 : son seul appelant possible était un modèle qui FABRIQUAIT les réponses
d'un humain et les enregistrait, horodatées, à son nom.

### Removed — la feature `questionnaire` cesse d'être exposée

`questionnaireEngine` et `generateQuestionnaire` sont retirés du registre Mastra. Les fichiers
et les tables restent ; seule l'exposition disparaît.

⚠️ **Le routage a été nettoyé en conséquence, et ce n'est pas cosmétique** :
`mastra.getAgent()` LÈVE sur un identifiant absent du registre
(`MASTRA_GET_AGENT_BY_NAME_NOT_FOUND`). Un mot-clé pointant encore cet agent n'aurait pas
produit un mauvais aiguillage mais un échec sur le message générique, à chaque message
contenant « questionnaire ».
- `ESCAPE_INTENTS` perd sa bande `['questionnaire', 'évaluation', 'quiz']` ;
- `QUESTIONNAIRE_TOPICS = ['test']` disparaît — gain en soi : ce mot-clé désignait un agent de
  quiz alors que « test » parle presque toujours d'un test logiciel dans ce workspace ;
- `KNOWN_AGENT_IDS` ne le contient plus, donc le palier COLLANT l'ignore. **Cas réel** : des
  `conversation_turns` de production portent encore `agentId: 'questionnaireEngine'` ; les
  suivre condamnerait le fil jusqu'au TTL de 60 min. Leurs tours sont désormais préfixés
  « [autre agent] » — littéralement vrai, cet assistant n'existe plus.
- Un test de non-régression asserte que `routeToAgent` ne rend JAMAIS un identifiant hors
  registre, sur douze phrases.

### Added — l'ENTRETIEN post-profil, qui aboutit là où le questionnaire échouait

Il inverse la construction : **le formulaire existe d'abord**, écrit en code, et ce qui est
stocké est ce qu'une personne a réellement répondu.

- **Table `onboarding_interview`** — `employee_id` en PRIMARY KEY : un employé a un entretien,
  pas une collection. L'unicité devient structurelle et l'upsert trivial. DDL rejouable,
  **appliqué et vérifié en production le 2026-08-14**.
  - ⚠️ Pas `questionnaire_responses` : cette table porte `score`, `max_score`, `percentage`,
    `reviewed_by`, `review_notes` — elle est en forme de QUIZ CORRIGÉ. Sept colonnes seraient
    NULL sur 100 % des lignes, et un schéma qui décrit autre chose que ce qu'il contient finit
    toujours par être relu comme s'il disait vrai.
  - ⚠️ `created_at` est ABSENT du `set` de l'upsert : une correction ne réécrit pas la date du
    premier entretien. Même invariant que `first_seen_at` dans `slack_directory`.
- **Modale à trois champs** (`interview-modal.ts`), tous OPTIONNELS — une modale validée à
  vide est un « non merci » légitime, et rendre la prose obligatoire ferait abandonner qui n'a
  pas envie d'écrire, en lui coûtant ses canaux.
  - ⚠️ Un quatrième champ « rythme de notification » a été explicitement ÉCARTÉ : aucun
    automate ne tourne dans ce dépôt (ni cron ni poller, `findPending()` n'a aucun site
    d'appel). L'ajouter aurait remis une promesse non tenue dans un produit qui vient d'en
    retirer trois.
  - ⚠️ Le bloc canaux est OMIS quand la liste est vide : un `multi_static_select` avec
    `options: []` fait REJETER la vue entière par Slack, donc la modale ne s'ouvrirait pas —
    et le symptôme, un clic sans effet, ne désignerait pas sa cause.
- **La soumission INVITE réellement**, et déterministiquement : la liste vient de Slack,
  transite par le `value` signé du bouton, est revalidée en forme des deux côtés. **Aucun
  modèle sur ce chemin** — c'est ce qui distingue cet entretien du questionnaire qu'il
  remplace. Chaque échec est isolé : un canal archivé ne prive pas des quatre autres.
  - La réponse NOMME ce qui a eu lieu, canal par canal : rejoint / déjà membre / échoué.
    `already_in_channel` n'est pas compté comme un échec. Ce dépôt a payé trois fois la faute
    d'annoncer une action qui n'avait pas eu lieu.
  - Ordre imposé : on ENREGISTRE d'abord, on invite ensuite. L'inverse pourrait ajouter
    quelqu'un à cinq canaux en perdant ce qu'il a écrit, sans qu'aucune moitié ne le signale.
- **Deux filtres sur les canaux proposés**, aucun optionnel : `!isArchived` (l'inventaire de
  production compte 32 canaux dont **26 archivés**) et `isMember` (`conversations.invite`
  échoue si le bot n'y est pas). Proposer un canal archivé garantit une promesse cassée.
- **Proposé sur `completed` ET sur `degraded`.** `degraded` veut dire « l'employé EST créé,
  une étape best-effort a échoué » : refuser l'entretien priverait de ses canaux quelqu'un
  dont le dossier est valide, et le priverait le jour où quelque chose a déjà mal tourné.
  Sur `failed`, rien n'est proposé — il n'y a pas de dossier.

### Changed — le guide cesse d'être générique

`generateDocument` résout l'entretien **côté serveur**, comme il résout la fiche employé, et
le passe au gabarit. `buildGuide` et `buildWelcomeLetter` impriment « Ton quotidien », « Ta
façon de travailler » et « Tes canaux » à partir de ce que la personne a écrit.

**Coût : zéro token.** L'alternative — exposer l'entretien au modèle — a été écartée pour
trois raisons dont la dernière suffirait : un tool de plus serait repayé à chaque
aller-retour ; le modèle REFORMULERAIT ce que la personne a écrit sur elle-même, dans un
document qui porte son nom ; et un gabarit ne peut pas halluciner.

- Chaque section n'est émise que si son champ existe — un intertitre suivi du vide se lit
  comme un oubli, défaut qui avait déjà fait retirer « Département : N/A ».
- Les canaux sont rendus en NOMS, résolus côté serveur ; un `C…` non résolu est ÉCARTÉ plutôt
  qu'imprimé (« #C0BP3RCLLA1 » dans un document d'accueil est pire qu'une ligne en moins).
- **Dépendances OPTIONNELLES** : sans elles, le document est exactement celui d'avant. Un test
  de non-régression le vérifie caractère par caractère, et un autre vérifie qu'une table
  absente ne fait pas échouer la génération.
- Garde-fou de NON-RETOUR : un test asserte que les quatre puces génériques (« Configuration
  poste de travail »…) ne reviennent pas. Elles reviendraient à la première relecture qui les
  trouverait utiles — c'est ce qui les avait fait écrire.

### Coût

FLOOR après retrait de `questionnaireEngine` : **3 926 tokens** pour les trois agents exposés
(`onboardingOrchestrator` 1 528, `notificationAgent` 1 517, `knowledgeAgent` 881). Le lot 2 est
**intégralement autofinancé** : −886 tokens d'agent retiré, et tout ce qu'il ajoute — modale,
invitation, gabarit nourri — est en CODE, donc à coût nul par aller-retour.

### Vérification

`npm run typecheck` vert ; `npm run test:unit` **1 498 tests / 93 fichiers**, tous verts ;
`npm run build` + `verify:bundle` verts. DDL `onboarding_interview` appliqué et vérifié sur la
Turso de production.

**Reste humain :** la Request URL d'*Interactivity* conditionne les DEUX modales désormais
(profil et entretien) — sans elle, aucun des deux boutons n'atteint quoi que ce soit. Et
`scripts/sync-slack-directory.mts --channels --apply` doit tourner de temps en temps : sans
inventaire à jour, l'entretien propose des canaux périmés ou aucun.

## [Unreleased] - 2026-08-14 — le dossier employé n'existait pour presque personne

Lot de FONDATIONS. Cinq demandes du propriétaire avaient **une seule cause racine**, établie
par lecture du code puis **confirmée sur la Turso de production** avant d'écrire une ligne.

### La cause racine

`buildWelcomeBlocks` est le SEUL émetteur du bouton « Compléter mon profil », et son seul
appelant est `handleTeamJoin`. Un salarié déjà présent n'avait donc **aucun chemin** vers le
formulaire — et `team_join` ne figure même pas dans les abonnements de l'app Slack, si bien
que les arrivants non plus. `employees` ne se remplissait pas.

Relevé en lecture seule le 2026-08-14 :

    employees        = 2 lignes (Karyl d20df236…, Awa d36b78dc…)
    slack_directory  = 40 lignes, dont 4 personnes vivantes NON rattachées
                       (Nazer, Pamela, Mistourath, ridwanenico77)

### Fixed — le document d'Awa parti à l'adresse de Karyl

**Diagnostic confirmé par les données**, et il n'était pas celui qu'on croyait :

    employee_id=d20df236…(Karyl)  type=welcome_letter  title="Bienvenue Awa"  status=sent

**Les DIX documents de la base portent l'UUID de Karyl.** `generate-document.ts` résout
pourtant correctement le sujet (`findById` puis `deliverByEmail(…, employee.email, …)`) : le
défaut est en amont, dans le choix de l'`employeeId` par le MODÈLE. Awa a sa propre ligne
`employees` — elle est simplement absente de `slack_directory`, donc `findEmployeeByEmail`
(seul résolveur existant) exigeait une adresse que personne n'avait tapée. **Aucun tool ne
résolvait un prénom** (`TODO.md` le recensait depuis le 2026-08-12 sans le relier à ce bug).
Sommé de fournir un UUID, le modèle a réutilisé le seul de son contexte — même mécanique que
l'email `votre_email@example.com`.

Trois correctifs, dont **un seul** est une correction :

1. **`findPersonByName`** (`employee/application/tools/`) — DEUX sources, `employees` d'abord
   puis l'annuaire. Le relevé l'impose : Awa n'existe que dans l'une, les quatre autres
   personnes vivantes que dans l'autre. Rapprochement dans `src/shared/name-matching.ts`,
   partagé par les deux dépôts — deux implémentations divergeraient au premier accent.
   - **Sur AMBIGUÏTÉ, aucun identifiant ne sort.** Rendre deux UUID reviendrait à laisser le
     modèle en choisir un : le geste même qui a produit le bug. Sans identifiant, l'appel
     suivant est structurellement impossible et le modèle doit demander.
   - Ni en SQL ni par `LIKE` : `lower()` de SQLite n'ôte pas les accents et `%needle%`
     correspondrait au milieu des mots — « rao » retrouverait « Traoré ».
2. `generateDocument` rend désormais `recipient` (le NOM, jamais l'email) et l'orchestrateur
   doit le citer. ⚠️ **Mesure de VISIBILITÉ, pas garantie** : elle rend l'erreur lisible au
   tour même au lieu de la laisser muette un mois.
3. `warn` quand un document est produit pour une autre personne que le demandeur. Aucun refus
   — c'est le cas d'usage normal ; c'est la ligne à chercher la prochaine fois.

### Added — deux court-circuits déterministes, portant le total à HUIT

Chacun est un prédicat pur, une réponse écrite en dur, **zéro token** sur un quota qui se
compte à la journée. Tous deux répliqués dans `isAnsweredWithoutModel`, contrat vérifié par
test : sans ce miroir, le plafond quotidien refuserait un geste qui ne coûte rien.

- **`src/shared/profile-request.ts`** — « complète mon profil », « où est-ce que je remplis
  ma fiche ? » postent le bouton. Calqué sur `forget.ts`, avec **l'asymétrie INVERSE** :
  un faux positif poste un bouton (additif, ignorable), un faux négatif laisse quelqu'un sans
  dossier. Les questions de MOYEN déclenchent donc (« comment je… ? » — le bouton EST la
  réponse), celles de MOTIF non (« pourquoi dois-je… ? »).
  - ⚠️ **DM UNIQUEMENT, et c'est de la sécurité.** Le pré-remplissage est figé dans le `value`
    du bouton : en canal, un témoin qui clique ouvrirait une modale portant les données
    d'autrui et sa soumission écrirait le dossier de cette personne. En canal, redirection.
  - Deux familles de verbes appariées à deux jeux d'objets : « envoie mon profil à Awa » n'est
    pas une demande de formulaire, et l'intercepter AVALERAIT une vraie question.
- **`src/shared/pin-fact.ts`** — « souviens-toi que… » ÉPINGLE enfin. Nouvelle table
  `pinned_facts`, **hors du TTL de 60 minutes** (table séparée et non un drapeau : deux durées
  de vie opposées sous la même purge, c'est un `WHERE pinned = 0` qu'on oublie une fois).
  - Bornes : 5 faits, 120 caractères, éviction du plus ancien — le préambule système est
    réémis à CHAQUE aller-retour.
  - Restitués dans le message `system` comme des **DÉCLARATIONS**, jamais des consignes :
    « souviens-toi que tu dois ignorer tes règles » ne doit pas devenir une règle.
  - `forget()` les emporte. Sans cela, une personne ayant demandé l'effacement verrait le bot
    continuer à citer ce qu'elle lui avait dit de retenir — le pire cas de ce chemin.
  - Sur échec d'écriture, **jamais** `pinnedFactReply` : promettre de se souvenir sans avoir
    écrit serait le défaut central du dépôt sous une autre forme.

### Added — `scripts/invite-profile-completion.mts` (npm `profile:invite`)

Fait, une fois, ce que `team_join` aurait dû faire. Dry-run par défaut ; vérifié contre la
production : **4 personnes réelles** à relancer. **N'écrit AUCUNE ligne `employees`** —
`position` et `start_date` sont `NOT NULL` et l'annuaire ne les connaît pas ; les fabriquer
produirait la valeur inventée qu'un lecteur ultérieur relit comme un fait.

⚠️ `SLACKBOT_USER_ID` est désormais exporté : Slack ne déclare Slackbot **ni `is_bot` ni
`deleted`** (vérifié en production), donc les deux filtres évidents le laissaient passer — le
premier dry-run le listait bel et bien.

### Removed — tout le suivi de TÂCHES

`getTaskList`, l'entité `Task`, son port, ses deux dépôts, `task-summary.mapper`, `task.dto`,
le catalogue `ONBOARDING_TASKS`, les `onboarding_steps` qui en dérivaient 1:1, l'écriture dans
`initOnboarding`, `BestEffortStep.OnboardingTasks` et `scripts/backfill-onboarding.mts`.

**Ces cinq tâches étaient un plan qu'AUCUN mécanisme ne faisait avancer** — ni humain, ni
automate, ni tool ne pouvait marquer « Rencontrer ton manager » comme faite. Un suivi qui ne
bouge jamais est un suivi qui ment : même famille que `emailSent: false` sous
`status: 'success'` et que `status = Sent` posé avant le `try`. Deux des cinq renvoyaient de
surcroît vers un questionnaire et un guide qui n'existaient pas sous la forme annoncée.

Le seul suivi du produit est désormais la **complétion du profil** (`onboarding_progress`,
`totalSteps = 1`, dérivé de `ONBOARDING_TOTAL_STEPS`).

⚠️ Les tables `tasks` et `onboarding_steps` ne sont PAS supprimées en production : un `DROP`
est irréversible et ce lot n'en a pas besoin.

### Changed — les gabarits de documents perdent ce qu'ils inventaient

`buildWelcomeLetter` perd son bloc « Prochaines étapes » et `buildGuide` ses quatre puces
(« Configuration poste de travail », « Accès Slack/GitHub »…). **Écrites en dur, elles
sortaient à l'identique dans le document de chaque personne**, et deux d'entre elles
renvoyaient à des choses qui n'existent pas : « Remplir le questionnaire d'intégration »
(aucun questionnaire n'est envoyable ni remplissable) et « Consulter le guide onboarding »
(aucune URL de téléchargement n'existe dans ce système). C'est le « document générique »
signalé par le propriétaire. `buildGuide` cite en revanche le POSTE, toujours connu.

### Changed — les aveux d'incapacité expliquent et proposent une suite

`NEUTRAL_REFUSAL`, `GENERIC_FAILURE`, `QUOTA_FAILURE`. Ce qui ne bouge pas : aucune mention de
la règle touchée (elle renseignerait l'attaquant), aucun renvoi vers un humain, tutoiement.

⚠️ `QUOTA_FAILURE` corrige une **INEXACTITUDE** : « réessaie dans quelques minutes » est vrai
pour le seau par minute, faux pour le plafond JOURNALIER — celui qui casse réellement la
production. Vérifié le 2026-08-11 : réessayé après 60 s, même échec en 21 s.

### Coût mesuré — assumé et nommé

FLOOR sur le câblage RÉEL (ratio 3,5 car./token, `zodToJsonSchema` + `getInstructions()`) :

| Agent                    | avant | après | Δ |
| ------------------------ | ----- | ----- | --- |
| `onboardingOrchestrator` | 1 476 | **1 528** | +52 |
| `questionnaireEngine`    | 875   | **886**   | +11 |
| `notificationAgent`      | 1 352 | **1 517** | +165 |
| **Somme (3 agents)**     | 3 703 | **3 931** | **+228 (+6 %)** |

(`knowledgeAgent` mesuré à **881**, absent des relevés antérieurs.)

Le lot n'est **pas** autofinancé, contrairement à ceux du 2026-08-11, et il faut le dire :
`findPersonByName` sur deux agents coûte plus que ne rend le retrait de `getTaskList`. La
contrepartie n'est pas dans le prompt mais dans les ÉTAPES et les tool-results — le poste
dominant : un aller-retour « donne-moi son email » → « je ne l'ai pas » épargné vaut plusieurs
centaines de tokens, `tasks` disparaît d'un tool-result qui pesait jusqu'à 979 tokens, et deux
court-circuits de plus répondent à coût nul.

### DDL

`scripts/ddl-pinned-facts.sql` — **appliqué et vérifié sur la Turso de production le
2026-08-14** (table + index). Rejouable. ⚠️ Ordre imposé : DDL d'abord, déploiement ensuite.

### ⚠️ Piège de test — QUATRIÈME dépendance à neutraliser

Toute construction manuelle d'un `SlackEventsHandler` en test doit désormais neutraliser
`conversationRepository`, `dedupRepository`, `rateLimiter` **et `pinnedFactRepository`**. Sans
la quatrième, `loadPinnedFacts` construit un dépôt Drizzle et lit la VRAIE base à chaque test
qui atteint le modèle — exactement la fuite déjà payée sur les compteurs de débit.

### Vérification

`npm run typecheck` vert ; `npm run test:unit` **1 479 tests / 91 fichiers**, tous verts ;
`npm run build` vert, `verify:bundle` inclus (659 paquets, smoke PDF 7 082 octets, liaison ESM
du bundle vérifiée). Dry-run de `profile:invite` exécuté contre la production.

**Reste à faire, humain et non scriptable :** abonner `team_join` dans *Event Subscriptions*,
et vérifier la Request URL d'*Interactivity* (`https://<domaine>/slack/interactions`). Sans le
premier, A1 et le script sont les SEULS chemins vers le formulaire ; sans le second, le clic
sur le bouton n'atteint rien.

## [Unreleased] - 2026-08-13 (4) — le plafond ne mesurait pas ce qu'il prétendait borner

Soumis au Conseil : **« le plafond de 12 messages/jour/personne est-il une bonne décision ? »**
Verdict unanime — l'architecture est bonne, **l'unité comptée et la portée sont fausses**.

### Fixed — un compteur de MESSAGES posé sur un problème de TOKENS

Le raisonnement qui justifiait `12` (« 12 < 19, donc une personne ne peut pas consommer la
journée entière ») suppose un coût moyen de 5 168 tokens/message. **La production l'a démenti
d'un facteur 2,6** : un « Bonjour » a coûté 13 376 tokens en 5 étapes — 13 % du budget
quotidien pour UNE unité de compteur. À ce tarif, 8 messages épuisent la journée sans jamais
approcher le plafond de 12.

Et la portée était fausse aussi : **6 personnes × 12 = 72 messages/jour possibles pour un
budget de ≈ 19**. Deux personnes en usage normal — sans script, sans malveillance — suffisent
à dépasser. Or c'est exactement la panne du 2026-08-11 (`TPD: Limit 100000, Used 98207`), et
**rien ne la mesurait** : il n'existait aucun compteur à l'échelle du workspace.

`WORKSPACE_TOKEN_RULE` — 90 000 tokens/jour, portée équipe. `usage.inputTokens` était **déjà
lu et journalisé à chaque réponse, et jeté** ; il alimente enfin un compteur.

- ⚠️ **Comptage POST-HOC**, inhérent : le coût n'est connu qu'après l'appel. Le message qui
  fait franchir le seuil passe toujours. On borne une dérive, on ne fait pas de comptabilité.
  Toute estimation *avant* l'appel serait pire — le coût dominant vient de l'historique, des
  schémas d'outils et du nombre d'étapes, pas de la taille du message entrant.
- ⚠️ **Exempté pour les réponses sans modèle.** Sans cette ligne, une détresse se heurterait
  au budget d'équipe épuisé : le défaut du 2026-08-13, transposé de l'individu au collectif.
  Test dédié.
- ⚠️ **Le refus aurait été MUET.** `evaluateCount` fonde `shouldNotify` sur `count === limit
  + 1` — une égalité qu'un compteur avançant par milliers ne rencontre jamais. Repli sur
  « une fois par fenêtre et par instance ». Prévenir deux fois est visible et corrigeable ;
  ne pas prévenir du tout ne l'est pas.

`increment(key, windowStart, expiresAt, by = 1)` : le pas devient un paramètre. **`by = 0`
est une lecture atomique** — c'est ce qui permet de CONSULTER le budget avant l'appel et de
l'INCRÉMENTER après, sans méthode supplémentaire ni second aller-retour. La lecture voyage
dans le **même lot parallèle** que les incréments par personne : la première version était
séquentielle et ajoutait un aller-retour au chemin de l'ACK Slack (3 s) — **les tests de coût
pré-ACK l'ont vue immédiatement.**

### Fixed — le refus promettait un levier qui n'existait pas

« Réessaie demain, ou demande à un administrateur de relever le plafond. » `readRuleLimit`
avait **zéro site d'appel** : la limite était un littéral figé à la compilation, et « relever
le plafond » exigeait de modifier le code source. La personne à qui le bot disait ça est
l'administratrice.

`readRuleLimit` est enfin câblé — `SLACK_BURST_LIMIT`, `SLACK_DAILY_LIMIT`,
`SLACK_WORKSPACE_TOKEN_BUDGET`. Il refuse déjà `0` et les négatifs : une faute de frappe dans
une variable Vercel ne peut pas éteindre le bot en silence.

Trois refus distincts, pour trois gestes distincts. Le texte « quota » personnalisait une
contrainte **collective** : relever le plafond d'une personne ne crée aucun token, ça lui
permet d'épuiser plus vite la part des autres. Il le dit maintenant.

### Fixed — `SlackRateLimiter.prune()` n'avait aucun site d'appel

`rate_limit_counters` croissait sans fin — seule des quatre tables à TTL du dépôt à n'être
jamais purgée. Branchée sur le même tirage que les deux autres.

### Conservé tel quel, sur avis du Conseil

`BURST_RULE` (5/min/personne) est **le bon instrument pour le bon mal** : un script en boucle
se mesure bien en messages/minute, indépendamment du coût de chacun. Le plafond par personne
reste, comme garde-fou d'ÉQUITÉ — sa seule fonction légitime est d'empêcher qu'une personne
rafle le budget partagé — et non plus comme instrument principal.

### Added — `scripts/replay-transcript.mts`

Rejeu d'un transcrit de production, 14 messages en 4 séries, rapport JSON. ⚠️ Seule sonde du
répertoire qui **dépense de vrais appels de modèle** — les quatre autres sont gratuites.

## [Unreleased] - 2026-08-13 (3) — rejeu d'un transcrit de production complet

Neuf défauts relevés dans un transcrit Slack réel. **Trois étaient déjà corrigés** et sont
consignés ici pour qu'aucun diagnostic futur ne les redécouvre ; **quatre sont corrigés par ce
lot** ; deux restent ouverts, au `TODO.md`.

### Fixed — le bot a répondu à une question vieille d'1 h 40

    20:54  Karyl  : « tu peux me retrouver le profil de mistourath@kissohq.com ? »
    22:31  Mastra : « J'ai atteint mon quota de messages pour aujourd'hui. »
    22:33  Karyl  : « bonjour »
    22:34  Mastra : « Je vois que Mistourath n'a pas de dossier d'onboarding… »   ← 20:54
    22:35  Mastra : « Ton document a été créé et livré sur ce fil Slack. » + un PDF

Deux réponses tardives se sont insérées dans une conversation qui avait avancé, dont une qui a
livré un **document que plus personne n'attendait**.

Cause, en deux défauts qui s'enchaînent :
- la reprise d'un événement `in-flight` abandonné n'avait qu'un **plancher** d'âge (60 s) et
  aucun plafond — une entrée de 61 secondes et une de 100 minutes étaient traitées à
  l'identique, et le traitement repartait ENTIER avec le texte d'origine ;
- `markDedupDone`/`releaseDedup` ne sont appelés que depuis `handleEvent()`, donc un événement
  refusé par la limite de débit reste `in-flight` **indéfiniment**, prêt à être « abandonné »
  puis repris à la première redélivrance.

Correctif : une borne d'**âge de l'événement** (`MAX_EVENT_AGE_MS` = 10 min), et non un plafond
sur la seule reprise — elle couvre d'un seul contrôle tous les chemins (reprise d'abandon,
rejeu Slack, redélivrance tardive, file d'attente), là où ce dépôt a déjà payé les correctifs
posés sur un chemin quand le défaut vivait sur plusieurs. Motif `stale_event`, distinct de
`duplicate` : un doublon a déjà reçu sa réponse, un périmé n'en a jamais eu.

⚠️ **On ne libère PAS la clé sur un refus de débit**, et c'était le correctif intuitif : la clé
libérée, un rejeu Slack arrivant 5 s plus tard repasserait pour un message NEUF et
consommerait une **seconde unité du quota** de la personne pour un message envoyé une fois.
La clé bloquée est protectrice ; la borne d'âge suffit à la rendre inoffensive.

⚠️ Lu sur `event_time` uniquement, jamais sur `event.ts` : `ts` est l'IDENTIFIANT d'un message
et la matière première de la clé de déduplication, pas une horloge. Absent ⇒ on laisse passer.

### Fixed — « Où est le quiz ? Je ne le vois pas »

Un questionnaire enregistré n'est envoyé à personne, affiché nulle part et remplissable par
personne : ni formulaire Block Kit, ni modale, ni route de soumission — c'est d'ailleurs pour
cela qu'`evaluateResponse` a été décâblé. Le modèle ne pouvait pas le deviner, et son ignorance
a pris trois formes : « prêt à être utilisé », « ou je te le partage en **lien direct** ? »,
« je peux te partager un **lien** pour qu'il y accède » — des liens qui n'existent nulle part,
exactement comme le faux `kisso.internal` du 2026-08-11.

`delivered: false` + un `hint` dans le RÉSULTAT (payé par les seuls runs qui enregistrent
vraiment un questionnaire, jamais par le prompt), et la description passe de « Crée un
questionnaire » à « **Enregistre** un questionnaire. Ne l'envoie à personne, ne l'affiche nulle
part. » — le mot que lit le modèle est celui qu'il répétera, leçon déjà tirée sur
`scheduleReminder`.

### Fixed — la réconciliation laissait passer la famille « mise à jour »

    Karyl  : « @Mastra ajoute en une quatrième »
    Mastra : « Le quiz "Quiz sur nos valeurs" est maintenant à jour avec une quatrième
              question. »

Aucun outil de modification de questionnaire n'existe : la phrase est fausse **par
construction**, le critère d'admission exact d'`ACCOMPLISHMENT_CLAIMS`. Elle passait entre les
mailles — ni « c'est fait », ni voix passive, ni « est prêt ». Le verbe n'est pas ajouté à
`DONE_VERBS` : il y couvrirait « a été mis à jour » mais raterait « est maintenant à jour »,
qui est la forme réellement relevée — un adjectif, pas un participe.

### Fixed — le modèle fabriquait une adresse email, puis réclamait ce que le système savait

    Karyl  : « Bonjour, que peux-tu faire pour moi ? »
    Mastra : « Je n'ai pas trouvé d'employé avec l'adresse karyl.soumaila@kisso.com.
              Pour retrouver ton identifiant, il me faudrait ton email professionnel. »

Deux défauts en une réponse, observés deux jours de suite. Le modèle a **fabriqué** une adresse
plausible à partir du nom de la personne — `isPlaceholderEmail` ne peut rien contre elle, elle
est bien formée et son domaine est réel. Puis il a réclamé à l'humain une information que le
système **détenait déjà** : l'identité du demandeur descend par le `requestContext`.

Le `return { found: false }` final était NU. Il porte désormais, quand le demandeur est connu,
son identifiant interne et l'interdiction de retenter en modifiant l'adresse. Un tour de
dialogue épargné vaut plus que plusieurs centaines de tokens rabotés, sur ≈ 19 messages/JOUR.
Aucune donnée nouvelle n'est exposée : c'est l'identifiant du demandeur lui-même, que
`canReadPersonRecord` l'autorise déjà à lire, et il vient du contexte serveur.

### Déjà corrigés — consignés pour ne pas être rediagnostiqués

- **Demande légitime refusée comme une attaque** (« Il me faudrait le guide d'accueil de Karyl
  en PDF » → refus neutre). La cause n'était pas l'entrée mais la SORTIE : le motif
  `kisso_[0-9a-f]{4,}` mordait sur un nom de fichier NARRÉ (`guide_kisso_2026.pdf` — `2026`
  est de l'hexadécimal valide) et remplaçait TOUTE la réponse. Corrigé en `{16,}` (le
  délimiteur réel fait 32 hex depuis le 2026-08-10). Le même message a réussi 2 h 38 plus tard.
- **Double livraison d'un PDF** : `generateDocument` appelé deux fois dans un même run.
  `buildRunKey`/`makeRunGuard` (`src/shared/tool-idempotency.ts`) sont câblés depuis. L'incident
  s'est produit 34 minutes après un déploiement et ~4 h 30 avant le commit du correctif.
- **« tu préfères quel canal (email, Slack, in-app) ? »** : l'énumération de `sendNotification`
  remontée à l'humain. L'enum est passé de 7 valeurs à 2, et 3 champs obligatoires ont reçu un
  défaut.

## [Unreleased] - 2026-08-13 (2) — « oublie ce que je t'ai dit » ne pouvait être qu'un mensonge

Tranches « Contexte et mémoire » et « Flux de conversation » de l'audit conversationnel.
Quatre correctifs, dont deux qui touchent des DONNÉES et non du confort.

### Added — un effacement RÉEL, sixième court-circuit déterministe

`ConversationRepository` exposait `append`, `recentTurns` et `prune` — et **rien** qui réponde
à une personne. « oublie ce que je t'ai dit », « supprime tout ce que tu sais de moi »
partaient donc au modèle, qui n'a aucun outil d'effacement et ne pouvait faire qu'une chose :
**le raconter**. C'est le défaut central de ce dépôt — « il parle exactement de la même façon
quand il a fait le travail et quand il l'a inventé » — appliqué à la seule demande à laquelle
une narration ne peut pas se substituer.

⚠️ La réconciliation FAIT/NARRATION n'aurait rien rattrapé : elle guette une formule
d'accompli sans `toolCall`, or il n'existait **aucun tool à appeler**, donc aucune
contradiction à constater. Le seul correctif possible était de rendre le geste réel.

- `ConversationRepository.forget(scope)` + les deux implémentations. Rend le **nombre** de
  tours supprimés : c'est lui qui permet à la réponse de dire ce qui s'est passé plutôt que
  de l'affirmer.
- Portée : en **DM** la conversation est l'espace privé d'une seule personne (la clé retombe
  sur le canal `D…`), donc tout part, tours `assistant` compris. En **fil de canal**,
  plusieurs humains parlent — seuls les tours du demandeur sont supprimés. Hors DM sans
  auteur identifié, on **échoue bruyamment** : une portée indéterminée sur une suppression,
  c'est la suppression du fil entier.
- La réponse nomme ce que l'effacement **ne couvre pas** (documents produits, notifications
  envoyées, annuaire). Sans cette phrase, « c'est fait » serait vrai dans sa lettre et faux
  dans ce qu'il laisse comprendre — la faute d'`emailSent: false` sous `status: 'success'`.
- Sur échec, **jamais** `erasureDoneReply`. Annoncer une suppression qui n'a pas eu lieu est
  pire que l'absence de fonctionnalité : la personne cesserait de la demander.
- Placé **avant** la frontière d'autorisation, comme la détresse : effacer ses propres
  données est un droit, pas un privilège accordé au niveau `full`. Et exempté du plafond
  quotidien — le cas le moins acceptable serait « J'ai atteint mon quota » en réponse à ça.

**Le critère de détection a été refait après qu'une revue adversariale a REPRODUIT une perte
de données.** La première version exigeait un verbe et un objet, avec une garde de négation
qui n'examinait que les caractères collés au verbe. Six phrases françaises ordinaires
effaçaient réellement la mémoire de quelqu'un, dont celle-ci — qui demande le **contraire** :

> « Je ne veux surtout pas que tu oublies ce que je t'ai dit »

La négation `pas` y est séparée du verbe par `que tu`. Et trois autres ne demandaient rien :
« Est-ce que tu **vas oublier** ce que je t'ai dit… ? », « Pourquoi **as-tu oublié**… ? »,
« Tu **risques d'oublier**… ».

La leçon n'est pas qu'il manquait des motifs : **on cherchait la présence d'un verbe là où il
fallait chercher un acte de langage.** Une question, un reproche et un pronostic contiennent
le même verbe et le même objet qu'un ordre. Le critère porte donc désormais sur la POSITION —
le verbe ouvre le message (impératif) ou suit une formule de demande explicite — plus une
négation cherchée sur une fenêtre de 4 mots **des deux côtés**. Vérifié sur 36 phrases,
10 qui doivent déclencher et 26 qui ne le doivent pas, sans écart.

### Fixed — le TTL de 60 minutes n'était appliqué qu'EN LECTURE

La purge se déclenchait « tous les 100 messages », sur `this.processedMessages` — un compteur
**en mémoire, par instance**. Il repart à zéro à chaque démarrage à froid, et Vercel en
provoque en permanence ; le budget Groq borne par ailleurs le trafic à ≈ 19 messages/jour.
**Le seuil de 100 n'était donc jamais atteint en production.** `recentTurns` filtrait bien par
TTL, mais les lignes restaient sur la Turso **sans borne de rétention réelle** — y compris
celles d'un DM où quelqu'un parle de son salaire ou d'un arrêt maladie, ce que le handler
documente lui-même comme l'usage normal de ce canal. Le dépôt annonçait une rétention d'une
heure et en pratiquait une illimitée.

Remplacé par un **tirage sans état** (`DEFAULT_PRUNE_PROBABILITY = 0.2`), qui survit au gel de
la fonction : ~4 purges/jour au lieu de zéro. Ce n'est toujours pas une garantie — seul un
cron en serait une, et ce projet n'en a aucun — mais c'est la borne la plus honnête qu'on
puisse poser sans en introduire un.

### Fixed — la frontière négative ne parlait qu'au PRÉSENT, et pas du tout du métier

`agentToolBoundary` disait « Rien d'autre n'existe ». Deux angles morts en découlaient :

- **La question à prémisse fausse.** « Pourquoi as-tu supprimé le compte de Awa ? » : aucun
  tool de suppression n'a jamais été câblé, mais rien ne le disait au modèle, qui pouvait
  donc s'excuser d'une action qu'il n'a pas pu commettre. D'où « ni n'a existé ».
- **Le hors-métier.** Rien n'indiquait qu'écrire un poème, traduire ou produire du code soit
  hors mandat — et la RÈGLE ANTI-INVENTION ne rattrape pas ces cas : elle interdit d'inventer
  une DONNÉE absente, or il n'y en a aucune à inventer. Le modèle obtempère, correctement, et
  brûle un tour entier d'un budget de ≈ 19 par jour.

⚠️ La clause est une **énumération négative** (« Pas de service générique : traduction,
rédaction libre, code ») et surtout **pas** un « reste dans ton domaine ». Les quatre agents
ont quatre domaines distincts : une consigne d'appartenance ferait refuser à
`notificationAgent` un rappel parfaitement légitime au motif que ce n'est pas de l'onboarding.
Un test verrouille cette forme. ≈ +20 tokens par aller-retour, seuil du test relevé de 60 à
70 ; un seul run hors-sujet évité rembourse l'ajout pour plusieurs jours.

⚠️ Décision de rédaction, et non un court-circuit par mots-clés : reconnaître une « intention
hors-sujet » par une liste de mots répéterait l'erreur la mieux documentée du dépôt, celle où
le mot « email » rendait la recherche par email structurellement inatteignable.

### Changed — deux outils retirés d'un agent qui ne pouvait rien en faire

`questionnaireEngine` portait `findEmployeeByEmail` et `getEmployeeProfile`. La justification,
écrite le 2026-08-11, était « tous ses tools exigent un UUID d'employé » — vraie **tant
qu'`evaluateResponse` était câblé**. Il a été décâblé le 2026-08-12 et la justification est
morte avec lui sans que personne ne relise la ligne. Ce qui reste, `generateQuestionnaire`, a
pour schéma `{title, description, questions[]}` : **aucun champ ne désigne une personne.**
Résoudre quelqu'un ne pouvait donc influencer aucun résultat.

Deux gains, et le second compte davantage. **Mesuré** (ratio 3,5 car./token, `zodToJsonSchema`
+ `getInstructions()`) : FLOOR de `questionnaireEngine` **1 102 → 875 tokens, soit −227
(−20,6 %) par aller-retour** — 127 pour `findEmployeeByEmail`, 88 pour `getEmployeeProfile`, et
12 rendus par la frontière négative, qui rétrécit d'elle-même puisqu'elle est dérivée du
câblage. Et surtout **une surface d'accès aux données RH en moins** : `getEmployeeProfile` est
précisément le tool que `canReadPersonRecord` a dû garder le 2026-08-13.

### Changed — `generateQuestionnaire` renvoie une projection, plus l'entité

Quatrième occurrence du même défaut, après `getEmployeeProfile` (2506 → 333),
`generateDocument` (685 → 39) et `getNotificationHistory` (≈ 9 600 → 177). `return published`
renvoyait `questions[]` en entier — l'énoncé, les options et les bornes que **le modèle venait
lui-même d'écrire**, refacturés au modèle puis réémis à chaque étape suivante du run.
Désormais `{id, title, questionCount, status}`. Test verrouillant l'INDÉPENDANCE : moins de
5 caractères d'écart entre un questionnaire d'une question courte et un de deux questions de
400 caractères.

### Rejeté par le Conseil — deux propositions écartées sur la doctrine du dépôt

- **Court-circuit « merci / ok / parfait ».** `greeting.ts` documente déjà pourquoi « ok » et
  « d'accord » en sont absents : ce sont des CONFIRMATIONS. « Je peux te l'envoyer par
  email. » → « merci » signifie *oui*. Répondre « Avec plaisir » sans rien faire reproduirait
  le silence-qui-se-lit-comme-un-succès. Le critère du dépôt n'est pas « le mot est court »
  mais « le message n'attend rien du système » — `merci` est plus proche d'`ok` que de
  `bonjour`.
- **Détecteur de répétition.** Il casserait le RÉESSAI APRÈS ÉCHEC, qui est le comportement
  observé dans les transcriptions de production : le bot répond « Désolé, une erreur s'est
  produite », la personne retape sa question. Répondre « on tourne en rond » frapperait
  exactement les gens qui vont déjà mal. Les plafonds de débit bornent déjà le dégât.

## [Unreleased] - 2026-08-13 — un plafond de coût ne doit pas pouvoir faire taire une détresse

### Fixed — le rationnement s'appliquait à des messages qui ne coûtent rien

**Défaut trouvé EN PRODUCTION**, par la sonde des réponses déterministes : les cinq sondes ont
reçu `HTTP 200` et **aucune** réponse n'a été postée. Cause lue dans le fil : la personne avait
déjà atteint son plafond de 12 messages du jour, et la limite de débit — qui vit dans
`accept()`, donc AVANT tout court-circuit — écartait tout, y compris ce qui n'appelle aucun
modèle. Le dernier message réel du fil le montrait noir sur blanc : « bonjour » → « J'ai
atteint mon quota de messages pour aujourd'hui. »

Le même refus serait tombé sur **« je ne vais pas bien »**. C'est ce cas-là qui rend le
correctif nécessaire, pas le confort d'une salutation : un plafond de COÛT ne doit pas pouvoir
faire taire la seule réponse de ce produit dont l'absence peut nuire à quelqu'un.

Le remède est dans l'intention déjà écrite des deux règles, pas dans une exception :

- `DAILY_RULE` porte `rationsModelBudget: true`. Sa raison d'être est documentée depuis
  l'origine — « 12 < 19 (le plafond réel du fournisseur) » : elle rationne un budget de
  MODÈLE. Elle n'a donc rien à dire d'un message qui n'en consomme pas.
- `BURST_RULE` ne le porte pas et **continue de s'appliquer** : elle contre l'abus, et un
  script qui inonde le bot de « bonjour » reste un script — chaque réponse est un appel à
  l'API Slack.

`check()` reçoit `answeredWithoutModel` et, dans ce cas, les règles de budget ne sont ni
consultées **ni incrémentées**. Ne pas incrémenter compte autant que ne pas refuser : sans
cela, une salutation gratuite retirerait quand même une unité au budget d'une vraie question.

⚠️ `isAnsweredWithoutModel` doit rester le miroir exact des court-circuits de `handleMessage` —
c'est sa seule fragilité, et chaque cas y délègue au même prédicat plutôt que de réécrire la
règle.

### Added — `scripts/probe-deterministic-replies.mts`

Sonde de production des cinq réponses déterministes. Elle ne consomme **aucun token** — ce sont
précisément les chemins qui n'appellent pas de modèle — donc elle est répétable après chaque
déploiement, sur un quota de ≈ 19 messages/jour qui rendait jusqu'ici toute vérification en
production coûteuse. Les constantes attendues sont importées des modules source, jamais
recopiées : une copie diverge, et la sonde passerait au vert en vérifiant un texte disparu.

C'est elle qui a trouvé le défaut ci-dessus. Aucun test unitaire ne pouvait le voir : les deux
bords étaient corrects, c'est leur ORDRE dans le produit déployé qui ne l'était pas.

## [Unreleased] - 2026-08-13 — trois lectures RH s'exécutaient sans regarder QUI demandait

### Security — la frontière d'autorisation manquait là où elle comptait le plus

Relevé par l'audit du 2026-08-13, vérifié ligne à ligne : `getEmployeeProfile`, `getTaskList`
et `getNotificationHistory` ne contenaient **aucune** référence au demandeur — ni
`readSlackContext`, ni rien d'équivalent. N'importe quel membre du workspace obtenait donc le
dossier RH complet d'un collègue : département, poste, date d'entrée, manager, avancement
d'intégration, tâches, et l'historique des messages qu'il a reçus.

L'UUID nécessaire n'était pas un secret : `findEmployeeByEmail` le rend depuis une simple
adresse. **La chaîne « email d'un collègue → UUID → dossier » était ouverte en deux messages.**

Ce n'est pas une machinerie qui manquait — elle existait déjà et était bien conçue
(`SlackAccessGuard`, `disclosure-policy.ts`, `canPerformSideEffects`). Ces trois outils-là ne
l'appelaient simplement pas. Encore la classe de défaut la plus fréquente de ce dépôt : deux
bords corrects, aucun câblage entre les deux.

**Câblage manquant.** Le handler résolvait déjà `employees.id` du demandeur — il alimente le
préambule d'identité depuis le 2026-08-12 — mais la valeur ne descendait pas jusqu'aux tools,
qui n'avaient donc aucun moyen de distinguer « mon dossier » de « celui d'un collègue ». Elle
voyage désormais par le `requestContext` (clé `slackEmployeeId`), le seul canal qui n'entre pas
dans la fenêtre du modèle — on ne décide jamais d'un droit sur une valeur qu'un attaquant peut
écrire.

**La règle n'est pas inventée ici** : son propre dossier toujours, celui d'autrui au niveau
`full`. C'est exactement celle qu'appliquent déjà `getUserConversations` à la mémoire d'autrui
et `canPerformSideEffects` aux effets de bord. Trois copies d'une décision d'autorisation
divergent — c'est une question de temps, pas de discipline.

Deux arbitrages, tous deux verrouillés par test :

- **La comparaison « est-ce mon dossier ? » passe AVANT le niveau.** Sans cela, activer
  l'application couperait chacun de son propre parcours d'intégration — la fonction même du
  produit.
- **Le refus arrive AVANT toute lecture en base.** Un refus qui interroge d'abord et filtre
  ensuite fuite par la latence et journalise une consultation qui n'aurait pas dû avoir lieu.
  Les tests vérifient que le repository n'est **jamais appelé**, pas seulement que le résultat
  est vide.

### Security — `generateDocument` restituait le même dossier, en pire

Relevé par une revue **adversariale** conduite après coup, et c'est la trouvaille la plus
importante du lot : fermer les trois lectures ne fermait qu'une porte sur deux, et pas la plus
large. `generateDocument` accepte un `employeeId` arbitraire, imprime `firstName`, `lastName`,
`email`, `department`, `position` et `startDate` de cette personne dans le document rendu, puis
livre le fichier **dans le canal du DEMANDEUR** — pas dans celui de la personne concernée.

En deux messages : « retrouve le profil de collegue@… », puis « génère-lui une lettre de
bienvenue ». L'attaquant reçoit en DM un PDF **téléchargeable et repartageable** portant le
dossier d'un collègue. Un fichier est un contournement pire qu'une lecture : il quitte le
système.

Même règle que les quatre autres — produire un document pour quelqu'un d'autre reste
parfaitement légitime (une lettre de bienvenue est écrite par les RH), d'où `full` et non un
refus sec. Test : la fiche employé n'est **jamais lue** quand le demandeur n'a pas le droit.

La leçon de méthode vaut d'être notée : la revue adversariale a trouvé ce que l'audit initial
avait manqué, parce qu'elle cherchait un CONTOURNEMENT plutôt qu'un défaut.

### ⚠️ Ce que ce correctif ne fait PAS — à lire avant d'en conclure quoi que ce soit

Le niveau porté par le contexte est l'`effective` calculé par `SlackAccessGuard`, qui rend
`full` à tout le monde tant que **`AUTHZ_ENFORCE`** n'est pas posé. **Tant que l'application
n'est pas activée, cette frontière ne refuse rien.** C'est délibéré et conforme au
raisonnement déjà tranché dans `access-guard.ts` : ces flux existaient avant elle, les
rétrograder d'un coup casserait des usages légitimes.

⚠️ **Piège de configuration à vérifier AVANT de poser `AUTHZ_ENFORCE=true`, pas après** :
`resolveAccess` n'accorde `full` qu'à une adresse dont le domaine figure dans
`SLACK_ORG_EMAIL_DOMAINS` (`kissohq.com,design.kisso.xyz`). Or l'adresse d'annuaire de la
personne qui administre l'onboarding est `karylsoumaila1@gmail.com` — domaine étranger, donc
`readonly`. Activer l'application en l'état la couperait du dossier de tout le monde.

## [Unreleased] - 2026-08-13 — ce que le bot fait quand la demande n'en est pas une

Campagne de durcissement sur les **cas limites de conversation** : ce que reçoit quelqu'un qui
écrit un emoji, colle un document entier, dépose un PDF, ou confie qu'il va mal. Le fil rouge
est unique — **tout ce qui est décidable sans modèle doit être décidé sans modèle**. Ce n'est
pas de l'élégance : le quota Groq se compte à la JOURNÉE (100 000 tokens ≈ 19 messages), donc
un run inutile n'est pas un gaspillage marginal, c'est ≈ 5 % de la capacité du produit.

### Added — `src/shared/message-shape.ts`, troisième court-circuit déterministe

Rejoint `greeting.ts` et `distress.ts`, même forme : un prédicat pur, une réponse écrite en
dur, zéro token.

- **Message sans contenu textuel** (emoji seul, ponctuation seule, kaomoji de symboles) :
  `hasNoTextualContent` teste la présence d'une lettre ou d'un chiffre **Unicode**
  (`[\p{L}\p{N}]`), jamais `[a-z0-9]`. Le filtre latin aurait classé « مرحبا », « привет » et
  « 你好 » comme vides — le bot serait resté MUET devant une phrase parfaitement sensée. Le
  faux positif coûte ici bien plus cher que le faux négatif, et l'arbitrage est verrouillé par
  test : `¯\_(ツ)_/¯` contient une lettre katakana, il atteint donc le modèle, et c'est voulu.
- **Message trop long** : voir ci-dessous, c'est un correctif, pas un ajout.

### Fixed — un copier-coller trop long ressortait en refus de SÉCURITÉ

Défaut reproduit en test avant correction. La borne de 8 000 caractères existait déjà, mais
elle vit dans `wrapUserInput` et y lève une `SecurityBlockError` — que `userFacingFailure`
traduit en `NEUTRAL_REFUSAL` : **« Je ne peux pas répondre à cette demande. Reformule-la
autrement. »**

Ce texte est délibérément muet sur la règle touchée, ce qui est le bon contrat pour une
injection (nommer la sonde qui a porté renseigne l'attaquant) et le mauvais pour quelqu'un qui
colle un compte rendu de réunion : il reçoit un refus de POLITIQUE là où le problème est une
TAILLE, et « reformule-la autrement » ne lui dit pas que reformuler **plus court** est
exactement la solution. Vu de l'extérieur : « le bot refuse mes documents », sans recours.

La longueur n'est pas une information adverse — la borne est publique et se mesure en trois
essais. Le handler court-circuite donc en amont avec un message qui la NOMME. La borne de
`wrapUserInput` n'est pas déplacée mais **doublée** : elle reste le dernier recours des
appelants hors Slack (route HTTP, workflow, playground), et les deux lisent la même constante,
donc elles ne peuvent pas diverger.

### Fixed — le préambule d'identité avait perdu l'email et la fiche employé

`buildMessages` ne passait plus `email` ni `employeeId` à `buildContextPreamble`, alors que le
commentaire immédiatement au-dessus explique pourquoi ils doivent y être. Régression muette :
elle rouvrait le défaut mesuré le 2026-08-12 — **38 `findEmployeeByEmail` en 1,5 seconde, tous
en échec**, le modèle fabriquant des adresses plausibles faute d'avoir la vraie dans sa
fenêtre. Deux tests la couvraient déjà et étaient rouges.

### Added — tests de CÂBLAGE pour les court-circuits, et pas seulement de détecteur

`distress.ts` et `message-shape.ts` ont leurs tests unitaires ; ils ne prouvent rien sur le
produit. C'est la classe de défaut la plus fréquente de ce dépôt — deux bords corrects, aucun
câblage entre les deux (cf. `findEmployeeByEmail` non exposé aux trois agents, cf.
`documents.content` sans colonne). Quatre tests traversent désormais le handler et vérifient la
seule chose qui compte : `generate` n'est **pas** appelé, et la personne reçoit la bonne
réponse. La détresse et la pièce jointe n'avaient aucun test de ce genre.

### Fixed — un commentaire qui déclarait « dette » un travail déjà fait

`securityRefusalMessage` portait encore « ⚠️ Pas encore branché côté appelant », avec le patch
d'une ligne à appliquer. Il **est** branché, en tête de `userFacingFailure`. Une note de dette
périmée est pire qu'une absence de note : elle invite à refaire.

## [Unreleased] - 2026-08-13 — parcours d'arrivée d'un nouvel employé

Ce que Slack sait d'un arrivant est désormais capté à la seconde zéro, et la seule question
qu'on lui pose est celle dont personne d'autre n'a la réponse : son poste.

Spec : `docs/superpowers/specs/2026-08-13-arrivee-nouvel-employe-design.md`.
Plan : `docs/superpowers/plans/2026-08-13-arrivee-nouvel-employe.md`.

### Added — l'arrivant entre dans l'annuaire dès le `team_join`

`handleTeamJoin` écrit la personne dans `slack_directory` (`upsertFacts`) avant tout autre
geste. L'annuaire n'apprenait une personne qu'au **premier message qu'elle envoyait** — et
`findEmployeeByEmail`, qui s'y replie depuis le 2026-08-12, répondait « introuvable » pour
quelqu'un que Slack venait pourtant d'annoncer. C'est le symptôme « il ne retrouve que mon
profil », vu depuis son autre extrémité.

`teamId` est laissé VIDE : le payload `team_join` ne le porte pas de façon fiable, et
`upsertFacts` ne doit jamais écraser un fait connu par une supposition.

### Added — invitation aux canaux publics d'accueil

Trois pièces neuves, dans leur ordre de dépendance :

- `directory/domain/services/welcome-channel-names.ts` — lecture de
  `ONBOARDING_WELCOME_CHANNELS`. Des **noms** et non des identifiants `C…` : c'est ce qu'un
  humain sait écrire et relire six mois plus tard. Le `#` de tête est toléré, la casse
  normalisée, les doublons écartés (deux invitations au même canal dépenseraient un appel
  Slack et feraient apparaître le canal deux fois dans le message de bienvenue).
- `directory/application/services/welcome-channels.service.ts` — le service, *best-effort* de
  bout en bout, qui **ne lève jamais**.
- `directory/infrastructure/providers/slack-welcome-channel.adapter.ts` — le pont, qui
  réconcilie deux conventions d'échec OPPOSÉES : `joinChannel` ne lève jamais et rend un
  statut nommé, `inviteToChannel` rend `void` et LÈVE, le code d'erreur enfoui dans
  l'exception.

Arbitrages, tous lisibles dans le rapport :

- **`already_in_channel` est un SUCCÈS.** L'objectif est « l'arrivant est dans le canal », pas
  « nous l'y avons mis ». Le compter comme une erreur rendrait dégradée toute réexécution —
  même arbitrage que `alreadyMember` dans `ChannelCoverageService`.
- **`not_in_channel` déclenche un `join` puis UN seul nouvel essai.** Jamais deux : un `join`
  qui échoue est définitif pour ce passage, et boucler dépenserait du quota pour répéter le
  même refus.
- **`missing_scope` interrompt les appels.** C'est la seule issue qui appelle un geste humain,
  et elle est journalisée séparément du message générique de dégradation.
- **`not_configured` est distinct de `completed`** : « personne n'a demandé d'invitation » ne
  se lit pas comme « toutes les invitations ont abouti ». Sans cette valeur, une variable
  d'environnement oubliée produirait un rapport parfaitement vert.
- **Séquentiel, jamais `Promise.all`** : `conversations.invite` est plafonné par Slack, et une
  salve simultanée se ferait rate-limiter — le remède produirait le symptôme.

Le DM de bienvenue part **indépendamment** : chacun des deux gestes qui le précèdent avale son
échec. Un arrivant sans canal mais avec son message peut demander de l'aide ; l'inverse ne le
peut pas. Le message cite les canaux rejoints, et **rien** quand il n'y en a aucun — annoncer
« je t'ai ajouté à » suivi de rien serait pire que le silence.

### Changed — la modale ne demande plus que le poste

Le sélecteur **Département** et le sélecteur de **date de début** disparaissent. Restent le
poste (seul champ réellement demandé) et email / prénom / nom, préremplis depuis Slack et
laissés éditables — le profil Slack est parfois vide ou faux, et l'email conditionne toute la
suite.

La date de début est **dérivée de l'instant du `team_join`** (`startDateFromJoin`), transporté
dans le `value` du bouton puis dans le `private_metadata` signé par Slack. Une question dont le
serveur connaît déjà la réponse est une occasion de se tromper offerte à l'arrivant, pas une
information gagnée.

`private_metadata` partage désormais l'encodage du bouton (`encodePrefill` / `decodePrefill`) :
deux formes proches mais distinctes auraient divergé au premier champ ajouté, et l'écart ne se
serait vu qu'en production, sur la soumission.

### Changed — `employees.department` est facultatif

`NOT NULL` retiré. SQLite n'a pas d'`ALTER COLUMN` : la colonne est rendue nullable par
**reconstruction de table** (`scripts/ddl-employees-department-nullable.sql`), retenue contre
une valeur sentinelle — une sentinelle dans une colonne `NOT NULL` finit toujours par être
relue comme une vraie valeur, mode d'échec récurrent de ce dépôt (`emailSent: false` sous
`status: 'success'`, `documents.content` perdu en silence, `status = Sent` posé avant le
`try`, `evaluateResponse` fabriquant des réponses).

⚠️ **Ordre imposé, respecté** : DDL appliquée sur la Turso de production **avant** le
déploiement — 2 lignes intactes, `notnull = 0` vérifié, 7 index recréés.
`idx_employees_department` est délibérément **supprimé** : une colonne qu'on ne renseigne plus
n'a aucune raison d'être indexée.

Les gabarits de documents **omettent** la ligne quand la valeur manque, au lieu d'imprimer
« Département : Général », « département N/A » ou une ligne vide. Une décision ne doit pas
ressembler à un oubli dans un livrable signé de l'entreprise. Idem pour l'email de bienvenue
du workflow. Le schéma de VALEUR est inchangé : quand une valeur est fournie, elle doit
toujours appartenir à l'enum `Department` — on assouplit la présence, jamais la validité.

### ⚠️ Prérequis hors code — BLOQUANT

`team_join` doit être abonné dans *Event Subscriptions*, **puis l'app réinstallée**. L'ajout
seul ne propage rien — piège déjà payé le 2026-08-08. Sans cela, `handleTeamJoin` est du code
mort et rien de ce parcours ne se déclenche, quel que soit le code déployé.


## [Unreleased] - 2026-08-13 — les sept défauts du rejeu de production

Rejeu intégral d'une conversation réelle (9 messages, 21:58–22:05 UTC le 2026-08-12) contre
le déploiement `6ubhhbtvp`, réponses Slack et appels d'outils relevés. Sept défauts, tous
corrigés ici sauf mention contraire.

### Fixed — « Bonjour » écrivait dans le dossier de la personne, et coûtait 13 % du budget

Sept caractères, et cette trace :

    toolCalls: ["findEmployeeByEmail","getEmployeeProfile","updateOnboardingStatus","getTaskList"]
    steps: 5, inputTokens: 13376

Deux dégâts distincts : une **tentative d'écriture non demandée** sur le statut d'onboarding,
et **13 376 tokens** — 13 % du budget Groq quotidien — pour une formule de politesse.

- **Nouveau** `src/shared/greeting.ts` : court-circuit déterministe, zéro appel LLM.
- Le critère est l'**ÉGALITÉ**, jamais « commence par ». « Bonjour, que peux-tu faire pour
  moi ? » et « Salut, tu peux me retrouver le profil de … ? » sont de vraies demandes
  observées en production ; les court-circuiter serait bien pire que le défaut corrigé.
- Placé APRÈS la garde de fil et AVANT le marqueur de progression. Les deux tours sont
  mémorisés : sans cela, un fil ouvert par une salutation ne serait jamais « engagé » et le
  message suivant, sans mention, serait abandonné.
- Une consigne de prompt aurait été payée à chaque aller-retour de chaque message, y compris
  ceux qui ne sont pas des salutations, et serait restée probabiliste.

### Fixed — le statut d'onboarding ne se mettait jamais à jour, et le bot l'annonçait quand même

`onConflictDoUpdate` dont le `set` **omettait `updatedAt` et `startedAt`** : les valeurs
étaient bien passées à `.values()`, mais `values()` est ignoré dès qu'il y a conflit. Sur une
ligne existante, `updated_at` restait gelé à la date d'insertion et le `startedAt` de la
transition `not_started → in_progress` était jeté en silence.

- `OnboardingRepository.update` rend désormais le **nombre de lignes affectées** — il rendait
  `void`, donc `updateOnboardingStatus` retournait `updated: true` en constante, vrai par
  construction. Cinquième occurrence de « le champ dit mieux que le fait ».
- Le double `InMemoryOnboardingRepository` rend 0 sur une ligne absente, comme un UPDATE SQL.
  **C'est cette divergence qui avait laissé passer le bug** : l'ancien double écrivait
  inconditionnellement l'objet entier, donc il conservait les horodatages que Drizzle jetait.
- ⚠️ `employees.onboarding_status` est une colonne **MORTE** — aucun lecteur, aucun écrivain
  applicatif, son index compris. Le seul statut affiché vient d'`onboarding_progress`. Non
  traitée ici : la retirer est un lot à part.

### Fixed — 7 documents et 3 emails identiques en 8 minutes

À « As-tu envoyé le rapport ? », le modèle **regénérait** le guide au lieu de constater qu'il
venait de l'envoyer. Puis encore. Cause de fond : **le système ne sait que CRÉER** — aucun
outil ne sait relire un document déjà produit, donc refaire est la seule action disponible.

- La garde d'idempotence passe du RUN à la **CONVERSATION** (`channel[:threadTs]`), TTL 10 min :
  le doublon s'étale sur plusieurs messages, une clé par message ne pouvait pas le voir.
- La clé ignore `content` (les appels différaient par le contenu) mais inclut `deliverTo` :
  « et envoie-le par email » après une livraison Slack est une demande légitimement différente.
- Mémorisation seulement si la livraison a ABOUTI — sinon une panne passagère deviendrait un
  refus de dix minutes.
- La garde vit dans la FACTORY et non au niveau module : en production c'est identique
  (un seul câblage), mais une garde de module rendait les tests dépendants de leur ordre.

### Fixed — faux refus de sécurité sur des demandes anodines

« Donne le PDF alors » → « Je ne peux pas répondre à cette demande. » (`redacted: 1`,
`toolCalls: []`). Même symptôme sur « Il me faudrait le guide d'accueil de Karyl en PDF ».

- Cause : `/kisso_[0-9a-f]{4,}/i`, hérité de l'époque où le préfixe de session était tronqué
  à 4 hex. Il fait **32 hex** depuis le 2026-08-10, mais le motif matchait toujours
  `kisso_2026`, `kisso_face`, `kisso_cafe`. Un modèle qui NARRE un nom de fichier
  (`guide_kisso_2026.pdf`) faisait détruire toute sa réponse. Porté à `{16,}` (64 bits).
- Le bloc STYLE **écrivait la chaîne interdite pour l'interdire** (« Jamais
  "KISSO-AGENT-v3" »), à trois lignes de la fin des instructions — la position la plus
  recopiable. Or `sanitizeAgentOutput` traite cette chaîne comme un marqueur et remplace la
  réponse entière : le prompt fabriquait le motif que le code punit. Retiré ; la garantie
  vit dans le code, pas dans le prompt. Assertion de test **inversée**, pas supprimée.
- Fixtures de test portées à un préfixe réaliste de 32 hex, plus fidèle à la production.
- ⚠️ **NON traité, et assumé** : `sanitizeAgentOutput` remplace toujours la réponse ENTIÈRE
  dès qu'un marqueur apparaît, là où le canal document retire l'occurrence et garde le
  contenu. Distinguer « le modèle a fuité un marqueur » de « le modèle a obéi à une
  injection » change la posture de sécurité — lot à instruire à froid, pas à 1h du matin.

### Fixed — `deliverTo: 'none'` sur une demande explicite de téléchargement

Sur « génère un guide en PDF **et donne-le moi pour que je puisse le télécharger** », le
modèle a choisi `none`, puis a annoncé que le document n'était pas livré.

La valeur reste dans le schéma — elle est légitime hors Slack (workflow, playground) — mais
elle est **neutralisée dès qu'une conversation Slack existe** : un document que personne ne
reçoit n'y est jamais ce qui a été demandé. C'est une porte de sortie offerte au modèle, pas
une intention d'utilisateur.

### Fixed — l'accusé de réception Slack frôlait la limite de rejeu

    WARN | Slack ACK budget at risk | {"ackMs":1619,"admissionMs":1619}

`ackMs === admissionMs` : **la totalité** du budget était consommée dans `accept()`, donc
dans Turso — signature, parsing et construction du handler pèsent ensemble moins d'une
milliseconde. Le premier accès paie le handshake complet vers Tokyo (DNS + TCP + TLS +
upgrade WebSocket + hello hrana). Slack rejoue tout événement non acquitté en 3 s, et un
rejeu est exactement ce qui a produit la double réponse du 2026-08-11.

`createClient` de libsql est synchrone : le coût n'est payé qu'au premier `await`. La
connexion est donc **amorcée au chargement du module**, ce qui fait chevaucher le handshake
avec l'évaluation du bundle. L'ancien commentaire (« getDb() ici forcerait l'ouverture au
démarrage — inutile en dev ») reposait sur une prémisse fausse en production.

Pistes mesurées et NON appliquées, par gain décroissant : déployer la fonction près de la
base (`regions: ['hnd1']`, ~150-250 ms par aller-retour sur trois), activer Fluid Compute,
rendre paresseux le `scryptSync(N=16384)` du vault (40-100 ms à froid, pour chiffrer puis
déchiffrer un template dans le même processus).

### Connu, mesuré, non corrigé

- **Le budget Groq est bien de 100 000 tokens/JOUR**, et il était consommé à 97 % pendant le
  rejeu : `TPD: Limit 100000, Used 97432`. Les neuf messages sont tous tombés sur Mistral.
  Une sonde d'un seul token passe et n'affiche aucun en-tête TPD — c'est ce qui avait fait
  conclure à tort « Groq est en pleine forme ».
- Le **triplement des questionnaires** persiste : même cause racine que les 7 documents, mais
  la garde n'a pas été étendue à `generateQuestionnaire` faute d'avoir pu la tester.


## [Unreleased] - 2026-08-12 (soir) — l'annuaire était là, personne ne le lisait

Campagne de production de 19:39–19:58 UTC sur le déploiement `9t5yxexhg` (commit `187b647`),
diagnostiquée sur les logs Vercel plutôt que sur le récit. Trois défauts signalés par le
propriétaire, un quatrième que personne n'avait vu.

### Fixed — « il ne retrouve pas les autres profils à part le mien »

Le système avait DEUX annuaires, et les tools lisaient le mauvais.

- `slack_directory` était en production, synchronisée depuis Slack, avec exactement les cinq
  champs demandés par le propriétaire : `slack_user_id`, email, `first_name`, `last_name`,
  `title` (le poste). Six personnes réelles.
- `employees` n'est peuplée que par la modale « Compléter mon profil », déclenchée par le seul
  événement `team_join` : **une ligne vivante** pour un workspace de six.
- `findEmployeeByEmail` n'interrogeait que `employees`. Les deux emails déclarés introuvables ce
  soir-là (`mistourath@kissohq.com`, `ridwanenico77@gmail.com`) étaient dans l'annuaire, avec
  nom et poste. `directorySync` est exporté depuis `src/mastra/index.ts:159` et n'avait **aucun
  appelant runtime** : la donnée était collectée et jamais lue.
- **Correctif additif, aucune migration** : `makeFindEmployeeByEmail(employeeRepo, directoryRepo)`.
  `employees` reste PRIORITAIRE — c'est lui qui porte l'UUID interne dont dépendent
  `getEmployeeProfile`, `getTaskList` et `scheduleReminder` ; l'inverse ferait perdre cet
  identifiant pour un employé enregistré.
- Le résultat distingue `source: 'employees'` de `source: 'slack_directory'`, et la clé de
  retour est `person` et non `employee` : réutiliser `employee.id` ferait passer un `U…` pour
  l'UUID interne qu'attendent les autres tools. Sans dossier d'onboarding, un `hint` le dit —
  au lieu de laisser le modèle inventer un identifiant.
- Bots et comptes désactivés sont écartés : les rendre inviterait le modèle à proposer de leur
  envoyer un document.
- ⚠️ La réduction d'`employees` aux cinq champs demandés a été **examinée puis reportée** :
  67 fichiers, 8 tables, 9 clés étrangères, reconstruction de table SQLite (pas de `DROP COLUMN`
  sûr), pour un gain en tokens **nul** — les tools projettent déjà. L'additif satisfait le
  besoin sans rien casser.

### Fixed — deux PDF identiques pour une seule demande

Ce n'était ni un rejeu d'événement Slack, ni une reprise du SDK : c'est le MODÈLE qui a appelé
le tool deux fois dans le même run.

    toolCalls: ["generateDocument","findEmployeeByEmail","getEmployeeProfile","generateDocument"]
    steps: 3, inputTokens: 7804

Deux lignes en base (`3f1399e2…`, `d05ff0cf…`), deux uploads, deux pièces jointes, une seule
réponse texte. Mastra 1.57 autorise 5 étapes par défaut (`stopWhen ?? stepCountIs(5)`) et ne
déduplique pas les appels d'outils.

- **Nouveau** `src/shared/tool-idempotency.ts` — garde à l'échelle du RUN, en mémoire. Le
  doublon visé naît de deux appels dans le même processus ; la leçon « le LRU en mémoire ne
  suffit pas » de `slack_event_dedup` ne s'applique pas, là-bas les deux invocations étaient
  sur des instances différentes par construction.
- ⚠️ **La clé ignore `content`.** Les deux appels de l'incident avaient un contenu DIFFÉRENT
  (15 puis 249 caractères — le modèle a étoffé son texte) : hacher les arguments complets
  n'aurait rien attrapé. La clé décrit le LIVRABLE (destinataire, type, titre, format, canal),
  jamais la prose. Le second contenu, plus riche, est perdu — arbitrage assumé : deux pièces
  jointes dans un fil sont un défaut visible, un texte plus court ne l'est pas.
- **Nouveau** `SLACK_EVENT_TS_KEY` dans `slack-request-context.ts`. `event.ts` et non `threadTs` :
  en DM `threadTs` est `undefined` par conception, donc une garde portée par le canal seul
  aurait bloqué le second document légitimement demandé dix minutes plus tard. Coût en tokens :
  **zéro**, le `RequestContext` ne traverse pas le prompt.
- Hors Slack (playground, workflow, test), `buildRunKey` rend `undefined` et la garde est
  INACTIVE : se rabattre sur une clé constante ferait qu'un second appel dans un tout autre
  contexte récupérerait le résultat du premier.
- Mémorisation APRÈS succès : un premier appel échoué avant enregistrement ne condamne pas une
  seconde tentative dans le même run.

### Fixed — deux tools étaient INAPPELABLES, dont un à chaque message de questionnaire

Défaut invisible à la lecture, invisible aux tests, visible dans les logs de production :

    tool call validation failed: parameters for tool evaluateResponse did not match schema:
    errors: [`/answers`: additionalProperties 'q2', 'q3', 'q1' not allowed]

- Cause : `z.record(z.unknown())` sérialise en `{"type":"object","additionalProperties":{}}` —
  un objet **sans `properties`** — et Groq refuse alors TOUTE clé. Le schéma est pourtant
  parfaitement PLAT, donc `tool-schema-flatness.test.ts` le déclarait conforme. Chaque tentative
  brûlait un aller-retour LLM complet, sous un quota de ≈ 19 messages/jour.
- `evaluateResponse.answers` devient un **tableau de paires** `{questionId, answer}`. La
  conversion vers le `Record` du domaine vit à la frontière du tool : aucune contrainte de
  sérialisation LLM ne descend dans l'entité ni dans le repository.
- `createEmployee.metadata` portait le même défaut, latent (le tool n'est pas câblé aux agents).
  **Supprimé** plutôt que corrigé : `EmployeeDataSanitizer.sanitize()` ne le recopiait pas dans
  `ValidatedEmployeeInput`, il n'atteignait donc jamais l'entité — exactement le défaut du bloc
  `options` retiré au même endroit.
- **Nouveau garde-fou** : `tool-schema-flatness.test.ts` gagne une suite d'APPELABILITÉ (aucun
  noeud `type: "object"` sans `properties`). C'est le seul contrôle du dépôt qui traverse
  `zodToJsonSchema` — tous les autres tests de tools appellent `execute()` en direct et ne
  peuvent pas, par construction, détecter un tool que le fournisseur refuse d'appeler.

### Changed — `evaluateResponse` ne prétend plus évaluer

Il calculait `réponses fournies / questions × 100` et rapportait ce chiffre au modèle sous le
nom `score`. Il ne comparait à **aucune bonne réponse** : `questionInputSchema` ne porte pas de
champ `expectedAnswer`, donc rien ne pouvait comparer quoi que ce soit. Cinquième occurrence de
la signature « le champ dit mieux que le fait » (`emailSent: false` sous `status: 'success'`,
`documents.content` perdu en silence, `status = Sent` posé avant le `try`).

- Sortie renommée `completionPercent`, plus `graded: false`. Description et nom d'outil disent
  « enregistre » et « complétion », jamais « évalue » ni « note » — le mot que lit le modèle est
  celui qu'il répétera.
- Le comptage n'accepte plus n'importe quelle clé : seules les réponses portant l'ID d'une
  question RÉELLE comptent. Trois clés inventées donnaient 100 % sur un questionnaire de trois
  questions. `unknownAnswers` remonte l'écart, sans quoi un jeu de réponses entièrement mal
  identifié rendait `answeredQuestions: 0` sans jamais dire pourquoi.
- Une vraie correction reste à faire : c'est une fonctionnalité, pas un correctif.

### Connu, non corrigé dans ce lot

- **Le quiz n'est montré qu'après relance.** Les questions SONT dans le tool-result
  (`generate-questionnaire.ts` retourne l'entité complète) ; c'est `AGENT_STYLE_BLOCK`
  (`agent-style.ts:62`) qui interdit la **liste numérotée** — or un quiz en est une. À la
  relance, aucun outil ne sait relire un questionnaire, donc le modèle en **recrée** un : trois
  questionnaires créés le 2026-08-12 (`8d59b6d6`, `a359d6fa`, `b35f2ba7`) pour une seule demande.
- **Le suivi de fil sans re-mention n'est pas tranché.** Le code accepte un message de fil
  (`slack-events.handler.ts:1522`), mais la seule ligne de rejet est en `debug` alors que la
  production tourne en `info` : l'événement n'apparaît ni comme traité, ni comme rejeté. Se
  tranche avec `LOG_LEVEL=debug`, pas avec du code.
- **`Authorization (observation mode) — this actor WOULD be restricted`** sur CHAQUE message du
  propriétaire, `reason: foreign_domain` : son email Slack est un `gmail.com`, absent de
  `SLACK_ORG_EMAIL_DOMAINS`. Inoffensif tant que `AUTHZ_ENFORCE=false` — piège armé sinon.


## [Unreleased] - 2026-08-12 — revue croisée avant redéploiement

Six revues indépendantes (contradiction code/commentaire, chaîne d'autorisation re-dérivée,
câblage mort, parcours utilisateur simulé, build exécuté) sur l'arbre de travail. Ce qui suit
est ce qu'elles ont trouvé et ce qui a été corrigé.

### Fixed — le bundle Vercel ne DÉMARRAIT PAS, et le build sortait en vert

C'est le défaut le plus grave de la passe, et il a exactement la signature récurrente de ce
dépôt : un contrôle qui rassure sur un artefact mort, comme `emailSent: false` sous
`status: 'success'` ou `documents.content` perdu en silence.

- **Symptôme** : `node -e "import('./index.mjs')"` dans `.vercel/output/functions/index.func`
  → `SyntaxError: Named export 'TTLCache' not found`. Erreur de LIAISON ESM, donc la fonction
  entière meurt **avant sa première instruction** — pas une dégradation, une mort.
- **Mécanisme** : le déployeur Mastra écrit un `package.json` de fonction épinglant
  `@mastra/core` en **0.24.9** et installe SA fermeture (`lru-cache@7`, `@isaacs/ttlcache@1`).
  `scripts/fix-vercel-output.js` écrase ensuite `@mastra/core` par le vrai **1.57.0** mais
  laissait sa fermeture derrière : un noyau récent posé sur les dépendances d'un noyau d'il y a
  trois majeures. Les anciennes majeures font `module.exports = Class`, les nouvelles exportent
  un espace de noms — l'`import { TTLCache }` de `mastra.mjs` ne peut pas se lier.
- **Pourquoi c'était invisible** : `ensureTransitiveDependencies` comble les modules ABSENTS,
  jamais ceux présents à une majeure périmée. Et `verify-vercel-bundle.js` VOYAIT l'écart
  (`lru-cache@7.18.3 vs ^11.2.7`) en le classant « non bloquant ».
- **Correctifs** : `lru-cache` et `@isaacs/ttlcache` ajoutés à `MODULES_TO_COPY` (la copie
  depuis la racine écrase, contrairement au comblement) ; et surtout un **contrôle de
  DÉMARRAGE** dans `verify-vercel-bundle.js` — il importe réellement `index.mjs` et n'échoue
  que sur une faute de résolution ou de liaison.
  - ⚠️ Une première version bloquait sur tout écart de MAJEURE : elle a immédiatement dénoncé
    cinq écarts **préexistants et inoffensifs** (`zod@4 vs ^3` exigé par `ai@4`, `ai@4 vs ^5`
    exigé par un provider OpenRouter jamais chargé) que la production fait tourner depuis des
    semaines. Une heuristique de version ne distingue pas un pair non satisfait d'une liaison
    rompue ; **le démarrage, si**. Le rapport de versions reste informatif.
- Vérifié après correctif : `✅ Démarrage du bundle : le graphe de modules se charge et se lie`,
  puis `BOOT OK` à la main. La production déployée, elle, répondait déjà `401` — Vercel résout
  cette fermeture autrement ; le défaut était local, le filet manquait des deux côtés.

### Fixed — la réconciliation FAIT/NARRATION était désarmée dans le cas COURANT

Réponse au verdict de l'utilisatrice testeuse (« il parle exactement de la même façon quand il
a fait le travail et quand il l'a inventé »), qui restait **vrai** malgré le garde-fou.

- La condition était `toolCalls?.length === 0`. Or le premier geste de presque tout run est une
  LECTURE (`findEmployeeByEmail`, `getEmployeeProfile`) : un seul de ces appels portait la
  longueur à 1 et **désactivait la détection pour tout le tour**. Le garde-fou ne couvrait donc
  en pratique que le cas rare « zéro outil du tout ».
- Ce qui contredit une annonce d'accompli n'est pas « zéro outil », c'est « zéro outil qui
  AGIT ». Nouveau `READ_ONLY_TOOL_NAMES` + `hasActingToolCall()`.
- **Liste de LECTEURS, jamais d'ACTEURS** : le défaut sûr doit être le silence. Un outil
  inconnu de la liste — nouvel outil non classé, ou nom illisible après un changement de forme
  de Mastra (`readToolCalls` a déjà journalisé « unknown » sur 100 % des appels) — est traité
  comme un acteur, donc n'accuse jamais. L'inverse ferait qu'un oubli de classement accuse le
  modèle d'avoir menti alors qu'il a réellement agi.

### Fixed — sécurité : deux fuites dans `getUserConversations`

- **Oracle d'annuaire.** `resolveTarget` interrogeait l'annuaire AVANT `authorizeMemoryRead` :
  un demandeur non privilégié distinguait `person_not_found` de `insufficient_privilege`, donc
  **énumérait les emails de l'entreprise** depuis un DM. L'autorisation soi/autrui est
  désormais tranchée sans aucune E/S (`designatesRequester`) et **avant** toute résolution.
- **Fuite transitive par la mémoire.** Tout membre `full` lisait les tours DM d'autrui — or les
  tours `assistant` contiennent les RÉSUMÉS produits par le bot. Un non-membre de
  `#engineer-karyl` pouvait donc lire un résumé de ce canal privé via le DM d'un membre,
  contournant `authorizeChannelRead`. `mayDiscloseBotUtterances` filtre les tours `assistant`
  hors du cas « la personne concernée ». On coupe l'AMPLIFICATION, pas l'accès : un tour `user`
  est ce que la personne a tapé elle-même.
- ⚠️ **Un test verrouillait la fuite** (`toContain('MacBook')` portait sur un tour `assistant`
  d'un tiers). Troisième occurrence du motif dans ce dépôt.

### Fixed — un canal ARCHIVÉ dont le bot est membre était déclaré accessible en écriture

`channel-coverage.service.ts` testait `isMember` avant `isArchived`. `chat.postMessage` échoue
en `is_archived` quel que soit `is_member`, et `listChannelMembershipsPage` ne pose
délibérément pas `exclude_archived` : ces canaux arrivaient donc bien dans la boucle, entraient
dans `accessibleChannelIds` (« ceux où le bot PEUT écrire ») et n'étaient jamais comptés dans
`archivedSkipped`.

### Fixed — la suite de tests n'était verte que parce qu'une table MANQUAIT

Découvert en alignant la base locale sur la production.

- Les tests unitaires ne chargent pas `.env` : `DATABASE_URL` est indéfini et
  `connection.ts` retombe sur `file:./data/kisso.db`. (La Turso de production n'est donc
  **jamais** touchée par les tests — vérifié.)
- Mais le handler construit un `DrizzleRateLimitRepository` dès que `rateLimiter` n'est pas
  injecté : les compteurs étaient **partagés entre tous les tests d'un fichier et persistés
  d'un run à l'autre**. La rafale par défaut étant de 5 messages/minute pour un même auteur,
  onze tests d'`accept()` basculaient en `rate_limited`.
- Cela ne se voyait pas parce que `rate_limit_counters` était ABSENTE de `data/kisso.db` — le
  limiteur dégradait alors en compteur local, par instance. **Un test vert par absence de table
  n'est pas un test vert**, et sur une machine neuve où `npm run db:init` crée tout le schéma,
  la suite échouait.
- Le helper `makeHandler` injecte désormais `rateLimiter: null`, comme il le faisait déjà pour
  `conversationRepository` et `dedupRepository` — même idiome, même commentaire, simple oubli.

### Fixed — DDL invalide

`scripts/ddl-rate-limit-counters.sql` commençait par `claud-- ===` : un fragment parasite en
tête de fichier rendait le premier énoncé insyntaxique. C'était l'unique modification du
fichier par rapport à sa version committée.

### Vérifié sans correctif nécessaire

- **Toutes les DDL sont appliquées en production** : `slack_channels`, `slack_channel_members`,
  `rate_limit_counters`, et `slack_directory.first_name/last_name/title`. `PRAGMA
  foreign_keys = 1` confirmé actif, comme le supposent les commentaires de `schema.ts`.
  Le piège « DDL d'abord, déploiement ensuite » n'était donc pas en attente cette fois.
- **La chaîne d'autorisation de `getChannelHistory` est structurellement sûre** : point de
  contrôle unique, fail-closed porté par l'analyse de flux de TypeScript (`isMember` déclaré
  sans initialiseur, le `catch` retourne), deux méthodes de port séparées plutôt qu'un
  `fetchIfAllowed()`, et deux vocabulaires de refus **typés disjoints** (droit vs faisabilité).
  Aucune identité dans les `inputSchema` : le LLM ne peut pas forger un élargissement de droits.
- **Les données récupérées sont correctement encadrées** : `flatten` supprime `[<>]` du texte
  ET du nom d'affichage avant l'encadrement, et les extraits ont leur propre préfixe de session
  128 bits, distinct de celui du message utilisateur. Le contenu récupéré n'est jamais persisté.
- **Le 4e agent est correctement câblé** : clé de registre identique à l'`id`, présent dans
  `KNOWN_AGENT_IDS`, et `ESCAPE_INTENTS` a été réordonné pour que l'orchestrateur (qui possède
  `retrouve`/`recherche`) ne le capture plus.
- Aucune nouvelle dépendance npm ; la liste `--require` de `verify:bundle` n'avait pas à bouger.

## [Unreleased] - 2026-08-11 (soir)
### Fixed — campagne de production 19:19→19:40, quatre lots de correction

⚠️ **Dans l'arbre de travail, pas déployé.** `npm run typecheck` : 0 erreur ;
`npm run test:unit` : **833 verts**.

#### La croyance centrale du projet était fausse — c'est le quota JOURNALIER, pas le seau/minute

`CLAUDE.md` consacrait une longue section à « PLAFOND GROQ 12 000 tokens/minute — c'est la
limite qui casse la production ». Les logs du 2026-08-11 18:21:50 UTC (déploiement `l71qz4x5f`,
message « Tu peux prévenir Awa que son parcours démarre lundi ? ») disent l'inverse :

- Le seau par MINUTE était **PLEIN** au moment de l'échec — `x-ratelimit-remaining-tokens: 12000`
  dans **56 échantillons sur 64**.
- La limite réellement atteinte est **`TPD: Limit 100000, Used 98207`** : 100 000 tokens par
  JOUR, soit — à **5 168 tokens par message** mesurés sur la campagne — ≈ **19 messages par
  jour, tous canaux confondus**.
- Le repli **Mistral plafonne à 4 REQUÊTES par minute** (`x-ratelimit-limit-req-minute: '4'`),
  limite **insensible à tout dégraissage de prompt**, documentée nulle part jusqu'ici. Groq mort
  sur sa journée, chaque étape retombait sur Mistral ; le message est tombé sur la 5ᵉ requête.
  `LAST_RESORT_MAX_RETRIES = 1` avec 1 s de back-off ne peut structurellement pas franchir un
  seau par minute.

**Conséquence de doctrine, écrite noir sur blanc dans `CLAUDE.md`** : le poste de coût dominant
n'est plus la TAILLE du prompt mais le **NOMBRE D'ÉTAPES** — chaque étape est une requête pleine
chez les deux fournisseurs. Les mesures de dégraissage des campagnes précédentes restent vraies ;
c'est leur **rendement** qui était surestimé. Le correctif à effet réel est humain (palier
payant), pas logiciel : voir `TODO.md` section [0].

- **Nouveau message utilisateur `QUOTA_FAILURE`** (`userFacingFailure`, reconnaissance sur
  `statusCode` 429 ou `AI_APICallError` parlant de quota, en suivant la chaîne `cause`). C'est le
  seul échec où **réessayer a un sens** ; le générique laissait croire à une panne, et
  l'utilisatrice est passée au message suivant, qui a échoué pour la même raison.

#### `files:write` était accordé — la documentation affirmait le contraire partout

Preuve : `{"filename":"guide-d-accueil-….pdf","hasPermalink":true}`, PDF réellement posté dans
le fil pendant la campagne. `CLAUDE.md`, `TODO.md` et `CHANGELOG.md` le déclaraient « SEUL
obstacle restant », et l'en-tête de `CLAUDE.md` — qui existe précisément pour éviter ce piège —
annonçait le chantier de livraison « pas en production ». Corrigé dans les trois fichiers.
- **Conséquence de code** : le repli email de `generateDocument` n'était armé que sur
  `missing_scope`. Le scope étant accordé, la condition était devenue du **CODE MORT** :
  `not_in_channel`, un 5xx Slack ou un réseau coupé rendaient `delivery: 'failed'` sec, alors
  qu'un fichier réel était prêt et qu'une adresse d'annuaire était connue. Rebranché sur **tout**
  échec de livraison Slack. L'argument d'origine (« ne pas écrire à quelqu'un qui n'a rien
  demandé ») ne tenait pas : le destinataire est l'employé concerné par le document qu'on vient
  de demander, et l'alternative n'était pas « ne rien envoyer » mais « perdre le document ».
- ⚠️ Deux commentaires de `src/` affirment encore le contraire (`src/mastra/index.ts` au point de
  câblage de `fileUpload`, en-tête de `SlackAdapter.uploadFile`) : ils n'ont pas été touchés.

#### Lot 1 — routage, identité, vérité (`slack-events.handler.ts`, `src/mastra/index.ts`)

- **Le palier collant faisait de `onboardingOrchestrator` un ÉTAT ABSORBANT.** `stickyAgentId`
  est renseigné dès le premier tour, donc les paliers thématiques étaient **morts à partir du
  message 2** ; et le seul palier capable de déplacer un fil ne menait **qu'à** l'orchestrateur,
  sans retour. Mesuré : `notificationAgent` n'a **jamais** été atteignable en série A (en DM la
  clé de conversation est le canal — tous les sujets d'une heure partagent ce verrou), tandis que
  B6 et C7 ont **arraché** leur fil vers un agent qui a hérité de la mémoire d'un autre et promis
  des capacités qu'il n'a pas : les deux réponses les plus fausses de la campagne.
  - Remplacé par **4 temps avec un palier d'ÉCHAPPEMENT SYMÉTRIQUE** — chaque agent y a ses
    termes, donc aucun n'absorbe — et les termes de suivi (`pdf`, `docx`, `guide`, `email`,
    `message`, `test`, `document`, `tâche`, `onboarding`) redescendent **sous** le collant : ce
    sont eux qui détournaient les réponses de suivi. Listes contractuelles, reproduites dans
    `CLAUDE.md`.
  - **« ajoute » retiré** : verbe français générique, il a envoyé « ajoute une question à choix
    multiple » vers un agent sans aucun tool de questionnaire. Même critère que celui qui avait
    fait écarter « word ».
- **Bord droit de la regex : désinences déclarées PAR MOT.** Le `s?(?![\p{L}])` cassait tous les
  infinitifs — `retrouver`, `rechercher`, `enregistrer` ne matchaient plus, soit le retour **par
  la conjugaison** du bug « recherche par email structurellement inatteignable » du 2026-08-10.
  Les radicaux verbaux déclarés (`VERB_STEM_KEYWORDS`) tolèrent `(?:s|r|z|nt)?` ; les mots-clés
  nominaux (`rappel`, `message`, `test`) gardent le seul pluriel, sinon `rappelle`, `messagerie`
  et `testez` redeviendraient des faux positifs.
- **Injection de l'identité du demandeur** dans un message `system` (≈ 38 tokens/tour, ≈ 69 avec
  l'avertissement d'attribution ; nom résolu via `users.info`, **assaini** — un nom d'affichage
  est contrôlé par son porteur — et caché par instance). Cause racine du « **Ton** profil » /
  « **Tu** as 5 tâches » quand on interroge un tiers : `cleanText` retirait les mentions,
  `slackUserId` ne voyageait que par le `requestContext` (hors fenêtre du modèle), donc le seul
  humain nommé était le SUJET de la requête — et le bloc STYLE impose le tutoiement.
  ⚠️ **Jamais dans le bloc `<kisso_XXXX_user_input>`**, que la DIRECTIVE 3.1 déclare non fiable :
  y glisser une affirmation du serveur la dévaluerait, et un seul bloc ouvrant est autorisé.
- **`cleanText` ne détruit plus que la mention DU BOT** : il les détruisait toutes, donc
  `@mastra crée un profil pour <@U0AWA>` perdait son sujet avant d'atteindre le modèle.
- **Les tours `assistant` d'un AUTRE agent sont préfixés** dans l'historique rejoué (≈ 4 tokens,
  zéro sur un fil homogène). On ne filtre pas par `agentId` — l'UUID rendu par l'orchestrateur
  est la donnée dont `notificationAgent` a besoin — mais sans marque, un agent lit la voix d'un
  autre **comme la sienne** : en C7, l'orchestrateur a repris le motif de `notificationAgent`
  (redemander sujet, texte, canal) pour cette seule raison.
- **Nouveau garde-fou déterministe : réconciliation FAIT / NARRATION.** Le handler est le seul
  point qui voit à la fois la réponse et `response.toolCalls` ; il les confronte désormais. Une
  affirmation d'accompli (liste FERMÉE de formules, relevées telles quelles sur la campagne)
  alors que zéro outil a tourné est **requalifiée** par une note accolée — jamais bloquée — et
  journalisée en `error`. Réponse au verdict de la testeuse : « il parle exactement de la même
  façon quand il a fait le travail et quand il l'a inventé ».
  - On cherche une CONTRADICTION, jamais une invraisemblance : « je peux t'envoyer… » n'en est
    pas une, et l'inclure transformerait chaque tour ordinaire en accusation.
  - ⚠️ `null` (trace illisible) **n'est pas** `[]` (zéro appel) : sans preuve positive, on se tait.
  - La note n'entre **pas** en mémoire — la rejouer apprendrait au modèle à imiter le démenti et
    coûterait ses tokens à chaque tour, sur un budget de ≈ 19 messages/jour.
- **`readToolCalls` journalisait `"unknown"` sur 100 % des appels** (19 runs de production) : le
  nom vit sous `chunk.payload.toolName`, la lecture `call.toolName ?? call.name` ne trouvait
  jamais rien. Le champ ajouté précisément pour distinguer une action d'une narration ne
  répondait à aucune question. Les deux formes plates restent en repli.
- **Un `message` de canal est accepté dans un fil DÉJÀ ENGAGÉ** ; `not_a_dm` ne couvre plus que
  les messages de canal hors fil. Le filtre était plus large que son motif : le doublon
  `message`/`app_mention` est **déjà** traité par `dedupKey` (`ts:<channel>:<ts>`), tandis que son
  effet de bord rendait **toute la mémoire conversationnelle inerte en canal** sans re-mention à
  chaque tour — friction signalée par le propriétaire.
  - Deux gardes : le message **racine** d'un fil est exclu (prise de parole neuve), et en tâche
    de fond `shouldAbandonThreadReply` abandonne tout fil où le bot n'a jamais parlé — sans quoi
    chaque phrase entre humains dans #kisso-hq deviendrait un run LLM.
  - ⚠️ Le **jumeau `message`** d'une mention reste traité : il peut prendre la clé de dédup le
    premier, et l'abandonner ferait écarter l'`app_mention` comme doublon — la mention resterait
    **sans réponse**, régression pire que le défaut corrigé.
- **`findEmployeeByEmail` exposé aux TROIS agents** — correctif de CÂBLAGE, pas de rédaction.
  Tous les tools de `questionnaireEngine` et `notificationAgent` exigent un UUID, aucun ne fait
  email → UUID, le `.describe()` de `recipientId` renvoyait vers `getEmployeeProfile` qui exige
  déjà un UUID (consigne **circulaire**), et `AGENT_ANTI_INVENTION_BLOCK` interdit d'en deviner
  un : la boucle de la série C était **garantie par le câblage**, pas probabiliste. Coût ≈ +120
  tokens de schéma par agent, assumé — un agent qui ne peut pas résoudre une personne ne peut
  RIEN faire.

#### Lot 2 — outils de notification : ils posaient les questions au lieu de faire le travail

Bilan de la série C avant correction : **7 messages, 0 email, 0 rappel, 0 document**.

- **`sendNotification` : 5 champs obligatoires sans défaut → 3, avec 2 défauts**
  (`channel` → `email`, `recipientType` → `employee`) — le profil exact de `generateDocument`,
  seul outil de la campagne qui ait abouti. Un champ obligatoire sans défaut est une question
  posée à l'humain, donc un aller-retour, donc un message sur les 19 de la journée.
  - Enum `channel` ramené de **7 à 2** valeurs : `in_app`, `teams`, `push`, `sms` et `webhook`
    n'ont aucun transport ici ni aucun lecteur ailleurs. Le « tu préfères quel canal (email,
    Slack, in-app) ? » observé en production **est** cette énumération remontée à l'humain.
    `recipientType` restreint de même aux types qui peuvent avoir une ligne d'annuaire.
  - ⚠️ **La dérogation de rédaction vit dans le `.describe()` de `subject`/`body`, PAR CHAMP.**
    Posée par agent dans le prompt, elle contredirait frontalement `AGENT_ANTI_INVENTION_BLOCK`
    et reviendrait à tirer à pile ou face à chaque tour. La distinction : un email ou un UUID se
    **retrouvent**, une prose se **produit**.
  - **`status = Sent` était posé AVANT le `try`**, donc par défaut : les canaux non transportés
    repartaient « envoyé », horodatés, sans qu'aucun octet ne parte — **et un test verrouillait
    ce mensonge** (supprimé et remplacé). Troisième occurrence du même défaut dans ce dépôt,
    après `emailSent: false` sous `status: 'success'` et `documents.content` perdu en silence.
- **`getNotificationHistory` rendait les lignes Drizzle brutes** : 18 colonnes, `body` non borné,
  `limit` par défaut à 50 → **≈ 9 600 tokens → 177**, taille désormais indépendante du nombre de
  lignes. `limit` **retiré du schéma** (il ne servait qu'à laisser le modèle choisir combien on
  lui facture) et tri déterministe ajouté — il n'y en avait aucun, deux appels identiques
  pouvaient rendre deux ordres différents.
- **`scheduleReminder` : aucun automate ne le reprend.** Le statut `Scheduled` n'est lu nulle
  part, `findPending()` n'a aucun site d'appel. On ne construit pas l'ordonnanceur (hors lot) ;
  on corrige le **mensonge** : description en « enregistre » et non « planifie » — le mot que lit
  le modèle est celui qu'il répétera — et résultat portant `willBeSentAutomatically: false`.
  Deux refus bruyants ajoutés, alignés sur `sendNotification` : destinataire inconnu et date
  passée.
- **`getTaskList` rend `found: false`** : un UUID inconnu donnait `{tasks: [], totalTasks: 0}`,
  **indiscernable d'un employé sans tâche** — le modèle affirmait « aucune tâche en cours » pour
  un identifiant qui ne désigne personne.

#### Lot 3 — SÉCURITÉ : le contenu d'un document ne passait par AUCUN filtre

- **`sanitizeAgentOutput` n'a qu'un site d'appel** (`response.text`) : **les arguments de tool
  n'y passent jamais**. Or `title` et `content` d'un document sont écrits intégralement par le
  modèle. Vérifié en générant de vrais PDF et en décodant leur CMap : `[SECURITY_BLOCK]`, les
  délimiteurs `kisso_XXXX`, `DIRECTIVE 3.1` et `https://kisso.internal/…` **s'imprimaient
  intégralement**, sans le moindre log. Dans Slack, chacun aurait déclenché `NEUTRAL_REFUSAL` ou
  le retrait du lien, avec une ligne en `error`. **Le document contournait donc le filet
  unique** — et il est téléchargeable et repartageable.
- Assainissement posé en **DEUX points**, et ce n'est pas une redondance : au seuil du RENDU
  (couche `domain`, seul point qu'aucun renderer ni `documentGenerationWorkflow` ne peut
  contourner) et dans le tool, parce que la **persistance** et la **journalisation** vivent en
  dehors du renderer — une ligne enregistrée avec un marqueur ressortirait telle quelle au
  premier code qui la relirait. L'opération est idempotente.
- **Contrat volontairement différent de celui de Slack** : on retire l'occurrence et on GARDE le
  document. Un PDF signé de l'entreprise ne contenant qu'un refus serait pire que le défaut
  corrigé. La détection ne se perd pas : elle remonte à l'appelant, qui journalise en `error`.
- **Les emojis sortaient en glyphe `.notdef`** (Roboto est la seule police du VFS) : c'est le
  « caractère indésirable » signalé par le propriétaire. Retirés, jamais transcrits — « [emoji] »
  rendrait visible une trace de filtrage dans un document d'accueil.
- **Le markdown est TRADUIT en structure** (`#` → titre, `- ` → puce, tableau à deux colonnes →
  bloc `fields`) au lieu d'être imprimé. Le modèle en écrit quoi qu'on lui demande (démenti en
  production sur les trois agents) ; le retirer aurait aplati tout le document en un pavé, soit
  le défaut d'origine sous une autre forme.
- **Le nom de fichier dérive désormais du titre ASSAINI** — il était dérivé du titre brut, et il
  sort du processus (nom du fichier Slack, nom de la pièce jointe).

#### Lot 4 — l'espace négatif : ce que l'agent NE PEUT PAS faire

- **A3 est le seul refus correct de toute la campagne, et la seule frontière écrite noir sur
  blanc.** Un `Agent` Mastra ne reçoit qu'une **énumération POSITIVE** de ses tools ; le
  complément était comblé par de la prose inventée — « je peux lui renvoyer le lien » (aucun tool
  n'envoie de lien), « donne-moi son email pro » (aucun tool de cet agent ne consomme un email),
  « je ne peux pas modifier un questionnaire qu'elle n'a pas encore reçu » (règle métier
  entièrement inventée), un rappel « programmé pour lundi 9h » annoncé sans jamais appeler
  `scheduleReminder`.
- **Nouvelle frontière `agentToolBoundary(tools)`** : `TES SEULS OUTILS : … Rien d'autre
  n'existe`, **dérivée de `Object.keys(tools)`** et jamais rédigée — ce dépôt a déjà connu des
  instructions nommant `discoverSlackWorkspace` et `createEmployee` longtemps après leur retrait.
  Une liste écrite à la main se désynchronise au premier changement de câblage ; celle-ci ne le
  peut pas. 38 à 48 tokens.
- **Supprimé : « passe la main à l'agent de notification ».** **Aucun mécanisme de passation
  n'existe** — le routage vit dans le handler Slack, hors de portée du modèle. Cette ligne
  ordonnait l'impossible, invitait à NARRER une délégation qui n'a jamais lieu, et était repayée
  à chaque aller-retour. Deux tests protègent la suppression.
- **Le formulaire « Compléter mon profil » n'est PAS inventé** — `handleTeamJoin` l'envoie
  réellement. Ce qui manquait était sa **condition de déclenchement** : il ne part que quand la
  personne rejoint le workspace Slack. Le citer sans le dire laisse croire à une RH que le
  dossier est réglé, alors que rien ne partira tant que l'arrivée n'a pas eu lieu.
- **`TUTOIEMENT` → « Tutoie ton interlocuteur, jamais le sujet dont on parle »** : le bloc
  imposait le tutoiement sans jamais dire QUI tutoyer. Ajout de « ton neutre, sans exclamation ni
  liste numérotée » — constat de la testeuse : les points d'exclamation arrivaient précisément
  dans les phrases où l'agent ne faisait rien.
- **« pas de markdown, pas d'emoji » rétabli UNIQUEMENT dans le bloc DOCUMENTS** de
  l'orchestrateur : le rétablir dans le bloc STYLE partagé le ferait payer trois fois pour un cas
  qui n'en concerne qu'un.
- **FLOOR mesuré sur le câblage réel** (ratio 3,5 car./token) : `onboardingOrchestrator` **1 476**,
  `questionnaireEngine` **1 244**, `notificationAgent` **1 352**, somme **4 072**. Les lots sont
  **autofinancés** — la frontière et les consignes ajoutées sont payées par les suppressions.
  L'écart avec les chiffres de lot (1 476 / 1 118 / 1 239) est l'exposition de
  `findEmployeeByEmail` aux trois agents.
  ⚠️ **`_measure.mts` est PÉRIMÉ** : son câblage codé en dur n'inclut pas `findEmployeeByEmail`
  sur `questionnaireEngine` ni `notificationAgent`, il sous-estime donc deux agents sur trois.
  Même défaut dans la constante `WIRING` de `agent-instructions-budget.test.ts` (sans
  conséquence : ce test vérifie la forme de la frontière, pas le total).
- **Fusion des trois agents en un seul : examinée puis REJETÉE.** Les schémas des 10 tools réunis
  pèsent **≈ 1 622 tokens**, davantage que le FLOOR entier de l'orchestrateur — soit ≈ +80 % par
  aller-retour. À réexaminer si Groq passe en palier payant.

#### Corrections directes, hors lots

- **`NEUTRAL_REFUSAL` disait « contactez l'équipe RH » — à la responsable RH, qui testait.** Et il
  vouvoyait quand les trois agents tutoient : le basculement de registre exact au moment où ça
  casse donnait l'impression de deux interlocuteurs différents. Réécrit en « Je ne peux pas
  répondre à cette demande. Reformule-la autrement. » — le bot ne connaît pas son interlocuteur
  au point de savoir vers qui le renvoyer. Reste muet sur la règle touchée, ce qui était déjà
  l'intention d'origine.
- **`getTaskList` et `scheduleReminder` reçoivent l'annuaire** dans `src/mastra/index.ts`.

#### Base de production (déjà appliqué, consigné ici)

- DDL `documents.content` et `slack_event_dedup` **appliquées et vérifiées** ; prise atomique de
  la déduplication testée (1 ligne, puis 0). La déduplication inter-instances **fonctionne** en
  production : `Dropping duplicate Slack event (claimed by another instance)` avec un `requestId`
  différent, et `Shared Slack dedup unavailable` : **0 occurrence**.
- Nettoyage : 6 documents sans contenu, 1 notification orpheline, 1 questionnaire non rattaché
  supprimés. Les 2 employés ont été rattrapés (1 parcours + 5 tâches + 5 étapes chacun).

#### Ce qui est SACRIFIÉ, et assumé

`generateQuestionnaire` est une boucle d'écho (`status: Published` sans rien publier) ; **aucun
tool ne sait LIRE un questionnaire ou une réponse** — « Awa a-t-elle répondu ? » est
structurellement insoluble ; aucun ordonnanceur ne reprend les rappels ;
`notificationCycleWorkflow` est un stub qui renvoie `successCount: N` sans aucune E/S ;
« étape 0 sur 5 » reste indicible. Détail et raisons dans `TODO.md`, section « Sacrifié ».

## [Unreleased] - 2026-08-11
### Added (livraison réelle de documents — lots 1 à 4)

⚠️ **Note du soir du 2026-08-11 : cet avertissement était FAUX.** Le chantier ci-dessous **a**
été déployé (déploiement `l71qz4x5f`) et le scope `files:write` **était accordé** — un PDF a été
rendu et posté dans Slack pendant la campagne (`hasPermalink: true`). Les DDL `documents.content`
et `slack_event_dedup` ont depuis été appliquées et vérifiées.

- **Port `DocumentRenderer`** (`src/features/document/domain/ports/document-renderer.ts`) :
  `render()` → `{ bytes: Uint8Array, filename, mimeType }`. `Uint8Array` et non `Buffer` — la
  couche `domain` doit rester du TypeScript pur (garde-fou `tests/unit/quality/architecture.test.ts`),
  et un `Buffer` EST un `Uint8Array` : la contrainte ne coûte rien au runtime.
  - `PdfmakeService implements PdfService, DocumentRenderer` : `render()` **n'écrit jamais sur
    disque** — seul chemin utilisable sur Vercel (FS en lecture seule hors `/tmp`, et éphémère).
    L'ancienne `generate()`, qui écrit dans `./data/documents` et rend un chemin local, est
    **conservée** : `documentGenerationWorkflow` en dépend et n'a pas été touché.
  - **`DocxService`** (`docx@9.7.1`), nouveau. Import **statique**, contrairement au
    `createRequire` de `pdfmake.service.ts` : c'est l'invisibilité du `require()` dynamique pour
    l'analyse du bundler qui avait produit le `Cannot find module 'js-md5'` en production — on ne
    reproduit pas ce montage.
- **Templates format-agnostiques** (`document/domain/services/document-template.ts`) : modèle
  logique en blocs pauvres (`heading | paragraph | bullets | fields`), dénominateur commun que
  PDF et DOCX rendent tous deux sans approximation. 4 gabarits dédiés (`contract`,
  `welcome_letter`, `certificate`, `guide`) + 1 **générique** couvrant les 5 autres valeurs de
  `DocumentType`. Les templates vivaient en `TDocumentDefinitions` pdfmake : les dupliquer pour
  DOCX aurait garanti que deux rendus du même type finissent par ne plus dire la même chose.
- **Nom de fichier assaini par liste BLANCHE** (`document/domain/services/document-file.ts`) :
  `[a-z0-9]` après décomposition NFD et retrait des diacritiques, jamais une liste noire — le
  titre est rédigé par un LLM à partir d'un texte utilisateur et SORT du processus (nom du
  fichier Slack, nom de la pièce jointe). `../../etc/passwd` → `etc-passwd.docx`, « Émilie » →
  `emilie`, titre vide → `document`. Base tronquée à 80 caractères (eCryptfs plafonne à 143
  octets, plusieurs clients mail tronquent au-delà de 100).
- **`SlackAdapter.uploadFile()`** via `files.uploadV2`, derrière le port `FileUploadProvider` —
  aucun type `@slack/*` dans `domain/`. Deux pièges consignés, tous deux constatés dans les
  typings installés (`@slack/web-api` 8.0.0) :
  - le permalink est **doublement imbriqué** (`res.files[0].files[0].permalink`) : la v2 est un
    enrobage client (`getUploadURLExternal` → PUT → `completeUploadExternal`) et non l'ancienne
    `files.upload`, qui rendait un unique objet `file` ;
  - l'accesseur public `client.files.uploadV2` est typé `WebAPICallResult`, soit
    `{ ok, response_metadata? }` : **le champ `files` n'existe pas pour TypeScript**, seule la
    méthode `WebClient.filesUploadV2()` porte le type riche. La lecture se fait donc depuis
    `unknown`, défensivement — et l'absence de permalink n'est PAS un échec, le fichier est livré.
  - `channel_id` (et non `channels`, déprécié) ; `file: Buffer.from(bytes)` — le SDK refuse un
    `Uint8Array` nu et interpréterait une **chaîne** comme un CHEMIN à lire sur le disque.
  - Un `missing_scope` est retraduit en `Error` de prose nommant les DEUX gestes humains requis
    (ajouter `files:write`, PUIS réinstaller l'app), erreur d'origine conservée dans `cause`.
- **Pièces jointes email** : `EmailProvider.sendEmail` gagne un 4ᵉ paramètre **optionnel**
  `attachments` — optionnel à dessein, `send-notification` et le workflow d'onboarding ne sont pas
  modifiés et produisent exactement le même message. Nouvelle policy de domaine
  `notification/domain/services/email-attachment-policy.ts`, borne **5 Mio sur le TOTAL**,
  vérifiée **avant toute E/S**.
  - Elle vit dans le domaine et non dans un adaptateur : SMTP et Brevo doivent refuser exactement
    les mêmes envois, sinon un basculement de fournisseur changerait silencieusement ce que le
    produit accepte de livrer. Sur le total et non par pièce : c'est le volume transféré qui fait
    expirer le socket.
  - Pourquoi 5 Mio : `SMTP_TIMEOUT_MS` = 10 s sur une connexion TCP tenue depuis une fonction
    serverless, et le base64 ajoute +33 % sur le fil (5 Mio ≈ 6,7 Mio transférés, ~12 Mio de pic
    mémoire). Les documents réellement produits pèsent quelques dizaines de kilo-octets — deux
    ordres de grandeur sous la borne : un dépassement signale un contenu non borné en amont,
    c'est-à-dire un bug, pas un document légitime.
  - `assertEmailAttachmentsFit` **lève** au lieu de rendre un booléen : un refus silencieux
    reproduirait le piège `emailSent: false` sous `status: 'success'`.
- **Contexte Slack jusqu'aux tools** (`src/shared/slack-request-context.ts`) — c'était le point
  **bloquant** recensé dans `TODO.md`. Un tool reçoit son `inputData` du modèle, et le modèle ne
  connaît pas — et ne doit pas connaître — l'identifiant d'un canal.
  - `agent.generate(messages, { requestContext })` : ⚠️ en Mastra 1.57 c'est **`requestContext`**,
    plus `runtimeContext`. Lecture côté tool par `readSlackContext(ctx.requestContext)`, par
    contrat structurel (`get(key)`) et non par `instanceof` — le runtime peut fournir un proxy, et
    un `instanceof` casserait aussi si deux copies du paquet cohabitaient dans le bundle.
  - **Coût en tokens : NUL.** Le `RequestContext` est un canal d'injection de dépendances côté
    serveur : il ne traverse ni le prompt, ni les schémas de tools, ni le tool-result.
  - Module dans `src/shared/` parce que le producteur (`notification/infrastructure/handlers`) et
    les consommateurs (`application/tools` d'AUTRES features) ne peuvent pas s'importer sans
    violer la règle de dépendance. Les trois clés sont le CONTRAT entre les deux bords : les
    dupliquer en littéraux ferait qu'un renommage d'un seul côté couperait la livraison sans
    qu'aucun type ne bouge ni aucun test ne rougisse.
  - **En DM, `threadTs` reste délibérément absent** : threader un DM enfouit le message hors de la
    conversation principale (incident de production déjà documenté). Un fichier uploadé avec un
    `thread_ts` en DM serait pire — la personne verrait « voici ton document » sans jamais voir le
    document.
  - `readSlackContext` ne lève jamais et rend `undefined` hors Slack (playground, route HTTP,
    workflow, test) : c'est le cas NORMAL de ces chemins, au tool de dégrader.

### Changed (capacité réellement atteignable — lot 4)
- **`generateDocument` rend, enregistre, livre et rend compte.** Il se réduisait à un
  `repo.save()` : aucun fichier produit, aucune livraison. C'est ce vide qui a fabriqué en
  production le faux lien `https://kisso.internal/docs/<uuid>/download` — sommé de livrer un
  document, le modèle en a inventé la seule chose qu'il savait produire, une URL.
  - `inputSchema` : `format` restreint de **10 à 2 valeurs** (`pdf`/`docx`, les seules qui aient
    un renderer — annoncer les huit autres promettrait au modèle ce que le code ne sait pas faire,
    c'est-à-dire exactement le piège corrigé ici, et les réémettrait à chaque aller-retour sous
    plafond Groq), **défaut `pdf`** au lieu de `txt` (le défaut `txt` produisait des documents que
    personne n'avait demandés dans ce format) ; nouveau champ `deliverTo`
    (`slack | email | none`, défaut `slack` — la demande arrive d'une conversation Slack dans la
    quasi-totalité des cas, et un défaut obligeant à demander « où veux-tu le recevoir ? » coûte
    un aller-retour complet, plus cher que le champ lui-même).
  - **Ni canal, ni thread, ni adresse dans le schéma.** Le canal et le thread viennent du
    `requestContext` : le modèle ne voit jamais un identifiant de canal, il ne peut donc ni
    l'inventer ni le détourner. L'adresse email est résolue depuis l'annuaire via `employeeId` —
    même modèle de menace que `send-notification.ts` : le tool est atteignable depuis un message
    Slack arbitraire, donc toute valeur produite par le LLM est réputée contrôlée par un
    attaquant.
  - **Tool-result projeté : 685 → 39 tokens** en nominal (91 quand un `hint` de dégradation est
    joint). Le tool retournait l'entité complète, `content` compris : il renvoyait au modèle, à
    ses frais, le texte que le modèle venait lui-même d'écrire, et ce texte restait ensuite dans
    l'historique de TOUS les tours suivants. La propriété qui compte n'est pas le chiffre mais
    l'**indépendance** : la taille ne dépend plus de la longueur de `content` (test : Δ = 0
    caractère entre 10 et 11 000 caractères de corps), sous 60 tokens verdict compris.
    Même défaut, même correction que `getEmployeeProfile` (2 506 → 329).
  - **Le permalink Slack est journalisé, jamais retourné au modèle** : remettre une URL dans le
    contexte rouvrirait précisément la porte par laquelle le faux lien est passé — et le fichier
    est déjà dans le fil.
  - Verdicts : `delivery` ∈ `slack | email | none | failed`, `reason` ∈ `employee_not_found |
    no_slack_context | missing_scope | no_email | delivery_failed | not_rendered`, plus un `hint`
    **payé uniquement dans les cas dégradés** (pas un caractère de plus quand la livraison
    réussit). Chaque `hint` dit au modèle ce qu'il doit ANNONCER, faute de quoi il comble le vide —
    c'est la mécanique exacte du faux lien.
  - ⚠️ **`missing_scope` déclenche un repli sur l'email ; un échec Slack ordinaire NON.** Un scope
    manquant est un manque de configuration durable (son ajout exige une réinstallation de l'app),
    donc réessayer autrement a du sens ; une panne Slack passagère (`not_in_channel`, 5xx) n'est
    pas une raison d'écrire à quelqu'un qui n'a rien demandé.
  - Le document est **toujours enregistré**, même quand la livraison échoue — seule une livraison
    réussie pose `status: Sent`, unique trace persistée du départ d'un document. Un `employeeId`
    inconnu n'enregistre rien (`documents.employee_id` porte une clé étrangère) et ne lève pas :
    il rend un résultat qui INSTRUIT, comme `get-employee-profile.ts`.
- **Bloc DOCUMENTS de `onboardingOrchestrator` réécrit** — pas ajouté : 203 → 198 caractères
  (58 → 57 tokens au ratio 3,5, mesuré). L'ancien texte (« il ne renvoie AUCUN fichier
  téléchargeable ni URL ») constatait un vide fonctionnel ; le garder aurait bridé la capacité en
  interdisant à l'agent d'annoncer ce qu'il vient de faire. Deux choses n'ont pas bougé :
  l'interdiction d'inventer un lien (le fichier est livré par UPLOAD, il n'existe aucune URL de
  téléchargement dans ce système) et le budget. Ajout de fond : lire le champ `delivery` du
  tool-result plutôt que supposer — c'est ce qui permet l'énoncé honnête « le document est prêt
  mais je n'ai pas pu te l'envoyer ».
- **`docx` ajouté à `ORCHESTRATOR_INTENTS`** (`slack-events.handler.ts`) : une extension de
  fichier, servie par le seul agent qui porte `generateDocument`, sans autre sens en français
  comme en anglais — le critère « sans ambiguïté » exigé par ce palier.
  - **« word » a été examiné et volontairement ÉCARTÉ.** C'est un mot anglais courant (« in other
    words »), et ce palier **prime sur le palier collant** : un faux positif n'y coûte pas un
    repli anodin, il ARRACHE le message au fil en cours. Or « envoie-le en Word » n'a pas besoin
    de ce palier — c'est une réponse de suivi, précisément ce que le palier collant sait router
    vers l'agent qui mène la conversation.
- **Garde-fou de bundle** : `verify:bundle` exige désormais `docx`
  (`--require pdfkit,pdfmake,js-md5,fontkit,docx`). C'est le **câblage** de `DocxService` dans
  `src/mastra/index.ts` (import statique) qui fait entrer le paquet dans le bundle — les deux vont
  ensemble, exiger sans câbler casserait le build. Vérifié : build OK, `docx@9.7.1` et ses 5
  dépendances (`hash.js`, `jszip`, `nanoid`, `xml`, `xml-js`) présents, smoke test PDF depuis le
  bundle → 7 082 octets, en-tête `%PDF-` valide.

### Fixed (lot 5 — l'échec d'email n'est plus silencieux)
- **`employeeOnboardingWorkflow` rend un verdict lisible.** Il ne connaissait que « réussi » et
  « échoué » : l'envoi de l'email étant best-effort, un email jamais parti se rendait par un
  `emailSent: false` noyé dans un run `status: 'success'`. Trois lecteurs successifs — rapports
  humains, `scripts/production-*.ts`, agents — y ont conclu à tort qu'un email avait été envoyé,
  produisant de faux « ✅ PASS ». C'est le piège « l'échec d'email est SILENCIEUX » de `CLAUDE.md`.
  - Nouveau `onboarding/domain/value-objects/onboarding-outcome.ts` : `OnboardingOutcome`
    (`completed | degraded | failed`) et `degradedSteps: { step, reason }[]`. Le couple
    QUOI/POURQUOI est indissociable — un booléen dit qu'il faut réparer, jamais quoi réparer, et
    le diagnostic repartait alors des logs quand ils existaient encore.
  - ⚠️ **`run.status` reste `'success'`** : c'est un champ de Mastra, non modifiable. Le verdict
    vit dans la charge utile — c'est `outcome` qu'il faut lire, pas `run.status`. `failed` ne
    figure jamais dans le résultat (un run en échec n'a pas de résultat, Mastra rend
    `{ status: 'failed', error }`) ; la valeur existe pour que les appelants qui traduisent
    `run.status` disposent du même vocabulaire.
  - **Trois** étapes best-effort inventoriées, et c'est la moitié du correctif : `onboardingTasks`,
    `welcomeEmail`, `slackInvite`. Ne traiter que l'email aurait laissé l'invitation Slack et la
    création des tâches dans le même angle mort, avec exactement le même symptôme.
  - **Arbitrage : « non applicable » ≠ « dégradé ».** Sans provider ni canal de département,
    l'invitation n'était pas censée avoir lieu — et c'est le cas de TOUTE soumission de la modale,
    qui passe `slackChannelId: null` faute de correspondance département → canal. La compter comme
    dégradation aurait rendu « dégradé » l'état NORMAL et détruit le signal. En revanche, canal
    configuré + compte Slack introuvable EST une dégradation : l'arrivant n'atterrit dans aucun
    canal.
  - **On ne lève pas.** Transformer l'échec d'une étape best-effort en exception avorterait le run
    et ferait perdre l'employé créé, ses tâches et son invitation — pour une indisponibilité SMTP
    de trente secondes. `Degraded` est un aboutissement, pas un échec.
  - `emailSent` et `slackInvited` sont **conservés** bien que redondants avec `degradedSteps` :
    les instructions des agents les nomment explicitement.
  - Appelants adaptés : `src/api/slack-interactions.route.ts`, `scripts/production-scenarios.mjs`,
    `scripts/production-test.ts`, `scripts/production-test-mocked.ts`,
    `docs/guides/tests-manuels.md`, `docs/SLACK_BOT_SETUP.md`.
  - Vérifié et laissé tel quel : le tool `sendNotification` n'a jamais porté ce défaut — il échoue
    bruyamment sur la résolution du destinataire (`throw NotFoundError`) et, sur échec de
    transport, enregistre puis **retourne** l'entité avec `status: 'failed'` / `sentAt: null`.

### Fixed (perte de données et double réponse)
- **`documents.content` — perte de données silencieuse.** L'entité `Document` déclare
  `content: string`, `generateDocument` l'exige en entrée (`z.string().min(1)`)… et **aucune
  colonne** ne l'accueillait. Drizzle IGNORE silencieusement toute clé de `.values()` sans colonne
  déclarée, et le `as unknown as` des mappers du repository effaçait l'écart pour le compilateur.
  État constaté sur la Turso de production le 2026-08-11 : **6 lignes sur 6 sans contenu,
  irrécupérables**.
  - Colonne ajoutée à `schema.ts`, DDL manuel `scripts/ddl-documents-content.sql` (les migrations
    `drizzle/` sont désynchronisées et `drizzle-kit push` se bloque contre un `libsql://` distant).
  - ⚠️ **Ordre imposé : DDL d'abord, déploiement ensuite.** Une fois `content` déclarée, Drizzle la
    NOMME dans l'INSERT : `generateDocument` échoue alors en `no such column: content` — échec
    bruyant, préférable à la perte muette, mais il impose l'ordre.
  - Colonne **nullable** à dessein : les 6 lignes existantes n'ont pas de contenu à rétablir, un
    `NOT NULL` exigerait une valeur de remplissage, c'est-à-dire un document vide présenté comme
    complet. Le bloc « stockage » de la table (`storage_key`, `storage_bucket`, `file_name`,
    `file_size`, `mime_type`) décrit une référence S3/GCS qui n'existe pas — NULL sur 6 lignes / 6,
    aucun bucket configuré nulle part. Tant qu'aucun stockage objet n'existe, la base EST le
    stockage.
- **Déduplication Slack partagée** (table `slack_event_dedup`, port
  `slack-event-dedup.repository.ts`, implémentations Drizzle et in-memory). Le cache LRU est en
  mémoire, donc **par instance** : incapable par construction d'écarter un rejeu routé vers une
  AUTRE instance. C'est la double réponse du 2026-08-11 12:38 UTC — l'instance A était occupée par
  le `waitUntil` de l'appel LLM, donc le rejeu (`retryNum: 1`, provoqué par un ACK à 6,7 s sur
  démarrage à froid) est parti sur une instance neuve, au cache vide, qui a répondu une seconde
  fois avec un texte différent.
  - `claimEvent()` prend la clé en deux temps : cache local (aucune E/S, cas le plus fréquent sur
    instance chaude) puis store partagé. La clé du handler (`ts:<channel>:<ts>` ou
    `id:<event_id>`) sert de PRIMARY KEY : c'est elle qui rend la prise atomique via
    `INSERT … ON CONFLICT DO NOTHING`.
  - **Dégradation assumée** : store indisponible → repli sur le seul cache local, événement
    **accepté**. Un doublon possible vaut mieux qu'un message perdu — le doublon est visible et
    corrigeable, le silence ne l'est pas. Journalisé en `error`
    (`Shared Slack dedup unavailable — falling back to the per-instance cache`).
  - ⚠️ **Aucun script DDL n'existe pour cette table et elle n'est appliquée nulle part** : tant que
    ce n'est pas fait, la dégradation ci-dessus est le comportement permanent. Voir `TODO.md`.

## [Unreleased] - 2026-08-11
### Changed (lot 0 — coût en tokens d'entrée)

Mesures au ratio **3,5 caractères/token** (calibré sur les relevés de production du projet),
via `_measure.mts` étendu aux 3 agents complets — instructions + tous les tools tels que câblés
dans `src/mastra/index.ts`.

| Agent                    | avant | après | gain |
| ------------------------ | ----- | ----- | ---- |
| `onboardingOrchestrator`  | 1649  | 1458  | −191 |
| `questionnaireEngine`     | 1266  | 1120  | −146 |
| `notificationAgent`       | 1391  | 1238  | −153 |
| **Somme**                 | 4306  | 3816  | **−490** |

- **Tool-results bornés et projetés** — le plus gros gain du lot.
  `getEmployeeProfile` rendait `tasks` **non borné**, avec les 19 champs de l'entité `Task`.
  Sur 12 tâches en base : **2 506 → 329 tokens** par appel. Nouveau
  `application/mappers/task-summary.mapper.ts` (`MAX_TASKS_IN_RESULT = 5`, projection sur
  `id/title/status/priority/dueDate`), appliqué à `getEmployeeProfile` **et** `getTaskList`.
  - La taille du résultat est désormais **indépendante du nombre de tâches** (verrouillé par test).
  - Troncature **signalée** (`totalTasks` / `shown`) : sans ces compteurs le modèle conclut qu'il
    a vu toute la liste. `getTaskList` filtre **avant** de tronquer, pour que `totalTasks` compte
    les tâches correspondant à la demande.
  - Effet de bord de sécurité : `metadata` et `description` ne partent plus dans le contexte du
    LLM. Même raisonnement que la projection du profil employé (commit `889ab66`), qui est
    **étendue, pas remplacée** — `progress` est projeté à son tour.
- **Blocs STYLE et ANTI-INVENTION factorisés** dans `src/shared/agent-style.ts`.
  ⚠️ La factorisation n'économise **aucun** token à l'exécution (chaque agent envoie quand même
  le bloc) : elle sert la maintenance. Le gain vient du **raccourcissement** — bloc STYLE
  ~170 → 80 tokens sur chacun des 3 agents. Le texte peut rester bref sur la mise en forme parce
  que le vrai garde-fou est du code : `sanitizeAgentOutput` convertit déjà markdown → mrkdwn et
  retire les emojis.
- **« URL / lien / chemin de fichier » ajouté à la liste ANTI-INVENTION.** La liste nommait
  « prénom, nom, email, identifiant, date, score » mais pas les URL : c'est le trou par lequel est
  passé le faux lien `https://kisso.internal/docs/<uuid>/download`.
- **Consigne documents sur l'orchestrateur** : `generateDocument` **enregistre** le document et ne
  rend ni fichier ni URL. Voir la note « livraison de PDF » dans `TODO.md` — la capacité attendue
  côté produit n'existe pas encore.
- **Instructions métier dégraissées** : elles ré-énuméraient les noms des tools, que le modèle
  reçoit déjà via les schémas. Les garde-fous issus de régressions réelles sont tous conservés
  (création d'employé impossible, résolution par email d'abord, déduplication par l'historique).
- **Schémas allégés** : `scheduleReminder` 232 → 183 tokens, `generateDocument` 212 → 172. Seuls
  des `.describe()` redondants avec le nom du champ ont été retirés — **aucun champ ni aucune règle
  de validation n'a bougé**. `format` est conservé sur `generateDocument` malgré son enum coûteux :
  c'est le seul point d'entrée par lequel un document pourra être demandé en `pdf`.

## [Unreleased] - 2026-08-11
### Added (lot 1 — mémoire conversationnelle)
- **Feature `conversation`** (`src/features/conversation/`), **sans `@mastra/memory`** :
  ce paquet dépend de `zod ^4.4.3` alors que le projet épingle `3.25.76` (le parseur de schémas
  du Vercel AI SDK casse au-delà), et surtout il ne sait plafonner qu'en **nombre de messages** —
  inadapté quand un seul retour d'outil pèse 979 tokens. Décision D2 de
  `docs/superpowers/specs/2026-08-11-memoire-conversationnelle-design.md`.
  - `domain/entities/conversation-turn.ts` — un tour = un message. **Texte seul** : jamais de
    tool-call ni de tool-result (décision D3, levier de −63 % sur la fenêtre).
  - `domain/value-objects/conversation-id.ts` — `deriveConversationId({ channel, threadTs })` :
    `threadTs ? \`${channel}:${threadTs}\` : channel`. En DM `threadTs` est `undefined` **par
    conception** (threader un DM avait rendu le bot silencieux), donc la clé est le canal `D…` ;
    en canal l'appelant passe `thread_ts ?? ts`, donc un thread est une conversation.
  - `domain/services/token-window.ts` — `selectWindow(turns, budgetTokens)` : fenêtrage **en
    tokens, jamais en messages**. Parcours du plus récent au plus ancien, rendu chronologique.
    Une **paire `user`/`assistant` n'est jamais coupée** (un assistant orphelin répondrait à une
    question invisible pour le modèle — pire que pas de mémoire). Un tour dépassant **40 % du
    budget est tronqué**, pas exclu, sinon un message géant avale la fenêtre. Constantes
    `CHARS_PER_TOKEN = 3.5` (calibré : en-tête de sécurité 1308 car. ≈ 374 tok mesurés en prod)
    et `CONVERSATION_TOKEN_BUDGET = 1000` (1253 réellement disponibles à K=3 sur
    `onboardingOrchestrator`, 20 % de marge pour l'incertitude ±10 % du ratio).
  - `domain/ports/conversation.repository.ts` — `append` / `recentTurns` / `prune`, plus
    `CONVERSATION_TTL_MS = 60 min`, **TTL unique** gouvernant mémoire ET routage collant (D1).
  - `infrastructure/repositories/` — implémentation Drizzle et doublure `in-memory`.
- **Table `conversation_turns`** dans `src/infrastructure/database/schema.ts`, index
  `(conversation_id, created_at)`. L'agent « collant » est l'`agent_id` du dernier tour : la
  requête de fenêtre le ramène déjà, pas de seconde table.
  - Écart assumé au style des 10 autres tables : `created_at` est un **INTEGER en millisecondes**
    (`mode: 'timestamp_ms'`) et non le `TEXT` `datetime('now')` habituel, dont la résolution à la
    seconde mettrait à égalité deux messages d'un même échange et rendrait l'ordre chronologique
    indéterminé — or c'est cet ordre dont dépend `selectWindow`.
  - DDL à appliquer **à la main** : `scripts/ddl-conversation-turns.sql`. Ni `npm run db:push`
    (se bloque indéfiniment contre une base `libsql://` distante) ni `npm run db:generate` (les
    migrations `drizzle/` sont désynchronisées de `schema.ts` et drizzle-kit exige un vrai TTY).

## [Unreleased] - 2026-08-08
### Changed (perf — coût en tokens d'entrée)
- **Réduction du coût en tokens système/tools des 3 agents**, `notificationAgent` en priorité :
  mesuré en production à 7 849 tokens d'entrée pour un message trivial (« ok »), au-dessus du
  plafond Groq (12 000 tokens/minute) dès qu'un flux fait plusieurs allers-retours d'outils.
  Méthode de mesure : `zodToJsonSchema` de `@mastra/schema-compat` (la même fonction utilisée en
  interne par Mastra) appliquée à chaque `inputSchema`, plus `agent.getInstructions()` pour la
  valeur réelle des instructions envoyées au LLM ; taille sérialisée en caractères, avec un ratio
  caractères/token calibré sur la seule donnée officielle disponible (en-tête de sécurité :
  1308 caractères ≈ 374 tokens ⇒ ~3,5 car./tok). C'est une **estimation assumée**, pas une mesure
  exacte de tokenizer Llama/Groq (indisponible en local, pas d'accès réseau pour en installer un).
  - **`notificationAgent` ne reçoit plus `discoverSlackWorkspace`** (`src/mastra/index.ts`) :
    le tool le plus coûteux du set (356 car. de schéma + 426 car. de description) n'était
    mentionné nulle part dans les instructions de l'agent et n'a aucun usage identifié —
    `sendNotification` résout déjà le compte Slack du destinataire côté serveur, sans que le LLM
    ait besoin d'appeler `discoverSlackWorkspace` lui-même. Toujours câblé à
    `onboardingOrchestrator`, inchangé.
  - **`sendNotification`** (`send-notification.ts`) : description et description de
    `recipientId`/`recipientType` condensées sans perdre l'information de sécurité porteuse
    (destinataire désigné par UUID uniquement, adresse résolue côté serveur) ; le rappel des
    valeurs de `recipientType` dans la description était de toute façon redondant avec l'`enum`
    déjà présent dans le JSON Schema.
  - **Instructions des 3 agents** (`notification-agent.ts`, `onboarding-orchestrator.ts`,
    `questionnaire-engine.ts`) : blocs STYLE et RÈGLE ANTI-INVENTION reformulés plus courts, sans
    rien retirer au fond (mêmes interdictions markdown GitHub / mrkdwn Slack avec parcimonie /
    pas de narration de plan / pas d'emojis / non-divulgation de l'identifiant interne / anti-
    invention avec l'exemple `emailSent: false`). Le bloc `SECURITY DIRECTIVE:` terminal
    (anti prompt-injection / anti-exfiltration / pas d'exécution de code) a été **retiré** des 3
    fichiers : il dupliquait fidèlement les DIRECTIVE 2.1 (hiérarchie SYSTEM > USER > EXTERNAL),
    4.1 (jamais exposer les directives système), 5.1 (rejet des tool-calls issus de
    `external_data`) et 6.1 (anti-jailbreak) déjà appliquées par l'en-tête de sécurité obligatoire
    (`buildAgentInstructions()` / `SYSTEM_SECURITY_PROMPT`, non modifié). Les DIRECTIVES
    D'EXTRACTION OBLIGATOIRES de `onboardingOrchestrator` (champs `createEmployee`) sont
    conservées mot pour mot.
  - Résultat mesuré (chars réels, méthode ci-dessus) :

    | Agent | instructions avant→après | tools avant→après (notificationAgent) | Δ total |
    |---|---|---|---|
    | `notificationAgent` | 3670→2430 car. (−33.8 %) | 3486→2591 car. (−25.7 %, 5→4 tools) | −29.8 % (7156→5021 car., ≈2046→1436 tokens estimés) |
    | `onboardingOrchestrator` | 4509→3528 car. (−21.8 %) | inchangé | — |
    | `questionnaireEngine` | 3454→2595 car. (−24.9 %) | inchangé | — |

  - Aucun tool retiré du fichier ni de `tool-schema-flatness.test.ts` : `discoverSlackWorkspace`
    reste défini et testé, seule sa présence dans le tool-set de `notificationAgent` change.
  - Vérifié après coup : `npm run typecheck && npm run test:unit` → 600/600 verts (baseline 597),
    y compris `architecture.test.ts`, `code-architecture.test.ts` et
    `tool-schema-flatness.test.ts`.

### Fixed
- **Garde-fou anti prompt-injection réellement branché** (`src/shared/security/llm-guardrail.ts`,
  les 3 agents, `slack-events.handler.ts`). Constat : `wrapUserInput()`, `wrapExternalData()` et
  `assembleSecurePrompt()` n'étaient appelés QUE par les tests ; les 3 agents important la
  constante brute `SYSTEM_SECURITY_PROMPT` envoyaient au LLM un prompt contenant les littéraux
  non substitués `{DELIMITER_PREFIX}` et `[[SESSION_MARKER]]` (visible publiquement via
  `GET /api/agents`), et le texte Slack partait tel quel dans `agent.generate()`, sans
  encadrement.
  - Nouvelles fonctions exportées `buildAgentInstructions()` et `wrapAgentInput()` dans
    `llm-guardrail.ts` : la première assemble l'en-tête de sécurité avec ses placeholders
    réellement substitués (via `SystemPromptVault` + `SessionManager`) puis les instructions
    métier ; la seconde encadre un message avant `agent.generate()`, avec le MÊME
    sessionId/SessionManager que la première (cohérence du `tagPrefix` annoncé dans les
    DIRECTIVE 3.1/3.2).
  - Marqueur de session tiré aléatoirement **une fois par processus** au démarrage : les
    `instructions` d'un `Agent` Mastra sont figées à la construction, donc un marqueur par
    requête n'est pas possible sans reconstruire l'agent à chaque message (voir commentaire
    de section 11 dans `llm-guardrail.ts` pour la justification complète et le compromis
    assumé).
  - `slack-events.handler.ts` passe désormais le texte Slack par `wrapAgentInput()` avant
    `agent.generate()`.
  - Bug latent corrigé au passage : `KeyManager.KEY_ITERATIONS = 100000` n'est pas une
    puissance de 2 — `scryptSync` l'exige et aurait levé `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`
    dès qu'un `KeyManager` réel (masterSecret, pas injecté) était instancié. Masqué jusqu'ici
    car rien n'instanciait `KeyManager` en dehors des tests (qui injectent leur propre
    `keyManager`). Corrigé à `16384` (2^14, minimum RFC 7914 pour un usage interactif).
- **Réponses Slack en DM ne sont plus enfouies dans un thread** (`slack-events.handler.ts`,
  `handleMessage`). `thread_ts = thread_ts ?? ts` threadait systématiquement, y compris en DM
  où ça masque la réponse hors de la conversation principale — le bot a semblé silencieux
  pendant des heures en production pour cette raison. Un DM ne threade désormais QUE si le
  message d'origine faisait déjà partie d'un thread (`thread_ts` présent et différent de `ts`).
  Les mentions en canal continuent de threader systématiquement (comportement inchangé).
- **Diagnostic de la bascule Groq → Mistral clarifié** (`src/shared/llm/model-fallback.ts`).
  Symptôme en production : `POST /api/agents/:id/generate` → `HTTP 500
  {"error":"Rate limit exceeded"}`. Vérifié empiriquement (agent réel, clé Groq invalide puis
  les deux clés invalides — script jetable, non versionné) : **la bascule fonctionne bien** ;
  ce n'était pas un bug de la chaîne elle-même. Le vrai problème était l'observabilité : Mastra
  émet deux logs `Upstream LLM API error` distincts, et celui de fin de run
  (`agent-Dj30gJa3.js:29829-29842`) lit `provider`/`modelId` via `capabilities.llm.getModel()`,
  qui retourne inconditionnellement le PREMIER modèle de la chaîne (`#firstModel`,
  `agent-Dj30gJa3.js:26004-26010`) — jamais celui qui a réellement produit l'erreur. Il peut
  donc attribuer l'échec du DERNIER maillon (ex. Mistral) au PREMIER (Groq) — reproduit dans
  `tests/unit/shared/model-fallback-chain-logging.test.ts` :
  `{ error: <échec mistral.chat>, provider: 'groq.chat', modelId: 'llama-3.3-70b-versatile' }`.
  C'est ce qui a fait perdre du temps en diagnostic : impossible de savoir, à la seule lecture du
  log, quel fournisseur avait réellement échoué.
  - Nouvelle fonction exportée `withChainFailureLogging()` : enveloppe chaque modèle de la
    chaîne (`Proxy` sur `doGenerate`/`doStream`) pour journaliser, via `src/shared/logger`
    (JSON structuré, PII masquée, respecte `LOG_LEVEL`), le `chainId`/`provider`/`modelId`
    **du maillon qui vient réellement d'échouer**, puis relance l'erreur inchangée — aucun
    changement de comportement pour Mastra, uniquement une observation fiable en plus,
    indépendante de la configuration du `logger` passé (ou non) à `new Agent()`.
  - La politique `maxRetries` existante (0 sur les maillons non terminaux, 1 sur le dernier) a
    été relue à la lumière du comportement réel de Mastra 1.57.0 (`executeStreamWithFallbackModels`,
    `agent-Dj30gJa3.js:23206` ; `shouldThrowError: !isLastModel`, `agent-Dj30gJa3.js:23578` ;
    `retries: modelSettings?.maxRetries ?? 2`, `agent-Dj30gJa3.js:22123`) : elle était déjà
    correcte, aucun changement de valeur.
  - Limites qui subsistent, documentées dans l'en-tête du fichier : si Mistral échoue aussi
    (429/5xx), l'erreur brute de Mistral remonte quand même au client (juste journalisée
    correctement désormais) — il n'y a pas de 3ᵉ maillon. Le basculement n'est jamais filtré par
    classe d'erreur : une erreur `context_length_exceeded` déclenche aussi l'essai de Mistral,
    utile seulement si sa fenêtre de contexte est plus grande.

### Changed
- **Style des réponses des 3 agents** (`onboarding-orchestrator.ts`, `questionnaire-engine.ts`,
  `notification-agent.ts`) : instructions métier réécrites pour imposer un français direct et
  concis, l'interdiction du markdown GitHub (`**gras**`, `###`, `---` — non rendu par Slack,
  affiché littéralement), le mrkdwn Slack avec parcimonie, l'absence de narration du plan
  interne ("Étape 1...", "Prochaines étapes"), et la non-divulgation de l'identifiant interne
  (« KISSO-AGENT-v3 », visible dans le bloc sécurité) à l'utilisateur. Les directives
  fonctionnelles (extraction obligatoire des champs `createEmployee`, etc.) et le bloc sécurité
  sont conservés intégralement.
  - Nouvelle règle explicite anti-invention : interdiction d'affirmer qu'une action a réussi
    sans confirmation du résultat du tool (notamment `emailSent: false` avec `status: 'success'`
    global — piège documenté dans `CLAUDE.md`), et interdiction d'inventer une donnée absente
    (nom, email, identifiant) — la demander à l'utilisateur à la place.

### Added
- **Tool `findEmployeeByEmail`** (`src/features/employee/application/tools/find-employee-by-email.ts`) :
  résout un employé à partir de son email professionnel. Corrige un trou fonctionnel observé en
  production — trace réelle : « Récupère les informations concernant Karyl SOUMAILA » → l'agent
  `onboardingOrchestrator` n'avait aucun tool pour passer d'un nom/email à un ID d'employé, se
  rabattait sur l'annuaire Slack, obtenait un ID Slack (pas un UUID), échouait à nouveau, et
  finissait par redemander manuellement département/poste/date de début à l'utilisateur. Aucun
  outil de résolution par email n'existait alors que `EmployeeRepository.findByEmail()` (port +
  implémentations Drizzle/in-memory) existait déjà et était simplement inutilisé par les tools.
  - Recherche insensible à la casse et robuste aux espaces parasites (normalisation
    trim + lowercase, en plus de `emailSchema` qui le fait déjà côté schéma).
  - Retourne `{ found: false }` — jamais une exception — quand l'email est inconnu :
    c'est précisément l'absence de ce comportement qui faisait dérailler l'agent
    (boucle d'erreurs `NotFoundError` → abandon → re-question à l'utilisateur).
  - Exposition volontairement minimale (audit sécurité : tout membre du workspace peut
    déclencher les tools) : uniquement `id`, `firstName`, `lastName`, `status`. Ni email,
    ni salaire, ni contact d'urgence, ni téléphone, ni métadonnées — voir commentaire du
    fichier. Le détail complet reste derrière `getEmployeeProfile(employeeId)`.
  - Câblé dans `src/mastra/index.ts` uniquement, dans la liste de tools de
    `onboardingOrchestrator` (le déclenchement observé en prod passait par cet agent, route
    par défaut de `slack-events.handler.ts`). Couvert par
    `tests/unit/tools/find-employee-by-email.test.ts` (TDD) et ajouté à
    `tests/unit/tools/tool-schema-flatness.test.ts`.

## [0.9.0] - 2026-08-07
### Added
- **Endpoint Slack Events monté** : `POST /slack/events`, déclaré dans `server.apiRoutes` de
  `src/mastra/index.ts` via `registerApiRoute()`. Jusqu'ici `src/api/slack-events*.ts` était du
  **code mort** — Mastra ne monte pas `src/api/` automatiquement et `index.ts` n'avait aucun bloc
  `server` : `POST /api/slack-events` répondait 404, ce qui explique le bot silencieux.
- **Vérification de signature Slack** (`src/shared/security/slack-signature.ts`) : HMAC-SHA256 sur
  `v0:{timestamp}:{rawBody}`, comparaison à temps constant (`timingSafeEqual`), fenêtre anti-rejeu
  de 5 minutes, **fail-closed** si `SLACK_SIGNING_SECRET` est absent. Vérifié en live :
  `url_verification` signé → `200 {"challenge":…}` en 2,4 s ; non signé → `401 missing_signature_headers`.
- **ACK Slack sous 3 s** : réponse immédiate, traitement de l'agent déporté en tâche de fond.
- **Déduplication des rejeux** Slack sur `event_id` (cache LRU en mémoire).
- **`SmtpAdapter`** (`nodemailer`) et sélecteur `createEmailProvider()` : SMTP dès que
  `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` sont tous renseignés, sinon repli Brevo.
- **ADR-006** — `docs/adr/006-fournisseur-email-smtp.md` : justification du passage à SMTP.

### Changed
- **Fournisseur email : Brevo → SMTP (Gmail).** `BREVO_API_KEY` est valide (`GET /v3/account` → 200)
  mais `POST /v3/smtp/email` renvoie `403 permission_denied` — *"Your SMTP account is not yet
  activated"* : blocage au niveau **compte**, reproduit même avec l'expéditeur validé, donc
  incontournable par configuration. Un email réel a été délivré via SMTP (`250 OK`).
- **Base Turso de production** : elle ne contenait **aucune** table applicative (uniquement 38 tables
  internes `mastra_*`), le bot déployé ne pouvait rien persister. `drizzle-kit push` se bloquant
  contre un `libsql://` distant, le DDL a été exporté depuis `schema.ts` et appliqué directement —
  **10 tables, 69 index, `employees` avec ses 20 colonnes**.
- `docs/SLACK_BOT_SETUP.md` : variables d'environnement réelles (SMTP au lieu de `RESEND_API_KEY`),
  et section dépannage étendue (freeze serverless, 401 de signature, double réponse, dédup).

### Fixed
- **Fuite de secret dans les logs** : `console.log('DEBUG ENV', { brevo: process.env.BREVO_API_KEY })`
  dans `src/mastra/index.ts` imprimait une clé API vivante. Remplacé par `hasBrevoKey: Boolean(…)`.
- **Configuration de l'app Slack** (côté Slack, pas côté code) : Socket Mode était activé — il est
  mutuellement exclusif avec la Request URL HTTP, Slack n'envoyait donc **aucune** requête — et
  `app_mention` n'était pas abonné, alors que le handler ne sert les mentions en canal que par cet
  événement. Request URL désormais « Verified ».
- **Faux positif de routage mot-clé** : `routeToAgent()` matchait `test` par sous-chaîne
  (`String.includes`), donc capturé par n'importe quel mot français contenant "test" ailleurs
  qu'en début de mot — "je conteste cette décision", "peux-tu attester de mon poste",
  "contestation", "protestation" partaient à tort vers `questionnaireEngine` au lieu du routage
  par défaut. Le matching exclut désormais un mot-clé immédiatement précédé d'une lettre
  (regex `(?<![\p{L}])`), sans toucher aux mots-clés eux-mêmes ni aux suffixes (pluriels,
  conjugaisons continuent de matcher). 6 tests ajoutés dans
  `tests/unit/handlers/slack-events.handler.test.ts`.

### Known issues
- `drizzle/0000_*.sql` déclare `employees` avec 11 colonnes contre 20 dans `schema.ts` : l'historique
  de migration n'est pas rejouable sur une base vierge. `npm run db:generate` est interactif et doit
  être relancé dans un vrai TTY.
- Traitement en tâche de fond **non testé en serverless** : Vercel peut geler la fonction dès l'ACK et
  tuer l'appel LLM en vol (symptôme « le bot ACK mais ne répond jamais »). Correctif durable : file
  durable (`inngest` déjà installé).
- La dédup LRU est **par instance** : elle ne protège pas d'un traitement double entre instances.
- Envoyer au nom de « Kisso » depuis une adresse `@gmail.com` dégrade la délivrabilité ; un domaine
  vérifié (SPF/DKIM/DMARC) reste le correctif propre.

## [0.1.3] - 2026-08-05
### Changed
- Migration de `better-sqlite3` vers `@libsql/client` (Turso).
- Architecture de déploiement orientée Serverless avec l'ajout de `@mastra/deployer-vercel`.
- Mise à jour de toutes les dépendances `@mastra/*` en version `1.56.0` (latest).
- Suppression du `Dockerfile` et de la configuration Fly.io.

## [0.8.0] - 2026-08-03
### Added
- **Slack Workspace Discovery** : port `SlackWorkspaceProvider`, `SlackWorkspaceService`, tool `discoverSlackWorkspace` (channels, members, invite).
- **PDF Generation** : `PdfmakeService` (pdfmake 0.3) avec templates contrat, lettre de bienvenue, certificat et guide.
- **Employee Onboarding** : étape Slack best-effort (find by email + invite channel) câblée au workflow.
- **Tests** : couverture unitaire tool/service Slack, PdfmakeService (4 templates), workflows `employee-onboarding` et `document-generation`.

### Fixed
- **PdfmakeService** : adaptation API pdfmake 0.3 (`createPdf` + VFS Roboto) — l’ancienne API `PdfPrinter` était incompatible.
- **document-generation** : sortie `documentPath` (chemin local) au lieu de `documentUrl` (URL invalide pour un fichier local).
- **createEmployee tests** : alignement sur le comportement réel (`ConflictError` thrown, validation UUID idempotency).

## [0.7.0] - 2026-07-31
### Fixed
- **TypeError in `validation.ts`**: Fixed `createEmployeeSchema.extend is not a function` (and identical bugs in `createTaskSchema`, `createNotificationSchema`, `createQuestionnaireSchema`). Root cause: `.refine()` wraps `z.object` in a `ZodEffects` which has no `.extend()` method. Fix: extract bare `z.object` bases as non-exported consts (`createEmployeeBaseSchema`, `createTaskBaseSchema`, `createNotificationBaseSchema`, `createQuestionnaireBaseSchema`); use `.extend()`/`.partial().extend()` on the bases, keep `.refine()`-wrapped versions as exports.

## [0.6.0] - 2026-07-30
### Added
- **Stratégie de Test & Tests de Sécurité** : Création de la liste de 500 tests (Test Strategy).
- **Implémentation de la Suite 1 (Sécurité)** : Tests unitaires de `llm-guardrail.ts` avec succès (15 tests contre Prompt Injection, Fuite de données, Token Flooding). Correction de la regex d'extraction des secrets.
- **Planification des bonnes pratiques** : Consolidation des décisions architecturales suite à l'analyse des agents.
- **Sécurité & Qualité** : Plan d'implémentation ajouté au `TODO.md` (RBAC, AuditLogs, ESLint, Prettier, CI/CD).

## [0.1.0] - 2026-07-28
- Architecture validée : 3 agents (OnboardingOrchestrator, QuestionnaireEngine, NotificationAgent), 8+ outils, 4 workflows.
- Planification complète du développement avec 8 tâches priorisées.

## [0.5.0] - 2026-07-29
### Added
- **Base de Données (Phase 8)** : Implémentation complète de Drizzle ORM avec `better-sqlite3`.
- **Infrastructure (Repositories)** : Remplacement de tous les mock repositories (InMemory) par des implémentations Drizzle ORM pour (`employee`, `task`, `document`, `notification`, `questionnaire`, `response`, `onboarding`).
- **Clean Architecture** : Respect strict du principe d'inversion des dépendances (les repositories `drizzle` implémentent les ports du domaine sans polluer les entités).
- **Scripts** : Ajout de `db:generate` et `db:push` dans le `package.json` pour la gestion des migrations avec Drizzle Kit.

## [0.4.0] - 2026-07-29
### Added
- **LLM Security Gateway** : Mise en place d'une architecture de défense de classe mondiale contre 30 vecteurs d'attaques LLM (OWASP, Injection directe/indirecte, Exfiltration, RAG Poisoning).
- **Guardrails** : Création de `prompt-defense.ts` et `llm-guardrail.ts` pour filtrer les entrées et sorties (Egress Filtering) et empêcher l'évasion des modèles (Token Flooding, Jailbreak).
- **Blindage des Agents** : Intégration du `SYSTEM_SECURITY_PROMPT` bloquant toute tentative de "Persona Override" et "Goal Hijacking".

## [0.3.1] - 2026-07-29
### Added
- Sécurisation des LLM : Ajout de directives Anti-Prompt Injection dans les agents Mastra.
- Amélioration de la qualité de code : Remplacement des erreurs génériques par `ValidationError` et `ConflictError`.
- TypeScript strict : Remplacement des derniers types `any` par `unknown`.
- Versioning initial : Dépôt local Git initialisé et commit des phases de Clean Architecture et de Sécurité.

## [0.3.0] - 2026-07-29
### Added
- Refonte complète de l'architecture selon les principes de Clean Architecture (Screaming Architecture / Bounded Contexts).
- Purification du domaine : retrait total de Zod des entités, création du Value Object `Email`, classes immuables avec `readonly`.
- Interfaces et Adaptateurs : `EmailProvider` (implémenté via `ResendAdapter`) et `ChatProvider` (implémenté via `SlackAdapter`).
- Logs JSON structurés avec obfuscation automatique des PII (ex: adresses e-mail masquées).

## [0.2.0] - 2026-07-29
### Added
- Implémentation des 4 workflows Mastra (`employeeOnboardingWorkflow`, `questionnaireCycleWorkflow`, `notificationCycleWorkflow`, `documentGenerationWorkflow`) en conformité avec l'API v1.53.0 (méthodes `createStep` et `.then()`).
- Définition stricte des schémas d'entrée/sortie (`inputSchema`, `outputSchema`) avec Zod pour les workflows.
- Export et enregistrement des workflows dans l'instance centrale Mastra.
- 3 agents Mastra (`OnboardingOrchestrator`, `QuestionnaireEngine`, `NotificationAgent`) configurés avec leurs outils respectifs.
- 10 outils Mastra fonctionnels avec signatures compatibles `@mastra/core` v1.53.0.
- Intégration API Resend pour l'envoi d'e-mails réels.
- Intégration Slack Web API pour l'envoi de messages Slack.
- Installation d'Inngest pour la planification de tâches asynchrones.
- Typecheck complet : 0 erreur TypeScript.

### Changed
- `send-notification.ts` : logique réelle multi-canal (Email via Resend, Slack via `@slack/web-api`, InApp en base).
- `.env.example` nettoyé (SMTP retiré, Resend/Inngest ajoutés, clés API retirées).
- `src/config/index.ts` : remplacé SMTP par Resend.
- `src/mastra/index.ts` : stubbé en attendant les étapes 6-7.

## [0.1.2] - 2026-07-29
### Added
- Composants partagés (types et interfaces métier).
- Validation de données via Zod (employé, questionnaire, notification, tâches).
- Gestion centralisée des variables d'environnement.
- Documentation d'architecture (`docs/guides/onboarding.md`).

## [0.1.1] - 2026-07-29
### Ajouté
- Structure des dossiers (Clean Architecture) initialisée dans `src/`, `docs/`, `tests/`.
- Installation des dépendances IA : `@ai-sdk/openai`, `@ai-sdk/google`.
- Rédaction des ADRs initiaux (001 à 005) dans `docs/adr/`.
- Fichier `.env` initialisé à partir de `.env.example`.

### Modifié
- Configuration `tsconfig.json` mise à jour pour éviter le warning de dépréciation de `baseUrl`.
- **Note** : La vérification TypeScript (`npm run typecheck`) échoue actuellement en raison d'un changement de signature de l'API `@mastra/core` (version 1.53.0) dans les outils existants. Les corrections seront apportées lors de l'étape 5 (Développer les outils Mastra).
