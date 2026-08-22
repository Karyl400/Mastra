# Feature `onboarding`

> Décisions de conception, extraites des commentaires du code le 2026-08-20.
> Périmètre : `src/features/onboarding/`
>
> Chaque entrée est ancrée sur la **déclaration** qu'elle précédait, jamais sur un numéro
> de ligne : l'audit du 2026-08-21 a mesuré 5 424 ancres `L.N` dont **153 exactes (2,8 %)**.
> Un numéro de ligne se périme au premier retrait de commentaire — c'est-à-dire aussitôt.
>
> Le code ne porte plus ce texte : **c'est ici qu'il vit désormais.**

---

## `features/onboarding/application/agents/onboarding-orchestrator.ts`

**Avant `export function makeOnboardingOrchestrator(tools: ToolsInput) {`**

── Ce qui a été SUPPRIMÉ le 2026-08-11, et pourquoi ────────────────────────
« Pour une notification ou un email, passe la main à l'agent de notification. »

Aucun mécanisme de passation n'existe : ni tool, ni primitive de routage
accessible au modèle. Le choix de l'agent est fait EN AMONT, dans
`slack-events.handler.ts`, sur le texte du message ; un agent en cours
d'exécution ne peut rien transmettre à un autre. Cette ligne ordonnait donc
l'impossible — et une instruction impossible n'est pas neutre : elle invite le
modèle à NARRER la délégation (« je transmets ça à l'agent de notification »),
ce qui se lit comme une action réalisée. Elle était en plus repayée à chaque
aller-retour. Elle est remplacée par la frontière dérivée ci-dessous, qui dit
la vérité : ces outils-là, et rien d'autre.

── Le bloc CRÉATION D'EMPLOYÉ, resserré et non supprimé ────────────────────
C'est le seul refus qui ait fonctionné en production (A3), et le chemin de
remplacement qu'il cite est RÉEL : `handleTeamJoin` ouvre un DM portant le
bouton « Compléter mon profil », la modale collecte les données et le workflow
est appelé en code, sans LLM. Ce qui manquait était sa CONDITION : ce DM ne part
que quand la personne rejoint le workspace Slack. Dire « elle recevra un
formulaire » sans dire quand laisse croire à une RH que le dossier est réglé,
alors que rien ne partira tant que l'arrivée n'a pas eu lieu.

── Le bloc DOCUMENTS ───────────────────────────────────────────────────────
Il a été réécrit le 2026-08-11 quand la livraison est devenue réelle : le tool
rend un vrai fichier et le livre. Deux choses n'ont pas bougé : l'interdiction
d'inventer un lien (le fichier est livré par UPLOAD, aucune URL de
téléchargement n'existe dans ce système — c'est par ce trou qu'est passé le faux
`https://kisso.internal/docs/<uuid>/download`), et l'obligation de lire le champ
`delivery` plutôt que de supposer.

⚠️ « Dans `content` : ni markdown ni emoji » a été RETIRÉ le 2026-08-19, et remplacé par
« rédige `content` toi-même ». Deux raisons, toutes deux mesurées :
  1. la consigne était REDONDANTE avec le code — `document-template.ts` TRADUIT le markdown
     (`#` → titre, `- ` → puce), élimine `**gras**` et retire les emojis. On payait des
     tokens à chaque aller-retour pour une contrainte que le rendu applique de toute façon ;
  2. elle a FUITÉ vers l'utilisateur. Constaté en production le 2026-08-19 sur « Génère-moi
     le guide d'accueil en PDF » : « Peux-tu me fournir le contenu (sans markdown ni
     emoji) ? » — une contrainte de rendu interne, remontée telle quelle à un humain, dans
     une phrase qui refusait déjà de faire le travail.

⚠️ Et c'est le second volet du même relevé : le `.describe()` de `content` disait « rédige-le,
ne le demande pas » depuis le 2026-08-18, et le modèle a redemandé. Cinq mots ne pèsent pas
face à `AGENT_ANTI_INVENTION_BLOCK` (« n'invente jamais une donnée absente : demande-la »),
qui est dans le PROMPT. La consigne existe désormais des deux côtés — champ ET bloc — et son
effet sera remesuré. Si elle échoue encore, le correctif suivant est du CODE, pas du texte.

⚠️ « Cite toujours le `recipient` » a été ajouté le 2026-08-14 (≈ 6 tokens). Le relevé de
production montre les DIX documents de la base enregistrés sous l'UUID de Karyl, dont un
intitulé « Bienvenue Awa » — dont l'email est donc parti à l'adresse de Karyl. La cause
est corrigée en amont (`findPersonByName` : aucun tool ne résolvait un prénom) ; cette
consigne-ci ne fait que rendre l'erreur VISIBLE au tour même, en obligeant le modèle à
dire pour qui il vient de produire. C'est une mesure de visibilité, pas une garantie.

S'y ajoute la seule contrainte existante sur le CONTENU d'un document.
`sanitizeAgentOutput` ne s'applique qu'à `response.text` : les arguments de tool
ne le traversent jamais. Vérifié en décodant la CMap de vrais PDF — les emojis
sortent en glyphe `.notdef` (carrés, Roboto étant la seule police du VFS) et le
markdown s'imprime littéralement. Un filet de code est posé par ailleurs et
reste le seul garant réel ; cette consigne est la ceinture, pas les bretelles.

## `features/onboarding/application/services/run-onboarding.ts`

**Avant `export interface OnboardingProfile {`**

Le lancement du workflow d'intégration, à UN SEUL endroit.

## Pourquoi il a été extrait de la route d'interactivité — 2026-08-19

Il y a désormais DEUX façons de renseigner un dossier : la soumission d'une modale, et un
échange écrit (`profile-chat.ts`), devenu le chemin principal parce qu'une modale ne peut
pas s'ouvrir sur ce déploiement — un `trigger_id` expire en 3 s, le démarrage à froid
mesuré est de 5,2 s.

Deux appelants pour un même geste, c'est exactement la configuration où ce dépôt a déjà
payé cher : deux chemins vers le formulaire de profil avaient divergé en un jour, et celui
qu'on exerçait le moins était le cassé. La règle vit donc ici, et les appelants ne
fournissent que ce qui LEUR est propre — comment parler à la personne, et quoi faire une
fois le dossier créé.

⚠️ `getWorkflow()` prend la CLÉ DU REGISTRE (`src/mastra/index.ts`), pas l'`id` interne du
workflow — ce dernier ne se résout que via `getWorkflowById`. Une clé erronée rend
`undefined` et lève un `TypeError` DANS LA TÂCHE DE FOND, donc invisible.

**Avant `export interface OnboardingProfile {`**

 Les quatre champs sans lesquels un dossier n'est pas exploitable.

**Avant `employeeId?: string;`**

⚠️ `employeeId` est bien dans `onboardingOutputSchema` — il est déclaré ici parce que ce

type est écrit à la main : `getWorkflow()` rend `unknown` et Mastra ne publie pas le

type de sortie. C'est lui qui relie le dossier créé à l'entretien.
**Avant `readonly getWorkflow: (key: string) => unknown;`**

 Le registre Mastra. Typé au plus juste : `getWorkflow` rend `unknown`.

**Avant `readonly notify: (text: string) => Promise<void>;`**

 Comment parler à la personne. Ne doit jamais lever.

**Avant `readonly onRecordReady: (employeeId: string | undefined) => Promise<void>;`**

 Appelé quand un dossier EXISTE — succès comme dégradation.

**Avant `export function onboardingRunId(email: string): string {`**

Identifiant de run dérivé de l'email.

Deux soumissions du même profil produisent le même `runId`, donc le même run — y compris
depuis deux instances serverless concurrentes. C'est ce qui rend l'idempotence indépendante
du cache mémoire de `create-employee.ts`, inopérant hors d'un processus unique.

**Avant `department: null,`**

Plus JAMAIS renseigné : le parcours d'arrivée a cessé de collecter le département le

2026-08-13, et `employees.department` est nullable depuis la même date.
**Avant `startDate,`**

Dérivée de l'instant du `team_join`, jamais saisie : voir `startDateFromJoin`.

**Avant `slackChannelId: null,`**

Aucune correspondance département → canal n'existe aujourd'hui : le workflow saute

alors l'invitation Slack, sans échouer.
**Avant `await deps.notify(PROFILE_SUBMISSION_FAILED_REPLY);`**

⚠️ Il n'y a PAS de dossier ici : c'est le seul cas où l'on demande de recommencer. La

soumission est idempotente, une seconde tentative ne créera pas de doublon.
**Avant `const degradedSteps = result.result?.degradedSteps ?? [];`**

⚠️ `result.status === 'success'` ne signifie QUE « le workflow est allé au bout ». Le

verdict est `result.result.outcome` : les étapes best-effort avalent leur exception et

laissent le run en `success` même quand rien n'est parti. Journaliser le seul `status`

reproduirait exactement le faux « PASS » que ce champ existe pour éliminer.
**Avant `const missing = describeMissingSteps(degradedSteps);`**

⚠️ Le dossier EXISTE : on ne demande pas de recommencer, on NOMME ce qui manque. La

liste vient du verdict réel, jamais devinée — annoncer un email non parti alors qu'il

l'est serait le mensonge inverse de celui qu'on corrige. Une liste vide n'envoie rien

plutôt qu'un message creux.
**Avant `await deps.onRecordReady(result.result?.employeeId);`**

⚠️ Appelé sur `completed` ET sur `degraded`, et cette distinction compte. `degraded`

signifie « l'employé EST créé, une étape best-effort a échoué ». C'est un ABOUTISSEMENT :

le workflow existe précisément pour ne pas perdre la création sur une indisponibilité SMTP

de trente secondes. Le cas `failed` sort plus haut par `return` — là, il n'y a pas de

dossier.
## `features/onboarding/application/tools/update-onboarding-status.ts`

**Avant `const NO_PROGRESS_HINT =`**

Met à jour l'avancement du parcours d'intégration.

── Pourquoi ce tool ne lève plus ───────────────────────────────────────────
Il levait `NotFoundError('OnboardingProgress')` dès que l'employé n'avait pas
de ligne `onboarding_progress` — c'est-à-dire, mesuré sur la Turso de
production le 2026-08-11, pour 100 % des employés : les deux profils en base
ont été créés par le tool `createEmployee` (un simple `repo.save`), et seul
`employeeOnboardingWorkflow` écrivait le suivi.

Cette exception n'était pas un échec ordinaire. L'AI SDK v7 capture ce que
lève un tool et le convertit en part `tool-error` RÉINJECTÉE au modèle : le
catch générique du handler Slack n'est jamais atteint. Le modèle reçoit donc
« ce suivi n'existe pas », en déduit qu'une étape lui manque, et INVENTE la
capacité qui la comblerait — reproduit en conditions réelles : « Souhaites-tu
que je crée un enregistrement d'onboarding ? » suivi d'un appel à un tool
`createOnboarding` inexistant. C'est la même mécanique que l'over-promise
« as-tu besoin de créer un profil ? » observée en production.

── L'arbitrage : résultat structuré, PAS de création implicite ─────────────
L'autre option était de créer le suivi manquant à la volée. Elle est écartée
pour trois raisons :

 1. Un suivi seul ne vaut RIEN. Le parcours, c'est le suivi PLUS les cinq
    tâches et leurs étapes (`domain/services/onboarding-plan.ts`). Poser un
    compteur `totalSteps: 5` sans tâche derrière, c'est exactement le défaut
    déjà corrigé le 2026-08-10. Le faire ici obligerait ce tool à dépendre
    aussi de `TaskRepository`.
 2. Ce serait une ÉCRITURE MASSIVE déclenchée par un LLM sur un identifiant
    qu'il peut avoir halluciné : le tool ne dispose d'aucun `EmployeeRepository`
    pour vérifier que la personne existe, et créerait donc volontiers un
    parcours orphelin. Un tool nommé « update » qui insère six lignes est de
    surcroît un effet de bord que rien n'annonce.
 3. Le rattrapage a un propriétaire HUMAIN, exécuté sciemment, jamais un tool.
    ⚠️ Ce point citait `scripts/backfill-onboarding.mts`, **supprimé le 2026-08-14** avec le
    suivi de tâches dont il dérivait les `onboarding_steps`. L'argument tient toujours — un
    rattrapage se décide, il ne se déclenche pas par effet de bord — mais le script nommé
    n'existe plus. Corrigé le 2026-08-21.

Reste donc à faire ce que `find-employee-by-email.ts` fait déjà : rendre un
résultat qui INSTRUIT le modèle. `hint` lui interdit nommément de proposer
une création — c'est cette phrase, et non le silence, qui empêche l'invention.

 Consigne rendue au modèle quand le suivi n'existe pas.
**Avant `if (!canPerformSideEffects(_ctx?.requestContext, data.employeeId)) {`**

FRONTIÈRE D'AUTORISATION — avant toute lecture, avant toute écriture

Ajoutée le 2026-08-18. Cet outil était, avec `scheduleReminder`, le SEUL écrivain

exposé à un agent qui ne regardait pas qui demande — alors que `sendNotification`,

son voisin de gravité, avait sa garde depuis le 2026-08-13.

Ce que l'absence permettait : `employeeId` est produit par le MODÈLE à partir d'un

texte Slack arbitraire, et un statut `Completed` pose `completedAt` (voir plus bas).

Un invité mono-canal pouvait donc déclarer terminé le parcours d'intégration de

quelqu'un d'autre — et la complétion du profil est le SEUL suivi que ce produit

sache réellement observer depuis le retrait du suivi de tâches.

⚠️ L'ABSENCE de niveau vaut autorisation, exactement comme dans

`send-notification.ts:117` : hors Slack (workflow, playground, test, route `/api/*`

déjà derrière un jeton) il n'y a pas de demandeur à évaluer.

⚠️ Le refus tombe AVANT `findByEmployee` : lire d'abord et filtrer ensuite ferait de

ce tool un oracle d'existence, journaliserait une consultation qui n'aurait pas dû

avoir lieu, et fuirait par la latence. Un test vérifie que le dépôt n'est jamais

touché.
**Avant `return {`**

On INSTRUIT plutôt que de lever — même raison que `sendNotification` : une

exception remonterait au modèle comme une panne, qu'il raconterait ou

réessaierait, soit deux allers-retours gâchés.
**Avant `logger.warn("Aucun suivi d'intégration pour cet employé — mise à jour impossible", {`**

`warn` volontaire : c'est la ligne à chercher quand un agent parle

d'un parcours qui n'existe pas. Elle signale aussi les employés à

passer au rattrapage.
**Avant `logger.warn('Mise à jour du statut sans effet — aucune ligne affectée', {`**

Écriture sur zéro ligne : le suivi a disparu entre la lecture et l'écriture.

On le DIT au lieu d'annoncer un succès — c'est exactement le mensonge mesuré

en production le 2026-08-12, où le bot affirmait « l'avancement de ton

onboarding est mis à jour » sans qu'aucune ligne ne bouge.
**Avant `return {`**

Projection : `id`, `employeeId` et les horodatages techniques n'aident

en rien le modèle et sont repayés à chaque aller-retour (plafond Groq

12 000 tokens/minute). Même règle que `task-summary.mapper.ts`.
## `features/onboarding/application/workflows/employee-onboarding.ts`

**Avant `const onboardingInputSchema = z.object({`**

SCHEMAS

⚠️ `department` et `position` DOIVENT appliquer ici les mêmes règles que le tool.

Ce workflow constitue une SECONDE porte d'entrée vers `employees`, à côté du tool
`createEmployee` — et, depuis le flux d'arrivée, la modale Slack en est une
troisième. Tant qu'il déclarait `z.string().min(1)`, la validation n'était
appliquée que sur le chemin agent : un appel direct à
`POST /api/workflows/employeeOnboardingWorkflow/start-async` avec
`department: "Wakanda"` renvoyait `status: 'success'` et persistait la valeur.

**`department` reste une allowlist, `position` n'en est plus une.** Ce n'est pas
une incohérence : le département pilote le routage vers les canaux Slack et les
règles métier, donc il doit appartenir à un ensemble fermé. Le poste, lui, est un
intitulé rédigé par la personne qui arrive — l'ancienne enum de 24 valeurs ne
contenait même pas « Software Engineer » et rejetait des saisies légitimes. Il est
désormais validé en FORME (longueur, jeu de caractères), pas en appartenance.

On réutilise l'enum `Department` (source unique de vérité) et NON
`departmentSchema` / `positionSchema` de `shared/validation` : ces derniers sont
bâtis sur `z.preprocess(...)`, dont le type d'ENTRÉE est `unknown`, ce qui casse
l'inférence de types entre les étapes du workflow (`.then(createEmployeeStep)`).
Les contraintes de `position` sont donc recopiées depuis
`VALIDATION_CONSTRAINTS.POSITION`, qui reste la source unique des valeurs.

Différence assumée avec le chemin tool : pas de `trim` ici. Le tool en a besoin car un
LLM produit des espaces parasites ; ce workflow est appelé par une machine en JSON, où
exiger la valeur exacte est plus sain qu'un nettoyage implicite.
**Avant `department: z.nativeEnum(Department).nullable().optional(),`**

FACULTATIF depuis le 2026-08-13 : le parcours d'arrivée ne le collecte plus, et la modale
Slack passe désormais `null`. Le schéma de VALEUR est inchangé — quand une valeur est
fournie (appel direct de l'API des workflows), elle doit toujours appartenir à l'enum.
On assouplit la présence, jamais la validité : c'est la présence qui a cessé d'être
exigible, pas « Wakanda » qui est devenu acceptable.

**Avant `alreadyExisted: z.boolean(),`**

Le dossier existait-il DÉJÀ pour cette adresse ?

Ce workflow échouait purement et simplement sur un email connu (`ConflictError`), et deux
tests verrouillaient cet échec. C'était défendable quand la création était un geste
d'administration : refuser un doublon protégeait la base.

⚠️ Le point d'entrée a changé. Le seul appelant est désormais la soumission de la modale
« Compléter mon profil », où le demandeur EST la personne concernée, identifiée par Slack.
Un échec y signifie : la personne remplit le formulaire, valide, et **ne reçoit rien** —
ni dossier, ni message, ni explication. Mesuré en production le 2026-08-15 : « Profile
submission accepted » puis « Onboarding workflow failed », en silence.

On réutilise donc le dossier existant au lieu de lever. Le drapeau voyage jusqu'à l'email
de bienvenue, qui n'a rien à faire d'être renvoyé à quelqu'un déjà accueilli.

**Avant `const stepFailureSchema = z.object({`**

Une étape best-effort en échec, transportée d'étape en étape jusqu'à la
sortie. Le tableau est CUMULATIF : chaque étape recopie ce qu'elle a reçu et
y ajoute son propre échec, faute de quoi la dernière écraserait les
précédentes et l'email masquerait Slack.

**Avant `alreadyExisted: z.boolean(),`**

 Propagé depuis `employeeCreatedSchema` : décide si l'email de bienvenue part.

**Avant `position: z.string(),`**

⚠️ `department` a été retiré de ce chaînage le 2026-08-20 : son seul lecteur en aval

était l'email de bienvenue, et « les départements ne doivent plus apparaître ». Il reste

dans `employeeCreatedSchema` et en base — c'est la SORTIE qui change, pas la donnée.

⚠️ AJOUTÉS le 2026-08-14. `employeeCreatedSchema` les portait déjà, mais ce schéma-ci les

JETAIT — deux étapes avant l'email de bienvenue, qui était donc générique faute de

matière, alors que la matière avait été saisie dans la modale. La personnalisation

n'était pas absente par choix : elle était perdue en route.
**Avant `const onboardingOutputSchema = z.object({`**

Sortie du parcours.

⚠️ `outcome` est le champ à lire, PAS le `status` du run Mastra. Ce dernier
vaut `'success'` dès que le workflow est allé au bout, y compris quand
l'email de bienvenue n'est jamais parti — c'est exactement ce qui a produit
de faux « PASS » dans les rapports de test (cf. `onboarding-outcome.ts`).

`emailSent` et `slackInvited` sont CONSERVÉS bien que redondants avec
`degradedSteps` : les instructions des agents (`AGENT_ANTI_INVENTION_BLOCK`),
`scripts/production-scenarios.mjs` et `docs/guides/tests-manuels.md` les
nomment explicitement. Les retirer casserait ces trois lecteurs pour un gain
cosmétique.

**Avant `export function createEmployeeOnboardingWorkflow(deps: {`**

FACTORY

**Avant `const createEmployeeStep = createStep({`**

Step 1 : créer l'employé en base

**Avant `const existing = await deps.employeeRepo.findByEmail(inputData.email);`**

RÉUTILISATION, et non conflit — voir `alreadyExisted` dans le schéma de sortie.

**Avant `const normalizedInput = {`**

Normaliser les champs optionnels avec null par défaut

**Avant `const initOnboardingStep = createStep({`**

Step 2 : initialiser l'onboarding progress

**Avant `const existingProgress = await deps.onboardingRepo.findByEmployee(inputData.employeeId);`**

⚠️ IDEMPOTENT, même raison que l'étape précédente. `onboarding_progress.employee_id`

porte une contrainte d'UNICITÉ : ré-insérer pour un employé qui en a déjà un lève

`SQLITE_CONSTRAINT` et fait échouer tout le workflow. Mesuré en production le

2026-08-15, juste après avoir rendu la création d'employé idempotente — le défaut

s'était simplement déplacé d'une étape.

On RELIT le suivi existant plutôt que d'en créer un second : il porte l'avancement

réel de la personne, qu'une réinitialisation effacerait.
**Avant `const reconciled = existingProgress ? reconcileProgress(existingProgress) : null;`**

⚠️ RÉCONCILIÉ, jamais recopié tel quel. Constaté en production le 2026-08-18 :

« Statut d'onboarding : en cours (étape 1 sur 5) » alors que `ONBOARDING_TOTAL_STEPS`

vaut 1 depuis le retrait du suivi de tâches. La ligne datait d'avant, et l'idempotence

ajoutée le 2026-08-17 la RÉUTILISAIT sans la corriger : le bot annonçait donc à

quelqu'un un parcours en cinq étapes dont quatre n'existent plus. Une donnée héritée

ne se périme pas toute seule — c'est le code qui la relit qui doit la ramener au

barème courant.
**Avant `logger.info('Onboarding — suivi hérité ramené au barème courant', {`**

`reconcileProgress` rend l'objet D'ORIGINE quand il est déjà cohérent : l'identité

référentielle est ce qui nous dit s'il y a quelque chose à écrire. Une écriture

inutile ferait bouger `updatedAt` sans raison.
**Avant `const degraded: StepFailure[] = [];`**

⚠️ Ce tableau reste, VIDE, et ce n'est pas un résidu.

Il portait l'échec de création des cinq tâches d'intégration, retirées le

2026-08-14 : un plan qu'aucun mécanisme ne faisait avancer. Le tableau est

conservé parce qu'il traverse le schéma de sortie de cette étape et se cumule

avec ceux des deux étapes suivantes (email, invitation Slack) — le supprimer

obligerait à réécrire le chaînage pour ne rien gagner.

La sauvegarde du suivi, elle, n'est PAS best-effort : elle est au-dessus, hors

du `try`. Sans `onboarding_progress`, `updateOnboardingStatus` et

`getEmployeeProfile` dégradent tous les deux — c'est un échec du parcours, pas

une dégradation à noter au passage.
**Avant `const sendWelcomeEmailStep = createStep({`**

Step 3 : envoyer l'email de bienvenue

**Avant `const { subject, body } = buildWelcomeEmail({`**

⚠️ Le texte vit dans le DOMAINE depuis le 2026-08-14, et il a changé de fond.

L'ancien promettait « les accès à nos outils ainsi que votre planning de première

semaine » — or il n'existe NI provisioning NI planning dans ce système. C'était le

tout premier message de l'entreprise à un arrivant, et il ouvrait sur une promesse

que rien ne tient. Voir `domain/services/welcome-email.ts`.
**Avant `if (inputData.alreadyExisted) {`**

⚠️ NON APPLICABLE ≠ DÉGRADÉ, distinction déjà tranchée dans ce dépôt. Renvoyer un

email de BIENVENUE à quelqu'un qui a déjà un dossier n'est pas un échec : c'est une

étape qui n'avait pas lieu d'être. La compter comme dégradation rendrait « dégradé »

le cas normal d'une re-soumission du formulaire et détruirait le signal.
**Avant `await deps.emailProvider.sendEmail(inputData.email, subject, htmlEmailBody(body));`**

`htmlEmailBody` et non `textEmailBody` : `welcome-email.ts` produit

délibérément du HTML et échappe déjà ses valeurs interpolées avec `esc()`.

Échapper une seconde fois afficherait `<p>` littéralement dans le tout premier

message que l'entreprise envoie à un arrivant.
**Avant `const inviteToSlackStep = createStep({`**

Step 4 : inviter sur Slack (best-effort)

**Avant `const conclude = (slack: { slackInvited: boolean; slackUserId?: string }) => {`**

Point de sortie UNIQUE de tout le parcours : c'est ici, et nulle part
ailleurs, que le verdict est calculé et journalisé. Les quatre `return`
précédents de cette étape rendaient chacun sa forme, et rien ne
garantissait qu'un cinquième penserait à conclure.

**Avant `logger.error('Onboarding terminé en mode DÉGRADÉ', {`**

Niveau `error`, et non `warn` comme le marqueur de progression Slack

(`slack-progress.ts`). L'arbitrage n'est pas le même : le marqueur

n'est qu'un confort dont l'absence saute aux yeux, alors qu'un email

de bienvenue jamais parti n'a AUCUN symptôme — l'arrivant ignore

qu'il aurait dû le recevoir, et le run se déclare `success`. Réparer

exige une action humaine (renvoi, invitation manuelle), donc la

ligne doit alerter et rester cherchable. Même raisonnement que la

dégradation de `claimEvent()` dans le handler Slack.
**Avant `if (!deps.slackProvider || !inputData.slackChannelId) {`**

NON APPLICABLE ≠ DÉGRADÉ. Sans provider ni canal de département,

l'invitation n'était pas censée avoir lieu — et c'est le cas de TOUTE

soumission de la modale Slack, qui passe `slackChannelId: null` faute

de correspondance département → canal. La compter comme dégradation

rendrait « dégradé » l'état NORMAL et détruirait le signal.
**Avant `logger.warn('Utilisateur Slack non trouvé', { email: inputData.email });`**

Ici le canal EST configuré : l'invitation était attendue et n'a pas

eu lieu. C'est un trou réel dans l'accueil (l'arrivant n'atterrit

dans aucun canal), pas une étape hors sujet.
**Avant `const workflow = new Workflow({`**

Assemblage du workflow

## `features/onboarding/domain/ports/onboarding-interview.repository.ts`

**Avant `export interface OnboardingInterview {`**

L'ENTRETIEN post-profil : ce que la personne dit d'elle une fois son dossier créé.

── Ce qu'il remplace ───────────────────────────────────────────────────────
La feature `questionnaire`. Relevé sur la Turso le 2026-08-14 : 5 questionnaires
enregistrés, **0 réponse** — il n'existait ni formulaire Block Kit, ni modale, ni route de
soumission, donc rien qu'un humain puisse remplir. Le tool le disait lui-même dans son
`hint`, ce qui prouve qu'on le savait sans le corriger.

L'entretien inverse la construction : le formulaire existe D'ABORD (Block Kit, écrit en
code), et ce qui est stocké est ce qu'une personne a réellement répondu.

── Ce que les réponses servent ─────────────────────────────────────────────
 1. **Les canaux, immédiatement et déterministiquement.** La soumission invite réellement
    aux canaux cochés — aucun modèle sur ce chemin, la liste est fermée et vient de Slack.
 2. **Le guide de bienvenue**, qui cesse d'être générique : le gabarit imprime la matière
    réelle au lieu de puces écrites en dur.

⚠️ TypeScript pur — cette entité traverse la couche `domain`.

**Avant `readonly channels: readonly string[];`**

 Identifiants `C…`, jamais les noms : un canal se renomme, son ID non.

**Avant `readonly dailyWork: string;`**

 Ce que la personne fait au quotidien. Chaîne vide = non renseigné, jamais `null`.

**Avant `readonly workStyle: string;`**

 Comment elle préfère travailler. Chaîne vide = non renseigné.

**Avant `listAll(): Promise<OnboardingInterview[]>;`**

Tous les entretiens.

⚠️ Ajouté le 2026-08-19 pour `findExpertise`, sur un défaut mesuré en production : à
« qui s'occupe du support technique ? », l'outil a répondu « aucun collaborateur n'est
identifié » alors que la personne venait d'écrire, dans son entretien, qu'elle fait du
support technique. La réponse était HONNÊTE — la donnée était ailleurs — mais l'entretien
est le seul endroit où quelqu'un décrit son métier avec ses mots, ce qui est exactement ce
qu'une recherche d'expertise cherche.

Pas de pagination : la table a UNE ligne par employé, et `employees` en compte deux. Si
elle devait croître, c'est la borne de `findExpertise` (6 résultats) qui protège le
tool-result, pas celle-ci.

**Avant `save(interview: OnboardingInterview): Promise<void>;`**

Écrit l'entretien, en ÉCRASANT le précédent s'il existe.

`employee_id` est la clé primaire : un employé a un entretien, pas une collection. Une
seconde soumission est une CORRECTION, pas une nouvelle réponse — et laisser deux lignes
coexister obligerait chaque lecteur à choisir laquelle fait foi, ce que personne ne ferait
deux fois de la même façon.

⚠️ `createdAt` de l'appelant n'est retenu qu'à l'INSERT. Une correction ne doit pas
réécrire la date du premier entretien — même invariant que `first_seen_at` dans
`slack_directory`, et pour la même raison : c'est un fait, pas un champ de mise à jour.

## `features/onboarding/domain/ports/onboarding.repository.ts`

**Avant `update(progress: OnboardingProgress): Promise<number>;`**

Applique la mise à jour et rend le NOMBRE DE LIGNES affectées.

Le contrat rendait `void`, donc aucun appelant ne pouvait distinguer une écriture
réussie d'une écriture sur zéro ligne — et `updateOnboardingStatus` annonçait au
modèle un `updated: true` constant, vrai par construction. Bug mesuré en production
le 2026-08-12 : le bot a dit « l'avancement de ton onboarding est mis à jour » alors
que rien n'avait bougé.

## `features/onboarding/domain/services/interview-chat.ts`

**Avant `export const INTERVIEW_QUESTION_DAILY =`**

« Parlons de toi » — l'entretien post-profil, en CONVERSATION plutôt qu'en modale.

Pourquoi la modale a été retirée

Pas pour une raison d'ergonomie : parce qu'elle ne s'ouvrait pas. Un `trigger_id` Slack
expire **3 secondes** après le clic, et le démarrage à froid de la fonction a été mesuré le
2026-08-18 à 4,9 s, puis jusqu'à 16 s après une longue inactivité. Or l'inactivité est le
cas NORMAL ici — ce produit voit ≈ 19 messages par jour, et un arrivant est par définition
le premier à écrire. Le bouton était donc structurellement cassé, et son échec ne laissait
aucune trace visible : Slack affiche une erreur générique, la modale n'apparaît pas.

Un échange écrit n'a aucune contrainte de ce type. Il coûte au pire quelques secondes
d'attente, ce qui est le comportement normal d'une conversation.

Pourquoi ZÉRO appel de modèle, et où vit l'état

Le poste de coût dominant de ce dépôt n'est pas la taille des prompts mais le NOMBRE
D'ÉTAPES : chaque aller-retour est une requête pleine chez les deux fournisseurs, sur un
budget de ≈ 19 messages par jour. Un entretien « intelligent » de trois tours coûterait à
lui seul un sixième de la journée du workspace, pour poser deux questions dont le texte est
connu d'avance.

L'état n'est stocké NULLE PART, et c'est la clef de la conception : il se lit dans le
dernier tour `assistant` du fil, que le handler charge DÉJÀ pour la mémoire
conversationnelle. Aucune table, aucune colonne, aucune lecture supplémentaire sur le
chemin des 3 secondes de l'ACK.

⚠️ Conséquence assumée : l'historique est borné par `CONVERSATION_TTL_MS` (60 min). Une
réponse donnée le lendemain n'est plus reconnue comme une réponse d'entretien et part chez
l'agent. C'est un abandon SILENCIEUX mais pas un mensonge — rien n'a été promis entre-temps —
et le parcours se relance depuis « C'est fait ». L'alternative (une table d'état) coûterait
une lecture par message pour un cas qui se joue en deux minutes.

⚠️ LES DEUX QUESTIONS SONT DES CONSTANTES, et c'est ce qui fait tenir la machine à états :
on reconnaît l'étape en cours en COMPARANT le dernier tour du bot à ces chaînes. Les
reformuler ailleurs — dans le verdict de « C'est fait », par exemple — casserait la
reconnaissance sans qu'aucun type ne bouge et sans qu'aucun test unitaire de ces
constantes ne rougisse. C'est pourquoi `profile-completion.ts` importe la première d'ici
au lieu de la réécrire.

⚠️ mrkdwn Slack (`*gras*`), jamais markdown GitHub : ces textes sont postés en dur et ne
passent par AUCUN filtre — `sanitizeAgentOutput` n'a qu'un seul site d'appel, la réponse
d'un modèle.

⚠️ « je m'en sers pour te proposer les bons canaux » a été RETIRÉ le 2026-08-19 : RIEN ne
proposait de canal. Le seul écrivain de `onboarding_interview.channels` était la modale,
morte le même jour ; le chemin conversationnel écrit `channels: existing?.channels ?? []`.
La promesse était faite au PREMIER message utile que reçoit un arrivant.

⚠️ Et un usage RÉEL n'était pas annoncé : cette phrase alimente `findExpertise`. Quand un
collègue demande « qui s'occupe du backend ? », il reçoit ces mots-là. Ce que la personne
écrit en confiance dans un questionnaire d'accueil devient sa fiche consultable — un
changement d'usage que l'en-tête de `find-expertise.ts` disait lui-même devoir « se demander
avant de se coder », et qui a été codé sans que la question soit tranchée. On le DIT
désormais, ce qui est la moitié la moins chère de la réponse : la personne sait, et rien
n'est retiré. Reste au propriétaire à décider si l'annonce suffit.
**Avant `export type InterviewStep = 'dailyWork' | 'workStyle';`**

 Étape que la réponse courante vient renseigner.

**Avant `export function pendingInterviewStep(lastAssistantText: string | undefined): InterviewStep | nul`**

Quelle question le bot vient-il de poser ?

⚠️ `includes`, et surtout PAS `startsWith` — c'est un défaut mesuré en production le
2026-08-19, sur le chemin nominal, alors qu'un commentaire affirmait ici même le contraire.
Le message qui pose la première question ne COMMENCE pas par elle : le verdict de
« C'est fait » dit « Ton dossier est complet, je l'ai vérifié. On enchaîne. Dis-moi… ».
Avec `startsWith`, la reconnaissance échouait donc systématiquement, et la réponse de la
personne partait chez l'agent — le tout sans le moindre signal, la question s'affichant
parfaitement.

Le handler accole par ailleurs des notes en fin de réponse (accompli requalifié, promesse
d'envoi démentie, couverture d'extraits) : le texte peut donc être encadré des deux côtés.
`includes` est le seul critère qui survive aux deux.

⚠️ STYLE est testé AVANT DAILY, et l'ordre porte un cas réel : rien n'interdit qu'un futur
texte cite les deux. La question la plus AVANCÉE doit l'emporter, sinon l'entretien
boucherait sur sa première étape.

**Avant `export const MAX_INTERVIEW_ANSWER_CHARS = 280;`**

Longueur maximale conservée pour une réponse.

Elle finit dans un document PDF portant le nom de la personne (le gabarit `guide` imprime
« Ton quotidien » et « Ta façon de travailler »). Une borne évite qu'un copier-coller de
trois pages y atterrisse — et elle vaut aussi comme garde-fou de coût, ces champs étant
relus à chaque génération de guide.

**Avant `export function captureInterviewAnswer(text: string | undefined): string | null {`**

La réponse est-elle exploitable ?

⚠️ On REFUSE le vide et le monosyllabe, et on le dit — sans quoi « ok » serait enregistré
comme la description du travail de quelqu'un, puis imprimé dans son guide d'accueil sous
« Ton quotidien ». Le seuil est délibérément bas : on écarte l'accusé de réception, pas la
concision.

**Avant `function isNotAnAnswer(text: string): boolean {`**

Phrases qui ne répondent PAS à la question, tout en étant assez longues pour passer la
borne de quatre caractères.

⚠️ Relevé en production le 2026-08-19, sur le chemin réel : « je n'ai pas fini », écrit
juste après « ce que tu fais au quotidien ? », a été enregistré comme la description du
métier de quelqu'un. Ce champ est imprimé dans le guide d'accueil, sous « Ton quotidien »,
dans un document qui porte le nom de la personne.

C'est la même famille que le refus de « ok » et « 👍 » : ce qui compte n'est pas la
longueur mais le fait que la phrase parle d'AUTRE CHOSE que de la question posée. La liste
est FERMÉE et minuscule — la garde qui compte reste la relance, pas l'exhaustivité.

**Avant `export const INTERVIEW_TOO_SHORT_REPLY =`**

 Ce qu'on répond quand la réponse est trop courte pour vouloir dire quelque chose.

**Avant `export function skipsInterview(text: string | undefined): boolean {`**

 La personne renonce. Reconnu tôt : insister sur un questionnaire d'accueil est le meilleur
moyen de le faire abandonner pour de bon.

**Avant `export const INTERVIEW_SKIPPED_REPLY =`**

⚠️ « Reviens quand tu veux, je reprendrai où on en est » a été RETIRÉ le 2026-08-19 : aucun
mécanisme ne reprend quoi que ce soit. L'état de cette machine EST le dernier tour
`assistant` du fil ; après ce texte, c'est LUI le dernier tour, et il ne correspond à aucun
marqueur — `pendingInterviewStep` rend `null` immédiatement. Même sans cela, le fil expire
en 60 minutes.

C'est `status: 'scheduled'` sans ordonnanceur, mot pour mot, dans un fichier dont l'en-tête
concédait déjà l'abandon silencieux — puis le dé-concédait dans la réponse.

On dit donc ce qui est vrai : le chemin de retour existe, il faut le reprendre du début, et
il tient en trois mots.

**Avant `const FIRST_PERSON = /(?<!\p{L})(?:je|j[’']|mon|ma|mes|moi)(?!\p{L})/u;`**

Ce texte est-il une QUESTION adressée au bot, plutôt qu'une description de son propre métier ?

## Le défaut que ceci ferme

Trouvé EN PRODUCTION le 2026-08-19. Le clic sur « C'est fait » pose la première question
d'entretien et ARME la machine à états. Le message suivant — « qui s'occupe du support
technique ? », une vraie question adressée au bot — était capturé comme la réponse à « ce que
tu fais au quotidien ».

⚠️ Ce champ est IMPRIMÉ dans un document au nom de la personne, sous « Ton quotidien », et
restitué à ses collègues par `findExpertise`. Sa propre question devenait sa fiche publique.

Même famille que « oublie ce que je t'ai dit » enregistré comme un métier, corrigé le matin
même par une autre porte. `captureInterviewAnswer` accepte presque n'importe quel texte PAR
CONCEPTION — on demande à quelqu'un de décrire son travail avec ses mots — et le correctif du
matin n'a fait céder le pas qu'aux court-circuits.

## Pourquoi un critère GRAMMATICAL, et pas une liste de mots

⚠️ `ESCAPE_INTENTS` du routage a été essayé puis ÉCARTÉ : « je fais de la *recherche* » est
une réponse d'entretien parfaitement valide, et `recherche` y est un terme d'échappement. Une
liste de mots-clés casserait des réponses justes.

Le signal qui sépare vraiment les deux cas est la PERSONNE GRAMMATICALE : on décrit son propre
métier à la première personne, on interroge sur autrui sans elle. Le point d'interrogation
seul ne suffit donc pas — « je préfère l'écrit, ça te va ? » reste une réponse.

⚠️ `\p{L}` avec le drapeau `u`, jamais `\b` : ce dépôt a payé trois fois ce piège, `\b`
raisonnant en ASCII et ne matchant jamais une frontière après un caractère accentué.

**Avant `const INTERROGATIVE_OPENERS =`**

 Mots par lesquels s'ouvre une question portant sur quelqu'un ou quelque chose d'AUTRE.

**Avant `if (INTERROGATIVE_OPENERS.test(normalized)) return true;`**

⚠️ L'OUVERTURE INTERROGATIVE PRIME SUR LA PERSONNE, et l'ordre est le fond du prédicat.

« à qui je demande pour un badge ? » contient « je » et reste une question adressée au

bot : la première personne y désigne le demandeur, pas le sujet décrit. Ce cas a été

trouvé en écrivant le test, pas après — c'est ce qui a imposé les deux passes.
**Avant `if (FIRST_PERSON.test(trimmed.toLowerCase())) return false;`**

Hors ouverture interrogative, la première personne tranche : on décrit son propre métier

avec elle. « je fais quoi au juste ? du support niveau 2 » reste donc une réponse — c'est

une hésitation, pas une question posée au bot.
## `features/onboarding/domain/services/newcomer-identity.ts`

**Avant `export interface NewcomerIdentity {`**

L'IDENTITÉ D'UN ARRIVANT et sa date de début — ce qui a survécu aux modales.

Pourquoi ce module existe

Ces deux pièces vivaient dans `notification/infrastructure/handlers/profile-modal.ts`,
supprimé le 2026-08-19 avec les modales. Elles n'avaient rien de modal : un type de données
et un calcul de date pur. Les laisser dans un module de formulaire Slack les rendait
indisponibles à qui n'en construisait pas — et c'est bien ce qui s'est produit : le type a
été importé par le handler d'événements, la route d'interactivité, les blocs d'accueil et un
script de rattrapage, tous par un chemin qui nommait une modale qu'aucun d'eux n'ouvrait.

Ici, en `domain`, sans aucun import : c'est du TypeScript pur, et il le reste.

Ce que le serveur sait d'un arrivant AVANT de lui parler.

⚠️ Le nom `ProfileModalPrefill` a été abandonné avec les modales. Il décrivait un
PRÉ-REMPLISSAGE de formulaire ; il ne reste aucun formulaire, et ce que ces champs portent
n'a jamais été un remplissage mais des FAITS — ce que Slack vient d'annoncer sur une
personne. Un nom qui décrit un mécanisme disparu est la première marche vers un commentaire
qui ment.
**Avant `joinedAt?: string | null;`**

Instant du `team_join`, en ISO 8601 — la date d'arrivée RÉELLE.

Ce n'est pas une valeur de remplissage : c'est le fait que Slack vient d'annoncer, et
c'est précisément pour cela qu'aucune question de date n'est jamais posée. Une question
dont le serveur connaît déjà la réponse ne doit pas être posée — chaque champ demandé est
un champ qu'on peut remplir de travers ou laisser en plan.

Absent quand l'arrivée n'est pas connue (rattrapage d'une personne déjà présente) :
l'appelant retombe alors sur l'instant courant.

**Avant `export function normalizeStartDate(date: string): string {`**

Journée UTC en ISO complet.

⚠️ Concaténation pure, jamais d'objet `Date`. Le « correctif » naturel
`new Date(d + 'T00:00:00').toISOString()` décale d'un jour dès que le runtime n'est pas en
UTC : mesuré en UTC+1, `2026-09-01` devient `2026-08-31T23:00Z`. L'écart dépend de `TZ`,
donc il ne se voit ni en test local ni en revue.

**Avant `export function startDateFromJoin(joinedAt: string | null | undefined, now: Date): string {`**

Date de début, DÉRIVÉE de l'arrivée Slack.

Aucune question de date n'est posée à l'arrivant parce que la réponse est déjà connue : il
commence le jour où le workspace l'annonce. Le repli sur `now` couvre le RATTRAPAGE — une
personne déjà présente quand le bot a été installé, dont l'arrivée n'a jamais été
annoncée — et il est exact pour elle aussi, à ceci près qu'il date la déclaration plutôt que
l'arrivée.

⚠️ Le passage par `slice(0, 10)` puis `normalizeStartDate` est délibéré : il borne au JOUR,
en UTC, sans jamais reconstruire une `Date` à partir d'une chaîne locale.

## `features/onboarding/domain/services/onboarding-nudge.ts`

**Avant `const PROFILE_LABELS: Readonly<Record<ProfileStep, string>> = {`**

LE RAPPEL DISCRET — quand quelqu'un laisse son dossier en plan et parle d'autre chose.

Le défaut, signalé par le propriétaire

« Lorsqu'un nouvel arrivant complète son profil puis ne dit pas "c'est fait" ou équivalent
mais change de sujet, le ramener subtilement à la complétion du profil. »

Ce qui se passait : une question d'accueil attend, la personne demande autre chose. Le
message ne ressemble pas à une réponse (`answersOnboardingQuestion` rend `false` sur une
question posée au bot), il part donc chez un agent, qui répond — **et le fil d'accueil est
abandonné sans un mot**. La machine à états n'a aucun rappel : son état EST le dernier tour
`assistant` du fil, or ce tour vient d'être remplacé par la réponse de l'agent. Le dossier
ne se termine jamais, et personne ne sait pourquoi.

⚠️ Ce n'est pas un défaut de mémoire mais de STRUCTURE : répondre au nouveau sujet EFFACE
l'état. Sans rappel accolé, l'accueil ne peut pas reprendre.

Pourquoi ACCOLÉ, et jamais posté à part

Exactement la forme retenue pour l'email d'entretien en attente : la personne a changé de
sujet, on lui répond D'ABORD. Deux messages feraient paraître le bot bavard là où il ne
fait que ne pas oublier, et un rappel posté seul se lit comme un reproche.

⚠️ Il ne BLOQUE rien et ne redemande rien : c'est une phrase en italique à la fin d'une
réponse utile. « Subtilement » est une contrainte de forme, et elle est tenue par le code —
pas par une consigne au modèle, qui la formulerait autrement à chaque fois.

ZÉRO token : texte écrit en dur, aucun modèle sur ce chemin.

Ce qui manque, dit avec les MÊMES mots que la question posée.

⚠️ Nommer le champ plutôt que dire « ton profil » : la personne sait alors exactement ce
qu'il reste à faire, et la reprise coûte une phrase au lieu d'un aller-retour. C'est la même
exigence que `FIELD_LABELS` dans `profile-completion.ts` — une réponse qui emploie d'autres
mots que la question envoie chercher un champ qui n'existe pas sous ce nom.
**Avant `const VARIANTS: readonly string[] = [`**

Trois formulations, choisies DÉTERMINISTEMENT sur l'horodatage du message.

La répétition littérale est ce qui fait « machine » — c'est le constat du Conseil du
2026-08-18 — et un rappel est par nature le texte qu'une personne verra le plus souvent :
c'est donc celui où la répétition coûte le plus cher. Jamais `Math.random()` : un test ne
peut pas verrouiller une réponse aléatoire, et un diagnostic ne peut pas la rejouer.

**Avant `export function onboardingNudge(`**

Le rappel à accoler, ou `undefined` s'il n'y a rien en attente.

⚠️ Rend `undefined` plutôt qu'une chaîne vide : l'appelant décide d'accoler ou non, et un
`''` accolé laisserait deux sauts de ligne en fin de message — une trace visible d'un
mécanisme qui ne s'est pas déclenché.

## `features/onboarding/domain/services/onboarding-plan.ts`

**Avant `import { createProgress, type OnboardingProgress } from '../entities/onboarding-progress';`**

Parcours d'accueil : la mise en plan du suivi d'intégration.

── Ce que ce module portait, et ne porte plus ──────────────────────────────
Jusqu'au 2026-08-14 il portait un CATALOGUE de cinq tâches (`ONBOARDING_TASKS`)
et construisait, pour chaque employé, cinq lignes `tasks` plus cinq lignes
`onboarding_steps`. Tout cela a été retiré : **le seul suivi du produit est
désormais la complétion du profil**.

La raison n'est pas cosmétique. Ces cinq tâches étaient un plan qu'aucun
mécanisme ne faisait avancer — ni humain, ni automate, ni tool : rien dans le
système ne pouvait marquer « Rencontrer ton manager » comme faite. Un suivi
qui ne bouge jamais est un suivi qui ment, et ce dépôt a déjà payé trois fois
le même défaut (`emailSent: false` sous `status: 'success'`,
`documents.content` perdu en silence, `status = Sent` posé avant le `try`).
Deux d'entre elles renvoyaient de surcroît vers un questionnaire et un guide
qui n'existaient pas sous la forme annoncée.

── Ce qui reste ────────────────────────────────────────────────────────────
Le suivi lui-même (`onboarding_progress`), avec UNE étape : le profil. C'est
le seul fait que le produit sache réellement observer — la modale
« Compléter mon profil » l'écrit, et son absence est vérifiable en base.

── Ce que ce module ne fait PAS ────────────────────────────────────────────
Il ne PERSISTE rien : il construit une entité. Qui l'écrit et avec quelle
tolérance à l'échec reste la décision de l'appelant.

**Avant `export const ONBOARDING_TOTAL_STEPS = 1;`**

Le parcours ne compte qu'une étape : la complétion du profil.

Constante nommée plutôt que littéral `1` dans `buildOnboardingPlan` — c'est
la valeur que `getEmployeeProfile` rend au modèle sous `totalSteps`, et le
jour où une seconde étape apparaîtra (l'entretien de personnalité est le
candidat), il ne devra y avoir qu'un seul endroit à corriger. L'ancien
`totalSteps` était déjà dérivé, jamais écrit en dur, pour cette raison.

**Avant `readonly progressId?: string;`**

Suivi DÉJÀ en base auquel se rattacher. Sans lui, un nouvel identifiant est
tiré. C'est ce qui rend un rattrapage idempotent : on ne recrée jamais un
`onboarding_progress` qui existe.

**Avant `readonly newId?: () => string;`**

 Injectable pour rendre le plan déterministe en test.

**Avant `export function buildOnboardingPlan(input: OnboardingPlanInput): OnboardingPlan {`**

Construit le suivi d'un parcours d'accueil — et le rend COMPLÉTÉ.

⚠️ Il était rendu `in_progress` avec `currentStep: 0`, ce qui était FAUX depuis le
2026-08-14. `buildOnboardingPlan` n'est appelé que par `initOnboardingStep`, c'est-à-dire
APRÈS que `createEmployeeStep` a persisté un profil COMPLET — et l'unique étape du parcours
EST la complétion du profil, comme l'en-tête de ce module le dit. On enregistrait donc
« 0 sur 1 fait » une étape après avoir constaté que la seule étape était faite.

Rien ne l'avançait ensuite : les seuls écrivains de `currentStep` sont ce chemin et
`updateOnboardingStatus`, l'outil qu'un MODÈLE appelle sur demande d'un humain.
`getEmployeeProfile` remontait fidèlement `in_progress, 0/1` au modèle, qui le remontait à
la personne. C'est le défaut `ONBOARDING_TASKS` recréé sous forme réduite — « un suivi qui
ne bouge jamais est un suivi qui ment » — dans le fichier dont l'en-tête affirme l'avoir
supprimé.

⚠️ Le jour où une seconde étape apparaîtra (l'entretien est le candidat), ce défaut inverse
réapparaîtra : il faudra alors poser `currentStep: 1` et `InProgress`, pas recopier ceci.

**Avant `export function reconcileProgress(progress: OnboardingProgress): OnboardingProgress {`**

Ramène un suivi HÉRITÉ au barème courant.

⚠️ Constaté en production le 2026-08-18 : « Statut d'onboarding : en cours (étape 1 sur 5) »
alors que `ONBOARDING_TOTAL_STEPS` vaut 1 depuis le retrait du suivi de tâches. La ligne
datait d'avant ; le workflow, rendu idempotent le 2026-08-17, la RÉUTILISE sans la corriger.
Le bot annonçait donc à quelqu'un un parcours en cinq étapes dont quatre n'existent plus.

⚠️ On rend l'OBJET D'ORIGINE quand il est déjà cohérent, et c'est ce qui permet à l'appelant
de savoir s'il doit écrire : une écriture inutile fait bouger `updatedAt` sans raison, et
une écriture est toujours une occasion de se tromper.

⚠️ LA COHÉRENCE N'EST PAS L'ÉCHELLE — corrigé le 2026-08-20, signalé en production

La première version sortait sur `if (totalSteps === ONBOARDING_TOTAL_STEPS) return progress`,
c'est-à-dire qu'elle tenait « déjà au bon barème » pour « déjà cohérent ». C'est faux : le
barème peut être juste pendant que le STATUT contredit les compteurs. Réponse réellement
rendue à une personne :

    « Intégration : en cours, étape 1 sur 1. »

Une étape sur une étape est FAITE. « En cours » est une contradiction dans la même phrase,
et c'est très exactement le défaut que le retrait du suivi de tâches disait supprimer —
« un suivi qui ne bouge jamais est un suivi qui ment » — sous une forme que la garde
précédente laissait passer parce qu'elle regardait le mauvais champ.

La réconciliation porte donc désormais sur l'INVARIANT : `currentStep >= totalSteps` ⇒
`completed`. C'est la seule formulation qui ne puisse pas se désynchroniser d'elle-même.

## `features/onboarding/domain/services/onboarding-replies.ts`

**Avant `export const PROFILE_SUBMISSION_FAILED_REPLY =`**

Ce que reçoit la personne qui vient de valider le formulaire « Compléter mon profil ».

## Le trou que ce module ferme

Le workflow d'onboarding sait déjà distinguer trois issues — `completed`, `degraded`,
`failed` — et `onboarding-outcome.ts` existe précisément pour que « réussi » cesse de
couvrir « rien n'est parti ». Mais ce verdict s'arrêtait au JOURNAL : sur `failed` comme
sur `degraded`, l'appelant écrivait une ligne `logger.error` et rendait la main. La
personne qui venait de remplir sa modale ne recevait **rien du tout**, et ne pouvait pas
distinguer un succès d'une panne.

C'est le mode d'échec que tout ce dépôt combat, arrêté un cran trop tôt : le verdict
existait, il n'atteignait personne.

## Ce que ces textes s'interdisent

- **Ne jamais dire « c'est fait » sur un échec.** Sur `failed`, il n'y a pas de dossier.
- **Ne jamais promettre une reprise automatique.** Il n'existe ni cron, ni poller, ni file
  de reprise dans ce système : « je réessaierai plus tard » serait la promesse creuse que
  `scheduleReminder` a appris à ne plus faire.
- **Nommer ce qui manque, pas un code.** « Ton email de bienvenue n'est pas parti » est
  actionnable ; « étape `welcomeEmail` dégradée » ne l'est pas.

**Avant `export const PROFILE_SUBMISSION_FAILED_REPLY =`**

Échec complet : aucun dossier n'a été créé.

On demande de recommencer parce que c'est la seule chose qui puisse marcher — la
soumission est idempotente, une seconde tentative ne crée pas de doublon.

**Avant `export function profileSubmissionDegradedReply(missing: readonly string[]): string {`**

Le dossier EXISTE, mais une étape best-effort a échoué.

⚠️ La liste des étapes manquées est construite à partir du verdict réel, jamais devinée :
annoncer un email non parti alors qu'il l'est ferait exactement le mensonge inverse de
celui qu'on corrige.

**Avant `const STEP_LABELS: Readonly<Record<BestEffortStep, string>> = {`**

Traduction des étapes dégradées en langage lisible.

Les identifiants d'étape sont du vocabulaire de code ; ils n'ont rien à faire dans un
message. Une étape inconnue est OMISE plutôt que rendue telle quelle — mieux vaut une liste
incomplète qu'une ligne incompréhensible, et l'ouverture du message dit déjà qu'il manque
quelque chose.

⚠️ CETTE TABLE ÉTAIT INDEXÉE SUR LES NOMS DE L'ENUM, JAMAIS SUR SES VALEURS

Défaut trouvé le 2026-08-19. Les clés étaient `WelcomeEmail` et `SlackInvite` — les noms des
MEMBRES de `BestEffortStep` — alors que le workflow pousse leurs VALEURS, `welcomeEmail` et
`slackInvite`. `describeMissingSteps` rendait donc `[]` sur TOUTE dégradation réelle, et
`runOnboarding` n'envoie rien quand la liste est vide : **personne n'était jamais prévenu
qu'un email de bienvenue n'était pas parti.**

C'est la faute exacte que tout ce module dit combattre, dans le module qui le dit : le
verdict existait, était calculé, était journalisé — et n'atteignait personne. Rien ne
rougissait, parce que les deux bords étaient corrects séparément.

Le correctif n'est pas de recopier les bonnes chaînes — la même divergence reviendrait au
premier renommage — mais de **dériver la table de l'enum lui-même**. `Record<BestEffortStep,
string>` rend de surcroît l'exhaustivité vérifiable à la COMPILATION : ajouter une étape
sans son libellé devient une erreur de build, pas un silence.

**Note de fichier**

⚠️ `MODAL_FAILED_REPLY` a été SUPPRIMÉ le 2026-08-19, avec les modales elles-mêmes. Il
disait « reclique sur le bouton, ça repart en général du premier coup » — une consigne
devenue fausse dans les deux moitiés : il n'y a plus de bouton, et ça ne repartait pas.

## `features/onboarding/domain/services/profile-chat.ts`

**Avant `export type ProfileStep = 'firstName' | 'lastName' | 'email' | 'position';`**

Compléter son dossier EN CONVERSATION — la dernière modale du produit disparaît.

Pourquoi, et pourquoi c'était inévitable

« Compléter mon profil » ouvrait une modale, donc dépendait d'un `trigger_id` Slack, qui
expire **3 secondes** après le clic. Mesuré le 2026-08-19 en production, sur un clic signé :
l'ACK mettait 5 229 ms à froid et 9 173 ms sur un déploiement neuf — le budget était épuisé
avant la première instruction.

Le portier d'ACK (`scripts/slack-ack-function/`) a ramené cet ACK sous la seconde, mais il
ne peut PAS sauver une modale : il répond vite parce qu'il ne connaît rien du produit, et
l'ouverture de la fenêtre a lieu ensuite, dans la fonction applicative, qui reste froide.
Vérifié dans les journaux : `Unable to open the profile modal … invalid_trigger_id`.

Aucune optimisation ne rattrape cela. Une modale suppose qu'un serveur réponde en moins de
3 s à un instant qu'on ne choisit pas ; ce déploiement ne peut pas le garantir. La modale
de l'entretien avait déjà été retirée pour cette raison exacte le 2026-08-19 — celle du
profil était la dernière.

La conception, identique à celle de l'entretien

ZÉRO appel de modèle : les questions sont des constantes, la validation est du code. Sur un
budget de ≈ 19 messages par JOUR pour tout le workspace, faire poser par un LLM des
questions dont le texte est connu d'avance coûterait un quart de la journée pour remplir
quatre champs.

⚠️ L'état n'est stocké NULLE PART. Il se reconstitue à partir du fil, que le handler charge
déjà pour la mémoire conversationnelle : chaque question posée par le bot est suivie de la
réponse de la personne, donc `collectProfileAnswers` n'a qu'à apparier les tours. Aucune
table, aucune colonne, aucune lecture de plus sur le chemin des 3 secondes.

Conséquence assumée, la même que pour l'entretien : l'historique est borné par
`CONVERSATION_TTL_MS` (60 min). Un dossier laissé en plan une heure repart de « C'est
fait ». C'est un abandon silencieux, jamais un mensonge — rien n'a été promis entre-temps.

 Les champs qu'un dossier exploitable doit porter, dans l'ordre où on les demande.
**Avant `export const PROFILE_QUESTIONS: Readonly<Record<ProfileStep, string>> = {`**

⚠️ CE SONT DES CONSTANTES, et c'est ce qui fait tenir la machine à états : l'étape en cours
se reconnaît en comparant le dernier tour du bot à ces chaînes. Les reformuler ailleurs
casserait la reconnaissance en silence — aucun type ne bougerait, aucun test de ces
constantes ne rougirait.

⚠️ mrkdwn Slack (`*gras*`), jamais markdown GitHub : ces textes sont postés en dur et ne
passent par AUCUN filtre. `sanitizeAgentOutput` n'a qu'un seul site d'appel — la réponse
d'un modèle.

**Avant `export type ProfileAnswers = Partial<Record<ProfileStep, string>>;`**

 Ce que la personne a déjà donné, quelle qu'en soit la source.

**Avant `export interface ProfileTurn {`**

 Un tour de conversation, réduit à ce dont cette machine a besoin.

**Avant `function looksLikeEmail(value: string): boolean {`**

Reconnaît une ADRESSE plutôt qu'une phrase — volontairement permissif, et sans expression
régulière.

⚠️ Deux raisons, dans cet ordre. D'abord la correction : une validation stricte rejette des
adresses valides (sous-domaines, `+`, TLD longs) et le symptôme, pour la personne, est « le
bot refuse mon adresse » sans qu'elle sache pourquoi. Ce qu'on doit attraper ici, c'est une
phrase à la place d'une adresse, pas une RFC — l'adresse est la clé de résolution du
dossier, une faute de frappe se voit au tour suivant.

Ensuite le coût : le motif naturel (`[^\s@]+@[^\s@]+\.[^\s@]{2,}`) est à performance
super-linéaire par retour arrière, et ce dépôt a déjà mesuré des ReDoS réels sur ses portes
d'entrée. Un découpage explicite est linéaire par construction, et se lit mieux.

**Avant `const REFUSAL_PATTERNS: readonly RegExp[] = [`**

⚠️ Reconnaît un REFUS, pas des mots-clés. Même garde que `captureInterviewAnswer` : sans
elle, « je n'ai pas d'adresse pro » deviendrait l'adresse professionnelle de la personne,
et ce champ est la clé de résolution de son dossier.

Ancré au DÉBUT du message : « je termine les tickets » est une réponse valable au poste.

⚠️ ESPACES LITTÉRAUX, jamais `\s+` : `captureProfileAnswer` a déjà normalisé les blancs
avant d'appeler ces motifs. Écrire `\s+` ici rouvrirait un retour arrière quadratique pour
zéro gain — et ce dépôt a mesuré de vrais ReDoS sur ses portes d'entrée le 2026-08-18.
**Avant `export function pendingProfileStep(lastAssistantText: string | undefined): ProfileStep | null {`**

Quelle question le bot vient-il de poser ?

⚠️ `includes` et non `startsWith` — défaut mesuré en production le 2026-08-19 sur la machine
jumelle : le handler accole des notes en fin de réponse (accompli requalifié, couverture
d'extraits), et le texte qui pose une question peut être précédé d'une phrase de contexte.
`includes` est le seul critère qui survive aux deux.

⚠️ L'ordre de balayage est celui des étapes INVERSÉ : la question la plus avancée l'emporte
si un texte venait à en citer deux, sinon la machine bouclerait sur sa première étape.

**Avant `export function captureProfileAnswer(step: ProfileStep, text: string | undefined): string | null`**

La réponse est-elle exploitable ? Rend la valeur retenue, ou `null` pour relancer.

⚠️ On ne devine JAMAIS. Une réponse refusée relance la question ; elle n'est pas enregistrée
« au mieux ». Ces quatre champs finissent dans un document qui porte le nom de la personne
et dans l'adresse à laquelle on lui écrit.

**Avant `if (!/\p{L}/u.test(trimmed)) return null;`**

Un nom ou un poste doit contenir au moins une lettre — Unicode, jamais `[a-z]` : ce

produit sert des gens dont le nom ne s'écrit pas en alphabet latin.
**Avant `export function collectProfileAnswers(turns: readonly ProfileTurn[]): ProfileAnswers {`**

Reconstitue ce que la personne a déjà répondu, en appariant les tours du fil.

⚠️ On lit le fil dans l'ordre CHRONOLOGIQUE et on écrase au fur et à mesure : si quelqu'un
répond deux fois à la même question (parce que la première a été refusée, ou parce qu'il se
corrige), c'est la DERNIÈRE réponse qui compte. L'inverse figerait une faute de frappe.

**Avant `export function answersFromRecord(`**

Ce que le dossier existant renseigne déjà.

⚠️ Le même vocabulaire des deux côtés — `ProfileSnapshot` et `ProfileAnswers` portent les
mêmes clés — pour qu'un champ ajouté un jour à la fiche ne puisse pas être oublié ici.

**Avant `export function nextProfileStep(answers: ProfileAnswers): ProfileStep | null {`**

 Le premier champ encore absent, ou `null` quand le dossier est complet.

**Avant `export function profileRetryReply(step: ProfileStep): string {`**

Relance quand la réponse n'est pas exploitable.

⚠️ Elle NOMME ce qui cloche. « Je n'ai pas compris » renvoie la personne à la même question
sans lui dire quoi changer — c'est la version inutile de cette phrase, et elle coûte un
aller-retour de plus sur un budget qui se compte à la journée.

**Avant `export const PROFILE_CHAT_INTRO_NO_RECORD =`**

 Ce qu'on annonce avant la première question, quand aucun dossier n'existe.

**Avant `export function profileChatIntroMissing(missing: readonly string[]): string {`**

 Ce qu'on annonce quand le dossier existe mais qu'il lui manque des champs.

**Avant `export const PROFILE_CHAT_SAVE_FAILED =`**

 Ce qu'on dit quand l'enregistrement échoue — jamais « c'est enregistré ».

**Avant `'Je n’ai pas réussi à enregistrer ton dossier. Ce n’est pas de ton fait — redis-moi ' +`**

⚠️ « j'ai fini », et pas « c'est fait » — corrigé le 2026-08-19. Les deux sont RECONNUES

(on n'a jamais intérêt à cesser de comprendre quelqu'un), mais le produit en ENSEIGNAIT

deux pour un même geste : « j'ai fini » dans le guide d'accueil et dans la reprise

d'entretien, « c'est fait » ici. Aucune n'était cassée ; un produit qui apprend deux

formules pour un même geste se lit simplement comme deux produits.

Verrouillé par `tests/unit/quality/taught-phrases.test.ts`.
## `features/onboarding/domain/services/profile-completion.ts`

**Avant `import { INTERVIEW_QUESTION_DAILY } from './interview-chat';`**

« C'est fait » — la vérification, et ce qu'on répond dans chaque cas.

## Pourquoi une VÉRIFICATION, et pas une simple confirmation

Un bouton qui se contente de dire « super, merci ! » est un bouton qui MENT dès que la
personne se trompe — et la faute la plus banale est de croire avoir terminé. Ce dépôt a
déjà payé cette famille de défaut trois fois : `emailSent: false` sous
`status: 'success'`, `documents.content` perdu en silence, un suivi de tâches qu'aucun
mécanisme ne faisait avancer. Chaque fois, le système AFFIRMAIT un état qu'il n'avait pas
constaté.

D'où la règle ici : on regarde la base, et la réponse ne dit que ce qu'on y a vu.

## Pourquoi le domaine, et pourquoi une fonction PURE

Elle est appelée depuis la route d'interactivité (clic) ET depuis le handler Slack (la
personne écrit « j'ai fini » plutôt que de cliquer — c'est le second chemin explicitement
demandé). Deux appelants, une seule règle : la dupliquer garantirait qu'un jour le bouton
et la phrase ne disent plus la même chose.

**Avant `import { INTERVIEW_QUESTION_DAILY } from './interview-chat';`**

 Ce qu'il faut avoir en base pour qu'un dossier soit exploitable.

**Avant `readonly missing: readonly string[];`**

 Champs manquants, en français, dans l'ordre où le guide les a annoncés.

**Avant `readonly reply: string;`**

 Le texte à poster, en mrkdwn Slack.

**Avant `readonly needsProfileChat: boolean;`**

Le dossier reste-t-il à compléter ?

⚠️ S'appelait `offerForm` jusqu'au 2026-08-19, quand la réponse posait un bouton ouvrant
une modale. Cette modale ne s'ouvrait jamais : un `trigger_id` expire en 3 s et le
démarrage à froid mesuré est de 5,2 s. La complétion se fait désormais EN CONVERSATION,
et `reply` porte déjà la première question — le nom devait suivre, sinon il décrirait un
produit qui n'existe plus.

**Avant `const NEXT_STEP =`**

⚠️ mrkdwn Slack (`*gras*`), jamais markdown GitHub (`**gras**`).

Ces textes sont postés en DUR par la route et le handler : ils ne passent par AUCUN filtre.
`sanitizeAgentOutput`, qui convertit le markdown, n'a qu'un seul site d'appel —
`response.text`, la réponse d'un MODÈLE. Un `**` s'afficherait littéralement, ce qui a été
constaté le 2026-08-18 sur le message de détresse, le pire endroit possible.

⚠️ La question vient d'`interview-chat.ts`, elle n'est PAS réécrite ici.

C'est la machine à états de l'entretien qui l'exige : l'étape en cours est reconnue en
comparant le dernier tour du bot à cette constante. Une reformulation locale — même
strictement synonyme — casserait la reconnaissance en silence, sans qu'aucun type ne bouge
ni qu'aucun test de cette constante ne rougisse. Le dépôt connaît bien cette classe de
défaut : deux bords corrects, aucun câblage entre les deux.
**Avant `const FIELD_LABELS: Readonly<Record<ProfileStep, string>> = {`**

Nom LISIBLE de chaque champ — les MÊMES mots que la question posée, sans quoi la personne
cherche un champ qui n'existe pas sous ce nom.

⚠️ « professionnelle » a été retiré le 2026-08-20. Une adresse personnelle est explicitement
acceptée depuis le 2026-08-19 (c'était une impasse sans sortie), et le mot survivait dans
NEUF descriptions d'outils — c'est de là que le modèle a tiré « Email professionnel : … »
devant une adresse `gmail.com`, dans une fiche relue par sa propriétaire. Le modèle
n'inventait pas : il répétait ce que le schéma lui disait.

**Avant `export function verifyProfile(`**

Le verdict.

⚠️ `null` (aucune fiche) et une fiche INCOMPLÈTE ne produisent pas le même texte, et c'est
la distinction qui compte. « Il me manque ton poste » adressé à quelqu'un qui n'a aucun
dossier serait faux et déroutant : il ne manque pas un champ, il manque tout. C'est la même
règle que `found: false` porteur d'un `reason` — un résultat vide doit se distinguer d'un
identifiant qui ne désigne personne.

**Avant `export const PROFILE_CHECK_UNAVAILABLE =`**

Réponse quand la vérification n'a PAS PU avoir lieu.

⚠️ Elle ne dit jamais « ton dossier est incomplet ». Une base indisponible est notre
défaut, pas celui de la personne, et le lui imputer l'enverrait corriger un formulaire qui
n'a rien à corriger. Elle ne dit pas non plus « c'est bon » : on n'a rien constaté, et
c'est tout ce qu'on sait. Même discipline que `null` face à `[]` dans la réconciliation
FAIT/NARRATION — sans preuve positive, on se tait sur le fond.

mrkdwn Slack, jamais markdown GitHub : ce texte est posté en dur, sans passer par aucun
filtre.

## `features/onboarding/domain/services/top-role-claim.ts`

**Avant `const WORD_SEPARATOR = /[^\p{L}\p{N}]+/u;`**

QUELQU'UN VIENT DE SE DÉCLARER AU SOMMET — le dire au sommet.

Ce que ce module N'EST PAS, et il faut le lire avant le reste

**Ce prédicat n'accorde RIEN.** Il ne participe à aucune décision d'autorisation, et c'est
ce qui rend acceptable qu'il repose sur une chaîne de caractères saisie par la personne
elle-même. Le seul fait qui accorde `full` est `slack_directory.role`, écrit délibérément
hors du produit (`npm run role:set`) — précisément parce qu'un champ déclaratif ne doit
jamais fonder un droit.

Ce module produit un SIGNAL, adressé à un humain : « cette personne s'est présentée comme
General Manager — es-tu au courant, approuves-tu ? » C'est la même distinction que le dépôt
fait déjà entre `title` (« Product Manager » sur quelqu'un qui n'est pas le manager) et
`role`. Confondre les deux serait l'élévation de privilège la plus simple qui soit : taper
son titre.

L'ASYMÉTRIE, qui fixe la largeur du filet

Un faux POSITIF coûte un DM au manager, qu'il lit en trois secondes et ignore.
Un faux NÉGATIF laisse une déclaration au sommet passer inaperçue.

Le filet penche donc vers l'inclusion — mais pas au point d'attraper « Product Manager » ni
« Engineering Manager », qui désignent des métiers réels de ce workspace et déclencheraient
à chaque arrivée. La liste est FERMÉE et porte sur des locutions ENTIÈRES, jamais sur le
mot « manager » seul : c'est le même critère d'ancrage que `matchesKeyword`, où
`String.includes('test')` capturait « contestation ».

Locutions qui désignent le sommet de l'organisation, normalisées (sans accent, minuscules).

⚠️ « manager » seul en est ABSENT, et c'est délibéré : trois personnes sur six portent un
titre qui contient ce mot. « directeur » seul aussi — « directeur technique » n'est pas le
General Manager.

 Tout ce qui n'est ni lettre ni chiffre sépare deux mots — Unicode, jamais `[a-z0-9]`.
**Avant `export function declaresTopRole(position: string | null | undefined): boolean {`**

Le poste déclaré désigne-t-il le sommet de l'organisation ?

⚠️ Comparaison sur des locutions ENTIÈRES, jamais par `includes` nu : sans ancrage, « ceo »
capturerait n'importe quel mot le contenant, et le dépôt a déjà payé ce défaut trois fois
(`\b` en ASCII, `includes('test')`, `endsWith(org)`).

⚠️ Le découpage en MOTS remplace une expression régulière, et ce n'est pas qu'une question
de lint. Une `RegExp` construite depuis une variable — même une constante de ce module —
est un motif que personne ne relit tel qu'il s'exécute ; et l'ancrage `\b` aurait été faux
ici, `\b` raisonnant en ASCII et ne reconnaissant pas `é` comme une lettre (quatrième
occurrence de ce piège dans ce dépôt). Encadrer d'espaces une suite de mots normalisés
donne la même garantie, en se lisant du premier coup.

**Avant `export function topRoleClaimNotice(input: {`**

Ce qu'on écrit au manager en place.

⚠️ Il DIT ce que la déclaration ne fait pas. Sans cette phrase, le message se lirait comme
une alerte de sécurité — « quelqu'un s'est donné les pleins pouvoirs » — alors que rien n'a
changé : le rôle est ailleurs, et il n'a pas bougé. Annoncer un danger qui n'existe pas est
la même famille de mensonge que d'en taire un.

⚠️ Il nomme le geste EXACT à faire si la réponse est oui. Un message qui demande d'approuver
sans dire comment laisse son destinataire chercher — et c'est ainsi qu'une approbation
n'arrive jamais.

ZÉRO token : texte écrit en dur, aucun modèle sur ce chemin.

## `features/onboarding/domain/services/welcome-email.ts`

**Avant `export interface WelcomeEmailInput {`**

L'EMAIL DE BIENVENUE — ce qu'on sait de la personne, et RIEN d'autre.

Les deux défauts corrigés le 2026-08-14

**1. Il PROMETTAIT ce qu'aucun mécanisme ne tient.** Le texte disait, mot pour mot :

> « Vous recevrez prochainement les accès à nos outils ainsi que votre planning de première
> semaine. »

Il n'existe **aucun provisioning de comptes** et **aucun planning** dans ce système — ni
cron, ni workflow, ni tool. Vérifié : les seules occurrences de ces mots dans `src/` sont
cette phrase elle-même. C'est le tout premier message que l'entreprise adresse à un
arrivant, et il ouvre sur une promesse qui ne sera pas tenue. Même famille que
`emailSent: false` sous `status: 'success'`, que les cinq tâches qu'aucun mécanisme ne
faisait avancer, et que le `status: Scheduled` d'un rappel que rien ne reprend.

**2. Il était GÉNÉRIQUE alors que la donnée existait.** `position` et `startDate` sont
saisis dans la modale, portés par `employeeCreatedSchema`… puis **jetés** au passage de
`onboardingInitializedSchema`, deux étapes avant l'email. La personnalisation n'était donc
pas absente par choix : elle était perdue en route.

La règle de ce gabarit

Chaque phrase repose sur une donnée VÉRIFIÉE, ou n'est pas écrite. Un champ absent fait
disparaître sa phrase — il ne déclenche jamais un « N/A », ni une formule de remplissage.
C'est la même discipline que `buildWelcomeLetter`, dont on a retiré « Département : N/A »
pour cette raison exacte : un intertitre suivi du vide se lit comme un oubli.

⚠️ Le seul énoncé tourné vers l'AVENIR est celui du bouton de profil, et il est vrai : le
DM part réellement, et le formulaire existe. On ne parle donc jamais de ce qui « va être
envoyé » sans que quelque chose l'envoie.

TypeScript pur — ce module traverse la couche `domain`.

**Avant `readonly position?: string | null;`**

 `null` par défaut depuis le 2026-08-13 : le parcours d'arrivée ne le collecte plus.

**Avant `readonly startDate?: string | null;`**

 ISO. Rendue en toutes lettres, ou omise si illisible — jamais affichée brute.

**Avant `readonly channels?: readonly string[];`**

 Canaux Slack où la personne va réellement être invitée. Omis si la liste est vide.

**Avant `function isFutureDay(startDate: string | null | undefined): boolean {`**

La date de début est-elle STRICTEMENT postérieure à aujourd'hui ?

Comparaison au JOUR, jamais à l'instant : une date de début est un jour, et « aujourd'hui à
23 h » ne rend pas l'arrivée future. Une date illisible rend `false` — on se tait plutôt que
d'affirmer, comme partout ailleurs dans ce module.

**Avant `const known: string[] = [];`**

⚠️ DES PHRASES, plus des puces étiquetées. Le bloc disait « Ce que nous avons

enregistré : » suivi de « Poste : … », « Équipe : … », « Premier jour : … » — du langage

de guichet, et surtout la forme même que le bloc STYLE interdit aux agents (« sans liste

numérotée », « pas de plan »). Le gabarit faisait donc ce qu'on refuse au modèle, dans le

PREMIER message que l'entreprise adresse à quelqu'un.

Chaque fragment reste adossé à une donnée vérifiée, et un champ absent fait disparaître

sa mention — c'est la règle du module et elle ne bouge pas.
**Avant `const day = formatFrenchDay(input.startDate);`**

⚠️ Le DÉPARTEMENT a été retiré de cette phrase le 2026-08-20, à la demande du

propriétaire : « les départements ne doivent plus apparaître ». Il n'est plus collecté

depuis le 2026-08-13 ; ne subsistait que sa ressortie sur les lignes anciennes.
**Avant `const welcome =`**

La phrase d'accueil absorbe ce qu'on sait du poste et de l'équipe plutôt que de le

reléguer dans une liste : c'est la même information, dite comme un humain la dirait.
**Avant `if (day && isFutureDay(input.startDate)) {`**

⚠️ UNE PHRASE D'ATTENTE NE VAUT QUE POUR L'AVENIR — 2026-08-19.

Sur le chemin conversationnel, devenu le chemin PRINCIPAL depuis le retrait des modales,

`submitProfile` passe `startDateFromJoin(undefined, …)` : `joinedAt` y est toujours

`undefined`, donc la date vaut systématiquement AUJOURD'HUI. Un salarié présent depuis six

mois qui complétait son dossier lisait « On t'attend le mercredi 19 août 2026 ».

⚠️ La règle de ce module — « un champ absent fait disparaître sa phrase » — n'était pas

violée, elle était CONTOURNÉE : le champ n'est jamais absent, il est fabriqué deux couches

plus haut. C'est la forme la plus difficile à voir de cette famille de défaut, parce que

chaque module pris isolément se comporte correctement.

On ne rend PAS la date facultative : `employees.start_date` est `NOT NULL` et le schéma du

workflow exige `z.string().datetime()` — la corriger là demanderait un DDL en production

pour un gain de texte. La règle juste est locale : on n'attend que ce qui n'est pas encore

arrivé.
**Avant `if (known.length > 0 || day || channels.length > 0) {`**

La proposition de correction n'a de sens que si l'on vient d'affirmer quelque chose.

**Avant `parts.push(`**

⚠️ La SEULE projection dans le futur, et elle est vraie : ce DM part réellement, et le

formulaire derrière le bouton existe et écrit en base.
**Avant ``<p>Tu vas recevoir un message direct de notre bot sur Slack : il t'expliquera comment compléter`**

⚠️ « avec un bouton pour compléter ton profil » a été RETIRÉ le 2026-08-19. Le bouton

réellement posté s'appelle « C'est fait » : `buildProfileButtonBlock` n'a plus aucun

appelant, et son `action_id` n'est traité par aucune branche de `handleBlockActions`.

Annoncer un libellé qu'on ne verra pas est pire qu'une simple erreur : l'arrivant

ATTEND le bouton annoncé et ne clique pas sur celui qui est là.
**Avant `subject: `Bienvenue chez ${COMPANY}, ${firstName}`,`**

Sans point d'exclamation : le bloc STYLE l'interdit au modèle depuis qu'on a mesuré que

« les exclamations arrivaient précisément dans les phrases où l'agent ne faisait rien ».

Un gabarit n'a pas de raison d'y échapper.
**Avant `function esc(value: string): string {`**

Le corps est du HTML, et `position` comme `department` viennent d'une saisie humaine dans
une modale Slack. Sans échappement, un `<` casserait le rendu — et le dépôt a déjà appris
qu'un canal de sortie non filtré finit par porter autre chose que ce qu'on croyait.

## `features/onboarding/domain/value-objects/onboarding-outcome.ts`

**Avant `export enum OnboardingOutcome {`**

Issue d'un parcours d'intégration — et pourquoi il en faut TROIS, pas deux.

── L'incident ──────────────────────────────────────────────────────────────
`employeeOnboardingWorkflow` ne connaissait que « réussi » et « échoué ».
L'envoi de l'email de bienvenue étant best-effort (il attrape son erreur), un
email jamais parti se rendait par un `emailSent: false` noyé dans un run
`status: 'success'`. Trois lecteurs successifs y ont conclu à tort qu'un
email avait été envoyé : les rapports humains, `scripts/production-*.ts` et
les agents. C'est le piège « l'échec d'email est SILENCIEUX » de CLAUDE.md,
et il a produit de faux « PASS ».

── Pourquoi on ne LÈVE pas ─────────────────────────────────────────────────
Transformer l'échec d'une étape best-effort en exception avorterait le run et
ferait perdre l'employé créé, ses tâches et son invitation Slack — pour une
indisponibilité SMTP de trente secondes. Ce serait pire que le défaut qu'on
corrige. La bonne réponse n'est pas d'échouer plus fort, c'est de RENDRE le
verdict lisible : `Degraded` est un aboutissement, pas un échec.

── Pourquoi un module de domaine ───────────────────────────────────────────
Le vocabulaire doit être identique dans le workflow, dans la route qui le
journalise et dans les scripts qui l'assertent. Une chaîne recopiée à trois
endroits redeviendrait trois vocabulaires. TypeScript pur : aucun import.

**Avant `Completed = 'completed',`**

 Toutes les étapes ATTENDUES ont abouti.

**Avant `Degraded = 'degraded',`**

L'employé existe, son suivi est en place — mais au moins une étape
best-effort a échoué. Le parcours est utilisable et RÉPARABLE, à condition
que quelqu'un l'apprenne : c'est tout l'objet de cette valeur.

**Avant `Failed = 'failed',`**

Le parcours n'a pas abouti (email en doublon, base indisponible…).

Cette valeur ne figure JAMAIS dans le résultat du workflow : un run en
échec n'a pas de résultat, Mastra rend `{ status: 'failed', error }`. Elle
existe pour que les appelants qui traduisent `run.status` en verdict
disposent du même vocabulaire que le workflow lui-même.

**Avant `export enum BestEffortStep {`**

Les étapes qui peuvent échouer SANS faire échouer le parcours.

L'inventaire est exhaustif et c'est la moitié du correctif : ne traiter que
l'email aurait laissé l'invitation Slack dans le même angle mort, avec
exactement le même symptôme.

⚠️ `OnboardingTasks` a été RETIRÉ le 2026-08-14 avec les tâches d'intégration
elles-mêmes. Ne pas le réintroduire pour couvrir l'écriture du suivi : cette
écriture n'est plus best-effort, un parcours sans `onboarding_progress` fait
dégrader `updateOnboardingStatus` ET `getEmployeeProfile`.

**Avant `WelcomeEmail = 'welcomeEmail',`**

 Envoi de l'email de bienvenue (`sendWelcomeEmail`).

**Avant `SlackInvite = 'slackInvite',`**

 Invitation de l'arrivant dans le canal Slack du département (`inviteToSlack`).

**Avant `export interface StepFailure {`**

QUOI a échoué et POURQUOI.

Le couple est indissociable : un booléen `emailSent: false` dit qu'il faut
réparer, jamais quoi réparer — le diagnostic repartait alors des logs, quand
ils existaient encore.

**Avant `export function toFailureReason(error: unknown): string {`**

Normalise une cause d'échec en une phrase courte et non vide.

On garde `error.message` et non l'objet : la valeur traverse un schéma Zod,
est sérialisée dans la réponse HTTP du workflow, et une `Error` n'y survit
pas (`JSON.stringify(new Error('x'))` rend `{}`). Une cause vide vaut une
cause perdue, d'où le repli explicite.

**Avant `export function outcomeOf(failures: readonly StepFailure[]): OnboardingOutcome {`**

 `Degraded` dès la PREMIÈRE étape best-effort en échec.

**Avant `export function describeDegradation(failures: readonly StepFailure[]): string {`**

Résumé d'une ligne, destiné aux logs et aux rapports de test.

Nomme TOUTES les étapes en échec, jamais seulement la première : ne rendre
que l'email ferait réparer l'email et croire le reste sain.

## `features/onboarding/infrastructure/repositories/drizzle-onboarding-interview.repository.ts`

**Avant `export class DrizzleOnboardingInterviewRepository implements OnboardingInterviewRepository {`**

Persistance de l'entretien post-profil sur LibSQL/Turso.

⚠️ La table `onboarding_interview` n'est PAS créée par les migrations `drizzle/` : celles-ci
sont désynchronisées de `schema.ts`, et `drizzle-kit push` se bloque indéfiniment contre une
base `libsql://` distante. Le DDL vit dans `scripts/ddl-onboarding-interview.sql` et doit
être appliqué AVANT le déploiement.

**Avant `async save(interview: OnboardingInterview): Promise<void> {`**

⚠️ Le `set` de l'upsert énumère les champs UN À UN, et `createdAt` en est ABSENT.

Ce n'est pas de la verbosité : `set: interview` réécrirait `created_at` à chaque
correction, donc la date du premier entretien serait perdue au premier changement d'avis.
Même invariant que `first_seen_at` de `slack_directory`, même mode d'échec évité — une
perte muette, du genre de celle qui a coûté `documents.content` sur 6 lignes sur 6.

**Avant `channels: Array.isArray(row.channels) ? (row.channels as string[]).filter(isChannelId) : [],`**

La colonne est du JSON libre côté pilote : on ne fait CONFIANCE ni à sa forme ni à son

contenu. Une ligne écrite par une version antérieure, ou à la main, ne doit pas faire

lever un `.map()` sur `undefined` au milieu d'une génération de document.
**Avant `function isChannelId(value: unknown): value is string {`**

 Un identifiant de canal Slack, et rien d'autre — il finit dans `conversations.invite`.

## `features/onboarding/infrastructure/repositories/drizzle-onboarding.repository.ts`

**Avant `set: {`**

⚠️ `startedAt` et `updatedAt` étaient ABSENTS de ce `set` — bug mesuré en

production le 2026-08-12. Les valeurs sont bien passées à `.values()`, mais

`values()` est IGNORÉ dès qu'il y a conflit : seul le `set` s'applique. Sur une

ligne existante, `updated_at` restait donc gelé à la date d'insertion

(2026-08-11T18:02:35 en production, alors que le tool venait de tourner), et le

`startedAt` calculé lors de la transition `not_started → in_progress` était jeté

en silence. Le symptôme observé était « le bot annonce une mise à jour et rien

ne change en base ».
**Avant `async update(progress: OnboardingProgress): Promise<number> {`**

Rend le nombre de lignes RÉELLEMENT affectées.

`Promise<void>` empêchait structurellement tout appelant de savoir si l'écriture
avait eu lieu : `updateOnboardingStatus` retournait `updated: true` en constante, et
le modèle annonçait à l'utilisateur une mise à jour qu'il ne pouvait pas vérifier.
Quatrième occurrence dans ce dépôt de la signature « le champ dit mieux que le fait ».

**Avant `return (result as unknown as { rowsAffected?: number }).rowsAffected ?? 0;`**

libsql expose `rowsAffected` ; le `?? 0` couvre un pilote qui ne le fournirait pas,

auquel cas on préfère annoncer « rien de sûr » plutôt qu'un succès supposé.
**Avant `set: {`**

Même défaut que `save()` ci-dessus, même correctif : `updatedAt` était absent du

`set`, donc gelé à l'insertion sur toute étape déjà existante.
## `features/onboarding/infrastructure/repositories/in-memory-onboarding-interview.repository.ts`

**Avant `export class InMemoryOnboardingInterviewRepository implements OnboardingInterviewRepository {`**

Doublure de `DrizzleOnboardingInterviewRepository`.

⚠️ Elle doit reproduire la propriété que le SQL obtient en ne nommant pas `created_at` dans
son `set` : une correction ne réécrit PAS la date du premier entretien. Une doublure plus
permissive validerait en test un comportement que la production n'a pas — et l'écart porterait
précisément sur une perte silencieuse de donnée.

## `features/onboarding/infrastructure/repositories/in-memory-onboarding.repository.ts`

**Avant `if (!this.progressStore.has(p.id)) return 0;`**

Rend 0 quand la ligne n'existe pas — c'est ce que fait un UPDATE SQL, et c'est la

divergence qui a laissé passer le bug : l'ancien double écrivait inconditionnellement

l'objet entier, donc il conservait des horodatages que Drizzle, lui, jetait.

---
# Deux défauts trouvés par le REJEU en production (2026-08-21)

Un rejeu du parcours d'arrivée complet a dérivé. C'est ce qui l'a rendu utile : les deux défauts
ci-dessous sont invisibles à la lecture du code, et aucun test unitaire ne les couvrait.

## Une adresse occupée par une fiche supprimée enferme la personne dans une BOUCLE

`idx_employees_email` est UNIQUE **sans prédicat sur `deleted_at`** : une fiche archivée occupe
encore son adresse. Mais les trois résolveurs (`findByName`, `findByEmail`, `findAll`) filtrent
`deleted_at` — donc pour le produit, la personne n'a **pas** de dossier.

Le parcours est alors le suivant, et il ne se termine jamais :

1. « Je ne trouve pas encore de dossier à ton nom » — vrai, du point de vue des résolveurs ;
2. les quatre questions, auxquelles la personne répond ;
3. `UNIQUE constraint failed: employees.email` ;
4. « ça vient de mon côté […] réécris-moi *compléter mon profil* et recommence » ;
5. retour à l'étape 1.

⚠️ **LE DIAGNOSTIC EXACT EXISTAIT DÉJÀ ET N'ATTEIGNAIT PERSONNE.**
`DrizzleEmployeeRepository.explainEmailConflict` fabrique, mot pour mot :

> `L'adresse … est encore occupée par une fiche supprimée le … Réactiver cette fiche ou libérer
> l'adresse avant de recréer un employé.`

`runOnboarding` le remplaçait par le message générique. C'est la même famille qu'`emailSent:
false` sous `status: 'success'` et que `documents.content` perdu en silence : **l'information
juste existe, et se perd au dernier mètre.**

`PROFILE_EMAIL_TAKEN_REPLY` ne conseille pas de recommencer, dit que le dossier est archivé, et
nomme qui peut le débloquer. Il ne cite **ni la date ni l'identifiant** : ce sont des détails
d'implémentation pour quelqu'un qui n'a aucun moyen d'agir dessus.

⚠️ `isEmailAlreadyTaken` parcourt la **chaîne de causes**. En production, `code: 'CONFLICT'`
était enfoui sous `details.cause.cause` : une lecture à plat retomberait en silence sur le
message générique — le défaut d'origine sous une autre forme, et invisible puisque le repli
existe. Même méthode que `isUniqueConstraintViolation` et que `userFacingFailure`.

⚠️ **Awa TRAORE est dans cet état depuis le 2026-08-12.** Le défaut n'est pas théorique.

## L'invitation au formulaire était postée avant la vérification

Constaté à l'œil dans la campagne : « On va compléter ton dossier — c'est lui qui me permet de
retrouver ton profil » suivi, dans la seconde, de « Ton dossier est déjà complet — je n'ai rien
à te redemander. » Le premier message annonce un travail que le second annule.

La lecture est déplacée **avant** le premier mot posté. Cela coûte un aller-retour de base de
données ; l'alternative est d'ouvrir la conversation par une phrase fausse.

## ⚠️ Ce que le rejeu a révélé et qui n'est PAS corrigé

Après un échec d'enregistrement, la machine à états repart de zéro et capture le message suivant
comme un **prénom**. Relevé en base pendant le rejeu : `first_name` valant
`« en asynchrone, avec peu de réunions et beaucoup d'écrit »`.

C'est la famille de défaut déjà corrigée pour les court-circuits le 2026-08-19 (« Salut »
devenait un prénom), reparue par un autre chemin — l'échec de sauvegarde. Signalé plutôt que tu.

---

## Décisions extraites du code le 2026-08-21

> Le code ne porte plus ce texte. L'ancre est la **déclaration**, jamais un numéro
> de ligne : l'audit du 2026-08-21 a mesuré 5 424 ancres `L.N` dont 153 exactes.
> Un numéro de ligne se périme au premier retrait de commentaire.

### `src/features/onboarding/application/services/run-onboarding.ts`

**Avant `function isEmailAlreadyTaken(error: unknown): boolean {`**

⚠️ LA CHAÎNE DE CAUSES EST PARCOURUE, jamais le seul premier niveau.

Mastra emballe l'erreur du step : en production, `code: 'CONFLICT'` était enfoui sous
`details.cause.cause`. Une lecture à plat retomberait en silence sur le message générique —
c'est-à-dire le défaut d'origine sous une autre forme, et invisible puisque le repli existe.

Même méthode que `isUniqueConstraintViolation` dans le dépôt Drizzle et que `userFacingFailure`
pour le quota : dans ce projet, une erreur intéressante est toujours à plusieurs niveaux.

**Avant `await deps.notify(emailTaken ? PROFILE_EMAIL_TAKEN_REPLY : PROFILE_SUBMISSION_FAILED_REPLY);`**

Deux échecs, deux gestes différents : l'un se répare en réessayant, l'autre demande
qu'un humain libère l'adresse. Les confondre enferme la personne dans une boucle.

### `src/features/onboarding/domain/services/interview-chat.ts`

**Avant `export function interviewRetryReply(step: InterviewStep): string {`**

⚠️ **LA RELANCE DOIT REPOSER LA QUESTION, ET CE N'EST PAS UNE QUESTION DE POLITESSE.**

Défaut trouvé par le rejeu d'arrivée en production, le 2026-08-21. `INTERVIEW_TOO_SHORT_REPLY`
seul disait « il me faut un peu plus que ça » — sans jamais redire ce qu'il demandait.

Or `pendingInterviewStep` reconstitue l'état de l'entretien en cherchant la QUESTION dans le
dernier tour de l'assistant. Une relance qui ne la contient pas efface donc l'état : la
réponse suivante, celle où la personne prend la peine de développer, ne part plus vers
`captureInterviewAnswer` mais vers le modèle — et n'est enregistrée NULLE PART.

**Une réponse trop courte mettait silencieusement fin à l'entretien.** Le symptôme est le
plus discret possible : le bot répond quelque chose de sensé, et la table reste vide.

`profileRetryReply` avait déjà cette forme depuis toujours — les deux machines à états
doivent la partager, sans quoi c'est celle qu'on a oubliée qui perd les données.

### `src/features/onboarding/domain/services/onboarding-replies.ts`

**Avant `export const PROFILE_EMAIL_TAKEN_REPLY =`**

⚠️ UNE ADRESSE OCCUPÉE PAR UNE FICHE SUPPRIMÉE N'EST PAS UNE PANNE — trouvé en production
le 2026-08-21, et la distinction est tout l'objet de ce message.

`idx_employees_email` est UNIQUE sans prédicat sur `deleted_at`, donc une fiche archivée
occupe encore son adresse ; mais les trois résolveurs filtrent `deleted_at`, donc le produit
ne la voit pas. Il pose les quatre questions, puis échoue à l'enregistrement — et le message
générique conseillait alors de RECOMMENCER, c'est-à-dire de refaire exactement ce qui vient
d'échouer. Une boucle sans sortie, dont la personne ne peut pas soupçonner la cause.

`DrizzleEmployeeRepository.explainEmailConflict` produisait déjà le diagnostic exact. Il
n'atteignait personne. C'est la même famille que `emailSent: false` sous `status: 'success'`
: l'information juste existe, et se perd au dernier mètre.

⚠️ Il ne cite NI la date d'archivage NI l'identifiant : ce sont des détails d'implémentation
pour quelqu'un qui n'a aucun moyen d'agir dessus. Ce qu'il lui faut est le geste suivant, et
la personne à qui le demander.

---

## Décisions du 2026-08-21 (nuit) — le rejeu des quatre cas de complétion de profil

### `src/features/onboarding/domain/services/profile-completion.ts`

**Avant `export function verifyProfile(`**

⚠️ **« J'AI FINI » REDEMANDAIT CE QU'IL SAVAIT DÉJÀ.** Le verdict ne lisait QUE la table
`employees`, alors que le parcours conversationnel part de `knownProfileAnswers` — annuaire
Slack **plus** dossier — et fusionne l'historique du fil.

Symptôme : quelqu'un écrit son prénom, dit « c'est fait » deux messages plus tard, et
s'entend redemander son prénom. En production le cas est pire encore — l'annuaire porte
prénom, nom **et** email pour toute personne dont le profil Slack est renseigné : la seule
chose qui manque est le poste, et on reposait les quatre questions.

C'est la forme exacte du défaut recensé le 2026-08-21 sur `pendingInterviewStep` :
**deux machines à états qui suivent la même règle sans la partager finissent par diverger,
et c'est celle qu'on a oubliée qui fait le mauvais travail.**

⚠️ **LA SÉPARATION QUI COMPTE, et elle n'est pas cosmétique** : le VERDICT (`complete`) se
prononce sur le DOSSIER, jamais sur ce qu'on croit savoir. Ce qui se prononce sur les
réponses connues, c'est la QUESTION POSÉE. Les confondre ferait dire « ton dossier est
complet » d'un dossier vide — `emailSent: false` sous `status: 'success'`, quatrième
occurrence.

Le second paramètre est donc OPTIONNEL et vaut `{}` : `slack-interactions.route.ts`, qui
vérifie un dossier déjà écrit, garde exactement son comportement.

**Avant `function introFor(`**

Trois entrées en tête, et chacune doit être VRAIE :

- aucun dossier, rien de connu → « Je ne trouve pas encore de dossier à ton nom … quatre
  questions » ;
- aucun dossier, une partie connue → `profileChatIntroPartial`. On ne peut dire ni « j'ai
  bien un dossier » (faux) ni « quatre questions » (faux) ;
- un dossier partiel → `profileChatIntroMissing`.

### `src/features/onboarding/domain/services/profile-chat.ts`

**Avant `export function profileChatIntroPartial(`**

Le troisième cas d'entrée en matière. `PROFILE_CHAT_INTRO_NO_RECORD` annonce « quatre
questions » — faux dès qu'on en sait une ; `profileChatIntroMissing` annonce « j'ai bien un
dossier à ton nom » — faux quand il n'y en a pas. Aucun des deux ne pouvait servir ici, et
en réemployer un aurait fait dire au produit une phrase fausse au premier message.

**Avant `function listOf(`**

Extrait de `profileChatIntroMissing` parce que les deux entrées en matière énumèrent la même
liste. Recopier l'énumération, c'était garantir que « ton nom et ton poste » d'un côté
devienne « ton nom, ton poste » de l'autre.

### `src/features/onboarding/domain/services/top-role-claim.ts`

**Avant `export function topRoleClaimReply(`**

⚠️ **PRÉVENIR LE MANAGER SANS RIEN DIRE À LA PERSONNE EST UN SILENCE, pas une neutralité.**
La déclaration était enregistrée sans réserve apparente pendant qu'une conversation
s'ouvrait derrière son dos. Même asymétrie que `emailSent: false` sous `status: 'success'` :
rien de faux n'est dit, et l'essentiel n'est pas dit.

⚠️ **CE N'EST PAS UN REFUS, et le texte doit le dire dans sa première phrase.** Refuser le
poste enfermerait la personne dans une boucle sans sortie — le défaut que
`PROFILE_EMAIL_TAKEN_REPLY` existe pour fermer. Le poste est un champ DÉCLARATIF de son
propre dossier ; ce qui est unique, c'est `slack_directory.role`, et il n'est pas écrit par
le produit.

⚠️ **`informed` VIENT DE CE QUI S'EST PASSÉ, jamais de l'intention.** Dire « je viens de lui
écrire » après un `channel_not_found` renverrait la personne en croyant la situation traitée.
Le handler compte les DM réellement acceptés.

⚠️ **AUCUNE FORME GENRÉE** pour la personne qui porte le rôle — « lui écrire », jamais « le
prévenir ». Un test le verrouille : le nom ne dit pas le genre, et se tromper sur une
personne réelle est le genre de détail qui décrédibilise tout le reste.

⚠️ **Rien ne se dit quand le siège est VIDE.** La colonne `role` naît vide : « aucun
manager » est l'état de DÉPART. Énoncer la règle sans pouvoir nommer qui la porte ni
prévenir personne n'apprend rien à personne.
