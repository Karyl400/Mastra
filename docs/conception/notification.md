# Feature `notification`

> Décisions de conception, extraites des commentaires du code le 2026-08-20.
> Périmètre : `src/features/notification/`
>
> Chaque entrée est ancrée sur la **déclaration** qu'elle précédait, jamais sur un numéro
> de ligne : l'audit du 2026-08-21 a mesuré 5 424 ancres `L.N` dont **153 exactes (2,8 %)**.
> Un numéro de ligne se périme au premier retrait de commentaire — c'est-à-dire aussitôt.
>
> Le code ne porte plus ce texte : **c'est ici qu'il vit désormais.**

---

## `features/notification/application/agents/notification-agent.ts`

**Avant `export function makeNotificationAgent(tools: ToolsInput) {`**

Le préambule a été resserré le 2026-08-11 pour financer la frontière négative
(`agentToolBoundary`) sans dépasser le FLOOR mesuré de l'agent. Le nom du tool
était cité en toutes lettres — `getNotificationHistory` — alors que la frontière
l'énumère déjà juste en dessous : la consigne se contente donc de dire QUAND
l'appeler, et « Ne spamme pas », qui n'ajoutait aucune règle vérifiable au
« pas de doublon » qui le précédait, a sauté.

La frontière corrige un défaut mesuré sur cet agent : en C6 il a proposé un
rappel « programmé pour lundi 9h » — il a bien `scheduleReminder`, mais il l'a
annoncé sans jamais l'appeler ; et en C1 il a réclamé un email pro alors
qu'AUCUN de ses tools ne consomme un email. L'énumération positive de ses outils
ne lui disait rien de ce qui manquait.

## `features/notification/application/tools/get-notification-history.ts`

**Avant `import { createTool } from '@mastra/core/tools';`**

Historique des notifications — outil exposé au LLM.

## Pourquoi une projection ET une borne

Ce tool renvoyait les lignes du repository TELLES QUELLES : 18 colonnes, `body` non
borné, et un `limit` par défaut à 50. Mesuré : **~10 223 tokens** pour 50 lignes.
Le plafond réel de Groq est de **100 000 tokens par JOUR** (les en-têtes de la
campagne du 2026-08-11 : `TPD: Limit 100000, Used 98207`) — un seul appel brûlait
donc 10 % de la journée entière, et le résultat restait ensuite dans l'historique de
TOUS les tours suivants, où il était repayé à chaque aller-retour.

C'est exactement le défaut corrigé pour `getEmployeeProfile` (2 506 → 329 tokens) et
jamais appliqué ici. Le remède est le même que celui appliqué alors aux tâches — un mapper de
projection dédié :

> ⚠️ Ce paragraphe citait `src/features/employee/application/mappers/task-summary.mapper.ts`,
> **supprimé le 2026-08-14** avec tout le suivi de tâches. La phrase était au PRÉSENT et
> renvoyait à un fichier absent ; corrigée le 2026-08-21. La technique, elle, reste celle
> décrite ci-dessous, et elle est vivante dans ce fichier même.

1. **BORNE** — au plus `MAX_NOTIFICATIONS_IN_RESULT` entrées, pour que la taille du
   résultat soit INDÉPENDANTE du nombre de notifications en base.
2. **PROJECTION** — on énumère ce qu'on expose plutôt que ce qu'on retire : une
   colonne ajoutée demain ne fuite pas toute seule. `body` en particulier ne sort
   JAMAIS — c'est le champ le plus lourd, et c'est le modèle lui-même qui l'a écrit :
   le lui renvoyer est un coût pur (même défaut que `documents.content`).
3. **SIGNALISATION** — `total` / `shown` disent que la liste est tronquée. Sans eux le
   modèle conclurait qu'il a tout vu.
4. **ORDRE** — il n'y en avait aucun : le repository rend les lignes dans l'ordre du
   `Map` ou de la base. Deux appels identiques pouvaient donner deux réponses
   différentes. On trie du plus récent au plus ancien.

Le paramètre `limit` a été retiré du schéma : il ne servait qu'à laisser le modèle
choisir combien on lui facture, il coûtait des tokens à chaque aller-retour, et la
borne doit être une propriété du serveur, pas une préférence du modèle.

**Avant `const NOT_AUTHORIZED_HINT =`**

Consigne rendue quand le demandeur n'a pas le droit de lire l'historique de cette personne.
Même rédaction que dans `get-employee-profile.ts` — une seule formulation, pour qu'elles ne
divergent pas.

**Avant `export const MAX_NOTIFICATIONS_IN_RESULT = 5;`**

Nombre maximal de notifications rendues.

Cinq suffit à la seule question réelle — « lui a-t-on déjà écrit à ce sujet ? »,
posée par les instructions de `notificationAgent` pour éviter les doublons.

**Avant `const SUBJECT_MAX_CHARS = 80;`**

 Au-delà, un objet n'apporte plus rien au modèle et coûte à chaque tour.

**Avant `export interface NotificationSummary {`**

Vue minimale d'une notification, telle qu'exposée au LLM.

Pas d'`id` : AUCUN tool de ce dépôt ne consomme un identifiant de notification.
Le rendre coûtait 36 caractères par ligne — le champ le plus lourd après le
sujet — pour une clé que le modèle ne peut que recopier.

**Avant `readonly status: string;`**

⚠️ PAS `NotificationStatus` : `scheduled` y est traduit — voir `honestStatus`. Le type
brut ferait croire qu'on rend l'énumération telle quelle, ce qui était précisément le
défaut.

**Avant `readonly at: string;`**

Date la plus significative : envoyée si elle l'a été, sinon prévue, sinon créée.
Un seul champ de date au lieu de quatre — le modèle n'a pas à arbitrer entre
`sentAt`, `scheduledAt`, `createdAt` et `updatedAt`.

**Avant `readonly total: number;`**

 Nombre total de notifications du destinataire, AVANT troncature.

**Avant `readonly shown: number;`**

 Nombre réellement présent dans `notifications`.

**Avant `function honestStatus(status: NotificationStatus): string {`**

Traduction du statut brut vers ce que le modèle doit en comprendre.

⚠️ **`scheduled` MENTAIT dès qu'il ressortait d'ici — défaut relevé le 2026-08-18.**
`scheduleReminder` neutralisait l'illusion dans son propre résultat, mais ce contre-poids
ne survivait pas au tour suivant : cet outil réexposait `status: 'scheduled'` BRUT, et le
modèle relisait une promesse tenue. La traduction posée alors disait
« enregistré, aucun envoi automatique ».

⚠️ **ET CETTE TRADUCTION EST DEVENUE FAUSSE DANS L'AUTRE SENS LE 2026-08-21**, jour où le
cron `/internal/reminders/dispatch` a été branché. Elle ne mentait plus par omission mais
par AFFIRMATION : elle niait explicitement un mécanisme qui tourne tous les matins à 6 h.
Un demandeur consultant son historique s'entendait dire qu'un rappel enregistré ne partirait
pas, alors qu'il partait le matin du jour dit. Corrigé le 2026-08-22.

⚠️ **C'est la troisième occurrence de la même forme** — après `READ_ONLY_TOOL_NAMES` gardant
`getTaskList` après son retrait, et `onlyNonDeliveringTools` gardant `scheduleReminder` après
le branchement du cron. **Un détecteur encode un CÂBLAGE ; quand le câblage bouge, il ne
devient pas inoffensif, il devient faux dans l'autre sens.**

D'où la forme actuelle : la phrase n'est plus RÉDIGÉE, elle est **DÉRIVÉE** de
`DISPATCHABLE_STATUSES` — la liste que `claimForDispatch` consomme réellement. Retirer un
statut du dispatch lui retire sa promesse tout seul ; en ajouter un la lui donne. La même
liste alimente désormais `findPending()` et les deux implémentations du dépôt, qui la
recopiaient chacune à leur façon (dont une en littéraux de chaîne).
Verrouillé par `tests/unit/tools/get-notification-history.test.ts`, qui compare l'ensemble
des statuts porteurs de promesse à `DISPATCHABLE_STATUSES` — et non à un libellé.

**Avant `export function makeGetNotificationHistory(`**

@param employeeRepo OPTIONNEL, et seulement pour résoudre un email en identifiant.

Mesuré en production le 2026-08-15 : « historique des notifications de <email> » coûtait
TROIS étapes — `findEmployeeByEmail`, puis `getNotificationHistory`, puis la réponse — pour
4 424 tokens. L'entrée étant CUMULATIVE (chaque étape réémet tout le contexte), l'étape
intermédiaire vaut à elle seule ≈ 1 500 tokens. Même défaut, même correctif que
`getEmployeeProfile`.

Le paramètre est optionnel pour ne pas casser les appelants existants : sans lui, seul le
chemin `recipientId` fonctionne et le chemin email INSTRUIT au lieu d'échouer.

**Avant `let recipientId = data.recipientId;`**

── Chemin EMAIL ──────────────────────────────────────────────────────

Même construction anti-ORACLE que `getEmployeeProfile` : l'identifiant RÉSOLU (ou

`null`) est passé à la garde, si bien qu'un demandeur non autorisé reçoit le MÊME

verdict que l'adresse désigne quelqu'un ou personne. Sans cela, le tool permettrait

d'énumérer l'annuaire une adresse à la fois.
**Avant `if (!canReadPersonRecord(_ctx?.requestContext, recipientId)) {`**

AVANT toute lecture en base — voir `canReadPersonRecord`. L'historique des messages

reçus par quelqu'un dit ce qu'on lui a écrit et quand : c'est une donnée personnelle

au même titre que son dossier.
**Avant `const sorted = [...all].sort((a, b) => {`**

Tri déterministe : date décroissante, puis `id` décroissant pour départager

deux notifications de même horodatage. Sans ce second critère, deux appels

identiques pouvaient rendre deux ordres différents.
## `features/notification/application/tools/schedule-reminder.ts`

**Avant `import { createTool } from '@mastra/core/tools';`**

Rappel daté — outil exposé au LLM.

## Ce que cet outil ne faisait pas, et ce qu'il fait depuis le 2026-08-21

### L'état d'origine, et la décision qui l'accompagnait

Le statut `Scheduled` qu'il posait n'était lu **nulle part** : ni cron ni poller dans
ce dépôt, et `findPending()` — le seul lecteur imaginable — n'avait aucun site
d'appel. Aucun rappel enregistré ici n'a jamais été expédié.

La décision assumée était : **on ne construit pas l'ordonnanceur** (chantier
d'infrastructure). Ce qui était corrigé, c'était le MENSONGE — un agent qui lisait
« planifié » promettait un envoi qui n'aurait jamais lieu. La description disait
« enregistré » et le verdict portait `willBeSentAutomatically: false`.

### ⚠️ CETTE DÉCISION A ÉTÉ RENVERSÉE, sur le verdict du propriétaire

> « *C'est noté. Par contre je ne sais pas te relancer tout seul le jour venu — repasse
> me le demander et je te le ressors.* — ce n'est pas le but d'un rappel. Pourquoi ne
> peut-il pas le faire ? »

Il avait raison, et la question était la bonne. L'honnêteté avait remplacé un mensonge
par une **inutilité** : un rappel dont il faut se souvenir n'est pas un rappel. C'était
un progrès, pas une fin.

**Pourquoi il ne pouvait pas le faire** — et ce n'était ni un oubli ni une paresse.
Dans un serverless, RIEN NE S'EXÉCUTE tant que personne ne frappe à la porte. La
fonction Vercel ne vit que le temps d'une requête HTTP ; aucun `setTimeout` ne survit
au gel ; aucun processus ne tourne entre deux messages Slack. `findPending()` était
écrite et correcte, et n'avait aucun appelant **parce qu'il n'existait personne pour
l'appeler**. Il manquait la seule chose qu'une fonction ne peut pas se donner à
elle-même : une **horloge extérieure**.

Le cron Vercel est cette horloge. Il frappe à la porte une fois par jour
(`/internal/reminders/dispatch`, `0 6 * * *`), et c'est tout ce qui manquait.

### ⚠️ La granularité est un fait de plateforme, pas un choix

Le plan Hobby n'autorise **qu'une exécution par jour** — « *Cron expressions that would
run more frequently will fail during deployment* » — et ne garantit l'heure qu'à
±59 min. Un rappel demandé « pour lundi 9 h » ne peut donc pas partir à 9 h 00.

Deux erreurs sont possibles, et elles ne se valent pas : arriver le **matin du bon
jour**, ou arriver le **lendemain**. On choisit le bon jour — un rappel est un objet à
granularité de JOURNÉE dans l'usage réel. `isDueForDispatch` compare donc des jours
**locaux** (jamais UTC : à 23 h à Cotonou on est déjà demain en UTC+2).

### ⚠️ Ce que le tool ne rend PLUS, et c'est le garde-fou

Il rendait `scheduledAt` brut et `scheduledLabel: 'lundi 24 août 2026 à 09 h00'` —
deux occasions, pour le modèle, d'annoncer une heure qu'aucune pièce du système ne
tient. Il ne rend plus que `deliveredOn: 'le lundi 24 août 2026 au matin'`.

**On ne lui interdit pas de mentir : on lui retire de quoi.** Une consigne est
PROBABLE, l'absence d'information est GARANTIE. `buildReminderNotice` accole la même
phrase côté handler (coût ZÉRO, `RequestContext`) pour le cas où le modèle reprendrait
l'heure de la demande, qu'il a sous les yeux.

### ⚠️ La prise est l'écriture, et elle rend un compte

`claimForDispatch(id)` fait un `UPDATE … WHERE status IN ('scheduled','pending')` et
lit `rowsAffected`. Deux exécutions du cron — ou un rejeu Vercel — ne peuvent pas
remettre deux fois le même rappel : le second appelant obtient `false`. Même contrat
que `clear()` sur les emails d'entretien en attente, et pour la même raison.

Sur un échec **réparable** (transport, base indisponible) la prise est RENDUE : la
remise du lendemain rattrapera. Sur un destinataire **introuvable** elle ne l'est pas —
rien ne fera revenir le dossier d'ici demain, et rendre la prise ferait repartir le
même rappel en échec tous les matins jusqu'à la fin des temps.

### ⚠️ Le détecteur de fausse promesse a dû bouger AVEC le câblage

`onlyNonDeliveringTools` a été supprimée. Son ensemble ne contenait qu'un nom,
`scheduleReminder`, et sa raison d'être tenait en une phrase : ce tool enregistrait une
ligne que rien ne reprenait. Depuis le cron, la phrase « ton rappel partira lundi » est
VRAIE — la démentir serait la faute exactement symétrique de celle que ce garde-fou
corrigeait.

**Un détecteur encode le CÂBLAGE.** Quand le câblage bouge, il doit bouger avec, sinon
il ne devient pas inoffensif : il devient faux dans l'autre sens. Même famille que
`READ_ONLY_TOOL_NAMES`, qui gardait `getTaskList` après son retrait. La condition passe
de « seuls des outils non livrants ont tourné » à « **aucun outil agissant n'a
tourné** » — la seule prémisse qui tienne encore.

### Aucun appel de modèle sur le chemin de la remise

Le sujet et le corps ont été rédigés au moment de la demande, sous les yeux de la
personne. Les refabriquer à la remise reviendrait à envoyer un texte que personne n'a
relu, et à payer un aller-retour par rappel. Seule la mise en contexte
(« Tu m'avais demandé de te remettre ceci en tête pour le lundi 24 août 2026. ») est
ajoutée, et elle est écrite par le CODE.

## Deux refus bruyants, alignés sur `sendNotification`

1. **Destinataire inconnu** → `NotFoundError`. `sendNotification` résout son
   destinataire depuis l'annuaire ; ne pas le faire ici laissait enregistrer des
   rappels pour des UUID qui ne désignent personne — invisibles jusqu'au jour où
   quelqu'un lirait la table.
2. **Date passée** → `ValidationError`. « Rappelle-lui hier » n'a aucun sens et le
   modèle produisait volontiers une date d'aujourd'hui déjà écoulée.

La date est validée dans `execute` et non par `z.string().datetime()` : la validation
de schéma de Mastra RETOURNE un objet d'erreur au lieu de lever, et il n'y a aucune
raison que « format illisible » et « date passée » suivent deux régimes d'erreur
différents. Effet de bord bienvenu : le mot-clé `format` sort du JSON Schema.

**Avant `const TRANSPORTED_CHANNELS = ['email', 'slack'] as const;`**

 Mêmes canaux que `sendNotification` : ce sont les seuls qu'on saurait acheminer.

**Avant `export function makeScheduleReminder(`**

@param employeeRepo Annuaire, pour refuser un destinataire inexistant. Optionnel
  uniquement parce que `src/mastra/index.ts` ne le câble pas encore (le fichier
  appartient à un autre lot) : sans lui, le rappel est enregistré sans vérification
  du destinataire — et c'est le seul cas où ce tool est moins strict que
  `sendNotification`.

**Avant `description: 'Enregistre un rappel daté. Aucun automate ne le reprend : rien ne part seul.',`**

« enregistre », jamais « planifie » : le mot que lit le modèle est celui qu'il

répétera à l'utilisateur.
**Avant `body: z.string().min(1).max(5000).describe('rédige-le, ne le demande pas'),`**

⚠️ Borne HAUTE ajoutée le 2026-08-13. `title`/`subject` étaient bornés à 200 sur la

ligne voisine, ce champ ne l'était pas — asymétrie relevée par l'audit, et c'est le

champ VOLUMINEUX. Rien en aval ne tronque : ni les assainisseurs de document ni les

adaptateurs d'envoi. Un contenu non borné est persisté, relu, et repart dans la

fenêtre du modèle, sur un système dont la contrainte dominante EST le budget de

tokens.
**Avant `if (!canPerformSideEffects(_ctx?.requestContext, data.recipientId)) {`**

FRONTIÈRE D'AUTORISATION — avant toute résolution, avant toute écriture

Ajoutée le 2026-08-18. Cet outil était, avec `updateOnboardingStatus`, le SEUL

écrivain exposé à un agent qui ne regardait pas qui demande — alors que son jumeau

`sendNotification` a sa garde depuis le 2026-08-13, et que les deux écrivent dans

la MÊME table.

Ce que l'absence permettait : écrire un `subject` et un `body` de 5 000 caractères

dans `notifications`, sur le `recipientId` d'un TIERS. Ces lignes ressortent ensuite

par `getNotificationHistory` — c'est donc une écriture arbitraire dans l'historique

de quelqu'un d'autre, relue plus tard comme un fait.

⚠️ L'ABSENCE de niveau vaut autorisation, comme dans `send-notification.ts:117` :

hors Slack il n'y a pas de demandeur à évaluer.

⚠️ Le refus tombe AVANT la résolution du destinataire : sans cela, « destinataire

inconnu » et « non autorisé » deviendraient deux verdicts distinguables, donc un

oracle d'annuaire — le défaut déjà fermé sur `getEmployeeProfile`.
**Avant `return {`**

Verdict PROJETÉ et sans ambiguïté. Ni `subject` ni `body` : le modèle vient de

les écrire, les lui renvoyer serait payé à chaque tour suivant. Les deux

booléens sont là pour qu'aucune formulation de la réponse ne puisse promettre

un envoi.
**Avant `scheduledLabel: frenchFullLabel(new Date(when), DISPLAY_TIMEZONE),`**

⚠️ LE JOUR DE LA SEMAINE EST CALCULÉ ICI, et c'est un correctif mesuré en production

le 2026-08-19 : l'agent avait répondu « à 09 h 00 le lundi 22 août 2026 », alors que

le 22 août 2026 est un SAMEDI. Il écrivait le libellé lui-même, à côté d'une date

qu'il avait calculée, et rien ne confrontait les deux. `recruitmentAgent` ne peut pas

commettre cette faute — son libellé vient d'un gabarit — et il a produit au même

moment « mardi 15 septembre 2026 », exact.

Coût : ≈ 15 tokens de tool-result, indépendants de la date. Ce qu'ils achètent, c'est

qu'une erreur de transcription devienne VISIBLE pour la personne qui relit.
## `features/notification/application/tools/send-notification.ts`

**Avant `import { createTool } from '@mastra/core/tools';`**

Envoi de notification — outil exposé au LLM.

## Modèle de menace

Cet outil est atteignable depuis un message Slack arbitraire : `slack-events.handler.ts`
route tout message contenant « email | message | notification | rappel » vers
`notificationAgent`, qui reçoit le texte brut de l'utilisateur. Toute valeur produite par
le LLM doit donc être considérée comme contrôlée par un attaquant.

Conséquence : **l'adresse de destination n'est jamais un paramètre**. Le schéma d'entrée
n'expose que `recipientId` ; l'email et le compte Slack sont résolus côté serveur depuis
l'annuaire (`EmployeeRepository`). Le LLM peut choisir *à qui parmi les employés
enregistrés* on écrit, jamais *à quelle adresse*.

## Deux phases, deux régimes d'erreur

1. **Résolution** — échoue BRUYAMMENT (throw). Un `recipientId` inconnu, ou un compte Slack
   introuvable, interrompt l'outil : aucun envoi, aucun enregistrement. On n'ajoute
   surtout pas un chemin silencieux de plus (cf. le piège `emailSent: false` documenté
   dans CLAUDE.md, où un échec d'email laissait le workflow renvoyer `status: 'success'`).
2. **Envoi** — un échec de transport (SMTP indisponible, API Slack en erreur) est enregistré
   en base avec `status: Failed`. C'est une panne opérationnelle, pas une tentative d'abus.

**Avant `const TRANSPORTED_CHANNELS = ['email', 'slack'] as const;`**

Canaux RÉELLEMENT transportés par cet outil.

`NotificationChannel` en compte sept ; cinq (`teams`, `in_app`, `push`, `sms`,
`webhook`) n'ont AUCUN transport ici et aucun lecteur ailleurs dans le produit.
Les exposer coûtait deux fois : en tokens (l'énumération est réémise à chaque
aller-retour) et surtout en dialogue — le « tu préfères quel canal (email, Slack,
in-app) ? » observé en production le 2026-08-11 est littéralement cette
énumération remontée à l'humain. Un canal qu'on ne sait pas acheminer n'a rien à
faire dans le schéma offert au modèle.

`z.enum` LOCAL et non `z.nativeEnum(NotificationChannel)` : on ne touche pas à
l'énumération partagée de `src/shared/types.ts`, qui décrit le domaine, pas ce que
cet outil sait faire.

**Avant `const RECIPIENT_TYPES = ['employee', 'manager', 'hr', 'admin'] as const;`**

Types de destinataire acceptés — restreints à ceux qui peuvent avoir une ligne
d'annuaire. `team` et `department` n'en ont jamais : les offrir revenait à
proposer au modèle un chemin dont la seule issue est un `NotFoundError`.

**Avant `function safeNotificationBody(`**

Assainit le corps d'une notification et JOURNALISE tout retrait.

⚠️ Extrait du corps de l'outil, mais pas seulement pour la complexité cognitive : c'est
ici que se ferme le troisième canal de sortie du produit, et il mérite d'être nommé.

`body` est de la prose LIBRE écrite par le modèle (5 000 caractères) et elle sortait par
TROIS chemins sans passer par le moindre filtre : l'email, le message Slack, et la ligne
`notifications.body` en base — que `getNotificationHistory` relit ensuite pour la rendre
au modèle. `sanitizeAgentOutput` n'a qu'un seul site d'appel, `response.text` : les
ARGUMENTS DE TOOL n'y passent jamais. C'est exactement le défaut constaté puis fermé
pour le contenu des documents le 2026-08-11, jamais rejoué ici.

Le contrat est celui du DOCUMENT et non celui de Slack : on retire le marqueur et le lien
sur place, on GARDE le message. Une notification amputée de son lien reste utile ; une
notification remplacée par un refus ne dit plus rien à personne.

Le retrait part en `error` et non en `warn` : il signifie qu'un modèle a produit un lien
fabriqué ou récité un marqueur interne à destination d'un HUMAIN, par un canal qui sort
de l'organisation. C'est le même niveau que sur le canal Slack, pour la même raison.

**Avant `description:`**

Description et `describe()` sont réémis à CHAQUE aller-retour : on n'y garde que

ce que le nom du champ ne dit pas déjà. Ce qui reste est le contrat de sécurité

(destinataire par UUID, jamais par adresse) — il doit rester lisible par le modèle.
**Avant `recipientId: uuidSchema.describe('UUID annuaire ; adresse résolue côté serveur.'),`**

Pas de `recipientEmail` ni de `recipientSlackId` : voir le modèle de menace ci-dessus.

Un LLM qui les émettrait quand même les verrait supprimés par Zod (`z.object` retire

les clés inconnues), et `execute` ne les lit de toute façon jamais.
**Avant `subject: z.string().min(1).max(200).describe('rédige-le, ne le demande pas'),`**

⚠️ DÉROGATION DE RÉDACTION, POSÉE PAR CHAMP — jamais dans les instructions de

l'agent. `AGENT_ANTI_INVENTION_BLOCK` lui interdit d'inventer une donnée absente ;

c'est juste pour un email ou un UUID, qui se RETROUVENT, et faux pour une prose,

qui se PRODUIT. Poser « compose le corps toi-même » dans le prompt contredirait

frontalement cette règle et reviendrait à tirer à pile ou face à chaque tour. Ici,

la dérogation ne porte que sur les deux champs qui sont effectivement de la prose.
**Avant `body: z.string().min(1).max(5000).describe('rédige-le, ne le demande pas'),`**

⚠️ Borne HAUTE ajoutée le 2026-08-13. `title`/`subject` étaient bornés à 200 sur la

ligne voisine, ce champ ne l'était pas — asymétrie relevée par l'audit, et c'est le

champ VOLUMINEUX. Rien en aval ne tronque : ni les assainisseurs de document ni les

adaptateurs d'envoi. Un contenu non borné est persisté, relu, et repart dans la

fenêtre du modèle, sur un système dont la contrainte dominante EST le budget de

tokens.
**Avant `channel: z.enum(TRANSPORTED_CHANNELS).default('email'),`**

Défauts, comme `generateDocument` (`format` → pdf, `deliverTo` → slack), le seul

outil de la campagne qui ait abouti. Un champ obligatoire sans défaut est une

question posée à l'humain ; il n'en reste que trois, et les trois sont

irremplaçables.
**Avant `if (!canPerformSideEffects(_ctx?.requestContext, data.recipientId)) {`**

FRONTIÈRE D'AUTORISATION — avant toute résolution, avant toute E/S

C'est LE tool à protéger en premier. Il fait partir un email depuis le compte Gmail

de l'entreprise, SPF/DKIM parfaitement alignés : entre les mains d'un invité externe

c'est un relais de hameçonnage authentifié. Son invariant historique — n'accepter

qu'un UUID, jamais une adresse — empêche de choisir la CIBLE, mais n'empêchait

personne de déclencher l'envoi.

Le niveau d'accès vient du `requestContext`, canal que le modèle ne peut pas écrire.

⚠️ L'ABSENCE de niveau vaut autorisation : hors Slack (workflow, playground, test,

route `/api/*` déjà derrière un jeton) il n'y a pas de demandeur à évaluer, et

refuser y casserait le parcours d'onboarding qui envoie l'email de bienvenue.
**Avant `return {`**

On INSTRUIT plutôt que de lever. Une exception remonterait au modèle comme une

panne, qu'il raconterait comme telle ou qu'il réessaierait — deux allers-retours

gâchés sur un budget de ≈19 messages/jour. Ici il lit un refus et peut le dire.
**Avant `const channel = data.channel ?? 'email';`**

Les défauts du schéma sont appliqués par la validation Mastra ; ces replis

couvrent l'appel direct (tests, workflows) qui court-circuite le parseur.
**Avant `const supplied = data as Record<string, unknown>;`**

Un LLM peut émettre des champs hors schéma lors d'un appel direct (hors validation

Mastra). On ne les utilise pas, mais on les journalise : une adresse proposée par le

modèle est un signal de tentative d'injection.
**Avant `const recipient = await employeeRepo.findById(data.recipientId);`**

Phase 1 — Résolution (échoue bruyamment)

`recipientId` désigne TOUJOURS la personne à notifier, quel que soit `recipientType`.

Un manager est lui-même une ligne de `employees` (la table porte un `manager_id`

auto-référent), il se résout donc exactement comme un employé. On n'interprète

jamais `recipientType: manager` comme « le manager DE cet identifiant » : l'annuaire

ne permet pas de lever l'ambiguïté entre les deux lectures, et se tromper enverrait

le message à la mauvaise personne. Si un manager (ou un destinataire `hr`, `admin`)

n'a pas d'enregistrement d'annuaire, on échoue — jamais de repli sur une valeur

proposée par le modèle.
**Avant `const member = await slackWorkspace.findUserByEmail(target.email);`**

Le compte Slack se déduit de l'email d'annuaire : le LLM ne choisit ni le canal

ni l'utilisateur. `chat.postMessage` accepte un identifiant utilisateur et ouvre

la conversation directe correspondante.
**Avant `let status: NotificationStatus;`**

Phase 2 — Envoi (un échec de transport est enregistré, pas propagé)

`Sent` était posé AVANT le `try`, donc par DÉFAUT : les cinq canaux non

transportés repartaient « envoyé », horodatés, sans qu'aucun octet ne parte —

troisième occurrence dans ce dépôt du même défaut (`emailSent: false` avec

`status: 'success'`, `documents.content` perdu en silence). Le statut est

désormais posé APRÈS l'`await` du transport : aucun chemin ne peut plus

atteindre `Sent` sans qu'un fournisseur ait réellement rendu la main.
**Avant `await emailProvider.sendEmail(destination, data.subject, textEmailBody(safe.text));`**

`textEmailBody` ÉCHAPPE : le corps part dans un slot HTML chez les deux

fournisseurs, et l'assainissement ci-dessus ne couvre pas ce risque-là — retirer

un lien n'empêche pas une balise d'être interprétée.
**Avant `body: safe.text,`**

Le corps ASSAINI, jamais celui du modèle : une ligne enregistrée avec un marqueur

ou un lien fabriqué ressortirait telle quelle au premier code qui la relirait —

ici `getNotificationHistory`, qui la rend au modèle. Même arbitrage que pour la

persistance d'un document.
**Avant `return {`**

Verdict PROJETÉ. On ne renvoie ni `subject` ni `body` : c'est le modèle qui

vient de les écrire, les lui refacturer à chaque aller-retour suivant est un

coût pur (même défaut que `documents.content`). `status` porte à lui seul la

différence entre « parti » et « pas parti ».
## `features/notification/domain/ports/employee.repository.ts`

**Avant `export interface EmployeeDirectoryRecord {`**

Port « annuaire » de la feature `notification`.

Vue minimale et en LECTURE SEULE d'un employé, restreinte à ce dont cette feature a
besoin : résoudre une adresse de destination à partir d'un identifiant.

Comme `src/features/document/domain/ports/employee.repository.ts`, ce port duplique
volontairement une partie du port de la feature `employee` : chaque feature possède ses
propres ports (cf. CLAUDE.md). La feature `notification` n'importe donc jamais les
internes de la feature `employee` ; c'est `src/mastra/index.ts` qui branche
l'implémentation Drizzle, structurellement compatible avec cette interface.

 Enregistrement d'annuaire — la seule source de vérité pour une adresse de destination.
## `features/notification/domain/ports/providers.ts`

**Avant `export interface EmailAttachment {`**

Pièce jointe d'un email, exprimée dans les termes du domaine.

`Uint8Array` et non `Buffer` : la couche domaine reste indépendante des types
Node — c'est le même arbitrage que `RenderedDocument` côté rendu de document.
Chaque adaptateur convertit vers ce que son transport attend (Buffer pour
nodemailer, base64 pour l'API Brevo).

**Avant `sendEmail(`**

`attachments` est OPTIONNEL, et doit le rester : les appelants historiques
(`send-notification`, workflow d'onboarding) n'ont pas été modifiés et
doivent continuer à compiler et à produire exactement le même message.

La taille totale est bornée — voir `domain/services/email-attachment-policy.ts`.

⚠️ `body` est un {@link EmailBody}, jamais une chaîne — corrigé le 2026-08-20.

Le contrat était IMPLICITE : les deux adaptateurs placent le corps dans un slot HTML
(`html:` chez SMTP, `htmlContent:` chez Brevo), donc il est INTERPRÉTÉ. Trois appelants
sur quatre y passaient du texte brut, dont `sendNotification` — 5 000 caractères de
prose écrite par le modèle, atteignable depuis un message Slack arbitraire. Un
`<a href>` vers un domaine tiers partait en lien cliquable DEPUIS L'ADRESSE DE
L'ENTREPRISE.

Le type force chaque appelant à déclarer ce qu'il produit, et un futur appelant qui
passerait une chaîne nue ne compilera pas. Voir `domain/services/email-body.ts`.
**Avant `sendMessage(channelId: string, text: string): Promise<{ channel: string }>;`**

⚠️ Rend le CANAL réellement utilisé. Quand `channelId` est un identifiant d'UTILISATEUR
(`U…`), Slack ouvre lui-même la conversation directe et le message atterrit dans un canal
`D…` que l'appelant ne connaissait pas. C'est ce qui a cassé l'entretien conversationnel
à sa première mise en production : la question était posée à `U…`, l'état était cherché
dans la mémoire de `D…`, et les deux ne se rencontraient jamais.

**Avant `channel: string;`**

 Canal de destination. En DM, l'identifiant `D…` du fil.

**Avant `threadTs?: string;`**

 Fourni pour livrer le fichier DANS le fil plutôt qu'à la racine du canal.

**Avant `export interface FileUploadProvider {`**

Livraison d'un fichier dans la conversation.

Le port ne mentionne aucun type `@slack/*` — la règle de dépendance l'interdit
dans `domain/`, et un garde-fou de test la verrouille
(`tests/unit/quality/architecture.test.ts`).

`permalink` est optionnel : le fichier peut être livré alors que la réponse du
fournisseur ne porte pas d'URL. L'absence de lien n'est donc PAS un échec.

## `features/notification/domain/ports/rate-limit.repository.ts`

**Avant `export interface RateLimitRepository {`**

Compteurs de limitation de débit PARTAGÉS entre instances (P3).

Pourquoi partagés, et pas un simple LRU en mémoire comme le proposait
`COMPETENCES_ET_ANALYSE.md` P3 palier 1 : le budget à protéger est JOURNALIER
(100 000 tokens Groq, ≈ 19 messages/jour). Un compteur en mémoire est par instance et
disparaît au gel de la fonction serverless — sur 24 h, il ne compte donc pas la même chose
que le fournisseur, et un attaquant n'a même pas à le savoir pour le contourner : il suffit
que Vercel démarre une instance neuve. C'est exactement la leçon déjà payée par la
déduplication, dont le cache par instance a produit la double réponse du 2026-08-11.

Le LRU local n'est pas abandonné pour autant : il reste le premier niveau, gratuit, qui
écarte sans aucune E/S les rafales retombant sur une instance chaude.

**Avant `increment(key: string, windowStart: Date, expiresAt: Date, by?: number): Promise<number>;`**

Incrémente le compteur d'une fenêtre et rend sa valeur APRÈS incrément.

⚠️ CONTRAT NON NÉGOCIABLE : un seul énoncé atomique
(`INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`). Un `SELECT`
suivi d'un `UPDATE` rouvrirait la fenêtre de concurrence que ce port existe pour fermer —
deux instances liraient la même valeur avant que l'une écrive, et la limite serait
franchissable par simple parallélisme.

La clé porte déjà le numéro de fenêtre (voir `buildCounterKey`) : il n'y a donc jamais de
remise à zéro à effectuer, seulement des lignes qui cessent d'être consultées.

@param by Pas d'incrément. Défaut `1` — les appelants qui comptent des MESSAGES ne
  changent pas.

  Deux autres valeurs ont un sens, et elles sont la raison d'être du paramètre :

  - **un nombre de TOKENS**, pour le budget dont la ressource ne se compte pas en
    messages. Un « Bonjour » a coûté 13 376 tokens en production — 13 % de la journée —
    pour une seule unité sur un compteur de messages. Le compteur ne mesurait pas ce
    qu'il prétendait borner.
  - **`0`, qui fait de cet appel une LECTURE ATOMIQUE** : la ligne est créée à 0 si elle
    manque, et le compte est rendu sans être modifié. C'est ce qui permet de CONSULTER un
    budget avant un appel de modèle et de l'INCRÉMENTER après — le coût réel n'étant connu
    qu'a posteriori — sans ajouter de méthode au port ni un second aller-retour.
**Avant `pruneExpired(now: Date): Promise<number>;`**

 Purge les fenêtres expirées. Appelée opportunément — aucun cron ne le fera.

## `features/notification/domain/ports/slack-event-dedup.repository.ts`

**Avant `export type SlackEventDedupStatus = 'in-flight' | 'done';`**

Déduplication PARTAGÉE des événements Slack.

Le cache LRU du handler est en mémoire, donc **par instance**. Incident de production du
2026-08-11 (12:38 UTC), deux causes conjointes :
  1. l'ACK a mis ~6,7 s (démarrage à froid du bundle Mastra) contre 3 s autorisées, donc
     Slack a rejoué l'événement ;
  2. l'instance A était occupée par le `waitUntil` de l'appel LLM, donc le rejeu a été routé
     vers une instance NEUVE, au cache vide — qui a répondu une seconde fois.

Le point structurant : un cache par instance est **incapable par construction** de
dédupliquer les rejeux qui arrivent PENDANT le traitement, c'est-à-dire exactement ceux qui
produisent une double réponse. D'où ce port, implémenté sur la base partagée (Turso).

⚠️ `claim()` tourne AVANT l'ACK HTTP, sur le chemin qui a 3 secondes : une implémentation
doit s'y tenir à UN aller-retour dans le cas passant.

État d'une clé.
 - `in-flight` : le traitement est en cours ; un rejeu concurrent doit être ignoré.
 - `done`      : le traitement est allé au bout ; tout rejeu est un doublon définitif.

Cette distinction est le fruit d'un bug déjà corrigé : marquer la clé « vue » dès l'ACK
perdait DÉFINITIVEMENT l'événement quand la fonction serverless était gelée en plein
traitement — le rejeu Slack tombait sur la clé posée et était silencieusement jeté.
**Avant `readonly inFlightGraceMs: number;`**

Durée au-delà de laquelle une entrée `in-flight` est réputée abandonnée (fonction gelée
ou tuée) et la clé redevient prenable. Sans cette grâce, un événement perdu au gel de la
fonction le serait pour toujours.

**Avant `export type SlackEventClaim =`**

Résultat d'une prise de clé.

`reclaimed` distingue une première prise d'une reprise après abandon : les deux autorisent
le traitement, mais la seconde mérite un `warn` — c'est le symptôme d'une invocation tuée
en vol.

Sur le refus, `status` et `ageMs` ne servent QUE la journalisation ; `unknown` couvre le cas
(rare) où la ligne a disparu entre la tentative de prise et sa relecture — purge concurrente.

**Avant `export const SLACK_EVENT_DEDUP_RETENTION_MS = 10 * 60 * 1000;`**

Rétention des clés. La fenêtre de rejeu de Slack est de ~10 minutes (3 renvois espacés
de 1 s, 1 min puis 5 min) : au-delà, une entrée ne protège plus de rien et ne fait que
grossir la table.

**Avant `claim(key: string, options: SlackEventClaimOptions): Promise<SlackEventClaim>;`**

Prend la clé de façon **ATOMIQUE**, ou refuse.

⚠️ CONTRAT NON NÉGOCIABLE : la prise doit être une opération atomique unique
(`INSERT … ON CONFLICT DO NOTHING`, puis décision d'après le nombre de lignes affectées).
Un `SELECT` suivi d'un `INSERT` rouvrirait exactement la fenêtre de concurrence que ce
port existe pour fermer — deux instances liraient « absente » avant que l'une écrive.

**Avant `markDone(key: string): Promise<void>;`**

 Le traitement est allé au bout : tout rejeu ultérieur est un doublon définitif.

**Avant `release(key: string): Promise<void>;`**

Libère la clé après un échec inattendu, pour qu'un rejeu Slack reparte immédiatement
au lieu d'être avalé par la déduplication.

**Avant `pruneOlderThan(cutoff: Date): Promise<number>;`**

 Purge les clés au-delà de la rétention. Appelé opportunément, pas par un cron.

## `features/notification/domain/ports/slack-workspace.port.ts`

**Avant `firstName: string;`**

 Prénom du profil Slack ; à défaut, premier mot de `realName`.

**Avant `lastName: string;`**

 Nom du profil Slack ; à défaut, reste de `realName`.

**Avant `displayName: string;`**

Cascade `profile.display_name` → `profile.real_name` → `real_name` → `name`, et elle
descend jusqu'au bout : un refus d'autorisation doit TOUJOURS pouvoir nommer quelqu'un.

**Avant `title: string;`**

`profile.title` — le poste DÉCLARÉ par la personne dans Slack.

⚠️ À ne pas confondre avec `employees.position`, qui est le poste CONTRACTUEL. Ce ne sont
pas deux versions d'une même vérité mais deux faits distincts, de deux sources distinctes :
l'un est édité par son porteur, l'autre par les RH. Quand ils divergent, il n'y a rien à
arbitrer — et surtout aucun `COALESCE` à écrire.

**Avant `isRestricted: boolean;`**

Drapeaux de CONFIANCE, matière première de la politique d'autorisation.

`isRestricted` = invité multi-canal, `isUltraRestricted` = invité mono-canal. Slack pose les
DEUX sur un invité mono-canal, et on les lit tels quels : déduire l'un de l'autre
interdirait à la politique de durcir le seul cas mono-canal — celui du scénario §4.1 de
`PLAN-ARCHITECTURE.md`, où un invité demande en DM le résumé d'un canal privé.

**Avant `isDeleted: boolean;`**

Compte désactivé. C'est ce qui permet de REFUSER un ancien salarié, là où un compte inconnu
(`null` rendu par le port) est seulement rétrogradé.

**Avant `findUserById(userId: string): Promise<SlackMember | null>;`**

Résout un membre par son identifiant Slack.

Nécessaire au flux d'arrivée : le payload `team_join` ne porte de façon
fiable que `user.id` — l'email peut manquer tant que le profil n'est pas
complété.

## `features/notification/domain/services/agent-routing.ts`

**Avant `import { AGENT_TOOLS, agentHasTool } from '../../../../shared/agent-capabilities';`**

Routage message → agent : les quatre paliers, et les listes qui les gouvernent.

## Pourquoi un module de DOMAINE

Extrait de `slack-events.handler.ts` le 2026-08-17. C'est une décision PURE : un texte et
l'agent du tour précédent entrent, un identifiant d'agent sort. Aucune E/S, aucun client
Slack. Elle vivait en méthode d'instance alors qu'elle n'a jamais lu `this` — le handler
conserve une méthode `routeToAgent` qui délègue ici, parce que ses tests l'appellent ainsi
depuis l'origine.

Le voisinage compte : ce module est adossé à `shared/agent-capabilities.ts`, qui déclare
le câblage agent → outils UNE SEULE FOIS. C'est ce qui permet à la bande 3 d'être DÉRIVÉE
du câblage plutôt que recopiée.

**Avant `const ESCAPE_INTENTS: ReadonlyArray<readonly [agentId: string, keywords: readonly string[]]> = [`**

Aiguillage mot-clé → agent, en TROIS BANDES. Ces listes sont CONTRACTUELLES : elles sont
documentées dans CLAUDE.md, ne pas les modifier sans mettre la doc à jour.

## Pourquoi trois bandes et non deux paliers

Le découpage précédent — « intentions de l'orchestrateur » PRIORITAIRES, puis palier
collant, puis thématiques — faisait de `onboardingOrchestrator` un ÉTAT ABSORBANT, mesuré
sur la campagne du 2026-08-11 :
 - `stickyAgentId` est renseigné dès le premier tour, donc les paliers thématiques étaient
   MORTS à partir du message 2. En DM la clé de conversation est le canal : tous les sujets
   d'une heure partageaient ce verrou, et `notificationAgent` n'a JAMAIS été atteignable en
   série A ;
 - le seul palier capable de déplacer un fil ne menait QU'À l'orchestrateur, sans retour.
   B6 (« ajoute ») et C7 (« guide » / « pdf ») ont ainsi ARRACHÉ leur fil vers un agent qui
   a hérité de la mémoire d'un autre et promis des capacités qu'il n'a pas — les deux
   réponses les plus fausses de la campagne.

D'où la forme retenue : **le palier d'échappement devient SYMÉTRIQUE**. Chaque agent y a
ses propres termes, donc aucun n'est un puits ; et les termes qui détournaient les réponses
de suivi redescendent SOUS le palier collant.

**Avant `const ESCAPE_INTENTS: ReadonlyArray<readonly [agentId: string, keywords: readonly string[]]> = [`**

BANDE 1 — ÉCHAPPEMENT. Évaluée AVANT le fil en cours.

Critère d'admission, plus strict que « désigne cet agent » : le terme doit ouvrir une
TÂCHE NOUVELLE, pas continuer celle en cours. C'est la porte de sortie d'un fil collé sur
le mauvais agent — sans elle, une conversation mal aiguillée serait un piège sans issue,
et c'est l'acquis du 2026-08-10 (« retrouve l'employé dont l'email est X » partait chez
`notificationAgent`, qui n'a pas `findEmployeeByEmail` : la recherche par email était
structurellement inatteignable).

L'ordre du tableau EST la priorité entre bandes-1 concurrentes.

Volontairement ABSENTS :
 - « ajoute » — verbe français générique. C'est lui qui a détourné B6 (« ajoute une
   question à choix multiple ») vers un agent sans aucun tool de questionnaire. Même
   critère que celui qui a fait écarter « word » ;
 - « profil » — trop courant, il capturerait « planifie un rappel : compléter son profil ».
   ⚠️ Et depuis le 2026-08-14, une demande de formulaire de profil est de toute façon
   interceptée AVANT le routage, par un court-circuit déterministe qui ne coûte rien ;
 - « statut », « intégration » — même critère de fréquence ;
 - « génère » — il sert `generateDocument`, et le défaut est déjà cet agent.

**Avant `['recruitmentAgent', ['candidat', 'candidate', 'recrutement', 'entretien']],`**

L'ORDRE EST : NOMS SPÉCIFIQUES D'ABORD, VERBES GÉNÉRIQUES ENSUITE.

Réordonné le 2026-08-12. `onboardingOrchestrator` était en tête et possède `retrouve` et

`recherche` — deux verbes que les DEUX tools de `knowledgeAgent` emploient pour se décrire

(« Retrouve les échanges… », « Retrouve les derniers messages… »). Conséquence mesurée :

« retrouve notre conversation avec Awa » partait chez l'orchestrateur, donc le quatrième

agent était INATTEIGNABLE sur son propre verbe, et le commentaire affirmant que cette

bande est symétrique était faux.

Le critère est le même que celui qui a fait écarter « ajoute » : un verbe générique ne doit

pas l'emporter sur un nom qui désigne sans ambiguïté un objet métier. « retrouve » ne dit

rien de ce qu'on cherche ; « conversation », « questionnaire » ou « rappel », si.

⚠️ L'ordre RELATIF des trois bandes nominales est conservé, et il porte un cas réel :

« quel est l'historique des notifications de l'employé 123 ? » doit aller à

`notificationAgent`. `notification` est donc évalué AVANT `historique`.

⚠️ `['questionnaireEngine', ['questionnaire', 'évaluation', 'quiz']]` a été RETIRÉ le

2026-08-14, avec l'agent lui-même. Ces trois mots retombent donc au défaut, c'est-à-dire

chez l'orchestrateur — dont la frontière DÉRIVÉE (`agentToolBoundary`) dira qu'il n'a

aucun outil de questionnaire. C'est la réponse honnête : il n'en existe plus.

Les laisser ici aurait été bien pire qu'un mauvais aiguillage : `mastra.getAgent()` LÈVE

sur un identifiant absent du registre (`MASTRA_GET_AGENT_BY_NAME_NOT_FOUND`), donc chaque

message contenant « questionnaire » aurait échoué sur le message générique.

⚠️ EN TÊTE, et l'ordre porte un cas réel. « Envoie un email d'entretien à

jean@exemple.com » contient `email`, qui appartient à `NOTIFICATION_TOPICS` : sans cette

bande, la phrase de référence de toute la feature partait chez `notificationAgent`, dont

`sendNotification` EXIGE une ligne d'annuaire — or un candidat n'en a aucune par

définition. La demande était donc structurellement insatisfaisable, comme l'était la

recherche par email avant le 2026-08-10. Même défaut, même correctif : le terme qui

désigne l'OBJET MÉTIER doit primer sur celui qui désigne le transport.

Placé avant `notification` pour la même raison : « envoie une notification à un

candidat » doit aller au recrutement, seul chemin capable d'écrire à quelqu'un qui

n'est pas dans l'annuaire.

⚠️ `entretien` est ambigu en français (« entretien du matériel ») et désigne aussi, dans

ce dépôt, l'entretien POST-PROFIL. Il est retenu quand même : ce dernier est piloté par

un bouton et une modale, jamais par un message, donc il ne passe pas par le routage.
**Avant `['knowledgeAgent', ['conversation', 'historique']],`**

Ajouté le 2026-08-12 avec `knowledgeAgent`. La bande 1 doit rester SYMÉTRIQUE : chaque

agent y a ses termes, aucun n'est un puits. Un quatrième agent sans porte d'entrée serait

inatteignable dès le deuxième message d'un fil, `stickyAgentId` étant renseigné dès le

premier tour — c'est exactement ce qui rendait `notificationAgent` inaccessible en série A.

Volontairement ABSENTS, au critère « ouvre une tâche nouvelle » :

 - « résume », « dit », « parle » — trop courants, ils captureraient des réponses de suivi ;

 - « message » — il appartient déjà à `NOTIFICATION_TOPICS` en bande 3, et le promouvoir

   ici détournerait « envoie-lui un message » vers un agent qui ne sait rien envoyer ;

 - « échange » — RETIRÉ après essai, le 2026-08-12. Le test de non-régression du bord

   droit l'a attrapé sur « rappelle-toi de notre échange », qui est une réponse de SUIVI et

   non l'ouverture d'une tâche. Même verdict que « ajoute » et « word » avant lui : un nom

   français assez courant pour apparaître dans une phrase qui ne demande rien.

 - « conversations » au pluriel — c'était du code MORT : `matchesKeyword` ajoute déjà `s?`

   aux mots-clés nominaux. Le déclarer donnait l'illusion d'une couverture supplémentaire.
**Avant `[`**

Le puits, en DERNIER : ses termes sont majoritairement des verbes génériques, et le défaut

du routage est de toute façon cet agent. Y placer un mot revient donc surtout à le retirer

aux autres — ce qui est exactement ce qui s'est produit avec `retrouve`.
**Avant `const ORCHESTRATOR_TOPICS = [`**

BANDE 3 — THÉMATIQUE. Évaluée APRÈS le fil en cours, donc seulement quand aucun agent ne
mène la conversation (fil neuf, ou clos par le TTL de 60 min).

On y trouve les termes qui désignent bien un agent mais qui, dans un fil vivant, sont
presque toujours des RÉPONSES DE SUIVI : « Donne le PDF alors », « envoie-le en docx »,
« et par email ? ». Les faire primer sur le fil est exactement ce qui a produit
l'alternance A → B → A → B → A entre deux agents amnésiques.

`guideline` est listé à part car le bord droit du motif empêche `guide` de matcher à
l'intérieur du mot. « word » reste écarté : mot anglais courant (« in other words »).

**Avant `const NOTIFICATION_TOPICS = ['email', 'message'] as const;`**

⚠️ `QUESTIONNAIRE_TOPICS = ['test']` a été RETIRÉ le 2026-08-14 avec l'agent. « test »

retombe au défaut. C'est aussi une amélioration en soi : ce mot-clé désignait un agent de

quiz, alors que « test » dans ce workspace parle presque toujours d'un test logiciel.
**Avant `const KNOWLEDGE_TOPICS = ['résume', 'résumé', 'resume', 'resumé'] as const;`**

Termes de bande 3 du `knowledgeAgent` — ajoutés le 2026-08-14.

Le manque était recensé depuis le 2026-08-12 : ses SEULES portes d'entrée étaient
`conversation` et `historique`, en bande 1. « Résume ce qui s'est dit dans #kisso-hq » et
« De quoi on a parlé cette semaine ? » partaient donc au DÉFAUT, c'est-à-dire chez
l'orchestrateur, qui n'a aucun outil de canal. Conséquence documentée : toute la
`disclosure-policy.ts` était du code mort sur la phrase que quelqu'un dirait vraiment — rien
ne fuyait, mais ce n'était pas la politique qui l'empêchait, c'était l'inaccessibilité.

`résume` avait été écarté de la bande 1 pour cause de fréquence, et à raison. La bande 3 est
l'endroit sûr : elle est évaluée SOUS le collant, donc elle ne peut pas détourner une
réponse de suivi — et depuis ce jour elle ne prend la main sur un fil vivant que si l'agent
qui le mène est STRUCTURELLEMENT incapable de servir la demande (voir `TOPIC_BANDS`).

Volontairement absents : `dit` et `parle`, trop courants même ici.

**Avant `const CHANNEL_TOKEN_PATTERN = /<#[CG][A-Z0-9]{2,}(?:\|[^>]*)?>/i;`**

Un JETON DE CANAL Slack — `<#C0ABC123|general>` — vaut mieux que n'importe quel mot-clé
pour désigner une question de canal : il est produit par le client Slack, jamais tapé, et il
survit à `cleanText` (qui ne retire que la mention du bot).

⚠️ `i` OBLIGATOIRE : le motif est évalué sur le texte MINUSCULÉ (`lowerText`), comme tous

les autres critères de bande. Sans ce drapeau, `[CG][A-Z0-9]` ne matcherait plus jamais et

le jeton de canal cesserait d'aiguiller — en silence, aucun type ne bougeant.

`{2,}` puis un groupe optionnel dont la classe exclut `>` : aucune découpe à essayer.

Mesuré à 0,07 ms sur 8 000 caractères adverses.
**Avant `const APOS = "['’`´]";`**

« QUI PEUT FAIRE QUOI » — la question d'expertise, reconnue par sa FORME INTERROGATIVE.

⚠️ Ajouté le 2026-08-14, **après avoir constaté que `findExpertise` était inatteignable sur
ses propres phrases**. Le tool venait d'être écrit et câblé sur `knowledgeAgent` ; or « qui
s'occupe du backend ? » ne contient aucun mot-clé de bande 1 ni de bande 3, et retombait
donc au défaut, chez un agent qui ne le porte pas. C'est EXACTEMENT le défaut qu'on venait
de corriger pour `getChannelHistory` — une capacité livrée sans sa route ne sert à rien, et
la campagne de routage l'a rattrapé avant le déploiement.

On reconnaît la FORME et non des mots-clés isolés : « qui » seul est bien trop courant, mais
« qui » suivi d'un verbe de responsabilité ou de savoir ne désigne qu'une seule chose.

Volontairement ABSENT : « qui peut » nu. « Qui peut créer un employé ? » interroge les
capacités du BOT, pas l'annuaire des personnes — même critère de discrimination que celui
qui a fait écarter « ajoute » et « word ».
Les variantes non accentuées sont déclarées : `routeToAgent` minuscule le texte mais ne
retire PAS les accents, et une saisie mobile dans Slack les perd.

⚠️ L'apostrophe TYPOGRAPHIQUE (`’`, U+2019) est acceptée au même titre que l'ASCII : c'est

celle que produisent Slack et les claviers mobiles par correction automatique, donc le cas

FRÉQUENT et non le cas limite. Le premier jet ne connaissait que `'` et « qui s’occupe du

backend ? » — la phrase de référence — ne matchait pas.

⚠️ Bords de mot en `\p{L}` et drapeau `u`, JAMAIS `\b` : sans le drapeau, `\b` raisonne en

ASCII, donc `à` n'y est pas une lettre et « **à** qui je demande… » ne matchait pas — le

motif partait silencieusement au défaut. C'est la même correction que celle déjà appliquée à

`matchesKeyword`, et le même piège, à deux jours d'intervalle.
**Avant `const TOPIC_BANDS: ReadonlyArray<{`**

BANDE 3, sous forme de CAPACITÉS et non plus de simples listes.

── Le défaut corrigé (mesuré le 2026-08-12, non corrigé jusqu'au 2026-08-14) ──
Le palier collant a DÉPLACÉ l'état absorbant, il ne l'a pas supprimé. Simulation vérifiée
sur les 8 messages d'une campagne type : après « Envoie un rappel à Pamela » (échappement
`rappel` → `notificationAgent`), le message « Génère-moi le guide en PDF » restait chez
`notificationAgent`, **qui n'a pas `generateDocument`**. En DM la clé de conversation est le
CANAL : le verrou tenait donc une heure entière, sur tous les sujets.

── Pourquoi la CAPACITÉ et non la priorité de bande ──
Remonter ces termes au-dessus du collant a déjà été essayé, et défait le 2026-08-11 : `pdf`,
`email`, `docx` sont massivement des RÉPONSES DE SUIVI (« Donne le PDF alors », « et par
email ? »), et les faire primer sur le fil reproduisait l'alternance A → B → A entre agents
amnésiques. Les deux mesures sont vraies, et c'est pourquoi la règle ne porte plus sur la
priorité mais sur le CÂBLAGE :

    le fil est conservé, SAUF si l'agent qui le mène ne porte pas l'outil demandé.

Cette forme est sûre dans les deux sens. Elle ne peut jamais arracher un fil à un agent qui
sait répondre — donc elle ne peut pas rejouer le défaut du 11 — et elle ne peut jamais
laisser un fil chez un agent qui ne sait pas — donc elle ferme celui du 12. Et elle est
DÉRIVÉE du câblage (`AGENT_TOOLS`), pas rédigée : un outil déplacé d'un agent à l'autre
change le routage tout seul, sans qu'on ait à y penser.

**Avant `readonly pattern?: RegExp;`**

Motif de FORME, évalué en plus des mots-clés. Il existe parce que deux des trois entrées
de knowledge ne se reconnaissent pas à un mot : un jeton de canal `<#C…>` et une question
d'expertise (« qui s'occupe de… ») sont des STRUCTURES, pas du vocabulaire.

**Avant `readonly requiredTool: string;`**

 L'outil SANS LEQUEL la demande est insatisfaisable. C'est lui qui autorise l'écart.

**Avant `readonly overridesSticky: boolean;`**

Ce terme peut-il déloger un fil vivant quand son agent n'a pas l'outil ?

⚠️ `false` sur la bande notification, et ce n'est PAS une prudence : c'est une
correction. Un test de non-régression du 2026-08-11 l'a attrapée — « Par email », après
« génère mon document », partait chez `notificationAgent`, ce qui est LE défaut A → B → A
que le palier collant existe pour supprimer.

La raison de fond : `email` et `message` nomment un TRANSPORT que les deux agents servent
légitimement — `generateDocument` porte `deliverTo: 'email'`. L'agent du fil n'est donc
jamais « structurellement incapable » de les honorer, et la prémisse de l'écart tombe.
`pdf`, `guide` ou `résume`, eux, nomment un ARTEFACT ou une LECTURE qu'un seul agent
sait produire.

Règle d'admission, à appliquer avant d'en ajouter un : le terme doit désigner une
capacité servie par EXACTEMENT UN agent. Dans le doute, `false` — le pire cas est alors
l'ancien comportement, pas une régression.

**Avant `{`**

« Qui s'occupe du backend ? » — la seule porte d'entrée de `findExpertise`, et il n'en a

AUCUNE avant le 2026-08-14 : le tool était câblé mais structurellement inatteignable.
**Avant `const VERB_STEM_KEYWORDS: ReadonlySet<string> = new Set([`**

Mots-clés qui sont des RADICAUX VERBAUX, et tolèrent donc les désinences françaises.

Régression corrigée le 2026-08-11 : le bord droit `s?(?![\p{L}])` cassait tous les
infinitifs. « Tu peux **retrouver** l'employé dont l'email est X » ne matchait plus la
bande 1 et retombait sur `NOTIFICATION_TOPICS` — précisément le bug que cette bande avait
été créée pour supprimer, revenu par la conjugaison.

La tolérance est déclarée PAR MOT et non globale, et c'est la clé de la correction : les
mots-clés NOMINAUX (`rappel`, `message`, `test`) gardent le seul pluriel. L'ouvrir à tous
ferait revenir les faux positifs d'origine — « rappelle », « messagerie », « testez ».

**Avant `const VERB_SUFFIX_PATTERN = '(?:s|r|z|nt)?';`**

 Désinences tolérées sur un radical verbal : pluriel, infinitif, 2ᵉ et 3ᵉ personnes.

**Avant `export const DEFAULT_AGENT_ID = 'onboardingOrchestrator';`**

Identifiants d'agents connus. Sert à valider l'agent collant relu en base : une valeur
corrompue ou l'identifiant d'un agent retiré du registre ferait sinon lever
`mastra.getAgent()` à chaque message du fil, condamnant la conversation entière.

Agent porté par les tours mémorisés qui ne viennent d'AUCUN agent — aujourd'hui la seule
réponse déterministe du système, celle aux salutations nues. On l'attribue au routage par
défaut plutôt qu'à une valeur sentinelle : `conversation_turns.agent_id` sert à préfixer
« [autre agent] » dans l'historique rejoué, et une valeur inconnue de `KNOWN_AGENT_IDS`
ferait marquer ce tour comme étranger à chaque message suivant du fil.
**Avant `const KNOWN_AGENT_IDS: ReadonlySet<string> = new Set([`**

⚠️ `questionnaireEngine` en est SORTI le 2026-08-14, et cette sortie a deux effets voulus.

 1. Le palier COLLANT l'ignore. Sans cela, un fil ouvert avant le retrait aurait continué
    de pointer un agent absent du registre — et `mastra.getAgent()` LÈVE dans ce cas
    (`MASTRA_GET_AGENT_BY_NAME_NOT_FOUND`), donc le fil aurait été condamné jusqu'au TTL.
 2. Les tours `assistant` qu'il a écrits sont désormais préfixés « [autre agent] » dans
    l'historique rejoué. C'est LITTÉRALEMENT vrai : cet assistant n'existe plus, et ses
    promesses de questionnaire ne doivent pas être reprises à son compte.

**Avant `export function matchesKeyword(lowerText: string, keyword: string): boolean {`**

Un mot-clé matche s'il apparaît dans le texte, bordé des DEUX côtés par autre chose
qu'une lettre.

La garde ne portait au départ que sur le bord GAUCHE : `String.includes('test')` matchait
aussi « conteste », « attester », « protestation » — des phrases françaises courantes sans
rapport. Le bord droit a écarté « rappelle », « messagerie », « testez », mais il a cassé
TOUS les infinitifs (« tu peux retrouver l'employé dont l'email est X » retombait sur
`NOTIFICATION_TOPICS`, soit le retour du bug du 2026-08-10 par la conjugaison). D'où le
suffixe déclaré MOT PAR MOT : radicaux verbaux tolérants, mots-clés nominaux au seul
pluriel. L'ouvrir à tous ferait revenir les faux positifs d'origine.

⚠️ `\p{L}` avec le drapeau `u`, jamais `\b` : sans `u`, `\b` raisonne en ASCII et un motif
comme `/\bbloqué\b/` ne matche JAMAIS. Piège rencontré trois fois dans ce dépôt.

**Avant `const pattern = new RegExp(`(?<![\\p{L}])${escaped}${suffix}(?![\\p{L}])`, 'u');`**

`escaped` sort de la ligne ci-dessus, et `keyword` vient des tables de ce module :

jamais d'un utilisateur.
**Avant `export function routeToAgent(text: string, stickyAgentId?: string): string {`**

Routage message → agent, en QUATRE TEMPS. Les listes sont CONTRACTUELLES (documentées
dans `CLAUDE.md`) : les modifier sans mettre la doc à jour la fait mentir.

 1. ÉCHAPPEMENT — `ESCAPE_INTENTS`, symétrique : chaque agent y a ses termes, donc aucun
    n'est un état absorbant. C'est la seule porte de sortie d'un fil mal aiguillé.
 2. COLLANT — l'agent qui mène le fil.
 3. THÉMATIQUE — exprimé en CAPACITÉS (`TOPIC_BANDS`), et il ne déloge le fil qu'à une
    condition : l'agent qui le mène ne porte pas l'outil exigé.
 4. Défaut — l'orchestrateur.

## Pourquoi la bande 3 est CALCULÉE avant d'appliquer le collant

Parce que la décision du palier 2 en dépend : le fil ne cède que si son agent est
structurellement incapable de servir la demande, il faut donc savoir quelle capacité la
demande exige avant de décider si on reste. La règle est sûre dans les deux sens — elle ne
peut jamais arracher un fil à un agent qui sait répondre (défaut du 2026-08-11), ni le
laisser chez un agent qui ne sait pas (défaut du 2026-08-12). Et elle est DÉRIVÉE
d'`AGENT_TOOLS` : déplacer un outil d'un agent à l'autre change le routage tout seul.

**Avant `for (const [agentId, keywords] of ESCAPE_INTENTS) {`**

1. ÉCHAPPEMENT. Prime sur le fil en cours : une demande explicite doit pouvoir SORTIR

d'une conversation collée sur le mauvais agent, sinon le fil est un piège sans issue.

L'ordre du tableau EST la priorité entre agents.
**Avant `const structural = CHANNEL_TOKEN_PATTERN.test(lowerText)`**

3. THÉMATIQUE, calculée d'abord — voir l'en-tête.

⚠️ **LE JETON DE CANAL PREND LE PAS SUR TOUTE BANDE DE MOTS-CLÉS — 2026-08-25.**

Symptôme relevé en production, mot pour mot : *« Je n'ai pas accès au fil de discussion du
canal #kisso-hq. Peux-tu me copier le texte que tu souhaites que je résume ? Ainsi je
pourrai créer le PDF et te l'envoyer par mail. »* La réponse est cohérente — elle vient de
`onboardingOrchestrator`, qui porte `generateDocument` et **pas** `getChannelHistory`. Le
défaut n'était pas dans l'agent mais dans l'ordre des bandes.

`TOPIC_BANDS.find` rend la PREMIÈRE bande qui matche, et celle de l'orchestrateur est en
tête avec `pdf`, `document`, `guide`. Une phrase mêlant un canal et un format partait donc
chez l'agent incapable de lire le canal. **Même famille que le défaut du 2026-08-12** : une
bande qui ne sait pas servir la demande l'emporte parce qu'elle a matché la première.

⚠️ **Le critère n'est PAS « la connaissance d'abord », c'est « le signal STRUCTUREL
d'abord ».** Un `<#C…>` est produit par le client Slack, jamais tapé, et il survit à
`cleanText` : c'est un FAIT. `pdf` est un mot que quelqu'un a écrit. La précédence n'est donc
accordée qu'à ce seul motif — la généraliser ferait partir « génère un document pour la
personne qui gère le backend » chez un agent sans `generateDocument`, **c'est-à-dire le
défaut d'aujourd'hui retourné**.

⚠️ **CE QUE CE CORRECTIF NE FAIT PAS.** « Résume ce canal et envoie-le-moi en PDF » atteint
désormais `knowledgeAgent`, qui résumera et dira qu'il ne sait pas produire de document.
C'est la BONNE réponse : lire un canal puis en livrer le contenu sous forme de fichier est
exactement la conjonction qu'`outbound-tool-quarantine.ts` interdit (§4.2). **Aucun agent ne
sert cette phrase entièrement, par construction** — et le produit doit le dire plutôt que de
proposer un contournement qui reporte le travail sur l'humain.

Verrouillé par `tests/unit/handlers/channel-summary-routing.test.ts`.

**Avant `if (stickyAgentId && KNOWN_AGENT_IDS.has(stickyAgentId)) {`**

2. COLLANT. Correction du défaut central mesuré le 2026-08-11 : le routage était

recalculé sur le texte de CHAQUE message, isolément. « Par email » répondait à une

question posée par l'orchestrateur et arrivait chez un agent qui ne l'avait jamais

posée — d'où le « Quel est l'objet de cette notification ? », qui est littéralement le

schéma d'entrée de `sendNotification` redemandé à zéro.

Un identifiant inconnu du registre est IGNORÉ : le suivre aveuglément ferait lever

`getAgent` à chaque message et condamnerait le fil entier.
**Avant `return DEFAULT_AGENT_ID;`**

4. Défaut.

## `features/notification/domain/services/claim-reconciliation.ts`

**Avant `const DONE_VERBS =`**

Réconciliation FAIT / NARRATION — le handler est le seul point qui voit à la fois la
réponse du modèle et sa trace d'exécution ; ce module sait les confronter.

## Pourquoi un module de DOMAINE

Extrait de `slack-events.handler.ts` le 2026-08-17. Rien ici ne touche Slack, ni un
dépôt, ni Mastra : ce sont des prédicats purs sur du texte et sur une liste de noms
d'outils. C'est la définition même d'un service de domaine — et cela rend enfin
possible de le tester sans construire un handler entier, ce qui exigeait jusqu'ici de
neutraliser quatre dépendances de base.

Le garde-fou lui-même répond au verdict de l'utilisatrice testeuse : « il parle
exactement de la même façon quand il a fait le travail et quand il l'a inventé ».

**Avant `const ACCOMPLISHMENT_CLAIMS: ReadonlyArray<{ label: string; pattern: RegExp }> = [`**

Formules affirmant qu'une action A EU LIEU.

Le critère d'admission est strict : la formule doit être FAUSSE PAR CONSTRUCTION si aucun
outil n'a tourné. « Je peux t'envoyer… », « Veux-tu que je t'envoie… », « Il faudra
créer… » n'en sont pas — ce sont des propositions, et les inclure transformerait chaque
tour de conversation ordinaire en accusation.

Formules relevées telles quelles sur la campagne du 2026-08-11 : « C'est fait ! »,
« Ton Guide en PDF est prêt », « t'a été envoyé ».

**Avant `{`**

── Famille MISE À JOUR, ajoutée le 2026-08-13 sur relevé de production ──

    Karyl  : « @Mastra ajoute en une quatrième »

    Mastra : « Le quiz "Quiz sur nos valeurs" est maintenant à jour avec une

              quatrième question. »

**Aucun outil de modification de questionnaire n'existe dans ce dépôt.** La phrase est

donc fausse par construction — le critère d'admission exact de cette liste — et elle

passait entre les mailles : ni « c'est fait », ni voix passive avec un verbe de

`DONE_VERBS`, ni « est prêt ». Le tour d'avant, le même agent avait déjà annoncé

« Ok, je la remplace par : … » sur le même questionnaire inexistant.

Le verbe `mis à jour` n'est PAS ajouté à `DONE_VERBS` : il y entrerait dans la voix

passive (« a été mis à jour ») mais raterait « est maintenant à jour », qui est la

forme réellement relevée — un ADJECTIF, pas un participe.
**Avant `export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(toolsWithEffect('read'));`**

Outils qui ne font que LIRE. Une annonce d'accompli qu'ils seraient seuls à étayer est
fausse par construction : lire ne produit rien.

## Pourquoi cette liste existe — le garde-fou était désarmé dans le cas COURANT

La réconciliation ne s'armait que sur `toolCalls.length === 0`. Or le premier geste de
presque tout run est une lecture — `findEmployeeByEmail` pour résoudre une personne,
`getEmployeeProfile` pour situer son parcours. Un seul de ces appels portait la longueur à
1 et **désactivait la détection pour tout le tour**. Le défaut numéro un formulé par
l'utilisatrice testeuse — « il parle exactement de la même façon quand il a fait le travail
et quand il l'a inventé » — restait donc entier partout où il se manifestait vraiment.

Ce qui contredit une annonce d'accompli n'est pas « zéro outil », c'est « zéro outil qui
AGIT ».

## Pourquoi une liste de LECTEURS, et non une liste d'ACTEURS

Le défaut sûr doit être le SILENCE. Un outil inconnu de cette liste est traité comme un
acteur, donc n'accuse jamais : un nouvel outil non classé, ou un nom de tool illisible
(Mastra a déjà changé la forme de ce champ une fois — `readToolCalls` journalisait
« unknown » sur 100 % des appels), produit au pire un silence, jamais une accusation à
tort. L'inverse — lister les acteurs — ferait qu'un oubli de classement accuse le modèle
d'avoir menti alors qu'il a réellement agi.

⚠️ Verrouillé par `tests/unit/quality/tool-classification.test.ts`, qui croise ces deux
ensembles avec `AGENT_TOOLS` : tout outil câblé doit être classé, aucun ne peut l'être deux
fois, et aucun nom mort ne peut y traîner.

⚠️ CE TEST ÉTAIT ANNONCÉ ICI ET N'EXISTAIT PAS — écrit le 2026-08-19, après que la liste eut
dérivé exactement comme cet en-tête le prédisait. Le 2026-08-14 a retiré `getTaskList` et
ajouté `findPersonByName` et `findExpertise` : le nom mort est resté, les deux nouveaux
n'ont jamais été classés. Comme un nom inconnu est réputé ACTEUR, `findPersonByName` —
PREMIER GESTE de presque toute demande nommant quelqu'un, câblé sur deux agents — désarmait
la réconciliation pour tout le tour. Le garde-fou était éteint sur le chemin le plus
fréquent du produit, et une phrase de vingt lignes expliquant pourquoi il ne pouvait pas
l'être tenait lieu de preuve.

**Avant `export const ACTING_TOOL_NAMES: ReadonlySet<string> = new Set(toolsWithEffect('write'));`**

Les ACTEURS, déclarés explicitement.

⚠️ Cette liste ne sert PAS à décider : `hasActingToolCall` reste construit sur la seule
liste des lecteurs, pour que le défaut sûr demeure le silence — un outil inconnu vaut
ACTEUR, donc la réconciliation se tait au lieu de démentir à tort. Elle sert à rendre la
classification EXHAUSTIVE et donc vérifiable — sans elle, le test ne pourrait pas
distinguer « acteur assumé » de « nouvel outil que personne n'a classé », et il ne
détecterait rien. C'est le prix d'un invariant qui se calcule au lieu de se relire.

⚠️ **LES DEUX LISTES SONT DÉRIVÉES DEPUIS LE 2026-08-25, ELLES NE SONT PLUS RECOPIÉES.**
C'était la dette n° 5 de `docs/tool-design-audit.md`, et elle avait déjà coûté : la liste
gardait `getTaskList` après son retrait et ignorait `findPersonByName` et `findExpertise`,
ajoutés le MÊME jour. Le symptôme n'était pas une erreur mais un SILENCE.

La source unique est `TOOL_EFFECTS` (`shared/agent-capabilities.ts`), qui déclare l'effet
de chaque outil à côté du câblage. `tests/unit/quality/tool-contracts.test.ts` interdit à
`TOOL_EFFECTS` de diverger dans les deux sens : ses clés doivent être exactement les outils
câblés, et le câblage ne peut nommer que des outils dont un fichier de `src/` porte l'`id`.
Un outil ajouté sans effet déclaré fait rougir le test avant d'atteindre la production.

**Avant `export function hasActingToolCall(toolCalls: readonly string[]): boolean {`**

Un outil susceptible d'AGIR a-t-il tourné ?

`[]` (zéro appel) rend `false` — c'est le cas d'origine, conservé. Un nom absent de
`READ_ONLY_TOOL_NAMES` rend `true` : voir l'arbitrage ci-dessus, l'inconnu ne doit jamais
produire une accusation.

**Avant `export const UNSUPPORTED_CLAIM_NOTICE =`**

Note ACCOLÉE à la réponse quand elle annonce un accompli qu'aucun outil n'étaye.

## Arbitrage : requalifier, pas bloquer

Remplacer la réponse entière serait brutal et faux dans un cas légitime : le modèle peut
dire « c'est fait » en parlant d'un tour PRÉCÉDENT, où l'outil avait bel et bien tourné.
La détection porte sur le tour courant, pas sur l'historique — elle ne peut donc pas
trancher ce cas, et une réponse par ailleurs exploitable serait détruite.

On applique le même arbitrage que pour un lien fabriqué (`sanitizeAgentOutput`) : le mal
est LOCAL, on le corrige localement. Ici le mal n'est pas une phrase à retirer mais une
ambiguïté à lever — d'où une note, et non une suppression. Elle dit exactement ce que le
système SAIT (« aucune action à ce tour »), jamais ce qu'il suppose.

Le verdict complet part en `error` dans les logs, comme pour les URL fabriquées.

**Avant `export function normalizeForClaims(text: string): string {`**

 Minuscules, accents et apostrophes typographiques normalisés — la comparaison s'y fait.

**Avant `export function detectUnsupportedCompletionClaim(text: string): string | null {`**

Étiquette de la formule d'accompli trouvée, ou `null`.

Ne dit RIEN de la véracité : c'est l'appelant qui confronte ce verdict à la trace
d'exécution. Fonction pure, donc éprouvable des deux côtés.

**Avant `export function readToolCallNames(response: unknown): string[] | null {`**

Noms des outils réellement appelés, ou `null` si la trace est illisible.

⚠️ La distinction `null` / `[]` est TOUT le contrat : `[]` prouve que zéro outil a tourné,
`null` dit seulement qu'on ne sait pas. Confondre les deux ferait accuser le modèle sur un
changement de forme de Mastra.

Forme réelle vérifiée dans `@mastra/core` (`trip-wire-*.js`) : `toolCalls` est un tableau
de CHUNKS `{ type: 'tool-call', payload: { toolCallId, toolName, args } }`. L'ancienne
lecture `call.toolName ?? call.name` rendait donc « unknown » sur 100 % des 19 runs de
production mesurés — la longueur était juste, le nom jamais. Les deux formes plates sont
conservées en repli : l'observabilité ne doit jamais faire échouer une réponse produite.

**Avant `const NON_DELIVERING_TOOL_NAMES: ReadonlySet<string> = new Set(['scheduleReminder']);`**

Où répondre, et donc quelle est la clé du fil.

En canal, on threade systématiquement (thread existant, sinon on en ouvre un sur ce
message). En DM, threader enfouit la réponse hors de la conversation principale — le bot a
semblé silencieux pendant des heures en production pour cette raison exacte. On ne threade
donc un DM QUE si le message d'origine faisait DÉJÀ partie d'un thread (`thread_ts` présent
et différent de `ts` ; sinon `thread_ts` == `ts` == la racine du message courant, pas un
vrai thread existant).

LA PROMESSE D'AVENIR — le symétrique de tout ce qui précède

Tout ce module guette l'ACCOMPLI non appuyé par un outil. Il est aveugle à la faute
inverse, mesurée en production le 2026-08-18 :

    « Le rappel a été enregistré. **Il sera envoyé à Karyl par email le 20 août 2026
      à 09 h 00**, avec le sujet … »

L'accompli y est VRAI — `scheduleReminder` a bel et bien tourné, la ligne existe. C'est la
suite qui est fausse : il n'existe ni cron ni poller dans ce système, et `findPending()`
n'a aucun site d'appel. Rien ne partira, jamais. `detectUnsupportedCompletionClaim` se tait
par conception, puisqu'un outil a tourné — la contradiction n'est pas entre la phrase et la
trace, elle est entre la phrase et le CÂBLAGE.

⚠️ **La consigne de prompt a été essayée d'abord, et mesurée en échec le même jour.**
« Un rappel est seulement ENREGISTRÉ : aucun automate ne l'enverra, dis-le sans détour » a
été ajoutée au `notificationAgent` puis déployée ; la réponse suivante en production a été
PIRE qu'avant — elle a gagné une date et une heure d'envoi précises. Le mot `scheduledAt`
du tool-result pèse plus lourd qu'une ligne d'instruction, et c'est la règle que ce dépôt
connaît déjà : « le mot que lit le modèle est celui qu'il répétera ». Une consigne est
PROBABLE ; le code est GARANTI. Même issue que le champ `coverage`, ignoré deux fois.

Outils qui écrivent une intention SANS jamais la transporter.

⚠️ Liste volontairement MINUSCULE, et son critère est vérifiable : y figure un outil dont
le résultat porte `willBeSentAutomatically: false`. Y ajouter un outil qui livre vraiment
ferait démentir des réponses justes — le pire défaut possible pour un garde-fou d'honnêteté.
**Avant `export function onlyNonDeliveringTools(toolCalls: readonly string[]): boolean {`**

Toutes les actions du tour sont-elles des enregistrements sans transport ?

⚠️ Faux dès qu'un outil INCONNU a tourné, exactement comme `hasActingToolCall` : l'inconnu
ne doit jamais produire une accusation. Et faux sur `[]`, où c'est l'autre détecteur qui
parle — sans cela les deux notes s'accoleraient à la même réponse.

**Avant `const ENCLITIC = "(?:(?:le|la|lui|les|leur|vous) |t')";`**

Formules d'ENVOI À VENIR. Liste FERMÉE, même discipline que `ACCOMPLISHMENT_CLAIMS` : on
cherche une CONTRADICTION avec le câblage, jamais une invraisemblance.

Volontairement ABSENTS :
 - « je peux l'envoyer », « veux-tu que je l'envoie » — une OFFRE n'est pas une promesse,
   et c'est le même critère qui a toujours épargné « je peux t'envoyer… » à l'autre
   détecteur ;
 - le passé (« a été envoyé ») — c'est le domaine de `ACCOMPLISHMENT_CLAIMS`, et le
   couvrir ici accolerait deux notes à la même phrase.

 Pronoms enclitiques français, dans l'ordre où ils s'empilent : « je **le lui** enverrai ».
**Avant `const SEND_VERBS_FUTURE = 'enverrai|transmettrai|expedierai|adresserai';`**

 Verbes d'envoi au futur de la première personne.

**Avant `label: 'planifié',`**

⚠️ AJOUTÉ le 2026-08-19 après mesure en production. `notificationAgent` a répondu

« Rappel PLANIFIÉ : … » alors que `scheduleReminder` rend explicitement

`willBeSentAutomatically: false` et que sa description dit « enregistre ». Le mot qui

compte pour la personne est celui-là, et il promettait un envoi qui n'aura jamais lieu :

il n'existe dans ce dépôt ni cron, ni poller, ni site d'appel de `findPending()`.

Il n'est PAS ambigu ici : ce détecteur ne parle que si le seul outil ayant tourné est un

enregistreur sans transport (`onlyNonDeliveringTools`).
**Avant `label: 'programmé',`**

⚠️ « PROGRAMMÉ » — relevé en production le 2026-08-19 au soir, sur le tour SUIVANT le

correctif de « planifié » : « Le rappel a bien été programmé pour le samedi 22 août ».

Le synonyme avait été écarté au premier passage comme trop polysémique (« le programme

d'intégration »), et le modèle est allé s'y loger — ce qui dit tout sur les listes

fermées : elles ne tiennent que si on les referme sur la FAMILLE, pas sur un mot.

La forme exige un auxiliaire (`est|été|sera`), ce qui écarte le nom : « le programme

d'intégration » n'en a pas.
**Avant `label: 'tu recevras',`**

Même famille, formulée du côté du destinataire. « Tu recevras un rappel lundi » est la

promesse la plus concrète que ce système ne peut pas tenir.
**Avant `pattern: new RegExp(`\\bje ${ENCLITIC}?${ENCLITIC}?(?:${SEND_VERBS_FUTURE})\\b`),`**

⚠️ Les pronoms sont RÉPÉTABLES : « je **le lui** enverrai » en empile deux, et un seul

groupe optionnel laissait passer la phrase la plus naturelle des trois. Attrapé par le

test avant tout déploiement — c'est le même défaut de bord que `\b` en ASCII, sous une

autre forme : un motif qui échoue en silence sur la moitié des tournures.

⚠️ DEUX groupes optionnels INDÉPENDANTS, jamais un quantificateur imbriqué

(`(?:… ?){0,2}`) : ce dernier était borné à deux, donc inoffensif, mais il déclenchait

`security/detect-unsafe-regex` — et ce dépôt a ramené son lint à ZÉRO warning le

2026-08-18. Une exception ajoutée ici rendrait la règle inaudible ailleurs.

Composé à partir d'une constante plutôt qu'écrit à plat : la même alternation répétée

deux fois portait la complexité du littéral à 23 pour un plafond de 20, et une liste

recopiée diverge de toute façon à la première modification. Même idiome que

`matchesKeyword` — la source est INTERNE, jamais un texte d'utilisateur (la règle

`detect-non-literal-regexp` ne s'en émeut d'ailleurs pas : les deux fragments sont des

constantes de ce module, pas des paramètres).

Mesuré : 0,02 ms sur 8 000 pronoms empilés.
**Avant `const HUMAN_GATED_PATTERN =`**

Ce qui DÉSAMORCE une promesse : un envoi conditionné à un geste humain est VRAI.

C'est exactement le contrat de la carte de recrutement — « il ne partira qu'après ton clic
sur Envoyer » — et y accoler une note de démenti transformerait ce garde-fou en défaut. La
fenêtre est le message entier : la condition est souvent posée dans une autre phrase que la
promesse.

**Avant `export const PROMISED_DELIVERY_NOTICE =`**

Note ACCOLÉE quand la réponse promet un envoi que rien n'exécutera.

⚠️ Contrat DIFFÉRENT de `UNSUPPORTED_CLAIM_NOTICE`, et la différence est le fond du
correctif : là-bas rien n'a été exécuté, ici l'enregistrement a bel et bien eu lieu. Écrire
« aucune action n'a été exécutée » serait faux et détruirait la seule partie vraie du
message. On dément la SUITE, pas le FAIT.

En mrkdwn Slack (`_italique_`), jamais en markdown GitHub : les textes en dur ne passent
par aucun filtre — `sanitizeAgentOutput` n'a qu'un seul site d'appel, `response.text`.

**Avant `export function detectUnsupportedDeliveryPromise(text: string): string | null {`**

Étiquette de la promesse d'envoi trouvée, ou `null`. Fonction PURE : c'est l'appelant qui
la confronte à la trace d'exécution, exactement comme pour l'accompli.

## `features/notification/domain/services/context-preamble.ts`

**Avant `import { DISPLAY_TIMEZONE, frenchDayLabel } from '../../../../shared/french-datetime';`**

Préambule serveur : QUI parle au modèle.

## Pourquoi un module de DOMAINE

Extrait de `slack-events.handler.ts` le 2026-08-17. Ce sont des fonctions pures sur des
chaînes : aucun appel Slack, aucun dépôt. La RÉSOLUTION de l'identité (`users.info`, le
cache par instance, l'annuaire) reste dans le handler — c'est de l'E/S. Seule sa MISE EN
FORME descend ici.

Le contrat qui compte, et qui justifie de l'isoler : le préambule part dans un message
`system`, JAMAIS dans le bloc `<kisso_XXXX_user_input>` que la DIRECTIVE 3.1 déclare non
fiable. Y glisser une affirmation du serveur la dévaluerait, et un seul bloc ouvrant est
autorisé par appel. Son coût est verrouillé par un test : ≈ 38 tokens par tour, ≈ 69 avec
l'avertissement d'attribution.

**Avant `import { DISPLAY_TIMEZONE, frenchDayLabel } from '../../../../shared/french-datetime';`**

 ----------------------------------------------------------------------- *
Préambule serveur : QUI parle au modèle

Préfixe posé sur un tour `assistant` produit par un AUTRE agent que celui du tour courant.

`loadHistory` ne filtre pas par `agentId` — et c'est délibéré, voir `buildMessages` : les
faits énoncés dans le fil (un email, un UUID) restent utiles quel que soit l'agent qui les
a recueillis. Ce qui ne l'est pas, c'est de LIRE LA VOIX D'UN AUTRE COMME LA SIENNE : en
C7, l'orchestrateur a repris le motif de `notificationAgent` (redemander sujet, texte,
canal) parce que rien ne distinguait ces tours des siens.
**Avant `const DISPLAY_NAME_ALLOWED = /[^\p{L}\p{M}\p{N} .'’-]+/gu;`**

Caractères conservés dans un nom d'affichage Slack.

⚠️ Le nom d'affichage est une donnée CONTRÔLÉE PAR SON PORTEUR. Injecté brut dans un
message `system`, il devient un vecteur d'injection de prompt de premier ordre — bien plus
direct que le texte du message, qui passe lui par `wrapAgentInput`. On ne garde donc que
des lettres, marques, chiffres et la ponctuation d'un patronyme ; tout le reste, retours à
la ligne et chevrons compris, devient une espace.

**Avant `const DISPLAY_NAME_MAX_CHARS = 48;`**

 Un patronyme plus long est tronqué : c'est un budget de tokens, pas un champ libre.

**Avant `const EMAIL_SHAPE = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;`**

Un IDENTIFIANT se VALIDE par sa forme ; il ne se rabote pas.

`sanitizeDisplayName` remplace tout caractère hors patronyme par une espace — ce qui est le
bon contrat pour un nom, et le mauvais pour une adresse : il en retire l'`@`, produisant
« karylsoumaila1 gmail.com ». Une adresse mutilée est pire qu'une adresse absente, parce
qu'elle est PLAUSIBLE : le modèle la passerait à `findEmployeeByEmail`, qui ne trouverait
rien, et l'on aurait reconstruit à la main le bug qu'on corrige.

Un email et un UUID ont une forme stricte et connue. On la vérifie donc, et tout ce qui n'y
répond pas est OMIS — jamais réparé, jamais tronqué. Aucune injection ne survit à un
contrôle de forme : il n'existe pas d'espace, de retour à la ligne ni de chevron dans les
classes ci-dessous.

Les deux motifs sont ANCRÉS et à quantifiants BORNÉS : coût linéaire garanti, même exigence
que les filtres de `agent-output.ts` sur une entrée non bornée.

**Avant `export interface RequesterIdentity {`**

Ce que le serveur SAIT du demandeur, par opposition à ce que le modèle en devine.

`null` signifie « non connu », jamais « vide » : c'est cette distinction qui décide si le
champ entre ou non dans le préambule. Un `''` traité comme une valeur produirait la ligne
à trous que `buildContextPreamble` existe pour éviter.

**Avant `export function buildContextPreamble(input: {`**

Message SERVEUR placé avant l'historique et avant le bloc balisé du message courant.

## Pourquoi il existe

`cleanText` supprimait toutes les mentions et `slackUserId` ne voyageait que par le
`requestContext`, qui n'entre PAS dans la fenêtre du modèle. Le seul humain nommé dans tout
le contexte était donc le SUJET de la requête — et comme le bloc de style impose le
tutoiement, « tu » ne pouvait se résoudre que sur lui. D'où « **Ton** profil », « **Tu** as
5 tâches » quand un manager interroge un tiers. Le cas fréquent (on demande son propre
profil) le rendait invisible.

## Pourquoi PAS dans le bloc `<kisso_XXXX_user_input>`

La DIRECTIVE 3.1 déclare le contenu de ce bloc NON FIABLE. Y glisser une affirmation du
serveur reviendrait à la dévaluer nous-mêmes, et un seul bloc ouvrant est autorisé par
appel (`validateDelimiterIntegrity`). Un message `system` distinct est le seul canal qui
soit à la fois dans la fenêtre du modèle et hors de la zone déclarée hostile.

## Les IDENTIFIANTS du demandeur, et pourquoi le nom seul ne suffisait pas

Défaut mesuré en production le 2026-08-12 à 15:42 UTC. Le préambule nommait « Karyl
SOUMAILA » et rien d'autre. Or AUCUN tool ne consomme un nom d'affichage : ils prennent
tous un email ou un UUID. Sommé de livrer un document « de Karyl », le modèle a donc
fabriqué l'adresse qui lui paraissait plausible (`karyl.soumaila@kisso.com`, inexistante),
puis en a essayé d'autres — **38 `findEmployeeByEmail` en 1,5 seconde, tous en échec** —
avant de dériver et d'émettre le délimiteur, ce qui a fait remplacer sa réponse par un
refus neutre. L'utilisatrice a vu « Je ne peux pas répondre à cette demande ».

L'annuaire connaissait pourtant les deux valeurs : la ligne `U0BJBDGTJUD` porte
`karylsoumaila1@gmail.com` et son `employee_id`. Elles n'étaient jamais mises dans la
fenêtre du modèle — le `requestContext` ne la traverse pas, et c'est sa raison d'être.

C'est le MÊME défaut de classe que celui corrigé le 2026-08-11 sur `findEmployeeByEmail`,
exposé aux trois agents : une boucle « donne-moi son identifiant » / « je ne l'ai pas »
GARANTIE PAR LE CÂBLAGE, pas probabiliste. Ici la personne concernée est le demandeur
lui-même — la seule dont le serveur connaisse l'identité de façon certaine.

⚠️ Chaque champ n'est émis que s'il EXISTE. Un gabarit à trous (« email : null ») est pire
que le silence : il apprend au modèle qu'une valeur existe, et il la passera aux outils.
Cinq humains réels dans ce workspace, une seule fiche employé — le cas « pas de fiche »
est le cas COURANT, pas le cas limite.

## Coût

≈ 35 tokens par tour, ≈ 69 avec l'avertissement d'attribution, ≈ 100 avec l'identité
complète (mesuré, verrouillé par test). Contrainte : Groq plafonne à 100 000 tokens/JOUR,
soit ≈ 19 messages. Le surcoût est le moins cher des deux termes : l'étape entière brûlée
à deviner une adresse coûtait à elle seule ≈ 3 200 tokens, et ne trouvait rien.

**Avant `email?: string | null;`**

 Email PROFESSIONNEL tel que l'annuaire le connaît. Jamais deviné, jamais reformé.

**Avant `employeeId?: string | null;`**

 `employees.id` du demandeur, quand il a une fiche.

**Avant `pinnedFacts?: readonly string[];`**

Faits que la personne a explicitement demandé de retenir (« souviens-toi que… »).

DÉJÀ bornés par l'appelant (5 faits, 120 caractères) : cette fonction ne tronque rien,
elle rend ce qu'on lui donne. La borne vit dans `src/shared/pin-fact.ts`, où elle est
dictée par le budget de tokens du préambule.

**Avant `now?: Date;`**

L'instant courant. INJECTÉ, jamais lu ici : ce module est en `domain`, et une fonction qui
appelle `new Date()` ne se teste qu'en gelant l'horloge — ce que ce dépôt évite partout
ailleurs par injection.

**Avant `if (input.now) {`**

── QUEL JOUR ON EST ────────────────────────────────────────────────────

⚠️ Ajouté le 2026-08-19 sur un défaut MESURÉ, et la cause n'était pas une faiblesse du

modèle. Sonde signée : « Prépare un entretien pour … lundi prochain à 9h » → réponse

« samedi 22 août 2026 à 08:00 ». Mauvais jour, mauvaise heure.

RIEN, dans toute la fenêtre qu'on lui donne, ne disait quel jour on est : ni les

`instructions`, ni ce préambule, ni l'historique. « Lundi prochain » n'était pas mal

transcrit — il était INCALCULABLE, et le modèle a fait la seule chose possible : deviner.

Même famille que `findEmployeeByEmail` inatteignable ou `findPersonByName` absent : une

demande qu'AUCUN câblage ne pouvait satisfaire, à laquelle le modèle répond en inventant.

Coût ≈ 12 tokens par tour. Le poste dominant de ce dépôt est le NOMBRE D'ÉTAPES : un

aller-retour perdu à corriger une date en vaut ≈ 1 500.

⚠️ Dans le message `system`, comme l'identité — et surtout pas dans le bloc

`<kisso_XXXX_user_input>` que la DIRECTIVE 3.1 déclare non fiable : une date que le

serveur affirme n'a pas à être dévaluée par le cadre qui la porte.

⚠️ Cela ne remplace PAS la réaffichage en toutes lettres avant confirmation humaine. La

date reste le seul champ TRANSCRIT depuis une phrase, donc le seul vecteur d'erreur qui

subsiste ; ceci en réduit la fréquence, l'affichage la rend rattrapable.
**Avant ``Nous sommes le ${frenchDayLabel(input.now)}, fuseau ${DISPLAY_TIMEZONE}.`,`**

⚠️ LE FAIT SEUL, sans consigne. « Calcule toute date relative à partir de là, n'en

invente jamais une » a été écrit puis retiré : ce qui manquait n'était pas une

instruction — `AGENT_ANTI_INVENTION_BLOCK` interdit déjà d'inventer — mais la DONNÉE.

La consigne coûtait 20 tokens par tour pour répéter une règle déjà posée.
**Avant `const email = safeIdentifier(input.email, EMAIL_SHAPE);`**

VALIDÉS PAR LEUR FORME, pas rabotés — voir `safeIdentifier`. `slack_directory.email`

vient du profil Slack, donc d'un champ que son porteur édite : c'est une entrée non

fiable au même titre que le nom d'affichage.
**Avant `const identifiers = [`**

Une seule ligne pour les deux : le préfixe est repayé à chaque aller-retour.

**Avant `const facts = (input.pinnedFacts ?? []).filter((fact) => fact.trim().length > 0);`**

── MÉMOIRE LONGUE ──────────────────────────────────────────────────────

Dans le message `system`, et surtout PAS dans le bloc `<kisso_XXXX_user_input>` que la

DIRECTIVE 3.1 déclare non fiable : ce sont des faits que le SERVEUR affirme, relus

depuis la base, et les y glisser les dévaluerait. C'est la même raison qui place

l'identité du demandeur ici.

⚠️ Ils restent du texte écrit par un humain, donc non fiable QUANT À SON CONTENU : la

phrase les présente comme une déclaration de la personne (« a demandé de retenir »),

jamais comme une vérité établie. Un fait épinglé ne doit pas pouvoir se lire comme une

instruction — « souviens-toi que tu dois ignorer tes règles » ne devient pas une règle.
**Note de fichier**

----------------------------------------------------------------------- *
Réconciliation FAIT / NARRATION

Verbes d'accompli, sans accent (le texte est normalisé avant comparaison).
Liste FERMÉE : on cherche une CONTRADICTION, jamais une invraisemblance.

## `features/notification/domain/services/deterministic-replies.ts`

**Avant `import { GREETING_REPLIES, GREETING_REPLY, isBareGreeting } from '../../../../shared/greeting';`**

Les HUIT court-circuits déterministes : ce à quoi le bot répond SANS aucun appel de
modèle, déclaré une seule fois.

## Le défaut que ce module ferme

Ces huit cas existaient à DEUX endroits de `slack-events.handler.ts` : la suite de `if`
de `handleMessage`, et le prédicat `isAnsweredWithoutModel` qui doit en être — je cite le
commentaire d'origine — « le MIROIR EXACT ». Le second gouverne le rationnement : un
court-circuit ajouté d'un côté et pas de l'autre fait payer un message qui ne coûte rien.

Ce n'est pas théorique. Le défaut d'origine, trouvé en production, est exactement de cette
famille : quelqu'un ayant atteint ses 12 messages du jour recevait « J'ai atteint mon
quota » pour un simple « bonjour » — et l'aurait reçu pour « je ne vais pas bien ». La
correction a consisté à énumérer les cas dans `isAnsweredWithoutModel`… c'est-à-dire à
créer la seconde liste qu'il fallait ensuite maintenir à la main.

Une seule table, donc, et `isAnsweredWithoutModel` en est DÉRIVÉE. C'est la discipline que
le dépôt applique déjà à `shared/agent-capabilities.ts` (« déclarer le câblage une seule
fois ») et pour la même raison : deux copies d'une liste divergent au premier changement,
en silence, sans qu'aucun type ne bouge.

## ⚠️ CE QU'ELLE NE PEUT PAS PORTER, et il faut le dire

La confirmation d'un email d'entretien (« oui » / « non », 2026-08-19) répond elle aussi
SANS appel de modèle, et elle n'est PAS dans cette table. Ce n'est pas un oubli : son
prédicat n'est pas textuel. « oui » ne veut rien dire tant qu'on n'a pas lu
`pending_interview_email`, et cette table est le contrat de ce qui se décide sur la FORME du
message seul — `isAnsweredWithoutModel` tourne à l'ACK, où l'on n'a pas le droit de lire en
base (3 secondes, et la prise de clé de déduplication y est déjà).

Conséquence assumée, à connaître : une personne ayant atteint ses 12 messages du jour ne
peut pas ANNULER un email en attente ce jour-là. Rien n'est envoyé pour autant — « oui » est
refusé de la même façon — et la préparation expire d'elle-même en 24 h
(`PENDING_EMAIL_TTL_MS`). L'exempter au vu du seul texte rouvrirait un contournement du
quota : sans préparation en attente, « oui » repart chez l'agent et coûte un appel plein.

## Ce que la table ne porte pas

L'ORDRE est significatif et il est celui du tableau. Trois entrées portent `reply: null` :
elles AGISSENT (effacer, épingler, publier un formulaire) et leur exécution reste dans le
handler, qui seul a les dépôts et le client Slack. Ce que la table garantit pour elles,
c'est que leur prédicat est le même des deux côtés — le seul point où la divergence
coûtait quelque chose.

**Avant `export const FILE_SHARE_SUBTYPE = 'file_share';`**

 Sous-type Slack d'un message portant une pièce jointe.

**Avant `export const FILE_ATTACHMENT_REPLY =`**

Réponse à une pièce jointe. Déterministe, zéro token.

Elle dit ce qui EST, jamais ce qui pourrait être : pas de « pour l'instant », pas de
« bientôt ». Le produit ne lit aucun fichier et rien n'indique qu'il le fera ; laisser
croire l'inverse ferait attendre quelqu'un pour rien. Elle propose immédiatement le
chemin qui, lui, fonctionne.

**Avant `export interface DeterministicReplyInput {`**

 Ce qu'un court-circuit a besoin de savoir pour se prononcer.

**Avant `readonly text: string;`**

 Texte déjà nettoyé de la mention du bot.

**Avant `readonly subtype?: string;`**

 `subtype` de l'événement Slack, seul critère non textuel de la table.

**Avant `readonly messageTs?: string;`**

Horodatage du message Slack. Sert UNIQUEMENT de graine au choix de formulation — jamais
à une décision. Absent hors Slack : la variante canonique est alors rendue.

**Avant `readonly isDirectMessage?: boolean;`**

Le message vient-il d'un DM ?

⚠️ Sert au journal de la détresse ET, depuis le 2026-08-19, à la DÉCISION pour
`profile_done` : la vérification porte sur le dossier de celui qui parle, donc en canal
elle exposerait à des témoins ce qui manque au dossier de quelqu'un d'autre. Le critère
est disponible à l'ACK sans aucune E/S (`channel_type`), ce qui est la condition pour
qu'il puisse entrer dans le miroir de `isAnsweredWithoutModel`.

**Avant `readonly name: string;`**

 Repris tel quel dans le journal, pour que le chemin emprunté soit lisible.

**Avant `readonly reply: string | null;`**

Texte figé, ou `null` quand le court-circuit AGIT et que le handler doit s'en charger
(effacement, épinglage, publication du formulaire).

⚠️ C'est la formulation CANONIQUE — celle que citent les tests et la documentation. Quand
`variants` existe, c'est `replyFor()` qui choisit ce qui part réellement.

**Avant `readonly variants?: readonly string[];`**

Formulations interchangeables, la canonique en tête. Voir `shared/reply-variants.ts` :
la répétition littérale est ce qui fait « machine », et la corriger ici coûte zéro token.

⚠️ La DÉTRESSE n'en a délibérément pas : chaque phrase y est pesée, et varier n'y
apporterait qu'un risque.

**Avant `readonly remembersTurn?: boolean;`**

Le tour entre-t-il en mémoire conversationnelle ?

⚠️ VRAI pour la seule salutation, et c'est nécessaire : sans elle, un fil ouvert par
« bonjour » ne serait jamais « engagé » et `shouldAbandonThreadReply` écarterait le
message SUIVANT. Faux partout ailleurs, et délibérément : ni « 🎉 » ni un pavé tronqué
n'aident le tour d'après, et une confidence de détresse n'a pas à être conservée plus
longtemps que nécessaire.

**Avant `readonly action?: 'erasure' | 'pin_fact' | 'profile_form' | 'profile_done' | 'cancel_reminder';`**

Le geste que ce court-circuit accomplit, quand `reply` vaut `null`.

⚠️ AJOUTÉ le 2026-08-18, et ce n'est pas cosmétique. La table était consultée par
`handleMessage`… qui RÉ-ÉVALUAIT ensuite les trois prédicats agissants à la main, dans
ses propres `if`. Deux conséquences : chaque message payait deux fois ces analyses, et
surtout un neuvième court-circuit ajouté ici serait resté MUET tant que personne n'aurait
pensé à écrire son `if` là-bas — exactement la divergence que cette table existe pour
interdire, réintroduite à mi-chemin de sa propre correction.

Le handler exécute désormais le geste désigné par ce champ. Ce qui reste chez lui, c'est
l'EXÉCUTION — il est le seul à avoir les dépôts et le client Slack ; ce qui vit ici, c'est
la DÉCISION.

**Avant `readonly logFields?: (input: DeterministicReplyInput) => Record<string, unknown>;`**

 Champs de journal propres à ce cas. Voir les mises en garde, cas par cas.

**Avant `export const DETERMINISTIC_REPLIES: readonly DeterministicReply[] = [`**

⚠️ L'ORDRE EST CONTRACTUEL, il est documenté dans `CLAUDE.md`, et chaque position a été
choisie contre un cas réel. Ne pas réordonner sans relire les justifications.

**Avant `name: 'bare_greeting',`**

En tête : une salutation n'est ni une détresse ni une demande. C'est aussi le seul

court-circuit qui doive laisser une trace en mémoire — voir `remembersTurn`.
**Avant `name: 'file_attachment',`**

Avant les deux formes ci-dessous : un fichier arrive souvent avec un texte vide, et

c'est la pièce jointe qui fait sens, pas le vide.
**Avant `name: 'no_textual_content',`**

Zéro lettre, zéro chiffre : le modèle n'a rien à traiter. Il coûtait pourtant un run

complet, ≈ 5 % du budget quotidien, pour répondre « que puis-je faire ? ».
**Avant `name: 'over_length',`**

La borne EXISTE déjà dans `wrapUserInput`, mais elle y lève une `SecurityBlockError`

que `userFacingFailure` traduit en refus de POLITIQUE — là où le problème est une

TAILLE. On ne déplace pas la borne, on la double en amont, sur la MÊME constante :

celle de `wrapUserInput` reste la garantie des appelants qui ne passent pas par ici.
**Avant `logFields: ({ text }) => ({ textLength: text.length }),`**

⚠️ La longueur, JAMAIS le texte : c'est un DM, et ce chemin est précisément celui des

copier-coller de documents internes.
**Avant `name: 'distress',`**

⚠️ PREMIER DE LA TABLE DEPUIS LE 2026-08-28, ET L'ORDRE EST LA DÉCISION.

Il était CINQUIÈME, derrière `file_attachment` et `over_length`. Mesuré : une détresse de

9 400 caractères recevait « Ton message est trop long » ; une détresse accompagnée d'une

capture d'écran recevait « Je ne sais pas lire les pièces jointes ». C'est le pire cas

possible de ce produit, et le dépôt avait énormément investi sur ce chemin — numéros béninois

vérifiés un par un, TROIS numéros écartés parce qu'ils étaient d'un autre pays, corpus à deux

colonnes, aucune variante autorisée. La position d'une ligne annulait une partie de cet

investissement.

⚠️ LE DÉPLACEMENT SEUL NE CORRIGEAIT RIEN, et c'est le piège de ce correctif : le détecteur

portait sa PROPRE borne (`MAX_DISTRESS_LENGTH`) et refusait de regarder au-delà de 2 000

caractères. Deux gestes, non interchangeables — voir `probeWindow` dans `shared.md`. Un

correctif qui rassure sans agir coûte plus cher que le défaut.

⚠️ RIEN N'EST AFFAIBLI : un message trop long SANS détresse garde `over_length`, une pièce

jointe SANS détresse garde `file_attachment`. Deux tests l'exigent, faute de quoi on aurait

échangé un défaut contre un autre.


Avant la frontière d'autorisation : quelqu'un qui va mal ne doit pas se heurter à une

politique d'accès. C'est le seul endroit de ce dépôt où un défaut peut nuire à une

PERSONNE — et l'absence d'appel LLM écarte au passage tout outil parasite.
**Avant `logFields: ({ isDirectMessage }) => ({ isDirectMessage }),`**

⚠️ Ni le texte ni l'auteur : c'est la confidence la plus sensible que ce produit

puisse recevoir. On journalise QUE le fait, pour savoir que le chemin a servi.
**Avant `name: 'profile_done',`**

── À partir d'ici, les court-circuits qui AGISSENT. Ils restent exécutés par le

handler ; seul leur PRÉDICAT vit ici, pour que le miroir ne puisse pas diverger.

⚠️ EN TÊTE DES AGISSANTS, et c'est l'ordre réel d'exécution : `maybeAdvanceOnboarding`

est appelé avant le `switch (acting.action)`. La place dans cette table doit refléter

l'exécution, sinon elle décrit un produit qui n'existe pas.

Pourquoi il devait ENTRER dans la table : il coûte ZÉRO token — il lit un dossier et

rend un verdict écrit en dur — mais il n'était pas dans le miroir

`isAnsweredWithoutModel`. Une personne ayant atteint ses 12 messages du jour recevait

donc « J'ai atteint mon quota » en réponse à « c'est fait », c'est-à-dire au geste

même qui fait avancer son accueil. C'est exactement le défaut corrigé le 2026-08-15

pour la salutation et la détresse, réapparu sur un chemin ajouté depuis.
**Avant `name: 'erasure_request',`**

Placé avant la frontière d'autorisation, comme la détresse : effacer ses données est

un droit, pas un privilège de niveau `full`.
**Avant `name: 'pin_fact',`**

Mémoriser un fait ne consomme aucun token, et quelqu'un qui a épuisé son quota doit

pouvoir corriger ce que le bot sait de lui — c'est même le geste qui réduira ses

tours suivants.
**Avant `name: 'profile_form_request',`**

Remplir son propre dossier n'est pas un privilège : un invité rétrogradé en `readonly`

doit pouvoir se déclarer, c'est même le seul geste qui puisse l'en faire sortir.
**Avant `export function isAnsweredWithoutModel(input: DeterministicReplyInput): boolean {`**

Ce message sera-t-il traité SANS aucun appel de modèle ?

DÉRIVÉ de la table, donc structurellement incapable de diverger des court-circuits — ce
qui était toute la fragilité de la version précédente, maintenue à la main.

Ce que ce prédicat NE dit PAS : que le message sera effectivement traité. Il peut encore
être écarté plus loin (fil non engagé, doublon, auteur inconnu). Il dit seulement qu'il ne
coûtera pas un token — la seule question que se pose le rationnement.

**Avant `export function findStaticReply(input: DeterministicReplyInput): DeterministicReply | undefined `**

Le premier court-circuit à réponse FIGÉE qui s'applique, s'il y en a un.

Les entrées agissantes (`reply: null`) sont ignorées ici : elles précèdent ou suivent dans
la table, mais toutes les entrées figées lui sont antérieures, donc les balayer d'abord
donne exactement l'ordre d'évaluation d'origine.

**Avant `export function replyFor(entry: DeterministicReply, input: DeterministicReplyInput): string | nu`**

Le texte réellement posté pour ce court-circuit.

Déterministe : la graine est l'horodatage du message, donc la même personne voit des
formulations différentes d'un message à l'autre, et un message rejoué donne exactement la
même réponse. Voir `shared/reply-variants.ts` pour le pourquoi complet — en résumé : un
test ne peut pas verrouiller une réponse aléatoire, et un diagnostic ne peut pas la rejouer.

**Avant `export function findActingReply(input: DeterministicReplyInput): DeterministicReply | undefined `**

Le premier court-circuit AGISSANT qui s'applique, s'il y en a un.

Pendant du `findStaticReply` ci-dessus : c'est ce qui permet au handler de ne plus
ré-évaluer les prédicats qu'il vient de faire évaluer par la table.

## `features/notification/domain/services/email-attachment-policy.ts`

**Avant `export const MAX_EMAIL_ATTACHMENTS_BYTES = 5 * 1024 * 1024;`**

Borne de taille des pièces jointes email, commune à TOUS les fournisseurs.

Elle vit dans le domaine et non dans un adaptateur : SMTP et Brevo doivent
refuser exactement les mêmes envois, sinon un basculement de fournisseur
changerait silencieusement ce que le produit accepte de livrer.

── Pourquoi 5 Mio ─────────────────────────────────────────────────────────
1. L'envoi SMTP est une connexion TCP tenue depuis une fonction serverless,
   avec des timeouts à 10 s (`SMTP_TIMEOUT_MS`). Passé quelques mébioctets, le
   socket expire au milieu du transfert : l'appelant récolte un `ETIMEDOUT`
   opaque après 10 s d'attente, au lieu d'un refus immédiat et explicite.
2. Le corps MIME est encodé en base64 (et le corps JSON de Brevo aussi) :
   +33 % sur le fil, et le tout est tenu en mémoire dans la fonction. 5 Mio de
   binaire, c'est déjà ~6,7 Mio transférés et un pic mémoire de l'ordre de
   12 Mio une fois l'original et son encodage coexistants.
3. Gmail refuse au-delà de 25 Mio : on reste très en deçà, la borne n'est donc
   jamais la contrainte la plus stricte côté destinataire.
4. Les documents réellement produits ici (guide d'intégration en PDF ou DOCX)
   pèsent quelques dizaines de kilo-octets — deux ordres de grandeur sous la
   borne. Un dépassement signale un contenu non borné en amont, c'est-à-dire un
   bug, pas un document légitime : échouer bruyamment est le bon comportement.

La borne porte sur le TOTAL et non sur chaque pièce : c'est le volume transféré
qui fait expirer le socket, pas le nombre de fichiers.

**Avant `export function assertEmailAttachmentsFit(attachments: readonly EmailAttachment[]): void {`**

Lève AVANT toute E/S si le total dépasse la borne.

Volontairement une exception et non un booléen : un refus silencieux
reproduirait le piège déjà documenté du projet (`emailSent: false` retourné
avec `status: 'success'`), où un envoi jamais parti passait pour un succès.
Le message nomme le total, la borne et les fichiers, faute de quoi le
diagnostic repart de zéro à chaque occurrence.

## `features/notification/domain/services/email-body.ts`

**Avant `export interface EmailBody {`**

LE CORPS D'UN EMAIL — un contrat qui était IMPLICITE, et que trois appelants sur quatre
violaient sans qu'aucun type ne bouge.

LE DÉFAUT
`EmailProvider.sendEmail(to, subject, body: string)` ne disait pas ce qu'était `body`.
Les deux adaptateurs le placent pourtant dans un slot HTML — `html:` chez SMTP
(`smtp.adapter.ts`), `htmlContent:` chez Brevo. Le corps est donc INTERPRÉTÉ.

Relevé le 2026-08-20, sur les quatre appelants :

  welcome-email.ts        HTML délibéré, valeurs échappées par `esc()`      ✅ correct
  interview-email.ts      texte brut                                        ❌ interprété
  send-notification.ts    texte brut ÉCRIT PAR LE MODÈLE, 5 000 car.        ❌ interprété
  generate-document.ts    texte brut, titre interpolé                       ❌ interprété

Le troisième est le grave : `body` est de la prose libre du modèle, atteignable depuis
un message Slack arbitraire. Un `<a href="https://…">Réinitialise ton mot de passe</a>`
partait en lien cliquable, DEPUIS L'ADRESSE DE L'ENTREPRISE, vers un salarié. Le produit
fabriquait lui-même le hameçonnage qu'il est censé ne pas rendre possible.

POURQUOI UN TYPE, ET NON UN ÉCHAPPEMENT DANS L'ADAPTATEUR
Échapper systématiquement dans l'adaptateur aurait cassé `welcome-email.ts`, qui produit
du vrai HTML : le premier message que l'entreprise envoie à un arrivant aurait affiché
`<p>` littéralement. Et n'échapper que dans `send-notification` aurait laissé les deux
autres appelants ouverts — c'est-à-dire réparé UNE occurrence d'une classe de défaut, ce
que ce dépôt refuse de faire depuis qu'il a mesuré trois fois le contraire.

Le type force chaque appelant à DÉCLARER ce qu'il produit. Un futur appelant qui
passerait une chaîne nue ne compilera pas : la règle n'est plus une consigne qu'on peut
oublier de lire, elle est vérifiée à la compilation. C'est la doctrine du dépôt —
une consigne est PROBABLE, le code est GARANTI.

⚠️ Ce module ne remplace PAS l'assainissement du contenu, et l'un ne couvre pas l'autre :
échapper `<script>` ne retire pas `https://evil.tld`, et retirer le lien n'empêche pas la
balise d'être interprétée. Voir `sanitizeNotificationBody` dans `shared/security/agent-output.ts`.

 Corps d'email, dans les deux formes que tout client attend.
**Avant `readonly html: string;`**

 Ce qui part en `html:` / `htmlContent:`. Toujours du HTML valide.

**Avant `readonly text: string;`**

Repli texte brut. Certains clients refusent un message uniquement HTML, et sa présence
améliore le score anti-spam. Il était jusqu'ici DÉRIVÉ du HTML par retrait de balises,
ce qui mutilait tout corps de texte brut contenant `<…>` — second symptôme du même
contrat implicite.

**Avant `function escapeHtml(raw: string): string {`**

Échappement HTML minimal mais complet pour du contenu de TEXTE (jamais d'attribut).

Les cinq caractères sont traités, `&` en PREMIER — l'inverse ré-échapperait les
esperluettes que les remplacements suivants viennent d'introduire, et `&lt;` deviendrait
`&amp;lt;`, visible tel quel par le destinataire.

**Avant `function stripTags(html: string): string {`**

Retire le balisage pour produire le repli texte.

`[^>]+` ne peut pas reculer devant `>`, qu'il exclut de sa classe : le coût reste
linéaire sur une entrée non bornée. Même exigence que le reste du dépôt en matière de
ReDoS — voir `llm-guardrail-redos.test.ts`.

**Avant `export function htmlEmailBody(html: string): EmailBody {`**

Un corps rédigé DÉLIBÉRÉMENT en HTML par un gabarit du serveur.

⚠️ N'échappe rien, par conception. Le seul appelant légitime est un gabarit qui échappe
lui-même ses valeurs interpolées (`welcome-email.ts` le fait avec `esc()`). Ne jamais
l'employer sur une valeur venue du modèle, d'un utilisateur ou de l'annuaire : ce serait
rouvrir exactement le défaut que ce module ferme, et sans laisser de trace.

**Avant `export function textEmailBody(plain: string): EmailBody {`**

Un corps de TEXTE BRUT. C'est le cas par défaut, et celui de toute prose écrite par un
modèle.

Les sauts de ligne deviennent des `<br />` : sans cela un message rédigé en paragraphes
arrive en un seul bloc. Le défaut est cosmétique, mais il touchait CHAQUE notification et
il vient du même contrat implicite — le texte était livré à un moteur de rendu HTML, qui
ne connaît pas le retour à la ligne.

## `features/notification/domain/services/rate-limit-policy.ts`

**Avant `export interface RateLimitRule {`**

LIMITATION DE DÉBIT (P3) — partie PURE : règles, clés de fenêtre, décision.

Constat qui a motivé ce fichier : `grep -rni "ratelimit|throttle|bucket"` sur `src/` ne
renvoyait rien hors commentaires. N'importe quel membre du workspace pouvait donc, à coût
nul pour lui, épuiser en quelques minutes un budget quotidien de ≈ 19 messages partagé par
toute l'organisation — et, accessoirement, pousser le compte Gmail expéditeur vers sa limite
de 500 envois/jour, dont la sanction est la suspension du compte.

CE QU'ON PROTÈGE EXACTEMENT, ET POURQUOI ÇA CHANGE LA FORME DU CORRECTIF
La contrainte qui casse la production n'est PAS le seau Groq par minute (12 000 tokens) mais
le quota JOURNALIER : `TPD: Limit 100000, Used 98207` relevé dans les en-têtes de l'incident
du 2026-08-11, soit ≈ 19 messages par jour à 5 168 tokens l'un. Une limitation qui ne
raisonnerait qu'à la minute laisserait passer 5 × 1 440 = 7 200 messages par jour : elle
protégerait le seau et laisserait brûler le budget. D'où DEUX règles, et non une.

Le plafond journalier est PAR PERSONNE, pas par workspace. Un plafond global calé sur 19
éteindrait le bot pour tout le monde dès qu'une seule personne l'atteindrait — en pratique,
la première à travailler ce matin-là. Par personne, il borne le dégât qu'un acteur unique
(hostile, ou simplement pris dans une boucle) peut infliger aux autres, et laisse le
fournisseur arbitrer le total. C'est ce que `QUOTA_FAILURE` sait déjà annoncer honnêtement.

FENÊTRE FIXE, ET POURQUOI CE N'EST PAS UN PIS-ALLER
La clé porte le numéro de fenêtre (`floor(now / windowMs)`), ce qui rend l'incrément
ATOMIQUE en un seul aller-retour : `INSERT … ON CONFLICT DO UPDATE SET count = count + 1
RETURNING count`. Une fenêtre glissante imposerait de LIRE puis d'ÉCRIRE — donc de rouvrir
entre les deux la fenêtre de concurrence que le store partagé existe précisément pour
fermer, sur un chemin (l'ACK Slack) qui n'a que 3 secondes.

Contrepartie assumée : à cheval sur une frontière de fenêtre, on tolère jusqu'à 2× la
limite. Sur un contrôle dont l'objet est d'empêcher l'épuisement d'un budget, un facteur 2
transitoire est sans conséquence ; une course entre deux instances, elle, en aurait une.

**Avant `readonly name: string;`**

 Entre dans la clé : deux règles ne partagent jamais un compteur.

**Avant `readonly limit: number;`**

 Nombre d'événements TOLÉRÉS dans la fenêtre. Le refus commence à `limit + 1`.

**Avant `readonly rationsModelBudget?: boolean;`**

Cette règle existe-t-elle pour RATIONNER LE BUDGET DU MODÈLE, ou pour contrer un abus ?

La distinction n'est pas cosmétique : elle décide qui la règle doit épargner. Un message
auquel le bot répond SANS appeler de modèle (salutation, emoji seul, message trop long,
détresse, pièce jointe) ne consomme pas un token — le rationner ne protège donc rien, et
coûte une réponse à quelqu'un.

⚠️ Le cas qui a rendu cette distinction nécessaire, observé en production le 2026-08-13 :
une personne ayant déjà atteint ses 12 messages du jour écrit « bonjour » et reçoit
« J'ai atteint mon quota de messages pour aujourd'hui ». Pour un mot qui ne coûte rien.
Et la même chose serait arrivée à « je ne vais pas bien » — soit exactement le message
que `distress.ts` existe pour ne jamais laisser sans réponse.

Absent ⇒ `false` : une règle qui ne se déclare pas est une règle anti-abus, donc elle
s'applique toujours. C'est le défaut sûr.

**Avant `export const BURST_RULE: RateLimitRule = {`**

Rafale : borne le débit instantané d'une personne.

5 messages/minute est le chiffre de `COMPETENCES_ET_ANALYSE.md` P3. Il est très au-dessus de
l'usage humain observé (la campagne du 2026-08-11 n'a jamais dépassé 2 messages/minute) et
très en dessous de ce qu'un script atteint sans effort : c'est exactement ce qu'on attend
d'un seuil dont les faux positifs coûteraient la confiance de l'utilisatrice qui teste.

**Avant `export const DAILY_RULE: RateLimitRule = {`**

Budget journalier par personne.

12 < 19 (le plafond réel du fournisseur) : une seule personne ne peut donc pas, à elle
seule, consommer la journée entière de l'organisation. Le test verrouille cette inégalité —
c'est elle qui porte le sens, pas le chiffre.

**Avant `rationsModelBudget: true,`**

Sa raison d'être est écrite juste au-dessus : elle borne une part du plafond du

FOURNISSEUR. Elle n'a donc rien à dire d'un message auquel on répond sans modèle.
**Avant `export const WORKSPACE_SUBJECT = 'workspace';`**

Sujet du compteur d'ÉQUIPE. Une seule clé pour tout le monde — c'est la portée qui manquait.

**Avant `export const WORKSPACE_TOKEN_RULE: RateLimitRule = {`**

BUDGET DE TOKENS DE L'ÉQUIPE — la seule règle qui mesure ce qui casse réellement.

Pourquoi les deux règles ci-dessus ne suffisaient pas

Elles comptent des MESSAGES ; la ressource se consomme en TOKENS. Deux conséquences, et
chacune suffirait :

 1. **L'unité est fausse.** Le raisonnement qui justifie `DAILY_RULE.limit = 12`
    (« 12 < 19, donc une personne ne peut pas consommer la journée entière ») suppose un
    coût moyen de 5 168 tokens par message. La production l'a démenti d'un facteur 2,6 : un
    « Bonjour » a coûté **13 376 tokens** en 5 étapes — 13 % du budget quotidien, pour UNE
    unité de compteur. À ce tarif, 8 messages épuisent la journée sans jamais approcher le
    plafond de 12.
 2. **La portée est fausse.** 6 personnes × 12 = **72 messages/jour possibles pour un budget
    de ≈ 19**. Il suffit de DEUX personnes en usage normal — sans script, sans malveillance —
    pour dépasser le budget du fournisseur. Or c'est exactement la panne survenue le
    2026-08-11 (`TPD: Limit 100000, Used 98207`), et rien ne la mesurait : le plafond par
    personne ne protège que du cas dégénéré à un seul acteur.

⚠️ Le comptage est POST-HOC, et ça ne peut pas être autrement

Le coût d'un appel n'est connu qu'APRÈS lui (`usage.inputTokens`). Le message qui fait
franchir le seuil passe donc toujours, et le dépassement est constaté au message suivant.
C'est assumé : on borne une DÉRIVE, on ne prétend pas à l'exactitude comptable. Toute
estimation faite AVANT l'appel serait pire que ce décalage — le coût dominant vient de
l'historique, des schémas d'outils et du nombre d'étapes, pas de la taille du message
entrant.

`rationsModelBudget: true` est **obligatoire ici**. Sans lui, une salutation ou une
détresse se heurteraient au budget d'équipe épuisé : ce serait la reproduction exacte du
défaut corrigé le 2026-08-13, transposée de l'individu au collectif.

**Avant `limit: 90_000,`**

90 % du TPD réel (100 000). La marge absorbe l'overshoot ×2 documenté sur les fenêtres

fixes et laisse de quoi terminer un run engagé — un plafond calé au ras couperait le

service à l'instant précis où quelqu'un attend encore sa réponse.
**Avant `const EXPIRY_MARGIN_MS = 5 * MINUTE_MS;`**

Marge de purge : une ligne survit à sa fenêtre.

Purger à l'instant exact de la fin ferait disparaître un compteur encore décisif pour une
instance dont l'horloge est en léger retard — et l'effacer, c'est offrir une fenêtre neuve.

**Avant `export function windowBounds(rule: RateLimitRule, now: Date): WindowBounds {`**

 Borne la fenêtre fixe contenant `now`.

**Avant `export function buildCounterKey(rule: RateLimitRule, subjectId: string, now: Date): string {`**

Clé du compteur : `<règle>:<longueur du sujet>:<sujet>:<numéro de fenêtre>`.

La longueur préfixée n'est pas une coquetterie. Un identifiant Slack ne contient pas de
`:`, mais cette clé accepte aussi des sujets composés (canal, workspace), et une
concaténation nue rend `a:b` et `a` indiscernables une fois le reste accolé — deux personnes
partageraient alors un quota, ou l'une s'en offrirait un second. Préfixer par la longueur
rend l'encodage injectif sans avoir à interdire un caractère.

**Avant `readonly shouldNotify: boolean;`**

`true` UNIQUEMENT au premier refus de la fenêtre.

Un refus muet reproduirait le défaut le plus coûteux de ce dépôt (`emailSent: false` sous
`status: 'success'`) : la personne conclurait à une panne et réessaierait, aggravant
exactement ce qu'on limite. Mais prévenir à CHAQUE refus ferait de la limitation un
amplificateur — un message Slack émis par message rejeté. D'où : une fois, puis silence.

**Avant `export function evaluateCount(rule: RateLimitRule, count: number): RateLimitEvaluation {`**

Décide à partir du compte APRÈS incrément.

Un compte non exploitable (0, `NaN` — compteur illisible, store dégradé) vaut autorisation :
ce n'est pas un dépassement CONSTATÉ, et refuser sans preuve positive couperait le service
sur une panne de la table. Même arbitrage que la déduplication partagée, qui accepte
l'événement quand son store est indisponible.

**Avant `export function readRuleLimit(raw: string | undefined, fallback: number): number {`**

Lit une limite depuis l'environnement, en refusant les valeurs qui éteindraient le bot.

`0` et les négatifs retombent sur le défaut : une faute de frappe dans une variable Vercel
ne doit pas pouvoir couper 100 % du trafic en silence — c'est la classe de panne que
`checkTeamId` documente déjà comme la raison de son propre fail-open.

## `features/notification/infrastructure/handlers/slack-events.handler.ts`

**Avant `import {`**

Extraits le 2026-08-17 vers `infrastructure/ui/welcome-blocks.ts` — voir son en-tête.

Réexportés en fin de fichier : d'autres modules et des tests les importent depuis ici.
**Avant `export interface SlackMessageEvent {`**

Handler des événements Slack (Events API).

Le découpage est volontaire :
 - `accept()` tourne AVANT l'ACK HTTP (< 3 s imposées par Slack) : filtrage de type, garde
   anti-boucle bon marché et déduplication. Il est ASYNCHRONE depuis le 2026-08-11 — la
   prise de clé fait un aller-retour vers la base partagée. C'est le prix à payer : un
   rejeu Slack routé vers une AUTRE instance ne peut être écarté que là, et seulement
   avant tout traitement.
 - `handleEvent()` est ASYNCHRONE et lancé en tâche de fond APRÈS l'ACK : il résout
   le `bot_user_id`, appelle l'agent LLM (2 à 17 s d'après TEST_REPORT.md) puis poste
   la réponse dans Slack.

Événement porteur de texte : `message` et `app_mention`.

`type` reste un `string` ouvert : le fil Slack est du JSON non fiable, et une
union fermée affirmerait une garantie qu'on n'a pas. Le filtrage réel est
fait par `SUPPORTED_EVENT_TYPES`, à l'exécution.
**Avant `export interface SlackTeamJoinUser {`**

 Profil porté par le payload `team_join`. Tous les champs sont optionnels.

**Avant `export interface SlackTeamJoinEvent {`**

Arrivée d'une personne dans le workspace.

Contrairement à un message, `user` est un OBJET complet, et l'événement ne
porte ni `channel`, ni `ts`, ni `text` — d'où l'union ci-dessous plutôt qu'une
interface unique où `user` serait `string | objet`.

**Avant `export function isTeamJoinEvent(event: SlackEvent): event is SlackTeamJoinEvent {`**

Prédicat de restriction. Une comparaison `event.type === 'team_join'` ne
suffit pas à restreindre l'union : le membre « message » déclare `type` en
`string` ouvert, donc il resterait dans la branche vraie.

**Avant `export type SlackIgnoreReason =`**

Motifs de rejet. Chacun est journalisé tel quel par la route
(`slack-events.route.ts`) : ne jamais recycler un motif existant pour un
nouveau cas, le log de production mentirait.

**Avant `| 'stale_event'`**

Événement trop VIEUX pour qu'on y réponde encore — voir `isStale`. Motif DISTINCT de
`duplicate` : un doublon a déjà reçu sa réponse, un événement périmé n'en a jamais eu.
Les confondre dans les logs rendrait la panne du 22:34 (une réponse tombée 1 h 40 trop
tard) indiscernable d'une déduplication qui fonctionne.

**Avant `| 'rate_limited';`**

Quota de messages dépassé pour cette personne. Motif DISTINCT de `duplicate` : les deux
écartent un événement, mais l'un dit « on l'a déjà traité » et l'autre « on refuse de le
traiter ». Les confondre rendrait le journal de production inexploitable au moment précis
où l'on cherche pourquoi quelqu'un n'a pas eu de réponse.

**Avant `retryNum?: string | null;`**

 En-tête `X-Slack-Retry-Num` (présent uniquement sur les renvois Slack).

**Avant `slackClient?: WebClient;`**

 Injection d'un WebClient (tests unitaires).

**Avant `chatProvider?: Pick<SlackAdapter, 'sendBlocks'>;`**

Émetteur des messages à blocs (DM de bienvenue).

Injecté par options plutôt que repris de `src/mastra/index.ts` : ce module
importe déjà la route qui construit ce handler, donc la dépendance inverse
créerait un cycle d'import — panne d'initialisation classique en ESM bundlé.

**Avant `workspaceProvider?: Pick<SlackWorkspaceProvider, 'findUserById'>;`**

 Annuaire Slack, pour le repli quand `team_join` ne porte pas l'email.

**Avant `dedupMax?: number;`**

 Taille max du cache de déduplication.

**Avant `dedupTtlMs?: number;`**

 TTL du cache de déduplication, en ms.

**Avant `inFlightGraceMs?: number;`**

Durée au-delà de laquelle une entrée `in-flight` est considérée abandonnée
(fonction serverless gelée / tuée) et l'événement redevient rejouable.

**Avant `conversationRepository?: ConversationRepository | null;`**

Mémoire conversationnelle. Injectée pour les tests (doublure in-memory) ; en
production le dépôt Drizzle est construit paresseusement, au premier message.

`null` DÉSACTIVE explicitement la mémoire — utile pour isoler un test du reste
du comportement sans avoir à fournir une doublure.

**Avant `pinnedFactRepository?: PinnedFactRepository | null;`**

Mémoire LONGUE — les faits explicitement épinglés (« souviens-toi que… »).

Séparée de `conversationRepository` parce que leurs durées de vie sont opposées : l'une
expire en 60 minutes, l'autre ne meurt que sur demande. `null` la DÉSACTIVE.

**Avant `interviewRepository?: OnboardingInterviewRepository | null;`**

Dépôt de l'entretien post-profil — OPTIONNEL, et sans repli paresseux.

⚠️ Pas de repli paresseux vers Drizzle ici — contrairement à `pinnedFactRepo`, qui en a
un — et c'est délibéré. Un repli ferait que TOUT handler construit sans cette dépendance
toucherait la base depuis les tests unitaires : c'est exactement le piège qui a rendu onze
tests d'`accept()` `rate_limited` le jour où `rate_limit_counters` a existé, et
`CLAUDE.md` recense déjà QUATRE dépendances à neutraliser pour cette raison. On n'en
ajoute pas une cinquième.

Absent, l'entretien COLLECTE et répond correctement sans persister : la conversation reste
juste, seule la trace manque. C'est la bonne dégradation — l'inverse (échouer faute de
dépôt) casserait un accueil pour un défaut de câblage.

**Avant `profileRepository?: { findByEmail(email: string): Promise<ProfileSnapshot | null> } | null;`**

Dépôt employé pour la VÉRIFICATION de « j'ai fini » — optionnel, sans repli paresseux,
même contrat que `interviewRepository` ci-dessus et pour la même raison : un repli ferait
qu'un handler construit en test toucherait la base.

Absent, la phrase écrite n'est pas reconnue et le message part chez l'agent — dégradé,
jamais faux. Le bouton « C'est fait », lui, reste servi par la route, qui a son propre
dépôt : les deux chemins ne tombent donc jamais ensemble.

**Avant `dedupRepository?: SlackEventDedupRepository | null;`**

Déduplication PARTAGÉE entre instances. Injectée pour les tests (une seule doublure
partagée par deux handlers simule deux instances serverless devant le même store) ;
en production le dépôt Drizzle est construit paresseusement.

`null` la DÉSACTIVE et ramène au seul cache local — l'ancien comportement, celui qui
laissait passer les doubles réponses.

**Avant `conversationTokenBudget?: number;`**

 Budget de contexte alloué à l'historique, en tokens.

**Avant `conversationTtlMs?: number;`**

 Durée d'inactivité au-delà de laquelle le fil est clos (mémoire ET collance).

**Avant `directoryRepository?: DirectoryRepository | null;`**

Annuaire du workspace — support de la frontière d'autorisation.

`null` la DÉSACTIVE (aucun fait connu sur personne, donc aucune restriction) ; c'est
l'ancien comportement, celui où tout invité mono-canal déclenchait `sendNotification`.

**Avant `welcomeChannels?: WelcomeChannelsService | null;`**

Invitation de l'arrivant aux canaux publics d'accueil, au `team_join`.

`null` ou absent la DÉSACTIVE — c'est le comportement d'avant le 2026-08-13, et celui de
tout test qui ne s'intéresse pas aux canaux. Contrairement à l'annuaire et à la
déduplication, il n'y a PAS de construction paresseuse par défaut : ce service a besoin de
la configuration `ONBOARDING_WELCOME_CHANNELS`, qui vit dans le câblage.

**Avant `accessGuard?: SlackAccessGuard | null;`**

 Politique d'accès. Injectée pour les tests ; en production construite paresseusement.

**Avant `rateLimiter?: SlackRateLimiter | null;`**

Limitation de débit. `null` la DÉSACTIVE.

⚠️ Sans elle, une seule rafale consomme les ≈19 messages/jour du workspace entier : le
budget Groq se mesure à la JOURNÉE (`TPD: Limit 100000`), pas à la minute.

**Avant `pruneProbability?: number;`**

Probabilité qu'un message déclenche une purge de rétention. Voir
`DEFAULT_PRUNE_PROBABILITY` : le tirage remplace un compteur d'instance, qui ne survivait
pas au gel de la fonction serverless. Injectable pour rendre les tests déterministes.

**Avant `auditSink?: (entry: Parameters<typeof writeAuditLog>[0]) => Promise<unknown>;`**

Où part le journal d'AUDIT.

⚠️ Injectable depuis le 2026-08-19, et pour une raison de TEST, pas de production :
`writeAuditLog` ouvre `data/kisso.db` par défaut. C'était la DERNIÈRE dépendance non
neutralisable des tests de handler — ≈ 250 ms par message, et sous contention (plusieurs
fichiers en parallèle sur le même fichier SQLite) des pointes qui franchissent le délai
de 5 s de Vitest. Des faux rouges qui ne désignent jamais leur cause.

En production, le défaut reste `writeAuditLog` : rien ne change.

**Avant `pendingEmailRepository?: PendingInterviewEmailRepository | null;`**

L'email d'entretien PRÉPARÉ et en attente d'un « oui ».

⚠️ Optionnel et SANS repli paresseux — même contrat que `interviewRepository`, et pour la
même raison recensée dans `CLAUDE.md` : un repli ferait qu'un handler construit en test
ouvrirait `data/kisso.db` sur le chemin nominal.

Absent, la confirmation conversationnelle n'existe simplement pas : « oui » repart chez
l'agent. C'est la bonne dégradation — l'inverse ferait dépendre d'un câblage la CAPACITÉ
à ne pas envoyer un email.

**Avant `sendEmail?: (to: string, subject: string, body: EmailBody) => Promise<unknown>;`**

L'envoi réel, injecté plutôt qu'importé.

⚠️ C'est le SEUL acte irréversible que ce handler puisse déclencher, et le seul qui sorte
du workspace. Le laisser construire son propre fournisseur ferait partir un vrai email
depuis un test unitaire — la faute que `smoke:email` documente déjà en toutes lettres.

**Avant `now?: () => Date;`**

L'horloge, injectable.

⚠️ Elle n'a qu'un seul consommateur — la ligne « Nous sommes le … » du préambule — et elle
existe pour la même raison que partout ailleurs dans ce dépôt : une valeur qui change à
chaque exécution ne se verrouille pas par un test. Sans elle, les tests qui comparent le
préambule construit à `buildContextPreamble({...})` ne pourraient plus qu'asserter des
fragments, c'est-à-dire vérifier moins.

Aucune E/S : ce n'est pas une neuvième dépendance à neutraliser.

**Avant `type DedupStatus = 'in-flight' | 'done';`**

État d'un événement dans le cache de déduplication.
 - `in-flight` : `accept()` l'a laissé passer, `handleEvent()` n'a pas encore rendu la main.
 - `done`      : `handleEvent()` est allé au bout — le rejeu doit être ignoré définitivement.

**Avant `startedAt: number;`**

 `Date.now()` au moment où le statut courant a été posé.

**Avant `const DEFAULT_IN_FLIGHT_GRACE_MS = 60_000;`**

Une invocation ne peut pas dépasser le `maxDuration` de la fonction Vercel
(60 s, cf. `scripts/fix-vercel-output.js`). Passé ce délai, une entrée encore
`in-flight` ne peut plus correspondre à un traitement vivant.

**Avant `const DIRECTORY_STALE_AFTER_MS = 24 * 60 * 60 * 1000;`**

Au-delà de cette ancienneté, les faits d'annuaire d'une personne sont rafraîchis depuis Slack
— en tâche de fond, jamais sur le chemin de l'ACK.

24 h parce que ce que porte cette ligne ne change qu'à des gestes rares et humains : une
désactivation de compte, un passage en invité, un changement d'adresse. Plus court ferait
payer un `users.info` par personne et par jour sans rien apprendre ; beaucoup plus long
laisserait un ex-salarié conserver son niveau d'accès pendant des semaines.

**Avant `const SUPPORTED_EVENT_TYPES = new Set(['app_mention', 'message', 'team_join']);`**

 Types d'événements Slack que le bot traite. Tout le reste est ignoré.

**Avant `export const SLACKBOT_USER_ID = 'USLACKBOT';`**

Identifiant fixe de Slackbot : il « rejoint » techniquement chaque workspace.

EXPORTÉ depuis le 2026-08-14 : `scripts/invite-profile-completion.mts` doit l'écarter lui
aussi. Slack ne le déclare NI `is_bot` NI `deleted` dans `users.list` — vérifié sur la
production, la ligne porte `is_bot=0, is_deleted=0` — donc les deux filtres évidents le
laissent passer. Le dupliquer en littéral dans le script ferait qu'un seul des deux
appelants serait corrigé le jour où il faudrait le changer.

**Avant `const CONVERSATION_QUERY_LIMIT = 40;`**

Garde-fou de REQUÊTE : nombre de tours chargés avant fenêtrage. Ce n'est pas le plafond
de contexte — celui-là se compte en tokens (`selectWindow`). Il évite seulement de tirer
un fil de mille messages en mémoire pour n'en garder que six.

**Avant `const DEFAULT_PRUNE_PROBABILITY = 0.2;`**

Probabilité qu'un message déclenche une purge, en tâche de fond.

Pourquoi une PROBABILITÉ et non plus un compteur — le TTL ne s'appliquait qu'en LECTURE

La forme précédente était « un message sur cent », sur un compteur d'instance
(`this.processedMessages`, en mémoire). Ce compteur ne peut pas fonctionner ici, et c'est
structurel :

 - il **repart à zéro à chaque démarrage à froid**, or Vercel en provoque un en
   permanence — une instance gelée est remplacée, pas reprise ;
 - le budget Groq borne le trafic à **≈ 19 messages par jour, tous canaux confondus**.

Le seuil de 100 n'était donc **jamais atteint en production**. Conséquence : `prune` ne
tournait pour ainsi dire pas, et le TTL de 60 minutes n'était appliqué qu'EN LECTURE, par
`recentTurns`. Les lignes, elles, restaient sur la Turso **sans borne de rétention réelle**
— y compris celles d'un DM où quelqu'un parle de son salaire, d'un arrêt maladie ou d'un
litige, ce que le handler documente lui-même comme l'usage normal de ce canal. Le dépôt
annonçait une rétention d'une heure et en pratiquait une illimitée.

Une probabilité n'a pas d'état, donc elle survit au gel de la fonction. À 0,2 et
≈ 19 messages/jour, la purge tourne ~4 fois par jour : les tours expirés vivent quelques
heures de plus que le TTL au lieu de vivre indéfiniment. C'est un DELETE indexé, hors du
chemin de réponse (`void`), et le plus souvent sans effet.

⚠️ Ce n'est toujours pas une garantie de rétention — seul un cron en serait une, et ce
projet n'en a aucun. C'est la borne la plus honnête qu'on puisse poser sans en introduire.

**Avant `const MAX_EVENT_AGE_MS = 10 * 60 * 1000;`**

Âge au-delà duquel un message n'est plus traité. Voir `isStale` pour le relevé de
production qui a motivé cette borne — une réponse arrivée 1 h 40 après la question.

10 minutes : deux ordres de grandeur au-dessus d'un run (2 à 21 s, `maxDuration` 60 s) et
des rejeux Slack (la minute). Assez haut pour ne jamais écarter un traitement légitimement
lent, assez bas pour qu'aucune réponse ne tombe dans une conversation qui a tourné.

**Avant `export function unwrapSanitizedInput(wrapped: string, fallback: string): string {`**

Extrait le contenu ASSAINI d'une entrée encadrée par `wrapAgentInput`.

Format produit par le garde-fou :
  `<PREFIX_user_input>\n{assaini}\n</PREFIX_user_input>`

On ne réimplémente surtout pas l'assainissement : on récupère le résultat de celui que le
garde-fou vient d'appliquer. C'est ce texte-là, et lui seul, qui a le droit d'entrer en
mémoire — le texte brut y ferait persister un faux délimiteur, rejoué ensuite à chaque tour.

Le repli sur `fallback` ne sert qu'au cas où le format changerait ; il est signalé par
l'appelant, jamais silencieux.

**Avant `const RATE_LIMIT_REPLIES: Readonly<Record<string, string>> = {`**

Les trois refus de rationnement, un par règle.

Une table plutôt que trois ternaires imbriqués : le lecteur vient ici pour savoir ce que le
bot DIT, et une cascade de conditions rend justement cela illisible. Une règle ajoutée
demain sans son texte retombe sur `burst`, le moins engageant des trois.

**Avant `interface MessageContext {`**

Ce qu'un message porte, une fois ses gardes franchies.

⚠️ Construit UNE FOIS par `buildMessageContext` et passé tel quel. Avant le 2026-08-18,
`channel`, `threadTs`, `user` et `text` étaient retransmis un par un dans une quinzaine de
signatures — chaque nouvelle étape en rajoutait un.

**Avant `readonly requesterIdentity: Promise<RequesterIdentity>;`**

⚠️ Volontairement NON attendue : la résolution de l'identité se recouvre avec la lecture
de la mémoire au lieu de s'y ajouter. Elle ne rejette jamais.

**Avant `function cancellationReply(cleared: number): string {`**

Les trois issues d'une annulation, jamais confondues : effacé (> 0), déjà tranché (0),
échec du dépôt (< 0). Dire « c'est annulé » sur un échec rejouerait exactement la famille
`emailSent: false` sous `status: 'success'`.

**Avant `function buildRecipientNotice(requestContext: unknown, answer: string): string {`**

La note « produit pour X », ou rien du tout.

Extraite de `runAgentPipeline` : deux conditions de plus y portaient la complexité cognitive
au-dessus du seuil, et ce dépôt est à zéro warning depuis le 2026-08-18.

**Avant `private readonly seenEvents: LRUCache<string, DedupEntry>;`**

Déduplication des renvois Slack (timeout / 5xx → Slack rejoue l'événement).

Le cache mémorise un STATUT, pas un simple booléen : marquer l'événement « vu » dès
`accept()` suffisait à bloquer tous les rejeux, y compris quand le traitement de fond
avait été tué en vol par le gel de la fonction serverless — l'événement était alors
perdu DÉFINITIVEMENT. On distingue donc `in-flight` (traitement en cours, un rejeu
concurrent doit bien être ignoré) de `done` (traitement terminé), et une entrée
`in-flight` périmée redevient rejouable.

ATTENTION : ce cache est EN MÉMOIRE, donc par instance. En multi-instance
(Vercel serverless, plusieurs conteneurs) deux répliques peuvent traiter le même
`event_id`. La correction durable est un store partagé (Redis / LibSQL) ou une file.

**Avant `private teamIdWarningEmitted = false;`**

 Évite d'inonder les logs : l'absence de `SLACK_TEAM_ID` est signalée une fois.

**Avant `private conversationRepo: ConversationRepository | null | undefined;`**

Mémoire conversationnelle. `undefined` signifie « pas encore construite » et
`null` « désactivée » — les deux états sont distincts, d'où l'union.

**Avant `private dedupRepo: SlackEventDedupRepository | null | undefined;`**

Déduplication partagée. `undefined` = pas encore construite, `null` = désactivée : deux
états distincts, d'où l'union.

**Avant `private directoryRepo: DirectoryRepository | null | undefined;`**

 `undefined` = pas encore construit, `null` = désactivé. Deux états distincts.

**Avant `private readonly welcomeChannels: WelcomeChannelsService | null;`**

 `null` = désactivé. Aucune construction paresseuse : voir l'option du même nom.

**Avant `private readonly pruneProbability: number;`**

Probabilité de purge par message. Injectable UNIQUEMENT pour rendre les tests
déterministes (0 = jamais, 1 = toujours) — en production c'est le défaut qui vaut.

**Avant `private readonly requesterNames = new LRUCache<string, RequesterIdentity>({`**

Cache des noms d'affichage Slack, par instance.

Un `users.info` par message coûterait un aller-retour réseau sur le chemin de fond de
CHAQUE tour, pour une donnée qui ne change qu'exceptionnellement. Une chaîne vide
mémorise un échec — et l'échec doit être mis en cache comme le succès, sinon un
workspace qui refuse l'annuaire paie l'appel indéfiniment.

**Avant `private readonly botToken: string;`**

 Conservé pour construire paresseusement la source d'annuaire (apprentissage au fil de l'eau).

**Avant `private readonly audit: (entry: Parameters<typeof writeAuditLog>[0]) => Promise<unknown>;`**

 Voir `auditSink` : injectable pour que les tests ne touchent pas `data/kisso.db`.

**Avant `private readonly pendingEmailRepo: PendingInterviewEmailRepository | null | undefined;`**

 `null`/`undefined` = pas de confirmation conversationnelle. Aucune construction paresseuse.

**Avant `private getDedupRepo(): SlackEventDedupRepository | null {`**

Dépôt de mémoire, construit paresseusement.

Volontairement PAS dans le constructeur : le handler est instancié au chargement du
module par `getSlackEventsHandler`, et ouvrir une connexion Drizzle à ce moment-là
paierait la latence de connexion sur le chemin d'ACK — celui qui a 3 secondes.

Dépôt de déduplication partagée, construit paresseusement.

Même raison que pour la mémoire : le handler est instancié au chargement du module, et
ouvrir une connexion Drizzle à ce moment-là alourdirait le démarrage à froid — or c'est
précisément ce démarrage à froid (6,1 s mesurées) qui provoque les rejeux Slack que cette
déduplication existe pour absorber.
**Avant `private getPinnedFactRepo(): PinnedFactRepository | null {`**

 Mémoire longue, construite paresseusement — même raison que les trois autres dépôts.

**Avant `routeToAgent(text: string, stickyAgentId?: string): string {`**

Délégation à `domain/services/agent-routing.ts`, extrait le 2026-08-17.

La méthode est conservée parce que les tests du handler appellent
`handler.routeToAgent(...)` depuis l'origine — et parce que c'est bien le handler qui
décide de router. Le CALCUL, lui, n'a jamais lu `this` : c'était une fonction pure
enfermée dans une classe.

**Avant `private getDirectoryRepo(): DirectoryRepository | null {`**

Résout (et met en cache) l'identifiant utilisateur du bot via `auth.test()`.
Attendu sur le workspace Kisso Ind. (`TMLKC4EPP`) : `U0BMBEJTBMJ`.
Jamais codé en dur : le token peut changer de bot.

Annuaire, politique d'accès et compteur de débit — tous construits PARESSEUSEMENT, pour la
même raison que la mémoire et la déduplication : le handler est instancié au chargement du
module, et y ouvrir une connexion Drizzle paierait la latence sur le démarrage à froid,
c'est-à-dire précisément là où les 3 secondes d'ACK de Slack sont déjà les plus serrées.
**Avant `resolveSubject: async (slackUserId) => {`**

APPRENTISSAGE AU FIL DE L'EAU — c'est ce qui rend la frontière opérante SANS
aucune synchronisation préalable.

Annuaire d'abord (une lecture sur la PRIMARY KEY, gratuite). Personne inconnue :
UN `users.info`, une seule fois dans la vie de cette personne, puis la ligne est
écrite. Sans ce repli, la politique dirait `unknown_actor` pour tout le monde
jusqu'à ce qu'un humain pense à lancer la synchronisation — c'est-à-dire une
frontière présente dans le code et inopérante en production, exactement ce
qu'était le correctif de la double réponse tant que `slack_event_dedup` manquait.

Le résolveur PROJETTE vers `AccessSubject` plutôt que de passer l'annuaire tel
quel : ce type est volontairement réduit aux champs qui portent une conséquence
d'autorisation (`isAdmin` en est absent). Un champ présent dans une signature de
sécurité finit toujours par être lu comme s'il faisait quelque chose.

**Avant `if (Date.now() - known.syncedAt.getTime() > DIRECTORY_STALE_AFTER_MS) {`**

⚠️ PÉREMPTION — sans elle, l'annuaire est un cache ÉCRIT UNE FOIS et jamais

relu : une personne dont le compte Slack est désactivé garderait son niveau

d'accès indéfiniment, puisque la seule chose qui pourrait le lui retirer

(`is_deleted`) n'est jamais rafraîchie. La frontière serait alors correcte

le premier jour et fausse tous les suivants — le pire des deux mondes, parce

qu'elle continuerait de rassurer.

Le rafraîchissement est DÉTACHÉ, et c'est le point : il ne se paie pas sur le

chemin des 3 secondes d'ACK. On rend la valeur connue tout de suite, et la

ligne s'auto-répare pour le message SUIVANT. Le prix est un message servi sur

des faits de la veille ; l'alternative — attendre `users.info` avant chaque

décision — mettrait un aller-retour réseau sur le chemin le plus contraint du

système, pour une donnée qui change quelques fois par an.
**Avant `await repo.upsertFacts(facts, new Date()).catch((error) =>`**

Écriture opportuniste : l'échec ne doit pas coûter la décision, qui est déjà

calculable à partir des faits qu'on vient de lire.
**Avant `return { ...facts, employeeId: null, isManager: false };`**

⚠️ On COMPLÈTE explicitement les deux faits d'autorisation que Slack ignore,

au lieu de rendre `facts` tel quel. La personne vient d'être apprise : elle

n'a par construction aucun dossier rattaché, donc aucun rôle. Les écrire

plutôt que de les laisser au hasard d'un élargissement de type est le point —

un `isManager` absent qui deviendrait `undefined` puis `truthy` quelque part

accorderait `full` à un inconnu, et c'est précisément le chemin qui apprend

les inconnus.
**Avant `hasManager: () =>`**

Le contrôle qui autorise l'APPLICATION — voir `access-guard.ts`. `false` en
dernier recours : une panne de lecture n'est pas une preuve d'absence, et
suspendre l'application vaut mieux que couper l'équipe sur une erreur SQL.

**Avant `this.limiter = new SlackRateLimiter({`**

⚠️ Les limites se lisent depuis l'ENVIRONNEMENT, et c'est ce qui rend enfin vraie la

phrase du refus (« c'est un réglage de déploiement »). `readRuleLimit` avait été écrit

exactement pour ça et n'avait AUCUN site d'appel : le plafond était un littéral figé à

la compilation, donc « relever le plafond » exigeait de modifier le code source.

La fonction refuse déjà `0` et les négatifs et retombe sur le défaut — une faute de

frappe dans une variable Vercel ne peut pas éteindre le bot en silence.
**Avant `this.botUserIdPromise = undefined;`**

Un échec ne doit pas figer le cache : on réessaiera au prochain événement.

**Avant `private dedupKey(envelope: SlackEventEnvelope): string | undefined {`**

Clé de déduplication : `event_id` si présent, sinon `channel:ts`.

Un `team_join` n'a NI `channel` NI `ts` : le repli est inopérant pour lui,
seul `event_id` le protège du double DM de bienvenue. Slack le fournit
systématiquement sur une enveloppe `event_callback`.

**Avant `if (event && !isTeamJoinEvent(event)) {`**

`channel:ts` PRIME sur `event_id` pour les événements porteurs de texte.

Une même prise de parole peut produire DEUX événements aux `event_id`

distincts (`message` et `app_mention`), mais ils partagent toujours le

même `ts` dans le même canal : une seule clé, donc un seul traitement.

C'est la protection de fond ; la garde `duplicate_mention` ci-dessus

évite en plus d'ouvrir une entrée pour rien.
**Avant `if (envelope.event_id) return `id:${envelope.event_id}`;`**

`team_join` n'a ni canal ni `ts` : seul `event_id` le protège du rejeu.

**Avant `async accept(`**

Décision SYNCHRONE prise avant l'ACK HTTP.

Règles :
 - `app_mention` → traité (mention du bot dans un canal).
 - `message` → traité UNIQUEMENT si `channel_type === 'im'` (message direct).
   C'est aussi ce qui empêche la double réponse : quand on mentionne le bot dans un
   canal, Slack émet À LA FOIS `app_mention` ET `message` (`channel_type: 'channel'`).
   En n'acceptant `message` que pour les DM, un seul des deux passe.
 - Tout message émis par un bot est ignoré (anti-boucle infinie).

**Avant `if (this.isStale(envelope, event)) {`**

⚠️ AVANT la prise de clé : un événement périmé ne doit ni être traité, ni consommer

une clé de déduplication qu'il faudrait ensuite refermer.
**Avant `const limited = await this.checkRateLimit(event);`**

⚠️ APRÈS la déduplication, jamais avant. Un rejeu Slack n'est pas un nouveau message :

le compter consommerait le quota de quelqu'un pour un événement qu'il n'a envoyé qu'une

fois — et c'est précisément sur les démarrages à froid, donc quand le bot va déjà mal,

que Slack rejoue le plus.
**Avant `private isStale(envelope: SlackEventEnvelope, event: SlackEvent): boolean {`**

L'événement est-il trop VIEUX pour qu'on y réponde encore ?

Le défaut mesuré en production — le bot a répondu à une question d'il y a 1 h 40

    20:54  Karyl  : « tu peux me retrouver le profil de mistourath@kissohq.com ? »
    20:54  Mastra : « Je n'ai pas trouvé d'employé avec cette adresse. »
    22:31  Mastra : « J'ai atteint mon quota de messages pour aujourd'hui. »
    22:33  Karyl  : « bonjour »
    22:34  Mastra : « Je vois que Mistourath n'a pas de dossier d'onboarding… »   ← 20:54
    22:35  Mastra : « Ton document a été créé et livré sur ce fil Slack. » + un PDF

Deux réponses tardives se sont insérées dans une conversation qui avait avancé depuis,
dont une qui a livré un DOCUMENT que plus personne n'attendait. Vu de l'utilisatrice,
le bot répond à côté — et le « bonjour » qui précède rend la confusion totale.

── La cause : la reprise d'un événement abandonné n'avait qu'un PLANCHER d'âge ──
`claimLocally` et `DrizzleSlackEventDedupRepository.claim` reprennent une clé
`in-flight` dès que `ageMs >= inFlightGraceMs` (60 s). Aucune borne HAUTE : une entrée
de 61 secondes et une de 100 minutes sont traitées à l'identique. Le traitement repart
alors ENTIER — nouvel appel de modèle, nouvelle réponse postée — avec le texte de
l'événement d'ORIGINE.

S'y ajoute une fuite : `markDedupDone`/`releaseDedup` ne sont appelés que depuis
`handleEvent()`, donc un événement refusé par la limite de débit reste `in-flight`
**indéfiniment** — prêt à être « abandonné » puis repris à la première redélivrance.

── Pourquoi une borne d'ÂGE DE L'ÉVÉNEMENT, et non un plafond sur la reprise ──
Parce qu'elle couvre TOUS les chemins d'un seul contrôle : reprise d'un abandon, rejeu
Slack, redélivrance tardive, file d'attente. Un plafond sur la seule reprise laisserait
les autres ouverts, et ce dépôt a déjà payé les correctifs posés sur un chemin quand le
défaut vivait sur plusieurs.

── Pourquoi on ne LIBÈRE PAS la clé sur un refus de débit ──
Ce serait le correctif intuitif de la fuite, et il serait faux : la clé libérée, un rejeu
Slack arrivant 5 secondes plus tard repasserait pour un message NEUF et **consommerait
une seconde unité du quota de la personne pour un message qu'elle n'a envoyé qu'une
fois**. C'est précisément ce que `checkRateLimit` documente en exigeant d'être appelé
APRÈS la déduplication. La clé bloquée est donc protectrice, et la borne d'âge suffit à
la rendre inoffensive.

── Le chiffre ──
10 minutes, contre un run de 2 à 21 secondes (jusqu'à ~60 s de `maxDuration`) et des
rejeux Slack qui vivent dans la minute. La marge est de deux ordres de grandeur : elle
ne peut pas écarter un traitement légitimement lent, et elle écarte tout ce qui n'a
plus de sens conversationnel.

⚠️ **Les messages seulement.** Un `team_join` tardif doit être traité : il déclenche le
parcours d'arrivée d'une personne réelle, et le perdre coûte infiniment plus qu'une
réponse hors sujet. La latence n'y est pas un problème de pertinence.

⚠️ Jamais silencieux — `warn`, pas `debug` : « le bot ne répond plus » est le symptôme
le plus coûteux de ce dépôt, et une garde muette qui l'imiterait serait indiscernable
d'une panne.

**Avant `const emittedAtSeconds = envelope.event_time;`**

`event_time` (secondes) UNIQUEMENT — jamais `event.ts`, et la distinction compte.

`ts` est l'IDENTIFIANT d'un message dans son canal ; c'est la matière première de la

clé de déduplication, pas une horloge. Rejeux, fixtures et outils de test le tiennent

légitimement CONSTANT, et le lire comme une date ferait périmer des événements

parfaitement frais. `event_time` est le seul champ dont le sens EST « quand cet

événement a eu lieu », et Slack le pose sur tout `event_callback`.

Absent ⇒ on laisse passer. Un âge inconnu n'est pas un âge excessif, et le dépôt

penche déjà de ce côté partout où il décide sans preuve (`checkTeamId`, la

déduplication partagée, le compteur de débit) : une garde qui coupe sur une donnée

manquante reproduit le symptôme le plus coûteux de ce projet, le bot muet.
**Avant `private isAnsweredWithoutModel(event: SlackEvent): boolean {`**

Compte le message et dit s'il peut être traité.

Placé dans `accept()` et non dans `handleMessage()` : c'est le seul endroit qui soit AVANT
l'ACK, donc avant que le travail de fond ne soit programmé. Refuser plus tard laisserait
déjà partir l'appel LLM — c'est-à-dire la dépense qu'on cherche à borner.

NE LÈVE JAMAIS : `SlackRateLimiter` dégrade tout seul vers son compteur local quand le
store partagé est indisponible, et une panne du compteur ne doit pas devenir une panne du
bot. Ici on n'ajoute qu'une garde de plus, par principe de non-régression.

Ce message sera-t-il traité SANS aucun appel de modèle ?

DÉLÉGATION à `deterministic-replies.ts`, qui déclare les huit cas une seule fois. La
version précédente les RECOPIAIT ici, en exigeant d'être « le MIROIR EXACT » des
court-circuits de `handleMessage` : une liste tenue à la main, dont l'oubli faisait
rationner un message gratuit. Elle ne peut plus diverger.
**Avant `return isAnsweredWithoutModel({`**

Sans `botUserId` : le chemin d'ACK n'a pas les 3 secondes d'un `auth.test()`. La

mention résiduelle du bot ne change aucun des verdicts — une salutation reste une

salutation, une longueur reste une longueur.
**Avant `isDirectMessage: event.channel_type === 'im' || (event.channel ?? '').startsWith('D'),`**

⚠️ Le seul critère non textuel de la table qui entre dans une DÉCISION, et il est

disponible ici sans aucune E/S — condition pour qu'il puisse servir sur le chemin des

3 secondes. Sans lui, « c'est fait » écrit en canal serait compté comme traité sans

modèle alors qu'il part chez un agent.
**Avant `const subject = isTeamJoinEvent(event) ? event.user?.id : event.user;`**

Le sujet est la PERSONNE, pas le canal : c'est un budget de messages par humain. Sans

auteur identifiable il n'y a personne à débiter, et refuser par défaut couperait les

événements systèmes.
**Avant `reserveOnly: true,`**

⚠️ RÉSERVATION, pas consommation. La décision d'abandonner un fil ne se prend qu'en

tâche de fond, une fois l'historique lu — bien après ce point. Débiter ici faisait

payer le budget quotidien à des messages qui n'atteindront jamais un modèle. Le

débit réel vit dans `chargeModelBudget`, juste avant `agent.generate()`.
**Avant `if (decision.rationsModelBudget && (await this.settlesWithoutModel(event))) {`**

LE MIROIR EXACT — seule branche autorisée à lire en base sur ce chemin

Le miroir TEXTUEL ci-dessus (`isAnsweredWithoutModel`) est évalué pour CHAQUE message

et ne peut donc rien lire : le chemin de l'ACK a 3 secondes. Il en résulte un angle

mort structurel — les court-circuits dont la reconnaissance dépend d'un ÉTAT

(« oui » à un email en attente, réponse à une question d'accueil) lui sont invisibles,

alors qu'ils coûtent ZÉRO token. Une personne au quota s'entendait donc répondre

« le budget est épuisé » au moment précis où elle voulait ANNULER un envoi, ou

terminer son propre dossier. Le garde-fou du budget bloquait des gestes qui ne

consomment pas de budget — même famille que « bonjour » refusé en 2026-08-13, et que

`profile_done` facturé jusqu'au 2026-08-19.

⚠️ LA PRÉMISSE QUI A ÉTÉ RENVERSÉE : « l'ACK n'a pas le droit de lire en base ». Il le

fait déjà DEUX fois par message — la prise de clé de déduplication et le compteur

partagé sont l'un et l'autre des allers-retours Turso. Ce qui n'a pas le droit de

grossir, c'est le chemin NOMINAL. Cette lecture-ci vit APRÈS un refus, donc sur un

chemin rare : elle ne coûte rien à personne d'autre qu'à celui qui allait de toute

façon être refusé.

⚠️ Réservé aux règles qui RATIONNENT LE MODÈLE. Un refus de RAFALE s'applique à tout,

y compris aux gestes gratuits : une rafale reste une rafale, et attendre douze

secondes n'a jamais empêché personne d'annuler un email.
**Avant `if (decision.shouldNotify && !isTeamJoinEvent(event) && event.channel) {`**

`shouldNotify` n'est vrai qu'au PREMIER refus de la fenêtre. Le dire à chaque message

transformerait la protection en son propre spam — et chaque publication est elle-même

un appel à l'API Slack.
**Avant `logger.error('Rate limit check failed — letting the event through', { error });`**

Fail-open BRUYANT, doctrine constante du dépôt : un message de trop est visible et

corrigeable, un bot muet ne l'est pas.
**Avant `private async chargeModelBudget(slackUserId: string | undefined): Promise<void> {`**

Débite le budget MODÈLE du demandeur, une fois qu'il est acquis qu'un modèle sera appelé.

Contrepartie de la RÉSERVATION faite dans `accept()`. Sans auteur identifiable il n'y a
personne à débiter — même raison que dans `checkRateLimit`.

⚠️ Ne REFUSE pas et ne lève pas : le refus a déjà eu lieu à l'ACK, sur la réservation. Ce
point-ci ne fait qu'acter la dépense. Y rejouer un refus ferait renoncer après avoir lu
l'historique et résolu l'identité, pour un verdict que l'appelant a déjà obtenu.

**Avant `logger.error('Could not charge the model budget — serving the message anyway', { error });`**

Même doctrine que le fail-open de `checkRateLimit` : un compteur en panne ne doit

jamais priver quelqu'un d'une réponse.
**Avant `private async settlesWithoutModel(event: SlackEvent): Promise<boolean> {`**

Ce message sera-t-il traité SANS aucun appel de modèle — en tenant compte de l'ÉTAT ?

Contrepartie exacte de `isAnsweredWithoutModel`, qui ne juge que sur le TEXTE. Les deux
cas couverts ici ont en commun de coûter zéro token et d'être invisibles à un prédicat
purement textuel, parce que leur reconnaissance dépend de ce qui a été dit avant :

  • une réponse à une question du parcours d'accueil (l'état EST le dernier tour
    `assistant` du fil) ;
  • un « oui » / « non » qui tranche un email d'entretien en attente (l'état est une ligne
    de `pending_interview_email`).

⚠️ Aucun des deux prédicats n'est réécrit ici : `answersOnboardingQuestion` est celui-là
même qu'exécutent les deux machines à états, et `pendingEmailVerdict` celui-là même
qu'exécute `resolvePendingEmail`. C'est la condition pour que ce miroir ne puisse pas
mentir — un miroir qui approxime son objet finit par refuser ce qu'il devait épargner.

⚠️ ÉCHOUE VERS LE REFUS, à l'inverse du fail-open qui gouverne le reste de ce fichier, et
c'est cohérent : cette lecture n'accorde pas un droit, elle lève une restriction. Store
illisible ⇒ `resolvePendingEmail` échouerait de la même façon quelques instants plus tard
et le « oui » partirait chez un agent, donc coûterait des tokens. Laisser passer sur une
panne de lecture reviendrait à ouvrir le quota sur une panne de base.

**Avant `const text = this.cleanText(event.text);`**

Sans `botUserId` : le chemin d'ACK n'a pas les 3 secondes d'un `auth.test()`, et la

mention résiduelle ne change aucun de ces deux verdicts.
**Avant `const [history, pending] = await Promise.all([`**

EN PARALLÈLE : les deux lectures sont indépendantes, et ce chemin reste borné par les

3 secondes de l'ACK même s'il est rare.
**Avant `text: (rule && RATE_LIMIT_REPLIES[rule]) || RATE_LIMIT_REPLIES.burst,`**

Tutoiement, comme les trois agents : le basculement de registre exact au moment où

ça casse donne l'impression de deux interlocuteurs différents. Et on ne nomme pas la

règle — l'utilisatrice n'a rien à faire de « BURST_RULE », elle a besoin de savoir

quoi faire ensuite.

Trois refus DISTINCTS, parce qu'ils appellent trois gestes différents. Il n'y en

avait que deux, et le texte « quota » était doublement faux :

 - « MON quota » personnalisait une contrainte COLLECTIVE. Le budget est celui du

   fournisseur, partagé par toute l'équipe : relever le plafond d'une personne ne

   crée aucun token, ça lui permet seulement d'épuiser plus vite la part des autres.

 - « demande à un administrateur de relever le plafond » promettait un levier qui

   N'EXISTAIT PAS — `readRuleLimit` n'avait aucun site d'appel, la limite était un

   littéral figé à la compilation. Et la personne à qui le bot disait ça est

   l'administratrice. La phrase n'est rétablie que maintenant que les limites se

   lisent réellement depuis l'environnement.
**Avant `private async claimEvent(key: string, retryNum?: string | null): Promise<boolean> {`**

Prend la clé d'un événement, ou refuse — en DEUX niveaux.

1. **Cache local (LRU).** Écarte sans aucune E/S les rejeux qui retombent sur la MÊME
   instance. Gratuit, et c'est le cas le plus fréquent quand l'instance est chaude.
2. **Store partagé (Turso).** Le seul capable d'écarter un rejeu routé vers une AUTRE
   instance. C'est précisément ce qui manquait le 2026-08-11 : l'instance A était occupée
   par le `waitUntil` de l'appel LLM, donc le rejeu Slack (`retryNum: "1"`, provoqué par
   un ACK à 6,7 s sur démarrage à froid) est parti sur une instance NEUVE, au cache vide,
   qui a répondu une seconde fois avec un texte différent.

**Dégradation assumée** : si le store partagé est indisponible, on retombe sur le seul
cache local et on ACCEPTE l'événement. L'arbitrage est explicite — un doublon possible
vaut mieux qu'un message perdu, car le doublon est visible et corrigeable tandis que le
silence ne l'est pas. La ligne est journalisée en `error` : c'est celle à chercher si les
doubles réponses reviennent.

**Avant `this.seenEvents.delete(key);`**

Une AUTRE instance mène ou a mené le traitement. On relâche notre prise locale :

la garder en `in-flight` bloquerait localement un rejeu qui redeviendrait pourtant

légitime après la grâce d'abandon.
**Avant `logger.warn('Reprocessing an abandoned Slack event (shared claim)', {`**

Symptôme d'une invocation tuée en vol : le traitement précédent n'a jamais rendu

la main et la grâce a expiré.
**Avant `private claimLocally(key: string, retryNum?: string | null): boolean {`**

Volet local de la prise de clé. Conserve à l'identique la sémantique d'origine, qui est
le fruit d'un bug déjà corrigé : une entrée `in-flight` plus vieille que la durée de vie
maximale d'une invocation ne peut plus correspondre à un traitement vivant (fonction gelée
ou tuée), donc l'événement redevient rejouable plutôt que d'être perdu DÉFINITIVEMENT.

**Avant `private checkTeamId(envelope: SlackEventEnvelope): SlackEventDecision | undefined {`**

Vérifie que l'événement vient bien du workspace attendu.

Délibérément **fail-open** : `SLACK_TEAM_ID` n'est définie ni localement ni
en production, donc rejeter en son absence couperait 100 % du trafic Slack
— silencieusement, la route rendant `200` en toute circonstance, et sans
qu'aucun test ne vire au rouge. La signature HMAC lie déjà chaque requête
au *signing secret* de cette app, qui n'est installée que sur un seul
workspace : ce contrôle n'est qu'une défense en profondeur.

Pour passer en fail-closed : déclarer `SLACK_TEAM_ID` dans Vercel, redéployer,
confirmer l'absence d'avertissement dans les logs, PUIS durcir ici.

**Avant `private rejectMessage(event: SlackMessageEvent): SlackIgnoreReason | undefined {`**

 Motifs de rejet propres aux messages. `undefined` = accepté.

**Avant `if (event.type === 'message' && event.channel_type !== 'im') {`**

Un message de canal passe s'il RÉPOND DANS UN FIL — et seulement dans ce cas.

Le filtre d'origine (`channel_type !== 'im'` → rejet sec) était plus large que son

motif. Il existait pour empêcher la double réponse d'une mention, qui émet à la fois

`message` et `app_mention` : or ce doublon est DÉJÀ traité par `dedupKey`, qui préfère

`ts:<channel>:<ts>` à `event_id` et unifie donc les deux événements. Son effet de bord,

lui, était majeur : sans re-mention à chaque tour, toute la mémoire conversationnelle

était INERTE en canal.

La restriction au fil est ce qui rend l'ouverture tenable : le bot est membre de
\#kisso-hq et #engineer-karyl, et accepter toute prise de parole y brûlerait le quota

**Avant `if (event.type === 'message' && event.channel_type !== 'im') {`**

(≈ 19 messages/jour chez Groq) en quelques échanges. Le message RACINE d'un fil est

exclu (`thread_ts === ts`) : c'est une prise de parole neuve, pas une réponse.

⚠️ Aucune lecture en base ici : `accept()` est le chemin d'ACK, il a 3 secondes. La

vérification « le bot a-t-il déjà parlé dans ce fil ? » se fait en tâche de fond,

dans `handleMessage`.
**Avant `if (event.type === 'app_mention' && event.channel?.startsWith('D')) {`**

Symétrique du filtre ci-dessus, pour les DM. Mentionner le bot dans un DM

émet À LA FOIS `message` (channel_type 'im') et `app_mention` : on garde

le premier, on écarte le second. Sans cela le bot répond DEUX FOIS —

observé en production le 2026-08-10.

Le test porte sur le préfixe `D` du canal et NON sur `channel_type` :

le payload `app_mention` de Slack ne porte pas ce champ (vérifié dans

`@slack/types`, `AppMentionEvent` déclare `ts`, `channel`, `event_ts`).
**Avant `if (event.bot_id || event.subtype === 'bot_message' || event.bot_profile) {`**

Anti-boucle : les indices synchrones. `user === bot_user_id` est vérifié plus tard

(nécessite un appel réseau `auth.test()`).
**Avant `if (event.type === 'message' && event.subtype && event.subtype !== FILE_SHARE_SUBTYPE) {`**

⚠️ `file_share` est LAISSÉ PASSER — correctif du 2026-08-13.

Déposer un PDF au bot RH est le geste le plus naturel qui soit, et il arrive avec

`subtype: 'file_share'` : il tombait donc dans le rejet générique ci-dessous, sans un

mot. Pour la personne, le bot était simplement EN PANNE — le pire des symptômes,

parce qu'il ne se distingue pas d'une vraie panne et n'invite à rien.

On ne lit toujours AUCUN contenu de fichier (c'est un choix de sécurité, pas une

limite technique) : `handleMessage` répond une phrase déterministe, sans appel LLM.
**Avant `if (event.subtype !== FILE_SHARE_SUBTYPE && !this.cleanText(event.text)) {`**

Un partage de fichier porte souvent un texte VIDE : la garde ci-dessous l'écarterait

avant que `handleMessage` ait pu répondre. Elle ne s'applique donc qu'aux vrais

messages.
**Avant `private rejectTeamJoin(event: SlackTeamJoinEvent): SlackIgnoreReason | undefined {`**

Motifs de rejet propres à `team_join`. `undefined` = accepté.

Aucune des gardes de `rejectMessage` ne s'applique ici : `bot_id`,
`subtype`, `bot_profile` et `text` sont des champs de *message*, absents
d'un `team_join`. Sans les gardes ci-dessous, le bot ouvrirait un DM à
chaque application installée — et la garde `empty_text` rejetterait au
contraire 100 % des arrivées réelles.

**Avant `if (user.is_ultra_restricted || user.is_stranger) return 'restricted_user';`**

Décision métier assumée : un invité MONO-canal (`is_ultra_restricted`) et

un externe Slack Connect (`is_stranger`) ne sont jamais des embauches

Kisso. L'invité MULTI-canal (`is_restricted`) passe en revanche — ce sont

les prestataires, qui suivent bien le parcours d'intégration.
**Avant `private async markDedupDone(key: string | undefined): Promise<void> {`**

Le traitement est allé au bout : tout rejeu ultérieur doit être ignoré.

Les deux niveaux sont mis à jour. L'échec du niveau partagé n'est pas fatal — il laisse
la clé en `in-flight`, donc reprenable après la grâce d'abandon, ce qui est le
comportement le moins dommageable.

**Avant `private async releaseDedup(key: string | undefined): Promise<void> {`**

Le traitement a échoué de façon inattendue : on libère la clé pour qu'un rejeu Slack
puisse repartir immédiatement au lieu d'être avalé par la déduplication.

**Avant `private scheduleRateLimitPruneIfDue(): void {`**

Purge de rétention de la déduplication, en tâche de fond. Même cadence et même
raisonnement que `schedulePruneIfDue()` pour la mémoire : pas de cron dans ce projet, et
une purge un message sur cent suffit à borner la table.

Purge des compteurs de débit, en tâche de fond.

`SlackRateLimiter.prune()` était écrit, testé… et n'avait AUCUN site d'appel :
`rate_limit_counters` croissait sans fin, seule des quatre tables à TTL du dépôt à ne
jamais être purgée. Même cadence et même tirage que les deux autres.
**Avant `void this.getRateLimiter()?.pruneExpired();`**

`prune()` avale déjà ses propres erreurs et journalise : rien à rattraper ici.

**Avant `private cleanText(text: string | undefined, botUserId?: string): string {`**

Retire la mention DU BOT et normalise les espaces.

⚠️ Ne retire plus TOUTES les mentions. `@mastra crée un profil pour <@U0AWA>` devenait
« crée un profil pour » : le SUJET de la demande disparaissait du message avant même
d'atteindre le modèle, qui n'avait alors plus qu'un seul humain à qui rattacher un
pronom — celui à qui il parlait. Les mentions de TIERS sont donc conservées telles
quelles ; Slack les affiche, `wrapAgentInput` les laisse passer intactes (vérifié) et
`sanitizeAgentOutput` ne touche pas aux jetons `<@U…>`.

`botUserId` est `undefined` sur le chemin d'ACK (`rejectMessage`), qui n'a pas les 3
secondes nécessaires à un `auth.test()` : on y retombe sur l'ancien comportement, sans
conséquence — ce texte n'y sert qu'à décider si le message est vide.

**Avant `const botMention = new RegExp(`<@${(botUserId ?? '').replace(/[^A-Z0-9]/gi, '')}>`, 'g');`**

Le nettoyage de `botUserId` n'est pas cosmétique : la valeur vient de `auth.test()`,

donc du réseau, et elle est interpolée dans une expression régulière.

`botUserId` est réduit à `[A-Z0-9]` — liste BLANCHE, pas noire — avant interpolation :

rien de métacaractère ne peut survivre.
**Avant `private async resolveRequesterIdentity(`**

IDENTITÉ du demandeur — nom d'affichage, email, fiche employé. Mise en cache.
**Ne rejette jamais.**

## L'annuaire d'abord, Slack ensuite — et cet ordre est le fond du correctif

`users.info` sait rendre un nom et une adresse ; il ne sait RIEN de `employees.id`, qui
n'existe que chez nous. Or c'est l'identifiant que consomment la moitié des outils
(`getTaskList`, `scheduleReminder`, `sendNotification`…). Interroger Slack en premier
rendrait donc une identité systématiquement amputée de sa moitié la plus utile, alors
qu'une lecture sur la PRIMARY KEY de l'annuaire les rend toutes les deux d'un coup.

Le repli sur `users.info` est conservé pour la personne que l'annuaire ne connaît pas
encore : sans lui, le préambule perdrait le nom pour tout nouvel arrivant tant que
personne n'a lancé la synchronisation. Il ne rend jamais d'`employeeId` — c'est correct,
et c'est exactement pourquoi le champ est OMIS plutôt que rendu vide.

## Ce qui est mis en cache

Les ÉCHECS comme les succès (identité vide) : un workspace qui refuse `users.info` ne
doit pas coûter un aller-retour réseau à chaque message. Le TTL de 12 h borne la
péremption — une fiche employé rattachée après coup met au plus une demi-journée à
apparaître, ce qui est sans conséquence : le rattachement est une opération d'annuaire,
pas un geste de conversation.

**Avant `logger.debug('Directory lookup failed while resolving the requester identity', {`**

Une panne d'annuaire ne doit pas devenir une panne du bot : on tombe sur Slack.

**Avant `email: resolved.email ?? member?.email ?? null,`**

`??` et non `||` : une adresse vide rendue par Slack ne doit pas écraser celle que

l'annuaire vient peut-être de fournir.
**Avant `async handleEvent(envelope: SlackEventEnvelope): Promise<void> {`**

Traitement de fond (après l'ACK). Ne jamais `await` depuis la route HTTP.

C'est ICI, et seulement ici, que la clé de déduplication passe de `in-flight` à
`done` : tant que ce point n'est pas atteint, un rejeu Slack reste recevable.

**Avant `await this.releaseDedup(key);`**

Échec inattendu : la clé est libérée pour que Slack puisse rejouer.

**Avant `if (isTeamJoinEvent(event)) {`**

L'aiguillage précède délibérément `getBotUserId()` : c'est un aller-retour

réseau (`auth.test()`) sans objet sur ce chemin — la boucle « le bot poste

en tant qu'utilisateur » n'existe pas pour une arrivée, et le cas « un bot

rejoint le workspace » est déjà filtré par `rejectTeamJoin`, sans réseau.
**Avant `const botUserId = await this.getBotUserId();`**

Dernière garde anti-boucle : le bot pourrait poster en tant qu'utilisateur.

**Avant `async handleTeamJoin(event: SlackTeamJoinEvent): Promise<void> {`**

Ouvre un DM de bienvenue portant le bouton « Compléter mon profil ».

Aucun LLM sur ce chemin : la modale collectera les données, et le workflow
sera appelé en code. Coût : zéro token.

N'échoue jamais vers l'appelant — `handleEvent` relance l'exception et
libère la clé de déduplication, ce qui ferait rejouer Slack et enverrait un
SECOND DM de bienvenue, visible par la personne.

**Avant `const joinedAt = new Date().toISOString();`**

L'instant de l'événement EST la date d'arrivée. Lu UNE SEULE FOIS, avant toute E/S :

deux lectures d'horloge donneraient deux dates pour un seul et même fait, et celle qui

finirait en base ne serait pas celle du journal.
**Avant `await this.recordNewcomer(user.id, identity, joinedAt);`**

Les deux gestes qui précèdent le DM sont indépendants l'un de l'autre ET du DM. Chacun

avale son échec : ni l'annuaire ni les canaux ne valent de priver quelqu'un de son

message de bienvenue. Un arrivant sans canal mais avec son DM peut demander de l'aide ;

l'inverse ne le peut pas.
**Avant `private async recordNewcomer(`**

Rend l'arrivant résolvable dès la seconde zéro.

Sans cela, l'annuaire n'apprend une personne qu'au PREMIER MESSAGE qu'elle envoie — et
`findEmployeeByEmail`, qui s'y replie depuis le 2026-08-12, répondait « introuvable » pour
quelqu'un que Slack venait pourtant d'annoncer. C'est exactement le symptôme signalé en
production (« il ne retrouve que mon profil »), vu depuis son autre extrémité.

⚠️ `teamId` est laissé VIDE : le payload `team_join` ne le porte pas de façon fiable, et
`upsertFacts` ne doit jamais écraser un fait connu par une supposition. Une synchronisation
ultérieure le renseignera.

**Avant `title: null,`**

Le poste DÉCLARÉ dans Slack n'est pas lu au `team_join` : il est vide à la seconde

zéro, et c'est précisément ce qu'on va demander à la personne.
**Avant `private async inviteToWelcomeChannels(slackUserId: string): Promise<readonly string[]> {`**

 Rend les noms des canaux où l'arrivant se trouve. Ne lève JAMAIS.

**Avant `logger.error('Welcome channel invitations threw', { error, slackUserId });`**

Le service déclare ne jamais lever ; on ne le suppose pas pour autant. Une exception

qui traverserait ce point emporterait le DM de bienvenue avec elle.
**Avant `private async resolveNewcomer(user: SlackTeamJoinUser): Promise<NewcomerIdentity> {`**

Ce que Slack sait déjà de l'arrivant, pour pré-remplir la modale.

L'email manque souvent du payload `team_join` tant que le profil n'est pas
complété : on ne paie le second aller-retour `users.info` que dans ce cas.
Son échec ne bloque pas — le DM part sur l'identifiant Slack et la modale
collectera l'email.

**Avant `private async runErasure(ctx: {`**

EFFACEMENT DEMANDÉ — un geste RÉEL, jamais une narration

« oublie ce que je t'ai dit », « supprime tout ce que tu sais de moi » : jusqu'ici ces

messages partaient au modèle, qui n'a AUCUN outil d'effacement et ne pouvait donc que

le raconter. C'est le défaut central de ce dépôt — « il parle exactement de la même

façon quand il a fait le travail et quand il l'a inventé » — appliqué à la seule

demande à laquelle une narration ne peut PAS se substituer.

⚠️ La réconciliation FAIT/NARRATION n'aurait rien rattrapé : elle guette une formule

d'accompli sans `toolCall`, or il n'existait aucun tool à appeler, donc aucune

contradiction à constater. Le seul correctif possible était de rendre le geste réel.

Placé APRÈS la détresse et AVANT la frontière d'autorisation, délibérément : effacer

ses propres données n'est pas un privilège qu'on accorde au niveau `full`, c'est un

droit. Le même raisonnement que pour la détresse — on ne fait pas passer une politique

d'accès devant une demande qui ne porte que sur soi.
**Avant `const scope = isDirectMessage ? { conversationId } : { conversationId, slackUserId: user };`**

En DM, `deriveConversationId` retombe sur le canal `D…` : la conversation EST

l'espace privé d'une seule personne, donc tout y est à elle, tours `assistant`

compris. Dans un fil de canal, plusieurs humains parlent — effacer le fil entier

parce que l'un d'eux le demande supprimerait les messages des autres.
**Avant `if (!repo || (!isDirectMessage && !user)) {`**

Hors DM sans auteur identifié, la portée serait INDÉTERMINÉE — et une portée

indéterminée sur une suppression, c'est la suppression du fil entier. On préfère

échouer bruyamment : c'est irréversible, et personne ne l'a demandé.
**Avant `let removedFacts = 0;`**

⚠️ La mémoire LONGUE part avec, et c'est non négociable : elle survit au TTL de

60 minutes par construction. L'oublier ici ferait qu'une personne ayant demandé

l'effacement verrait le bot continuer à citer ce qu'elle lui avait dit de

retenir — c'est-à-dire le pire cas possible pour ce chemin.

L'effacement porte sur le DEMANDEUR, jamais sur la conversation : les faits sont

indexés par `slack_user_id`. En DM les deux coïncident ; en canal, on n'efface

que les siens, comme pour les tours.

Isolé dans son propre `try` : un échec ici ne doit pas faire annoncer un échec

total alors que les tours, eux, sont bien partis. On le journalise et on continue

— la réponse rendue reste vraie sur ce qu'elle affirme.
**Avant `logger.info('Erasure request honoured — answered without any LLM call', {`**

Le COMPTE, jamais le contenu : c'est une trace d'exécution, pas une copie de ce

qu'on vient précisément de supprimer.
**Avant `logger.error('Erasure request failed', { error, channel });`**

⚠️ Ne JAMAIS retomber sur `erasureDoneReply` ici. Toute la valeur du correctif

tient dans le fait que la réponse dit ce qui s'est réellement passé ; annoncer un

effacement qui n'a pas eu lieu serait pire que l'absence de fonctionnalité, parce

que la personne cesserait de le demander.
**Avant `const repo = user ? this.getPinnedFactRepo() : null;`**

Sans auteur identifié, la mémoire longue n'a pas de clé : elle est indexée par

`slack_user_id`, pas par conversation. On le dit plutôt que d'écrire une ligne

orpheline que personne ne relira jamais.
**Avant `fact: factToPin,`**

Le texte est déjà passé par `cleanText`. Il sera RÉÉMIS au modèle à chaque

tour, dans le message `system` — même exigence que pour les tours de

conversation : on ne persiste jamais du brut.
**Avant `logger.info('Fact pinned — answered without any LLM call', {`**

La LONGUEUR, jamais le contenu : c'est une donnée personnelle que la personne

vient de confier, elle n'a rien à faire dans un journal.
**Avant `logger.error('Pin request failed', { error, channel });`**

⚠️ Ne JAMAIS retomber sur `pinnedFactReply` ici. Promettre de se souvenir sans

avoir pu écrire serait exactement le défaut qu'on corrige, sous une autre forme.
**Avant `private async runCancelReminder(ctx: {`**

Le DOUZIÈME court-circuit, ajouté le 2026-08-25 — et le premier geste RÉVERSIBLE du produit.

Le raisonnement complet — pourquoi un court-circuit et non un treizième outil, pourquoi le
modèle ne peut structurellement pas désigner le rappel — vit dans
`docs/conception/shared.md`, section `shared/cancel-reminder.ts`. Ce qui se décide ICI est
l'EXÉCUTION, parce que le handler est le seul à tenir à la fois le dépôt et le client Slack.

⚠️ ON PART DU DOSSIER DU DEMANDEUR, jamais d'une liste qu'on filtrerait ensuite. Il n'y a
donc rien à filtrer, donc rien à oublier de filtrer — la même construction que la liste des
canaux de `searchKnowledge`, bâtie sur `users.conversations` du demandeur.

⚠️ LES RAPPELS `sending` ENTRENT DANS LES CANDIDATS, et ce n'est pas une négligence. Répondre
« tu n'as aucun rappel en attente » à quelqu'un dont le rappel est en cours de remise serait
FAUX : il en a un, il est simplement trop tard. Ils sont donc listés, `cancelIfPending` les
refuse, et la personne s'entend dire que le message part quand même. Deux états distincts,
deux phrases distinctes — même exigence que `no_data_yet` contre `not_persisted` au tableau
de bord.

⚠️ AUCUN APPEL DE MODÈLE, et c'est ce qui rend le geste gratuit au plafond quotidien. Son
entrée dans `DETERMINISTIC_REPLIES` suffit à l'inscrire au miroir `isAnsweredWithoutModel`,
qui se DÉRIVE de la table : c'est la correction de 2026-08-18 qui paie ici, quatre mois après
que « bonjour », `profile_done` et le « oui » d'un email en attente ont chacun été facturés à
tort.

**Avant `private async runProfileForm(ctx: {`**

DEMANDE DU FORMULAIRE DE PROFIL — réponse déterministe, aucun appel LLM

Le défaut : `buildWelcomeBlocks` était le SEUL émetteur du bouton, et son seul

appelant `handleTeamJoin`. Un salarié DÉJÀ PRÉSENT n'avait donc aucun chemin vers le

formulaire — `team_join` ne se déclenche que sur une ARRIVÉE. Mesuré sur la Turso le

2026-08-14 : `employees` = 2 lignes, `slack_directory` = 4 personnes vivantes de plus,

toutes non rattachées.

⚠️ La suite de ce commentaire affirmait que « `team_join` ne figure même pas dans les

abonnements de l'app Slack, si bien que les arrivants non plus ». C'est FAUX : vérifié

dans la console le 2026-08-15, l'événement EST abonné et `handleTeamJoin` s'exécute.

Les cinq personnes sans dossier étaient déjà là AVANT l'installation du bot — un retard

de rattrapage, pas un chemin manquant. Ce court-circuit sert donc le rattrapage, aux

côtés de `npm run profile:invite`, et non les futurs arrivants.

Cela reste la cause du guide « générique » (aucun dossier à personnaliser) et de

l'échec de `getEmployeeProfile` sur la plupart des gens.

Placé APRÈS l'effacement et AVANT la frontière d'autorisation : remplir son propre

dossier n'est pas un privilège de niveau `full`. Un invité rétrogradé en `readonly`

doit pouvoir se déclarer — c'est même le seul geste qui puisse le faire sortir de

cet état.
**Avant `const { channel, threadTs, isDirectMessage } = ctx;`**

⚠️ `user` a été retiré de la signature le 2026-08-19, avec la lecture d'annuaire qu'il

alimentait. Le garder « au cas où » aurait laissé croire que ce chemin sait QUI parle,

alors qu'il n'a plus rien à en faire : le texte posté est le même pour tout le monde.
**Avant `if (!isDirectMessage) {`**

⚠️ DM UNIQUEMENT — et il faut RÉÉNONCER la raison, parce que l'ancienne a disparu avec

les boutons.

Jusqu'au 2026-08-19, le motif était le pré-remplissage : il voyageait dans le `value` du

bouton, donc en canal un témoin qui cliquait ouvrait une modale portant les données de

QUELQU'UN D'AUTRE, et sa soumission écrivait le dossier de cette personne. Ce vecteur

n'existe plus — il n'y a ni bouton, ni `value`, ni pré-remplissage.

La restriction est CONSERVÉE pour une autre raison, qui vaut seule : ce qui suit est un

ÉCHANGE (`profile-chat.ts`) dont chaque réponse est le nom, l'adresse et le poste de la

personne. Le conduire en canal les publierait devant témoins. Une restriction dont on

garde l'effet sans réénoncer la cause est exactement ce que ce dépôt appelle un

commentaire qui ment — la cause est ci-dessus, elle est neuve, et elle est vérifiable.
**Avant `await this.chatProvider.sendBlocks(`**

⚠️ La lecture d'annuaire qui vivait ici a été SUPPRIMÉE le 2026-08-19. Elle servait au

pré-remplissage du bouton ; celui-ci retiré, elle ne nourrissait plus qu'un champ de log

`prefilled` qui valait `true` alors que rien n'était pré-rempli. Un aller-retour Turso

(≈ 250 ms) payé sur un chemin qui se veut à zéro E/S, pour produire une ligne fausse.
**Avant `buildProfileInviteBlocks(),`**

⚠️ Plus AUCUN pré-remplissage : il vivait dans le `value` du bouton, et c'est ce

`value` qui imposait la restriction « DM uniquement » pour des motifs de sécurité —

en canal, un témoin qui cliquait ouvrait une modale portant les données d'autrui.

Sans bouton, transporter ces champs serait une donnée personnelle qui voyage sans

aucun destinataire.
**Avant `private async runAgentPipeline(ctx: {`**

Le pipeline LLM : router, encadrer, générer, assainir, publier.

⚠️ Extrait de `handleMessage` le 2026-08-18. C'est sa SECONDE responsabilité — la
première étant l'ordonnancement des gardes et des court-circuits, qui n'appellent aucun
modèle. Les deux se lisaient d'affilée dans 670 lignes, et rien ne signalait qu'on passait
de l'une à l'autre.

⚠️ Ce qui reste chez l'appelant, et qui ne doit PAS descendre ici : `chargeModelBudget`
et `startProgress`. Leur position relative est justifiée par un incident — le marqueur est
le premier écrit Slack, et poster « Je regarde ça… » pour le remplacer aussitôt par un
refus de quota serait la pire des séquences. Un découpage qui les emporterait rendrait cet
ordre invisible.

**Avant `let phase: 'route' | 'resolve-agent' | 'wrap' | 'generate' | 'sanitize' | 'post' = 'route';`**

Phase courante du traitement. Le catch générique ci-dessous couvrait cinq points

d'échec très différents — chaîne LLM épuisée, exception d'outil, `SecurityBlockError`

de `wrapAgentInput`, agent introuvable, échec de publication Slack — et les rendait

tous sous le même « Désolé, une erreur s'est produite », sans rien pour les

distinguer dans les logs. C'est ce qui a rendu l'incident du 2026-08-11 opaque.
**Avant `const stickyAgentId = history.at(-1)?.agentId;`**

La collance lit le DERNIER tour de l'historique BRUT, pas de la fenêtre : un fil

peut dépasser le budget de contexte sans pour autant avoir changé d'interlocuteur.
**Avant `await progress.resolve(`**

⚠️ Ce texte VOUVOYAIT et renvoyait « vers l'administrateur » — les deux défauts

exacts pour lesquels `NEUTRAL_REFUSAL` a été réécrit : le basculement de registre

au moment où ça casse donne l'impression de deux interlocuteurs, et la personne à

qui le bot disait ça est justement l'administratrice. Il ne nomme plus l'identifiant

d'agent non plus : c'est du vocabulaire interne, sans usage pour qui le lit.
**Avant `const safeInput = wrapAgentInput(text);`**

Le texte Slack est une entrée UTILISATEUR non fiable : on l'encadre (délimiteurs,

détection d'injection, neutralisation Unicode) avant de le transmettre au LLM.

Peut lever `SecurityBlockError` — et c'est voulu : un message bloqué ne doit

atteindre ni le modèle, ni la mémoire (décision D4).
**Avant `await this.rememberTurn({`**

Le tour utilisateur est mémorisé AVANT l'appel du modèle, et seulement après que

l'encadrement a réussi. Si la chaîne LLM échoue, la question reste connue : la

personne reformule et le bot a toujours le contexte, au lieu de repartir de zéro

exactement au moment où ça se passe mal.

⚠️ On mémorise le texte ASSAINI, pas le texte brut. La différence n'est pas

cosmétique : un message hostile portant un faux délimiteur (`<kisso_XXXX_user_input>`)

serait sinon stocké tel quel, puis rejoué NON ENCADRÉ à chaque tour suivant du fil —

une injection qui se persiste et se répète, exactement ce que la mémoire ne doit

jamais permettre. `wrapAgentInput` a déjà neutralisé le contenu ; on ne conserve

que ce qu'il a validé.
**Avant `const identity = await requesterIdentity;`**

Le contexte Slack descend jusqu'aux tools par le `requestContext` de Mastra — le seul

canal qui n'entre PAS dans la fenêtre du modèle. Sans lui, un tool n'a aucun moyen de

savoir où livrer un fichier : c'est ce vide qui a produit le faux lien

`https://kisso.internal/docs/<uuid>/download` du 2026-08-11.

⚠️ On transmet la variable `threadTs` DÉJÀ calculée plus haut, jamais `thread_ts` ni

`ts` du payload : en DM elle vaut `undefined` par conception, et un fichier uploadé

avec un `thread_ts` en DM serait enfoui hors de la conversation principale —

exactement le défaut qui a fait paraître le bot muet pendant des heures.

Résolue UNE fois : elle alimente désormais deux consommateurs — le préambule (ce que

le modèle sait dire) et le `requestContext` (ce sur quoi un tool a le droit de

décider). Deux `await` sur la même promesse rendraient la même valeur, mais nommer la

valeur dit qu'il s'agit bien de la même identité des deux côtés.
**Avant `const pinnedFacts = await this.loadPinnedFacts(user);`**

Mémoire LONGUE. Lue ici et non plus haut : ce chemin est le seul qui aille jusqu'au

modèle, et les sept court-circuits qui précèdent n'en ont aucun usage — la charger

avant eux paierait un aller-retour Turso pour chaque « bonjour ».

Dégrade en silence, comme la mémoire conversationnelle : sans faits épinglés le bot

redevient oublieux, il ne cesse pas de répondre.
**Avant `const requestContext = buildSlackRequestContext({`**

⚠️ Hissé dans une variable parce qu'il est BIDIRECTIONNEL depuis le 2026-08-18 : les

tools de `knowledge` y ÉCRIVENT la couverture des extraits, et cette boucle est

relue plus bas. C'est un canal SERVEUR — il ne traverse ni le prompt, ni les schémas,

ni le tool-result — donc l'aller comme le retour coûtent zéro token.
**Avant `eventTs: event.ts,`**

Identifiant du RUN pour les gardes d'idempotence des tools. `event.ts` et non

`threadTs` : en DM `threadTs` est absent par conception, donc deux messages

successifs partageraient la même clé et la garde bloquerait le second document

légitimement demandé.
**Avant `employeeId: identity.employeeId ?? undefined,`**

Fiche employé du DEMANDEUR — la seule donnée qui permette à un tool de

distinguer « je consulte mon dossier » de « je consulte celui d'un collègue ».

Elle était déjà résolue ici et injectée dans le préambule ; elle ne descendait

pas jusqu'aux tools, qui n'avaient donc aucun contrôle possible.
**Avant `accessLevel,`**

Coût en tokens : ZÉRO. Le `RequestContext` ne traverse ni le prompt, ni les

schémas de tools, ni le tool-result — c'est ce qui permet de faire descendre une

décision d'autorisation jusqu'aux tools sans jamais la soumettre au modèle.
**Avant `abortSignal: AbortSignal.timeout(AGENT_GENERATE_TIMEOUT_MS),`**

⚠️ LA SEULE BORNE DE DURÉE DE TOUT LE CHEMIN — posée le 2026-08-20.

Sans elle, une fonction tuée à `maxDuration` pendant cet appel laissait la

personne sur « Je regarde ça, un instant… » pour toujours : l'ACK à 200 avait

déjà supprimé tout rejeu Slack, et l'invocation mourait avant d'écrire la

moindre ligne d'erreur. Ni `progress.resolve()` ni `progress.fail()` n'étaient

atteints.

`abortSignal` se pose ICI et non dans `modelSettings` : Mastra l'EXCLUT

explicitement de ce dernier (`Omit<CallSettings, 'abortSignal' | …>`). Vérifié

dans le paquet installé — `AgentExecutionOptionsBase` l'accepte au premier

niveau. Le poser au mauvais endroit aurait été ignoré en silence, donc pire

qu'une absence : on aurait cru la borne en place.
**Avant `const safeOutput = sanitizeAgentOutput(response.text);`**

Point de passage UNIQUE de toute réponse d'agent vers Slack. C'est ici,

et nulle part ailleurs, qu'on garantit qu'aucun marqueur interne ne

franchit la frontière et que le style est bien du mrkdwn Slack.

Les instructions et le prompt système n'y suffisent pas : la campagne du

2026-08-10 a vu passer le délimiteur `kisso_XXXX`, le marqueur

`[SECURITY_BLOCK]` et du markdown GitHub, tous explicitement proscrits.
**Avant `const toolCalls = readToolCallNames(response);`**

RÉCONCILIATION FAIT / NARRATION.

Ce point est le SEUL du code qui voit à la fois la réponse du modèle et la trace

d'exécution : jusqu'ici il journalisait la seconde et postait la première sans

jamais les confronter. Le défaut produit numéro un, formulé par l'utilisatrice

testeuse, tient en une phrase : « il parle exactement de la même façon quand il a

fait le travail et quand il l'a inventé ».

On ne juge PAS la vraisemblance, on constate une CONTRADICTION : une réponse qui

affirme un accompli alors que la trace prouve que zéro outil a tourné est fausse par

construction. `null` (trace illisible) n'est pas `[]` (zéro appel) — sans preuve

positive, on se tait.

⚠️ La condition porte sur « aucun outil qui AGIT », et non sur « aucun outil ». Le

test `length === 0` d'origine ne se déclenchait presque jamais : une lecture

(`findEmployeeByEmail`, `getEmployeeProfile`) ouvre presque tout run et suffisait à

désarmer la détection pour le tour entier. Lire ne produit rien — une annonce

d'accompli que seules des lectures étayent est fausse par construction.
**Avant `logger.error('Agent claimed a completed action while no tool ran — response requalified', {`**

Niveau `error`, comme pour les URL fabriquées : c'est le même genre de faute — le

modèle affirme une réalité que le système peut démentir.
**Avant `const registeredWithoutDelivery = toolCalls !== null && onlyNonDeliveringTools(toolCalls);`**

── LA PROMESSE D'AVENIR — le symétrique, ajouté le 2026-08-18 ──────────

Ici l'accompli est VRAI et la suite est fausse : « Le rappel a été enregistré. Il

sera envoyé à Karyl par email le 20 août à 09 h 00. » `scheduleReminder` a bel et

bien tourné, donc le détecteur ci-dessus se tait par conception — la contradiction

n'est pas entre la phrase et la TRACE, elle est entre la phrase et le CÂBLAGE : il

n'existe ni cron ni poller, et `findPending()` n'a aucun site d'appel.

⚠️ La consigne de prompt a été essayée D'ABORD et mesurée en échec le même jour : la

réponse suivante en production a gagné une date et une heure d'envoi précises. Une

consigne est probable, le code est garanti.

Les deux notes sont MUTUELLEMENT EXCLUSIVES : `onlyNonDeliveringTools` exige au moins

une action, `hasActingToolCall` exige qu'il n'y en ait aucune. Deux démentis accolés

à la même réponse se contrediraient l'un l'autre.

⚠️ LA NOTE EST DÉSORMAIS INCONDITIONNELLE quand le seul outil AGISSANT du tour est un

enregistreur sans transport — correctif du 2026-08-20, TROISIÈME occurrence.

La liste fermée de formules a été élargie deux fois pour la même cause : « planifié »

(2026-08-19 matin), puis « programmé » le tour SUIVANT. Le 2026-08-20, le modèle a

trouvé un troisième logement, et c'est celui qui ferme le débat :

    « Rappel enregistré pour Karyl : relire le guide d'accueil le jeudi 20 août à 17 h. »

Aucun mot de promesse. Le verbe est celui du tool lui-même — le seul honnête — et

c'est la DATE accolée qui fait la promesse. Aucune liste de mots ne peut couvrir ça :

ce qui promet ici n'est pas un mot, c'est une juxtaposition.

La condition ne porte donc plus sur le TEXTE mais sur le CÂBLAGE, qui est certain :

`onlyNonDeliveringTools` est vrai quand le seul outil agissant rend

`willBeSentAutomatically: false`. Dans ce cas, « rien ne l'enverra » est vrai QUELLE

QUE SOIT la formulation, donc il n'y a rien à détecter — seulement à dire.

Le détecteur SURVIT, et sert désormais à ce pour quoi il est bon : journaliser que le

modèle a promis, ce qui reste le signal à suivre pour juger ses instructions.
**Avant `await this.rememberTurn({`**

Mémorisé APRÈS assainissement : sans cela, l'unique filet anti-marqueurs serait

contourné et un `kisso_XXXX` capté une fois se rejouerait à chaque tour suivant.

⚠️ La note de requalification n'entre PAS en mémoire, délibérément : c'est une

affordance destinée à l'humain, pas un tour de dialogue. La rejouer apprendrait au

modèle à imiter le démenti, et coûterait ses tokens à chaque tour suivant — sur un

budget quotidien de ≈ 19 messages.
**Avant `const excerptCoverage = readExcerptCoverage(requestContext);`**

⚠️ `progress.resolve` directement, et non plus un passe-plat qui recevait un

`{ channel, text }` dont il JETAIT le `channel` : le marqueur de progression connaît

déjà son canal, il a été construit avec. Un paramètre ignoré que les appelants

remplissent quand même est une fausse indication sur ce que la fonction fait.

── LA COUVERTURE, QUATRIÈME FORME — 2026-08-18 ────────────────────────

Relue depuis le `RequestContext`, où les tools de `knowledge` l'ont écrite pendant le

run. Les trois formes précédentes passaient toutes par le modèle et ont été mesurées

en échec sur le même canal : champ `coverage` ignoré, champ `hint` ignoré, préface

lue mais non relayée — et le jour même, une consigne d'agent réécrite pour couvrir

l'affirmation NÉGATIVE a échoué elle aussi (« Aucun blocage explicite n'est

mentionné », sur 6 messages vus sur 8). Deux agents, deux consignes, deux échecs :

une consigne est PROBABLE, le code est GARANTI.

⚠️ Écrite UNIQUEMENT si le résultat a réellement été tronqué

(`describeCoverageForHuman` rend `undefined` sinon) : un avertissement systématique

deviendrait du bruit, et le bruit s'ignore.
**Avant `const recipientNotice = buildRecipientNotice(requestContext, safeOutput.text);`**

── LE DESTINATAIRE D'UN DOCUMENT, TROISIÈME CONSIGNE MESURÉE EN ÉCHEC ──

Le bloc DOCUMENTS impose de citer le `recipient` depuis le 2026-08-14 : c'est la

mesure de VISIBILITÉ contre l'erreur de destinataire — « Bienvenue Awa » enregistré

sous l'UUID de Karyl, fichier parti à l'adresse de Karyl. Mesuré en production le

2026-08-19 sur DEUX sondes document : le modèle ne le cite pas. Une mesure de

visibilité qui ne se déclenche jamais est pire qu'absente — on la croit en place.

Après la couverture des extraits et la rédaction du contenu, c'est la TROISIÈME

consigne d'agent mesurée en échec sur ce dépôt. Le verdict ne bouge pas : une consigne

est PROBABLE, le code est GARANTI.

⚠️ La note n'est accolée QUE si la réponse ne nomme pas déjà la personne. Doubler une

réponse déjà juste d'une redite de machine est exactement le ton qu'on cherche par

ailleurs à supprimer — et un avertissement systématique devient du bruit, donc

s'ignore, ce qui le ramènerait au défaut qu'il corrige.
**Avant `appendNotes([excerptCoverage, pendingEmailReminder, onboardingReminder]),`**

⚠️ L'ORDRE compte, et il va du plus lié au moins lié à la réponse : la couverture

qualifie ce qui vient d'être dit, les deux rappels parlent d'autre chose. Un

rappel glissé entre la réponse et sa couverture ferait lire celle-ci comme une

note de bas de page du rappel.
**Avant `const inputTokens = this.readInputTokens(response);`**

Ce que le log ne disait pas et qu'il fallait deviner : combien d'étapes le run a

coûté, quels outils ont réellement tourné, et combien de tokens d'entrée ont été

brûlés. Sans `toolCalls`, « Le PDF a été généré » est indiscernable d'une pure

narration du modèle. Coût : zéro token.
**Avant `void this.getRateLimiter()?.consumeTokens(inputTokens);`**

LE COÛT RÉEL EST ENFIN COMPTÉ — il était lu, journalisé, et jeté

`inputTokens` existait déjà à cette ligne exacte et n'alimentait AUCUN compteur : il

mourait dans les logs. C'est la grandeur qui a réellement cassé la production

(`TPD: Limit 100000, Used 98207`), et rien ne la mesurait — les deux règles en place

comptaient des MESSAGES, et par PERSONNE.

⚠️ Ici, et pas avant : le coût n'est connu qu'APRÈS l'appel. Le message qui fait

franchir le seuil passe donc toujours, et le dépassement est constaté au suivant.

C'est la contrepartie assumée du choix de compter la bonne grandeur plutôt qu'une

grandeur commode.

`void` : on est après la publication de la réponse. Une erreur de comptabilité ne

doit rien changer pour la personne qui vient d'être servie.
**Avant `logger.error('Error processing Slack message', {`**

`error.constructor.name` est conservé explicitement : `maskPii` remplace la pile

par la constante `[STACK_TRACE]` et ne garde que `name`/`message`/`cause`, ce qui

ne suffit pas à distinguer un `SecurityBlockError` d'un échec de la chaîne LLM.
**Avant `textLength: text.length,`**

⚠️ `textLength`, JAMAIS `text` — symétrique du chemin nominal 200 lignes plus haut,

qui explique pourquoi : le DM au bot est le canal privilégié pour parler d'un

salaire, d'un arrêt maladie ou d'un litige. Le texte figurait ici en clair, en

niveau `error`, et `maskPii` ne le rattrapait pas (`text` n'est pas dans

`PII_KEYS`). Le chemin d'erreur est FRÉQUENT — c'est celui qu'emprunte

l'épuisement du quota Groq —, donc le message le plus sensible finissait dans les

logs au moment précis où le bot allait mal.
**Avant `await progress.fail(userFacingFailure(error));`**

`fail()` ne lève jamais : il est déjà sur le chemin d'erreur, et y remplacer une

exception par une autre effacerait la cause d'origine.
**Avant `private async enforceAuthorization(ctx: {`**

La frontière d'autorisation : évalue, refuse, journalise l'audit.

Rend `'denied'` quand elle a déjà répondu à la personne — l'appelant n'a plus qu'à
s'arrêter. Sinon rend le niveau, que le pipeline transmet aux tools par le
`requestContext`.

⚠️ Elle vient APRÈS les huit court-circuits, et cette position est un choix : détresse,
effacement, épinglage et demande de formulaire sont des DROITS, pas des privilèges de
niveau `full`. Quelqu'un qui va mal ne doit pas se heurter à une politique d'accès.

**Avant `await this.slack.chat.postMessage({`**

Muet sur la règle touchée, exactement comme `NEUTRAL_REFUSAL` : nommer ce qui a porté

renseignerait un attaquant sur la sonde qui a fonctionné.
**Avant `private async buildMessageContext(event: SlackMessageEvent): Promise<MessageContext | null> {`**

Tout ce qu'il faut savoir sur un message avant de décider quoi en faire.

Rend `null` quand il n'y a rien à faire — message du bot, canal absent, ou fil de canal
où le bot n'a jamais parlé. L'appelant s'arrête, sans avoir à savoir pourquoi.

⚠️ L'ORDRE des trois dernières lignes est justifié par un incident et ne doit pas être
réarrangé : l'historique est lu AVANT que le marqueur de progression n'existe, parce
qu'un fil non engagé est abandonné ici même — poster « Je regarde ça… » pour l'effacer
aussitôt laisserait un message orphelin dans le fil.

**Avant `if (event.bot_id || event.subtype === 'bot_message') {`**

Garde défensive : `handleMessage` peut être appelé directement.

**Avant `const botUserId = await this.getBotUserId();`**

La promesse est déjà résolue sur ce chemin (`processEvent` l'a attendue), donc gratuit.

**Avant `const conversationId = deriveConversationId({ channel, threadTs });`**

Clé du fil. En DM `threadTs` est `undefined` par conception (voir plus haut), donc

la conversation EST le canal ; en canal, c'est le thread.
**Avant `const requesterIdentity = this.resolveRequesterIdentity(user);`**

Lancée SANS `await` : la résolution de l'identité se recouvre avec la lecture de la

mémoire au lieu de s'y ajouter. Elle ne rejette jamais (cf. `resolveRequesterIdentity`).
**Avant `private async runStaticReply(ctx: {`**

Les cinq court-circuits STATIQUES : un prédicat pur, une réponse écrite en dur, zéro token.

Extrait de `handleMessage` le 2026-08-19 — non par goût du découpage, mais parce que la
garde `hasPendingOnboardingQuestion` ajoutée le même jour a porté la complexité cognitive
de la fonction au-dessus du seuil, et que le lint de ce dépôt est à zéro warning depuis le
2026-08-18. Le corps est déplacé À L'IDENTIQUE.

Rend `true` quand la réponse a été servie et que `handleMessage` doit s'arrêter là.

**Avant `if (staticReply.remembersTurn && !hasPendingOnboardingQuestion(history)) {`**

Seule la salutation entre en mémoire : sans elle, un fil ouvert par « bonjour » ne

serait jamais « engagé » et `shouldAbandonThreadReply` écarterait le message

SUIVANT. Voir `remembersTurn` dans la table.

⚠️ SAUF QUAND UNE QUESTION D'ACCUEIL ATTEND — correctif du 2026-08-19, second volet.

Le premier volet a fait céder le pas aux court-circuits AGISSANTS ; le groupe

STATIQUE, qui tourne AVANT `maybeAdvanceOnboarding`, n'avait pas été traité. L'état

des deux machines EST le dernier tour `assistant` du fil : mémoriser ici l'écrase

définitivement, et la question en attente devient invisible.

Deux dégâts d'un seul geste, et le second est le pire : le tour `user` — « Salut » —

serait apparié par `collectProfileAnswers` à la question en attente, donc enregistré

comme PRÉNOM, puis imprimé dans un document au nom de la personne. C'est la faute

exacte déjà corrigée pour l'entretien (« oublie ce que je t'ai dit » devenu une

description de métier), par l'autre porte.

⚠️ ON NE TOUCHE PAS À L'ORDRE, et surtout pas pour la DÉTRESSE. L'asymétrie commande :

un faux positif donne un numéro d'aide à quelqu'un qui parlait de son métier — gênant ;

un faux négatif enregistre « je ne vais pas bien » comme un nom de famille et n'aide

personne — dangereux. La réponse figée est servie ; c'est la MÉMOIRE qu'on retient,

pour que le fil reste exactement où il était.
**Avant `private async resolvePendingEmail(input: {`**

LE « OUI » CONVERSATIONNEL — ce qui a remplacé le bouton « Envoyer »

L'invitation d'entretien est le SEUL acte irréversible de ce produit : un email part vers
une adresse extérieure, au nom de l'entreprise. Il était confirmé par un bouton ; il l'est
désormais par une phrase, pour la raison mesurée le 2026-08-19 sur les modales — un clic
dépend d'une fonction chaude, une phrase ne dépend de rien.

⚠️ LA QUESTION D'ACCUEIL PRIME, et l'asymétrie commande. Si une question de profil ou
d'entretien attend, « oui » lui est destiné bien plus probablement qu'à l'email — et les
deux erreurs ne se valent pas : capturer « oui » comme un prénom se corrige d'un message,
envoyer une invitation à un candidat ne se corrige pas. On DIFFÈRE donc, en rappelant.

Rend `handled: true` quand la réponse a été servie ; sinon un `reminder` éventuel, que
`runAgentPipeline` accole à la réponse de l'agent. Le rappel ne bloque RIEN : la personne
change de sujet, on lui répond, et l'email reste en attente — c'est littéralement ce qui
était demandé.

**Avant `if (!repo || !send) return { handled: false };`**

Les deux ou rien : un dépôt sans expéditeur ferait exister une attente que rien ne peut

jamais trancher, c'est-à-dire une promesse en creux de plus.
**Avant `logger.error('Email d’entretien en attente illisible', { error: String(error) });`**

Dégradation silencieuse, comme la mémoire : sans cette lecture le « oui » repart chez

l'agent, qui ne peut rien envoyer. Rien de faux n'est dit, seule la commodité manque.
**Avant `if (verdict === 'stale') {`**

── ABANDONNÉE ──────────────────────────────────────────────────────────

Sans cette borne, une préparation ne meurt jamais : la ligne reste sur la Turso — une

adresse de NON-SALARIÉ, donc une donnée personnelle sans chemin d'effacement — et le

rappel s'accole à CHAQUE réponse d'agent, indéfiniment. Le bruit qui s'ignore, c'est-à-

dire exactement ce que le rappel existe pour éviter.

⚠️ On le DIT au lieu d'effacer en silence : la personne a vu un email complet et une

question ; le retirer sans un mot la laisserait croire qu'il est peut-être parti.
**Avant `const reply = cancellationReply(cleared);`**

⚠️ Trois issues distinctes, et on ne les confond pas : effacé (1), déjà tranché (0),

échec du dépôt (-1). Dire « c'est annulé » sur un échec rejouerait exactement la

famille `emailSent: false` sous `status: 'success'`.
**Avant `return { handled: false, reminder: pendingReminder(pending) };`**

Ni oui ni non : la personne parle d'autre chose. On ne l'interrompt pas.

**Avant `const shortCircuitInput = {`**

SALUTATION NUE — réponse déterministe, aucun appel LLM

Mesuré en production le 2026-08-12 : « Bonjour » (7 caractères) a déclenché

`["findEmployeeByEmail","getEmployeeProfile","updateOnboardingStatus","getTaskList"]`

en 5 étapes et **13 376 tokens** — 13 % du budget Groq quotidien — dont une

tentative d'ÉCRITURE non demandée sur le dossier de la personne.

Placé APRÈS la garde de fil (on ne répond pas dans un fil où le bot n'a jamais

parlé) et AVANT le marqueur de progression : la réponse est instantanée, donc

« Je regarde ça, un instant… » n'a aucun sens ici.

Les deux tours sont mémorisés comme n'importe quel échange : sans cela, un fil

ouvert par une salutation ne serait jamais « engagé » et le message suivant, sans

mention, serait abandonné par la garde ci-dessus.

COURT-CIRCUITS À RÉPONSE FIGÉE — salutation, pièce jointe, forme, détresse

Les cinq premiers des huit court-circuits partagent exactement la même forme : un

prédicat, un texte écrit en dur, zéro token. Ils sont déclarés dans

`domain/services/deterministic-replies.ts` — voir son en-tête pour la raison, qui

n'est pas cosmétique : `isAnsweredWithoutModel` doit en être le miroir exact, et deux

listes tenues à la main divergent au premier ajout, en silence.

Les trois derniers AGISSENT (effacer, épingler, publier un formulaire) : leur

exécution reste ci-dessous, seul leur prédicat vit dans la table.

`messageTs` ne sert qu'à choisir la FORMULATION : la même personne voit des tournures

différentes d'un message à l'autre, et un message rejoué donne exactement la même

réponse. Voir `shared/reply-variants.ts` — la répétition littérale est ce qui fait

« machine », et la corriger ici coûte zéro token.
**Avant `const pendingEmail = await this.resolvePendingEmail({`**

L'EMAIL D'ENTRETIEN EN ATTENTE — « oui » / « non », et rien d'autre

Placé APRÈS les réponses figées — la détresse et la forme d'un message priment sur

tout, y compris sur un email en attente — et AVANT le parcours d'accueil, dont il

s'efface de lui-même quand une question y attend (voir la méthode).
**Avant `const pendingStep = pendingOnboardingStep(history, isDirectMessage);`**

« J'AI FINI » À L'ÉCRIT — le jumeau du bouton « C'est fait »

⚠️ Ce chemin existe parce qu'un TEXTE le promettait. Le guide d'accueil dit « clique

sur "C'est fait" — ou écris-moi simplement "j'ai fini" » : sans lui, cette phrase était

une promesse creuse, et la personne qui suivait l'instruction écrite voyait son message

partir chez un agent qui n'a aucune idée de ce qu'elle vient d'accomplir.

Il rend exactement le MÊME verdict que le bouton — `verifyProfile` est partagé, pas

réécrit : deux formulations pour la même vérification finiraient par ne plus dire la

même chose, et c'est la divergence que ce dépôt vient de corriger deux fois en un jour.

ZÉRO token. En DM uniquement, comme le formulaire lui-même : le pré-remplissage est

personnel, et la vérification porte sur le dossier de celui qui parle.

ENTRETIEN CONVERSATIONNEL — « Parlons de toi », sans modale et sans modèle

⚠️ La modale a été retirée le 2026-08-19 parce qu'elle NE S'OUVRAIT PAS. Un

`trigger_id` expire 3 secondes après le clic, et le démarrage à froid de cette fonction

a été mesuré à 4,9 s le 2026-08-18, jusqu'à 16 s après une longue inactivité — c'est-à-

dire dans le cas d'un ARRIVANT, qui est par définition le premier à écrire de la

journée. Le bouton échouait donc systématiquement, et son échec était invisible : Slack

affiche une erreur générique, rien n'atteint les logs de ce dépôt.

L'état n'est stocké NULLE PART : il se lit dans le dernier tour `assistant` de

`history`, déjà chargé pour la mémoire conversationnelle. Aucune table, aucune lecture

de plus sur le chemin des 3 secondes — et ZÉRO token, alors qu'un entretien « piloté par

le modèle » coûterait trois allers-retours, soit un sixième du budget quotidien du

workspace pour poser deux questions dont le texte est connu d'avance.

Placé APRÈS les réponses figées (la détresse et la forme d'un message priment sur tout)

et AVANT les court-circuits qui agissent : effacer ses données reste prioritaire sur

répondre à une question d'accueil.

⚠️ RELEVÉ AVANT que l'accueil ne consomme le tour : `maybeAdvanceOnboarding` répond et

remplace le dernier tour `assistant`, donc l'état de la machine à états. Le lire après

rendrait toujours `undefined`, et le rappel ne partirait jamais.
**Avant `employeeId: (await requesterIdentity).employeeId,`**

⚠️ Résolu par le handler AVANT tout appel de modèle, et il ne vient JAMAIS de la

fenêtre du modèle : c'est la même règle que pour `slackEmployeeId` dans le

`requestContext` — on ne décide pas d'une écriture sur une valeur qu'un attaquant

peut écrire.
**Avant `const acting = findActingReply(shortCircuitInput);`**

COURT-CIRCUITS QUI AGISSENT — effacer, épingler, publier le formulaire

⚠️ Le prédicat vient de la TABLE, il n'est plus réécrit ici. Jusqu'au 2026-08-18 ces

trois cas étaient déclarés dans `deterministic-replies.ts` ET ré-évalués à la main

juste en dessous : chaque message payait deux fois ces analyses, et un neuvième

court-circuit ajouté à la table serait resté MUET tant que personne n'aurait écrit son

`if` ici — exactement la divergence que la table existe pour interdire, réintroduite à

mi-chemin de sa propre correction.

L'ORDRE reste celui de la table, et il est justifié cas par cas là-bas : effacer prime

sur retenir, et les trois passent AVANT la frontière d'autorisation — effacer ses

données, corriger ce que le bot sait de soi et remplir son propre dossier sont des

droits, pas des privilèges de niveau `full`.
**Avant `const accessLevel = await this.enforceAuthorization({`**

FRONTIÈRE D'AUTORISATION — l'identité franchit enfin la frontière

Jusqu'ici `event.user` servait au journal et à l'anti-boucle, puis était jeté : une

chaîne `U…` opaque dont le système ne pouvait pas dire si elle désignait la responsable

RH ou un invité mono-canal. Tous les outils à effet de bord étaient donc atteignables

par n'importe qui — y compris un invité externe, qui pouvait faire partir un email

depuis le Gmail de l'entreprise, SPF/DKIM parfaitement alignés.

⚠️ Par défaut le mode est OBSERVATION (`AUTHZ_ENFORCE` absent) : la décision est

calculée et journalisée, rien n'est refusé. C'est délibéré — une politique mal

configurée bloquerait des gens légitimes, et le symptôme (« le bot ne sait plus rien

faire ») ne désignerait pas sa cause. On lit les logs, PUIS on active.
**Avant `if (isDirectMessage && user) {`**

Le canal `D…` est appris ICI et NULLE PART AILLEURS : `conversations.list({types:'im'})`

répond `missing_scope` faute du scope `im:read`. Slack nous le livre gratuitement dans

`event.channel`, et une fois perdu il l'est définitivement — d'où l'écriture

conditionnelle côté repository, qui n'écrase jamais une valeur déjà connue.
**Avant `logger.info('Processing Slack message', { user, channel, textLength: text.length });`**

⚠️ Le TEXTE n'est PAS journalisé, et c'est le même raisonnement que pour `audit_logs`

vingt lignes plus bas : le DM au bot est le canal privilégié pour parler d'un salaire,

d'un arrêt maladie ou d'un litige. Le recopier en clair en niveau `info` l'expose à tout

ce qui lit les logs — plateforme comprise. `maskPii` ne rattrapait rien ici : `text`

n'est pas dans `PII_KEYS`.

Ce qu'on garde est ce qui sert au diagnostic : qui, où, et la TAILLE — c'est elle qui

distingue un message vide d'un pavé, sans en révéler le contenu.
**Avant `status: 'accepted',`**

⚠️ `accepted`, PAS `success` — correctif du 2026-08-19. Cette ligne est écrite avant

le débit du budget, avant l'appel d'agent, avant la publication, et rien ne la met à

jour ensuite : le défaut `?? 'success'` de `writeAuditLog` faisait donc enregistrer

comme réussi un message qui allait échouer. La colonne est INDEXÉE pour qu'un humain

filtre dessus, et les deux autres sites passent bien `'denied'` — c'était un oubli,

pas un arbitrage. On dit ce qu'on a constaté : la demande est entrée.
**Avant `details: { accessLevel: accessLevel ?? 'not_evaluated', isDirectMessage },`**

Le TEXTE n'est jamais enregistré : le DM au bot est le canal privilégié pour parler

d'un salaire ou d'un litige, et une table consultable n'expire pas comme un log.
**Avant `await this.chargeModelBudget(user);`**

⚠️ LE DÉBIT DU BUDGET MODÈLE A LIEU ICI, et pas à l'ACK.

Tout ce qui précède peut encore renoncer sans rien coûter : un fil abandonné, une

salutation, une pièce jointe, une demande d'effacement… Ces chemins ne doivent pas

entamer un quota qui se compte à la JOURNÉE (≈ 19 messages tous canaux confondus).

`accept()` n'a fait que RÉSERVER — vérifier que le message passerait — parce qu'à

l'ACK on ignore encore s'il sera abandonné : l'historique n'est pas lu.

Placé AVANT `startProgress` à dessein : le marqueur est le premier écrit Slack, et

poster « Je regarde ça… » pour le remplacer aussitôt par un refus de quota serait la

pire des séquences.
**Avant `const progress = await startProgress(this.slack, { channel, threadTs });`**

Marqueur de progression posté IMMÉDIATEMENT, avant tout appel LLM. Un run prend 2 à

17 s (jusqu'à ~21 s quand le back-off du dernier maillon se déclenche), pendant

lesquelles le bot paraissait totalement muet. `startProgress` ne bloque pas : il rend

la main sans attendre l'aller-retour Slack, et la réponse finale REMPLACE le marqueur

— un seul message dans le fil, jamais deux.
**Avant `const chain = planIntentChain(ctx.text, ctx.history.at(-1)?.agentId);`**

⚠️ **DEUX DEMANDES DANS UN MESSAGE, ET LA SECONDE DISPARAISSAIT EN SILENCE — 2026-08-25.**

Le routage choisit UN agent par message. Mesuré sur cinq phrases réelles : deux marchaient
par hasard, deux perdaient la moitié de la demande sans le dire, et la cinquième était la
phrase que la quarantaine interdit.

Le harness découpe donc le message sur les connecteurs et route chaque fragment. ⚠️ **Si tous
les fragments vont au même agent, RIEN ne change** — c'est l'immense majorité des messages, et
ils ne paient pas un token de plus.

⚠️ **CE QUI REND L'ENCHAÎNEMENT SÛR N'EST PAS UNE LISTE NOIRE, C'EST L'INDÉPENDANCE.** Une
première version refusait certains enchaînements d'après la boîte à outils du second agent :
trop strict (« résume ce canal ET RAPPELLE-MOI JEUDI », bénin, s'y faisait refuser) et trop
lâche (une liste se périme au premier outil déplacé). La règle retenue est structurelle — **une
étape ne reçoit jamais la sortie d'une étape précédente** — et il en découle un théorème :

> Aucun contenu ne circule entre les étapes, donc l'ensemble ne porte rien que ses parties ne
> portaient déjà : **l'ensemble est sûr si et seulement si chaque partie l'est.**

⚠️ **ET EN CAS DE CONFUSION, ON DEMANDE AU LIEU D'EXÉCUTER** — recommandation du propriétaire.
Quand la seconde demande RENVOIE à la première (« et envoie *ça* à… »), elle réclame un
transport de contenu qui n'aura pas lieu : l'exécuter produirait « qu'est-ce que je dois
envoyer ? », ce qui se lit comme un bot ayant perdu le fil. La clarification coûte ZÉRO token et
dit la vraie raison. Même chose au-delà de deux demandes.

Verrouillé par `tests/unit/notification/intent-chain.test.ts` (le plan) et
`tests/unit/handlers/intent-chain-execution.test.ts` (l'indépendance, qui ne se vérifie qu'à
l'exécution).

**Avant `pendingEmailReminder: pendingEmail.reminder,`**

⚠️ ACCOLÉ à la réponse de l'agent, jamais posté à part : deux messages feraient

paraître le bot bavard là où il ne fait que ne pas oublier. Et il ne bloque rien —

la personne a changé de sujet, on lui répond d'abord.
**Avant `onboardingReminder: onboardingNudge(pendingStep, event.ts),`**

Même forme, même raison, autre objet : une question d'accueil est restée sans réponse

parce que la personne a parlé d'autre chose. Répondre EFFACE l'état de la machine

(il vit dans le dernier tour `assistant`), donc sans ce rappel l'accueil ne peut pas

reprendre — et personne ne sait pourquoi le dossier n'a jamais été terminé.
**Avant `private logSanitizerVerdicts(`**

Journalise ce que le filtre de sortie a retiré. Aucun effet sur la réponse : elle est
déjà nettoyée quand on arrive ici.

**Avant `logger.error('Agent output carried internal markers — response replaced', {`**

Niveau `error` volontaire : une fuite de marqueur signifie que le modèle a été amené

à parler de son propre garde-fou. C'est la ligne à chercher dans les logs après une

tentative d'extraction de prompt.
**Avant `logger.error('Agent output carried fabricated links — links removed', {`**

Un lien fabriqué n'est PAS une fuite : la réponse reste utile, seul le lien est

retiré. Le niveau `error` est néanmoins volontaire — c'est la ligne qui aurait fait

tomber en minutes le faux `https://kisso.internal/docs/<uuid>/download` du

2026-08-11. Seuls les HÔTES sont journalisés : le chemin d'un lien inventé embarque

un identifiant réel, inutile à déverser dans les logs.
**Avant `private shouldAbandonThreadReply(`**

Second volet de l'ouverture aux fils de canal — le premier est dans `rejectMessage`.

`accept()` a laissé passer une réponse de fil sans pouvoir vérifier qu'elle nous
concerne : c'est le chemin d'ACK, il n'a pas le droit de lire en base (3 secondes). On
tranche donc ici, en tâche de fond : **le bot ne prend la parole que dans un fil où il a
DÉJÀ répondu.**

Sans cette garde, chaque phrase échangée entre humains dans un fil de #kisso-hq
deviendrait un run LLM — le quota Groq est de ≈ 19 messages par JOUR. Le TTL de la
mémoire (60 min) borne l'engagement par-dessus : un fil retombé dans le silence
redemande une mention explicite.

Dégradation assumée : mémoire indisponible → historique vide → abandon. C'est le sens le
moins coûteux, et le seul honnête — sans mémoire, le bot n'a de toute façon aucun
contexte à continuer. Un `app_mention` n'est jamais concerné : la mention EST le mandat.

**Avant `if (botUserId && (event.text ?? '').includes(`<@${botUserId}>`)) return false;`**

⚠️ Le JUMEAU `message` d'une mention en canal doit rester traité.

Une mention émet à la fois `app_mention` et `message`, et les deux partagent

`channel:ts` — donc UNE SEULE clé de déduplication. Avant l'ouverture aux fils, le

jumeau était écarté par `rejectMessage`, avant toute prise de clé ; il peut désormais

la prendre le premier. L'abandonner ici ferait ensuite écarter l'`app_mention` comme

doublon, et la mention resterait SANS RÉPONSE — une régression pire que le défaut

qu'on corrige. Un message qui mentionne le bot porte son propre mandat, fil engagé

ou non.
**Avant `return !history.some((turn) => turn.role === 'user' && turn.slackUserId === event.user);`**

⚠️ « Le bot a déjà parlé ici » ne suffit PAS — relevé par l'audit du 2026-08-13.

La garde ci-dessus ouvre le fil, elle ne dit rien de QUI parle. Dans un fil où le bot

a répondu une fois, il traitait donc les messages de TOUTES les autres personnes, sans

mention, y compris ceux qui ne lui étaient pas adressés. Deux conséquences, la

première grave :

 1. **Un tiers héritait de la mémoire du fil.** C'est un bot RH : cet historique porte

    le profil, les tâches et le parcours d'intégration de QUELQU'UN D'AUTRE. Deux

    collègues qui commentent une réponse entre eux se voyaient répondre avec le

    dossier de la personne qui avait ouvert le fil.

 2. Chaque phrase échangée entre humains consommait un run, sur ≈ 19 messages/jour.

On exige donc que l'auteur ait DÉJÀ parlé au bot dans ce fil. `slackUserId` est

stocké sur chaque tour `user` par `rememberTurn` — la donnée était là, personne ne la

lisait. Un tiers reste libre de s'adresser au bot : il lui suffit de le mentionner,

ce que la garde précédente laisse passer. C'est le mandat explicite, et il est le bon

critère pour quelqu'un dont on n'a jamais eu de message.
**Avant `private tryGetAgent(agentId: string) {`**

Résout un agent du registre Mastra, ou `undefined`.

`mastra.getAgent()` LÈVE (`MASTRA_GET_AGENT_BY_NAME_NOT_FOUND`) au lieu de rendre
`undefined` : l'ancien `if (!agent)` posé sur son résultat était donc du code MORT, et
un identifiant erroné retombait sur le « Désolé, une erreur s'est produite » générique
du catch — un piège de diagnostic actif. On rattrape l'exception ici.

La garde `!agent` est conservée en aval malgré tout : c'est une double sécurité contre
un changement de contrat de Mastra, dans les deux sens.

**Avant `private async maybeAdvanceOnboarding(input: {`**

 ----------------------------------------------------------------------- *
Mémoire conversationnelle

Historique récent du fil. **N'échoue jamais vers l'appelant** : une mémoire
indisponible doit dégrader le bot vers son comportement d'avant — amnésique mais
fonctionnel — et surtout pas le rendre muet. C'est notamment le cas tant que la table
`conversation_turns` n'a pas été appliquée sur la base de production.

Le PARCOURS D'ACCUEIL, en un seul point d'entrée.

Deux étapes conversationnelles s'y enchaînent, et elles sont ici plutôt que dans
`handleMessage` pour deux raisons. La première est prosaïque — chacune ajoutait une
branche au tronc commun, qui repassait au-dessus du plafond de complexité que ce dépôt
tient à zéro warning. La seconde vaut mieux : ce sont les deux moments d'un même
parcours, et les voir côte à côte rend leur ORDRE lisible.

⚠️ Et l'ordre porte un cas réel. « C'est fait » doit être reconnu AVANT l'entretien :
quand le dossier est complet, la réponse à cette annonce CONTIENT la première question
de l'entretien. Inverser reviendrait à traiter l'annonce comme une réponse à une
question qui n'a pas encore été posée.
**Avant `private async maybeRunProfileStep(input: {`**

La personne est-elle en train de compléter son dossier, et si oui, faire avancer.

⚠️ AVANT l'entretien, et l'ordre n'est pas arbitraire : les deux machines lisent le même
endroit — le dernier tour `assistant` du fil — et un dossier se remplit avant qu'on
demande à quelqu'un comment il aime travailler. Les questions étant des constantes
distinctes, les deux prédicats ne peuvent pas reconnaître le même texte.

⚠️ DM UNIQUEMENT, comme tout ce parcours. En canal, le dernier tour `assistant` peut être
une question posée à quelqu'un d'AUTRE, et la réponse d'un témoin s'écrirait dans le
dossier de cette personne — la même asymétrie de sécurité que `profile-request.ts`.

**Avant `if (!answersOnboardingQuestion(input)) return false;`**

⚠️ Les TROIS gardes communes aux deux machines vivent dans `answersOnboardingQuestion`

depuis le 2026-08-20 : DM, court-circuit agissant prioritaire, question posée au bot.

Elles y sont parce qu'un TROISIÈME lecteur en a besoin — le miroir exact du

rationnement — et qu'une copie de plus est la configuration où ce dépôt a déjà payé.
**Avant `private async runProfileStep(input: {`**

Un pas de la complétion de dossier. ZÉRO appel de modèle.

Trois issues, et une seule écrit en base :
  • réponse inexploitable → on relance la MÊME question, en nommant ce qui cloche ;
  • champ suivant manquant → on pose la question suivante ;
  • dossier complet → on lance le workflow d'intégration, qui enchaîne sur l'entretien.

⚠️ L'état se reconstitue du FIL, jamais d'une table : `collectProfileAnswers` apparie les
questions déjà posées avec les réponses données. Le dossier existant sert de socle — donc
quelqu'un à qui il ne manque que le poste ne se voit demander que le poste.

**Avant `private async knownProfileAnswers(user: string | undefined): Promise<ProfileAnswers> {`**

Ce que le dossier existant renseigne déjà — le socle de la conversation.

⚠️ La résolution passe par l'ANNUAIRE puis par l'email, jamais par le texte du message :
c'est la même règle que pour `slackEmployeeId` dans le `requestContext`. On ne décide pas
d'une écriture sur une valeur que la personne peut écrire elle-même.

**Avant `logger.warn('Dossier existant illisible — la conversation repart de zéro', {`**

Un socle illisible ne casse rien : on redemande tout, ce qui est plus long mais juste.

**Avant `private async submitProfile(`**

Le dossier est complet : on l'enregistre par le MÊME workflow que la modale.

⚠️ `runOnboarding` est partagé (`onboarding/application/services/`) et n'est pas réécrit
ici. Deux écrivains pour un même geste, c'est la configuration où ce dépôt a déjà payé :
deux chemins vers le formulaire de profil avaient divergé en un jour, et celui qu'on
exerçait le moins était le cassé.

⚠️ La date de début n'est pas demandée. `startDateFromJoin` retombe sur le jour même —
une question de plus pour une donnée qu'aucun mécanisme n'exploite serait un tour de
dialogue payé pour rien, sur un budget qui se compte à la journée.

**Avant `onRecordReady: async (employeeId) => {`**

⚠️ RELIER D'ABORD, DEMANDER ENSUITE — l'ordre EST le correctif du 2026-08-19.

La question de l'entretien invite la personne à répondre ; sa réponse arrive au

tour SUIVANT, avec une identité relue de l'annuaire. Poser la question avant

d'avoir relié rejouerait le défaut un tour plus tard.
**Avant `void this.warnManagersOfTopRoleClaim(input.user, answers.position);`**

⚠️ NON ATTENDU, et journalisé sur échec : prévenir le manager est une COURTOISIE

envers un tiers, pas une étape du parcours de l'arrivant. La faire attendre —

ou pire, la laisser échouer — retarderait la question suivante d'un aller-retour

Slack pour un message qui ne le concerne pas.
**Avant `startDateFromJoin(await this.joinedAtOf(input.user), new Date()),`**

⚠️ LA DATE D'ARRIVÉE VIENT DE L'ANNUAIRE, plus d'un bouton — 2026-08-19.

Elle voyageait dans le `value` du bouton (`joinedAt`), posé par `handleTeamJoin`.

Les boutons ayant été retirés, ce chemin passait `undefined`, et `startDateFromJoin`

retombait sur AUJOURD'HUI pour tout le monde — y compris pour quelqu'un présent

depuis six mois.

`slack_directory.first_seen_at` porte exactement la même information : `upsertFacts`

la pose au `team_join`, et c'est plus robuste qu'un aller-retour par un `value`

Slack — la donnée ne quitte jamais le serveur, donc rien ne peut la falsifier ni la

perdre en route. Absente, on retombe sur aujourd'hui, comme avant.
**Avant `private async warnManagersOfTopRoleClaim(`**

Quelqu'un vient de se déclarer au SOMMET — le dire au sommet.

Ce que ce chemin ne fait PAS

Il n'accorde rien, ne refuse rien, ne bloque rien. Un intitulé de poste est DÉCLARATIF —
la personne le tape elle-même — et le seul fait qui ouvre la portée est
`slack_directory.role`, écrit hors du produit. Ce chemin produit un SIGNAL adressé à un
humain : « es-tu au courant, approuves-tu ? »

C'est aussi pour cela qu'un faux positif est sans gravité (un DM lu en trois secondes) et
qu'un faux négatif l'est davantage (une déclaration au sommet passée inaperçue).

⚠️ ON N'ÉCRIT PAS À QUELQU'UN AU SUJET DE LUI-MÊME. Le manager qui refait son propre
dossier recevrait sinon un message lui demandant s'il s'approuve.

⚠️ AUCUN MANAGER DÉSIGNÉ ⇒ on le journalise en `warn` plutôt que de se taire. C'est un
état réel — la colonne naît vide — et c'est exactement le moment où quelqu'un aurait dû
être prévenu. Un silence ici serait indiscernable d'un envoi réussi.

ZÉRO token : prédicat pur et texte écrit en dur, aucun modèle sur ce chemin.

**Avant `newcomerName: identity.displayName ?? slackUserId,`**

Le nom résolu, jamais celui que la personne vient de taper : c'est l'annuaire qui

dit qui elle est, et le destinataire du message la connaît sous ce nom-là.
**Avant `await this.slack.chat.postMessage({ channel: manager.slackUserId, text: notice });`**

`chat.postMessage` sur un `U…` ouvre le DM : le canal `D…` de l'annuaire n'est

connu que si la personne a déjà écrit au bot, et un manager qui ne lui a jamais

parlé est précisément celui qu'il faut pouvoir joindre.
**Avant `logger.error('Impossible de prévenir le manager d’une déclaration de poste', {`**

AVALÉ : l'arrivant vient d'enregistrer son dossier et attend la question suivante.

Lui montrer l'échec d'un message qui ne lui était pas destiné n'a aucun sens, et

faire échouer son parcours pour cela en aurait encore moins.
**Avant `private async linkRequesterToRecord(`**

Rattache la ligne d'annuaire au dossier qui vient d'être créé.

## Le défaut que ceci ferme, et pourquoi il était invisible

`slack_directory.employee_id` n'était écrite par AUCUN chemin de production. Son unique
écrivain est `linkEmployee` ; son unique appelant est `directory-sync.service.ts`, dont
l'unique point d'entrée est le script manuel `scripts/sync-slack-directory.mts` — qui, en
dry-run (le défaut), le remplace par un no-op.

Or c'est de cette colonne que vient l'`employeeId` du demandeur, par
`resolveRequesterIdentity`. Deux conséquences, toutes deux mesurées :

  1. `persistInterviewAnswer` sortait en silence, donc l'entretien répondait « Noté. »
     puis « j'y mettrai ce que tu viens de me dire » sans rien enregistrer. La personne
     demandait son guide et recevait le gabarit générique.
  2. `canReadPersonRecord` accorde « son propre dossier, toujours » sur ce même champ :
     poser `AUTHZ_ENFORCE` aurait coupé chacun de SON PROPRE dossier.

⚠️ Le test de production du 2026-08-19 n'a rien vu : la ligne d'annuaire de la personne
qui testait avait été reliée par une exécution passée du script. La feature fonctionnait
exactement pour les gens reliés à la main — c'est-à-dire pour son testeur.

⚠️ ON INVALIDE LE CACHE, et ce n'est pas une précaution de style. `requesterNames` est un
LRU de 12 h qui mémorise l'identité COMPLÈTE, `employeeId` inclus. Sans cette ligne, le
tour suivant relirait l'entrée périmée — donc `employeeId: null` — et le défaut se
rejouerait à l'identique, un tour plus tard, avec la base pourtant correcte.

⚠️ Un échec est journalisé et AVALÉ : la personne vient de faire enregistrer son dossier,
lui montrer une erreur après coup lui ferait croire que rien n'a abouti. Le geste de
rattrapage est humain (`npm run directory:sync -- --apply`) et le log est ce qui le
déclenche.

**Avant `if (linked === 0) {`**

⚠️ ON NE L'ANNONCE QUE SI UNE LIGNE A BOUGÉ — trouvé EN PRODUCTION le 2026-08-19, en

testant ce correctif le jour même où il a été écrit. `linkEmployee` est un

`UPDATE … WHERE slack_user_id = ?` : sans ligne correspondante, l'ordre réussit et

n'affecte rien. La version précédente journalisait « Annuaire relié au dossier » dans

ce cas — c'est-à-dire exactement la famille de défaut que ce correctif venait fermer,

reproduite par le correctif lui-même.

Relevé au même moment : `slack_directory` compte 41 lignes dont UNE SEULE porte un

`employee_id`. Le cas « pas de ligne » n'est donc pas théorique, c'est le cas courant

pour qui n'est jamais passé ni par `team_join` ni par la synchronisation manuelle.
**Avant `private async joinedAtOf(slackUserId: string | undefined): Promise<string | undefined> {`**

La date de première apparition dans le workspace, telle que l'annuaire l'a enregistrée.

Rend `undefined` — jamais une date fabriquée — quand on ne sait pas : c'est ce qui permet
à `buildWelcomeEmail` de faire disparaître sa phrase plutôt que d'annoncer une arrivée.

**Avant `private async sayAndRemember(`**

Poste un texte ET l'inscrit dans la mémoire du fil.

⚠️ LES DEUX SONT INDISSOCIABLES : l'état des deux machines à états EST le dernier tour
`assistant`. Une question posée sans être mémorisée est invisible au tour suivant, donc la
réponse de la personne part chez un agent — la faute exacte mesurée le 2026-08-19, dont le
symptôme trompe puisque la question s'affiche parfaitement.

**Avant `private async maybeCheckProfileDone(input: {`**

La personne annonce-t-elle avoir fini, et si oui, vérifier.

Rend `true` quand elle a répondu. Extraite de `handleMessage` pour la ramener sous le
plafond de complexité — et l'extraction dit quelque chose de juste : la CONDITION
d'entrée dans une étape appartient à l'étape, pas au tronc commun du handler.

⚠️ DM UNIQUEMENT, comme le formulaire lui-même. La vérification porte sur le dossier de
CELUI QUI PARLE ; en canal, la réponse exposerait à des témoins ce qui manque au dossier
de quelqu'un d'autre. Même asymétrie que `profile-request.ts`, où la restriction au DM
est de la sécurité et non de l'ergonomie.

**Avant `const acting = findActingReply({ text: input.text, isDirectMessage: input.isDirectMessage });`**

⚠️ Le prédicat vient de la TABLE, il n'est pas réécrit ici — même règle que pour les

trois autres court-circuits agissants depuis le 2026-08-18. C'est ce qui garantit que

`isAnsweredWithoutModel` en soit le miroir exact : une seule déclaration, donc aucune

divergence possible entre ce qui est exécuté et ce qui est facturé.
**Avant `private async runProfileDoneCheck(input: {`**

Vérifie le dossier de celui qui dit avoir fini, et lui répond.

⚠️ La résolution se fait par EMAIL — la seule clé que `employees` partage avec l'annuaire
Slack, cette table n'ayant aucune colonne d'identifiant Slack. Sans email résolvable, on
traite comme « aucun dossier » : c'est exact, on n'a effectivement rien pu constater.

⚠️ Un échec de lecture ne devient JAMAIS « ton dossier est incomplet ». Une base
indisponible est notre défaut, pas le sien, et le lui imputer l'enverrait corriger un
formulaire qui n'a rien à corriger.

**Avant `const member = user ? await this.getDirectoryRepo()?.findBySlackUserId(user) : null;`**

L'email vient de l'ANNUAIRE Slack, jamais du texte du message : c'est la même règle

que pour `slackEmployeeId` dans le `requestContext` — on ne décide pas d'une lecture

de dossier sur une valeur que la personne peut écrire elle-même.
**Avant `await this.rememberTurn({`**

⚠️ Mémorisés tous les deux, et c'est INDISPENSABLE : quand le dossier est complet, la

réponse CONTIENT la première question de l'entretien, et l'état de cette machine est

précisément le dernier tour `assistant`. Ne pas mémoriser ici ferait perdre le fil au

message suivant — la faute exacte corrigée côté route quelques heures plus tôt.
**Avant `private async maybeRunInterviewStep(input: {`**

L'entretien est-il en cours, et si oui, le faire avancer.

Rend `true` quand il a répondu — l'appelant s'arrête là. Extraite de `handleMessage` pour
la ramener sous le plafond de complexité (ce dépôt tient son lint à ZÉRO warning), et
l'extraction dit aussi quelque chose de juste : la CONDITION d'entrée dans l'entretien
appartient à l'entretien, pas au tronc commun du handler.

⚠️ DM UNIQUEMENT. En canal, le dernier tour `assistant` du fil peut être une question
d'entretien posée à quelqu'un d'AUTRE : la réponse d'un témoin serait alors capturée comme
la sienne. Même asymétrie que `profile-request.ts`, où la restriction au DM est de la
SÉCURITÉ et non de l'ergonomie.

**Avant `if (!answersOnboardingQuestion(input)) return false;`**

Mêmes trois gardes que le pas de dossier, et pour les mêmes raisons — voir

`answersOnboardingQuestion`, qui les porte une seule fois.
**Avant `private async runInterviewStep(input: {`**

Un pas de l'entretien conversationnel. ZÉRO appel de modèle, ZÉRO lecture supplémentaire.

⚠️ Les deux tours sont mémorisés comme n'importe quel échange, et c'est OBLIGATOIRE ici :
l'état de la machine EST le dernier tour `assistant`. Ne pas mémoriser la question
suivante ferait perdre le fil au message d'après, en silence.

⚠️ CE CHEMIN EST DÉSORMAIS LE SEUL ÉCRIVAIN de `onboarding_interview`, et le commentaire
qui figurait ici affirmait l'inverse : « l'écriture vit dans la route d'interactivité,
avec `applyInterview` ». C'était vrai jusqu'au 2026-08-19, quand les modales ont été
retirées — `view_submission` n'est plus jamais émis par Slack. Le commentaire décrivait
donc un partage de responsabilité disparu, à quatre lignes d'un appel à
`persistInterviewAnswer` qui le démentait.

**Avant `const skipped = skipsInterview(text);`**

On reconnaît le renoncement AVANT de juger la réponse trop courte : « non » fait quatre

caractères de moins que le seuil, et le traiter comme une réponse ratée relancerait la

question à quelqu'un qui vient de dire non. Insister est le meilleur moyen de faire

abandonner un questionnaire d'accueil pour de bon.
**Avant `private async persistInterviewAnswer(`**

Persiste la réponse — au mieux, et JAMAIS au prix de la conversation.

⚠️ `save` ÉCRASE (la clé primaire est `employee_id`), donc on relit d'abord pour ne pas
effacer la réponse de l'autre question. C'est le prix d'une table à une ligne par employé,
et il est payé ici plutôt qu'en dupliquant l'état ailleurs.

⚠️ Un échec est journalisé et AVALÉ. La personne vient d'obtenir une réponse cohérente ;
lever ici lui ferait voir « une erreur s'est produite » après un échange qui s'est bien
passé, et c'est le contraire de ce qu'on veut apprendre d'un accueil. La trace manque,
l'accueil tient — même arbitrage que la mémoire conversationnelle, qui dégrade en silence.

**Avant `if (!input.employeeId) {`**

⚠️ CE CAS ÉTAIT MUET, et c'est ce qui a rendu le défaut invisible pendant qu'un test de

production le traversait. Il subsiste après le correctif pour les personnes DÉJÀ

présentes, dont le dossier a été créé avant que la liaison n'existe. Le produit ne peut

pas le réparer seul — le geste est `npm run directory:sync -- --apply` — mais il doit

le DIRE plutôt que de perdre en silence ce que quelqu'un vient d'écrire sur lui-même.
**Avant `private async loadPinnedFacts(slackUserId: string | undefined): Promise<readonly string[]> {`**

 Persiste un tour. Même contrat que `loadHistory` : jamais fatal.

Faits épinglés de la personne. Ne lève JAMAIS.

Même contrat de dégradation que `loadHistory` : la mémoire longue est un CONFORT, pas
une condition de fonctionnement. Une table absente ou une base injoignable rend le bot
oublieux, jamais muet — et c'est cette propriété qui a permis de déployer
`conversation_turns` sans coordination avec le DDL.
**Avant `private buildMessages(`**

Messages transmis au modèle : l'historique fenêtré, puis le message courant.

⚠️ L'historique n'est PAS ré-encadré, et c'est délibéré.
`validateDelimiterIntegrity` rejette toute seconde balise ouvrante, donc
`history.map(wrapAgentInput)` lèverait `SecurityBlockError` sur chaque message. Un
SEUL bloc `<kisso_XXXX_user_input>` existe par appel, porté par le message courant —
c'est exactement ce que les DIRECTIVE 3.1/3.2 annoncent au modèle (« le bloc balisé
ajouté sous ce prompt »). L'historique voyage en messages structurés, où le rôle
porte déjà la distinction système / utilisateur.

Ce qui rend l'absence d'encadrement sûre, c'est le point d'écriture : un tour `user`
n'entre en mémoire qu'après un `wrapAgentInput` réussi, et un tour `assistant`
qu'après `sanitizeAgentOutput`. Rien de bloqué ne peut donc être rejoué.

**Avant `const preamble = buildContextPreamble({`**

Fenêtrage AVANT construction du préambule : l'avertissement d'attribution ne doit être

payé (≈ 35 tokens) que si un tour étranger survit réellement au budget de tokens.

⚠️ `email` et `employeeId` sont transmis TELS QUELS, y compris `null`. C'est

`buildContextPreamble` qui décide de les omettre — un champ absent y est silencieux,

jamais rendu en gabarit à trous. Les filtrer ici dupliquerait cette décision à deux

endroits, et c'est leur ABSENCE de la fenêtre du modèle qui a produit les 38

`findEmployeeByEmail` en échec du 2026-08-12.
**Avant `now: this.now(),`**

⚠️ INJECTÉE ici et non lue dans le domaine : `buildContextPreamble` est du TypeScript

pur, et une fonction qui appellerait `new Date()` ne se testerait qu'en gelant

l'horloge — ce que ce dépôt fait partout ailleurs par injection.
**Avant `const replayed = window.map((turn) =>`**

La ternaire produit une union de types LITTÉRAUX (`{role:'user'}` | `{role:'assistant'}`)

là où un `{ role: turn.role }` produirait `role: 'user' | 'assistant'` sur un seul

objet — non assignable à `MessageListInput`, qui attend un membre discriminé.
**Avant `content:`**

ARBITRAGE — on garde le tour d'un autre agent, mais on le DÉSIGNE.

Filtrer l'historique par `agentId` était la correction évidente ; elle perdrait

le contexte utile, qui est précisément ce qu'un fil mixte transporte : l'UUID

rendu par l'orchestrateur est la donnée dont `notificationAgent` a besoin, et

c'est un tour `assistant`. On ne coupe donc rien. Ce qu'on retire, c'est la

MÉPRISE : sans marque, un agent lit la voix d'un autre comme la sienne — en C7

l'orchestrateur a repris le motif de `notificationAgent` (redemander sujet,

texte, canal) pour cette seule raison. Coût : ≈ 4 tokens par tour étranger,

zéro sur un fil homogène (le cas courant).
**Avant `({ role: 'user', content: turn.content } as const),`**

Un tour `user` n'est jamais préfixé : ce que la personne a dit reste ce qu'elle a

dit, quel que soit l'agent qui l'a reçu.
**Avant `const preambleMessages = preamble ? [{ role: 'system', content: preamble } as const] : [];`**

Le préambule serveur ouvre la liste. Mastra le route vers `addSystem()` et le place

avant tous les messages de modèle, à côté des instructions de l'agent — donc HORS du

bloc `<kisso_XXXX_user_input>`, que la DIRECTIVE 3.1 déclare non fiable.
**Avant `private pruneIsDue(): boolean {`**

Purge de rétention, en tâche de fond. Déclenchée par tirage — voir
`DEFAULT_PRUNE_PROBABILITY` : un compteur d'instance ne survit pas au gel de la fonction
serverless, et ne se déclenchait donc jamais.

Tirage sans état — c'est la propriété qui compte. Un compteur d'instance repart à zéro
à chaque démarrage à froid ; une probabilité, non.
**Avant `return Math.random() < this.pruneProbability;`**

Échantillonnage d'une purge de maintenance : aucune décision de sécurité n'en dépend.

Le tirage SANS ÉTAT remplace un compteur en mémoire PAR INSTANCE, remis à zéro à chaque

démarrage à froid et dont le seuil de 100 n'était donc jamais atteint à ≈ 19 messages

par jour : les lignes restaient sur la Turso sans borne réelle.
**Avant `private readSteps(response: unknown): number | null {`**

 ----------------------------------------------------------------------- *
Lecture défensive du résultat d'agent (observabilité)

Ces trois lecteurs sont volontairement tolérants : la forme exacte du résultat varie
selon la version de Mastra, et l'observabilité ne doit JAMAIS faire échouer une
réponse déjà produite. Un champ absent vaut `null`, jamais une exception.
**Avant `private readInputTokens(response: unknown): number | null {`**

 ⚠️ `inputTokens` CUMULE toutes les étapes : ne comparer deux mesures qu'à `steps` égal.

**Avant `private noAccessGuardLogged = false;`**

Décide ce que le demandeur a le droit de déclencher.

Rend `undefined` quand la question ne se pose pas (pas d'auteur, annuaire désactivé) : ce
n'est PAS une autorisation, c'est une non-évaluation — et `canPerformSideEffects` la traite
comme le chemin historique. Confondre les deux ferait qu'une panne d'annuaire ouvrirait ou
fermerait le produit selon l'humeur du code appelant.

NE LÈVE JAMAIS : `SlackAccessGuard.evaluate` avale déjà ses propres échecs, et un annuaire
indisponible rend `unknown_actor`, donc `readonly` — la réponse monotone restrictive.

 Un avertissement de câblage pour la vie de l'instance, jamais un par message.
**Avant `this.warnNoAccessGuardOnce();`**

⚠️ ÉTAIT MUET jusqu'au 2026-08-20, et c'était le chemin le PLUS probable des deux :

le garde est absent dès que `directoryRepository` n'est pas câblé. La conséquence

n'est plus « tout le monde en `full` » depuis que `mayTouchRecord` refuse une

non-décision — c'est désormais l'inverse, plus personne ne lit le dossier d'autrui.

Dans les deux sens, un tel état doit se voir : il ne se déduit d'aucun symptôme, et

« le bot ne sait plus rien faire » ne désignerait pas sa cause.
**Avant `export { FILE_ATTACHMENT_REPLY };`**

Réexports de compatibilité : `slack-interactions.route.ts` et trois tests importent

ces symboles depuis ce module depuis l'origine. Les faire pointer ailleurs serait

une modification de plus dans un même commit, sans rien apporter.

Réexport : deux tests importent `FILE_ATTACHMENT_REPLY` depuis ce module.
**Avant `export { GENERIC_FAILURE, QUOTA_FAILURE, userFacingFailure };`**

Réexports de la politique d'échec — le test du handler les importe depuis ici.

**Avant `export { FOREIGN_TURN_PREFIX, buildContextPreamble, sanitizeDisplayName };`**

Réexports du préambule d'identité — quatre tests les importent depuis ici.

**Avant `export {`**

Réexports de la réconciliation FAIT/NARRATION — trois tests les importent depuis ici.

**Avant `PROMISED_DELIVERY_NOTICE,`**

⚠️ RÉEXPORTÉE le 2026-08-20 : elle est désormais accolée sur une condition de CÂBLAGE et

non de texte, donc le seul endroit où ce comportement se vérifie est le handler.
**Avant `function appendNotes(notes: readonly (string | undefined)[]): string {`**

Texte du dernier tour `assistant` du fil, ou `undefined`.

C'est le SUPPORT D'ÉTAT de l'entretien conversationnel : on y reconnaît la question que le
bot vient de poser. Fonction libre et non méthode — elle ne lit pas `this`, et la déclarer
ici la rend éprouvable sans construire un handler entier (ce qui, dans ce dépôt, exige de
neutraliser quatre dépendances qui touchent la base).

Une question du parcours d'accueil attend-elle une réponse dans ce fil ?

⚠️ Dérivé des DEUX machines à états, jamais d'une liste recopiée : ajouter une question à
`profile-chat` ou à `interview-chat` suffit à la couvrir ici. Une troisième copie des
marqueurs serait la configuration où ce dépôt a déjà payé — deux bords corrects, aucun
câblage entre les deux.

Ce message est-il une RÉPONSE à une question du parcours d'accueil ?

Les trois gardes, et pourquoi elles vivent ici plutôt qu'en double

 1. **DM uniquement.** En canal, le dernier tour `assistant` du fil peut être une question
    posée à quelqu'un d'AUTRE : la réponse d'un témoin s'écrirait dans le dossier de cette
    personne. Même asymétrie de SÉCURITÉ que `profile-request.ts`.
 2. **Les court-circuits agissants priment.** `captureInterviewAnswer` accepte presque
    n'importe quel texte — c'est sa nature, on demande à quelqu'un de décrire son métier
    avec ses mots. Une question en attente absorbait donc « oublie ce que je t'ai dit » :
    l'effacement n'avait pas lieu, ET la phrase était enregistrée comme la description du
    métier de la personne, champ imprimé dans un document à son nom.
 3. **Une question posée au bot n'est pas une réponse** — trouvé EN PRODUCTION le
    2026-08-19. « qui s'occupe du support technique ? » était capturé comme la description
    du métier de la personne, puis restitué à ses collègues par `findExpertise`. Le critère
    est GRAMMATICAL, jamais une liste de mots : voir `isQuestionToBot`.

⚠️ Extraite le 2026-08-20 parce qu'un TROISIÈME lecteur en a besoin : le miroir exact du
rationnement, qui doit savoir si un message sera traité SANS appel de modèle avant de le
refuser pour cause de quota. Les trois gardes étaient déjà écrites DEUX fois, à l'identique,
dans les deux machines à états ; une troisième copie aurait garanti la divergence, et son
symptôme aurait été muet — quelqu'un qui répond à une question d'accueil et reçoit « quota
atteint », c'est-à-dire l'accueil bloqué par le garde-fou censé protéger l'accueil.

Quelle question d'accueil attend une réponse dans ce fil, s'il y en a une ?

⚠️ DM uniquement, même raison qu'`answersOnboardingQuestion` : en canal, le dernier tour
`assistant` peut être une question posée à quelqu'un d'AUTRE, et le rappel s'adresserait au
mauvais témoin.

⚠️ Dérivé des DEUX machines à états, jamais d'une liste recopiée. L'ordre reprend celui de
`maybeAdvanceOnboarding` : le dossier avant l'entretien.

Accole les notes non vides, séparées d'une ligne blanche.

⚠️ Fonction plutôt que trois ternaires en ligne, et pas seulement pour le plafond de
complexité : chaque note ajoutée au fil des mois rallongeait la même expression, et une
chaîne de ternaires est exactement l'endroit où l'on finit par oublier un `\n\n` ou par
intervertir deux notes sans que rien ne le signale.

Rend `''` quand tout est vide : accoler une chaîne vide laisserait deux sauts de ligne en
fin de message, trace visible d'un mécanisme qui ne s'est pas déclenché.
**Avant `export function interviewReplyFor(step: InterviewStep, text: string, skipped: boolean): string {`**

Ce qu'on répond à un pas d'entretien. PURE, et hors de la classe à dessein : elle ne lit
pas `this`, elle s'éprouve sans construire un handler (ce qui, dans ce dépôt, exige de
neutraliser quatre dépendances qui touchent la base), et l'extraire ramène `runInterviewStep`
sous le plafond de complexité que ce dépôt tient à zéro warning.

⚠️ Le renoncement est jugé AVANT la longueur : « non » fait moins que le seuil, et le
traiter comme une réponse ratée relancerait la question à quelqu'un qui vient de dire non.

**Avant `export function interviewDoneReply(workStyle: string): string {`**

Fin de l'entretien.

⚠️ Elle ne PROMET rien. Le texte ne dit ni « je t'ai ajouté aux canaux » ni « ton guide
arrive » : ce chemin ne fait ni l'un ni l'autre. C'est la règle la plus constante de ce
dépôt — l'email de bienvenue a perdu « vous recevrez prochainement les accès », et
`scheduleReminder` a cessé de dire « planifié ». Ce qui est vrai ici, c'est qu'on a écouté.

## `features/notification/infrastructure/providers/brevo.adapter.ts`

**Avant `export class BrevoAdapter implements EmailProvider {`**

Adaptateur email Brevo — chemin de REPLI, mort en pratique.

`createEmailProvider()` ne le retient que si la configuration SMTP est
incomplète. Et même alors il n'enverra rien : la clé est valide
(`GET /v3/account` → 200) mais `POST /v3/smtp/email` répond
`403 permission_denied` — le compte transactionnel n'est pas activé, ce qui se
règle chez Brevo et non dans la configuration.

Il est malgré tout maintenu cohérent avec le port `EmailProvider` : sans cela
TypeScript casserait au premier ajout au port, et une éventuelle reprise du
chemin Brevo enverrait un corps de requête silencieusement invalide.

**Avant `if (attachments?.length) assertEmailAttachmentsFit(attachments);`**

Même borne que SMTP, et pour la même raison : ici le binaire est en plus

encodé en base64 DANS le corps JSON, soit +33 % sur le fil et deux copies

simultanées en mémoire de la fonction.
**Avant `textContent: body.text,`**

Le repli texte accompagne désormais le HTML ici aussi. Les deux transports

doivent livrer le MÊME message : un basculement de fournisseur ne peut pas

changer ce que reçoit le destinataire — même exigence que la borne de pièces

jointes, posée dans le domaine pour cette raison exacte.
**Avant `...(attachments?.length`**

L'API Brevo attend `attachment` (singulier), avec `content` en base64 et

`name` — ce n'est ni le nom ni la forme de la clé nodemailer. Absente

quand il n'y a rien à joindre, pour ne pas modifier les envois existants.
## `features/notification/infrastructure/providers/email-provider.factory.ts`

**Avant `export function createEmailProvider(): EmailProvider {`**

Sélection du fournisseur email — UN SEUL endroit.

⚠️ Cette fonction vivait dans `src/mastra/index.ts`. Elle en a été EXTRAITE le 2026-08-14
parce que `src/api/slack-interactions.route.ts` en a désormais besoin lui aussi — c'est là
qu'un email d'entretien part réellement, au clic sur « Envoyer » — et que la route ne peut
pas importer `index.ts` : celui-ci importe la route, le cycle serait immédiat.

L'alternative était de recopier le choix SMTP/Brevo dans la route. Ce dépôt a déjà payé
trois fois le prix d'une décision dupliquée qui diverge (`WIRING` dans deux fichiers,
`_measure.mts`, les instructions nommant des tools retirés) : ici, une divergence ferait
partir les emails d'entretien par un fournisseur et ceux de notification par un autre,
sans que rien ne le signale.

SMTP l'emporte dès que `SMTP_HOST`, `SMTP_USER` et `SMTP_PASS` sont tous renseignés, sinon
on retombe sur Brevo. Raison : le compte transactionnel Brevo n'est PAS activé
(`403 permission_denied` sur `POST /v3/smtp/email`, y compris avec un expéditeur validé),
donc SMTP est aujourd'hui le seul chemin qui envoie réellement.

⚠️ Gmail : `SMTP_PASS` doit être un mot de passe d'APPLICATION (16 caractères), pas le mot
de passe du compte — sinon `534-5.7.9 Application-specific password required`.

## `features/notification/infrastructure/providers/slack-progress.ts`

**Avant `export interface ProgressTarget {`**

Marqueur de progression Slack — « le bot est en train de réfléchir ».

POURQUOI CE MODULE
Un appel LLM prend 2 à 17 s (jusqu'à ~21 s quand le back-off du dernier
maillon de la chaîne de fallback se déclenche, cf. CLAUDE.md). Pendant tout
ce temps l'utilisateur ne voit RIEN : le bot paraît muet. On poste donc
immédiatement un message court, puis on le REMPLACE (`chat.update`) par la
réponse finale — un seul message dans le fil, jamais deux.

POURQUOI PAS `assistant.threads.setStatus`
C'est la seule vraie API « typing indicator » de Slack
(`node_modules/@slack/web-api/dist/types/request/assistant.d.ts`,
`AssistantThreadsSetStatusArguments`). Elle n'opère que sur un *assistant
thread* — le conteneur créé par la fonctionnalité « Agents & AI Apps », que
l'app Kisso n'active pas. Sur un canal ou un DM ordinaire il n'y a pas de
thread assistant à cibler. Le repli `postMessage` + `update` ci-dessous ne
dépend, lui, que de `chat:write` — un scope réellement accordé au bot.

PROPRIÉTÉ CRITIQUE — CETTE BRIQUE N'EST JAMAIS UN POINT DE PANNE
Le marqueur est un CONFORT. Tout échec sur son chemin (`not_in_channel`,
`rate_limited`, réseau, `message_not_found` à la mise à jour) est journalisé
en `warn` et le traitement continue : `resolve()` se rabat alors sur un
`chat.postMessage` normal. Le bot répond même sans indicateur.

Seule exception, et elle est délibérée : si la LIVRAISON FINALE elle-même
échoue (mise à jour ET repli), `resolve()` propage — l'appelant doit savoir
que sa réponse n'a atteint personne, exactement comme avec un `postMessage`
direct aujourd'hui. `fail()`, lui, ne lève jamais : il est déjà sur le chemin
d'erreur, et y remplacer une exception par une autre ne ferait qu'effacer la
cause d'origine.

ZÉRO TOKEN LLM : aucun appel de modèle sur ce chemin.

 Cible du marqueur. `threadTs` absent = message posté à la racine du canal.
**Avant `threadTs?: string;`**

Fil de discussion. En DM le bot ne threade PAS par conception (la réponse
serait enfouie hors de la conversation principale) : l'appelant passe alors
`undefined`.

**Avant `resolve(text: string): Promise<void>;`**

Remplace le marqueur de progression par le texte final.

Ne lève que si la réponse n'a pas pu être délivrée DU TOUT (mise à jour
échouée *et* repli `postMessage` échoué).

**Avant `fail(text: string): Promise<void>;`**

Abandonne le marqueur et le remplace par un message d'erreur.
Ne lève jamais — on est déjà sur le chemin d'erreur.

**Avant `export const PROGRESS_MARKER_TEXT = 'Je regarde ça, un instant…';`**

Texte du marqueur : français, tutoiement, sobre, sans emoji.

Cohérent avec `sanitizeAgentOutput`, qui retire déjà les emojis de toute
réponse d'agent : un marqueur émaillé détonnerait juste avant une réponse qui
n'en porte aucun. Volontairement court — il ne survit que quelques secondes.

**Avant `type ProgressClient = Pick<WebClient, 'chat'>;`**

Sous-ensemble de `WebClient` réellement consommé.

Un `WebClient` complet reste accepté (c'est un sur-type structurel) ; ce type
ne sert qu'à documenter la surface utilisée : deux méthodes, rien d'autre.

**Avant `function warnDegraded(message: string, channel: string, error: unknown): void {`**

 Le marqueur ne part pas / ne se met pas à jour : on continue sans lui.

**Avant `export async function startProgress(`**

Poste un marqueur de progression et rend de quoi le remplacer.

BUDGET DE LATENCE — on n'attend PAS l'aller-retour Slack.
`startProgress()` rend la main dès la microtâche suivante : la promesse du
`postMessage` est conservée et n'est attendue qu'au moment de conclure. Le
marqueur part donc en parallèle de l'appel LLM au lieu de le retarder de
200-500 ms. La promesse est immédiatement munie d'un `.catch()` pour qu'un
échec ne remonte jamais en rejet non géré, et l'attendre dans `settle()`
garantit l'ordre : jamais de marqueur qui atterrit APRÈS la réponse finale.

⚠️ À n'appeler QUE dans la tâche de fond, après l'ACK HTTP des 3 s de Slack.

PAS DE RAFRAÎCHISSEMENT PÉRIODIQUE, décision assumée :
 1. chaque rafraîchissement est un aller-retour réseau de plus, et
    `chat.update` est limité en débit par Slack (palier « Tier 3 ») ;
 2. un timer récurrent maintient l'invocation serverless en vie et doit être
    annulé sur TOUS les chemins de sortie, sinon il ronge le `maxDuration`
    de 60 s — un point de panne ajouté pour un gain cosmétique ;
 3. il courrait contre `resolve()` : une mise à jour en vol au moment de la
    réponse finale ÉCRASERAIT cette réponse par « je regarde ça… ». C'est le
    risque décisif ;
 4. le pire cas mesuré est ~21 s ; l'utilisateur a déjà un signal visible et
    horodaté. Le rafraîchir n'apporte rien qu'une mention « modifié ».

**Avant `const markerTs: Promise<string | undefined> = post(PROGRESS_MARKER_TEXT)`**

Lancé sans `await` : voir « BUDGET DE LATENCE » ci-dessus. Le `.catch()`

est posé ici même — sans lui, un échec du marqueur produirait un rejet non

géré (le `settle()` qui l'attend peut arriver plusieurs secondes plus tard).
**Avant `let markerConsumed = false;`**

Le marqueur n'est consommable qu'UNE fois.

Sans ce verrou, un second `resolve()` (ou un `fail()` après un `resolve()`)
réécrirait le même message et EFFACERAIT la réponse déjà livrée. Une fois
consommé, toute conclusion supplémentaire part en message distinct.

**Avant `warnDegraded(`**

`message_not_found`, `cant_update_message`, réseau… : le marqueur est

perdu, mais la réponse, elle, doit partir.
**Avant `resolve: (text: string) => settle(text),`**

La livraison finale échoue → l'appelant doit le savoir (cf. en-tête).

## `features/notification/infrastructure/providers/slack-workspace.service.ts`

**Avant `interface SlackApiUser {`**

 Forme commune aux réponses `users.list`, `users.lookupByEmail` et `users.info`.

**Avant `deleted?: boolean;`**

 Nom de champ de Slack : `deleted`, et non `is_deleted` comme les autres drapeaux.

**Avant `export const SLACK_PAGE_LIMIT = 200;`**

Taille de page demandée à Slack. Le DÉFAUT de `users.list` et de `conversations.list` est
**100**, jamais « tout » : une lecture sans curseur rend un workspace partiel sans le dire.

**Avant `export const SLACK_MAX_PAGES = 50;`**

Plafond de pages, appliqué à TOUTE boucle de curseur de ce fichier.

Il n'existait pas : `while (cursor)` faisait confiance au serveur pour terminer. Un curseur
qui ne se vide jamais — bug d'API, réponse tronquée, curseur rejoué — bouclait indéfiniment
dans une fonction Vercel dont le budget est de 60 s.

50 pages × 200 = 10 000 entrées, deux ordres de grandeur au-dessus du workspace Kisso. Le
franchir n'est donc pas une limite de capacité mais le signe d'une anomalie — d'où la
journalisation en `error` et non en `warn` : un plafond silencieux se lit « tout est
synchronisé », qui est exactement le mode d'échec que ce dépôt paie depuis `emailSent: false`.

**Avant `export interface SlackMemberPage {`**

 Une page de `users.list`, déjà projetée. Le curseur reste au contrôle de l'appelant.

**Avant `nextCursor?: string;`**

 Absent = dernière page.

**Avant `export interface SlackChannelMembership {`**

Un canal vu sous l'angle de l'ACCÈS, et non de la description.

Type SÉPARÉ de `SlackChannel` à dessein : `SlackChannel` est ce que le tool
`discoverSlackWorkspace` montre à un modèle (topic, purpose, memberCount — des tokens payés
à chaque aller-retour), là où la couverture de canaux n'a besoin que de « public ou privé,
archivé ou non, dedans ou dehors ». Fondre les deux ferait porter à chaque énumération
envoyée au modèle des champs qui ne l'intéressent pas, et inversement.

**Avant `isMember: boolean;`**

 `true` si le bot est déjà dans le canal — c'est ce que `chat.postMessage` exige.

**Avant `export type SlackJoinStatus =`**

Issue NOMMÉE d'une tentative d'adhésion. Aucune n'est une exception :

 - `not_public` n'est PAS une panne. `conversations.join` ne fonctionne que sur un canal
   public ; un canal privé exige une invitation humaine. Le traiter en erreur ferait
   échouer une synchronisation dont tout le reste a fonctionné — c'est l'arbitrage
   « non applicable ≠ dégradé » déjà tranché sur l'invitation Slack de l'onboarding.
 - `already_member` est le cas IDEMPOTENT : rejoindre deux fois ne fait rien et n'est pas
   un échec.
 - `missing_scope` est la seule issue qui appelle un geste HUMAIN (ajouter `channels:join`
   dans *OAuth & Permissions*, **puis réinstaller l'app** — l'ajout seul ne propage rien).

**Avant `error?: string;`**

 Code d'erreur brut de Slack, conservé pour le journal. Jamais montré à un utilisateur.

**Avant `function splitRealName(realName: string): { firstName: string; lastName: string } {`**

 Découpe « Marie Claire Dupont » en « Marie » / « Claire Dupont ».

**Avant `export function toMember(user: SlackApiUser): SlackMember {`**

Projection unique de l'utilisateur Slack vers `SlackMember`.

Les trois méthodes d'annuaire la partagent : trois mappings parallèles
auraient divergé au premier champ ajouté.

**Avant `email: user.profile?.email ?? null,`**

`?? null` et non `|| ''` : une chaîne vide passerait une simple validation de présence,

et l'email est une CLÉ de recherche. L'absence doit rester nommée.
**Avant `firstName: user.profile?.first_name || derived.firstName,`**

`||` et non `??` : Slack renvoie une chaîne vide — pas `undefined` —

pour un prénom non renseigné, et `??` la laisserait passer.
**Avant `displayName:`**

Cascade complète, jusqu'à `name` : un refus d'autorisation journalisé sans aucun nom est

inexploitable. C'est le champ que lit la politique quand elle doit dire QUI a été refusé.
**Avant `title: user.profile?.title || '',`**

Pas de cascade ici, contrairement à `displayName` : un poste ne se devine pas. Absent

vaut absent — c'est le cas réel de Mistourath IDI, dont le profil ne porte aucun titre.
**Avant `isRestricted: user.is_restricted ?? false,`**

Lus TELS QUELS, sans déduction : Slack pose les deux drapeaux sur un invité mono-canal, et

dériver l'un de l'autre interdirait de durcir ce seul cas.
**Avant `function logTruncation(method: string, pages: number, collected: number): void {`**

LA ligne à chercher quand l'annuaire paraît complet et ne l'est pas.

En `error` et non en `warn` : une troncature muette est indiscernable d'un workspace petit,
et la politique d'autorisation qui s'en nourrit rétrograderait des gens légitimes au motif
qu'ils sont en page 2.

**Avant `async listMembers(): Promise<SlackMember[]> {`**

⚠️ Les comptes DÉSACTIVÉS sont écartés ici, et ce filtre est correct POUR CET APPELANT
(le tool de découverte n'a que faire d'un ancien salarié). Il ne l'est PAS pour l'annuaire :
`isDeleted` est le fait qui fait REFUSER un compte désactivé, et une source qui ne le livre
jamais laisserait la politique accorder l'accès à un ex-salarié indéfiniment. C'est pourquoi
la synchronisation d'annuaire passe par `listMembersPage`, non filtrée.

**Avant `async listMembersPage(`**

UNE page de `users.list`, sans aucun filtre.

Primitive à curseur plutôt que balayage complet : c'est l'appelant qui connaît sa politique
de plafond et qui doit pouvoir DIRE qu'il a été tronqué. Un balayage qui rend un tableau nu
ne peut pas l'avouer — il rend « moins de gens », ce qui se lit « il n'y en a pas plus ».

**Avant `async listChannelMembershipsPage(`**

UNE page de `conversations.list`, projetée sur l'appartenance.

`exclude_archived` n'est PAS posé : un canal archivé doit être VU pour être écarté par un
état nommé, sinon il disparaît du décompte et l'on ne sait plus distinguer « archivé » de
« inexistant ».

**Avant `isMember: ch.is_member ?? false,`**

`?? false` : l'absence du drapeau se lit « pas membre ». Le défaut sûr est celui qui

fait TENTER l'adhésion — un `join` inutile est idempotent, un `postMessage` dans un

canal dont on croit à tort être membre échoue en `not_in_channel`, silencieusement.
**Avant `async joinChannel(channelId: string): Promise<SlackJoinOutcome> {`**

Rejoint un canal PUBLIC. Ne lève jamais : chaque refus de Slack devient un état nommé.

Le scope `channels:join` est accordé depuis longtemps mais **aucun code n'émettait cet
appel** — d'où un bot membre de 2 canaux sur 5, et un `chat.postMessage` qui échouait en
`not_in_channel` dans les trois autres. Cet échec-là est INVISIBLE pour l'utilisateur : le
message d'erreur de repli est posté dans le même canal inaccessible, donc échoue aussi.

**Avant `const warning = String((response as { warning?: string }).warning ?? '');`**

Slack ne lève pas quand on est déjà dedans : il répond `ok` avec un avertissement. Sans

cette lecture, une adhésion déjà acquise serait comptée comme une adhésion nouvelle et

le rapport surestimerait ce que ce passage a réellement changé.
**Avant `if (message.includes('user_not_found') || message.includes('users_not_found')) {`**

`users.info` répond `user_not_found` au singulier, là où

`users.lookupByEmail` répond `users_not_found`. Les deux sont acceptés.
## `features/notification/infrastructure/providers/slack.adapter.ts`

**Avant `type ChatPostMessageWithBlocks = Extract<ChatPostMessageArguments, { blocks: unknown }>;`**

Types Block Kit dérivés des signatures de `WebClient`.

Ils vivent ici, en infrastructure, et non dans `domain/` : Block Kit est le
format de fil d'un fournisseur externe (clés en snake_case), et le garde-fou
d'architecture interdit tout import `@slack/*` dans la couche domaine. Les
dériver plutôt que de les réécrire évite une union de plusieurs centaines de
lignes qui dériverait à chaque évolution de l'API Slack.

On les dérive de `@slack/web-api` et non de `@slack/types` — ce dernier n'est
qu'une dépendance transitive, l'importer serait une dépendance fantôme.

`ChatPostMessageArguments` est une union (texte | blocs | pièces jointes) :
`Extract<…, { blocks: unknown }>` en isole le membre où `blocks` est requis.

**Avant `export type SlackModalView = Extract<ViewsOpenArguments['view'], { type: 'modal' }>;`**

`ViewsOpenArguments['view']` est l'union `HomeView | ModalView | WorkflowStepView`.
On la restreint à la modale : `HomeView` ne porte ni `title` ni `submit`, donc
l'union brute rend ces champs inaccessibles au typage alors qu'ils sont
obligatoires ici.

**Avant `function isSlackError(err: unknown, code: string): boolean {`**

Teste le code d'erreur brut d'une réponse Slack.

Le SDK lève un `WebAPIPlatformError` dont `.message` est de la prose
(« An API error occurred: expired_trigger_id ») et dont `.data.error` porte
le code seul. On lit `data.error` en priorité — le message peut changer d'une
version du SDK à l'autre — avec repli sur le message pour les erreurs nues.

**Avant `function extractPermalink(response: unknown): string | undefined {`**

Extrait le permalink du retour de `files.uploadV2` — DÉFENSIVEMENT.

Trois raisons de ne jamais y laisser d'accès direct :

1. **La forme n'est pas celle de la v1.** `files.upload` rendait un unique
   objet `file`. La v2 est un enrobage client (`WebClient.filesUploadV2` :
   `getUploadURLExternal` → PUT → `completeUploadExternal`) qui rend
   `{ ok: true, files: [<réponse completeUploadExternal>, …] }`, chaque réponse
   portant à son tour son propre tableau `files`. Le permalink est donc
   DOUBLEMENT imbriqué : `res.files[0].files[0].permalink`.
2. **Le typage installé ne le dit pas.** `client.files.uploadV2` est déclaré
   `MethodWithRequiredArgument<FilesUploadV2Arguments, WebAPICallResult>`
   (@slack/web-api 8.0.0, `dist/methods.d.ts`), soit `{ ok, response_metadata? }` :
   le champ `files` n'existe pas pour TypeScript. Seule la méthode privée
   `WebClient.filesUploadV2()` porte le type riche. On lit donc depuis `unknown`.
3. **Le fichier est livré même sans permalink.** Faire lever ici transformerait
   une livraison réussie en échec — le lien est un confort, pas la livraison.

**Avant `const flat = (completion as { permalink?: unknown } | null | undefined)?.permalink;`**

Repli sur un permalink posé à plat, au cas où le SDK aplatirait la réponse

dans une version ultérieure.
**Avant `constructor(botToken: string, client?: WebClient) {`**

 `client` n'est là que pour les tests — la production ne passe que le jeton.

**Avant `async sendMessage(`**

@param threadTs répond DANS le fil plutôt qu'à la racine du canal.

⚠️ Ajouté le 2026-08-18, sur un commentaire qui mentait. `replyInThread` (route
d'interactivité) annonçait « répond dans le fil de la carte — jamais à la racine, la
carte y serait orpheline » et appelait cette méthode, qui n'avait aucun moyen de
threader. Le `thread_ts` était même déclaré dans le type du payload Slack et lu nulle
part. Résultat : « C'est envoyé à … » atterrissait à la racine du canal, détaché de la
carte qu'il confirme.

Optionnel, et non un second paramètre obligatoire : en DM on ne threade délibérément
PAS — threader un DM enfouit le message hors de la conversation principale, ce qui a
déjà fait paraître ce bot muet pendant des heures.

⚠️ Rend le CANAL RÉELLEMENT UTILISÉ, et ce retour porte un correctif du 2026-08-19.

Quand `channelId` est un identifiant d'UTILISATEUR (`U…`), Slack ouvre lui-même la
conversation directe et le message atterrit dans un canal `D…` que l'appelant ne connaît
pas. C'est exactement ce qui a cassé l'entretien conversationnel à sa première mise en
production : la route posait la question à `U…`, le handler cherchait l'état dans la
mémoire de la conversation `D…`, et les deux ne se rencontraient jamais. Le symptôme est
trompeur — la question s'affiche bien, seule la RÉPONSE part chez l'agent.

On rend donc ce que Slack a décidé, plutôt que ce qu'on lui a demandé. Sans ce retour, la
seule alternative serait un `conversations.open` de plus, payé à chaque envoi.
**Avant `async updateMessage(`**

Réécrit un message déjà posté — c'est ce qui NEUTRALISE un bouton après son premier clic.

⚠️ La capacité était décrite depuis l'origine dans le commentaire de `sendBlocks` (« le
`ts` permet de mettre le message à jour par la suite ») et n'avait jamais été câblée : la
carte d'invitation d'entretien restait entièrement cliquable, y compris après « Annuler »
et après un envoi réussi. Sur la seule action irréversible de ce système — un email à un
candidat — cela signifiait deux invitations pour deux clics.

⚠️ `blocks` REMPLACE les blocs existants : passer un tableau sans bloc `actions` est ce
qui fait disparaître les boutons. Le `text` de repli doit rester non vide pour la même
raison que dans `sendBlocks`.

**Avant `async sendBlocks(channelId: string, text: string, blocks: SlackBlock[]): Promise<{ ts: string }>`**

Poste un message à blocs et rend son `ts`.

Le `ts` permet de mettre le message à jour par la suite — c'est le seul
moyen de neutraliser un bouton après son premier clic.

**Avant `async openModal(triggerId: string, view: SlackModalView): Promise<{ viewId: string }> {`**

Ouvre une modale et rend son `viewId`.

⚠️ À appeler immédiatement après l'interaction : le `trigger_id` expire au
bout de 3 secondes. C'est le contre-pied exact du traitement en tâche de
fond de la route Events — ne pas « harmoniser » les deux.

Le `viewId` retourné est le seul moyen d'enrichir la modale ensuite
(`views.update`), une fois ce délai passé.

**Avant `async uploadFile(input: FileUploadInput): Promise<{ permalink?: string }> {`**

Livre un fichier dans un canal ou dans un fil, et rend son permalink.

Le scope `files:write` **est accordé** — vérifié en production le 2026-08-11, un PDF
réellement posté (`hasPermalink: true`). La branche `missing_scope` ci-dessous n'est
donc plus le cas nominal, mais elle reste : une réinstallation de l'app peut à tout
moment repartir sur un jeu de scopes plus étroit, et son message nomme alors les DEUX
gestes requis. Ajouter le scope dans la console ne suffit en effet pas — le jeton du
workspace conserve les scopes de l'installation en cours, seule une réinstallation les
propage. C'est le piège qui a coûté plusieurs heures le 2026-08-08, manifeste conforme
et installation périmée.

On ne dégrade pas ici : l'erreur remonte à l'appelant, à qui il revient de
choisir un repli (email) ou de rendre `delivery: 'failed'`. Un adaptateur qui
avalerait l'échec ferait croire à une livraison qui n'a pas eu lieu.

**Avant `const destination = threadTs`**

`channel_id` et non `channels` : la v2 a déprécié `channels`, qui ne

supporte plus la liste séparée par des virgules et déclenche un warning.

Les deux formes de destination sont construites séparément parce que le

typage les modélise en union discriminée (`thread_ts?: never` hors fil) :

un `thread_ts: undefined` répandu par spread casserait la résolution.
**Avant `file: Buffer.from(bytes),`**

Le SDK n'accepte pas un `Uint8Array` nu : `Buffer | Stream | string`, où

une chaîne serait interprétée comme un CHEMIN à lire sur le disque —

inutilisable sur Vercel, dont le FS est en lecture seule hors `/tmp`.
## `features/notification/infrastructure/providers/smtp.adapter.ts`

**Avant `export interface SmtpAdapterConfig {`**

Adaptateur email SMTP (Gmail et tout serveur SMTP classique).

Pourquoi cet adaptateur existe : Brevo refuse d'envoyer tant que le compte
transactionnel n'est pas activé (`403 permission_denied`), et la validation d'un
expéditeur sur un domaine que l'on ne possède pas est impossible. SMTP permet
d'envoyer immédiatement, sans domaine à vérifier.

⚠️ GMAIL — MOT DE PASSE D'APPLICATION OBLIGATOIRE
Depuis mai 2022, Google refuse le mot de passe habituel du compte pour SMTP :
  `534-5.7.9 Application-specific password required`
Il faut un « App Password » de 16 caractères, ce qui suppose la validation en deux
étapes activée sur le compte :
  Compte Google → Sécurité → Validation en deux étapes → Mots de passe des applications
`SMTP_PASS` doit contenir ce mot de passe d'application, jamais celui du compte.

⚠️ SERVERLESS (Vercel)
SMTP maintient une connexion TCP, contrairement à une API HTTP. Sur une fonction
serverless c'est plus lent et plus fragile qu'un appel `fetch` : la connexion ne
survit pas au gel de la fonction. On désactive donc le pool et on borne les timeouts
pour échouer vite plutôt que de bloquer l'appelant.

**Avant `from?: string;`**

 Expéditeur affiché. À défaut, `user`.

**Avant `fromName?: string;`**

 Nom affiché à côté de l'adresse.

**Avant `secure?: boolean;`**

 TLS implicite (port 465). Déduit du port si absent.

**Avant `transporter?: Transporter;`**

 Injection d'un transport (tests unitaires).

**Avant `const SMTP_TIMEOUT_MS = 10_000;`**

 Timeouts serrés : mieux vaut échouer vite que retenir la requête HTTP appelante.

**Avant `this.from = fromName ? `"${fromName}" <${address}>` : address;`**

`from` doit rester une adresse simple ; le nom est ajouté au format RFC 5322.

**Avant `secure: secure ?? port === 465,`**

Port 465 = TLS implicite ; 587 = STARTTLS (secure:false puis upgrade).

**Avant `requireTLS: true,`**

⚠️ SANS CETTE LIGNE, LE CHIFFREMENT EN TRANSIT ÉTAIT OPPORTUNISTE.
Sur 587 (`secure: false`), nodemailer ne bascule en STARTTLS que si le serveur
annonce l'extension dans sa réponse EHLO : `if (!this.secure && !ignoreTLS &&
(/STARTTLS/.test(str) || this.options.requireTLS))`. Un serveur qui ne l'annonce
pas — MITM en aval, relais mal configuré, dégradation de session — laissait donc
partir `AUTH LOGIN` (identifiants en base64, c'est-à-dire en clair) puis le corps
du message SANS AUCUNE ERREUR. Ce transport porte des noms, des adresses et des
convocations d'entretien.
Avec `requireTLS`, la commande STARTTLS est envoyée quoi qu'annonce le serveur, et
un refus devient `ETLS: Error upgrading connection with STARTTLS` — un échec
BRUYANT, jamais un envoi silencieusement dégradé. On ne pose pas `opportunisticTLS`,
qui reprendrait explicitement le comportement qu'on ferme ici.

Sur 465 (`secure: true`), l'option n'a AUCUN effet sur cette bascule — la garde
`!this.secure` la court-circuite, TLS étant déjà établi dès la connexion. Elle n'y
est pas pour autant purement décorative : dans `_actionEHLO`, un EHLO refusé fait
échouer la connexion au lieu de retomber sur HELO. C'est le comportement souhaité
(HELO est un dialecte pré-ESMTP), et cela vaut aussi comme filet si `SMTP_PORT`
était un jour mal renseigné.

Verrouillé par `tests/unit/infrastructure-providers/smtp.adapter.test.ts`
(bloc « transport TLS »), qui espionne `createTransport` — les autres tests du
fichier injectent un transport et ne peuvent donc rien dire de ces options.

**Avant `connectionTimeout: SMTP_TIMEOUT_MS,`**

Pas de `pool: false` ici : c'est déjà le défaut de nodemailer, et le typage

`SMTPTransport.Options` ne connaît pas la clé `pool` (elle n'existe que sur

`SMTPPool.Options`, où elle vaut obligatoirement `true`). L'ajouter fait

dérailler la résolution de surcharge de `createTransport` (TS2769).
**Avant `async verify(): Promise<void> {`**

Vérifie la connexion et l'authentification sans envoyer de message.
Utile au diagnostic (`scripts/smoke-email.mjs`) — ne PAS appeler à chaud sur
chaque envoi, cela double le coût d'une connexion SMTP.

**Avant `if (attachments?.length) assertEmailAttachmentsFit(attachments);`**

Vérifié AVANT d'ouvrir la connexion : sur une fonction serverless, laisser

partir un envoi trop lourd coûte les 10 s du timeout socket pour finir sur

un `ETIMEDOUT` qui ne dit rien de la vraie cause.
**Avant `text: body.text,`**

Repli texte brut : certains clients refusent un message uniquement HTML, et cela

améliore le score anti-spam.

⚠️ Il était DÉRIVÉ du HTML par retrait de balises, ce qui mutilait tout corps de

texte brut contenant `<…>` — second symptôme du contrat implicite corrigé le

2026-08-20. C'est désormais le producteur du corps qui rend les deux formes, la

seule place où l'on sache laquelle est l'original.
**Avant `...(attachments?.length`**

La clé n'est posée que s'il y a réellement quelque chose à joindre :

les appelants historiques doivent produire un message strictement

identique à l'existant. `content` doit être un Buffer — nodemailer ne

contractualise pas l'`Uint8Array`.
**Avant `if (err.responseCode === 534 || /application-specific password/i.test(err.message ?? '')) {`**

Message explicite pour l'erreur Gmail la plus fréquente, sinon on perd 20 min

à croire que le mot de passe est faux alors qu'il est simplement du mauvais type.
## `features/notification/infrastructure/repositories/drizzle-notification.repository.ts`

**Avant `async findPending(): Promise<Notification[]> {`**

Les notifications qu'un ordonnanceur devrait reprendre — s'il en existait un.

⚠️ **DEUX choses à savoir avant de brancher quoi que ce soit dessus.**

1. **Cette méthode n'a AUCUN site d'appel** en production : ni cron, ni poller, ni worker.
   C'est assumé et documenté partout dans ce dépôt — `scheduleReminder` rend
   explicitement `willBeSentAutomatically: false` plutôt que de laisser croire le
   contraire.
2. **Elle filtrait sur le MAUVAIS statut**, et personne ne pouvait s'en apercevoir puisque
   rien ne l'appelait : elle cherchait `Pending` alors que `scheduleReminder` écrit
   `Scheduled`. Le seul lecteur imaginable était donc déjà incompatible avec le seul
   écrivain — un ordonnanceur branché demain aurait tourné à vide, EN SILENCE, et le
   diagnostic aurait porté sur le cron plutôt que sur cette ligne.

Les deux statuts sont désormais retenus : `Pending` (créée, pas encore traitée) et
`Scheduled` (datée par `scheduleReminder`). C'est ce qu'« en attente d'envoi » veut dire.

## `features/notification/infrastructure/repositories/drizzle-rate-limit.repository.ts`

**Avant `export class DrizzleRateLimitRepository implements RateLimitRepository {`**

Compteurs de limitation de débit PARTAGÉS entre instances, sur LibSQL/Turso.

⚠️ Comme `slack_event_dedup`, la table `rate_limit_counters` n'est PAS créée par les
migrations `drizzle/` : celles-ci sont désynchronisées de `schema.ts`, et `drizzle-kit push`
se bloque indéfiniment contre une base `libsql://` distante. Le DDL doit être appliqué à la
main sur toute base — locale, neuve ou de production — sinon `increment()` lève
`no such table: rate_limit_counters` et l'appelant retombe sur sa dégradation (autoriser).

COÛT : `increment()` fait UN aller-retour, toujours, quel que soit l'état de la ligne. C'est
un plafond assumé et non négociable — le contrôle tourne avant l'ACK Slack, celui qui n'a que
3 secondes.

**Avant `constructor(private readonly resolveDb: () => DatabaseInstance = getDb) {}`**

La connexion est résolue PARESSEUSEMENT (fonction, pas instance) : la construire ici
ouvrirait la base au chargement du module, donc au câblage de `src/mastra/index.ts`. Le
paramètre existe aussi pour les tests, qui injectent une base libsql en mémoire plutôt que
de mocker Drizzle à la main.

**Avant `async increment(key: string, windowStart: Date, expiresAt: Date, by = 1): Promise<number> {`**

UN SEUL énoncé, atomique, qui rend la valeur d'après incrément :

  INSERT INTO rate_limit_counters (key, count, window_start, expires_at)
  VALUES (?, 1, ?, ?)
  ON CONFLICT(key) DO UPDATE SET count = count + 1
  RETURNING count

Un `SELECT` suivi d'un `UPDATE` — la forme « naturelle » — rouvrirait la fenêtre de
concurrence que ce dépôt existe pour fermer : deux instances liraient la même valeur avant
que l'une écrive, et la limite serait franchissable par simple parallélisme. C'est le même
raisonnement, et la même forme, que la prise atomique de `slack_event_dedup`.

VÉRIFIÉ : Drizzle 0.45 + `@libsql/client` acceptent bien `.returning()` derrière un
`.onConflictDoUpdate()`, et rendent la valeur ISSUE DE L'UPDATE (1, puis 2, puis 3…). Il
n'y a donc aucune raison de descendre au client libsql brut (`db.run(sql\`…\`)`), ce qui
aurait coûté la vérification de types sur les noms de colonnes.

`window_start` et `expires_at` ne sont volontairement PAS réécrits sur conflit : la clé
porte déjà le numéro de fenêtre (`buildCounterKey`), donc toutes les lignes qui entrent en
conflit décrivent EXACTEMENT la même fenêtre. Les réécrire ne changerait rien — sauf le
jour où une horloge décalée d'une milliseconde repousserait l'expiration à chaque
incrément, offrant à une clé très sollicitée une survie indéfinie.

**Avant `const step = Number.isFinite(by) && by > 0 ? Math.round(by) : 0;`**

Un pas négatif rendrait du budget, ce qu'aucun appelant ne doit pouvoir faire par

accident : `usage.inputTokens` d'un fournisseur est une valeur externe, donc réputée

non fiable. `0` reste licite — c'est la lecture atomique décrite dans le port.
**Avant `return row?.count ?? 0;`**

`RETURNING` sur un upsert rend toujours une ligne. S'il n'en rend aucune, on ne devine

pas : `0` est précisément la valeur que `evaluateCount` traite comme « compte non

exploitable » et qui vaut AUTORISATION. Refuser sans preuve positive couperait le service

sur une bizarrerie du pilote — même arbitrage que la déduplication partagée.
**Avant `async pruneExpired(now: Date): Promise<number> {`**

`lte` et non `lt` : `expires_at` est déjà une date de fin FRANCHIE (elle inclut la marge de
purge de `rate-limit-policy.ts`). Une ligne dont l'expiration tombe exactement sur `now`
n'a plus rien à protéger.

**Avant `function rowsAffected(result: unknown): number {`**

 Le pilote libSQL rend `rowsAffected` ; on ne suppose jamais sa présence.

## `features/notification/infrastructure/repositories/drizzle-slack-event-dedup.repository.ts`

**Avant `export class DrizzleSlackEventDedupRepository implements SlackEventDedupRepository {`**

Déduplication partagée des événements Slack, sur LibSQL/Turso.

⚠️ La table `slack_event_dedup` n'est PAS créée par les migrations `drizzle/` : celles-ci
sont désynchronisées de `schema.ts`, et `drizzle-kit push` se bloque indéfiniment contre une
base `libsql://` distante. Le DDL à appliquer à la main vit dans
`scripts/ddl-slack-event-dedup.sql`.

COÛT : `claim()` fait UN aller-retour dans le cas passant (l'événement est neuf), et c'est
un plafond assumé — il tourne avant l'ACK HTTP, celui qui a 3 secondes. Les allers-retours
supplémentaires ne concernent que le chemin REFUSÉ (un rejeu, donc rare) et ne servent qu'à
journaliser pourquoi.

**Avant `const inserted = await db`**

1. PRISE ATOMIQUE. Tout repose sur cette ligne : la PRIMARY KEY arbitre la course, et

   le nombre de lignes affectées dit qui a gagné. Un `SELECT` préalable — la forme

   « naturelle » — rouvrirait la fenêtre de concurrence que ce dépôt existe pour

   fermer : deux instances liraient « absente » avant que l'une écrive.
**Avant `const cutoff = new Date(now - options.inFlightGraceMs);`**

2. REPRISE D'UNE ENTRÉE ABANDONNÉE — atomique elle aussi. Le `WHERE` porte l'entièreté

   de la condition (`in-flight` ET plus vieille que la grâce) : deux instances en course

   sur la même entrée périmée ne peuvent pas la reprendre toutes les deux, la seconde

   voit `started_at` déjà rafraîchi et n'affecte aucune ligne.

   `lte` et non `lt` : avec une grâce nulle, `cutoff === now` et une entrée posée dans

   la même milliseconde doit être reprenable — c'est la sémantique `ageMs >= grace`

   du cache mémoire, qu'on conserve à l'identique.
**Avant `const [row] = await db`**

3. REFUS. La relecture ne sert QUE le log : elle n'entre dans aucune décision de prise,

   et n'a donc aucun effet sur la concurrence.
**Avant `return { granted: false, status: 'unknown', ageMs: null };`**

La ligne a disparu entre la prise et la relecture (purge concurrente). On refuse

quand même : mieux vaut une réponse manquée qu'une réponse en double, et la fenêtre

de rejeu de Slack est bien plus courte que la rétention.
**Avant `status: row.status as SlackEventDedupStatus,`**

SQLite ne connaît pas les unions littérales : la colonne est un `text` libre, la

contrainte vit dans le domaine.
**Avant `async markDone(key: string): Promise<void> {`**

Un `UPDATE` ne suffirait pas : la ligne peut avoir été purgée pendant un traitement long.
L'upsert garantit qu'un `done` posé reste un `done`, purge ou non.

**Avant `function rowsAffected(result: unknown): number {`**

 Le pilote libSQL rend `rowsAffected` ; on ne suppose jamais sa présence.

## `features/notification/infrastructure/repositories/in-memory-notification.repository.ts`

**Avant `async findPending(): Promise<Notification[]> {`**

 Mêmes deux statuts que l'implémentation Drizzle — voir son commentaire.

## `features/notification/infrastructure/repositories/in-memory-rate-limit.repository.ts`

**Avant `expiresAt: number;`**

 `Date.now()` de la borne de purge. La fenêtre elle-même est portée par la clé.

**Avant `export class InMemoryRateLimitRepository implements RateLimitRepository {`**

Doublure de test du `RateLimitRepository`. VRAI compteur — une `Map` — et non un bouchon :
c'est elle qui sert de doublure aux tests du contrôle de débit, et une doublure qui ne compte
pas ferait passer au vert un limiteur qui ne limite rien.

Elle sert aussi de premier niveau LOCAL possible : une instance chaude peut écarter une
rafale sans aucune E/S. Mais elle ne remplace pas l'implémentation Drizzle, et le port dit
pourquoi — un compteur en mémoire est par instance et disparaît au gel de la fonction
serverless, alors que le budget à protéger se mesure sur 24 h.

⚠️ `increment()` ne comporte AUCUN `await` avant sa mutation, et c'est délibéré : en
JavaScript, un corps de fonction sans point de suspension est atomique. La doublure reproduit
ainsi la garantie que l'implémentation Drizzle obtient de
`INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`. Y insérer un `await`
entre la lecture et l'écriture réintroduirait exactement la fenêtre de concurrence que ce
port ferme — et le test de concurrence, qui exige N valeurs DISTINCTES, le verrait.

**Avant `const step = Number.isFinite(by) && by > 0 ? Math.round(by) : 0;`**

Même normalisation que côté SQL — une doublure qui accepterait un pas que le vrai dépôt

refuse ferait passer au vert un comportement qui n'existe pas en production.
**Avant `existing.count += step;`**

On n'écrase PAS `expiresAt` : la clé porte le numéro de fenêtre, donc tous les incréments

qui atterrissent ici décrivent la même fenêtre. Le repousser à chaque incrément offrirait

à une clé très sollicitée une survie indéfinie. Même choix, et même raison, que côté SQL.
**Avant `async pruneExpired(now: Date): Promise<number> {`**

 `<=` : `expiresAt` inclut déjà la marge de purge de `rate-limit-policy.ts`.

**Avant `clear(): void {`**

 Confort de test : vide le dépôt entre deux cas.

## `features/notification/infrastructure/repositories/in-memory-slack-event-dedup.repository.ts`

**Avant `startedAt: number;`**

 `Date.now()` au moment où le statut courant a été posé.

**Avant `export class InMemorySlackEventDedupRepository implements SlackEventDedupRepository {`**

Doublure de test du `SlackEventDedupRepository`. Même contrat et même sémantique que
l'implémentation Drizzle — c'est elle qui sert de doublure dans les tests unitaires, on ne
mocke jamais Drizzle à la main.

Une SEULE instance partagée entre deux handlers simule deux instances serverless devant le
même store : c'est ainsi que se teste la déduplication multi-instance.

⚠️ `claim()` ne comporte AUCUN `await` avant sa mutation, et c'est délibéré : en JavaScript,
un corps de fonction sans point de suspension est atomique. La doublure reproduit donc la
garantie que l'implémentation Drizzle obtient de `INSERT … ON CONFLICT DO NOTHING`. Y
insérer un `await` entre la lecture et l'écriture réintroduirait exactement la fenêtre de
concurrence que ce port ferme.

**Avant `const abandoned = existing.status === 'in-flight' && ageMs >= options.inFlightGraceMs;`**

La grâce ne s'applique QU'À `in-flight` : une entrée `done` est un refus définitif.

**Avant `clear(): void {`**

 Confort de test : vide le dépôt entre deux cas.

## `features/notification/infrastructure/services/slack-rate-limiter.ts`

**Avant `export interface RateLimitDecision {`**

LIMITATION DE DÉBIT — assemblage des DEUX niveaux (P3).

Exactement la forme de `claimEvent()` pour la déduplication, et pour les mêmes raisons :

  1. **Compteur local (LRU).** Gratuit, aucune E/S. Il écarte les rafales qui retombent sur
     une instance chaude — le cas fréquent quand quelqu'un martèle le bot.
  2. **Store partagé (Turso).** Le seul qui voie ce que font les AUTRES instances, et le
     seul qui survive au gel de la fonction serverless. Sur un budget qui se mesure à la
     JOURNÉE, c'est lui qui compte réellement : un compteur en mémoire disparaît avec
     l'instance, et Vercel en démarre une neuve sans que personne ait à le demander.

DÉGRADATION — et pourquoi elle penche du même côté que la déduplication
Store indisponible ⇒ on retombe sur le seul compteur local et on ACCEPTE. Le raisonnement
est celui déjà tranché pour `slack_event_dedup` : une panne de la table ne doit pas devenir
une panne du produit. Un message de trop est visible et corrigeable ; un bot muet ne l'est
pas — et ce dépôt a déjà passé des heures à chercher pourquoi le bot semblait mort.

La ligne à chercher dans les logs :
    Shared rate limit unavailable — falling back to the per-instance counter

⚠️ Conséquence à assumer : tant que `rate_limit_counters` n'existe pas en base, la
protection est présente dans le code mais ne porte que sur une instance. C'est le même
avertissement que pour la déduplication, et il vaut la peine d'être lu deux fois.

**Avant `readonly rule: string | null;`**

 Nom de la règle qui a refusé. `null` quand l'événement est autorisé.

**Avant `readonly shouldNotify: boolean;`**

 Vrai au PREMIER refus d'une fenêtre seulement. Voir `evaluateCount`.

**Avant `readonly degraded: boolean;`**

 Le store partagé n'a pas répondu : la décision ne porte que sur cette instance.

**Avant `readonly rationsModelBudget: boolean;`**

La règle qui a refusé RATIONNE-T-ELLE le budget du modèle, ou contre-t-elle un abus ?

⚠️ Lu depuis l'objet `RateLimitRule` qui vient de refuser, JAMAIS d'une correspondance
par nom chez l'appelant. Une table `nom → rationne` recopiée ailleurs serait une liste
tenue à la main de plus, et ce dépôt en a déjà vu trois se désynchroniser en silence.

L'appelant s'en sert pour une seule chose, et elle est décisive : un refus de RAFALE
s'applique à tout, un refus de BUDGET ne doit jamais frapper un message qui ne coûtera
pas un token. Voir le miroir exact dans `slack-events.handler.ts`.

**Avant `readonly rules?: readonly RateLimitRule[];`**

Ordre significatif, à DEUX titres. Il fixe la priorité de lecture des verdicts — la règle
citée à l'utilisateur est la première de ce tableau qui refuse, jamais celle dont la
réponse réseau est revenue en premier. Et il fixe l'ordre du court-circuit LOCAL : la règle
la moins chère à déclencher d'abord, un abus se manifestant en rafale bien avant d'épuiser
un budget journalier. Court-circuiter sur la rafale épargne TOUS les allers-retours de la
phase partagée, pas seulement le sien.

**Avant `readonly repository?: RateLimitRepository | null;`**

`null` désactive explicitement le niveau partagé (tests, environnement sans base).
`undefined` laisse l'appelant fournir le dépôt plus tard.

**Avant `readonly workspaceRule?: RateLimitRule | null;`**

Budget de tokens de l'ÉQUIPE. `null` le DÉSACTIVE — c'est le comportement d'avant le
2026-08-13, celui où rien ne mesurait la grandeur qui a réellement cassé la production.

**Avant `private readonly workspaceRule: RateLimitRule | null;`**

 Budget de tokens de l'équipe. `null` = désactivé.

**Avant `private readonly local: LRUCache<string, number>;`**

Compteurs locaux. La clé porte déjà le numéro de fenêtre, donc une entrée ne se remet
jamais à zéro : elle cesse simplement d'être consultée. Le TTL est posé par `set()`,
par règle — 1 minute et 24 heures n'ont pas à partager une durée de rétention.

**Avant `private degradationLogged = false;`**

 N'inonde pas les logs quand la table manque : un avertissement, pas un par message.

**Avant `private readonly notifiedWindows = new Set<string>();`**

 Fenêtres pour lesquelles cette instance a déjà prévenu. Voir `claimNotification`.

**Avant `this.workspaceRule =`**

`undefined` ⇒ le défaut ; `null` ⇒ désactivé. Deux états distincts, comme partout

ailleurs dans ce dépôt.
**Avant `ttl: DAILY_RULE.windowMs,`**

TTL de repli ; chaque `set()` pose le sien, calé sur la fenêtre de sa règle.

**Avant `async check(`**

Compte un événement pour `subjectId` et dit s'il peut être traité.

⚠️ Appelée sur le chemin de l'ACK Slack (3 s), qui n'en a que trois. D'où la forme en DEUX
PHASES, et non une boucle unique :

  1. **Phase locale — séquentielle, court-circuitée, ZÉRO E/S.** L'ordre y est gratuit, et
     il porte une sémantique qu'on ne veut surtout pas perdre (voir plus bas).
  2. **Phase partagée — PARALLÈLE.** Les clés des règles sont disjointes par construction
     (`buildCounterKey` encode le nom de la règle ET le numéro de fenêtre) : les deux
     `increment` sont indépendants, aucun ne lit ce que l'autre écrit. Les séquentialiser
     ne faisait qu'additionner deux latences réseau sur le chemin le plus contraint du
     système. En parallèle, le contrôle coûte UN aller-retour de latence au lieu de N.

POURQUOI LA PHASE LOCALE RESTE SÉQUENTIELLE — ce n'est pas une inconséquence
Tout paralléliser reviendrait à incrémenter le compteur JOURNALIER d'un message que la
règle de RAFALE vient de refuser. Or un message refusé ne déclenche aucun appel LLM : il
ne consomme pas un token du budget Groq que la règle journalière existe pour protéger.
Le compter serait doublement nuisible — quelqu'un qui martèle le bot par accident (double
clic, boucle de script) brûlerait ses ≈12 messages du jour sans jamais obtenir une seule
réponse, et le seul garde-fou qui devait le protéger serait devenu l'instrument de sa
punition. La phase locale, qui est gratuite, tranche donc AVANT que quoi que ce soit ne
parte vers le store : elle est le filtre le plus fréquent (instance chaude) et le seul qui
doive rester strictement ordonné.

Reste un écart assumé, étroit : quand le compteur local passe mais que le PARTAGÉ refuse
(rafale répartie sur plusieurs instances), les compteurs des autres règles ont déjà été
incrémentés. Il est borné par la limite locale la plus basse et par instance — au plus
`BURST_RULE.limit` unités par minute et par instance — là où une parallélisation totale
l'aurait rendu illimité.

⚠️ À appeler APRÈS la déduplication. Un rejeu Slack n'est pas un nouveau message : le
compter consommerait le quota de quelqu'un pour un événement qu'il n'a envoyé qu'une
fois, et c'est précisément sur les démarrages à froid — donc quand le bot va déjà mal —
que Slack rejoue le plus.

@param options.answeredWithoutModel Le message sera-t-il traité SANS appel de modèle ?
  Les règles qui rationnent le budget du modèle (`rationsModelBudget`) sont alors
  ignorées — ni consultées, ni INCRÉMENTÉES. Ne pas incrémenter est aussi important que
  ne pas refuser : sans cela, une salutation gratuite consommerait quand même une unité
  du budget quotidien d'une vraie question. Les règles anti-abus, elles, s'appliquent
  toujours : un script qui inonde le bot de « bonjour » reste un script.

@param options.reserveOnly Évaluer les règles qui rationnent le modèle SANS les
  incrémenter — une réservation, pas une consommation. La consommation réelle revient à
  `consumeModelBudget`, appelée juste avant `agent.generate()`.

  ## Pourquoi ce mode existe

  `check()` vit sur le chemin de l'ACK, qui a 3 secondes ; la décision d'ABANDONNER un
  message (fil de canal où le bot n'a jamais parlé, ou dont l'auteur ne lui a jamais
  parlé) ne se prend que bien plus tard, en tâche de fond, une fois l'historique lu.
  Incrémenter à l'ACK débitait donc le budget quotidien de gens dont le message
  n'atteindrait JAMAIS un modèle : deux collègues se répondant dans un fil épuisaient
  leur quota sans consommer un seul token, puis leurs DM légitimes étaient refusés.

  ⚠️ Le compteur est PROJETÉ (`count + 1`) dans ce mode : la lecture rend l'état AVANT ce
  message, et le verdict doit porter sur l'état APRÈS. Sans cette projection, le dernier
  message d'un budget passerait deux fois.
**Avant `const applicable = options.answeredWithoutModel`**

BUDGET DE L'ÉQUIPE — évalué EN PREMIER, et sans rien incrémenter

Un budget d'équipe épuisé rend la suite sans objet : compter le message d'une personne

contre son quota individuel alors qu'aucun token n'est disponible lui ferait payer deux

fois un refus qu'elle ne peut pas éviter.
**Avant `const local = this.checkLocalCounters(applicable, subjectId, now, options);`**

Phase 1 — compteurs LOCAUX. Gratuits, donc évalués un par un et court-circuités.

**Avant `const workspaceRule = this.workspaceRule;`**

BUDGET DE L'ÉQUIPE — dans le MÊME lot parallèle, et lu EN PREMIER

Deux propriétés à préserver simultanément, et une seule forme les préserve toutes deux.

 - **Une seule latence réseau**, pas deux. Ce contrôle vit sur le chemin de l'ACK Slack,

   qui a 3 secondes ; y ajouter un aller-retour SÉQUENTIEL était une régression, et les

   tests de coût du chemin pré-ACK l'ont vue immédiatement. `by: 0` fait de cet appel

   une lecture atomique (voir le port), donc il peut voyager avec les incréments sans

   rien perturber.

 - **Le verdict de l'équipe PRIME.** Il est placé en tête de `pending`, et les verdicts

   sont relus dans l'ordre de ce tableau : c'est donc lui qui remonte jusqu'au message

   adressé à la personne, quel que soit l'ordre d'arrivée des réponses réseau.

Aucun compteur LOCAL, à la différence des règles par personne : un cumul de tokens par

instance ne veut rien dire, l'instance est remplacée en permanence, et c'est précisément

le total à travers toutes les instances qu'on cherche à borner.

⚠️ Contrepartie assumée, la même que celle déjà documentée plus haut : quand le budget

d'équipe refuse, les compteurs par personne ont déjà été incrémentés. Sans conséquence —

la personne est refusée de toute façon, et les deux fenêtres sont la même journée.
**Avant `by: 0,`**

Lecture seule : la consommation réelle est enregistrée APRÈS le run, quand

`usage.inputTokens` existe enfin. Voir `consumeTokens`.
**Avant `projected: false,`**

⚠️ PAS de projection ici, à la différence d'une réservation par personne : ce

compteur est en TOKENS et saute par milliers. Lui ajouter 1 n'aurait aucun sens, et

le dépassement est de toute façon constaté au message suivant (cf. `consumeTokens`).
**Avant `const repository = this.repository;`**

Phase 2 — store PARTAGÉ. Le seul qui compte pour un budget journalier, et le seul qui

coûte du réseau : il part donc d'un bloc.
**Avant `return { rule, key, count: read + (projected ? 1 : 0) };`**

Une lecture de réservation rend l'état AVANT ce message : on juge celui d'APRÈS.

**Avant `this.logDegradation(rule, error);`**

Journalisé ICI, à l'endroit où l'échec est connu : une panne du store ne doit

jamais être muette, même quand une autre règle tranche avant qu'on la lise.
**Avant `return this.readSharedVerdicts(outcomes);`**

Les verdicts sont relus DANS L'ORDRE DES RÈGLES, pas dans l'ordre d'arrivée des

réponses : `rules` est déclaré par priorité (« la règle la moins chère à déclencher

d'abord »), et c'est ce nom-là qui remonte jusqu'au message adressé à l'utilisateur.

Sans ce tri, la règle citée dépendrait de l'aléa réseau.
**Avant `private checkLocalCounters(`**

Phase 1 — les compteurs en mémoire. Gratuits, donc évalués un par un et court-circuités.

Rend soit un REFUS immédiat, soit la liste des incréments à porter au store partagé.
`projected` dit que le compteur lu n'inclura PAS ce message et qu'il faut donc l'ajouter
pour juger.

**Avant `const reserve = options.reserveOnly === true && rule.rationsModelBudget === true;`**

Une RÉSERVATION ne touche aucun compteur, ni local ni partagé : elle demande

seulement « ce message passerait-il ? ». C'est `consumeModelBudget` qui débite.
**Avant `return {`**

Le compteur partagé est nécessairement ≥ au local (il voit un sur-ensemble des

événements) : s'il est dépassé ici, il l'est là-bas. Refuser sans l'interroger est

donc correct, et épargne un aller-retour au moment précis où le trafic est le plus

dense.
**Avant `shouldNotify: localVerdict.shouldNotify && this.claimNotification(key),`**

⚠️ `claimNotification` et non le seul verdict — voir `readSharedVerdicts`, où

le même correctif est expliqué : sous RÉSERVATION le compteur n'avance pas,

donc l'égalité `count === limit + 1` reste vraie à CHAQUE message et la

protection se met à répéter son propre avertissement.
**Avant `private readSharedVerdicts(`**

Phase 3 — relire les verdicts DANS L'ORDRE DES RÈGLES, jamais dans l'ordre d'arrivée des
réponses réseau. `rules` est déclaré par priorité, et c'est ce nom-là qui remonte jusqu'au
message adressé à la personne : sans ce tri, la règle citée dépendrait de l'aléa réseau.

**Avant `shouldNotify: this.claimNotification(key),`**

⚠️ `evaluateCount` fonde `shouldNotify` sur une ÉGALITÉ EXACTE (`count === limit

+ 1`). C'est juste pour un compteur qui avance de 1 en 1 ; c'est INAPPLICABLE à

un compteur de tokens, qui saute par milliers et ne tombera jamais pile sur

`limit + 1`. Le budget d'équipe aurait donc refusé EN SILENCE — soit le symptôme

le plus coûteux de ce dépôt, le bot muet, produit par le garde-fou censé

l'éviter. On retombe ici sur « une fois par fenêtre et par instance », qui ne

peut pas se tromper dans ce sens-là.

⚠️ `claimNotification` est désormais la CONDITION, plus un simple repli — corrigé

le 2026-08-20. `evaluateCount` fonde `shouldNotify` sur une égalité exacte

(`count === limit + 1`), juste pour un compteur qui avance de 1 en 1. Or depuis

que le budget modèle est RÉSERVÉ à l'ACK et débité seulement avant

`agent.generate()`, un message refusé n'incrémente RIEN : le compteur lu reste

figé, l'égalité reste vraie, et « une fois, puis silence » était devenu « à chaque

message ». La limitation se transformait en son propre spam, c'est-à-dire

exactement ce que ce champ existe pour empêcher — et chaque publication est

elle-même un appel à l'API Slack.

Le budget de TOKENS, lui, ne tombe jamais pile sur `limit + 1` : c'est le cas qui

avait imposé le `||`. « Une fois par fenêtre et par instance » couvre les deux.
**Avant `async consumeModelBudget(subjectId: string, now: Date = new Date()): Promise<void> {`**

Débite le budget MODÈLE d'une personne — à appeler juste avant `agent.generate()`.

Contrepartie de `check(..., { reserveOnly: true })` : la réservation dit si le message
PASSERAIT, celle-ci acte qu'il a réellement coûté un appel de modèle. Séparer les deux est
ce qui empêche un message abandonné en tâche de fond — ou traité par un court-circuit
déterministe — de consommer un quota qu'il n'utilise pas.

⚠️ Le budget d'ÉQUIPE (`workspaceRule`) n'est PAS touché ici : il se compte en tokens, et
son débit réel a lieu après le run, quand `usage.inputTokens` existe (`consumeTokens`).

NE LÈVE JAMAIS, même doctrine que `consumeTokens` : une panne du compteur ne doit pas
priver quelqu'un d'une réponse. Le pire cas est un message de trop, visible et corrigeable.

**Avant `async consumeTokens(tokens: number | null | undefined, now: Date = new Date()): Promise<void> {`**

Enregistre le coût RÉEL d'un appel de modèle sur le budget de l'équipe.

⚠️ Appelée APRÈS le run, parce que `usage.inputTokens` n'existe pas avant. C'est la
contrepartie assumée du choix de compter des tokens : le message qui fait franchir le
seuil passe toujours, et le dépassement est constaté au suivant.

NE LÈVE JAMAIS. Elle vit sur le chemin de fond, après que la réponse a été postée : une
erreur ici ne doit rien changer pour la personne qui vient d'être servie.

**Avant `logger.info('Workspace token budget', { consumed, limit: rule.limit });`**

`info` et non `debug` : c'est la seule trace qui dise où en est le budget de la

journée, et c'est elle qu'on lira avant de lancer une campagne de test.
**Avant `private claimNotification(key: string): boolean {`**

Première fois qu'on refuse sur cette fenêtre, pour cette instance ?

Sert de repli à `shouldNotify` quand le compteur n'avance pas de 1 en 1 (voir le budget de
tokens). La clé porte déjà le numéro de fenêtre, donc l'ensemble ne se vide jamais : il
cesse simplement d'être consulté, et disparaît avec l'instance.

Imperfection assumée : deux instances peuvent prévenir deux fois. Prévenir en double est
visible et corrigeable ; ne pas prévenir du tout ne l'est pas — c'est l'arbitrage que ce
fichier applique déjà partout ailleurs.

**Avant `private logDegradation(rule: RateLimitRule, error: unknown): void {`**

 N'inonde pas les logs : un avertissement pour la vie de l'instance, pas un par message.

**Avant `async pruneExpired(now: Date = new Date()): Promise<void> {`**

 Purge opportuniste des fenêtres expirées. Aucun cron ne le fera.

## `features/notification/infrastructure/ui/welcome-blocks.ts`

**Avant `import { type SlackBlock } from '../providers/slack.adapter';`**

Blocs Block Kit du parcours « Compléter mon profil ».

## Pourquoi un module à part

Extrait de `slack-events.handler.ts` le 2026-08-17. Le handler cumulait huit
responsabilités sur 3 707 lignes ; celle-ci — la MISE EN FORME d'un message Slack —
est la plus facile à isoler et la plus souvent modifiée. Elle n'a besoin ni du client
Slack, ni d'un dépôt, ni de l'orchestration : rien que des données déjà résolues.

Le découpage suit la règle du dépôt : ce qui reste dans le handler, c'est
`accept`/`processEvent`/`handleMessage` et les dépôts paresseux — sa vraie
responsabilité. Tout le reste en sort.

**Avant `export function firstWordOf(fullName: string | undefined): string {`**

 Premier mot d'un nom complet — repli quand le profil Slack n'a pas de prénom.

**Avant `export function restAfterFirstWord(fullName: string | undefined): string {`**

 Reste du nom complet — repli quand le profil Slack n'a pas de nom de famille.

**Avant `export function greet(firstName: string): string {`**

 Salutation, avec ou sans prénom connu.

**Avant `export function channelsLine(joinedNames: readonly string[]): string {`**

DM d'accueil : un mot de bienvenue et le bouton qui ouvrira la modale.

Le `value` du bouton transporte tout ce que Slack sait déjà de l'arrivant.
C'est ce qui permet à la route d'interactivité d'ouvrir une modale
pré-remplie **sans aucune E/S** : le `trigger_id` expire en 3 secondes, et
refaire un `users.info` au moment du clic dépenserait ce budget pour une
information déjà en main.

Ligne citant les canaux où l'arrivant vient d'être ajouté.

VIDE quand il n'y en a aucun : annoncer « je t'ai ajouté à » suivi de rien serait pire que
le silence, et c'est le cas normal tant que `ONBOARDING_WELCOME_CHANNELS` n'est pas posée.
**Avant `export function buildWelcomeBlocks(`**

DM d'accueil : la vidéo, le guide écrit, puis « C'est fait ».

⚠️ L'ancien message disait « Il me manque une information — une minute suffit » et posait
directement le bouton du formulaire. Deux défauts, et le second est le plus grave :

 1. il ne DISAIT PAS ce qui allait être demandé, donc l'arrivant ouvrait la modale, y
   découvrait qu'il lui fallait son adresse pro, et la refermait ;
 2. il faisait dépendre le tout premier geste de l'accueil d'un `trigger_id` de 3 secondes,
   que le démarrage à froid rendait structurellement inatteignable.

La phrase de la vidéo DISPARAÎT quand aucune URL n'est résolvable — jamais un lien mort dans
le premier message de l'entreprise à quelqu'un. Depuis le 2026-08-19 la vidéo existe et son
URL est DÉDUITE du domaine de production (`onboarding-video.ts`) : elle n'est donc plus
conditionnée à une variable qu'on aurait pu oublier de poser.

**Avant `export function buildProfileInviteBlocks(): SlackBlock[] {`**

Le MÊME parcours, hors du flux d'arrivée.

## Ce qui a été corrigé le 2026-08-19

Ce chemin — celui de quelqu'un DÉJÀ dans le workspace qui demande son formulaire — était
resté sur l'ancien bouton « Compléter mon profil » : pas de vidéo, pas de guide écrit, et
surtout aucune vérification. Deux parcours pour la même tâche, dont un cassé par la même
cause que l'autre (le jeton d'ouverture d'une fenêtre expire en 3 s, le démarrage à froid
en prend 5). C'est exactement la divergence que ce dépôt traque : deux émetteurs pour un
même geste, et celui qu'on exerce le moins est celui qui pourrit.

Il reçoit donc désormais la vidéo, le guide et « C'est fait », comme l'arrivant.

⚠️ Seule la PHRASE D'OUVERTURE reste distincte, et c'est délibéré : « Ravi de t'accueillir
chez Kisso » adressé à quelqu'un qui est là depuis six mois sonne faux. Le reste est
partagé — le dupliquer garantirait qu'un jour les deux ne disent plus la même chose.

---

## Le budget modèle est PRIS, plus seulement lu (2026-08-20)

Depuis le 2026-08-15, le budget modèle n'est plus débité à l'ACK mais juste avant
`agent.generate()`. La raison est bonne et ne doit pas être défaite : un fil abandonné en
tâche de fond ne coûte alors rien à personne.

Mais la conséquence n'avait pas été traitée. `check()` en mode `reserveOnly` LISAIT le
compteur sans le poser, et le débit venait bien plus tard — tout le traitement les séparait.
N messages en vol lisaient donc le même compteur, passaient tous, puis débitaient tous. Sur
un système dont la contrainte dominante est un plafond de ≈ 19 messages par JOUR, c'est le
garde-fou de coût lui-même qui sautait, et sans aucun log de refus pour le signaler.

`claimModelBudget` remplace `consumeModelBudget` sur le chemin nominal. La prise est
ATOMIQUE : on incrémente, on regarde ce que l'incrément a rendu, et si l'on vient de dépasser
on REND la prise. Même forme que `clear()` sur l'email d'entretien — on prend d'abord, on agit
si la prise a réussi. C'est ce qui distingue une garde d'une supposition.

⚠️ La restitution couvre AUSSI la règle qui a causé le refus : elle avait incrémenté elle
aussi. Sans cela le compteur dérivait à chaque refus, et le plafond serait devenu un compteur
de TENTATIVES plutôt qu'un compteur de dépense — la personne aurait été pénalisée pour des
messages qui n'ont jamais atteint le modèle. Vérifié rouge avant correctif.

⚠️ Le refus réutilise `notifyRateLimited(channel, 'daily')`, jamais un texte neuf : les trois
textes de refus vivent dans `RATE_LIMIT_REPLIES` et un quatrième aurait divergé.

## La dégradation du compteur partagé se journalise à chaque fois (2026-08-20)

Le fail-open reste délibéré : un message de trop est visible, un bot muet ne l'est pas. Ce
qui ne l'était pas, c'est qu'il ne se journalisait qu'UNE FOIS PAR INSTANCE. Sur des
instances serverless éphémères, cela vaut une ligne par démarrage à froid — noyée, donc
invisible. Or dans cet état les règles se réduisent au compteur local, inopérant sur une
instance froide : c'est la protection du quota journalier qui disparaît entièrement.

La ligne porte désormais `firstInThisInstance`, ce qui permet de distinguer une panne
naissante d'une panne installée sans perdre les occurrences suivantes.

---

# La phrase HONNÊTE déclenchait le démenti (2026-08-21)

Sonde de production sur `scheduleReminder`. Le modèle a répondu exactement ce qu'on lui
demande :

> « Sache que ce rappel est seulement enregistré. Aucun automate ne l'enverra, **rien ne partira
> tout seul** le moment venu. »

C'est le comportement voulu. Et le motif `partira` de `FUTURE_DELIVERY_CLAIMS` s'est déclenché
dessus : une note a été accolée pour redire la même chose, en moins bien. La personne lisait
l'information deux fois, la seconde sous forme de démenti administratif — et c'est ce doublon
qui faisait « machine », bien plus que le vocabulaire.

⚠️ **Une phrase qui NIE la livraison est le contraire d'une promesse de livraison.** C'est la
famille de défaut corrigée dans `forget.ts` le 2026-08-13, où « je ne veux surtout pas que tu
oublies » DÉCLENCHAIT l'effacement : un verbe lu sans sa négation dit l'inverse de la phrase qui
le porte.

## Le filtre est appliqué PHRASE PAR PHRASE

`NEGATED_DELIVERY_PATTERN` écarte les phrases qui nient, puis les motifs sont testés sur ce qui
reste. À la différence de `HUMAN_GATED_PATTERN`, qui court-circuite globalement.

La raison est concrète : un filtre global ferait qu'il suffit d'ajouter « rien ne part tout
seul » n'importe où dans un message pour faire taire le détecteur sur tout le reste —
c'est-à-dire offrir une formule magique à ce qu'on surveille. Un test le vérifie explicitement
(« Rien ne partira tout seul. Elle recevra le message demain. » reste requalifié).

`splitSentences` est partagé avec `assertiveText`, qui écarte les interrogations pour le
détecteur d'accompli. Deux filtres, une seule façon de découper.

## Les deux notes parlent comme Marcel

Elles s'ouvraient par « Note : » et disaient « aucune action n'a été exécutée à ce tour » et
« il n'y en a aucun dans ce système » : trois marques d'un système qui s'annote lui-même. La
seconde est de l'architecture — la personne n'a que faire de savoir POURQUOI rien ne partira ;
il lui faut le fait, et le geste suivant.

⚠️ **Ce qu'elles AFFIRMENT n'a pas changé.** L'aveu doit rester net, c'est toute leur raison
d'être, et deux tests le verrouillent : la note de livraison dit toujours que l'enregistrement a
eu lieu ET que rien ne partira tout seul.

⚠️ **Un test verrouillait le MOT « automate »** alors que son propre commentaire décrivait une
PROPRIÉTÉ. Ce mot appartenait à la formulation d'architecte qu'on retirait : le test aurait
interdit la correction du ton tout en gardant l'apparence de protéger le fond. Réécrit sur les
deux moitiés de la propriété — ce qui a eu lieu, ce qui n'aura pas lieu.

---

## Décisions extraites du code le 2026-08-21

> Le code ne porte plus ce texte. L'ancre est la **déclaration**, jamais un numéro
> de ligne : l'audit du 2026-08-21 a mesuré 5 424 ancres `L.N` dont 153 exactes.
> Un numéro de ligne se périme au premier retrait de commentaire.

### `src/features/notification/application/agents/notification-agent.ts`

**Avant `export function makeNotificationAgent(tools: ToolsInput) {`**

⚠️ **UNE CONSIGNE RETIRÉE LE 2026-08-21, ET IL FALLAIT LA RETIRER : ELLE ÉTAIT DEVENUE FAUSSE.**

Elle disait « Un rappel est seulement ENREGISTRÉ : aucun automate ne l'enverra, dis-le sans
détour ». C'était exact jusqu'au cron quotidien (`domain/services/reminder-dispatch.ts`).
Depuis, elle demandait à Marcel d'affirmer quelque chose de FAUX — la faute que tout ce dépôt
est construit pour éviter, retournée contre lui.

⚠️ Elle n'est remplacée par RIEN. Le moment de remise n'est pas confié à une consigne : le
tool ne rend plus que `deliveredOn` (« le lundi 24 août 2026 au matin », sans heure) et le
handler accole la précision manquante. Une consigne est PROBABLE — celle-ci avait d'ailleurs
été mesurée en échec le 2026-08-19, la réponse suivante gagnant une heure d'envoi précise.
Le code est GARANTI, et il coûte zéro token par aller-retour.

### `src/features/notification/application/services/dispatch-due-reminders.ts`

**Avant `readonly stale: number;`**

Périmés : le jour est passé depuis plus d'une semaine. Annulés, jamais remis.

**Avant `export async function dispatchDueReminders(deps: DispatchDeps): Promise<DispatchReport> {`**

LA REMISE QUOTIDIENNE DES RAPPELS

Appelée par le cron Vercel, et par lui seul. Elle ne fait AUCUN appel de modèle : le sujet
et le corps ont été rédigés au moment de l'enregistrement, sous les yeux de la personne qui
les a demandés. Les refabriquer à la remise reviendrait à envoyer un texte que personne n'a
relu, et à payer un aller-retour par rappel sur un budget qui se compte à la journée.

⚠️ **L'ORDRE DES QUATRE GESTES EST TOUT** : on PREND, on résout, on envoie, on constate.
  - prendre AVANT d'envoyer ferme la course entre deux exécutions ;
  - rendre la prise sur un échec RÉPARABLE (transport, base) évite de perdre le rappel — la
    remise du lendemain le rattrapera ;
  - un destinataire introuvable n'est PAS réparable : on marque `failed` et on s'arrête là,
    sans quoi le même rappel repartirait en échec tous les matins jusqu'à la fin des temps.

**Avant `const stale = selectStaleReminders(pending, now);`**

⚠️ **LES PÉRIMÉS SONT ÉTEINTS AVANT TOUT LE RESTE.** Allumer un ordonnanceur réveille tout
ce qui dormait : le 2026-08-21, la première exécution a trouvé des lignes écrites des
semaines plus tôt, quand rien ne les reprenait. Sans cette extinction, un backlog de six
mois partirait par lots de 25, sur des jours, chez des gens qui n'ont rien demandé.

On ANNULE plutôt qu'on ne supprime : la trace reste lisible, et un rappel exhumé est un
mensonge de plus, pas un service rendu.

**Avant `logger.warn('Lot de rappels plafonné — le reste partira à la remise suivante', {`**

⚠️ Un plafond silencieux se lit comme « tout a été traité ». On le dit.

**Avant `const claimed = await deps.notifications.claimForDispatch(`**

── 1. LA PRISE ───────────────────────────────────────────────────────────

**Avant `let destination: string;`**

── 2. LE DESTINATAIRE ────────────────────────────────────────────────────

**Avant `logger.error('Résolution du destinataire impossible — la prise est rendue', {`**

Une base indisponible EST réparable d'ici demain : on rend la prise.

**Avant `const preamble = reminderPreamble(reminder.scheduledAt);`**

── 3. L'ENVOI ────────────────────────────────────────────────────────────

**Avant `const safe = safeOutboundText(`**

⚠️ **SECOND PASSAGE D'ASSAINISSEMENT, et ce n'est pas une redondance.**

`scheduleReminder` filtre désormais à l'écriture — mais la production porte des rappels
enregistrés AVANT ce correctif du 2026-08-21, et rien ne les relira jamais autrement que
par ce chemin-ci. Filtrer seulement à l'écriture n'aurait protégé que l'avenir.

C'est la même forme que `generateDocument`, qui filtre au seuil du rendu ET dans le tool :
la persistance vit en dehors du renderer, donc une ligne peut entrer par un autre chemin
que celui qu'on vient de fermer. L'opération est idempotente — un texte déjà propre en
ressort identique, ce qu'un test vérifie.

Et c'est ici que ça compte le plus : personne n'est présent au moment de cet envoi.

**Avant `await deps.notifications.update({`**

── 4. LE CONSTAT ─────────────────────────────────────────────────────────

### `src/features/notification/application/services/outbound-text.ts`

**Avant `export interface SafeOutboundText {`**

LE POINT UNIQUE PAR OÙ PASSE TOUTE PROSE DE MODÈLE QUI SORT DU PRODUIT

Trois chemins expédient un couple sujet/corps rédigé par le modèle : `sendNotification`
(immédiat), `scheduleReminder` (écriture) et `dispatchDueReminders` (remise, le lendemain).
Avant le 2026-08-21 ils avaient trois traitements DIFFÉRENTS — le premier filtrait son corps
et pas son sujet, les deux autres ne filtraient rien.

⚠️ **Ce module existe pour qu'il n'y ait plus rien à oublier.** La leçon est celle que ce
dépôt a déjà tirée pour `email-attachment-policy` : une borne écrite dans un adaptateur laisse
l'autre adaptateur libre de diverger, et le jour où l'on bascule de fournisseur, le produit
change silencieusement ce qu'il accepte de livrer. Ici, c'est ce qu'il accepte d'ÉMETTRE.

⚠️ **Le journal est en `error`, pas en `warn`, et c'est délibéré** : une notification assainie
signifie qu'un modèle a produit un marqueur interne ou un lien hors liste blanche dans un
texte destiné à un humain. Ce n'est jamais normal, même quand le filtre a fait son travail.

**Avant `export function safeOutboundText(`**

Assainit le couple et journalise si quelque chose a été retiré.

`context` sert uniquement au diagnostic — il ne doit porter que des identifiants, jamais la
prose elle-même : `maskPii` masque par NOM DE CLÉ, et une clé inventée ici échapperait au
masquage. C'est le défaut trouvé sur `inputPreview` le 2026-08-21.

### `src/features/notification/application/tools/schedule-reminder.ts`

**Avant `const safe = safeOutboundText(`**

⚠️ **ON ASSAINIT À L'ÉCRITURE, ET PAS SEULEMENT À LA REMISE.**

Deux raisons, et la seconde est celle qu'on oublie :
 1. le cron du 2026-08-21 expédie ce texte le lendemain matin, sans qu'aucun humain
    ne le relise — c'est le seul chemin sortant du produit dans ce cas ;
 2. la ligne est RELUE par `getNotificationHistory`, qui la rend au modèle. Un
    marqueur interne stocké ici ressortirait tel quel au premier tour suivant.

Le défaut dormait tant que rien ne partait. Allumer l'ordonnanceur l'a réveillé —
même mécanique que `onlyNonDeliveringTools` le même jour : **un assainisseur, comme
un détecteur, encode le câblage ; quand le câblage bouge, il faut le déplacer avec.**

**Avant `const delivery = deliveryLabel(scheduled.scheduledAt, new Date());`**

⚠️ **ON REND LE MOMENT DE REMISE, PAS LE MOMENT DEMANDÉ.**

Ce tool rendait `scheduledLabel: 'lundi 24 août 2026 à 09 h00'` — l'heure que la
personne avait dite. Le cron ne passe qu'UNE FOIS PAR JOUR (limite du plan Hobby,
±59 min de précision) : annoncer une heure serait promettre ce qu'aucune pièce de ce
système ne tient. Le modèle ne peut pas répéter une précision qu'on ne lui donne pas.

`willBeSentAutomatically` passe à `true`, et c'est enfin vrai — voir
`reminder-dispatch.ts` et `/internal/reminders/dispatch`.

### `src/features/notification/application/tools/send-notification.ts`

**Avant `const safe = safeOutboundText(`**

⚠️ **LE SUJET AUSSI — trouvé par l'audit du 2026-08-21.** Le `body` était filtré depuis
la veille, le `subject` partait BRUT à deux caractères de là, sur les deux transports.
C'est pourtant la partie la plus visible d'un email et la ligne en gras d'un message
Slack, et son `.describe()` ORDONNE au modèle de le rédiger. Une asymétrie dans une
défense délibérément construite, pas une défense absente.

**Avant `subject: safe.subject,`**

Ce qui est PERSISTÉ est ce qui a été ENVOYÉ, jamais le brut : `getNotificationHistory`
relit cette ligne et la rend au modèle. Y laisser un marqueur interne le ferait
ressortir au premier tour suivant — c'est le défaut `documents.content`, à l'envers.

### `src/features/notification/domain/ports/notification.repository.ts`

**Avant `claimForDispatch(id: string, strandedBefore?: Date): Promise<boolean>;`**

⚠️ **LA PRISE EST L'ÉCRITURE, et elle REND UN COMPTE.** Même contrat que `clear()` sur les
emails d'entretien en attente, et pour la même raison : deux exécutions du cron — ou un
rejeu Vercel — ne doivent pas remettre deux fois le même rappel à quelqu'un.

Un `findPending()` suivi d'un `update()` conditionnel côté application — la forme
« naturelle » — rouvrirait la course, et son symptôme serait un doublon dans la boîte de
quelqu'un. Ici l'`UPDATE … WHERE status IN (…)` est atomique : le second appelant obtient
`false` et s'arrête.

Rend `true` si ce processus-ci a bien pris le rappel, `false` si quelqu'un d'autre l'avait.

⚠️ `strandedBefore` est la date avant laquelle une prise EN COURS est réputée ABANDONNÉE —
une invocation tuée entre la prise et l'envoi (dépassement de `maxDuration`, redéploiement,
incident). Sans cette reprise, le rappel resterait `sending` à jamais, invisible de
`findPending()` : perdu EN SILENCE, ce qui est pire qu'un doublon — un doublon se voit.

**Avant `cancelIfPending(id: string, recipientId: string): Promise<boolean>;`**

Annuler un rappel qui n'est pas encore parti — et RENDRE UN COMPTE.

⚠️ MÊME FORME QUE `claimForDispatch`, ET POUR LA MÊME RAISON. Le cron tourne à 6 h et peut
être en train de remettre le rappel à l'instant où la personne demande de l'annuler. Un
`findById` puis un `update` inconditionnel — la forme « naturelle » — écraserait le statut
d'un rappel DÉJÀ PARTI, et Marcel répondrait « c'est annulé » d'un message que la personne a
sous les yeux. C'est le compte, et lui seul, qui décide de la phrase.

⚠️ LE `recipientId` EST DANS LA CLAUSE, PAS SEULEMENT CHEZ L'APPELANT. La portée devient
STRUCTURELLE : il n'existe aucun chemin, présent ou futur, par lequel l'annulation touche le
rappel d'un tiers. Un filtre côté appelant est un filtre qu'on peut oublier de rappeler — et
ce dépôt a déjà payé cette leçon avec `slack_directory.employee_id`, écrite par un chemin et
lue par aucun.

**Avant `releaseClaim(id: string): Promise<void>;`**

Rend la prise. Sur un échec de TRANSPORT rien n'est parti : garder le rappel en « envoi en
cours » le perdrait pour toujours, alors que la remise du lendemain le rattraperait.

### `src/features/notification/domain/services/agent-routing.ts`

**Avant `const RECALL_QUESTION_PATTERN = new RegExp(`**

⚠️ CETTE BANDE EST UNIQUEMENT INTERROGATIVE — aucun mot-clé nu.

La première version portait `décidé|décision|convenu`, et un test de non-régression
PRÉEXISTANT l'a attrapée sur-le-champ : « je conteste cette décision » partait chez
`knowledgeAgent`. Même critère que celui qui avait fait écarter « ajoute » et « word » —
un mot très courant du français ne désigne pas une capacité. La FORME de la question, elle,
ne se prononce que pour demander ce qui s'est dit.

**Avant `'${LB}(?:qu${APOS}?est-ce\\s+qu|qu${APOS}?a-t-on|qu${APOS}?avons-nous|de\\s+quoi)${APOS}?\\s*' +`**

⚠️ Le séparateur est `${APOS}?\\s*` et non `\\s+` : « qu'est-ce qu'ON a dit » n'a AUCUN
espace après « qu », et cette seule exigence faisait échouer la formulation la plus
courante des trois. Attrapé par un test, jamais à la lecture.

**Avant `overridesSticky: true,`**

⚠️ `true`, et il a fallu une mesure en production pour le trancher. Posé d'abord à
`false` par prudence, la bande n'a JAMAIS tiré : en DM la clé de conversation est le
canal, donc le palier collant verrouille tous les sujets pendant une heure — c'est l'état
absorbant corrigé le 2026-08-11, et il rendait la base inatteignable dans le seul cas qui
compte. Journal du 2026-08-20 : `agentId: onboardingOrchestrator, sticky: true`.
La règle d'admission est respectée : `searchKnowledge` n'est porté que par UN agent, et
le délogement n'a lieu que si le fil en cours ne l'a pas. Le motif est purement
INTERROGATIF, donc il ouvre toujours une tâche neuve — c'est pour cela que
« on avait dit jeudi », qui peut CONTINUER une discussion d'agenda, en a été retiré.

**Avant `const KNOWN_AGENT_IDS: ReadonlySet<string> = new Set(Object.keys(AGENT_TOOLS));`**

⚠️ **DÉRIVÉE de `AGENT_TOOLS`, plus recopiée — 2026-08-21.**

C'était une TROISIÈME copie du câblage agent→outils, après `src/mastra/index.ts` (le vrai) et
`AGENT_TOOLS`. Aucun test ne la confrontait aux deux autres : un agent ajouté au registre et
oublié ici aurait vu son fil COLLANT ignoré en silence, donc reroute à chaque message — et le
symptôme (« il perd le fil ») ne désigne jamais une liste d'identifiants.

L'ensemble est maintenant impossible à désynchroniser de la table qui déclare les outils :
un agent sans outil déclaré n'existe pas pour le routage, ce qui est exactement la propriété
qu'on veut — le palier collant ne doit jamais renvoyer vers un agent dont on ignore ce qu'il
sait faire.

### `src/features/notification/domain/services/claim-reconciliation.ts`

**Avant `function splitSentences(normalized: string): Array<{ text: string; delimiter: string }> {`**

⚠️ UNE AFFIRMATION DANS UNE QUESTION N'EST PAS UNE AFFIRMATION.

Ce filtre est passé AVANT tous les motifs, et il protège les six d'origine autant que ceux
ajoutés pour le ton de Marcel. Sans lui, « Tout est bon pour toi ? » et « Est-ce que ça y
est ? » se font requalifier — c'est-à-dire qu'on accole un démenti à une QUESTION, ce qui
n'a aucun sens pour la personne qui lit.

Le contrat de ce détecteur est de constater une CONTRADICTION entre ce que la réponse
affirme et ce que la trace d'exécution montre. Une interrogation n'affirme rien : il n'y a
rien à contredire. Élargir les motifs sans poser ce filtre d'abord aurait multiplié les faux
positifs exactement à la vitesse où l'on gagnait en couverture.

Les segments retenus sont recollés par « . » et non par un espace : sans séparateur, la fin
d'une phrase et le début de la suivante formeraient des expressions qu'aucune des deux ne
contient.

**Avant `const ACCOMPLISHMENT_CLAIMS: ReadonlyArray<{ label: string; pattern: RegExp }> = [`**

⚠️ LISTE FERMÉE, MAIS PLUS LARGE QU'ELLE NE L'ÉTAIT — et l'ordre des deux gestes compte.

Ce dépôt avait REFUSÉ tout ton chaleureux, avec cet argument, consigné dans `CLAUDE.md` :
« un modèle invité à varier ses formules écrirait "voilà, ton document t'attend" — hors
motif, donc non requalifié. Demander de la variété au modèle DÉGRADE le seul détecteur de
fausses annonces. »

L'argument est juste, et il n'interdit pas le ton : il interdit de changer le ton AVANT le
détecteur. Les familles ci-dessous sont donc les façons NATURELLES d'annoncer un travail
fait — celles qu'un collègue emploie et que les six motifs d'origine, tous construits sur
des tournures administratives, laissaient toutes passer.

`tests/unit/notification/claim-detection-warmth.test.ts` verrouille les deux bords : ce qui
doit être attrapé, et ce qui ne doit surtout pas l'être.

**Avant `{`**

⚠️ À partir d'ici : les formules de COLLÈGUE, ajoutées avec le ton de Marcel.

**Avant `label: 'voilà',`**

« Voilà ce dont j'ai besoin » et « voilà pourquoi » sont des CHARNIÈRES de discours, pas
des annonces : le motif exige donc un livrable derrière, jamais « voila » nu.

**Avant `label: 'ça y est',`**

« Est-ce que ça y est ? » est déjà écarté par le filtre interrogatif ; le lookbehind
couvre la forme sans point d'interrogation (« je me demande si ça y est »).

**Avant `label: 't’attend',`**

« je t'attends » n'est pas une livraison : le `s` final et le sujet « je » l'excluent.

**Avant `export const ACCOMPLISHMENT_CLAIM_LABELS: readonly string[] = ACCOMPLISHMENT_CLAIMS.map(`**

Les libellés, exposés pour qu'un test de ton puisse raisonner sur la COUVERTURE sans relire
les motifs. La liste d'origine était fermée ET muette : le seul moyen de savoir si une
formule était couverte était de dérouler les regex à la main.

**Avant `export const UNSUPPORTED_CLAIM_NOTICE =`**

⚠️ CETTE NOTE CONTREDIT MARCEL, donc elle doit parler comme lui — sans quoi le changement de
registre trahit à lui seul qu'une machine vient de reprendre la main.

Elle s'ouvrait par « Note : » et disait « aucune action n'a été exécutée à ce tour » : deux
marques d'un système qui s'annote lui-même. Ce qui ne change PAS est ce qu'elle affirme —
l'aveu doit rester net, c'est toute sa raison d'être.

**Avant `export function promisesWithoutActing(toolCalls: readonly string[]): boolean {`**

LA PRÉMISSE DE CE DÉTECTEUR A CHANGÉ LE 2026-08-21 — et c'est le point de méthode

`onlyNonDeliveringTools` a été SUPPRIMÉE. Son ensemble ne contenait qu'un nom,
`scheduleReminder`, et sa raison d'être tenait en une phrase : ce tool enregistrait une
ligne que rien ne reprenait. Depuis que le cron quotidien existe
(`domain/services/reminder-dispatch.ts`), le rappel PART. Garder le garde-fou tel quel
reviendrait à faire démentir une phrase VRAIE — la faute exactement symétrique de celle
qu'il corrigeait.

⚠️ **Un détecteur encode le CÂBLAGE. Quand le câblage bouge, il doit bouger avec, sinon il
ment dans l'autre sens.** Même famille que `READ_ONLY_TOOL_NAMES`, qui gardait `getTaskList`
après son retrait et ignorait `findPersonByName` ajouté le même jour : un détecteur périmé
n'est pas neutre, il est faux.

Ce qui RESTE vrai, et pourquoi la fonction n'est pas simplement effacée : promettre une
livraison alors qu'AUCUN outil agissant n'a tourné reste un mensonge. La condition passe donc
de « seuls des outils non livrants ont tourné » à « aucun outil agissant n'a tourné ». Le
même garde-fou, sur la seule prémisse qui tienne encore.

**Avant `const ENCLITIC = "(?:(?:le|la|lui|les|leur|vous|nous|te|me) |[ltm]')";`**

⚠️ **`l'` MANQUAIT, et avec lui les DEUX formes les plus courantes en français** — trouvé le
2026-08-21 en écrivant le test de la prémisse retournée. La liste tenait `le `, `la `, `vous `
et l'élidé `t'`, mais pas l'élidé `l'` : « je te **l'**enverrai lundi » et « je vous
**l'**enverrai » n'étaient détectés par RIEN. Le motif couvrait « je le enverrai », que
personne n'écrit, et manquait ce que tout le monde écrit.

Même famille que « je veux en finir », absent du détecteur de détresse jusqu'au même jour :
une liste rédigée d'un trait couvre ce qu'on a en tête, pas ce que les gens tapent. Le seul
remède est de l'exercer sur des phrases réelles — d'où les formes énumérées dans
`tests/unit/notification/promised-delivery.test.ts`.

**Avant `const NEGATED_DELIVERY_PATTERNS: readonly RegExp[] = [`**

⚠️ UNE PHRASE QUI NIE LA LIVRAISON EST LE CONTRAIRE D'UNE PROMESSE DE LIVRAISON.

Relevé en production le 2026-08-21, sur une sonde `scheduleReminder`. Le modèle a répondu
exactement ce qu'on lui demande — « Aucun automate ne l'enverra, rien ne partira tout seul
le moment venu » — et le motif `partira` s'est déclenché dessus. Une note a donc été accolée
pour redire la même chose, en moins bien : la personne lisait l'information deux fois, la
seconde sous forme de démenti administratif.

C'est la famille de défaut corrigée dans `forget.ts` le 2026-08-13, où « je ne veux surtout
pas que tu oublies » DÉCLENCHAIT l'effacement : un verbe lu sans sa négation dit l'inverse
de la phrase qui le porte.

⚠️ LE FILTRE EST APPLIQUÉ PHRASE PAR PHRASE, jamais au message entier — à la différence de
`HUMAN_GATED_PATTERN`, qui court-circuite globalement. Sinon il suffirait d'ajouter « rien ne
part tout seul » n'importe où pour faire taire le détecteur sur tout le reste du message,
c'est-à-dire d'offrir une formule magique à ce qu'on surveille.

**Avant `function negatesDelivery(sentence: string): boolean {`**

⚠️ Une LISTE et non une seule alternation : le motif unique franchissait le seuil de
complexité du linter (21 pour 20), et surtout il devenait illisible — or c'est un garde-fou
qu'on relira en cherchant pourquoi une phrase n'a pas été attrapée. Un test par formule.

**Avant `export const PROMISED_DELIVERY_NOTICE =`**

⚠️ **CETTE NOTE A CHANGÉ DE SENS LE 2026-08-21, parce que le produit a changé.**

Elle disait : « je ne sais pas te relancer tout seul le jour venu — repasse me le demander ».
C'était exact et c'était le défaut : ce n'est pas ce qu'on attend d'un rappel. Le cron
quotidien le fait désormais partir, donc la note n'a plus à s'excuser — elle a à dire QUAND,
puisque la remise a lieu le matin et non à l'heure demandée.

Elle ne s'accole que lorsqu'une promesse de livraison a été faite SANS qu'aucun outil
agissant n'ait tourné : là, rien n'a été enregistré, donc rien ne partira.

### `src/features/notification/domain/services/rate-limit-policy.ts`

**Avant `export const DAILY_RULE: RateLimitRule = {`**

⚠️ CES DEUX PLAFONDS ÉTAIENT DES DÉCALQUES DU QUOTA GROQ, ET IL N'EST PLUS LE PRIMAIRE.

Ils ont été dimensionnés sur les 100 000 tokens par JOUR de Groq, qui bornaient tout le
produit à ≈ 19 messages quotidiens pour l'organisation entière — la contrainte qui
gouvernait chaque décision de coût de ce dépôt. Gemini est passé primaire le 2026-08-20
et n'a pas ce plafond ; garder les anciennes valeurs ferait du garde-fou LUI-MÊME la
limite qui casse la production, ce qui est le contraire de son rôle.

Ce qu'ils gardent : ils ne protègent plus un quota de fournisseur, ils protègent contre
une BOUCLE — un automate ou une injection qui ferait parler le bot sans fin. C'est
pourquoi ils sont relevés et non retirés, et pourquoi `BURST_RULE` ne bouge PAS : une
rafale reste une rafale, quel que soit le quota derrière.

### `src/features/notification/domain/services/reminder-dispatch.ts`

**Avant `export const REMINDER_DISPATCH_PATH = '/internal/reminders/dispatch';`**

CE QUI FAIT PARTIR UN RAPPEL — et pourquoi rien ne le faisait avant

`scheduleReminder` écrivait une ligne en base et le disait sans détour : « Aucun automate ne
le reprend : rien ne part seul. » C'était exact — et ce n'est pas un rappel. Dans ce système
RIEN NE S'EXÉCUTE tant que personne ne frappe à la porte : la fonction Vercel ne vit que le
temps d'une requête HTTP, il n'existe aucun processus long, et `findPending()` — pourtant
écrite et correcte — n'avait AUCUN site d'appel. La cause n'était donc ni un oubli ni une
paresse : il manquait la seule chose qu'un serverless ne peut pas se donner à lui-même, une
HORLOGE EXTÉRIEURE.

Le cron Vercel est cette horloge. Il frappe à la porte une fois par jour, et c'est tout ce
qui manquait.

⚠️ **LA GRANULARITÉ EST UN FAIT DE PLATEFORME, PAS UN CHOIX.** Le plan Hobby n'autorise
qu'une exécution PAR JOUR (« Cron expressions that would run more frequently will fail
during deployment ») et ne garantit l'heure qu'à ±59 min. Un rappel demandé « pour lundi
9 h » ne peut donc pas partir à 9 h 00. Deux erreurs possibles, et elles ne se valent pas :
arriver le MATIN du bon jour, ou arriver le LENDEMAIN. On choisit le bon jour — un rappel
est un objet à granularité de JOURNÉE dans l'usage réel.

⚠️ **CE MODULE EST DONC AUSSI CE QUI EMPÊCHE MARCEL DE PROMETTRE UNE HEURE.** `deliveryLabel`
nomme le moment RÉEL de remise, jamais celui qui a été demandé. Le tool rendait
« lundi 24 août 2026 à 09 h00 » : une précision que la plateforme ne peut pas tenir, donc
la même famille de mensonge que `emailSent: false` sous `status: 'success'`.
⚠️ **LA VÉRITÉ VIT DANS `vercel.json`, PAS ICI.** C'est elle que Vercel lit, et
`fix-vercel-output.js` la RECOPIE dans `config.json` au build plutôt que d'en tenir une
seconde. Cette constante est le miroir dont le code a besoin pour calculer une date de
remise, et `tests/unit/notification/reminder-dispatch-wiring.test.ts` échoue si les deux
divergent. Une planification écrite à deux endroits finit par dire deux choses, et le jour
où ça arrive personne ne le voit : le rappel part simplement à la mauvaise heure.

**Avant `export const MAX_REMINDERS_PER_RUN = 25;`**

Une exécution ne traite qu'un lot borné. Sans borne, un incident (base repartie, horloge
fausse) enverrait d'un coup tout l'historique — et une rafale de courriels est irréversible.

**Avant `export const STALE_AFTER_DAYS = 7;`**

⚠️ **ALLUMER UN ORDONNANCEUR RÉVEILLE TOUT CE QUI DORMAIT — constaté en production le
2026-08-21, à la première exécution.**

`scheduleReminder` écrivait des lignes `scheduled` depuis des semaines, et rien ne les
reprenait : elles étaient inertes. À la seconde où la remise a existé, **trois rappels échus
de la veille sont partis pour de bon**, et onze autres attendaient leur jour. C'était correct
— et c'est exactement le mode de panne qu'on aurait eu en pire si la table avait porté six
mois d'historique : une avalanche, le jour de la mise en service, sans que personne l'ait
demandée.

Le plafond par exécution borne la RAFALE, pas le BACKLOG : il l'étale sur des jours.

Au-delà de cette péremption, un rappel n'est plus rendu, il est ANNULÉ. « Je te rappelle ceci
pour le 20 juillet » remis le 21 août n'est pas un service, c'est de la confusion — et une
personne qui reçoit ça n'a aucun moyen de savoir si c'est un bug ou une intention.

⚠️ Sept jours, et pas moins : rater d'un jour ou deux doit rester rattrapable, c'est toute la
raison d'être de la reprise. Ce qu'on refuse est l'exhumation, pas le retard.

**Avant `export const STRANDED_CLAIM_MS = 6 * 60 * 60 * 1000;`**

⚠️ **UNE PRISE QUI NE SE TERMINE JAMAIS PERDRAIT LE RAPPEL POUR TOUJOURS.**

On prend AVANT d'envoyer, et l'état de prise (`sending`) sort le rappel de `findPending()` —
c'est précisément ce qui interdit le doublon. Mais une fonction Vercel peut être tuée entre
les deux : dépassement de `maxDuration`, redéploiement, incident de plateforme. Le rappel
resterait alors `sending`, invisible de toute exécution ultérieure, et personne ne le saurait.

C'est le mode de panne que ce dépôt traque partout : pas une erreur, un SILENCE. Même forme
que `Reprocessing an abandoned Slack event` — au-delà d'une grâce, on considère que
l'invocation qui tenait la prise est morte, et on reprend.

⚠️ La grâce doit dépasser très largement `maxDuration` (60 s) : la reprendre trop tôt
rouvrirait la course qu'on vient de fermer, et le symptôme serait un doublon dans la boîte
de quelqu'un. Six heures, contre une remise quotidienne : on ne peut rater qu'un seul tour.

**Avant `function localDayKey(at: Date, timeZone: string): string {`**

Le jour civil, dans le fuseau d'affichage — jamais en UTC. À 23 h à Cotonou on est déjà
demain en UTC+2 et encore hier en UTC-5 : comparer des jours sans fuseau, c'est se tromper
de journée une fois sur trois.

**Avant `export function isDueForDispatch(`**

Le rappel est DÛ dès que le jour demandé est arrivé — pas à l'heure demandée.

⚠️ Attendre l'heure exacte serait le pire des deux mondes : la remise quotidienne a lieu le
matin, donc un rappel « lundi 9 h » ne serait vu comme dû qu'à la remise du MARDI. Le
garde-fou censé éviter d'arriver trop tôt ferait systématiquement arriver un jour trop tard.

**Avant `export function isStaleReminder(`**

Périmé : le jour est passé depuis trop longtemps pour que la remise ait encore un sens.
Distinct de « pas encore dû » — c'est un état terminal, pas une attente.

**Avant `export function nextDeliveryAt(scheduledAt: string, now: Date): Date | null {`**

Le moment où ce rappel sera RÉELLEMENT remis : la remise quotidienne du jour demandé, ou
celle du lendemain si celle d'aujourd'hui est déjà passée.

⚠️ Rendu au modèle À LA PLACE de la date demandée. Il n'a alors aucune occasion d'annoncer
une heure — non parce qu'on le lui interdit (une consigne est PROBABLE), mais parce que la
précision n'est plus dans sa fenêtre.

**Avant `while (run.getTime() < now.getTime()) run.setTime(run.getTime() + DAY_MS);`**

Demandé pour aujourd'hui après la remise du matin, ou pour une heure déjà passée : la
prochaine horloge est celle de demain. On ne peut pas remonter le temps, on le dit.

**Avant `export function reminderPreamble(`**

⚠️ LA MISE EN CONTEXTE EST ÉCRITE PAR LE CODE, jamais par le modèle.

Un message qui arrive seul, des jours plus tard, sans dire d'où il vient, se lit comme un
message spontané du bot — donc comme une initiative qu'il n'a pas prise. Nommer la demande
et sa date est ce qui en fait un RAPPEL plutôt qu'une interruption.

Le sujet et le corps, eux, restent ceux qui ont été enregistrés : les refabriquer à la
remise reviendrait à envoyer un texte que personne n'a relu.

### `src/features/notification/infrastructure/handlers/slack-events.handler.ts`

**Avant `knowledgeErasure?: KnowledgeErasurePort | null;`**

⚠️ **INJECTÉ, comme l'ingestion, et JAMAIS fabriqué ici.** Ce handler fabrique déjà six
dépôts Drizzle en interne, ce qui est la cause racine documentée du piège de tests
(« HUIT dépendances à neutraliser », la suite rouge un run sur trois par lenteur). On
n'en ajoute pas un septième.

Absent ou `null` ⇒ l'archive n'est pas touchée et la réponse ne prétend RIEN à son sujet.

**Avant `function buildAuthorizationNotice(requestContext: unknown, answer: string): string {`**

⚠️ UN REFUS QUI NE DIT PAS POURQUOI SE LIT COMME UNE PANNE.

Mesuré en production : « Je ne peux pas créer cette invitation. » — exact, et muet. Le `hint`
du tool demandait la raison, l'agent a pour instruction de le reprendre, et il ne l'a pas
fait. Cinquième consigne mesurée en échec dans ce dépôt.

⚠️ La note S'EFFACE quand la réponse nomme déjà la personne — même arbitrage que
`buildRecipientNotice` : une redite sur une réponse déjà juste n'est que du bruit, et le
bruit finit par faire ignorer les notes qui comptent.

**Avant `const CHANNEL_TOKEN = /<#C[^>]{1,140}>/i;`**

⚠️ **QUAND LE RAPPEL ARRIVERA — dit par le code, jamais par le modèle.**

Le rappel part pour de bon depuis le 2026-08-21, mais la remise est QUOTIDIENNE : le matin
du jour demandé, à ±59 min près (limite du plan Hobby). Le modèle n'a jamais l'heure dans sa
fenêtre — le tool ne lui rend que `deliveredOn` — mais il peut la reprendre de la demande de
la personne, qui l'a écrite juste avant. C'est le seul chemin par lequel une précision que
rien ne tient pourrait ressortir, et on le ferme ici.

⚠️ La note S'EFFACE si la réponse dit déjà « au matin » : le doublon de démenti relevé le
2026-08-21 est venu d'une note qui redisait ce que la phrase disait déjà.
« TRANSMETS-MOI LE TEXTE » — le contournement que le modèle proposait

Mesuré en production le 2026-08-21. « Récapitule `<#CMLKC4S5T>` et envoie-le-moi en PDF »
contient `pdf`, donc part chez `onboardingOrchestrator` (bande 3, position 1) — qui ne porte
PAS `getChannelHistory`. Son refus était CORRECT et la quarantaine §4.2 a fonctionné : aucun
agent ne réunit lecture agrégée et écriture externe.

Deux choses ne l'étaient pas :
 1. il PROPOSAIT un contournement — « transmets-moi le texte, je ferai le PDF ». Bénin (le
    demandeur a déjà le texte), mais cela apprend à passer autour d'une frontière ;
 2. il ANNONÇAIT l'adresse email du demandeur, que personne ne lui avait demandée.

⚠️ **LE PROMPT LE LUI INTERDISAIT DÉJÀ** — « Rédige `content` TOI-MÊME, ne le demande
jamais » — et il l'a fait quand même. C'est la sixième consigne d'agent mesurée en échec sur
ce dépôt. Une consigne est PROBABLE, le code est GARANTI : on n'ajoute donc pas une phrase au
prompt, on accole une note déterministe qui dit où la demande aboutit réellement.

⚠️ **On ne réécrit PAS le routage.** Faire gagner le jeton de canal sur `pdf` déplacerait la
demande vers un agent qui, lui, ne sait pas produire de document : on échangerait un demi-refus
contre un autre. Le routage par capacité est correct ; c'est la RÉPONSE qui manquait d'issue.
Hauteur d'étoile 1 : voir `mention-names.ts` — l'entrée vient d'un tiers, pas de backtracking.

**Avant `if (agentHasTool(agentId, 'getChannelHistory')) return '';`**

Dérivé du câblage : si l'agent qui a répondu SAIT lire un canal, il n'y a rien à rediriger.

**Avant `if (/demande-moi (?:seulement |simplement )?le r[ée]sum[ée]/i.test(answer)) return '';`**

Il a peut-être déjà dit la bonne chose — on ne double pas une réponse juste.

**Avant `export const REMINDER_UNDO_HINT = ' Dis-moi « annule le rappel » si tu changes d’avis.';`**

⚠️ UNE CAPACITÉ RÉVERSIBLE QUE PERSONNE NE SAIT INVOQUER N'EXISTE PAS. Ajouté le
2026-08-25 avec le court-circuit d'annulation. C'est la situation du bouton « Compléter
mon profil » avant `profile-request.ts` : il était RÉELLEMENT émis, et personne d'autre
qu'un nouvel arrivant ne pouvait l'obtenir. La sortie est donc offerte à l'endroit exact
où le geste vient d'être fait, par le CODE — pas par une consigne d'agent, dont ce dépôt a
mesuré trois échecs.
⚠️ Et elle est offerte sur les TROIS chemins de la note, pas sur le plus fréquent : sinon
la découvrabilité dépendrait de la formulation du modèle, c'est-à-dire de rien.
⚠️ `tests/unit/quality/taught-phrases.test.ts` EXTRAIT cette phrase du code et exige qu'un
prédicat la reconnaisse. Le lien entre les deux bords n'est donc pas une intention, il est
vérifié — c'est ce même test qui a rougi ici avant que le prédicat ne soit enregistré.

**Avant `if (answer.includes(label) || /au matin\b/i.test(answer)) {`**

La réponse dit déjà la date : il ne reste que la façon de défaire le geste.

**Avant `const day = label.replace(/^le /i, '').replace(/ au matin$/i, '');`**

⚠️ La note ne REDIT pas la date quand l'agent vient de la donner. Mesuré en production le
2026-08-21 : « Rappel programmé pour le lundi 24 août 2026. » suivi de « Je te le
remettrai lundi 24 août 2026 au matin » — l'information utile (le matin, une fois par
jour) noyée dans une répétition. Même arbitrage que `buildRecipientNotice` : une note qui
se répète finit par se faire ignorer, y compris quand elle compte.
⚠️ Bornes SIMPLES et non `\s+` : `sonarjs/super-linear-regex` signale le retour arrière que
produit un quantificateur en tête ou en queue de motif, et ce dépôt tient son lint à zéro
warning. Le libellé est produit par `deliveryLabel`, sa forme est connue exactement.

**Avant `{ ...BURST_RULE, limit: readRuleLimit(process.env.SLACK_BURST_LIMIT, BURST_RULE.limit) },`**

⚠️ CES VARIABLES ÉCRASENT LES CONSTANTES, ET LE PIÈGE S'EST REFERMÉ LE 2026-08-21.
`SLACK_DAILY_LIMIT` et `SLACK_WORKSPACE_TOKEN_BUDGET` étaient posées en production
depuis une semaine : relever les défauts dans `rate-limit-policy.ts` n'a RIEN
changé, et le journal continuait d'afficher l'ancien plafond. Avant de conclure
qu'un plafond n'a pas bougé, lire `npx vercel env ls production`.

**Avant `private checkTeamId(envelope: SlackEventEnvelope): SlackEventDecision | undefined {`**

⚠️ **LA RÈGLE VIT DANS `shared/slack-team.ts` DEPUIS LE 2026-08-21, et elle y vit parce
qu'elle a DEUX consommateurs.** `/slack/interactions` ne la posait pas du tout, alors que
son payload porte `team.id` — déclaré dans le type, lu nulle part. Recopier la règle ici et
là était exactement ce qui avait produit la divergence ; on la partage.

**Avant `let removedArchive = 0;`**

⚠️ **L'ARCHIVE PART AUSSI, MAIS SEULEMENT EN DM ET SEULEMENT POUR CE CANAL.**

Depuis le 2026-08-21 les DM sont archivés (`channel_messages`, `ARCHIVED_CHANNEL_TYPES`
inclut `im`) et le manager peut les relire. Dire « c'est effacé » en laissant l'archive
du DM intacte serait un mensonge par omission sur la donnée la plus sensible du lot.

⚠️ **En fil de CANAL, on ne touche à rien**, et ce n'est pas de la prudence : le
demandeur y agit sur ses propres tours, pas sur la mémoire collective du canal. Un
`forgetUser` global effacerait, sur une phrase en passant, un an de décisions d'équipe
qu'une autre personne lira demain. Même règle que `ConversationRepository.forget` —
« une portée indéterminée sur une suppression, c'est le fil entier ».

L'effacement GLOBAL existe, et c'est un geste d'administration explicite :
`npm run knowledge:forget -- --user <U…>` (dry-run par défaut).

**Avant `text: archivePartial`**

⚠️ Sur un effacement PARTIEL, on ne dit jamais « c'est effacé » : le contrat de ce
court-circuit est qu'il ne prétend jamais avoir effacé quand il a échoué.

**Avant `const known = await this.knownProfileAnswers(user);`**

⚠️ L'INVITATION EST POSTÉE APRÈS LA VÉRIFICATION, PAS AVANT — corrigé le 2026-08-21,
sur observation en production.
Elle partait inconditionnellement, si bien qu'une personne au dossier déjà complet lisait
« On va compléter ton dossier » suivi, dans la seconde, de « Ton dossier est déjà complet
— je n'ai rien à te redemander. » Le premier message annonce un travail que le second
annule : c'est la famille de défaut que ce dépôt traque partout ailleurs, ici sous sa
forme la plus bénigne et la plus visible.
L'ordre coûte une lecture de plus avant le premier mot posté. C'est le bon échange :
l'alternative est d'ouvrir la conversation par une phrase fausse.

**Avant `const deliveryPromise =`**

⚠️ La note s'accole désormais SUR LE VERDICT DU DÉTECTEUR, et non sur la seule
classification des outils. C'est ce qui produisait le doublon relevé en production le
2026-08-21 : le modèle disait la vérité, et la note la redisait en moins bien.

**Avant `private async findProfileRecord(`**

⚠️ **LE LIEN DIRECT D'ABORD, L'ADRESSE ENSUITE — corrigé le 2026-08-21, en production.**

Les deux lecteurs du dossier (`knownProfileAnswers` et le verdict de « j'ai fini ») ne
passaient QUE par `slack_directory.email`. Or cette colonne peut être vide : elle vient du
profil Slack, et une adresse n'y est pas toujours visible — un invité, un compte sans
`users:read.email` exploitable, ou simplement quelqu'un qui ne l'a pas renseignée.

Le symptôme, reproduit par la sonde d'arrivée : la personne complète tout son dossier,
`submitProfile` RELIE bien `slack_directory.employee_id` au dossier créé — et « j'ai fini »
répond « Je ne trouve pas encore de dossier à ton nom ». L'identifiant était dans la ligne
qu'on venait de lire, et personne ne le regardait.

Même famille que la cause racine du 2026-08-19, à l'envers : là, `employee_id` n'était
écrite par aucun chemin ; ici elle l'est, et n'est lue par aucun.

### `src/features/notification/infrastructure/repositories/drizzle-notification.repository.ts`

**Avant `constructor(private readonly resolveDb: () => DatabaseInstance = getDb) {}`**

⚠️ Injectable pour que le contrat de PRISE soit exercé contre du VRAI SQL : « l'UPDATE n'a
touché aucune ligne » ne se démontre pas contre une doublure. Même forme que
`DrizzlePendingInterviewEmailRepository`, et pour la même raison.

**Avant `async findPending(): Promise<Notification[]> {`**

⚠️ `Sending` EN FAIT PARTIE : une prise abandonnée est, en fait, en attente. C'est la
sélection qui décide ensuite si la grâce est écoulée — sans quoi un rappel dont
l'invocation a été tuée serait invisible de toute exécution ultérieure, donc perdu en
silence. La prise elle-même, atomique, empêche d'en remettre un qui est réellement en vol.

**Avant `const free = inArray(notifications.status, [`**

`Sending` est l'état de PRISE : il n'est écrit que par ce chemin. Un rappel réellement en
vol ne peut donc pas être repris — c'est ce qui interdit le doublon.
⚠️ Sauf s'il est ABANDONNÉ : une invocation tuée entre la prise et l'envoi le laisserait
dans cet état pour toujours. Au-delà de la grâce, on reprend — un rappel perdu en silence
est pire qu'un doublon, qui lui se voit.

**Avant `function readAffectedRows(result: unknown): number {`**

⚠️ Drizzle/LibSQL rend le compte sous `rowsAffected`, mais le type public ne le promet pas
selon le pilote. On lit défensivement, et **l'absence de compte vaut ÉCHEC de prise** : un
doute qui accorde la prise enverrait deux fois, un doute qui la refuse ne fait que reporter
le rappel à la remise suivante.

### `src/features/notification/infrastructure/repositories/in-memory-notification.repository.ts`

**Avant `async findPending(): Promise<Notification[]> {`**

⚠️ `sending` EN FAIT PARTIE — voir le port : une prise abandonnée est en attente.

**Avant `async cancelIfPending(id: string, recipientId: string): Promise<boolean> {`**

⚠️ `readAffectedRows` EST LA GARANTIE, PAS L'`UPDATE`. « L'UPDATE n'a touché aucune ligne »
ne se démontre pas contre une doublure : le contrat est donc vérifié sur les DEUX
implémentations par la même suite (`tests/unit/notification/notification-claim.test.ts`), la
Drizzle contre une vraie base libsql en mémoire. C'est la doublure in-memory qui décide, dans
tous les tests du handler, si un second « annule » annule une seconde fois.

**Avant `async claimForDispatch(id: string, strandedBefore?: Date): Promise<boolean> {`**

⚠️ C'est cette doublure qui décide, dans tous les tests du répartiteur, si une seconde
exécution remet le rappel une seconde fois. Le contrat est verrouillé sur les DEUX
implémentations par la même suite — `tests/unit/notification/notification-claim.test.ts`.

**Avant `const abandoned =`**

⚠️ Une prise ABANDONNÉE (invocation tuée entre la prise et l'envoi) est reprenable au-delà
de la grâce — sinon le rappel resterait `sending` à jamais, perdu en silence.

---

## Décisions du 2026-08-21 (nuit) — complétion de profil

### `src/features/notification/infrastructure/handlers/slack-events.handler.ts`

**Avant `private async runProfileDoneCheck(input: {`**

⚠️ **L'ORDRE DE PRÉCÉDENCE EST CELUI DE `handleProfileAnswer`, et il doit le rester** :
annuaire, puis dossier, puis historique du fil. L'historique gagne parce que c'est ce que la
personne vient d'écrire. Toute divergence entre ces deux fusions réintroduirait exactement le
défaut qu'on ferme ici.

⚠️ **LA PROMESSE DE `PROFILE_CHAT_SAVE_FAILED` EST ENFIN TENUE.** Ce texte dit mot pour mot
« redis-moi "j'ai fini" dans un instant et je réessaie ». Tant que « j'ai fini » ne faisait
que relire la base, il ne réessayait rien : la personne redisait la formule et s'entendait
reposer les quatre questions. Quand tout est connu et qu'il n'y a AUCUN dossier, on
réenregistre.

⚠️ **`record === null`, et surtout PAS `!verdict.complete`.** Une ligne existante mais
incomplète repasserait par le workflow de CRÉATION, or `employees.email` est UNIQUE : le
symptôme serait un conflit d'adresse sur son propre dossier, et le message d'aide parlerait
d'archivage là où rien n'est archivé. Un dossier partiel se complète par la question suivante,
jamais par une seconde création.

⚠️ Le tour `user` est mémorisé À LA MAIN sur ce chemin : `sayAndRemember` réécrit `input.text`
à chaque appel, et `submitProfile` en fait plusieurs. On passe donc un `input` SANS `text`.

**Avant `private async warnManagersOfTopRoleClaim(`**

⚠️ **ELLE REND LE MESSAGE DU DÉCLARANT AU LIEU DE NE RIEN RENDRE, et l'appel n'est plus
`void`.** Le détachement se justifiait tant que la fonction n'avait d'effet que sur un tiers ;
il devient un défaut dès qu'elle décide ce que l'arrivant doit lire — le message serait parti
après la question suivante, ou pas du tout.

⚠️ **CHAQUE DM EST DANS SON PROPRE `try`, et c'est ce qui rend `informed` honnête.** Un seul
`try` englobant comptait un échec sur le premier manager comme un échec total, et surtout
n'aurait pas permis de distinguer « aucun n'a reçu » de « le troisième n'a pas reçu ».

⚠️ Le nom du porteur est ASSAINI (`sanitizeDisplayName`) : il vient du profil Slack, donc de
son propre porteur, et ce message entre dans l'historique conversationnel rejoué au modèle.

---

## UNE CHAÎNE NE CONTINUE PAS SUR UNE ÉTAPE QUI N'A RIEN PU FAIRE (2026-08-25)

Verdict du propriétaire sur la première version de l'enchaînement : *« pourquoi maintient-il le
rappel si le résumé n'a pas été fait ? Ça ne sert à rien. »* La trace de production lui donne
raison en deux messages — « Je ne peux pas résumer le canal kisso-hq. » puis « Rappel programmé
pour jeudi 27 août 2026 au matin. » Un rappel « de relire le compte rendu » posé alors qu'aucun
compte rendu n'existe est du bruit qui arrivera jeudi matin, et l'ensemble se lit comme un bot
qui n'écoute pas.

### Pourquoi cela ne casse PAS le théorème d'indépendance

L'invariant qui rend l'enchaînement sûr est qu'**aucun CONTENU ne circule entre les étapes**.
Une ISSUE n'est pas un contenu :

- elle vaut UN BIT, produit par le harness et jamais par le modèle ;
- elle ne porte aucun texte, donc rien qu'un attaquant contrôle ;
- et elle ne peut que RETIRER du travail, jamais en déclencher.

Un canal qui ne transporte pas de donnée et qui ne sait que s'arrêter n'exfiltre rien.

### C'est le filet de rattrapage du détecteur d'anaphore

`refersToPreviousStep` reconnaît « ça », « ce résumé », « envoie-le-moi ». Il ne reconnaît PAS
« de relire le compte rendu », qui renvoie pourtant bel et bien à l'étape 1 — et aucune liste de
tournures ne sera jamais complète. S'arrêter sur échec couvre exactement les cas où la dépendance
était réelle et non détectée, **sans rien avoir à énumérer**. C'est la même préférence que celle
qui a fait remplacer la liste noire d'outils par l'invariant d'indépendance.

### Et on le DIT

Le silence sur la seconde demande était le défaut d'origine ; l'exécuter dans le vide en est un
autre. La troisième voie — s'arrêter ET l'annoncer — coûte ZÉRO token et laisse la main à la
personne. Verrouillé par `tests/unit/handlers/intent-chain-stops-on-failure.test.ts`.

### `src/features/notification/domain/services/intent-chain.ts`

**Avant `export const CHAIN_STOPPED_NOTICE =`**

La phrase ne REPREND PAS le texte de la demande abandonnée. C'est le texte de la personne, donc
sûr par nature — mais il n'est pas assaini par `sanitizeAgentOutput`, qui n'a qu'un seul site
d'appel (`response.text`), et le renvoyer dans Slack ferait de ce chemin une réflexion de mrkdwn
non filtré. Une phrase générique dit la même chose sans ouvrir ce canal.

### `src/features/notification/infrastructure/handlers/slack-events.handler.ts`

**Avant `private async postPlainMessage(`**

Un échec de publication de la note d'arrêt est journalisé en `warn`, jamais propagé : la réponse
de l'étape 1 est déjà partie, et perdre le fil entier pour une phrase complémentaire serait un
mauvais échange. Même règle que le marqueur de progression, qui n'est jamais un point de panne.
