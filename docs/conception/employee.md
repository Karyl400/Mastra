# Feature `employee`

> Décisions de conception, extraites des commentaires du code le 2026-08-20.
> Périmètre : `src/features/employee/`
>
> Chaque entrée est ancrée sur la **déclaration** qu'elle précédait, jamais sur un numéro
> de ligne : l'audit du 2026-08-21 a mesuré 5 424 ancres `L.N` dont **153 exactes (2,8 %)**.
> Un numéro de ligne se périme au premier retrait de commentaire — c'est-à-dire aussitôt.
>
> Le code ne porte plus ce texte : **c'est ici qu'il vit désormais.**

---

## `features/employee/application/dtos/employee.dto.ts`

**Avant `import { z } from 'zod';`**

employee.validation.ts

**Avant `import contains from 'validator/lib/contains.js';`**

Sous-chemin — voir la note d'`isEmail` dans `shared/validation.ts`.

**Avant `const EMPLOYEE_CONSTRAINTS = {`**

1. CONSTANTES ET CONFIGURATION

**Avant `MESSAGE: 'Name must contain only letters, spaces, hyphens, and apostrophes',`**

Support noms internationaux

**Avant `},`**

Maximum 90 jours dans le futur


1 milliard
**Avant `const nameSchema = z`**

2. SCHEMAS DE BASE AMÉLIORÉS


Schema de nom avec validation internationale
Supporte les caractères Unicode pour les noms non-latins
**Avant `.refine(`**

Protection XSS

**Avant `const startDateSchema = z`**

Schema de date avec contraintes métier

**Avant `const departmentSchema = z`**

Normalisation


Schema département avec enum dynamique
**Avant `.transform((val) => sanitizeHtml(val));`**

Validation contre l'enum après nettoyage

**Avant `const baseEmployeeSchema = z.object({`**

3. SCHEMAS MÉTIER COMPLEXES


⚠️ `managerValidationSchema` a été SUPPRIMÉ le 2026-08-17 — il n'avait aucun appelant.

Il déclarait deux règles métier (« un employé actif doit avoir un manager », « un employé

en attente ne peut pas en avoir ») que RIEN n'appliquait : le seul chemin de création

réel est le formulaire « Compléter mon profil », qui ne collecte aucun manager et crée

des dossiers actifs. La règle était donc à la fois morte ET fausse pour ce produit —

la câbler aurait cassé le formulaire.

Une règle qu'aucun code n'applique est de la même famille que `emailSent: false` sous

`status: 'success'` : elle donne l'illusion d'une garantie. Si le rattachement

hiérarchique devient un vrai besoin, il se réécrira contre le parcours qui existera

alors, pas contre celui de 2026-08-05.

4. SCHEMA PRINCIPAL AVEC DISCRIMINATED UNIONS

Schema de base commun à tous les employés
**Avant `email: emailSchema,`**

⚠️ Le `.refine()` qui enrobait ce champ a été RETIRÉ le 2026-08-17 : son prédicat


retournait `true` en toute circonstance, sous le message « Email already exists in

the system ». Il ne pouvait donc rien refuser, tout en faisant croire à un contrôle

d'unicité — un test de schéma l'aurait vu « passer » sans qu'aucune vérification

n'ait lieu. L'unicité EST vérifiée, mais là où elle peut l'être : la contrainte

`UNIQUE` de la table et `findByEmail` dans `createEmployeeStep`.
**Avant `department: departmentSchema.nullable(),`**

NULLABLE depuis le 2026-08-13 : le parcours d'arrivée ne collecte plus le département.


Le schéma de VALEUR reste inchangé — quand une valeur est présente, elle doit toujours

appartenir à l'enum. On assouplit la présence, jamais la validité.
**Avant `position: z`**

Champ libre : voir `positionSchema` dans shared/validation.ts. Le `.pipe()`


qui figurait ici sérialisait en `allOf` — exactement la construction que

`tool-schema-flatness.test.ts` interdit, et qui a déjà cassé `createEmployee`.

Elle ne survivait que parce que ce schéma n'est pas un `inputSchema` de tool.
**Avant `export const employeeDtoSchema = applyManagerValidation(`**

Schema pour la réponse (DTO) — le SEUL schéma vivant de ce module.

**Avant `fullName: z.string().optional(),`**

Champs calculés

**Avant `})`**

Ancienneté en mois

**Avant `export type EmployeeDto = z.infer<typeof employeeDtoSchema>;`**

5. TYPES INFÉRÉS

**Note de fichier**

⚠️ SECTIONS 6 À 9 SUPPRIMÉES LE 2026-08-17

Ce module faisait 474 lignes pour DEUX symboles réellement importés :

`EmployeeDto` (par `employee.mapper.ts`) et `employeeDtoSchema` (par son seul test).

Ont été retirés :

 • `EmployeeValidator` — une classe de validation à zéro appelant, seule consommatrice

   de `createEmployeeSchema` et d'`updateEmployeeSchema`, eux-mêmes sans importateur.

   C'est ce qui rendait morte la règle « un employé actif doit avoir un manager » :

   elle EXISTAIT, mais aucun chemin d'exécution ne la traversait.

 • `EmployeeValidationError` — levée nulle part, donc rattrapée nulle part.

 • `preValidationHooks` — normalisation d'entrée qu'aucun appelant n'invoquait ; le

   parcours réel normalise dans `createEmployeeStep`.

 • `validationTestCases` — des FIXTURES DE TEST exportées depuis le code de production,

   qui n'étaient utilisées par aucun test. Elles décrivaient un contrat (« ces entrées

   doivent être refusées ») que rien ne vérifiait : la forme la plus trompeuse de code

   mort, puisqu'elle ressemble à une garantie.

 • `EmployeeListResponse` — pagination d'une API qui n'existe pas.

`applyManagerValidation` est CONSERVÉE : `employeeDtoSchema` l'applique réellement, et

son test la traverse.

## `features/employee/application/tools/find-employee-by-email.ts`

**Avant `const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net', 'example.edu', 'localhost`**

Résout un employé à partir de son email.

Contexte (trace de production) : un utilisateur demandait « Récupère les informations
concernant Karyl SOUMAILA » ; l'agent n'avait aucun moyen de passer d'un nom/email à
un ID d'employé et redemandait en boucle un UUID à l'utilisateur — trou fonctionnel,
pas un problème de prompt. Ce tool lève l'ambiguïté d'identité ; l'agent enchaîne
ensuite avec `getEmployeeProfile(employeeId)` pour le détail complet si besoin.

Sécurité — non négociable (voir audit) : n'importe quel membre du workspace Slack peut
déclencher ce tool. On n'expose donc QUE le strict nécessaire pour lever l'ambiguïté
d'identité : identifiant interne, prénom/nom, statut. Explicitement PAS exposés :
salaire, contact d'urgence, téléphone, métadonnées, ni même l'email en retour (déjà
connu de l'appelant). Le détail complet reste derrière `getEmployeeProfile`.

`email` réutilise `emailSchema` (partagé, épinglé Zod 3.25.76) qui trim + lowercase
déjà l'entrée ; l'email est re-normalisé dans `execute` pour rester robuste même si
ce tool est appelé directement (tests, futurs appelants) sans passer par la validation
du schéma d'entrée.


Domaines réservés par la RFC 2606 (et voisins), qui ne désignent JAMAIS une
boîte réelle. `example.*` en second niveau, le reste en suffixe de TLD.
**Avant `const PLACEHOLDER_LOCAL_PARTS = new Set([`**

Parties locales de remplissage, sous forme NORMALISÉE (séparateurs `.`, `_` et
`-` retirés) : `votre_email`, `votre.email` et `votre-email` se ramènent au même
`votreemail`, sans avoir à énumérer les variantes.

Comparaison EXACTE, jamais par sous-chaîne : `email` en sous-chaîne
condamnerait un `remaild@…` légitime, et le coût d'un faux positif est élevé —
c'est un employé réel que l'agent déclarerait introuvable.

**Avant `function isPlaceholderEmail(email: string): boolean {`**

L'email est-il un exemple générique plutôt qu'une vraie adresse ?

Mécanisme visé, mesuré en production le 2026-08-11 : privé de mémoire
conversationnelle, le modèle n'a plus l'email donné au tour précédent, mais
`emailSchema` exige une adresse syntaxiquement valide — alors il en FABRIQUE
une (`votre_email@example.com`) pour que l'appel passe la validation. Zod ne
peut rien y voir : la valeur inventée est parfaitement bien formée. C'est le
même défaut que celui documenté dans `src/mastra/index.ts` à propos de
`createEmployee` (« le modèle substitue une valeur valide AVANT d'appeler
l'outil pour que l'appel réussisse »).

Le contrôle vit ICI, et non dans `emailSchema` : ce schéma partagé sert aussi à
la création d'employés et aux entités, où élargir la liste des domaines
bloqués changerait le comportement de tout le dépôt pour un défaut propre à un
seul chemin — celui d'un LLM qui devine une entrée.

**Avant `export function makeFindEmployeeByEmail(repo: EmployeeRepository, directory?: DirectoryRepositor`**

Deuxième source de résolution : l'ANNUAIRE SLACK (`slack_directory`).

Constat de production du 2026-08-12 — c'est la panne que le propriétaire décrit par
« il ne retrouve pas les autres profils à part le mien ». La table `employees` n'est
peuplée que par la modale « Compléter mon profil », déclenchée par le seul événement
`team_join` : elle contenait **une ligne vivante** pour un workspace de 6 personnes.
Les deux emails déclarés introuvables ce soir-là (`ridwanenico77@gmail.com`,
`mistourath@kissohq.com`) étaient présents dans `slack_directory`, avec prénom, nom et
poste. La donnée était là ; aucun tool ne la lisait.

L'annuaire est un MIROIR de Slack, `employees` une donnée PROPRE au produit. D'où
l'ordre : `employees` d'abord — c'est lui qui porte l'UUID interne dont dépendent
`getEmployeeProfile`, `generateDocument` et `scheduleReminder` — puis l'annuaire en repli.
L'inverse ferait perdre l'identifiant interne d'un employé enregistré.

⚠️ Dépendance OPTIONNELLE : le tool reste appelable sans annuaire (tests, playground,
base neuve). Sans lui, le comportement est exactement celui d'avant.

**Avant `if (isPlaceholderEmail(normalizedEmail)) {`**

Avant toute E/S : une adresse d'exemple ne peut rien trouver en base, et


la laisser passer produirait un « aucun employé avec cet email » que le

modèle rapporterait à l'utilisateur comme un fait — exactement le

« Je ne trouve pas d'employé avec l'email votre_email@example.com »

observé le 2026-08-11 à 2:56.
**Avant `logger.warn('Email de remplissage refusé — valeur probablement inventée par le modèle', {`**

`warn` volontaire : une adresse de remplissage signale que le modèle a


inventé un paramètre. C'est la ligne à chercher quand un agent affirme

qu'un employé est introuvable.

Partie locale et domaine sont journalisés SÉPARÉMENT, et non sous une

clé `email` : le logger masque le PII à la fois par nom de clé

(`isPiiKey`) et par forme de la valeur (`isPiiValue`), donc une adresse

entière ressortirait en `[REDACTED:EMAIL]` — ce qui viderait la ligne

de tout intérêt, alors qu'on cherche précisément à savoir QUELLE

adresse le modèle a fabriquée. Aucun secret n'est exposé : cette

branche n'est atteinte que par des adresses qui ne désignent personne.
**Avant `return {`**

Résultat structuré, pas d'exception : le tool contracte explicitement


« jamais une exception » (cf. sa description), et les autres tools ne

lèvent (`NotFoundError`) que sur un identifiant censé exister —

`updateOnboardingStatus`, `evaluateResponse`, `sendNotification`. Ici

rien n'a été demandé de valide, et surtout : une exception remonterait

au catch générique du handler Slack, qui poste « Désolé, une erreur

s'est produite » — le modèle n'apprendrait rien et ne corrigerait pas.

`reason` + `hint` l'INSTRUISENT au contraire de la marche à suivre.
**Avant `const member = directory ? await directory.findByEmail(normalizedEmail) : null;`**

Repli sur l'annuaire Slack. Bots et comptes désactivés sont écartés : ce ne


sont pas des personnes à onboarder, et les rendre inviterait le modèle à

proposer de leur envoyer un document.
**Avant `return {`**

`employeeId` est le pont posé par `directorySync` quand l'email Slack


correspond déjà à une ligne `employees`. Il est `null` pour quelqu'un qui

n'a jamais rempli le formulaire de profil — le cas de 5 personnes sur 6.
**Avant `slackUserId: member.slackUserId,`**

Nom de clé distinct d'`employee` À DESSEIN : cette personne n'a pas


de dossier d'onboarding. Réutiliser `employee.id` ferait passer un

`U…` pour l'UUID interne qu'attendent les autres tools.
**Avant `title: member.title,`**

`profile.title` — le poste DÉCLARÉ dans Slack, pas le poste contractuel.

**Avant `const requesterEmployeeId = readSlackContext(ctx?.requestContext)?.employeeId;`**

ÉCHEC QUI INSTRUIT — un aller-retour épargné vaut plus que tout dégraissage


`return { found: false }` était NU, et le relevé de production montre exactement ce

que ça coûte. Deux fois, sur deux jours :

    Karyl  : « Bonjour, que peux-tu faire pour moi ? »

    Mastra : « Je n'ai pas trouvé d'employé avec l'adresse

              karyl.soumaila@kisso.com. […] Tu peux me les donner ? »

Deux défauts en une réponse. Le modèle a FABRIQUÉ une adresse plausible à partir du

nom de la personne — `isPlaceholderEmail` ne peut rien contre elle, elle est bien

formée et son domaine est réel. Puis il a réclamé à l'humain une information que le

système DÉTENAIT DÉJÀ : l'identité du demandeur descend par le `requestContext`.

Le tour de dialogue ainsi provoqué est le poste de coût le plus cher du produit —

la doctrine du dépôt le dit : « un tour de dialogue épargné vaut plus que plusieurs

centaines de tokens rabotés », sur un budget de ≈ 19 messages/JOUR.

⚠️ Aucune donnée nouvelle n'est exposée : c'est l'identifiant du DEMANDEUR lui-même,

que `canReadPersonRecord` l'autorise déjà à lire (« son propre dossier toujours »),

et il vient du contexte serveur — jamais d'une valeur écrite par un attaquant.

Payé uniquement dans cette branche, comme les autres `hint` du dépôt.
## `features/employee/application/tools/find-person-by-name.ts`

**Avant `export const MAX_NAME_CANDIDATES = 5;`**

Résout une personne par son NOM.


Le défaut, mesuré sur la Turso de production le 2026-08-13


  employee_id=d20df236…(Karyl)  type=welcome_letter  title="Bienvenue Awa"  status=sent

Les DIX documents de la base portent l'UUID de Karyl — y compris celui intitulé
« Bienvenue Awa », dont l'email est donc parti à l'adresse de Karyl. Awa a pourtant sa
propre ligne `employees` ; elle est simplement absente de `slack_directory`, si bien que
`findEmployeeByEmail` — seul résolveur existant — exigeait une adresse que personne
n'avait tapée.

Sommé de fournir un `employeeId` par le schéma de `generateDocument`, le modèle a fait ce
que ce dépôt sait qu'il fait devant un espace vide : il a réutilisé le seul UUID présent
dans son contexte. Même mécanique que l'email `votre_email@example.com` documenté dans
`find-employee-by-email.ts` — **le modèle produit une valeur valide pour que l'appel
passe**, et aucune validation Zod ne peut le voir.

`TODO.md` recensait ce manque depuis le 2026-08-12 (« Aucun tool ne résout un PRÉNOM »)
sans l'avoir relié au bug de destinataire.


Deux sources, `employees` d'abord — et c'est le relevé qui l'impose


Au 2026-08-14 : `employees` = 2 lignes (Karyl, Awa) ; `slack_directory` = 40 lignes dont
4 personnes vivantes non rattachées (Nazer, Pamela, Mistourath, ridwanenico77) — et Awa
n'y figure pas. **Une seule des deux sources laisserait la moitié du workspace
irrésolvable.**

L'ordre est celui de `findEmployeeByEmail`, pour la même raison : `employees` porte
l'UUID interne dont dépendent `getEmployeeProfile`, `generateDocument` et
`scheduleReminder`. L'inverse ferait perdre cet identifiant pour un employé enregistré.


Nombre maximal de candidats rendus sur une ambiguïté.

Ce résultat entre dans l'historique et est réémis à chaque aller-retour suivant, sur un
budget de ≈ 19 messages par jour. Cinq noms suffisent à ce qu'un humain reconnaisse le
sien ; au-delà, la bonne réponse est « précise ta demande », pas une liste plus longue.
**Avant `const MIN_NAME_LENGTH = 2;`**

Longueur minimale de la requête.

Une seule lettre correspondrait, par la règle de préfixe, à une grande partie du
workspace : l'ambiguïté rendue porterait alors sur tout le monde, ce qui n'apprend rien
et coûte des tokens. Deux caractères est le plancher où la question reste une question.

**Avant `const AMBIGUOUS_HINT =`**

Consigne rendue sur ambiguïté.

⚠️ Elle accompagne une liste de candidats SANS AUCUN IDENTIFIANT — voir plus bas. C'est
elle qui transforme le silence en question posée à l'humain.

**Avant `const DIRECTORY_ONLY_HINT =`**

Consigne rendue quand la personne n'existe que dans l'annuaire Slack.

Reprise mot pour mot de `findEmployeeByEmail` : les deux tools doivent instruire le
modèle de la même façon, sans quoi le même état de fait produirait deux comportements.

**Avant `const employees = await repo.findByName(query, MAX_NAME_CANDIDATES + 1);`**

On demande UN candidat de plus que la borne : c'est ce qui permet de dire


`truncated` sans un second aller-retour, et sans le déduire d'une égalité qui

serait fausse quand le total vaut exactement la borne.
**Avant `firstName: sanitizeDisplayName(found.firstName),`**

Même traitement que la branche annuaire : ces champs viennent d'un dossier


que la personne a elle-même rempli en conversation.
**Avant `},`**

⚠️ PAS d'email. Ce tool lève une ambiguïté d'identité, il n'est pas un canal


de sortie de données personnelles — et il est atteignable par n'importe quel

membre du workspace. Même arbitrage que `findEmployeeByEmail`.
**Avant `const members = directory`**

Repli sur l'annuaire. Bots et comptes désactivés écartés : ce ne sont pas des


personnes à onboarder, et les rendre inviterait le modèle à leur proposer un

document. Le workspace de production porte 22 bots sur 40 lignes.
**Avant `slackUserId: member.slackUserId,`**

Nom de clé distinct d'`employee` À DESSEIN, comme dans `findEmployeeByEmail` :


cette personne n'a pas de dossier. Réutiliser `employee.id` ferait passer un

`U…` pour l'UUID interne qu'attendent les autres tools.
**Avant `firstName: sanitizeDisplayName(member.firstName),`**

⚠️ TEXTE ÉCRIT PAR UN TIERS. `schema.ts` le dit : « `title` est le poste


DÉCLARATIF, ÉDITÉ PAR SON PORTEUR » — donc par n'importe qui du workspace,

invité mono-canal compris, sans revue, et restitué ici en réponse à la question

D'UN AUTRE. Cet outil est câblé sur `notificationAgent`, qui porte

`sendNotification` : c'est la conjonction lecture-de-tiers + écriture externe

qu'`outbound-tool-quarantine.ts` §4.2 interdit, atteinte par la porte que

personne ne gardait. `findExpertise`, lui, est protégé en aval par la

quarantaine ; celui-ci ne l'est pas.

On réutilise le neutraliseur du préambule d'identité plutôt qu'une bannière :

c'est une LISTE BLANCHE (lettres, marques, chiffres, `.'’-`), donc ni chevron,

ni deux-points, ni retour à la ligne, ni URL ne survivent — et un poste

ordinaire en ressort intact. Coût en tokens : négatif, il raccourcit.
**Avant `function label(firstName: string | null, lastName: string | null, role: string | null): string {`**

Un candidat, en UNE chaîne plutôt qu'en objet à trois clés.

Les noms de clés (`firstName`, `lastName`, `role`) seraient répétés à chaque candidat —
25 caractères × 5, soit ≈ 36 tokens de pure structure, réémis à chaque aller-retour
suivant. Or cette liste n'est pas destinée à être destructurée : elle est destinée à
être RÉCITÉE à un humain pour qu'il désigne la bonne personne.

**Avant `[firstName, lastName, role] = [`**

⚠️ Ce libellé sort AUSSI vers le modèle, sur le chemin ambigu. L'oublier aurait laissé


ouverte exactement la même porte, une branche plus loin.
**Avant `const name = fullName(firstName, lastName) || '(sans nom)';`**

Le repli « (sans nom) » reste ICI : c'est une décision d'affichage propre à la levée


d'ambiguïté, et un document signé ne doit surtout pas l'imprimer.
**Avant `function ambiguous(all: readonly string[]) {`**

Résultat d'ambiguïté — **sans aucun identifiant**, et c'est la garantie centrale du tool.

Rendre deux UUID reviendrait à laisser le modèle en choisir un : c'est très exactement le
geste qui a enregistré « Bienvenue Awa » sous l'identifiant de Karyl et envoyé le fichier
à son adresse. Sans identifiant, l'appel suivant est structurellement impossible — le
modèle n'a plus d'autre issue que de poser la question, ce que `AMBIGUOUS_HINT` lui dit
de faire.

Le discriminant rendu est le RÔLE, jamais l'email : c'est ce qui distingue deux homonymes
aux yeux d'un collègue, et ça ne divulgue rien qu'un annuaire d'entreprise ne montre.

## `features/employee/application/tools/get-employee-profile.ts`

**Avant `const NOT_FOUND_HINT =`**

Consigne rendue au modèle quand l'identifiant ne désigne personne.

Le tool levait `NotFoundError` ici. Or l'AI SDK v7 convertit ce que lève un
tool en part `tool-error` RÉINJECTÉE au modèle — le catch générique du
handler Slack n'est jamais atteint. Face à un vide, le modèle comble : c'est
ainsi qu'est né l'over-promise « as-tu besoin que je crée un profil ? », pour
une capacité qu'aucun agent ne possède. Un résultat qui INSTRUIT vaut mieux
qu'une exception ; même motif que `find-employee-by-email.ts`.

**Avant `const NO_PROGRESS_HINT =`**

Consigne rendue quand l'employé existe mais n'a pas de suivi d'intégration.

État réel des deux employés de production au 2026-08-11 : créés par le tool
`createEmployee` (un simple `repo.save`), ils n'avaient pas d'
`onboarding_progress`. Un `progress: null` nu se lisait comme « il n'y a plus
qu'à le créer » — d'où la proposition de création. Le rattrapage appartient
aux RH, pas au modèle.

**Avant `const NOT_AUTHORIZED_HINT =`**

Consigne rendue quand le demandeur n'a pas le droit de lire CE dossier.

Elle nomme la RÈGLE et jamais la donnée : elle ne dit pas si l'identifiant désigne
quelqu'un, ni ce que contient le dossier. Sans cela, le refus lui-même deviendrait un
oracle — « cet UUID existe » est déjà une information sur une personne.

⚠️ Elle INTERDIT explicitement de reformuler ou de réessayer. Sans cette phrase, un modèle
sommé de livrer un profil traite un refus comme un obstacle à contourner : c'est ce
comportement exact qui a produit 38 `findEmployeeByEmail` en 1,5 seconde le 2026-08-12.

**Avant `const MISSING_IDENTIFIER_HINT =`**

Consigne rendue quand le modèle appelle le tool sans aucune clé.

Les deux champs sont optionnels — il faut donc l'un OU l'autre, ce qu'un schéma Zod ne peut
pas exprimer ici (`z.discriminatedUnion` casse le parseur du Vercel AI SDK sous Zod 3.25.76).
La contrainte est donc vérifiée à l'exécution, et son non-respect INSTRUIT plutôt qu'il ne
lève : une exception repart au modèle en part `tool-error`, et un modèle privé de résultat
comble le vide.

**Avant `const email = data.email ? String(data.email).trim().toLowerCase() : undefined;`**


DEUX CLÉS D'ENTRÉE, et c'est une mesure de COÛT


Mesuré en production le 2026-08-15 : « profil de l'employé dont l'email est X »

coûtait TROIS étapes — `findEmployeeByEmail`, puis `getEmployeeProfile`, puis la

réponse — pour 4 711 tokens d'entrée. L'entrée est CUMULATIVE (1 417 + 1 559 + 1 735) :

chaque étape réémet tout le contexte. Une étape épargnée vaut donc ≈ 1 500 tokens,

près d'un tiers du message, là où raboter le prompt en rend quelques dizaines.

⚠️ `z.object` avec deux champs OPTIONNELS, jamais `z.discriminatedUnion` : Zod est

épinglé à 3.25.76 et le parseur de schémas du Vercel AI SDK casse sur cette

construction (piège documenté).
**Avant `return {`**

On INSTRUIT, on ne lève pas : une exception repart au modèle en part `tool-error`,


et un modèle privé de résultat comble le vide.
**Avant `if (!data.employeeId && email) {`**

── Chemin EMAIL ──────────────────────────────────────────────────────


La résolution doit précéder la décision d'accès : on ne connaît pas encore la

personne visée. Le risque est d'en faire un ORACLE d'existence — `not_authorized`

signifierait « cette adresse existe », `employee_not_found` « elle n'existe pas », et

un demandeur non autorisé énumérerait l'annuaire une adresse à la fois.

La parade tient en une ligne : on passe l'identifiant RÉSOLU (ou `null`) à la garde.

Sur `null`, `canReadPersonRecord` ne peut pas emprunter la branche « son propre

dossier » et retombe sur le niveau d'accès — donc un demandeur sans le niveau `full`

reçoit le MÊME refus dans les deux cas, et n'apprend rien.
**Avant `if (!canReadPersonRecord(_ctx?.requestContext, employeeId)) {`**

── Chemin IDENTIFIANT ────────────────────────────────────────────────


AVANT toute lecture en base. Un refus qui interroge d'abord la base laisse fuiter par

sa latence, et journalise une consultation qui n'aurait pas dû avoir lieu. Cette

propriété est verrouillée par test et ne doit PAS être perdue en ajoutant l'email.
**Avant `logger.warn('Aucun employé pour cet identifiant', { employeeId });`**

`warn` volontaire : un identifiant qui ne désigne personne signale


presque toujours une valeur fabriquée par le modèle.
**Avant `function project(employee: Employee, progress: OnboardingProgress | null) {`**

Projection du couple employé / suivi, FACTORISÉE parce qu'elle a désormais DEUX appelants
(résolution par identifiant et par email). La dupliquer serait la garantie qu'un champ
ajouté d'un seul côté finisse par fuiter par l'autre — or c'est précisément ce que cette
projection existe pour empêcher.

**Avant `const view = progress ? reconcileProgress(progress) : null;`**

PROJECTION EXPLICITE, et non `return { employee }`.


`DrizzleEmployeeRepository.findById` fait un `db.select()` sans argument

— donc un `SELECT *` sur 20 colonnes — puis un `as Employee`. Cette

assertion est effacée à la compilation : elle ne retire AUCUNE propriété

à l'exécution, et `JSON.stringify` sérialise l'objet réel. Les colonnes

`salary_amount`, `phone`, `emergency_contact_*` et `metadata` existent en

base et partiraient telles quelles dans le contexte du LLM, donc

potentiellement dans une réponse Slack visible par n'importe quel membre

du workspace.

Le profil ne fuite rien AUJOURD'HUI seulement parce que l'entité

`Employee` ne déclare pas ces champs — une protection par coïncidence,

pas par conception. On énumère donc ce qu'on expose, sur le modèle de

`find-employee-by-email.ts`. Verrouillé par un test.

La même règle s'applique à `progress`.

⚠️ `tasks` a disparu de ce retour le 2026-08-14, avec le suivi de tâches

lui-même. Il en était le poste de coût dominant : non borné, 19 champs par

ligne, 2 506 tokens mesurés pour 12 tâches avant projection, réémis à chaque

aller-retour. Ne pas le réintroduire sans borne ni projection.


⚠️ CINQ CHAMPS RETIRÉS LE 2026-08-20, chacun pour sa propre raison


Le relevé qui les a fait tomber, rendu tel quel à la personne concernée :

    ID : d20df236-…   Département : Engineering   Date de début : 1 septembre 2026

    Poste : Developer   Statut : pending

    Intégration : en cours, étape 1 sur 1.

 • `id` — un UUID ne dit RIEN à un humain, et il a fait douter du reste : « je ne sais

   pas d'où il vient, s'il existe réellement ou pas ». Le retirer de la SORTIE plutôt que

   de demander au modèle de ne pas l'écrire : une consigne est probable, l'absence est

   garantie. Les flux qui ont besoin d'un identifiant l'obtiennent ailleurs —

   `generateDocument` prend celui du DEMANDEUR dans le `requestContext`, et

   `findPersonByName` rend celui d'un tiers.

 • `department` — retiré du produit entier ce jour-là, à la demande du propriétaire.

 • `startDate` — « 1 septembre 2026 » pour quelqu'un qui travaille déjà là. La valeur

   n'a qu'une source fiable (le jour d'arrivée sur Slack) et les lignes antérieures ne

   l'ont pas ; l'affirmer dans une réponse, c'est affirmer ce qu'on ne sait pas.

 • `status` — `employees.status` a **zéro écrivain** dans tout `src/` après la création :

   il vaut `pending` pour toujours. Annoncer « pending » à quelqu'un dont l'accueil est

   terminé, c'est le défaut nommé par ce dépôt — un suivi qui ne bouge jamais est un

   suivi qui ment. Le SEUL suivi réellement observé est `progress`, juste en dessous.

 • `managerId` — toujours `null`, et la notion de manager a déménagé vers

   `slack_directory.role` le même jour. Un champ vide qui porte le nom d'une frontière

   d'autorisation finit par être lu comme s'il en disait quelque chose.

⚠️ RÉCONCILIÉ, et par la MÊME fonction que le workflow — `reconcileProgress`. Cette

projection faisait son propre `Math.min(currentStep, ONBOARDING_TOTAL_STEPS)` : elle

corrigeait donc les compteurs et LAISSAIT le statut. D'où, en production, « Intégration :

en cours, étape 1 sur 1 » — une étape sur une étape est faite, « en cours » se contredit

dans la même phrase. Deux normalisations du même fait, dont l'incomplète vivait sur le

chemin de LECTURE : la classe de défaut la plus fréquente de ce dépôt.
**Avant `found: true as const,`**

Symétrique de `findEmployeeByEmail` : le modèle distingue le succès de


l'échec sur le MÊME champ, quel que soit le tool.
**Avant `position: employee.position,`**

Le POSTE est le seul attribut de métier rendu, et c'est ce qui a été demandé le


2026-08-20. Ce qui l'entourait a disparu, champ par champ, pour une raison propre à

chacun — voir l'encadré au-dessus de cette fonction.
## `features/employee/domain/entities/employee.ts`

**Avant `readonly department: string | null;`**

FACULTATIF depuis le 2026-08-13 — le parcours d'arrivée ne le collecte plus.

`null` et non `''` : une chaîne vide serait indiscernable d'une saisie effacée, et tout
lecteur finirait par l'afficher telle quelle. `null` dit « pas de valeur », ce que le
moindre `if` sait lire.

## `features/employee/domain/ports/employee.repository.ts`

**Avant `findByName(query: string, limit: number): Promise<Employee[]>;`**

Résout une personne par son NOM, accents et casse ignorés.

⚠️ Rend une LISTE, jamais un seul résultat, et c'est le point du contrat. Deux
homonymes existent dans tout workspace un peu grand ; en choisir un serait décider à
la place de l'humain sur une valeur qui finit par désigner un destinataire d'email.
L'appelant doit pouvoir constater l'ambiguïté.

Le rapprochement lui-même vit dans `src/shared/name-matching.ts` — le même code des
deux côtés (ici et `DirectoryRepository`), sans quoi une personne serait résolvable
dans une table et pas dans l'autre.

`limit` borne le retour : une requête d'un seul caractère peut correspondre à
beaucoup de monde, et ce résultat repart dans la fenêtre d'un modèle.

## `features/employee/infrastructure/repositories/drizzle-employee.repository.ts`

**Avant `const EMPLOYEE_COLUMNS = {`**

PROJECTION EXPLICITE — le point le plus important de ce fichier.

Ces lectures faisaient `db.select().from(employees)`, c'est-à-dire `SELECT *` sur les
20 colonnes de la table, puis `return result as Employee`. L'assertion de type DISPARAÎT à
l'exécution : elle apaisait le compilateur, elle ne retirait pas une seule colonne de l'objet.
`salary_amount`, `emergency_contact_name`, `emergency_contact_phone`, `phone` et `metadata`
repartaient donc intacts vers l'appelant — et `getEmployeeProfile` est câblé aux TROIS agents,
ce qui les envoyait chez Groq puis chez Mistral à chaque consultation de fiche.

L'énumération ci-dessous est exactement l'interface `Employee` du domaine, champ pour champ.
Ce n'est pas une redondance avec elle : c'est la seule forme qui fasse porter la restriction
par le SQL plutôt que par une promesse du système de types. Ajouter un champ au domaine sans
l'ajouter ici produit une erreur de compilation dans `toDomain` — l'inverse, ajouter une
colonne sensible à la table, ne produit désormais plus rien du tout, ce qui est le but.

**Avant `type EmployeeRow = {`**

Forme rendue par la projection. Écrite explicitement plutôt que dérivée de
`EMPLOYEE_COLUMNS` : Drizzle expose `_['data']` SANS la nullabilité de la colonne, donc un
type mappé rendrait `managerId: string` là où le SQL rend `string | null` — un mensonge de
type sur exactement le genre de champ qui produit un « null » imprimé en production.

Ajouter un champ à l'interface `Employee` du domaine casse `toDomain`, ce qui force à
l'ajouter ici, ce qui force à l'ajouter dans `EMPLOYEE_COLUMNS` : la chaîne tient.

**Avant `function toDomain(row: EmployeeRow): Employee {`**

 Seul point où `status` redevient l'énumération du domaine : la colonne est un `text` libre.

**Avant `constructor(private readonly resolveDb: () => DatabaseInstance = getDb) {}`**

Connexion résolue PARESSEUSEMENT (fonction, pas instance) : la construire ici ouvrirait la
base au chargement du module, donc au câblage de `src/mastra/index.ts`. Le paramètre sert
aussi aux tests, qui injectent une base libsql en mémoire plutôt que de mocker Drizzle.

**Avant `async save(employee: Employee): Promise<void> {`**

L'upsert ne NOMME jamais `deleted_at`, et c'est ce qui empêche une résurrection accidentelle :
`update()` délègue ici, donc un enregistrement rejoué sur l'identifiant d'une fiche supprimée
retombe sur sa ligne. Il en met à jour les champs métier et laisse la suppression en place.
Réactiver une fiche sera un geste EXPLICITE le jour où il existera, jamais un effet de bord.

**Avant `async delete(id: string): Promise<void> {`**

SOFT DELETE. `employees.deleted_at` et son index existaient depuis l'origine, mais cette
méthode faisait un DELETE PHYSIQUE : l'index était mort et toute suppression détruisait la
donnée sans trace ni réversibilité — dans un système RH, où la conservation est une
obligation avant d'être un confort.

Le `isNull` de la clause WHERE porte la propriété d'idempotence : un second appel n'affecte
aucune ligne et ne DÉPLACE donc pas la date. C'est la trace de la suppression ORIGINELLE,
seule information réutilisable pour un audit ou une restauration.

Un identifiant inconnu n'affecte aucune ligne et ne lève pas — c'est déjà le contrat de
l'ancien `delete()`, et les appelants s'en remettent à lui.

**Avant `async findByName(query: string, limit: number): Promise<Employee[]> {`**

Résolution par nom : UN aller-retour, puis le rapprochement en mémoire.

── Pourquoi pas en SQL ─────────────────────────────────────────────────────────────
`lower()` de SQLite ne retire pas les accents (pas d'ICU dans le build LibSQL), et un
`LIKE '%needle%'` correspondrait au MILIEU des mots : « rao » retrouverait « Traoré ».
Sur une résolution qui finit par désigner le destinataire d'un email, une
correspondance approximative est exactement le défaut qu'on corrige — il a déjà envoyé
le document d'Awa à l'adresse de Karyl le 2026-08-13.

── Le coût, et sa borne ────────────────────────────────────────────────────────────
On lit donc les fiches vivantes et on filtre en mémoire. La projection
`EMPLOYEE_COLUMNS` s'applique (aucune colonne sensible ne quitte la base) et
`employees` compte 2 lignes en production au 2026-08-14 — c'est la table des salariés
ENREGISTRÉS, elle croît au rythme des arrivées, pas des messages.

⚠️ Le jour où elle passera quelques milliers de lignes, la réponse n'est pas un `LIKE`
(il réintroduirait la correspondance en milieu de mot) mais une colonne normalisée
persistée, indexée, écrite par le même `normalizeName`.

**Avant `private async explainEmailConflict(email: string, error: unknown): Promise<void> {`**

Le soft delete crée un cas que le hard delete ne pouvait pas produire : une ligne SUPPRIMÉE
occupe toujours son adresse, car la contrainte UNIQUE porte sur la colonne et ignore
`deleted_at`. Recréer un employé sur l'email d'un partant échoue donc, avec le message brut
du pilote — « UNIQUE constraint failed: employees.email » — qui ne dit rien de la cause.

On ne relâche PAS la contrainte (un index partiel laisserait deux vivants coexister le temps
d'une réactivation) et on n'avale pas l'erreur : on la NOMME. Le seul comportement
inacceptable ici serait un échec silencieux — ce dépôt en a déjà payé trois.

Quand la ligne en place est VIVANTE, c'est un doublon ordinaire : on ne s'en mêle pas et
l'erreur d'origine remonte telle quelle. Parler de suppression y serait un mensonge.

**Avant `function isUniqueConstraintViolation(error: unknown): boolean {`**

Le pilote libSQL ne classe pas ses erreurs : on lit le texte. Les deux formes rencontrées sont
`SQLITE_CONSTRAINT_UNIQUE` (code) et `UNIQUE constraint failed` (message) selon que l'erreur
remonte du client ou de l'enrobage Drizzle.

## `features/employee/infrastructure/repositories/in-memory-employee.repository.ts`

**Avant `export class InMemoryEmployeeRepository implements EmployeeRepository {`**

Doublure de `DrizzleEmployeeRepository`, utilisée par tous les tests de tools.

⚠️ Elle doit se comporter comme l'implémentation réelle, y compris sur le soft delete : si
elle diverge, le run unitaire valide un comportement que la production n'a pas. C'est le
contrat que verrouille `tests/unit/repositories/employee-soft-delete.test.ts`, exécuté sur
les DEUX implémentations.

**Avant `private deletedAt = new Map<string, string>();`**

L'état de suppression vit HORS de `store`, et c'est ce qui reproduit la propriété que le SQL
obtient en ne nommant pas `deleted_at` dans son upsert : `save()`/`update()` réécrivent la
fiche sans toucher à sa suppression, donc aucune résurrection accidentelle.

**Avant `async findByName(query: string, limit: number): Promise<Employee[]> {`**

 Même rapprochement que la production — le module partagé est le seul juge.

**Avant `for (const existant of this.store.values()) {`**

Reproduit la contrainte UNIQUE sur l'email, que le soft delete rend visible : une fiche


supprimée OCCUPE toujours son adresse. Sans cela, la doublure accepterait une création que

la production refuse — l'écart le plus coûteux qu'une doublure puisse porter.
**Avant `async delete(id: string): Promise<void> {`**

 Idempotent, comme le `WHERE deleted_at IS NULL` du SQL : la date d'origine ne bouge pas.

---

## Décisions extraites du code le 2026-08-21

> Le code ne porte plus ce texte. L'ancre est la **déclaration**, jamais un numéro
> de ligne : l'audit du 2026-08-21 a mesuré 5 424 ancres `L.N` dont 153 exactes.
> Un numéro de ligne se périme au premier retrait de commentaire.

### `src/features/employee/application/tools/find-employee-by-email.ts`

**Avant `let memberEarly: Awaited<ReturnType<NonNullable<typeof directory>['findByEmail']>> = null;`**

On ne consulte l'annuaire que si le dossier n'a rien donné : c'est un aller-retour, et
ce dépôt les compte. Écrit en deux temps plutôt qu'en ternaire imbriqué — la forme
condensée cachait l'ORDRE, qui est précisément ce qui compte ici.

**Avant `const resolvedId = employee?.id ?? memberEarly?.employeeId ?? null;`**

⚠️ **ANTI-ORACLE — le verdict est le MÊME que l'adresse désigne quelqu'un ou personne.**

Sans cela, ce tool répond `found: true/false` sur une adresse arbitraire, à n'importe
qui : c'est l'énumération de l'annuaire une adresse à la fois. `getEmployeeProfile` a
été retravaillé pour ne pas être cet oracle — « il passe l'identifiant RÉSOLU **ou
`null`** » — et la même précaution n'avait pas été portée ici.

⚠️ **On résout D'ABORD, on décide ENSUITE.** L'ordre inverse (refuser avant de lire)
serait plus économe mais rouvrirait l'oracle : il faut connaître la cible pour savoir
si le demandeur y a droit, et c'est précisément pour cela que le refus ne peut pas
tomber avant la lecture sur CE chemin — contrairement au chemin par identifiant, où il
le peut et où il le fait.

**Avant `function unresolvable(requesterEmployeeId: string | undefined) {`**

Le verdict rendu quand le demandeur n'a pas à tenir cet identifiant.

⚠️ **Il n'affirme PAS que l'adresse ne désigne personne** — ce serait un mensonge dans la
moitié des cas, et ce dépôt ne fabrique pas de faux négatifs pour se protéger. Il dit
seulement qu'il ne peut pas résoudre, ce qui est exactement vrai : la résolution est refusée.

⚠️ Il porte le MÊME `hint` d'auto-résolution que le vrai « non trouvé », sans quoi la
différence de forme rouvrirait l'oracle qu'on vient de fermer.

### `src/features/employee/application/tools/find-person-by-name.ts`

**Avant `const WITHHELD_HINT =`**

⚠️ Le hint dit au modèle ce qu'il PEUT faire, pas ce qui lui est refusé — un refus détaillé
l'inviterait à contourner, et ce dépôt a mesuré cinq consignes en échec. Il ne nomme donc ni
la garde, ni le niveau, ni ce qui manque.

**Avant `export function makeFindPersonByName(repo: EmployeeRepository, directory?: DirectoryRepository) {`**

⚠️ **LA CLÉ NE SORT QUE POUR QUI PEUT S'EN SERVIR — 2026-08-21.**

Ce résolveur n'a jamais consulté de garde : il rendait l'UUID interne, le poste et le statut
de n'importe qui, à n'importe qui, depuis n'importe quel message Slack — invité mono-canal
compris. Sur treize outils, dix consultaient une frontière ; celui-ci et son voisin par email
étaient les deux exceptions qui rendent un IDENTIFIANT.

⚠️ **ON NE BLOQUE PAS, ON RÉDUIT.** La contrepartie est écrite noir sur blanc dans ce dépôt :
« un agent qui ne sait pas résoudre une personne ne peut RIEN faire », et le câblage manquant
a déjà produit une boucle sans sortie le 2026-08-10. Une garde bloquante casserait le produit
pour fermer une fuite modeste.

L'UUID est la CLÉ : c'est lui qui rend l'appel SUIVANT possible. Un demandeur non autorisé
garde donc de quoi poursuivre le dialogue (le nom) et perd de quoi agir. Il ne perd rien
d'utile au passage : `getEmployeeProfile`, `generateDocument`, `sendNotification` et
`scheduleReminder` lui refuseraient déjà cet identifiant. Ce qu'on retire, c'est l'illusion
qu'il pourrait s'en servir — et l'énumération qui va avec.

⚠️ **Hors contexte Slack, on retient AUSSI.** `mayTouchRecord` répond `true` sans contexte,
par conception (playground, workflow, test). On ne renverse pas ce fail-open — mais un
résolveur n'a aucune raison de rendre un UUID à un appelant dont on ignore l'identité.

**Avant `function projectEmployee(`**

Les deux projections sont sorties d'`execute` le 2026-08-21 : la réduction de sortie l'avait
portée à une complexité cognitive de 18 (seuil 15), et une fonction qui décide À LA FOIS de la
résolution et de ce qui sort est exactement celle qu'on relit mal le jour où l'une des deux
doit bouger.

**Avant `// personne n'a pas de dossier » n'est pas « tu n'as pas à tenir son identifiant ».`**

Deux raisons distinctes de joindre un hint, et elles ne disent pas la même chose : « cette

**Avant `let hint: string | undefined;`**

personne n'a pas de dossier » n'est pas « tu n'as pas à tenir son identifiant ».
