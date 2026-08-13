# Parcours d'arrivée d'un nouvel employé

**Date** : 2026-08-13
**État** : validé, prêt pour le plan d'implémentation

## Intention

Quand une personne rejoint le workspace Slack, le système doit :

1. récupérer tout ce que Slack sait d'elle — prénom, nom, email, identifiant ;
2. lui envoyer un message direct de bienvenue, avec une invitation à compléter son
   profil où **seul le poste est demandé** — ni département, ni date de début ;
3. l'inviter dans une liste définie de canaux publics, **dès son arrivée**.

## État actuel — ce qui existe, ce qui manque

| Pièce | État |
| --- | --- |
| `handleTeamJoin` (`slack-events.handler.ts:1795`) | existe |
| `resolveNewcomer` (`:1829`) — prénom, nom, email avec repli `users.info`, ID Slack | existe, complet |
| `buildWelcomeBlocks` (`:837`) — DM + bouton « Compléter mon profil » | existe |
| Modale (`profile-modal.ts:169`) | existe, mais **6 champs** dont département et date de début |
| `employeeOnboardingWorkflow` → `createEmployee` | existe |
| Étape `slackInvite` du workflow | existe, mais reçoit **toujours** `slackChannelId: null` |
| Invitation de l'arrivant dans des canaux | **n'existe pas** |
| Écriture de l'arrivant dans `slack_directory` au `team_join` | **n'existe pas** — l'annuaire n'apprend une personne qu'au premier message qu'elle envoie |

⚠️ **`resolveNewcomer` ne lit pas `profile.title`.** C'est cohérent avec l'intention : le
poste est ce qu'on demande à la personne, pas ce qu'on devine.

## Prérequis hors code — bloquants

**`team_join` doit être abonné dans *Event Subscriptions*, puis l'app RÉINSTALLÉE.**
Le code le gère (`SUPPORTED_EVENT_TYPES`, `slack-events.handler.ts:260`) et
`docs/SLACK_BOT_SETUP.md:54` le marque REQUIS, mais la liste des abonnements réels
recensée dans `CLAUDE.md` ne le contient pas. Si c'est exact, `handleTeamJoin` est du
code mort et **rien de ce parcours ne se déclenche**. L'ajout seul ne propage rien —
seule la réinstallation le fait, piège déjà payé le 2026-08-08.

Scopes requis, tous déjà accordés : `channels:manage` (inviter dans un canal public),
`channels:join`, `users:read`, `users:read.email`, `im:write`, `chat:write`.

## Le parcours

### 1. Capture

`team_join` → `resolveNewcomer` (inchangé) rend `{ slackUserId, firstName, lastName, email }`.

**Ajout** : écrire immédiatement dans `slack_directory` via `DirectoryRepository.upsertFacts`.
La personne devient résolvable par `findEmployeeByEmail` dès la seconde zéro, sans attendre
qu'elle écrive un premier message.

L'instant du `team_join` est retenu comme **date d'arrivée**. Ce n'est pas une valeur de
remplissage : c'est le fait que Slack vient d'annoncer. Il est transporté jusqu'à la modale
dans le `value` du bouton, aux côtés du préremplissage existant.

### 2. Message direct de bienvenue

`buildWelcomeBlocks`, enrichi de la liste des canaux effectivement rejoints. Le bouton
« Compléter mon profil » transporte `{ slackUserId, firstName, lastName, email, joinedAt }`.

Le DM part **indépendamment** du résultat des invitations : un échec d'invitation ne doit
jamais priver l'arrivant de son message de bienvenue.

### 3. Invitation aux canaux publics

Nouveau service à responsabilité unique, dans `features/directory/application/services/`.

- Entrée : `ONBOARDING_WELCOME_CHANNELS`, liste de **noms** de canaux en configuration.
  Des noms et non des identifiants : c'est ce qu'un humain sait écrire et relire.
- Résolution nom → identifiant via l'inventaire `slack_channels` déjà en base, avec repli
  `conversations.list` quand l'inventaire ne connaît pas le canal.
- Pour chaque canal : `conversations.invite({ channel, users })`.

Traitement des erreurs, nommé et non générique :

| Erreur Slack | Traitement |
| --- | --- |
| `already_in_channel` | **succès** — l'objectif est atteint |
| `not_in_channel` | le bot n'est pas membre → `conversations.join`, puis nouvel essai |
| `channel_not_found` | journalisé en `error`, les autres canaux continuent |
| toute autre | journalisée en `error`, les autres canaux continuent |

L'ensemble est *best-effort*. Un canal en échec n'interrompt jamais la boucle.

### 4. Modale — un seul champ demandé

`profile-modal.ts` perd le sélecteur **Département** et le sélecteur de **date de début**.

Restent :

- **Poste** — le seul champ réellement demandé ;
- email, prénom, nom, préremplis depuis Slack et **laissés éditables** : le profil Slack est
  parfois vide ou faux, et l'email conditionne toute la suite (résolution, envois, documents).

### 5. Création de l'employé

Soumission → `employeeOnboardingWorkflow`, structure inchangée.

- `position` ← le champ de la modale.
- `startDate` ← la date d'arrivée capturée au `team_join`.
- `department` ← **jamais renseigné**.

## Modèle de données et migration

`employees.department` est `NOT NULL` (`schema.ts:31`) et l'entité `Employee`
(`employee.ts:8`) l'exige. Il doit devenir facultatif des deux côtés.

SQLite n'a pas d'`ALTER COLUMN` : rendre la colonne nullable impose une **reconstruction de
table** (créer, copier, supprimer, renommer). C'est retenu malgré le coût, plutôt qu'une
valeur sentinelle :

- la production ne contient **qu'une seule ligne vivante**, la migration est donc sans risque ;
- `NULL` est le seul encodage honnête de « on a délibérément cessé de collecter ça » ;
- une sentinelle dans une colonne `NOT NULL` finit toujours par être relue comme une vraie
  valeur — c'est le mode d'échec récurrent de ce dépôt (`emailSent: false` sous
  `status: 'success'`, `documents.content` perdu en silence, `status = Sent` posé avant le
  `try`, `evaluateResponse` fabriquant des réponses).

⚠️ **Ordre imposé : DDL d'abord, déploiement ensuite.** Une fois `department` retiré des
écritures, le code déployé avant la migration échouerait sur la contrainte `NOT NULL`.
L'index `idx_employees_department` est supprimé au passage : une colonne qu'on ne renseigne
plus n'a aucune raison d'être indexée.

`employees.onboarding_status` reste en l'état : colonne morte, sans lecteur ni écrivain
applicatif. Son retrait est un lot distinct.

## Configuration

| Variable | Rôle |
| --- | --- |
| `ONBOARDING_WELCOME_CHANNELS` | Noms de canaux publics, séparés par des virgules, où inviter tout nouvel arrivant. Vide ou absente ⇒ aucune invitation, et une ligne en `warn` — l'absence de configuration ne doit pas ressembler à un échec technique. |

## Tests

Doublure Slack en mémoire pour `conversations.invite` et `conversations.join` :

1. l'arrivant est invité dans les N canaux configurés ;
2. `already_in_channel` est compté comme un **succès**, pas comme une erreur ;
3. `not_in_channel` déclenche un `join` puis un second essai ;
4. un canal introuvable n'empêche pas les autres d'aboutir ;
5. l'échec **total** des invitations laisse partir le DM de bienvenue ;
6. `ONBOARDING_WELCOME_CHANNELS` absente ⇒ aucun appel Slack, une ligne en `warn` ;
7. la modale n'expose que le poste comme champ demandé — ni département, ni date ;
8. l'employé créé porte `department: null` et la date d'arrivée réelle ;
9. `team_join` écrit bien la personne dans `slack_directory`.

## Hors périmètre — décidé, pas oublié

- **Relance de celui qui ne complète jamais son profil.** Il reste connu de l'annuaire et
  présent dans les canaux, mais n'a ni dossier d'onboarding ni tâches. C'est le cas le plus
  fréquent aujourd'hui (cinq personnes sur six). Une relance exige un ordonnanceur, qui
  n'existe pas dans ce système — ni cron, ni poller.
- **Retrait complet de `department`** du schéma et de tous les fichiers qui le lisent
  (`onboarding-plan.ts`, `document-template.ts`, `employee.dto.ts`, `employee.mapper.ts`,
  l'entité, les tests). Le rendre facultatif suffit à l'intention ; le supprimer est un lot
  à part, chiffré à plusieurs dizaines de fichiers.
- **Création de l'employé dès l'arrivée** (approche écartée) : elle obligerait à rendre
  `position` nullable pour tout le monde afin de couvrir un état transitoire, et le problème
  qu'elle résoudrait — « le bot ne retrouve que mon profil » — est déjà réglé depuis le
  2026-08-12 par le repli de `findEmployeeByEmail` sur l'annuaire Slack.
