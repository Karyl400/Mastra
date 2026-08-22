# Plateforme (`src/api/`, `src/mastra/`, `src/infrastructure/`)

> Décisions de conception, extraites des commentaires du code le 2026-08-20.
>
> Chaque entrée est ancrée sur la **déclaration** qu'elle précédait, jamais sur un numéro
> de ligne : l'audit du 2026-08-21 a mesuré 5 424 ancres `L.N` dont **153 exactes (2,8 %)**.
> Un numéro de ligne se périme au premier retrait de commentaire — c'est-à-dire aussitôt.
>
> Le code ne porte plus ce texte : **c'est ici qu'il vit désormais.**

---

## `api/slack-events.route.ts`

**Avant `import { registerApiRoute } from '@mastra/core/server';`**

Route HTTP de l'Events API Slack — implémentation CANONIQUE.

⚠️ Un fichier posé dans `src/api/` n'est PAS monté automatiquement par Mastra.
Cette route n'existe que parce que `slackEventsRoute` est passé à
`server.apiRoutes` dans `src/mastra/index.ts`.

⚠️ CHEMIN : les chemins personnalisés ne peuvent PAS commencer par l'`apiPrefix`
du serveur (par défaut `/api`) — `@mastra/server` lève au démarrage :
  `Custom API route "/api/slack-events" must not start with "/api" — that path is
   reserved for built-in Mastra routes.`
(Vérifié empiriquement contre @mastra/deployer `createHonoServer`.)
On monte donc sur `/slack/events`, et c'est CETTE URL qui doit être renseignée dans
le champ « Request URL » de l'app Slack :
  https://<domaine>/slack/events
(L'alternative — `apiPrefix: '/mastra/api'` pour libérer `/api` — déplacerait toutes
les routes internes Mastra et le playground : rejetée, trop risquée.)

**Avant `export const SLACK_EVENTS_PATH = '/slack/events';`**

 Chemin public de l'endpoint Slack. À reporter tel quel dans l'app Slack.

**Avant `const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');`**

 ------------------------------------------------------------------------- *
Prolongation de vie de la fonction serverless (`waitUntil`)


Clé du contexte de requête posée par le lanceur Vercel sur `globalThis`.
C'est le SEUL et unique contrat de `waitUntil` : `@vercel/functions@3.8.0`
(`wait-until.js` + `get-context.js`) se réduit littéralement à
`globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil?.(promise)`.

On le lit en direct plutôt que d'ajouter la dépendance `@vercel/functions` :
 - le bundler de `@mastra/deployer-vercel` fait sa propre analyse de dépendances puis
   recopie `node_modules` dans `.vercel/output/functions/index.func/` — un mécanisme qui
   a déjà dû être rattrapé à la main (`scripts/fix-vercel-output.js`) ;
 - `@vercel/functions` tire `@vercel/oidc` et des peers AWS SDK pour six lignes de code.
Zéro dépendance = zéro risque de bundling, pour exactement le même comportement.

⚠️ `hono/vercel` ne peut PAS servir de solution de repli :
`node_modules/hono/dist/adapter/vercel/handler.js` est `handle = (app) => (req) =>
app.fetch(req)` — l'`ExecutionContext` n'est jamais transmis, donc `c.executionCtx`
lève « This context has no ExecutionContext ». C'est bien ce `handle()` qu'utilise
l'entrée générée par le déployeur (`VercelDeployer.getEntry()`).
**Avant `export type BackgroundMechanism = 'vercel-wait-until' | 'detached';`**

 Mécanisme effectivement retenu pour faire vivre le traitement de fond.

**Avant `export function getVercelWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {`**

 `waitUntil` du lanceur Vercel, ou `undefined` hors Vercel (dev local, tests).

**Avant `export function scheduleBackgroundWork(work: Promise<unknown>): BackgroundMechanism {`**

Planifie un travail qui doit survivre à l'envoi de la réponse HTTP.

Sur Vercel, `waitUntil` empêche le gel de la fonction tant que la promesse n'est pas
réglée (dans la limite du `maxDuration`). Hors Vercel — `mastra dev`, tests, tout
serveur Node de longue durée — le simple détachement suffit puisque le processus vit.

La promesse reçue DOIT déjà être « catchée » : `waitUntil` propagerait sinon un rejet
non géré.

**Avant `export const SLACK_ACK_BUDGET_MS = 3_000;`**

 ------------------------------------------------------------------------- *
Budget d'ACK Slack — instrumentation


Slack rejoue tout événement qu'il n'a pas vu accusé dans ce délai. Ce n'est pas une
recommandation : c'est le mécanisme qui a produit la DOUBLE RÉPONSE du 2026-08-11 12:38 UTC.
Un ACK à 6,7 s sur démarrage à froid a déclenché un rejeu (`retryNum: 1`) routé vers une
instance NEUVE, au cache vide, qui a répondu une seconde fois avec un texte différent.
**Avant `export const SLACK_ACK_AT_RISK_MS = 1_500;`**

Seuil d'alerte, à la moitié du budget.

Il existe parce que le dépassement, lui, n'est PAS observable depuis la fonction : quand
l'ACK part à 3,4 s, on voit un `200` parfaitement normal dans les logs et un doublon
inexplicable dans Slack. La seule trace exploitable de l'incident du 2026-08-11 a été
reconstruite après coup, par déduction, à partir de deux messages contradictoires postés
dans un fil. Mesurer le chemin pré-ACK est ce qui manquait pour le voir venir.

**Avant `export type AckBudgetState = 'ok' | 'at_risk' | 'exceeded';`**

 État NOMMÉ du budget d'ACK — aucune dégradation de ce chemin ne doit être muette.

**Avant `function reportAckBudget(state: AckBudgetState, details: Record<string, unknown>): void {`**

Journalise le coût du chemin pré-ACK, et seulement quand il devient intéressant.

`exceeded` part en `error` et non en `warn` : à ce stade Slack a déjà rejoué, donc un second
traitement est déjà en vol quelque part. C'est la ligne à chercher quand une double réponse
réapparaît — avant d'aller soupçonner la déduplication, qui n'est que la victime.

**Avant `export interface SlackRouteContext {`**

Sous-ensemble du `Context` Hono réellement utilisé par la route.
Permet de tester le handler sans démarrer un serveur.

**Avant `let cachedHandler: SlackEventsHandler | undefined;`**

Handler mémorisé : le cache de déduplication et le `bot_user_id` résolu via
`auth.test()` doivent survivre entre deux requêtes.

**Avant `let handlerOptionsForTests: SlackEventsHandlerOptions | undefined;`**

COUTURE D'INJECTION RÉSERVÉE AUX TESTS — `undefined` en production, toujours.

La route construit le handler par la voie de production, donc SANS options : le handler
construit alors PARESSEUSEMENT un `DrizzleRateLimitRepository`, un
`DrizzleSlackEventDedupRepository`, un `DrizzleConversationRepository` et un
`DrizzleDirectoryRepository`. C'est le bon comportement en production, et un piège en test
unitaire : `vitest.config.ts` ne charge pas `.env`, donc `DATABASE_URL` est absent et
`connection.ts` retombe sur `file:./data/kisso.db` — la VRAIE base de développement.

Le mode d'échec est déjà arrivé : les compteurs de débit et les clés de déduplication y sont
alors PERSISTÉS, partagés entre tous les tests du fichier ET d'un run à l'autre. Passé le
5ᵉ événement d'un même auteur (rafale par défaut de `rate-limit-policy.ts`), `accept()` rend
`rate_limited` et plus aucun travail de fond n'est programmé. La suite ne passait que parce
que ces tables étaient ABSENTES de la base locale — un test vert par absence de table n'est
pas un test vert, et `npm run db:init` suffisait à le casser.

Cette couture ne change RIEN à la voie de production : sans appel explicite, les options
restent `undefined` et le constructeur reçoit exactement ce qu'il recevait avant.

**Avant `let cachedEventsEmailProvider: ReturnType<typeof createEmailProvider> | undefined;`**

Invitation des arrivants aux canaux d'accueil, câblée ICI et non dans `src/mastra/index.ts`.

⚠️ Ce n'est pas une entorse à la règle « le câblage vit dans `index.ts` » mais sa
conséquence : `index.ts` importe cette route (`apiRoutes: [slackEventsRoute]`), donc
l'importer en retour créerait un cycle ESM — panne d'initialisation classique en bundle,
et le motif exact pour lequel `chatProvider` est déjà injecté par options plutôt que repris
d'`index.ts`.

ZÉRO E/S à la construction : `parseWelcomeChannelNames` lit une variable d'environnement et
l'adaptateur ne fait qu'envelopper un client. Ce fichier est évalué à chaque démarrage à
froid, donc SUR le chemin des 3 secondes d'ACK — un ACK à 6,7 s a déjà provoqué un rejeu,
donc la double réponse du 2026-08-11. Le premier appel réseau n'a lieu qu'au premier
`team_join`.

**Avant `function getEventsEmailProvider() {`**

 Fournisseur d'email, construit au PREMIER envoi réel — jamais au chargement du module.

**Avant `interviewRepository: new DrizzleOnboardingInterviewRepository(),`**

⚠️ Injecté ICI et nulle part ailleurs : le handler n'a délibérément AUCUN repli


paresseux vers Drizzle pour ce dépôt. Un repli ferait que tout handler construit en

test toucherait la base — le piège qui a rendu onze tests d'`accept()` `rate_limited`

le jour où `rate_limit_counters` a existé. Absent, l'entretien conversationnel

collecte et répond correctement, seule la trace manque.
**Avant `profileRepository: new DrizzleEmployeeRepository(),`**

⚠️ Le MÊME dépôt que celui de la route d'interactivité, et c'est voulu : le bouton


« C'est fait » et la phrase « j'ai fini » doivent rendre le même verdict. Deux

sources de vérité pour une seule vérification finiraient par ne plus dire la même

chose — la divergence corrigée deux fois en un jour sur ce même parcours.
**Avant `pendingEmailRepository: new DrizzlePendingInterviewEmailRepository(),`**

L'email d'entretien PRÉPARÉ, en attente d'un « oui » ou d'un « non ». Même contrat


d'injection que les deux ci-dessus, et pour la même raison : aucun repli paresseux,

donc aucun test de handler ne touche la base par accident.
**Avant `sendEmail: (to, subject, body) => getEventsEmailProvider().sendEmail(to, subject, body),`**

⚠️ PARESSEUX à l'appel, jamais à la construction : `createEmailProvider` lit la


configuration SMTP et construit un transport, et ce fichier est évalué à CHAQUE

démarrage à froid, donc sur le chemin des 3 secondes d'ACK. La fabrique est la même

que celle de `src/mastra/index.ts` et de la route d'interactivité — une copie ferait

partir les emails d'entretien par un fournisseur et ceux de notification par un

autre, sans que rien ne le signale.
**Avant `...handlerOptionsForTests,`**

Les options de test l'emportent : un test qui neutralise les canaux doit pouvoir le


faire, et l'ordre inverse rendrait l'injection silencieusement inopérante.
**Avant `export function setSlackEventsHandlerOptionsForTests(`**

Installe les dépendances du handler construit par la route (tests uniquement).

Invalide le singleton au passage : sans cela, un handler déjà mémorisé — donc déjà porteur
de ses dépôts Drizzle — survivrait à l'injection et la rendrait silencieusement inopérante.

**Avant `export function resetSlackEventsHandler(): void {`**

 Réinitialise le singleton ET l'injection de test — remise à l'état de production.

**Avant `const startedAt = Date.now();`**

Horloge du budget d'ACK. Prise AVANT toute lecture : le corps de la requête, la


vérification HMAC et l'admission comptent tous dans les 3 s que Slack accorde.
**Avant `const rawBody = await c.req.text();`**

1. Corps BRUT obligatoire pour le HMAC. Parser puis re-sérialiser casserait la


   signature (espaces / ordre des clés).
**Avant `logger.warn('Rejected Slack request', { reason: verification.reason });`**

`url_verification` est signé lui aussi : la vérification s'applique à TOUS les


types d'événements, sans exception.
**Avant `if (body.type === 'url_verification') {`**

2. Handshake Slack (envoyé AVANT que l'app soit vérifiée, mais bien signé).

**Avant `const retryNum = c.req.header('x-slack-retry-num');`**

3. Filtrage + déduplication SYNCHRONES, avant l'ACK, pour qu'un renvoi Slack ne


   déclenche pas un second traitement de fond.
**Avant `const admissionStartedAt = Date.now();`**

`accept()` est asynchrone depuis la déduplication partagée : la prise de clé fait un


aller-retour vers Turso, et le contrôle de débit un second (les deux règles y partent

désormais ENSEMBLE — cf. `SlackRateLimiter.check`). Il reste AVANT l'ACK, et c'est

délibéré : les deux décisions qu'il prend gouvernent l'existence même du travail de fond.

Les déplacer après l'ACK reviendrait à programmer d'abord et à décider ensuite — sur une

plateforme où « programmer » veut dire tenir la fonction éveillée et où le premier geste

du traitement est de poster un marqueur de progression dans Slack. Un rejeu écarté APRÈS

avoir posté « Je regarde ça, un instant… » n'est plus un rejeu écarté : c'est la double

réponse qu'on cherche à empêcher, avec une étape de plus.
**Avant `const work = handler.handleEvent(body).catch((error) => {`**

4. Slack renvoie tout événement non accusé en moins de 3 s, et un appel agent


   prend 2 à 17 s (cf. TEST_REPORT.md) → traitement en tâche de fond.

   ⚠️ SERVERLESS (Vercel) : un simple `void promise` ne suffit PAS. La fonction est

   gelée dès la réponse envoyée et l'appel LLM en vol est tué — symptôme observé en

   production : ACK 200, aucune réponse dans Slack, et AUCUN log après l'ACK.

   `waitUntil()` déclare la promesse au lanceur Vercel, qui maintient l'instance

   éveillée jusqu'à son règlement (borné par `maxDuration`).
**Avant `logger.info('Slack event scheduled', {`**

`retryNum` n'était journalisé QUE sur le chemin dupliqué. Sur le chemin


accepté, l'en-tête était lu puis jeté — impossible de distinguer un rejeu

Slack d'un événement jumeau (`message` + `app_mention`) quand deux

réponses partent pour un seul message. C'est la ligne qui tranche.
**Avant `if (mechanism === 'detached' && process.env.VERCEL) {`**

Garde-fou d'observabilité : sur Vercel, `detached` signifie que le travail SERA


tué au gel de la fonction. C'est la ligne à chercher dans les logs si le bot

recommence à ne plus répondre.
**Avant `const ackMs = Date.now() - startedAt;`**

5. ACK immédiat — toujours 200, sinon Slack rejoue puis désactive l'endpoint.


   Le coût réel du chemin qui précède est mesuré et NOMMÉ : c'est le seul endroit d'où

   l'on puisse constater qu'on s'approche des 3 s, et l'instrument qui manquait le

   2026-08-11.
**Avant `export const SLACK_EVENTS_WORK_PATH = '/internal/slack/events';`**

Le chemin INTERNE, où le portier d'ACK rejoue la requête.

⚠️ Ce n'est pas une porte dérobée : la route montée ici est EXACTEMENT la même, signature
HMAC comprise, vérifiée sur le corps réexpédié à l'identique. La frontière de sécurité est
donc inchangée, et elle tiendrait même si le portier disparaissait du routage.

Deux chemins plutôt qu'un seul parce que le routage Vercel se décide sur le CHEMIN : sans
distinction, la règle qui envoie `/slack/events` au portier renverrait aussi la requête
réexpédiée au portier — une boucle, et un bot définitivement muet.

⚠️ `/internal` et non `/api/…` : le préfixe `/api` est réservé par `@mastra/server` et une
route personnalisée qui commence par lui fait échouer le DÉMARRAGE du serveur.

## `api/slack-interactions.route.ts`

**Avant `import { registerApiRoute } from '@mastra/core/server';`**

Route HTTP de l'interactivité Slack — clic de bouton et soumission de modale.

Distincte de `/slack/events` pour une raison de format, pas d'organisation :
les payloads d'interactivité arrivent en `application/x-www-form-urlencoded`
(champ `payload=<json>`), là où la route Events ne sait lire que du JSON.

⚠️ Comme pour la route Events, un fichier posé dans `src/api/` n'est PAS monté
automatiquement : cette route n'existe que parce que `slackInteractionsRoute`
est passé à `server.apiRoutes` dans `src/mastra/index.ts`.

⚠️ Le préfixe `/api` est réservé — une route personnalisée qui commence par lui
fait échouer le DÉMARRAGE du serveur, ce n'est pas un 404. D'où `/slack/…`.

⚠️ PLUS AUCUNE MODALE DEPUIS LE 2026-08-19, et c'est une constatation, pas une
préférence. Un `trigger_id` Slack expire 3 secondes après le clic ; mesuré ce jour-là
sur un clic SIGNÉ en production, l'ACK de cette route mettait 5 229 ms à froid et
9 173 ms sur un déploiement neuf. Le portier d'ACK (`scripts/slack-ack-function/`) a
ramené l'accusé sous la seconde, mais il ne peut pas sauver une modale : il répond vite
précisément parce qu'il ne connaît rien du produit, et la fenêtre s'ouvre ensuite, depuis
la fonction restée froide. Journaux à l'appui : `invalid_trigger_id`.

Tous les boutons se contentent donc d'ACQUITTER, et le travail part en tâche de fond. Les
deux parcours qui ouvraient une fenêtre sont devenus CONVERSATIONNELS (`profile-chat.ts`,
`interview-chat.ts`).

⚠️ Le traitement de `view_submission` est CONSERVÉ mais devenu INATTEIGNABLE : plus aucun
bouton n'ouvre de vue, donc Slack n'en enverra plus. Il est laissé en place le temps d'un
lot dédié — le retirer emporte `profile-modal.ts`, `interview-modal.ts` et
`applyInterview`, c'est-à-dire l'invitation aux canaux, et cela ne se fait pas dans le même
commit qu'un parcours neuf. Voir `TODO.md`.

**Avant `const PROFILE_DONE_ACTION_ID = 'profile_done';`**

⚠️ IDENTIFIANT HÉRITÉ — plus AUCUN émetteur depuis le 2026-08-19.

Les boutons ont été retirés du parcours : le propriétaire a signalé deux fois qu'ils ne
fonctionnaient pas sous un vrai clic humain, alors que les sondes signées mesuraient des ACK
de 393 à 1 473 ms. On a supprimé la DÉPENDANCE plutôt que de rejouer la mesure.

Cette branche est CONSERVÉE, et ce n'est pas du code mort : les messages déjà postés dans
Slack portent encore leur bouton, indéfiniment. Quelqu'un qui remonte son fil et clique doit
obtenir la vérification de son dossier — pas un `block_actions sans action connue`, c'est-à-
dire un clic sans effet et sans trace. La constante vit ici parce que c'est désormais son
unique consommateur.

**Avant `export const SLACK_INTERACTIONS_PATH = '/slack/interactions';`**

 Chemin public. À reporter dans *Interactivity & Shortcuts* de l'app Slack.

**Avant `interface SlackInteractionUser {`**

 -------------------------------------------------------------------------- *
Types de payload

**Avant `interface SlackInteractionPayload {`**

Union structurelle plutôt que discriminée : on branche sur `payload.type` en
TypeScript. Le payload est du JSON non fiable, et `z.discriminatedUnion` reste
proscrit dans ce dépôt (zod épinglé 3.25.76).

**Avant `channel?: { id?: string };`**

⚠️ `state` a été RETIRÉ de ce type le 2026-08-19, avec les modales. Le garder aurait
laissé croire que ce module lit encore une saisie de formulaire — il n'y en a plus, et
`handleViewSubmission` ne fait plus que prévenir la personne que rien n'a été gardé.


 Présents sur `block_actions` (pas sur `view_submission`) : où la carte a été cliquée.
**Avant `function decodeLegacyProfileButton(`**

Relit le `value` d'un bouton « C'est fait » DÉJÀ POSTÉ dans un DM.

⚠️ RAPATRIÉ ICI le 2026-08-19, depuis `profile-modal.ts` supprimé le même jour. Ce n'est
plus une pièce de formulaire : c'est le décodeur d'un legs. Slack ne rappelle pas les
messages, donc ces boutons restent cliquables indéfiniment dans les DM où ils ont été
postés, et cette route est le seul endroit qui les voie encore. Aucun code n'en émet plus.

Le payload est signé, donc digne de confiance après vérification HMAC — mais un message
ancien peut porter un format antérieur, d'où le repli sur l'identifiant seul.

**Avant `return { slackUserId: value || fallbackUserId };`**

Format historique : le `value` ne portait que l'identifiant Slack brut.

**Avant `export interface SlackInteractionsContext {`**

 Sous-ensemble du `Context` Hono réellement utilisé.

**Avant `function ack(): Response {`**

 -------------------------------------------------------------------------- *
Réponses


Accusé de réception : `200` avec un corps **VIDE**.

Sur `view_submission`, Slack n'accepte que deux formes : un corps vide (ferme
la modale) ou un corps portant `response_action`. Un `{"ok":true}` — le
réflexe hérité de la route Events — n'est ni l'un ni l'autre et affiche
« We had some trouble connecting » à l'utilisateur.
**Avant `let cachedAdapter: SlackAdapter | undefined;`**

 -------------------------------------------------------------------------- *
Adaptateur Slack mémorisé

**Avant `export function resetSlackInteractionsAdapter(): void {`**

 Réinitialise le singleton (tests).

**Avant `async function handleBlockActions(payload: SlackInteractionPayload): Promise<Response> {`**

 -------------------------------------------------------------------------- *
Traitement


Clic sur « Compléter mon profil ».

`views.open` est appelé AVANT toute autre opération : le `trigger_id` expire
3 secondes après l'interaction, et le pré-remplissage voyage déjà dans le
`value` du bouton — donc zéro appel réseau supplémentaire.
**Avant `const doneAction = actions.find((a) => a.action_id === PROFILE_DONE_ACTION_ID);`**

── « C'EST FAIT » — le nouveau point d'entrée du parcours, 2026-08-19 ────


⚠️ TRAITÉ EN PREMIER, et surtout AVANT la garde `trigger_id` : il n'ouvre aucune modale,

donc il n'en a pas besoin. C'est toute sa raison d'être. Un `trigger_id` expire 3 s après

le clic ; le démarrage à froid de cette fonction a été mesuré à 4,9 s le 2026-08-18, et

jusqu'à 16 s après une longue inactivité — c'est-à-dire le cas d'un ARRIVANT, qui est

par définition le premier à écrire de la journée. Faire dépendre le premier geste de

l'accueil d'un `trigger_id` revenait à le faire échouer systématiquement.

ACK immédiat, ZÉRO E/S ici : la vérification en base et la réponse partent en tâche de

fond. Au pire la réponse arrive quelques secondes plus tard, ce qui est le comportement

normal d'une conversation — jamais une erreur affichée par Slack.
**Avant `if (actions.some((a) => a.action_id === CANCEL_INTERVIEW_ACTION_ID)) {`**

── Recrutement : les deux boutons de la carte de confirmation ─────────────


Ils n'ouvrent aucune modale, donc rien ne doit les faire dépendre d'un `trigger_id`.
**Avant `if (!claimCard(payload)) {`**

⚠️ La prise se fait ICI, avant l'ACK, et pas dans la tâche de fond : c'est une décision


synchrone sans E/S, et la mettre en tâche de fond rouvrirait la fenêtre qu'elle ferme.

Annuler NEUTRALISE la carte. Sans cela « Envoyer » restait cliquable APRÈS une

annulation — l'annulation n'écrivait qu'une phrase et ne retirait rien.
**Avant `scheduleInteractionWork(`**

Même régime que l'envoi ci-dessous, et pour la même raison : ce sont des appels réseau


à Slack. Awaités, ils portaient l'ACK à 5,3 s (mesuré) — au-delà des 3 secondes

accordées, alors qu'une annulation n'a strictement rien à faire attendre.
**Avant `if (!claimCard(payload)) {`**

⚠️ LA GARANTIE D'UN SEUL ENVOI, et elle est ici — synchrone, avant l'ACK. Un email vers


un candidat est la seule action irréversible et SORTANTE de ce système ; le tool a sa

garde (`runGuard`) et le workflow d'onboarding la sienne (`onboardingRunId`), ce clic

n'en avait aucune.
**Avant `scheduleInteractionWork(`**

⚠️ TÂCHE DE FOND, et surtout PAS `await` — défaut mesuré en production le 2026-08-15 :


un clic signé répondait 200 en **22,5 secondes**. L'email partait bien, mais Slack

n'accorde que **3 secondes** à une interaction : passé ce délai il affiche une erreur.

Pour un email SORTANT vers un candidat, la conséquence est sérieuse : la personne voit

un échec, reclique, et le candidat reçoit DEUX invitations. Le bouton « marchait » tout

en paraissant cassé — la pire des combinaisons, et exactement le genre d'écart entre le

FAIT et ce qu'en perçoit l'utilisateur que ce dépôt traque partout ailleurs.

`handleInterviewSend` rend déjà compte DANS LE FIL (`replyInThread`), succès comme

échec : rien n'est perdu à répondre tout de suite. C'est le régime déjà retenu pour

`view_submission`, énoncé en tête de ce fichier ; l'envoi d'entretien était resté sur le

chemin synchrone alors qu'il fait un SMTP complet PUIS un appel Slack.
**Avant `logger.debug('block_actions sans action connue', {`**

⚠️ PLUS AUCUNE MODALE — 2026-08-19, et c'est une constatation, pas une préférence.


Les deux boutons qui en ouvraient une (« Compléter mon profil », « Parlons de toi »)

dépendaient d'un `trigger_id` valable 3 secondes. Mesuré ce jour-là sur un clic SIGNÉ en

production : l'ACK mettait 5 229 ms à froid, 9 173 ms sur un déploiement neuf. Le portier

d'ACK (`scripts/slack-ack-function/`) a ramené l'accusé sous la seconde, mais il ne peut

pas sauver une modale : il répond vite parce qu'il ne connaît rien du produit, et

l'ouverture a lieu ensuite, dans la fonction restée froide. Journaux à l'appui :

`Unable to open the profile modal … invalid_trigger_id`.

Les deux parcours sont désormais CONVERSATIONNELS (`profile-chat.ts`, `interview-chat.ts`)

: zéro token, zéro `trigger_id`, et rien à ouvrir dans les trois secondes.

⚠️ `trigger_id` n'est plus lu nulle part ici. Le laisser en garde d'entrée ferait échouer

des boutons qui n'en ont aucun besoin — la faute déjà corrigée pour « Envoyer » et

« Annuler ».
**Avant `let cachedEmailProvider: EmailProvider | undefined;`**

 -------------------------------------------------------------------------- *
Recrutement — l'envoi réel de l'invitation d'entretien

**Avant `function getEmailProvider(): EmailProvider {`**

⚠️ Construit PARESSEUSEMENT et partagé avec `src/mastra/index.ts` via la fabrique commune :
une copie du choix SMTP/Brevo ferait partir les emails d'entretien par un fournisseur et
ceux de notification par un autre, sans que rien ne le signale.

**Avant `export function resetRecruitmentDependencies(): void {`**

 Réinitialise le singleton (tests).

**Avant `function scheduleInteractionWork(label: string, work: Promise<unknown>): void {`**

Programme un travail de fond ET signale s'il ne survivra pas au gel de la fonction.

⚠️ `scheduleBackgroundWork` rend `'vercel-wait-until' | 'detached'`. La route Events
exploite ce verdict depuis l'origine (« Slack background work is detached on Vercel ») ;
cette route-ci l'IGNORAIT à ses quatre sites d'appel. Or c'est ici que vivent l'envoi de
l'email d'entretien, le workflow d'onboarding complet et l'enregistrement de l'entretien :
si `waitUntil` venait à disparaître, ces trois-là seraient tués en vol **sans une seule
ligne de journal**, après avoir répondu 200 à l'utilisateur.

`label` nomme le travail perdu — sans lui, la ligne d'alerte ne dirait pas lequel.

**Avant `async function replyInThread(payload: SlackInteractionPayload, text: string): Promise<void> {`**

Répond dans le fil de la carte — jamais à la racine, la carte y serait orpheline.

⚠️ Cette phrase était FAUSSE jusqu'au 2026-08-18 : la fonction appelait `sendMessage`, qui
n'avait aucun paramètre de fil, et le `thread_ts` du payload — pourtant déclaré dans le
type — n'était lu nulle part. « C'est envoyé à … » atterrissait donc à la racine du canal.

`thread_ts ?? ts` : si la carte est elle-même dans un fil on y reste ; sinon on OUVRE le
fil sous la carte. Dans les deux cas la confirmation est attachée à ce qu'elle confirme.

**Avant `const isDirectMessage = channel.startsWith('D');`**

⚠️ JAMAIS dans un DM, et c'est une règle établie de ce dépôt : threader un DM enfouit


le message hors de la conversation principale, ce qui a déjà fait paraître ce bot muet

pendant des heures. `resolveThreadTarget`, côté handler d'événements, applique

exactement le même critère — un canal `D…` EST la conversation, il n'y a rien à

threader. En canal, en revanche, la confirmation doit rester attachée à la carte

qu'elle confirme.
**Avant `logger.error('Réponse de confirmation non postée', { error: String(error) });`**

Ne jamais propager : Slack rejouerait l'interaction, donc l'email partirait DEUX FOIS.


Un accusé perdu est bénin ; un second email à un candidat ne l'est pas.
**Avant `const settledCards = new Set<string>();`**

Cartes déjà tranchées — envoyées, annulées ou refusées.

⚠️ GARDE EN MÉMOIRE, par instance, et il faut dire ce qu'elle couvre et ce qu'elle ne
couvre pas. Elle couvre le cas RÉEL : la même personne reclique sur la même carte quelques
secondes plus tard, sur l'instance encore chaude. Elle ne couvre pas deux clics
simultanés routés vers deux instances différentes.

On ne paie PAS un aller-retour Turso pour ce reliquat, et c'est un arbitrage assumé : la
seconde barrière — la carte réécrite sans bouton — retire l'affordance elle-même, donc le
scénario résiduel exige deux clics dans la fenêtre de quelques centaines de millisecondes
qui précède la réécriture. Le magasin partagé existe (`slack_event_dedup`) si ce reliquat
devenait un incident réel ; aujourd'hui il n'en est pas un.

**Avant `function cardKey(payload: SlackInteractionPayload): string | null {`**

 Une carte est identifiée par le message qui la porte.

**Avant `function claimCard(payload: SlackInteractionPayload): boolean {`**

Prend la carte, ou refuse. Une carte prise ne peut plus rien déclencher.

Sans clé identifiable (payload sans `message`), on LAISSE PASSER : refuser casserait le
chemin nominal sur un détail de forme, et c'est la neutralisation visuelle qui porte alors
seule la garantie.

**Avant `function releaseCard(payload: SlackInteractionPayload): void {`**

Rend une carte prise — elle redevient cliquable.

Deux cas, et un seul principe : on ne consomme la carte que si le clic a EU un effet. Un
échec SMTP n'a rien envoyé, donc réessayer est la bonne conduite ; et un clic par un
témoin non autorisé ne doit pas détruire l'invitation du demandeur légitime, sans quoi le
contrôle d'accès deviendrait un déni de service.

**Avant `export function resetSettledCards(): void {`**

 Réservé aux tests : la garde est un état de module, il doit pouvoir repartir à zéro.

**Avant `async function settleCard(`**

Réécrit la carte sans ses boutons, avec le verdict à la place.

⚠️ Ne lève jamais et n'est jamais bloquant : une carte non réécrite est une gêne, alors
qu'une exception ici empêcherait le message de confirmation de partir. La garantie de
non-répétition est portée par `claimCard`, pas par cet appel réseau.

**Avant `async function handleInterviewSend(`**

Clic sur « Envoyer » — le SEUL endroit du système où un email part vers une adresse
extérieure non contrainte par l'annuaire.

⚠️ **Rien n'est rejoué sur confiance.** Le bouton ne transporte que des CHAMPS ; le sujet et
le corps sont re-rendus ici par le même gabarit, et la date est re-validée. Transporter le
corps dans le `value` aurait fait de ce bouton un moyen d'envoyer un texte arbitraire à une
adresse arbitraire — c'est-à-dire exactement la primitive d'exfiltration que toute la
feature est construite pour ne pas offrir.

**Avant `const clicker = payload.user?.id ?? '';`**

⚠️ Le cliqueur DOIT être celui qui a préparé l'invitation. La carte est visible de tous


ceux qui voient le fil : sans ce contrôle, un témoin écrirait à l'extérieur au nom de

l'entreprise. Même famille de défaut que la modale de profil en canal.
**Avant `releaseCard(payload);`**

⚠️ La carte n'est PAS neutralisée ici, et c'est voulu : le demandeur légitime doit


encore pouvoir envoyer. Un témoin qui clique ne doit pas pouvoir détruire l'invitation

de quelqu'un d'autre — ce serait transformer un contrôle d'accès en déni de service.

La prise faite plus haut est donc RENDUE.
**Avant `const parsed = parseInterviewSchedule(confirm.startsAt, new Date());`**

Re-validation : entre la préparation et le clic, la date a pu devenir passée.

**Avant `await settleCard(payload, expired);`**

Neutralisée : cette carte ne pourra plus jamais rien envoyer, sa date est périmée.

**Avant `logger.error('Email d’entretien NON envoyé', { error: String(error) });`**

⚠️ On ne prétend JAMAIS avoir envoyé. Troisième occurrence de cette discipline dans ce


dépôt, après `emailSent: false` sous `status: 'success'` et `status = Sent` avant le try.
**Avant `releaseCard(payload);`**

⚠️ On REND la prise : rien n'est parti, donc réessayer est légitime — et c'est même la


seule chose à faire. Neutraliser la carte ici obligerait à tout redemander au modèle,

soit un aller-retour LLM complet pour une panne SMTP de trente secondes.
**Avant `logger.info('Invitation d’entretien envoyée', {`**

⚠️ Aucune écriture en base, et c'est un choix : `RecipientType` n'a pas de valeur honnête


pour un candidat, et en ajouter une contaminerait le schéma de `sendNotification`. Surtout,

stocker l'adresse et l'invitation d'un NON-SALARIÉ créerait des données personnelles sans

chemin d'effacement — le trou que `TODO.md` recense déjà pour `notifications` et

`documents`. La trace vit dans le fil Slack, que les intéressés lisent, et ici en journal.
**Avant `await settleCard(payload, sent, confirmFacts(confirm, parsed.schedule.humanReadable));`**

La carte porte désormais le verdict, à l'endroit exact où l'on a cliqué : c'est ce qui


évite le second clic bien plus sûrement qu'un message posté à côté.
**Avant `let cachedEmployeeRepo: DrizzleEmployeeRepository | undefined;`**

Écrit à la personne qui vient de valider la modale.

⚠️ Le canal est son DM, jamais le canal d'origine : la soumission d'un profil est privée
par nature, et `slackUserId` EST une clé de conversation directe valide pour
`chat.postMessage`.

Ne lève jamais : ce message accompagne un verdict, il ne doit pas pouvoir en produire un
second. Un échec ici est journalisé et rien de plus.


Dépôt employé, construit PARESSEUSEMENT — même raison que `interviewRepo` plus bas : ce
module est évalué au chargement, donc sur le chemin de l'ACK. Ouvrir une connexion Turso à
l'import y ajouterait le handshake complet.
**Avant `async function answerProfileDone(prefill: NewcomerIdentity): Promise<void> {`**

Répond à « C'est fait » : on REGARDE la base, et on ne dit que ce qu'on y a vu.

⚠️ La résolution se fait par EMAIL, la seule clé que Slack nous donne et que `employees`
porte aussi — il n'existe aucune colonne `slack_user_id` dans cette table. Une adresse
absente du profil Slack rend donc `null`, ce qui est traité comme « aucun dossier » : c'est
exact, on n'a effectivement rien pu constater, et la réponse propose le formulaire.

⚠️ La note d'échec ne prétend JAMAIS que la vérification a réussi. Une base indisponible
n'est pas un dossier incomplet, et confondre les deux dirait à un arrivant que son dossier
est en défaut alors que c'est le nôtre.

**Avant `await rememberAsked(prefill.slackUserId, verdict.reply);`**

⚠️ UN SEUL CHEMIN DEPUIS LE 2026-08-19, et c'est la disparition de la dernière modale du


produit. Le cas incomplet posait ici un bouton « Compléter mon profil » ouvrant une

fenêtre ; elle ne s'ouvrait jamais. Un `trigger_id` expire 3 secondes après le clic, et le

démarrage à froid de la fonction applicative a été mesuré à 5,2 s ce jour-là, sur un clic

signé en production. Le portier d'ACK a ramené l'accusé de réception sous la seconde, mais

il ne peut pas sauver une modale : il répond vite précisément parce qu'il ne connaît rien

du produit, et l'ouverture a lieu ensuite, dans la fonction restée froide. Journaux à

l'appui : `Unable to open the profile modal … invalid_trigger_id`.

`verdict.reply` porte donc, dans TOUS les cas, la question suivante — celle de l'entretien

quand le dossier est complet, celle du premier champ manquant sinon. Les deux machines à

états lisent le même endroit : le dernier tour `assistant` du fil.
**Avant `async function rememberAsked(slackUserId: string | undefined, text: string): Promise<void> {`**

 Poste un texte en DM et l'inscrit dans la mémoire du fil — voir ci-dessus.

**Avant `const OBSOLETE_FORM_REPLY =`**


IL N'Y A PLUS AUCUN FORMULAIRE — mais ce chemin ne se tait pas pour autant


Les deux modales ont été SUPPRIMÉES du dépôt le 2026-08-19, pas seulement décâblées : elles
ne s'ouvraient pas. Un `trigger_id` expire 3 secondes après le clic, et le démarrage à froid
de cette fonction a été mesuré à 4,9 s le 2026-08-18, jusqu'à 16 s après une longue
inactivité — c'est-à-dire dans la situation exacte d'un arrivant, par définition le premier
à écrire de la journée. Journaux à l'appui : `invalid_trigger_id`.

⚠️ ON NE SUPPRIME PAS CE BRANCHEMENT POUR AUTANT, et c'est la seule chose qui compte ici.
Sur une fonction CHAUDE (684 ms mesurées), un bouton déjà posté dans un DM d'hier peut
encore ouvrir sa modale — Slack ne rappelle pas les messages. Sans ce chemin, la personne
remplirait un formulaire, cliquerait « Envoyer », verrait la fenêtre se fermer exactement
comme sur un succès, et rien ne serait enregistré. C'est le mode d'échec précis que ce dépôt
traque depuis `emailSent: false` sous `status: 'success'` — et il aurait ici la forme la
plus cruelle, puisque la personne aurait tapé ses réponses.

On ACCEPTE donc la fermeture, et on DIT en DM que rien n'a été gardé, en donnant la marche à
suivre. Un formulaire disparu n'est pas une panne ; le taire en serait une.

**Avant `return ack();`**

⚠️ Un ACK NU, jamais `response_action: 'errors'`. Slack réafficherait la modale avec un


message par champ, donc laisserait croire qu'un champ est à corriger — alors que c'est le

formulaire entier qui n'existe plus. La fenêtre doit se fermer, et l'explication arriver

en DM, là où la personne pourra répondre.
**Avant `const rawBody = await c.req.text();`**

Corps BRUT d'abord : le HMAC porte dessus, et le lire autrement


(`c.req.parseBody()`) consommerait le flux.
**Avant `if (params.get('ssl_check') === '1') {`**

À l'enregistrement de la Request URL, Slack envoie un POST `ssl_check=1`


SANS champ `payload`. Répondre autrement qu'un 200 fait REFUSER l'URL —

et donc la fonctionnalité entière n'existe jamais.
**Avant `const encoded = params.get('payload');`**

`URLSearchParams.get` décode déjà le pourcentage : un `decodeURIComponent`


supplémentaire lèverait « URI malformed » sur le moindre accent.
**Avant `export const SLACK_INTERACTIONS_WORK_PATH = '/internal/slack/interactions';`**

Le chemin INTERNE, où le portier d'ACK rejoue la requête. Voir `SLACK_EVENTS_WORK_PATH`
pour le raisonnement complet — en deux mots : la même route, la même vérification de
signature, un chemin distinct pour que le routage Vercel ne boucle pas sur lui-même.

**Avant `requiresAuth: false,`**

OBLIGATOIRE : `server.auth` est actif (src/mastra/index.ts). Sans cette


ligne, chaque requête Slack prend un 401 et Slack finit par désactiver

l'endpoint — sans autre symptôme qu'une modale qui ne s'ouvre jamais.
## `infrastructure/audit/audit-log.ts`

**Avant `export interface AuditEntry {`**

ÉCRITURE DE LA PISTE D'AUDIT — la table existait, personne n'y écrivait.

`audit_logs` porte 20 colonnes et 7 index depuis l'origine, pour ZÉRO ligne. Et le problème
n'était pas seulement qu'on avait oublié d'appeler un `insert` : `actorId` est `NOT NULL`, et
**aucune identité ne franchissait la frontière** — le handler appelait `agent.generate(texte)`,
le texte seul. Brancher l'écriture avant de faire circuler l'identité aurait produit une table
pleine de lignes sans acteur, ce qui est PIRE que vide : une piste d'audit qui ne désigne
personne donne l'illusion de la traçabilité sans en fournir aucune.

L'ordre a donc été respecté : l'annuaire (`slack_directory`) et la politique d'accès d'abord,
l'écriture ensuite. Chaque ligne écrite ici nomme réellement quelqu'un.

## Ce qui est journalisé, et ce qui ne l'est pas

On enregistre QUI, QUOI, et le VERDICT — jamais le texte du message. Le DM au bot est le
canal privilégié pour parler d'un salaire ou d'un litige ; le recopier dans une table
consultable transformerait un journal de sécurité en base de surveillance. C'est exactement
le grief RGPD que `PLAN-ARCHITECTURE.md` §4.7 oppose à l'ingestion de tous les canaux.
(Le texte est déjà journalisé en clair par `logger.info` sur ce chemin — c'est une dette
distincte, mais un log applicatif expire, une table non.)

**Avant `action: string;`**

 Verbe en majuscules : `SLACK_MESSAGE`, `AUTHZ_DENIED`, `RATE_LIMITED`.

**Avant `actorId: string;`**

 Identifiant Slack de la personne. Jamais vide — c'est le point de tout le fichier.

**Avant `status?: 'success' | 'accepted' | 'failure' | 'denied';`**

⚠️ `accepted` a été AJOUTÉ le 2026-08-19, et il manquait à un endroit précis.

Le défaut par défaut est `success`, ce qui est juste pour une action qu'on journalise
APRÈS l'avoir accomplie. Le site `SLACK_MESSAGE` écrit AVANT tout traitement — avant le
débit du budget, avant l'appel d'agent, avant la publication — et aucun chemin ne met la
ligne à jour ensuite : un message qui a épuisé le quota ou levé dans l'agent était
enregistré `success`. Même forme que `status = 'Sent'` posé avant le `try`.

`accepted` dit exactement ce qui a été constaté à cet instant : la demande est entrée. Rien
de plus, et c'est vrai.

**Avant `export async function writeAuditLog(`**

Écrit une ligne d'audit. **NE LÈVE JAMAIS, et n'est jamais attendue sur le chemin critique.**

Le raisonnement est le même que pour la déduplication partagée et le marqueur de progression :
une panne de la table d'audit ne doit pas devenir une panne du produit. Un journal manquant se
constate et se rattrape ; un bot muet a déjà coûté des heures à ce dépôt.

⚠️ La contrepartie est réelle et il faut la nommer : ce n'est PAS un journal d'audit de
conformité — un tel journal doit refuser l'action quand il ne peut pas l'enregistrer. C'est
une piste d'observabilité fiable en marche normale. La ligne à chercher quand elle manque :
    Audit log write failed

## `infrastructure/database/connection.ts`

**Avant `import { drizzle } from 'drizzle-orm/libsql';`**

db/connection.ts - Production-Grade DB Connection Manager (LibSQL/Turso)


Standards 2026: Serverless-safe, Migrations, Graceful Shutdown
**Avant `type DatabaseInstance = LibSQLDatabase<typeof schema>;`**

1. TYPES

**Avant `dbUrl: string;`**

 URL de connexion Turso/LibSQL

**Avant `authToken: string;`**

 Token d'authentification Turso

**Avant `autoMigrate: boolean;`**

 Exécuter les migrations au démarrage

**Avant `migrationsFolder: string;`**

 Dossier des migrations

**Avant `const DEFAULT_CONFIG: ConnectionConfig = {`**

2. CONFIGURATION PAR DÉFAUT

**Avant `let dbShutdownHandlersRegistered = false;`**

Flag module-scope pour éviter l'enregistrement multiple des handlers OS

**Avant `class LibSqlConnectionManager implements ConnectionManager {`**

3. CONNECTION MANAGER (Serverless-Safe)

**Avant `getDb(): DatabaseInstance {`**

PUBLIC API


Récupère l'instance de base de données
**Avant `async close(): Promise<void> {`**

Ferme proprement la connexion

**Avant `async healthCheck(): Promise<boolean> {`**

Vérifie l'état de santé de la connexion

**Avant `getStats(): DatabaseStats {`**

Récupère les statistiques de la base de données

**Avant `private connect(): void {`**

PRIVATE METHODS


Établit la connexion à la base de données
**Avant `this.runMigrations().catch((e) => {`**

En mode Turso/Serverless, c'est généralement déconseillé de migrer au runtime.


Mais si config.autoMigrate est activé (ex: tests locaux), on le lance de manière asynchrone.
**Avant `private async runMigrations(): Promise<void> {`**

Exécute les migrations Drizzle

**Avant `private setupGracefulShutdown(): void {`**

Configure le graceful shutdown

**Avant `export class DatabaseConnectionError extends Error {`**

4. ERREURS PERSONNALISÉES

**Avant `let connectionManager: ConnectionManager | null = null;`**

5. INSTANCE SINGLETON (Serverless-Safe)

## `infrastructure/database/schema.ts`

**Avant `import {`**

db/schema.ts - Production-Grade Drizzle Schema


Standards 2026: FKs, Indexes, Soft Delete, Audit Trail
**Avant `export const employees = sqliteTable(`**

1. EMPLOYEES

**Avant `department: text('department'),`**

NULLABLE depuis le 2026-08-13 : le parcours d'arrivée ne demande plus le département —
la modale « Compléter mon profil » ne pose qu'une question, le poste.

`NULL` est le seul encodage honnête de « on a délibérément cessé de collecter ça ». Une
sentinelle dans une colonne NOT NULL finit toujours par être relue comme une vraie
valeur, mode d'échec récurrent de ce dépôt.

⚠️ DDL : `scripts/ddl-employees-department-nullable.sql`, à appliquer AVANT le
déploiement. `idx_employees_department` y est supprimé et non recréé — une colonne
qu'on ne renseigne plus n'a aucune raison d'être indexée.

**Avant `onboardingStatus: text('onboarding_status').notNull().default('not_started'), // OnboardingStatu`**

EmployeeStatus

**Avant `managerId: text('manager_id'),`**

OnboardingStatus

**Avant `createdAt: text('created_at')`**

Record<string, unknown>


Timestamps
**Avant `},`**

Soft delete

**Avant `emailIdx: uniqueIndex('idx_employees_email').on(table.email),`**

Indexes

**Avant `emailCheck: check('chk_employees_email', sql`${table.email} LIKE '%@%'`),`**

Contrainte: email doit contenir '@'

**Avant `export const tasks = sqliteTable(`**

2. TASKS

**Avant `reviewerId: text('reviewer_id'), // Pour les tâches de type Review`**

La personne qui exécute (peut différer de employeeId)

**Avant `title: text('title').notNull(),`**

Pour les tâches de type Review

**Avant `status: text('status').notNull().default('pending'), // TaskStatus`**

TaskType

**Avant `priority: text('priority').notNull().default('medium'), // TaskPriority`**

TaskStatus

**Avant `dueDate: text('due_date'),`**

TaskPriority

**Avant `metadata: text('metadata', { mode: 'json' }), // Record<string, unknown>`**

string[]

**Avant `createdAt: text('created_at')`**

Record<string, unknown>


Timestamps
**Avant `},`**

Soft delete

**Avant `employeeFk: foreignKey(() => ({`**

Foreign Keys

**Avant `employeeIdx: index('idx_tasks_employee').on(table.employeeId),`**

Indexes

**Avant `export const documents = sqliteTable(`**

3. DOCUMENTS

**Avant `type: text('type').notNull(), // DocumentType`**

Si généré depuis un template

**Avant `title: text('title').notNull(),`**

DocumentType

**Avant `content: text('content'),`**

CONTENU du document — le texte lui-même.

Ajoutée le 2026-08-11 après une perte de données vérifiée en production :
l'entité `Document` déclare `content: string`, `generateDocument` l'exige
en entrée… et aucune colonne ne l'accueillait. Drizzle IGNORE
silencieusement toute clé de `.values()` sans colonne déclarée, et le
`as unknown as` des mappers effaçait l'écart pour le compilateur : les 6
documents de la Turso de production ne contiennent RIEN.

Pourquoi une colonne, et non un mappage vers les colonnes existantes : le
bloc « stockage » ci-dessous décrit une référence vers un objet S3/GCS qui
n'existe pas — `storage_key`, `storage_bucket`, `file_name`, `file_size`
et `mime_type` sont NULL sur 6 lignes / 6, aucun bucket n'est configuré
nulle part dans le dépôt. Détourner `description` (un résumé) ou
`metadata` (un JSON libre) pour y loger le corps du document ferait mentir
deux colonnes au lieu d'en ajouter une juste. Tant qu'aucun stockage
objet n'existe, la base EST le stockage.

Nullable, car les 6 lignes déjà écrites n'ont pas de contenu à rétablir.

**Avant `storageKey: text('storage_key'), // Clé S3/GCS`**

Stockage : on stocke la référence S3, pas le contenu

**Avant `storageBucket: text('storage_bucket'),`**

Clé S3/GCS

**Avant `mimeType: text('mime_type'),`**

En bytes

**Avant `status: text('status').notNull().default('pending'), // DocumentStatus`**

DocumentFormat

**Avant `version: integer('version').notNull().default(1),`**

DocumentStatus

**Avant `createdAt: text('created_at')`**

Record<string, unknown>


Timestamps
**Avant `},`**

Soft delete

**Avant `employeeFk: foreignKey(() => ({`**

Foreign Keys

**Avant `employeeIdx: index('idx_documents_employee').on(table.employeeId),`**

Indexes

**Avant `export const notifications = sqliteTable(`**

4. NOTIFICATIONS

**Avant `channel: text('channel').notNull(), // NotificationChannel`**

RecipientType

**Avant `priority: text('priority').notNull().default('normal'), // NotificationPriority`**

NotificationChannel

**Avant `templateId: text('template_id'),`**

NotificationPriority

**Avant `subject: text('subject').notNull(),`**

Record<string, unknown>

**Avant `errorMessage: text('error_message'),`**

NotificationStatus

**Avant `createdAt: text('created_at')`**

Record<string, unknown>


Timestamps
**Avant `recipientIdx: index('idx_notifications_recipient').on(table.recipientId, table.recipientType),`**

Indexes

**Avant `export const questionnaires = sqliteTable(`**

5. QUESTIONNAIRES

**Avant `title: text('title').notNull(),`**

Nullable: questionnaire peut être un template

**Avant `questions: text('questions', { mode: 'json' }).notNull(), // Question[]`**

'onboarding', 'feedback', 'evaluation', 'exit'

**Avant `status: text('status').notNull().default('draft'), // QuestionnaireStatus`**

Question[]

**Avant `isAnonymous: integer('is_anonymous', { mode: 'boolean' }).default(false),`**

QuestionnaireStatus

**Avant `dueDate: text('due_date'),`**

Qui a assigné le questionnaire

**Avant `createdAt: text('created_at')`**

Timestamps

**Avant `employeeFk: foreignKey(() => ({`**

Foreign Keys

**Avant `employeeIdx: index('idx_questionnaires_employee').on(table.employeeId),`**

Indexes

**Avant `export const questionnaireResponses = sqliteTable(`**

6. QUESTIONNAIRE RESPONSES

**Avant `status: text('status').notNull().default('pending'), // ResponseStatus`**

QuestionResponse[]

**Avant `score: real('score'),`**

ResponseStatus

**Avant `timeSpentSeconds: integer('time_spent_seconds'),`**

0-100

**Avant `createdAt: text('created_at')`**

Timestamps

**Avant `questionnaireFk: foreignKey(() => ({`**

Foreign Keys

**Avant `uniqueEmployeeQuestionnaire: uniqueIndex('uq_responses_employee_questionnaire').on(`**

Unique: un employé ne peut répondre qu'une fois à un questionnaire


(sauf si le questionnaire le permet explicitement)
**Avant `questionnaireIdx: index('idx_responses_questionnaire').on(table.questionnaireId),`**

Indexes

**Avant `export const onboardingProgress = sqliteTable(`**

7. ONBOARDING PROGRESS

**Avant `status: text('status').notNull().default('not_started'), // OnboardingStatus`**

Si basé sur un template d'onboarding

**Avant `currentStep: integer('current_step').notNull().default(0),`**

OnboardingStatus

**Avant `startedAt: text('started_at'),`**

0-100

**Avant `metadata: text('metadata', { mode: 'json' }), // Record<string, unknown>`**

Référent/parrain

**Avant `createdAt: text('created_at')`**

Record<string, unknown>


Timestamps
**Avant `employeeFk: foreignKey(() => ({`**

Foreign Keys

**Avant `uniqueEmployee: uniqueIndex('uq_onboarding_employee').on(table.employeeId),`**

Unique: un seul onboarding actif par employé

**Avant `statusIdx: index('idx_onboarding_progress_status').on(table.status),`**

Indexes

**Avant `export const onboardingSteps = sqliteTable(`**

8. ONBOARDING STEPS

**Avant `name: text('name').notNull(),`**

Optionnel: lié à une tâche existante

**Avant `status: text('status').notNull().default('pending'), // TaskStatus`**

'documents', 'training', 'meetings', 'setup'

**Avant `isRequired: integer('is_required', { mode: 'boolean' }).notNull().default(true),`**

TaskStatus

**Avant `startedAt: text('started_at'),`**

Qui est responsable de cette étape

**Avant `createdAt: text('created_at')`**

Record<string, unknown>


Timestamps
**Avant `progressFk: foreignKey(() => ({`**

Foreign Keys

**Avant `progressIdx: index('idx_onboarding_steps_progress').on(table.progressId),`**

Indexes

**Avant `export const employeeDocuments = sqliteTable(`**

9. EMPLOYEE DOCUMENTS (Junction Table)

**Avant `status: text('status').notNull().default('pending'), // 'pending', 'acknowledged', 'signed', 'ex`**

Statut spécifique à l'association employé-document

**Avant `acknowledgedAt: text('acknowledged_at'),`**

'pending', 'acknowledged', 'signed', 'expired'

**Avant `createdAt: text('created_at')`**

Timestamps

**Avant `employeeFk: foreignKey(() => ({`**

Foreign Keys

**Avant `uniqueEmployeeDocument: uniqueIndex('uq_employee_document').on(`**

Unique: un document ne peut être assigné qu'une fois à un employé

**Avant `employeeIdx: index('idx_employee_documents_employee').on(table.employeeId),`**

Indexes

**Avant `export const auditLogs = sqliteTable(`**

10. AUDIT LOGS (Enriched)

**Avant `actorId: text('actor_id').notNull(),`**

e.g., 'CREATE_EMPLOYEE', 'SEND_NOTIFICATION'

**Avant `actorEmail: text('actor_email'),`**

'user', 'system', 'api', 'webhook'

**Avant `details: text('details', { mode: 'json' }), // { before, after, changes }`**

'Employee', 'Task', 'Document', etc.

**Avant `ipAddress: text('ip_address'),`**

{ before, after, changes }


Contexte de la requête
**Avant `status: text('status').notNull().default('success'), // 'success', 'failure', 'denied'`**

Statut

**Avant `errorMessage: text('error_message'),`**

'success', 'failure', 'denied'

**Avant `createdAt: text('created_at')`**

Timestamp

**Avant `actorIdx: index('idx_audit_logs_actor').on(table.actorId, table.actorType),`**

Indexes

**Avant `export const conversationTurns = sqliteTable(`**

11. CONVERSATION TURNS (Mémoire conversationnelle)


Table unique de la feature `conversation`. L'agent « collant » d'un fil est simplement

l'`agent_id` du dernier tour : la requête de fenêtre le ramène déjà, aucune seconde table

n'est nécessaire.

⚠️ Écart ASSUMÉ au style des 10 tables ci-dessus : elles horodatent en `text` via

`datetime('now')`, qui a une résolution à la SECONDE et un format sans fuseau. Ici

l'horodatage est le discriminant du TTL *et* de l'ordre des tours ; deux messages d'un même

échange arrivent couramment dans la même seconde, et les égalités casseraient l'ordre

chronologique dont dépend `selectWindow`. D'où un entier en millisecondes, qui donne aussi

un `Date` natif côté Drizzle — donc pas de reparsing pour l'arithmétique du TTL.
**Avant `role: text('role').notNull(), // 'user' | 'assistant'`**

`${channel}` ou `${channel}:${threadTs}`

**Avant `content: text('content').notNull(), // texte seul — jamais de tool-call ni de tool-result`**

'user' | 'assistant'

**Avant `agentId: text('agent_id').notNull(), // onboardingOrchestrator | questionnaireEngine | notificat`**

texte seul — jamais de tool-call ni de tool-result

**Avant `slackUserId: text('slack_user_id'), // null sur un tour assistant`**

onboardingOrchestrator | questionnaireEngine | notificationAgent

**Avant `createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),`**

null sur un tour assistant


Timestamp
**Avant `conversationCreatedAtIdx: index('idx_conversation_turns_conversation_created_at').on(`**

Index unique servant les deux accès : fenêtre d'une conversation (égalité + tri) et purge.

**Avant `export const onboardingInterview = sqliteTable(`**

11 ter. ONBOARDING INTERVIEW (Entretien post-profil)


Ce que la personne dit d'elle APRÈS avoir complété son profil : les canaux qui l'intéressent,

ce qu'elle fait au quotidien, comment elle préfère travailler.

── Pourquoi une table et pas `questionnaire_responses` ─────────────────────────────────

Cette table existe déjà et porte `score`, `max_score`, `percentage`, `reviewed_by`,

`review_notes` : elle est en forme de QUIZ CORRIGÉ. Un entretien n'a ni bonne réponse ni

note, et sept colonnes resteraient NULL sur 100 % des lignes — un schéma qui décrit autre

chose que ce qu'il contient finit toujours par être relu comme s'il disait vrai. Elle a de

surcroît une clé étrangère vers `questionnaires`, qui obligerait à fabriquer une ligne de

définition pour un formulaire écrit en dur dans le code.

Relevé du 2026-08-14 : `questionnaire_responses` = **0 ligne** pour 5 questionnaires

enregistrés. Personne n'a jamais pu répondre à quoi que ce soit, parce qu'aucun chemin de

soumission n'existait. C'est ce chemin-là qu'apporte l'entretien.

── `employee_id` EST la clé primaire ───────────────────────────────────────────────────

Un employé a un entretien, pas une collection. Cette forme rend l'upsert trivial et

l'invariant STRUCTUREL plutôt que conventionnel : il ne peut pas exister deux réponses

concurrentes dont on ne saurait laquelle est courante.
**Avant `slackUserId: text('slack_user_id').notNull(),`**

 Auteur Slack — conservé pour l'effacement et pour ré-inviter sans relire `employees`.

**Avant `channels: text('channels', { mode: 'json' }).notNull(),`**

Identifiants `C…` des canaux choisis, en JSON.

Les ID et non les NOMS : un canal se renomme sans que son `C…` bouge, et c'est l'ID que
`conversations.invite` consomme. Même arbitrage que la clé de `slack_channels`.

**Avant `dailyWork: text('daily_work').notNull().default(''),`**

 Texte libre — ce que la personne fait au quotidien. Assaini avant écriture.

**Avant `workStyle: text('work_style').notNull().default(''),`**

 Texte libre — comment elle préfère travailler. Assaini avant écriture.

**Avant `slackUserIdx: index('idx_onboarding_interview_slack_user').on(table.slackUserId),`**

Sert l'effacement par personne et la relecture depuis un identifiant Slack — le seul


disponible sur le chemin d'un message.
**Avant `export const pinnedFacts = sqliteTable(`**

11 bis. PINNED FACTS (Mémoire longue, hors TTL)


`conversation_turns` porte un TTL de 60 minutes et une fenêtre de 1 600 tokens : tout ce

qu'on y écrit est destiné à disparaître. C'est le bon comportement pour un fil de

discussion, et le mauvais pour « souviens-toi que mon poste est Backend Developer » —

`TODO.md` le recense depuis le 2026-08-13 : la demande n'ÉPINGLAIT rien, alors que le

modèle promettait de s'en souvenir.

D'où une table SÉPARÉE, et non un drapeau sur `conversation_turns` : les deux ont des

durées de vie opposées, et un `WHERE pinned = 0` dans la purge finirait par être oublié

une fois. La séparation rend l'invariant structurel — cette table n'est JAMAIS purgée par

le TTL.

La clé est le `slack_user_id`, pas la conversation : un fait sur soi vaut dans tous les

fils. C'est aussi ce qui permet à `forget()` de les emporter par la même clé.

⚠️ Aucune borne en SQL. Le plafond (5 faits, 120 caractères) vit dans le CODE

(`src/shared/pin-fact.ts`), parce qu'il est dicté par le budget de tokens du préambule et

non par le stockage — et parce qu'un dépassement doit ÉVINCER le plus ancien, pas échouer.
**Avant `fact: text('fact').notNull(),`**

 Texte D'ORIGINE de la personne, assaini — jamais normalisé ni reformulé.

**Avant `userCreatedAtIdx: index('idx_pinned_facts_user_created_at').on(`**

Sert les deux accès : lecture des faits d'une personne (égalité + tri) et éviction du


plus ancien. Aucun index sur `created_at` seul — rien ne purge cette table par l'âge,

et c'est tout son objet.
**Avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

11 bis. PENDING INTERVIEW EMAIL (email préparé, en attente d'un « oui »)


Ajoutée le 2026-08-19, quand les boutons ont été retirés du produit. La confirmation d'envoi

vivait dans un Block Kit « Envoyer / Annuler » ; elle est devenue une question à laquelle on

répond oui ou non.

⚠️ POURQUOI UNE TABLE, alors que les deux machines à états de l'accueil n'en ont AUCUNE.

Leur état est le dernier tour `assistant` du fil — gratuit, et suffisant tant que l'état ne

survit pas à une digression. Ici il doit y survivre : l'exigence est de RAPPELER l'email en

attente si l'on change de sujet, et de le GARDER en suspens si la personne veut vraiment

changer de sujet. Un état qui doit tenir pendant qu'on parle d'autre chose ne peut pas être

le dernier message du bot — par définition, ce n'est plus lui.

⚠️ ON N'Y STOCKE QUE DES CHAMPS, JAMAIS LE CORPS DE L'EMAIL. C'est le contrat que portait

déjà le `value` du bouton, et sa raison n'a pas changé : transporter le corps ferait de cette

table un moyen d'envoyer un texte arbitraire à une adresse arbitraire, la primitive que toute

la feature est construite pour ne pas offrir. Sujet et corps sont RE-RENDUS à l'envoi, la

date RE-VALIDÉE.

⚠️ La clé est la CONVERSATION, pas la personne : c'est dans ce fil qu'on répondra « oui ».

Une seconde préparation dans la même conversation remplace la première — l'humain n'en voit

qu'une à l'écran, et deux lignes signifieraient qu'un « oui » est ambigu.

Horodatage entier en millisecondes, comme `pinned_facts` et `conversation_turns`.
**Avant `startsAt: text('starts_at').notNull(),`**

 ISO. RE-VALIDÉ à l'envoi : entre la préparation et le « oui », la date a pu passer.

**Avant `export const slackEventDedup = sqliteTable(`**

12. SLACK EVENT DEDUP (Déduplication multi-instance)


Table unique de la déduplication PARTAGÉE des événements Slack. Le cache LRU du handler est

en mémoire, donc par instance : il est incapable par construction d'écarter un rejeu routé

vers une AUTRE instance pendant que la première traite encore l'événement — c'est-à-dire

exactement le cas qui produit une double réponse (incident du 2026-08-11, 12:38 UTC).

La `key` est celle du handler (`ts:<channel>:<ts>` ou `id:<event_id>`) et sert de PRIMARY

KEY : c'est elle qui rend la prise atomique via `INSERT … ON CONFLICT DO NOTHING`.

⚠️ Même écart assumé que `conversation_turns` sur l'horodatage : entier en millisecondes et

non `datetime('now')` en `text`. `started_at` est le discriminant de la grâce d'abandon

(60 s) ; une résolution à la seconde y serait grossière, et le comparer exigerait un

reparsing à chaque prise de clé — sur le chemin d'ACK, celui qui a 3 secondes.
**Avant `status: text('status').notNull(), // 'in-flight' | 'done'`**

`ts:<channel>:<ts>` ou `id:<event_id>`

**Avant `startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),`**

'in-flight' | 'done'

**Avant `startedAtIdx: index('idx_slack_event_dedup_started_at').on(table.startedAt),`**

Sert la purge de rétention (~10 min, la fenêtre de rejeu de Slack). L'accès par clé


passe déjà par l'index implicite de la PRIMARY KEY.
**Avant `export const slackDirectory = sqliteTable(`**

13. SLACK DIRECTORY (Annuaire du workspace — autorisation)


Ce qui manquait pour que « qui parle ? » ait une réponse. `slack-events.handler.ts` lisait

`event.user` pour le journal et l'anti-boucle, puis le jetait : une chaîne `U…` opaque, dont

le système ne pouvait pas dire si elle désignait la responsable RH ou un invité mono-canal.

La table porte des FAITS que Slack maintient lui-même (`is_bot`, `is_restricted`,

`is_ultra_restricted`, `deleted`), et non une liste d'identifiants tenue à la main : ajouter

un invité au workspace le rétrograde automatiquement, sans qu'aucune variable d'environnement

ne bouge. Même exigence que `agentToolBoundary(tools)`, dérivée de `Object.keys(tools)` — ce

dépôt a déjà payé trois fois le prix d'une liste rédigée qui se désynchronise du réel.

⚠️ DDL : `scripts/ddl-slack-directory.sql`, à appliquer à la main (les migrations `drizzle/`

sont désynchronisées et `drizzle-kit push` se bloque contre une base `libsql://` distante).
**Avant `slackUserId: text('slack_user_id').primaryKey(),`**

La PRIMARY KEY est `slack_user_id`, PAS l'email : un email se change dans le profil Slack,


l'identifiant `U…` est immuable. Une clé portée par l'email ferait qu'un changement

d'adresse crée un SECOND sujet avec ses propres droits — élévation de privilège par

simple édition de profil.
**Avant `email: text('email'),`**

NULLABLE, et ce n'est pas de la prudence de façade : `users.list` ne rend `profile.email`


que si `users:read.email` est accordé ET que le compte en porte un ; les bots n'en ont

pas. La politique traite « pas d'email » comme un cas NOMMÉ, jamais comme une chaîne vide

comparée à un domaine — une chaîne vide finirait par matcher.
**Avant `realName: text('real_name').notNull().default(''),`**

NOT NULL avec DEFAULT '' : ces champs sont affichés et concaténés, un NULL y imprimerait


« null » plutôt qu'un blanc. Arbitrage inverse de `email`, qui est une CLÉ de recherche.
**Avant `firstName: text('first_name'),`**

Prénom, nom et poste — lus TELS QUELS dans `profile.first_name`, `profile.last_name` et


`profile.title`, jamais dérivés de `real_name`. Sur les données réelles du workspace,

découper `real_name` sur l'espace marche quatre fois sur cinq et échoue sur

`ridwanenico77`, qui n'a pas de prénom mais un pseudo. Une heuristique fausse une fois

sur cinq n'est pas une heuristique, c'est une invention.

NULLABLES, et la nullité veut dire quelque chose : Slack rend une CHAÎNE VIDE pour un

champ non renseigné, qu'on normalise en `NULL`. `''` se lirait « renseigné, mais vide ».

Et comme `synced_at` prouve qu'on a interrogé Slack, `NULL` signifie ici « Slack ne le

précise pas » — une absence AVÉRÉE, pas une ignorance.

⚠️ `title` est le poste DÉCLARATIF, édité par son porteur. Distinct de

`employees.position`, qui est le poste CONTRACTUEL : deux faits, deux sources, aucun

arbitrage à écrire entre eux.
**Avant `isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),`**

Flags de CONFIANCE — matière première de la politique d'autorisation. Aucun n'est


nullable : « on ne sait pas si c'est un invité » ne doit pas exister comme état, la

politique devrait alors décider sur un troisième cas où le défaut sûr serait

indiscernable de l'ignorance.

is_restricted = invité multi-canal ; is_ultra_restricted = invité mono-canal.
**Avant `dmChannelId: text('dm_channel_id'),`**

⚠️ INDÉCOUVRABLE par balayage : `conversations.list({types:'im'})` répond `missing_scope`


(il faudrait `im:read`, non accordé — vérifié le 2026-08-12). La colonne se remplit

OPPORTUNÉMENT, au premier DM reçu, où Slack livre le canal dans `event.channel`. Vide

signifie « cette personne ne nous a jamais écrit en direct », pas « on ne sait pas le

trouver ». Corollaire : une valeur perdue l'est DÉFINITIVEMENT — d'où le `set`

champ-par-champ de l'upsert côté repository, qui ne la nomme jamais.
**Avant `employeeId: text('employee_id').references(() => employees.id),`**

Pont vers le métier, NULLABLE dans les deux sens : tout membre du workspace n'est pas un


employé enregistré, et tout employé n'a pas forcément de compte Slack.
**Avant `role: text('role').notNull().default('employee'), // EmployeeRole`**

RÔLE — la seule colonne de ce dépôt dont dépende une autorisation.

`employee` par défaut, et le défaut est le bon : n'accorde rien au-delà de son propre
dossier. Seul `manager` ouvre la portée aux données de tout le monde (`resolveAccess`).

⚠️ **ICI et non sur `employees`**, et c'est la donnée réelle qui l'a imposé : le General
Manager de l'entreprise n'a AUCUNE ligne dans `employees`, et 5 des 6 personnes vivantes
non plus — cette table-là ne contient que les dossiers créés par le parcours d'accueil.
Lui en fabriquer un aurait exigé d'inventer `start_date` et `position` pour quelqu'un que
ce produit n'a jamais intégré. Le sujet d'une décision d'autorisation n'est pas un
dossier RH, c'est un MEMBRE DU WORKSPACE : la colonne rejoint donc `is_bot`,
`is_restricted` et `is_deleted`, les autres faits sur lesquels la même fonction tranche.

⚠️ Elle n'est écrite par AUCUN chemin en libre-service, ni par la synchronisation Slack :
`upsertFacts` énumère ses colonnes une par une et ne la nomme pas, exactement comme pour
`dm_channel_id` et `employee_id`. C'est ce qui la distingue de `title`, que son porteur
édite dans son profil — une autorisation dérivée d'un champ déclaratif s'obtiendrait en
le déclarant. Et `title` porte ici « Product Manager » sur quelqu'un qui n'est pas LE
manager : la chaîne ne décide rien.

⚠️ DDL : `scripts/ddl-slack-directory-role.sql`, à appliquer AVANT le déploiement.

**Avant `firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),`**

EmployeeRole


Même écart assumé que `conversation_turns` : entier en millisecondes plutôt que

`datetime('now')` en text. `syncedAt` gouverne la fraîcheur, `firstSeenAt` n'est écrit

qu'à l'INSERT — une seule fois dans la vie de la ligne.
**Avant `emailIdx: index('idx_slack_directory_email').on(table.email),`**

NON UNIQUE à dessein : deux comptes peuvent porter la même adresse le temps d'une


migration, et une contrainte d'unicité ferait échouer la synchronisation ENTIÈRE plutôt

que de rapporter deux lignes.
**Avant `export const rateLimitCounters = sqliteTable(`**

14. RATE LIMIT COUNTERS (Limitation de débit partagée)


Un compteur en mémoire est PAR INSTANCE et disparaît au gel de la fonction serverless. Sur un

budget qui se mesure à la JOURNÉE (`TPD: Limit 100000` ≈ 19 messages/jour), il ne protège donc

RIEN : Vercel démarre une instance neuve sans que personne le demande, le compteur repart à

zéro pendant que le quota du fournisseur, lui, continue de courir.

C'est la leçon exacte de la double réponse du 2026-08-11 : le cache LRU de déduplication était

lui aussi en mémoire. Un état par instance ne peut, par construction, rien dire de sa voisine.

⚠️ DDL : `scripts/ddl-rate-limit-counters.sql`.
**Avant `key: text('key').primaryKey(),`**

`key` EST la clé primaire, et ce n'est pas un détail de modélisation : c'est elle qui rend


l'incrément atomique via `INSERT … ON CONFLICT DO UPDATE`. Deux instances qui incrémentent

au même instant sont départagées par la base, sans verrou applicatif — le seul mécanisme

qui tienne quand les deux concurrents ne partagent aucune mémoire.

La FENÊTRE est DANS la clé (`<règle>:<sujet>:<numéro de fenêtre>`), pas dans une colonne

comparée : remettre un compteur à zéro exigerait de lire, décider, puis écrire — donc de

rouvrir la course. Ici, changer de fenêtre change de ligne.
**Avant `count: integer('count').notNull(),`**

Sans DEFAULT : une ligne n'existe que parce qu'un incrément l'a créée. Un DEFAULT 0


laisserait croire qu'une ligne peut naître vide.
**Avant `windowStart: integer('window_start', { mode: 'timestamp_ms' }).notNull(),`**

Redondant avec le numéro de fenêtre encodé dans la clé, et c'est voulu : la clé est une


chaîne opaque. Cette colonne répond à « depuis quand ce compteur court-il ? » sans

reparser un identifiant.
**Avant `expiresAtIdx: index('idx_rate_limit_counters_expires_at').on(table.expiresAt),`**

Sert la PURGE : sans elle la table croîtrait indéfiniment, une ligne par sujet ET par


fenêtre. L'accès par clé passe déjà par l'index implicite de la PRIMARY KEY.
**Avant `export const slackChannels = sqliteTable(`**

15. SLACK CHANNELS (Inventaire des canaux — feature `directory`)


⚠️⚠️ CES DEUX TABLES SONT UN INVENTAIRE D'OBSERVABILITÉ, JAMAIS UNE SOURCE D'AUTORISATION.

La tentation est écrite d'avance : « les membres de #engineer-karyl » RESSEMBLE à une liste

d'autorisation, et quelqu'un finira par la lire comme telle. Or `#engineer-karyl` est PRIVÉ,

et servir son contenu à un non-membre sur la foi de ces lignes est exactement le « deputy

confus » de `PLAN-ARCHITECTURE.md` §4.1 — que la feature `knowledge` ferme en interrogeant

Slack EN DIRECT à chaque décision de divulgation.

L'aggravant est vérifiable et n'a rien d'hypothétique : **il n'existe AUCUN chemin

d'invalidation**. Les abonnements de l'app n'incluent ni `member_joined_channel`, ni

`member_left_channel` (liste faisant foi : `CLAUDE.md`, section « ABONNEMENTS »).

Aucun événement ne viendra jamais démentir une ligne d'ici. Ces tables ne sont donc pas

« périmées dans trois jours » : elles sont fausses, et silencieuses, dès la première personne

qui quitte un canal entre deux synchronisations manuelles.

La règle est rendue EXÉCUTABLE, et non recommandée, par

`tests/unit/directory/channel-inventory-not-an-acl.test.ts` : il échoue si `knowledge/**`,

`access-policy.ts` ou `access-guard.ts` importent le repository de canaux.

Ce que ces tables servent, et rien d'autre : « dans quels canaux le bot est-il ?  »,

« combien de personnes y a-t-il ? », « qui y est ? », « depuis quand ? » — de l'inventaire.

⚠️ DDL : `scripts/ddl-slack-channels.sql`.
**Avant `channelId: text('channel_id').primaryKey(),`**

La PRIMARY KEY est l'identifiant, PAS le nom. Un canal se renomme (`#random` →


`#random-fr`) sans que son `C…` bouge : une clé portée par le nom ferait qu'un renommage

crée un SECOND canal et laisse l'ancien vivre à côté, avec ses membres périmés. Même

arbitrage que `slack_directory`, dont la clé est le `U…` et non l'email.
**Avant `name: text('name').notNull().default(''),`**

NOT NULL DEFAULT '' : le nom est affiché et concaténé, un NULL y imprimerait « null ».


Arbitrage identique à `real_name` / `display_name` de `slack_directory`.
**Avant `isPrivate: integer('is_private', { mode: 'boolean' }).notNull().default(false),`**

Faits d'accès, tels que `conversations.list` les rend. `isMember` est le seul qui


détermine si `chat.postMessage` peut aboutir — c'est lui, et non « le bot est invité »,

qui décide d'un `not_in_channel`.
**Avant `memberCountReported: integer('member_count_reported'),`**

⚠️ LE NOM DE CETTE COLONNE EST LE COMMENTAIRE. C'est une ASSERTION DE SLACK


(`conversations.list` → `num_members`), pas un cache du `COUNT(*)` de

`slack_channel_members`. Les deux viennent d'appels DISTINCTS, donc d'instants distincts,

et divergent normalement.

Le VRAI compte est `COUNT(*)` sur la table de jointure. L'écart entre les deux est un

signal de fraîcheur GRATUIT — et le nommer `member_count` tout court aurait garanti qu'on

le prenne un jour pour l'autorité, puis qu'on « corrige » l'écart en le réécrivant.

NULLABLE : Slack ne rend pas toujours `num_members` (canaux privés notamment). NULL dit

« Slack n'a rien affirmé », ce qu'un `0` — indiscernable d'un canal vide — ne dirait pas.
**Avant `syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),`**

Millisecondes (Drizzle `timestamp_ms`), comme `conversation_turns`, `slack_event_dedup` et


`slack_directory` — et non le `datetime('now')` en text des 10 tables historiques.
**Avant `syncedAtIdx: index('idx_slack_channels_synced_at').on(table.syncedAt),`**

Sert « quand cet inventaire a-t-il été confirmé pour la dernière fois ? ». Sans fraîcheur


lisible, une table sans chemin d'invalidation se lit « à jour ».
**Avant `channelId: text('channel_id')`**

FK DÉCLARÉE, et c'est un choix : les deux lignes sont écrites par la MÊME passe de


synchronisation, le canal AVANT ses membres. `PRAGMA foreign_keys = 1` étant ACTIF sur la

Turso de production (vérifié le 2026-08-12), une appartenance orpheline échoue

bruyamment — ce qui est le comportement voulu : une appartenance sans canal ne désigne

rien.
**Avant `slackUserId: text('slack_user_id').notNull(),`**

⚠️ AUCUNE FK VERS `slack_directory`, ET C'EST DÉLIBÉRÉ.


Un membre de canal peut parfaitement être un compte que l'annuaire ne connaît pas encore :

les deux synchronisations sont INDÉPENDANTES (`--members` et `--channels` s'exécutent

séparément), une personne arrivée depuis le dernier balayage de `users.list` n'a pas de

ligne, et les bots tiers n'en ont pas non plus.

Avec le pragma actif, une FK ici ferait ÉCHOUER l'enregistrement précisément sur les

comptes les plus intéressants — les nouveaux arrivants — et imposerait un ordre entre deux

synchronisations qui n'en ont pas. Un inventaire enregistre ce qu'il OBSERVE ; il n'est

pas la vérité référentielle des personnes.
**Avant `firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),`**

Survit aux resynchronisations d'une personne toujours présente : c'est le champ que


`replaceMembers` ne nomme JAMAIS dans son `set`, exactement comme `upsertFacts` protège

`dm_channel_id`. Le mode d'échec évité est celui, déjà payé, de `documents.content` : une

écriture qui perd une donnée en silence.
**Avant `syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),`**

Marqueur de passe. Il porte à lui seul la sémantique de REMPLACEMENT : la passe réécrit


`synced_at` sur les membres présents, puis supprime du canal tout ce qui porte encore un

`synced_at` antérieur. Une personne partie DISPARAÎT — les membres d'un canal à l'instant

T sont un ENSEMBLE, jamais une accumulation.
**Avant `pk: primaryKey({ columns: [table.channelId, table.slackUserId] }),`**

PK COMPOSITE, sans clé de substitution : la ligne n'a pas d'identité propre, elle EST


l'appartenance. Un `id` autogénéré autoriserait deux lignes identiques pour le même

couple, et le doublon ne se verrait qu'au `COUNT(*)`, c'est-à-dire dans le seul chiffre

que cette table existe pour rendre.
**Avant `userIdx: index('idx_slack_channel_members_user').on(table.slackUserId),`**

« Dans quels canaux est cette personne ? » — la PK indexe (channel_id, slack_user_id),


donc elle ne sait pas répondre dans ce sens.
**Avant `syncedAtIdx: index('idx_slack_channel_members_synced_at').on(table.syncedAt),`**

Détection des départs : c'est la colonne sur laquelle porte la suppression de fin de passe.

**Avant `import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';`**

16. TYPES INFÉRÉS POUR LES REQUÊTES

**Avant `export type Employee = InferSelectModel<typeof employees>;`**

Select types (lecture)

**Avant `export type NewEmployee = InferInsertModel<typeof employees>;`**

Insert types (création)

## `mastra/index.ts`

**Avant `void healthCheck().catch((error) => {`**

AMORÇAGE DE LA CONNEXION — mesuré, et à contre-courant du commentaire précédent


L'ancienne note disait « getDb() appelé ici forcerait l'ouverture au démarrage — inutile

en dev ». Sa prémisse est fausse en production, et le prix a été mesuré le 2026-08-12 :

    WARN | Slack ACK budget at risk | {"ackMs":1619,"admissionMs":1619}

`ackMs === admissionMs` : la totalité du budget d'accusé de réception était consommée

À L'INTÉRIEUR de `handler.accept()`, c'est-à-dire dans Turso. Signature, parsing et

construction du handler pèsent ensemble moins d'une milliseconde.

Ce que paie ce chemin : la déduplication partagée et le limiteur de débit font chacun un

aller-retour vers `aws-ap-northeast-1` (Tokyo) — mais surtout, le PREMIER d'entre eux

paie le handshake complet (DNS + TCP + TLS + upgrade WebSocket + hello hrana), soit 4 à

5 allers-retours. Slack rejoue tout événement non acquitté en 3 s, et un rejeu est

exactement ce qui a produit la double réponse du 2026-08-11.

`createClient` de libsql est SYNCHRONE et ouvre le socket de façon impérative : le coût

n'est payé qu'au premier `await`. L'amorcer ici fait donc chevaucher le handshake avec

l'évaluation du reste du bundle, au lieu de l'ajouter au chemin d'ACK. Ce n'est pas

« ouvrir plus tôt », c'est « ne plus le payer au pire moment ».

`void` et `.catch()` : aucun `await` au niveau module (il bloquerait le démarrage), et

une base injoignable au boot ne doit pas faire échouer le chargement — chaque appelant

gère déjà sa propre dégradation. On journalise, on ne relance pas.
**Avant `const emailProvider = createEmailProvider();`**

⚠️ `createEmailProvider` a été EXTRAIT vers


`features/notification/infrastructure/providers/email-provider.factory.ts` le 2026-08-14 :

`slack-interactions.route.ts` en a besoin (l'email d'entretien part au clic) et ne peut pas

importer ce fichier-ci, qui importe la route. Le recopier ferait diverger le choix de

fournisseur entre deux chemins d'envoi, sans que rien ne le signale.
**Avant `console.log('ENV CHECK', {`**

Ne JAMAIS logger la valeur d'une clé d'API — uniquement sa présence.

**Avant `const docxService = new DocxService();`**

Renderers de documents — c'est CE câblage qui fait entrer `docx` dans le bundle.

`DocxService` importe `docx` statiquement : tant qu'aucun module atteignable depuis ce
fichier ne le référençait, le bundler Mastra/Vercel ne l'embarquait pas. Le garde-fou
`verify:bundle` exige désormais sa présence (`--require …,docx` dans package.json) —
les deux vont ensemble, ajouter l'exigence sans ce câblage casserait le build.

**Avant `const directoryRepo = new DrizzleDirectoryRepository();`**

Annuaire des personnes et couverture des canaux (feature `directory`)


UN SEUL WebClient : les deux adaptateurs consomment `slackWorkspace` déjà câblé. Deux

clients ignoreraient chacun les appels de l'autre et franchiraient un plafond de débit que

ni l'un ni l'autre ne verrait venir.

⚠️ Ce sont des FACTORIES : aucune E/S au chargement du module. Ce fichier est évalué à

chaque démarrage à froid, donc sur le chemin des 3 secondes d'ACK de Slack — un ACK à 6,7 s

a déjà provoqué un rejeu, donc la double réponse du 2026-08-11.
**Avant `export const directorySync = makeDirectorySync({`**

Synchronisation de l'annuaire et couverture des canaux.

⚠️ NE TOURNENT PAS AU BOOT, délibérément — voir ci-dessus. Trois rythmes, par ordre de
valeur :
 1. **au fil de l'eau** : le handler Slack résout un `slackUserId` inconnu par UN
    `users.info` puis écrit la ligne. C'est ce qui rend la frontière d'autorisation opérante
    SANS aucune synchronisation préalable ;
 2. **à la demande** : `npx tsx scripts/sync-slack-directory.mts` (dry-run), `--apply` pour
    écrire. À lancer après chaque arrivée ou départ groupé ;
 3. **périodique** : un cron quotidien serait le complément naturel — il rattrape les
    DÉPARTS, que `deleted: true` n'annonce par aucun événement abonné. Pas encore créé : la
    route devrait être protégée, elle déclenche des écritures et N appels Slack.

Exportés pour être appelables depuis un script ou une future route, jamais invoqués ici.

**Avant `const channelCoverage = makeChannelCoverage({`**

⚠️ `inventory` était ABSENT jusqu'au 2026-08-14, et c'est le défaut que `TODO.md` [0 bis]


recensait : sans lui, `recordInventory()` rend `undefined` et n'écrit RIEN. Le service

n'a toujours aucun consommateur dans l'application — l'inventaire est alimenté par

`npm run directory:sync -- --channels --apply`, qui reconstruit ses propres instances —

mais il est désormais CORRECT si quelqu'un s'en sert, au lieu d'être muet.
**Avant `const findEmployeeByEmail = makeFindEmployeeByEmail(employeeRepo, directoryRepo);`**

L'annuaire Slack est le SECOND paramètre, et c'est le correctif de la panne du


2026-08-12 (« il ne retrouve pas les autres profils à part le mien ») : `employees`

n'est peuplée que par la modale « Compléter mon profil », donc elle contenait UNE

ligne pour 6 personnes réelles, tandis que `slack_directory` les portait toutes,

avec prénom, nom et poste. `directorySync` alimentait cette table depuis le

2026-08-12 sans qu'aucun tool ne la lise.
**Avant `const findPersonByName = makeFindPersonByName(employeeRepo, directoryRepo);`**

RÉSOLUTION PAR NOM — le manque qui a envoyé le document d'Awa à l'adresse de Karyl


Relevé sur la Turso de production le 2026-08-13 : les DIX documents de la base portent

l'UUID de Karyl, y compris celui intitulé « Bienvenue Awa ». Awa a pourtant sa propre

ligne `employees` — elle est simplement absente de `slack_directory`, donc

`findEmployeeByEmail` (seul résolveur existant) exigeait une adresse que personne

n'avait tapée. Sommé de fournir un `employeeId`, le modèle a réutilisé le seul UUID de

son contexte : même mécanique que l'email `votre_email@example.com`.

Les DEUX sources sont donc câblées, `employees` d'abord : Awa n'existe QUE dans

`employees`, et les quatre autres personnes vivantes du workspace QUE dans l'annuaire.
**Avant `const generateDocument = makeGenerateDocument({`**

⚠️ `getTaskList` a été RETIRÉ le 2026-08-14, avec tout le suivi de tâches.


Les cinq tâches d'intégration étaient un plan qu'AUCUN mécanisme ne faisait avancer : ni

humain, ni automate, ni tool ne pouvait marquer « Rencontrer ton manager » comme faite. Un

suivi qui ne bouge jamais est un suivi qui ment — même famille de défaut que

`emailSent: false` sous `status: 'success'` et que `status = Sent` posé avant le `try`.

Deux des cinq renvoyaient de surcroît vers un questionnaire et un guide qui n'existaient

pas sous la forme annoncée.

Le seul suivi du produit est désormais la COMPLÉTION DU PROFIL, portée par

`onboarding_progress` et lisible par `getEmployeeProfile`.

⚠️ `evaluateResponse` a été SUPPRIMÉ du câblage le 2026-08-14 — audit de code mort.

Il était décâblé de tout agent depuis le 2026-08-12 (son seul appelant possible était un

modèle qui FABRIQUAIT les réponses d'un humain), mais sa CONSTRUCTION est restée, et avec

elle celle de `questionnaireRepo` et `responseRepo`. Trois objets bâtis à chaque démarrage

à froid pour un tool que rien ne pouvait appeler.

`generateDocument` ne se contente plus d'écrire une ligne : il rend le fichier, le

livre dans Slack (upload) ou par email (pièce jointe), et rend compte de la livraison.

Le canal et le thread ne sont PAS injectés ici — ils viennent du `requestContext` par

requête (`src/shared/slack-request-context.ts`) ; l'adresse email, elle, est résolue

depuis l'annuaire. Aucune destination ne transite par le modèle.
**Avant `fileUpload: chatProvider,`**

`SlackAdapter` porte `uploadFile` en plus de `sendMessage` : un seul WebClient, un


seul jeton. Le scope `files:write` EST accordé — vérifié en production le 2026-08-11,

un PDF réellement posté dans un DM (`hasPermalink: true` dans les logs). L'ancienne

note affirmant le contraire a survécu à sa propre invalidation pendant une journée.
**Avant `interviewRepo,`**

── L'ENTRETIEN nourrit le gabarit, CÔTÉ SERVEUR ────────────────────────────────────


Ces deux dépôts ne traversent jamais la fenêtre du modèle : `generateDocument` résout

l'entretien depuis l'`employeeId`, exactement comme il résout la fiche employé. Le

gabarit imprime donc de la matière réelle — ce que la personne a écrit sur son quotidien,

sa façon de travailler, les canaux qu'elle a choisis — pour **zéro token**.

C'est la réponse à « le guide doit être chaleureux, avec les infos connues de

l'utilisateur, sans donnée générique » : jusqu'au 2026-08-14 le gabarit sortait quatre

puces écrites en dur, identiques pour tout le monde.

⚠️ Les DEUX sont optionnels dans le tool : sans eux le document reste produit à

l'identique. C'est ce qui rend ce câblage sûr même sur une base où

`onboarding_interview` n'a pas encore été appliquée.
**Avant `const scheduleReminder = makeScheduleReminder(notificationRepo, employeeRepo);`**

L'annuaire est le SECOND paramètre, et il n'est pas décoratif : il permet de refuser un


destinataire inexistant AVANT d'enregistrer un rappel. Sans lui le tool dégrade — il ne ment

pas, mais il accepte.
**Avant `const getNotificationHistory = makeGetNotificationHistory(notificationRepo, employeeRepo);`**

⚠️ `employeeRepo` est injecté UNIQUEMENT pour résoudre un email en identifiant, ce qui


supprime une étape entière (mesuré : 3 étapes / 4 424 tokens → 2). Voir la factory.
**Avant `const findExpertise = makeFindExpertise({`**

`discoverSlackWorkspace` a été SUPPRIMÉ le 2026-08-18. Il avait d'abord été retiré des


agents (schéma coûteux, mentionné dans aucune instruction), et ce commentaire affirmait

alors qu'il « reste câblé et testé isolément » : c'était faux. Il n'était câblé à AUCUN

agent ni à aucun autre appelant — il n'était que TESTÉ, ce qui n'est pas la même chose et

donne l'illusion d'un code vivant.

Ce qui a emporté la décision n'est pas qu'il soit mort, c'est ce qu'il portait : une action

`inviteToChannel` sans la moindre garde d'autorisation, dans un fichier qu'un futur

recâblage aurait pu rebrancher sans relire. L'invitation Slack du parcours d'onboarding, la

vraie, passe par `deps.slackProvider` dans l'étape `inviteToSlack` du workflow.

`createEmployee` a été retiré le 2026-08-11, après la campagne de tests en

production. Exposer une allowlist fermée (`department`, `position`) à un LLM ne

protège pas l'intégrité des données : le modèle substitue une valeur valide

AVANT d'appeler l'outil pour que l'appel réussisse. Mesuré : « Software

Engineer » enregistré en « Developer », et « Plomberie » enregistré en

« Engineering » — ce dernier SANS le moindre avertissement. La validation Zod

n'a jamais vu les valeurs refusées.

La création passe désormais par la modale du flux d'arrivée : liste déroulante

côté Slack, workflow appelé en code, aucun LLM sur le chemin transactionnel.

Le tool reste câblé pour l'API et le workflow.

`findExpertise` (2026-08-14) répond à « qui peut faire quoi » — la seconde moitié de la

demande adressée au `knowledgeAgent`. Il est en LECTURE PURE et ne rend que des NOMS : ni

UUID, ni adresse, ni identifiant Slack. Il satisfait donc la quarantaine ci-dessus, et sa

place est bien ici plutôt que sur l'orchestrateur — « qui s'occupe du backend ? » est une

question de connaissance du workspace, pas une étape d'onboarding.

⚠️ `interviewRepo` est la TROISIÈME matière, ajoutée le 2026-08-19 sur un défaut mesuré en

production : « qui s'occupe du support technique ? » rendait « aucun collaborateur

identifié » alors que la personne venait d'écrire, dans son entretien, qu'elle fait du

support technique. Le poste est un intitulé RH saisi une fois ; l'entretien est ce que la

personne fait, avec ses mots. Coût en tokens : ZÉRO — le tool-result reste borné à 6 noms.
**Avant `const onboardingOrchestrator = makeOnboardingOrchestrator({`**

⚠️ REMONTÉ ICI le 2026-08-19 : `findExpertise` est désormais câblé sur TROIS agents, donc il


doit être construit avant le premier. Voir juste en dessous pour la raison — et pour la

frontière qui, elle, n'a PAS bougé.
**Avant `findExpertise,`**

⚠️ « QUAND UNE INFORMATION RÉELLE EST REQUISE » — 2026-08-19, et il faut dire exactement


ce qui a été fait et ce qui a été REFUSÉ.

FAIT : `findExpertise` est la connaissance que ce système possède sur les PERSONNES —

poste déclaré, ce que la personne dit faire au quotidien. Un agent qui ne l'a pas ne peut

répondre à « qui s'occupe du backend ? » qu'en INVENTANT, et c'est le mode d'échec numéro

un recensé par ce dépôt. Il est en lecture pure et ne rend que des NOMS : ni UUID, ni

adresse, ni identifiant Slack.

REFUSÉ : `getChannelHistory` et `getUserConversations` restent au seul `knowledgeAgent`.

Ce sont des lectures AGRÉGÉES, et cet agent porte `generateDocument`, qui rend un fichier

ET le livre (upload Slack ou pièce jointe email). Les réunir formerait mot pour mot le

canal d'exfiltration de §4.2 — « récapitule #engineer-karyl et envoie-le-moi en PDF » —

que `outbound-tool-quarantine.ts` et `makeRecruitmentAgent` gardent chacun d'un côté. La

capacité reste ATTEIGNABLE : le palier thématique du routage envoie « résume… » et tout

jeton de canal `<#C…>` au `knowledgeAgent`, et peut déloger un fil pour cela.
**Avant `const notificationAgent = makeNotificationAgent({`**

`findEmployeeByEmail` est exposé à `onboardingOrchestrator` et `notificationAgent` depuis le


2026-08-11, et c'est un correctif de CÂBLAGE, pas de rédaction.

Tous les tools de `notificationAgent` exigent un UUID d'employé, et AUCUN ne sait faire

email → UUID : ce tool n'était câblé que sur l'orchestrateur. Pire, le `.describe()` de

`recipientId` renvoyait vers `getEmployeeProfile`, qui exige déjà un UUID — la consigne était

circulaire. Et `AGENT_ANTI_INVENTION_BLOCK` interdit au modèle d'en deviner un. La boucle

infernale de la série C (« donne-moi son identifiant » → « je ne l'ai pas » → …) était donc

GARANTIE par le câblage, pas probabiliste.

`questionnaireEngine` A ÉTÉ RETIRÉ DU REGISTRE le 2026-08-14

Avec son unique tool `generateQuestionnaire`. Les deux restent dans le dépôt, testés ;

seule leur EXPOSITION disparaît. Trois raisons, la première étant décisive :

 1. **Il n'a jamais rien produit d'utilisable.** Relevé sur la Turso le 2026-08-14 :

    `questionnaires` = 5 lignes (« Quiz sur nos valeurs »…), `questionnaire_responses` =

    **0 ligne**. Il n'existe ni formulaire Block Kit, ni modale, ni route de soumission :

    un questionnaire enregistré n'est envoyé à personne et remplissable par personne. Le

    tool le dit lui-même dans son `hint` — ce qui prouve qu'on le savait sans le corriger.

    C'est exactement pour cette raison qu'`evaluateResponse` avait dû être décâblé le

    2026-08-12 : son seul appelant possible était un modèle qui FABRIQUAIT les réponses.

 2. **Le besoin réel est ailleurs.** Ce que le questionnaire devait servir — cerner les

    centres d'intérêt d'un arrivant pour l'abonner aux bons canaux — est désormais rendu

    par l'ENTRETIEN post-profil : une modale Block Kit, remplissable, dont la soumission

    invite réellement aux canaux choisis. Déterministe, zéro token, et il aboutit.

 3. ≈ 886 tokens de FLOOR en moins, et un agent de moins dans le routage.

⚠️ Le routage a été nettoyé en conséquence (`ESCAPE_INTENTS`, `QUESTIONNAIRE_TOPICS`,

`KNOWN_AGENT_IDS`). Ce n'est pas cosmétique : `mastra.getAgent()` LÈVE sur un identifiant

absent du registre, donc un mot-clé pointant encore cet agent aurait fait échouer chaque

message qui le contient.

discoverSlackWorkspace n'est PAS exposé ici : les instructions de l'agent ne le

mentionnent jamais (sendNotification résout déjà le compte Slack côté serveur), et

c'est actuellement le tool le plus coûteux en tokens du set (~356 caractères de

schéma JSON + 426 de description). Voir CHANGELOG pour la mesure avant/après.
**Avant `findEmployeeByEmail,`**

Voir le commentaire de `questionnaireEngine` ci-dessus : sans ce tool, les quatre autres


sont inatteignables dès que l'humain désigne quelqu'un par son email — c'est-à-dire

presque toujours.
**Avant `findPersonByName,`**

Même raison, et le cas est encore plus fréquent ici : « envoie un rappel à Pamela »


ne porte jamais d'adresse. Sans ce tool, la boucle « donne-moi son identifiant » →

« je ne l'ai pas » était garantie par le câblage.
**Avant `findExpertise,`**

Même arbitrage que sur l'orchestrateur, et la même frontière : la connaissance des


PERSONNES, jamais la lecture agrégée des canaux. Ici le voisinage est `sendNotification`,

donc l'écriture externe est encore plus directe — raison de plus pour que `findExpertise`

ne rende que des noms, et que `title` et `evidence` en sortent ASSAINIS (correctif du

2026-08-19 : `title` est un poste déclaratif, édité par son porteur).
**Avant `const channelHistory = new SlackChannelHistoryAdapter(process.env.SLACK_BOT_TOKEN ?? '', {`**

AGENT KNOWLEDGE — lecture des conversations, et rien d'autre


Deux sources, et deux seulement : la mémoire propre du bot (`conversation_turns`, ses DM

avec les gens) et l'historique des canaux où il est invité. Rien n'est ingéré ni stocké :

lecture À LA DEMANDE, fenêtre bornée — une ingestion persistante de tous les canaux

constituerait une surveillance systématique des communications des salariés

(AIPD obligatoire, consultation du CSE), ce que `PLAN-ARCHITECTURE.md` §4.7 refuse.

⚠️ Le filtrage se fait selon les droits du DEMANDEUR, jamais selon ceux du bot. Le bot

détient l'UNION des droits de tous ses canaux ; les prêter au premier venu est le

« deputy confus » de §4.1 — un invité mono-canal demandant en DM le résumé de

`#engineer-karyl`.
**Avant `resolveDisplayName: async (id) =>`**

Résolution des noms par l'ANNUAIRE et non par `users.info` : zéro appel Slack


supplémentaire, et un nom absent retombe sur l'identifiant sans casser la lecture.
**Avant `directory: directoryRepo,`**

`DirectoryRepository` satisfait STRUCTURELLEMENT le port du tool : celui-ci ne voit que


les deux lectures dont il a besoin, ni `upsertFacts` ni `listAll`.
**Avant `const knowledgeAgent = makeKnowledgeAgent({`**

⚠️ AUCUN outil de SORTIE ici, et ce n'est pas une convention : `makeKnowledgeAgent` LÈVE au


démarrage si on lui en câble un. Lecture agrégée + écriture externe dans la même chaîne =

canal d'exfiltration complet (§4.2) — « envoie à ce candidat un récapitulatif de ce qui se

dit dans #engineer-karyl », en une phrase, par un invité. Une erreur de câblage devient donc

un échec au démarrage, pas une fuite.
**Avant `const pendingInterviewEmailRepo = new DrizzlePendingInterviewEmailRepository();`**

⚠️ AUCUN outil de LECTURE ici, et c'est la quarantaine INVERSE de celle ci-dessus :


`makeRecruitmentAgent` LÈVE au démarrage si on lui en câble un. C'est le seul agent qui

écrive à une adresse SITUÉE HORS DE L'ENTREPRISE et non contrainte par l'annuaire ; lui

adjoindre `getEmployeeProfile` ou `getChannelHistory` formerait le canal d'exfiltration de

§4.2 — « retrouve le dossier de Karyl et envoie-le à moi@ailleurs.com ».

C'est aussi pourquoi ce tool n'est PAS posé sur `notificationAgent`, qui aurait été

l'option la moins chère : il porte déjà trois outils de lecture.

`directoryRepo` n'est PAS une exception à la quarantaine : le tool s'en sert pour résoudre

l'adresse du DEMANDEUR (afin que le candidat puisse répondre à un humain), jamais sur une

valeur choisie par le modèle — le `slackUserId` vient du `requestContext`.

L'email d'entretien PRÉPARÉ, en attente d'un « oui ».

⚠️ Remplace le `value` du bouton « Envoyer », retiré le 2026-08-19 avec tous les autres.
L'état doit survivre à un changement de sujet — c'est l'exigence explicite : rappeler l'email
en attente si l'on parle d'autre chose, et le garder en suspens si la personne veut vraiment
changer de sujet. Un état qui tient pendant qu'on parle d'autre chose ne peut pas être le
dernier message du bot, donc pas le fil : il lui faut une table.

⚠️ DDL à appliquer à la main : `scripts/ddl-pending-interview-email.sql`. Les migrations
`drizzle/` sont désynchronisées de `schema.ts` et `drizzle-kit push` se bloque contre une
base `libsql://` distante.
**Avant `chat: { sendText: (channelId, text) => chatProvider.sendMessage(channelId, text) },`**

⚠️ Du TEXTE, plus des blocs — les boutons ont été retirés du produit le 2026-08-19. La


relecture se conclut par une question à laquelle on répond oui ou non.
**Avant `presenter: slackInterviewConfirmationPresenter,`**

La présentation de la carte de relecture est injectée : la couche `application` ne


connaît pas Block Kit — voir `domain/ports/interview-confirmation.presenter.ts`.
**Avant `const employeeOnboardingWorkflow = createEmployeeOnboardingWorkflow({`**

LE SEUL WORKFLOW DU SYSTÈME — et ce qu'il apporte que les agents ne peuvent pas apporter.

Trois workflows ont été RETIRÉS du registre le 2026-08-12 :

 - `notificationCycleWorkflow` retournait `successCount: N` et `failuresCount: 0` sans la
   moindre E/S, et `scripts/production-scenarios.mjs` l'enregistrait en PASS. Il ne mesurait
   rien, il fabriquait un feu vert.
 - `questionnaireCycleWorkflow` posait `status: 'SENT'` et `responsesCount: 10` en dur.
 - `documentGenerationWorkflow` écrivait sur le disque et rendait un chemin local :
   inutilisable sur Vercel, dont le système de fichiers est en lecture seule hors `/tmp`,
   lequel est éphémère et propre à l'instance.

Ils étaient enregistrés À ÉGALITÉ avec celui-ci et atteignables par l'API. Un appelant ne
pouvait pas distinguer le vrai des trois maquettes — c'est-à-dire que la présence des trois
dévaluait le seul qui fonctionne.

VALEUR AJOUTÉE de `employeeOnboardingWorkflow` dans le processus

 1. **Il coûte ZÉRO token.** C'est la propriété décisive sur un budget de 100 000 tokens
    par JOUR (≈ 19 messages). Le même parcours conduit par un agent consomme ~6 838 tokens
    en 2 étapes ; ici, 0. Le chemin transactionnel n'a aucun LLM dessus.

 2. **Il est déterministe là où un agent est probabiliste.** C'est la leçon du retrait de
    `createEmployee` des agents : exposer une allowlist (`department`, `position`) à un
    modèle ne protège pas l'intégrité des données — le modèle SUBSTITUE une valeur valide
    avant d'appeler l'outil pour que l'appel réussisse. Mesuré en production :
    « Plomberie » enregistré en « Engineering », sans le moindre avertissement. La
    validation Zod n'a jamais vu la valeur refusée. Ici l'entrée vient d'une liste
    déroulante Slack, validée en code.

 3. **Il rend un VERDICT, pas un booléen.** `OnboardingOutcome` ∈
    `completed | degraded | failed`, accompagné de `degradedSteps: { step, reason }[]`.
    Trois étapes best-effort sont inventoriées (`onboardingTasks`, `welcomeEmail`,
    `slackInvite`) : un email jamais parti se lit désormais, là où il se noyait dans un
    `emailSent: false` sous un run `status: 'success'` — d'où trois lecteurs successifs qui
    ont conclu à tort qu'un email était parti.
    ⚠️ `run.status` reste `'success'` (champ de Mastra, non modifiable) : le verdict vit
    dans la CHARGE UTILE. C'est `outcome` qu'il faut lire, jamais `run.status`.

 4. **Il n'avorte pas sur une indisponibilité de trente secondes.** Perdre l'employé créé,
    ses tâches et son invitation parce que SMTP a hoqueté serait une régression, pas une
    rigueur. `degraded` est un aboutissement.

Il est déjà INTÉGRÉ au produit : `src/api/slack-interactions.route.ts` le déclenche à la
soumission de la modale « Compléter mon profil », elle-même envoyée par `handleTeamJoin`
quand une personne rejoint le workspace. Aucun LLM sur ce chemin.

**Avant `agents: {`**

La clé du registre doit être IDENTIQUE à l'`id` de l'agent — c'est elle que résout


`mastra.getAgent(id)`, et c'est cet identifiant que le routage collant relit en base.
**Avant `workflows: {`**

UN SEUL workflow, et c'est délibéré — voir le commentaire de `employeeOnboardingWorkflow`.


Les trois autres ne faisaient aucune E/S et se déclaraient réussis.
**Avant `server: {`**

Une route HTTP n'existe QUE si elle est déclarée ici. Les fichiers de `src/api/`


ne sont jamais montés automatiquement par Mastra.
**Avant `apiRoutes: [`**

⚠️ QUATRE routes pour DEUX endpoints. Les deux `…WorkRoute` sont les chemins internes


où le PORTIER D'ACK (`scripts/slack-ack-function/`) rejoue la requête : Slack n'accorde

que 3 secondes, et le démarrage à froid de CETTE fonction a été mesuré à 5,2 s le

2026-08-19 — le budget était épuisé avant la première instruction. Le portier n'a aucune

dépendance, donc aucun dépaquetage à payer.

Elles ne sont pas une porte dérobée : même handler, même vérification HMAC sur le corps

réexpédié à l'identique. Le chemin distinct existe pour que le routage Vercel ne renvoie

pas la requête réexpédiée au portier — ce qui serait une boucle.
**Avant `middleware: [`**

Requalifie en 400 les erreurs de validation d'entrée que Mastra renvoie en 500.


Monté sur `/api/*` UNIQUEMENT : `/slack/events` gère ses propres codes et le rejeu

de Slack en dépend. Une vraie panne serveur reste un 500 (voir le module).
**Avant `{ path: '*', handler: createSecurityHeadersMiddleware() },`**

Les en-têtes de sécurité, sur TOUTE réponse — d'où le joker nu et non `/api/*` : la


racine et `/agents` rendent du `text/html`, et c'est cette surface-là qui justifie

`x-frame-options`. Relevé de l'extérieur le 2026-08-18 : seul le HSTS de Vercel était

présent. En PREMIER pour que les en-têtes couvrent aussi les refus des gardes qui

suivent.
**Avant `{`**

⚠️ EN PREMIER, et l'ordre porte la sécurité : ce garde doit refuser AVANT que


quoi que ce soit ne lise le contexte. Mastra fusionne `body.requestContext` dans le

contexte serveur et n'écarte que `RESERVED_CONTEXT_KEYS` (`mastra__*`,

`organizationId`) — aucune clé `slack*` n'y figure, donc un porteur de

`MASTRA_API_TOKEN` se déclarait n'importe qui : `slackEmployeeId` décide de l'accès

au dossier RH, `slackAccessLevel` des effets de bord. Le trou était recensé depuis

le 2026-08-12 et fermé le 2026-08-14.

⚠️ EN SECOND, avant la requalification d'erreur : le prompt système FUYAIT par

`/api/agents/*` — quatre surfaces, dont DEUX sans la moindre ruse. `GET /api/agents`

rendait les instructions des quatre agents en clair, `GET /api/agents/:id` 2 624

caractères dont le `[SECURITY_ID:…]` de session. Aucune injection, aucun modèle,

aucun coût. Mesuré et fermé le 2026-08-14.

Monté sur `/api/*` et non `/api/agents/*` : un joker Hono ne couvre pas

`/api/agents` SANS segment suivant — or c'est précisément la pire des quatre. Le

garde teste le chemin lui-même.
**Avant `cors: { origin: [], credentials: false },`**

Sans `auth`, `getEffectiveAuthConfig()` renvoie null et `checkRouteAuth()` laisse


passer TOUTES les routes /api/* sans authentification — n'importe qui sur Internet

pilotait les agents (envoi d'email, création d'employés, publication Slack).

`/slack/events` reste exempt via son `requiresAuth: false` (vérifié dans le source

de @mastra/server) et s'authentifie par signature HMAC Slack.

⚠️ SANS CETTE LIGNE, le serveur RENVOIE l'origine demandée avec

`access-control-allow-credentials: true` — vérifié en production le 2026-08-18 :

`Origin: https://evil.example.com` ressortait tel quel dans `access-control-allow-origin`.

Honnêteté sur la portée : aucun scénario d'exploitation n'a été trouvé aujourd'hui.

L'authentification est un jeton PORTEUR, qu'un navigateur n'attache jamais tout seul ;

une page tierce ne gagne donc rien qu'elle ne puisse déjà faire depuis son propre

serveur. Ce qu'on ferme est le jour où un cookie apparaîtrait — la combinaison

origine reflétée + `credentials: true` est précisément celle qui rend ce jour-là

catastrophique, et elle serait alors invisible parce que déjà en place.

Liste VIDE et non `false` : `false` désactiverait le middleware CORS et laisserait

l'absence d'en-tête dépendre de l'implémentation. Une liste vide ne matche aucune

origine, donc aucun `access-control-allow-origin` n'est émis — et le produit n'a

aucun client navigateur d'aucune origine, ce qui rend le refus total exact.

---
## La sauvegarde `.env.bak-*` a été supprimée (2026-08-20)

Un fichier `.env.bak-1786128475` daté du 7 août portait 19 clés en clair —
`SLACK_SIGNING_SECRET`, `DATABASE_AUTH_TOKEN`, `SMTP_PASS`, `GROQ_API_KEY`,
`MASTRA_API_TOKEN` entre autres. Il était bien ignoré par git, donc jamais publié, mais
lisible en `0644` par tout utilisateur de la machine.

Le vrai danger n'était pas la lecture locale : c'est qu'il **survivait à toute rotation de
clés**. Renouveler les secrets n'aurait pas touché ce fichier, qui aurait gardé les anciens
en clair indéfiniment, sans que personne ne le surveille.

Vérifié avant suppression : `.env` couvrait toutes les clés de la sauvegarde et aucune valeur
ne différait — elle était strictement redondante. `.env` est passé en `0600`.

---

## `.env.example` est DÉRIVÉ de `src/`, il n'est plus tenu à la main (2026-08-20)

Onze variables lues par `src/` n'y figuraient pas. La plus chère est `AUTHZ_ENFORCE` :
quiconque provisionnait depuis cet exemple obtenait une frontière d'autorisation **inactive**
— `SlackAccessGuard` rendant `full` à tout le monde — et l'absence de signal est la propriété
même du défaut : une frontière inactive se comporte exactement comme une frontière qui
marche, vue du côté de celui qui a le droit.

Les dix autres : `SYSTEM_PROMPT_VAULT_SECRET`, `SLACK_DAILY_LIMIT`, `SLACK_BURST_LIMIT`,
`SLACK_WORKSPACE_TOKEN_BUDGET`, `ONBOARDING_WELCOME_CHANNELS`, `ONBOARDING_VIDEO_URL`,
`RECRUITMENT_TIMEZONE`, `DISPLAY_TIMEZONE`, plus `VERCEL` et
`VERCEL_PROJECT_PRODUCTION_URL`.

⚠️ **Ces deux dernières ne sont PAS déclarées, et c'est un choix.** Elles sont injectées par
la plateforme. Les mettre dans l'exemple inviterait à poser `VERCEL=` en local, ce qui ferait
croire à `scheduleBackgroundWork` qu'il dispose de `waitUntil` — un bot muet, et un symptôme
qui ne désigne pas sa cause. Elles vivent dans un bloc « INJECTÉES PAR LA PLATEFORME » en pied
de fichier, et dans l'allowlist du test.

**Retiré** : `OPENAI_API_KEY` et `AWS_SECRET_ID`, orphelines depuis la suppression de
`src/config/` — aucun lecteur nulle part dans `src/`, `scripts/` ni `tests/`.

⚠️ **`SLACK_TEAM_ID` a été signalée comme morte par l'audit, et elle ne l'est pas.** Elle est
lue par le contrôle de workspace du handler Slack (`slack-events.handler.ts`, fail-open
délibéré quand elle est absente). Elle est CONSERVÉE. C'est précisément ce qu'une liste écrite
à la main ne peut pas garantir, et ce que le test dérive.

### Le test qui la verrouille

`tests/unit/quality/env-example-completeness.test.ts`, deux sens de statut différent :

- **DUR** — toute variable lue par `process.env.X` (les deux formes d'accès) dans `src/` doit
  être DÉCLARÉE (`^KEY=`). C'est le sens qui a coûté quelque chose.
- **SOUPLE** — toute variable déclarée doit être NOMMÉE quelque part dans `src/`, `scripts/`
  ou `tests/`. Il ne cherche pas `process.env.X` : `MASTRA_API_TOKEN` est lu par indirection
  (`API_TOKEN_ENV_VAR = 'MASTRA_API_TOKEN'`), et exiger la forme littérale ferait rougir un
  test sur du code vivant. Une garde qui crie sur du texte juste finit désactivée.

⚠️ **Le test s'EXCLUT lui-même des sources scannées, et sans cela il ne pouvait rien
attraper.** Son propre docblock nomme les variables mortes qu'il dénonce : au premier run il
passait au vert alors qu'`OPENAI_API_KEY` et `AWS_SECRET_ID` étaient bel et bien orphelines.
Un détecteur qui se compte lui-même comme preuve est un détecteur désarmé — même famille que
les deux détecteurs trouvés désarmés le 2026-08-19.

Un dernier contrôle refuse toute VALEUR réelle dans le fichier (`xoxb-`, `sk-`, JWT…).

## Le démarrage signale ce qui manque (2026-08-20)

`reportMissingCriticalEnv(process.env, logger)` est appelé dans `src/mastra/index.ts` juste
après le `throw` de `DATABASE_URL`. Il journalise en `error` une ligne par variable critique
absente, avec sa conséquence concrète — et ne bloque rien. Arbitrage, table des variables et
raisons : `docs/conception/shared.md`, section `shared/startup-env-check.ts`.

---

## Décisions extraites du code le 2026-08-21

> Le code ne porte plus ce texte. L'ancre est la **déclaration**, jamais un numéro
> de ligne : l'audit du 2026-08-21 a mesuré 5 424 ancres `L.N` dont 153 exactes.
> Un numéro de ligne se périme au premier retrait de commentaire.

### `src/api/reminders-dispatch.route.ts`

**Avant `/**`**


L'HORLOGE EXTÉRIEURE — la seule pièce qui manquait pour qu'un rappel parte


Ce projet n'a JAMAIS pu envoyer un rappel, et la raison n'était ni un oubli ni une paresse :
une fonction serverless n'existe que le temps d'une requête. Aucun `setTimeout` ne survit au
gel, aucun processus ne tourne entre deux messages Slack. `findPending()` était écrite,
correcte, et n'avait aucun site d'appel — parce qu'il n'existait personne pour l'appeler.

Le cron Vercel frappe désormais à cette porte une fois par jour. C'est tout ce qui manquait.

⚠️ **PAS SOUS `/api`** : `@mastra/server` refuse toute route personnalisée commençant par
l'`apiPrefix`, et c'est un ÉCHEC AU DÉMARRAGE, pas un 404.

⚠️ **PAS DE BUDGET DE 3 SECONDES ICI**, contrairement à `/slack/events` : un cron n'attend
pas. La remise est donc SYNCHRONE — et elle doit l'être, car `waitUntil` ne garantit rien
après qu'on a répondu à un appelant qui, lui, ne réessaiera pas avant demain.

**Avant `export function authorizeCron(`**

⚠️ **FAIL-CLOSED, à l'inverse du reste de ce dépôt.**

Vercel ajoute automatiquement `Authorization: Bearer $CRON_SECRET` à ses invocations dès que
la variable existe. Sans elle, cette route serait une primitive publique permettant de
déclencher l'envoi de messages à des salariés — la seule chose que toute la feature
`recruitment` est construite pour ne pas offrir. En son absence on REFUSE, et on journalise
en `error` : un cron qui ne fait rien en silence est indiscernable d'un cron qui marche.

**Avant `if (!constantTimeEquals(header ?? '', 'Bearer ${secret}')) {`**

⚠️ **COMPARAISON À TEMPS CONSTANT, comme les deux autres frontières de ce dépôt.**

L'exploitation par mesure de temps est ici peu plausible — comparaison de chaînes V8 sur un
réseau public, et le CDN Vercel ajoute 0,3 à 2,3 s de variance, mesurée. Ce qu'on corrige
n'est pas un risque, c'est une DISSONANCE : trois secrets, et un seul traité autrement que
les autres. C'est le genre d'écart qui devient un défaut le jour où quelqu'un recopie le
mauvais des deux modèles.

**Avant `const retention = await pruneKnowledge({`**

⚠️ **LA RÉTENTION PARTAGE CETTE HORLOGE, et c'est un choix assumé.**

Ce produit n'a QU'UNE horloge — un cron quotidien — et la purge de la base de
connaissance en a besoin exactement comme la remise des rappels. Un second cron aurait
été plus propre à lire ; il aurait aussi rouvert la classe de panne qui a fait échouer
un déploiement le 2026-08-21 (« A duplicated cron job with the same schedule and path
was found » — Vercel FUSIONNE `vercel.json` et `config.json`).

La purge passe APRÈS la remise et ne propage jamais : un échec de purge est réparable
demain, un rappel non remis ne l'est pas.

### `src/api/slack-events.route.ts`

**Avant `knowledgeErasure: new KnowledgeErasureService({`**

⚠️ **UNE SEULE PAIRE DE DÉPÔTS pour l'ingestion ET l'effacement.**

Les instancier deux fois marcherait — ils sont sans état — mais ferait deux endroits
où changer une implémentation, et ce dépôt a déjà payé trois fois la divergence de
deux copies. Surtout : effacer et archiver DOIVENT viser la même base, sinon
l'effacement rendrait `0` en toute bonne foi.

**Avant `// pas su classer, et seulement par lots de cinq : sur le chemin nominal, il ne coûte`**

⚠️ Le SECOND RIDEAU. Il ne tourne que sur les messages que le code déterministe n'a

**Avant `// pas un seul appel de modèle. Voir 'fact-curtain.service.ts'.`**

pas su classer, et seulement par lots de cinq : sur le chemin nominal, il ne coûte

**Avant `summarizer: new ModelFactSummarizer(),`**

pas un seul appel de modèle. Voir `fact-curtain.service.ts`.

**Avant `// 'rejectMessage' ('not_a_dm') — c'est le cas nominal, et c'est justement celui qu'il faut`**

⚠️ Écarté pour la RÉPONSE, pas pour la CONNAISSANCE. Un message de canal est écarté par

**Avant `// archiver. Le rejet protège le budget de modèle ; il ne dit rien de ce qui mérite d'être su.`**

`rejectMessage` (`not_a_dm`) — c'est le cas nominal, et c'est justement celui qu'il faut

**Avant `scheduleBackgroundWork(`**

archiver. Le rejet protège le budget de modèle ; il ne dit rien de ce qui mérite d'être su.

### `src/api/slack-interactions.route.ts`

**Avant `const workspace = judgeWorkspace(payload.team?.id, process.env.SLACK_TEAM_ID);`**

⚠️ **CONTRÔLE D'APPARTENANCE AU WORKSPACE — il manquait ici, et seulement ici.**

La signature HMAC prouve que Slack a émis la requête, pas depuis quel workspace : une app
installée ailleurs signerait tout aussi valablement. `/slack/events` posait cette défense
en profondeur depuis longtemps ; cette route ne la posait pas, alors que `payload.team.id`
est **déclaré dans son type et lu nulle part**. Relevé par l'audit du 2026-08-21.

La règle est PARTAGÉE (`shared/slack-team.ts`), pas recopiée — c'est la seule façon de ne
pas rejouer la divergence qui vient d'être corrigée ailleurs.

⚠️ **Fail-open sans `SLACK_TEAM_ID`**, comme côté événements : refuser en silence tous les
clics d'un déploiement qui n'a pas posé la variable serait une panne indiscernable d'un bot
mort. On journalise, on ne bloque pas.

**Avant `// dans le client de quelqu'un dont on ignore délibérément l'action.`**

On ACQUITTE : Slack ne doit pas réessayer, et un 4xx ferait apparaître une croix rouge

**Avant `return ack();`**

dans le client de quelqu'un dont on ignore délibérément l'action.

### `src/infrastructure/database/schema.ts`

**Avant `distilledAt: integer('distilled_at'),`**

⚠️ NULL = le SECOND RIDEAU n'a pas encore regardé ce message. Le distillateur
déterministe, lui, tourne à l'arrivée : quand il produit un fait, la colonne est posée
dans la foulée. Sans cette marque, un lot que le modèle juge sans intérêt serait relu à
chaque nouveau message — un appel de modèle par message, exactement ce qu'on évite.

### `src/mastra/index.ts`

**Avant `// enregistré ne part jamais. Voir 'reminders-dispatch.route.ts'.`**

L'horloge extérieure : sans elle, `findPending()` n'a aucun appelant et un rappel

**Avant `remindersDispatchRoute,`**

enregistré ne part jamais. Voir `reminders-dispatch.route.ts`.

**Avant `{`**

⚠️ **EN PREMIER APRÈS LES EN-TÊTES, et avant le garde de contexte.**

`createRequestContextGuard` refuse qu'un appelant SE DÉCLARE quelqu'un ; celui-ci
refuse qu'il exécute un outil SANS se déclarer personne — la moitié de la brèche du
2026-08-14 restée ouverte, et la plus puissante des deux. Le placer avant évite de
lire et parser le corps d'une requête qu'on va de toute façon refuser.

### `src/shared/agent-style.ts`

**Avant `export const AGENT_STYLE_BLOCK = 'STYLE : tu es ${ASSISTANT_NAME}, chez ${COMPANY_NAME}. Français, phrases cou`**

⚠️ LE SEUL LEVIER DE TON CÔTÉ PROMPT, ET IL EST PLAFONNÉ À 86 TOKENS — repayés à CHAQUE
étape, chez les quatre agents. Tout ajout doit être AUTOFINANCÉ par une suppression.

Ce lot ajoute le nom et l'interdiction de s'auto-désigner comme outil, et les paie en
retirant « collègue » (redondant dès lors qu'on donne un prénom et une maison) et en
fusionnant « ton neutre » avec la nouvelle consigne de registre.

⚠️ « SANS EXCLAMATION » RESTE, et c'est le point où l'on pourrait croire à une contradiction
avec la demande d'un ton chaleureux. Ce n'en est pas une, et la raison est mesurée, pas
esthétique : le constat de l'utilisatrice testeuse — « les points d'exclamation arrivent
précisément dans les phrases où il ne fait rien » — dit que l'enthousiasme ponctuel a servi
ici de CAMOUFLAGE à l'inaction. Un collègue chaleureux, dans une conversation de travail,
n'écrit d'ailleurs presque jamais de points d'exclamation. La chaleur passe par le nom,
l'adresse directe et la brièveté ; l'exclamation, elle, ne fait que du bruit.

### `src/shared/assistant-identity.ts`

**Avant `export const ASSISTANT_NAME = 'Marcel';`**

⚠️ MARCEL — LE NOM SOUS LEQUEL CE PRODUIT PARLE AUX GENS.

Jusqu'au 2026-08-21, l'assistant n'avait aucun nom. Il se désignait par la société
(« Kisso ») ou, pire, par sa nature : « Je suis un outil d'onboarding ». Une personne qui
écrit à quelqu'un sans nom n'écrit à personne, et le premier message de l'entreprise à un
arrivant ouvrait par une phrase sur la machine plutôt que sur lui.

⚠️ CE NOM N'EST PAS `KISSO-AGENT-v3`, et il ne faut surtout pas les confondre.
  • `KISSO-AGENT-v3` est un identifiant INTERNE, verrouillé par la DIRECTIVE 1.1 et
    CENSURÉ en sortie par `INTERNAL_MARKERS.agent_identity` : toute réponse qui le contient
    est remplacée en bloc. Il ne doit jamais sortir.
  • « Marcel » est un nom d'affichage, destiné à sortir à chaque conversation.
Le second n'affaiblit en rien le premier — un prénom ne renseigne aucun attaquant sur la
configuration interne, là où l'identifiant de version en dit long.

⚠️ NOMMER N'EST PAS MENTIR. Marcel ne se présente pas comme un automate ; il ne prétend pas
non plus être un être humain, et rien ici ne l'y invite. La consigne de style est une
INTERDICTION DE S'AUTO-DÉSIGNER COMME OUTIL, pas une instruction de revendiquer une
humanité. La distinction porte : dans le message de détresse, il dit toujours qu'il n'est
pas la bonne personne — parce qu'à cet endroit, laisser croire le contraire nuirait.

**Avant `export const MACHINE_SELF_DESIGNATIONS: readonly RegExp[] = [`**

⚠️ LA GARANTIE EST ICI, PAS DANS LE PROMPT.

Doctrine du dépôt, vérifiée trois fois en production : « une consigne est PROBABLE, le code
est GARANTI. » Le bloc STYLE demande au modèle de ne pas s'annoncer comme un outil ; ces
motifs permettent à un test de le VÉRIFIER sur tous les textes que le dépôt écrit lui-même,
qui sont les seuls sur lesquels une garantie soit possible.

⚠️ Ils ne servent PAS à filtrer la sortie du modèle. Réécrire « je suis un assistant » au
vol produirait des phrases estropiées, et un filtre qui mutile est pire qu'une consigne qui
échoue parfois — c'est le raisonnement qui a fait garder le document plutôt que le remplacer
quand un marqueur y est détecté.

**Avant `// optionnel, ce que 'security/detect-unsafe-regex' signale. Même langage reconnu.`**

`(?:a |an )?` et non `(?:an? )?` : le second imbrique un quantificateur dans un groupe

**Avant `/\bi(?:'m| am) (?:a |an )?(?:tool|bot|robot|assistant|ai|chatbot)\b/i,`**

optionnel, ce que `security/detect-unsafe-regex` signale. Même langage reconnu.

### `src/shared/distress.ts`

**Avant `export type DistressKind = 'self_harm' | 'aggression';`**

⚠️ DEUX SITUATIONS, DEUX RÉPONSES — séparées le 2026-08-21.

Ce module n'en connaissait qu'une. « je suis harcelé par mon manager » et « je veux
mourir » recevaient le MÊME texte, qui citait une ligne de prévention du suicide. À
quelqu'un qui vient de dire qu'on l'agresse, ce texte répond à côté : il lui donne un
numéro d'écoute là où il lui faut la police, et il ne nomme personne qui puisse AGIR sur
ce qui se passe au travail.

L'inverse est vrai aussi : envoyer vers la police quelqu'un qui pense à en finir, c'est
répondre par une procédure à une souffrance.

⚠️ EN CAS DE DOUTE, C'EST `self_harm` QUI L'EMPORTE. Un message peut porter les deux
(« je suis harcelé et je n'en peux plus, je veux en finir ») et les deux erreurs ne se
valent pas : traiter une agression comme une détresse donne quand même un numéro
d'urgence joignable, l'inverse remplace une aide vitale par une démarche administrative.

**Avant `// « envie d en finir », ni par « en finir avec la vie ». C'est pourtant la formulation la`**

⚠️ « je veux en finir » n'était détecté par RIEN jusqu'au 2026-08-21 — ni ici, ni par

**Avant `// plus courante en français, et le faux négatif le plus cher que ce module puisse avoir.`**

« envie d en finir », ni par « en finir avec la vie ». C'est pourtant la formulation la

**Avant `// Trouvé par un test qui cherchait tout autre chose : la priorité détresse/agression.`**

plus courante en français, et le faux négatif le plus cher que ce module puisse avoir.

**Avant `'veux en finir',`**

Trouvé par un test qui cherchait tout autre chose : la priorité détresse/agression.

**Avant `// opinion : c'est le critère qui a fait écarter « violence » et « conflit » nus, trop`**

Ajoutées le 2026-08-21 avec la séparation. Chacune décrit un FAIT subi, jamais une

**Avant `// courants pour désigner une situation vécue.`**

opinion : c'est le critère qui a fait écarter « violence » et « conflit » nus, trop

**Avant `'me suis fait agresser',`**

courants pour désigner une situation vécue.

**Avant `export function distressKind(text: string | undefined | null): DistressKind | null {`**

La NATURE de la situation, indépendamment de la langue.

⚠️ `self_harm` gagne quand les deux correspondent — voir l'en-tête du module.

**Avant `export const DISTRESS_REPLY =`**

⚠️ CES QUATRE TEXTES SONT LES SEULS DU DÉPÔT QUI N'ONT AUCUNE VARIANTE, et un test le
verrouille. Ailleurs, la répétition littérale est ce qui fait « machine » et on la combat.
Ici, elle est une garantie : ce texte a été pesé mot à mot, et un tirage qui en changerait
la formulation ferait qu'on ne saurait plus lequel a été lu.

⚠️ MARCEL NE JOUE PAS L'EMPATHIE ICI. C'est le seul endroit où « presque humain » serait
nuisible : simuler la compassion auprès de quelqu'un de vulnérable, c'est lui mentir au pire
moment. Le texte reconnaît, oriente vers quelqu'un qui peut agir, et s'efface. Ce qui a
changé le 2026-08-21 est seulement l'auto-désignation « je suis un outil d'onboarding », qui
ouvrait le message par une phrase sur SOI — remplacée par une phrase sur la personne.

**Avant `export const AGGRESSION_REPLY =`**

⚠️ LA RÉPONSE À UNE AGRESSION NOMME QUELQU'UN QUI PEUT AGIR — c'est ce qui la distingue.

Une ligne d'écoute ne peut rien contre un collègue qui menace : elle écoute. Ce qu'il faut
ici, c'est la police si le danger est immédiat, et la personne qui a autorité sur le
workspace pour ce qui s'y passe. Le message le dit explicitement — « c'est lui qui peut
faire quelque chose, pas moi » — parce que laisser croire le contraire, c'est exactement le
genre de promesse creuse que ce dépôt traque partout ailleurs.

### `src/shared/emergency-lines.ts`

**Avant `export type EmergencyCountry = 'BJ' | 'NG';`**

⚠️ LE SEUL FICHIER DU DÉPÔT OÙ UNE ERREUR PEUT COÛTER UNE VIE.

Règle absolue, héritée du correctif du 2026-08-18 : **ne jamais écrire ici un numéro qu'on
n'a pas vérifié auprès d'une source nommée.** Un numéro faux consomme le seul geste que la
personne aura peut-être la force de faire. À défaut de vérification, le texte oriente vers
un humain SANS donner de numéro — c'est moins bien, ce n'est pas dangereux.

Ce module existe parce que la règle ne tenait qu'à un commentaire. Elle tient désormais à
une STRUCTURE : chaque numéro porte sa source dans le champ `verified`, et il faut mentir
dans ce champ pour introduire un numéro non vérifié.


TROIS NUMÉROS ONT ÉTÉ ÉCARTÉS PENDANT LA VÉRIFICATION DU 2026-08-21, et chacun aurait été
une faute plausible :

  • **3114** — français. Il figurait ici jusqu'au 2026-08-18 et ne joignait personne.
  • **122** — congolais (RDC). Il remonte en tête d'une recherche « ligne verte violences
    basées sur le genre » parce que trois médias congolais en parlent ; aucune source
    béninoise ne le cite.
  • **143** — ivoirien. C'est la ligne nationale d'assistance psychologique de Côte
    d'Ivoire, annoncée par un ministère dont le sigle (MSHPCMU) ressemble à s'y méprendre
    à celui d'un ministère béninois.

Les trois sont réels, gratuits, et joignent quelqu'un — dans un AUTRE pays. C'est
exactement pourquoi une recherche rapide ne suffit pas ici : la mauvaise réponse a toutes
les apparences de la bonne.

Le **138** béninois est réel et vérifié, mais il est délibérément ABSENT : c'est la ligne
d'assistance aux ENFANTS victimes de violences (UNICEF Bénin). La citer à un salarié
adulte l'enverrait vers un service qui ne peut pas le prendre en charge.


**Avant `readonly number: string;`**

Le numéro, tel qu'il doit être composé.

**Avant `readonly label: string;`**

Ce qu'on joint — en français, dans la phrase.

**Avant `readonly verified: string;`**

⚠️ La source qui l'établit. Un numéro sans source n'entre pas dans cette table.

**Avant `readonly crisis: EmergencyLine;`**

Ce qu'on compose quand quelqu'un est en danger immédiat, ou pense à en finir.

**Avant `readonly medical: EmergencyLine;`**

L'urgence médicale.

**Avant `//  1. Police Républicaine du Bénin — numéro vert gratuit, centre d'appels ouvert le`**

Deux angles indépendants, ce qui est ce qui fait la force de ce numéro-ci :

**Avant `//     2026-11-07 (couvert par banouto.bj, beninwebtv.bj, lanouvelletribune.info,`**

1. Police Républicaine du Bénin — numéro vert gratuit, centre d'appels ouvert le

**Avant `//     cappfm.com, mediapartbenin.bj), et repris dans la liste officielle des numéros`**

2026-11-07 (couvert par banouto.bj, beninwebtv.bj, lanouvelletribune.info,

**Avant `//     courts publiée par l'ARCEP Bénin.`**

cappfm.com, mediapartbenin.bj), et repris dans la liste officielle des numéros

**Avant `//  2. 'findahelpline.com/countries/bj' le liste comme « Benin Emergency Hotline »,`**

courts publiée par l'ARCEP Bénin.

**Avant `//     service 24h/24 pour toute personne en situation d'urgence OU en risque suicidaire.`**

2. `findahelpline.com/countries/bj` le liste comme « Benin Emergency Hotline »,

**Avant `// C'est le second point qui décide : il couvre les deux cas de ce module.`**

service 24h/24 pour toute personne en situation d'urgence OU en risque suicidaire.

**Avant `verified: 'ARCEP Bénin + Police Républicaine (numéro vert) + findahelpline.com/countries/bj',`**

C'est le second point qui décide : il couvre les deux cas de ce module.

**Avant `export function resolveEmergencyLines(env: NodeJS.ProcessEnv = process.env): EmergencyLines {`**

⚠️ LE DÉFAUT EST LE BÉNIN, ET CE CHOIX MÉRITE D'ÊTRE EXPLIQUÉ PLUTÔT QUE SUBI.

`CLAUDE.md` a consigné le 2026-08-18 que les salariés sont au Nigeria, et le message de
détresse citait donc SURPIN. Le propriétaire a demandé le 2026-08-21 des numéros locaux en
nommant la **police béninoise**. Les deux affirmations viennent de la même personne et se
contredisent ; la plus récente et la plus explicite l'emporte.

Le Nigeria n'est pas supprimé pour autant — ses numéros restent vérifiés et disponibles par
`EMERGENCY_COUNTRY=NG`. Trancher en supprimant l'autre pays aurait détruit une vérification
qui avait coûté cher, pour un gain nul.

Une valeur inconnue retombe sur le défaut plutôt que de lever : une faute de frappe dans une
variable d'environnement ne doit pas priver quelqu'un de tout numéro. Même arbitrage que
`readRuleLimit`, qui refuse une limite à 0.

### `src/shared/escalation.ts`

**Avant `const DEFAULT_ESCALATION_NAME = 'Nazer';`**

⚠️ « L'ÉQUIPE RH » N'EXISTE PAS DANS CETTE ENTREPRISE — c'était une promesse creuse de plus.

Six textes en dur renvoyaient vers « l'équipe RH » : deux dans l'onboarding, deux dans
l'effacement, un dans un `hint` d'outil, un dans le message de détresse. Aucun de ces
renvois ne désignait quelqu'un de joignable. Le relevé de production du 2026-08-20 est
sans ambiguïté : le workspace compte SEPT personnes, dont UNE seule porte
`slack_directory.role = 'manager'` — le General Manager. Il n'y a pas de service RH.

C'est la même famille de défaut que le 3114 français dans le message de détresse, que
`emailSent: false` sous `status: 'success'`, et que les cinq tâches d'onboarding qu'aucun
mécanisme ne faisait avancer : le produit nommait une instance qui n'existe pas, et la
personne à qui on le disait n'avait aucun moyen de s'en apercevoir.

⚠️ DÉCLARÉ ICI UNE SEULE FOIS, jamais recopié. Six littéraux se désynchronisent au premier
changement de personne — et le symptôme serait qu'on continue d'orienter les gens vers
quelqu'un qui a quitté l'entreprise. Ce dépôt a déjà eu des instructions qui nommaient
`discoverSlackWorkspace` et `createEmployee` longtemps après leur retrait.

⚠️ CE N'EST PAS UNE FRONTIÈRE D'AUTORISATION. Le droit de lire un dossier se décide sur
`slack_directory.role`, en base, par `resolveAccess` — jamais sur cette chaîne. Ici on
nomme quelqu'un dans une phrase ; là-bas on accorde un droit. Les confondre ferait qu'un
renommage de courtoisie changerait qui peut lire quoi.

**Avant `export const ESCALATION_CONTACT = '${escalationName()}, le ${escalationRole()}';`**

« Nazer, le General Manager » — la forme employée dans une phrase française.

**Avant `export const ESCALATION_CONTACT_EN = '${escalationName()}, the ${escalationRole()}';`**

« Nazer, the General Manager » — même personne, phrase anglaise.

### `src/shared/forget.ts`

**Avant `export const ERASURE_SCOPE_NOTICE =`**

⚠️ **CETTE PHRASE A RÉTRÉCI LE 2026-08-21, parce que le produit sait faire plus.**

Elle nommait « les messages que j'ai archivés dans les canaux » parmi ce qui ne partait pas.
C'était vrai — `forgetUser` était implémentée quatre fois et appelée zéro fois — mais le
renvoi vers le General Manager pointait alors vers **un geste sans implémentation** : il
aurait dû écrire du SQL à la main sur la Turso de production.

Désormais, en DM, l'archive de CE canal part avec le reste. Ce qui subsiste hors de portée
est nommé, et il existe pour chacun un geste réel :
  • les canaux → `npm run knowledge:forget -- --user <U…>` (dry-run par défaut) ;
  • le dossier, l'annuaire, les documents, les notifications → toujours l'escalade humaine.

⚠️ **On ne dit pas « tout est effacé ».** Le contrat de ce court-circuit est de nommer ce
qu'il NE couvre pas — c'est la seule raison pour laquelle on peut lui faire confiance sur ce
qu'il couvre.

**Avant `export function erasureDoneReply(count: number): string {`**

⚠️ **ON NE DIT PLUS COMBIEN — demandé par le propriétaire le 2026-08-21.**

La réponse annonçait « C'est effacé : 4 messages … ont été supprimés ». Le chiffre ne rendait
aucun service à qui le lisait, et il en rendait un à qui SONDE : il mesure ce que le bot avait
gardé, donc l'activité passée d'une personne — dans un DM où le manager peut par ailleurs
relire l'archive. Un compte est une information sur la donnée, pas seulement sur le geste.

⚠️ **On garde en revanche la distinction VIDE / NON VIDE.** « Je n'avais rien retenu » et
« c'est effacé » ne sont pas la même phrase : la première dit qu'il n'y avait rien, la seconde
qu'il y avait quelque chose et que c'est parti. Les fondre ferait dire « c'est effacé » à un
geste qui n'a rien effacé — la famille de mensonge que ce dépôt traque, et exactement ce que
ce court-circuit a été écrit pour ne plus faire.

### `src/shared/greeting.ts`

**Avant `export const GREETING_REPLY = 'Bonjour, moi c'est ${ASSISTANT_NAME}. Dis-moi ce qu'il te faut : ${CAPABILITY_L`**

⚠️ C'EST ICI QUE MARCEL SE PRÉSENTE, et c'est souvent le tout premier échange.

Le texte disait « Bonjour. » — correct, et anonyme. Personne ne se présente comme ça à un
nouveau collègue. Le prénom ne coûte rien (ce court-circuit répond sans aucun appel de
modèle) et change ce que la personne croit avoir en face d'elle.

⚠️ Les variantes restent contraintes par deux tests : `GREETING_REPLY` doit tenir sous
200 caractères ET citer chacune des capacités réellement câblées — une salutation qui
promet ce qui n'existe pas est le défaut qu'on a corrigé en retirant « questionnaire ».

### `src/shared/llm/model-fallback.ts`

**Avant `export const DEFAULT_GEMINI_MODEL_ID = 'gemini-3.5-flash';`**

⚠️ `gemini-3.7-flash` a été essayé PUIS ÉCARTÉ le 2026-08-21, sur mesure et non sur
intuition : 2 réponses `503 high demand` sur 6 en local, et deux échecs réels en
production dès la première campagne (« This model is currently experiencing high
demand »). La chaîne rattrapait — Groq répondait — mais c'est exactement le mode de panne
de `llama-3.3-70b-versatile` : le bot répond, et chaque message paie un aller-retour perdu.

Relevé comparatif, 6 requêtes par modèle :
  gemini-3.5-flash     6/6      ← retenu
  gemini-3.6-flash     5/6      (1 dépassement de délai)
  gemini-3.7-flash     4/6      (2× 503)
  gemini-flash-latest  1/6      (3× 429, 2× 503)

Les deux retenus appellent les outils, vérifié par une requête portant un vrai schéma —
le test qui avait écarté `qwen/qwen3.6-27b` le 2026-08-15.

**Avant `// agent, donc lever ferait exploser le câblage entier — y compris dans neuf fichiers de`**

⚠️ On ne LÈVE PAS, et c'est délibéré. Ce module est évalué à la construction de chaque

**Avant `// tests qui ne testent pas la configuration LLM. Le contrat d'avant le 2026-08-20 était`**

agent, donc lever ferait exploser le câblage entier — y compris dans neuf fichiers de

**Avant `// déjà « la chaîne n'est jamais vide » : Groq y était poussé sans regarder sa clé.`**

tests qui ne testent pas la configuration LLM. Le contrat d'avant le 2026-08-20 était

**Avant `//`**

déjà « la chaîne n'est jamais vide » : Groq y était poussé sans regarder sa clé.

**Avant `// du fournisseur, à des étages de distance de sa cause.`**

Ce qui change est la LISIBILITÉ : sans cette ligne, la panne se présente comme un 401

**Avant `sharedLogger.error(`**

du fournisseur, à des étages de distance de sa cause.

### `src/shared/security/agent-output.ts`

**Avant `export const NOTIFICATION_SUBJECT_PLACEHOLDER = 'Notification Kisso';`**

Repli COURT — un sujet n'est pas un corps.

`NOTIFICATION_BODY_PLACEHOLDER` est une phrase entière, juste pour un corps vidé ; en ligne
d'objet elle donnerait « (Le contenu de cette notification a été retiré : il n'a pas passé le
contrôle de sortie.) », ce que personne n'ouvre. Deux fonctions, deux replis.

**Avant `const SUBJECT_MAX_LENGTH = 200;`**

Le schéma de `sendNotification` borne déjà `subject` à 200 ; on ne fait pas confiance à ça
 seul, l'assainissement pouvant être appelé depuis un chemin qui ne passe pas par le schéma
 (une ligne relue en base, par exemple).

**Avant `export function sanitizeNotificationSubject(raw: string | undefined | null): SanitizedDocumentText {`**

⚠️ **UN SUJET N'EST PAS UN CORPS, et c'est pourquoi ce n'est pas `sanitizeNotificationBody`
qui est réutilisé tel quel.** Deux différences, toutes deux nécessaires :

1. **Les sauts de ligne sont APLATIS.** `\r\n` dans une ligne d'objet est la primitive
   classique d'injection d'en-tête SMTP. Nodemailer s'en protège — mais on ne délègue pas à
   un transport une garantie qu'on peut tenir soi-même, et le SECOND transport de ce tool
   (Slack) n'a jamais entendu parler de cette règle : un sujet multiligne y casse simplement
   la mise en forme de `*${subject}*`.
2. **La longueur est bornée.**

Le reste — marqueurs internes, URL hors `ALLOWED_LINK_DOMAINS` — est le contrat commun, et il
est partagé par construction : `redactAndFilter` est le point unique. Le faire diverger
ferait qu'un lien retiré du corps survivrait dans le sujet, à deux caractères de là.

Trouvé par l'audit du 2026-08-21 : `sendNotification` filtrait son `body` depuis la veille et
laissait passer son `subject`, alors que le `.describe()` du champ ORDONNE au modèle de le
rédiger.

### `src/shared/security/tool-execution-guard.ts`

**Avant `/** 403 et non 401 : l'appelant est authentifié, c'est la capacité qui n'existe pas pour lui. */`**


L'EXÉCUTION D'UN OUTIL PAR HTTP EST FERMÉE


`mayTouchRecord` (`shared/slack-request-context.ts`) rend `true` quand aucun contexte Slack
n'accompagne l'appel. **Ce n'est pas un oubli** : c'est le cas normal du playground, d'un
workflow et d'un test, et « au tool de dégrader » est une décision écrite et justifiée.

Mais Mastra expose `POST /api/tools/:toolId/execute` et
`POST /api/agents/:agentId/tools/:toolId/execute`. Derrière `MASTRA_API_TOKEN` — fail-closed,
mais **sans aucune règle RBAC déclarée**, donc le jeton vaut toutes les routes — un appelant
atteint ces chemins sans contexte Slack, et exécute alors `getEmployeeProfile`,
`generateDocument`, `sendNotification`, `scheduleReminder` ou `updateOnboardingStatus` sur
l'identifiant de n'importe qui.

⚠️ **C'est la moitié restée ouverte du correctif du 2026-08-14.** Celui-ci a fermé la FORGE
(`createRequestContextGuard` refuse toute clé `slack*` venue du corps) et laissé la VACANCE,
qui est strictement plus puissante : s'usurper exige de connaître les clés, ne rien déclarer
n'exige rien.

⚠️ **ON FERME LA ROUTE, PAS LE FAIL-OPEN.** Renverser `mayTouchRecord` ferait refuser les
chemins internes légitimes, et le symptôme serait un produit qui ne sait plus rien faire —
la panne que le garde d'autorisation évite déjà en refusant de s'appliquer tant qu'aucun
manager n'est désigné. Ce qu'il faut retirer, c'est la SURFACE : ces routes n'ont **aucun
consommateur** dans ce dépôt (zéro occurrence dans `src/`, `scripts/`, `tests/`). Une
capacité sans usage qui vaut l'usurpation totale n'est pas une capacité.

⚠️ **La frontière ne repose pas sur ce garde.** Le retirer un jour ramènerait à l'état du
2026-08-20, pas plus bas. Il ferme une porte ; il ne porte pas la serrure.

**Avant `const FORBIDDEN = 403;`**

403 et non 401 : l'appelant est authentifié, c'est la capacité qui n'existe pas pour lui.

**Avant `export function isToolExecutionPath(rawPath: string): boolean {`**

⚠️ **AUCUNE EXPRESSION RÉGULIÈRE ICI, et c'est délibéré.**

La première version était `/\/api\/(?:agents\/[^/]+\/)?tools\/[^/]+\/execute$/i` — deux
classes répétées de part et d'autre d'un groupe optionnel, donc un motif que `eslint` signale
en `detect-unsafe-regex` et `super-linear-regex`. Ce dépôt a déjà mesuré et corrigé un lot
ReDoS ; poser un motif à backtracking sur un chemin **contrôlé par l'appelant**, dans un garde
de sécurité, aurait été rouvrir la porte à côté de celle qu'on ferme.

Un découpage en segments est linéaire par construction, et il se lit mieux : on veut
`…/tools/<x>/execute`, éventuellement précédé de `agents/<y>`.

⚠️ **La normalisation précède la décision.** Le chemin vient d'une URL que l'appelant écrit :
tout ce que le serveur normaliserait SANS que le garde le voie serait un contournement. Les
segments vides absorbent d'un coup le slash de fin, les slashs doublés et le `?…`.

**Avant `if (segments.length < 4) return false;`**

`…/tools/<toolId>/execute` — au minimum `api`, `tools`, `<id>`, `execute`.

**Avant `// et '/api/agents/<agentId>/tools/<id>/execute'.`**

Deux formes exposées par Mastra, et deux seulement : `/api/tools/<id>/execute`

**Avant `if (segments.length === 4) return true;`**

et `/api/agents/<agentId>/tools/<id>/execute`.

### `src/shared/slack-request-context.ts`

**Avant `export const SLACK_AUTHZ_NOTICE_KEY = 'slackAuthorizationNotice';`**

⚠️ POURQUOI UN REFUS D'AUTORISATION PASSE PAR LE CONTEXTE, ET NON PAR LE SEUL `hint`.

Mesuré en production le 2026-08-21 : « Prépare un email d'entretien pour … » a reçu
« Je ne peux pas créer cette invitation. » — exact, et muet sur la RAISON. Le `hint` du tool
demandait pourtant de l'expliquer, et l'agent a pour instruction de le reprendre.

C'est la CINQUIÈME consigne d'agent mesurée en échec dans ce dépôt, après la couverture des
extraits, la rédaction du contenu, le `recipient` d'un document et les codes internes récités
par Gemini. La conclusion ne change pas : une consigne est PROBABLE, le code est GARANTI.

Un refus qui ne dit pas pourquoi est vécu comme une panne. Nommer la seule personne qui
détient le droit transforme un mur en information exploitable — et coûte ZÉRO token, le
`RequestContext` ne traversant ni le prompt ni les schémas.

**Avant `export const SLACK_REMINDER_DELIVERY_KEY = 'slackReminderDelivery';`**

⚠️ **LE MOMENT DE REMISE EST NOMMÉ PAR LE CODE, jamais par le modèle** — même raison que
ci-dessus, et même famille de défaut.

Le rappel part désormais pour de bon (cron quotidien, voir `reminder-dispatch.ts`), mais la
plateforme ne garantit qu'un passage PAR JOUR, à ±59 min. Laisser le modèle annoncer l'heure
demandée — « lundi 24 août à 09 h00 » — serait une précision que rien ne tient : la famille
exacte d'`emailSent: false` sous `status: 'success'`.

Le tool écrit donc ici le moment RÉEL, le handler l'accole, et le modèle n'a jamais l'heure
dans sa fenêtre. On ne lui interdit pas de mentir : on lui retire de quoi.

**Avant `export function mayHoldKeyFor(`**

⚠️ **PEUT-ON CONFIER L'IDENTIFIANT INTERNE DE CETTE PERSONNE AU DEMANDEUR ?**

Les résolveurs de personne (`findPersonByName`, `findEmployeeByEmail`) s'en servent pour
décider ce qu'ils rendent. Ils ne REFUSENT jamais — un agent qui ne sait pas résoudre une
personne ne peut rien faire — ils rendent le NOM sans la CLÉ.

⚠️ **IL DÉLÈGUE À `mayTouchRecord`, FAIL-OPEN HORS SLACK COMPRIS, et c'est une décision
prise puis REVENUE SUR.** La première version répondait NON sans contexte Slack, au motif
qu'on ne rend pas une clé à un appelant qu'on ne connaît pas. Elle a cassé 19 tests — et ces
tests encodaient une décision délibérée du dépôt : ces outils restent utilisables depuis le
playground, un workflow et un test, où `readSlackContext` rend `undefined` par conception.

Inverser ce fail-open aurait dépassé ce que l'audit demandait, et aurait pu couper la
résolution de SOI-MÊME pendant la fenêtre d'accueil, quand `slack_directory.employee_id`
n'est pas encore écrite — la famille exacte du défaut du 2026-08-19.

⚠️ **Ce qui rend ce fail-open sûr est ailleurs** : `createToolExecutionGuard` ferme depuis le
2026-08-21 les routes d'exécution d'outil de l'API, c'est-à-dire la seule porte par laquelle un
appelant sans contexte Slack atteignait ces outils en production. On ferme la ROUTE, pas la
règle — même arbitrage que pour la frontière elle-même.

Il reste donc un alias de `mayTouchRecord`, et il existe pour NOMMER l'intention : « peut-on
confier la clé » se relit autrement que « peut-on lire le dossier », alors même que la
réponse est la même. Le jour où l'une des deux doit bouger, elle bougera seule.

### `src/shared/slack-team.ts`

**Avant `export type WorkspaceVerdict =`**


L'APPARTENANCE AU WORKSPACE — une règle, deux portes d'entrée


La signature HMAC prouve que **Slack** a émis la requête. Elle ne dit rien de **quel
workspace** : une app installée ailleurs signerait tout aussi valablement. `SLACK_TEAM_ID`
est la défense en profondeur qui tranche cette question.

⚠️ **Elle n'existait que d'un côté.** `SlackEventsHandler.checkTeamId` la posait sur
`/slack/events` ; `/slack/interactions` ne la posait pas, alors que le champ `team.id` est
déclaré dans son type de payload et **lu nulle part**. L'audit du 2026-08-21 l'a relevé.

⚠️ **On PARTAGE la fonction plutôt que de la recopier**, et c'est la leçon la plus chère de
ce dépôt : « deux machines à états qui suivent la même règle sans la partager finissent par
diverger, et c'est celle qu'on a oubliée qui perd les données ». Elle a été payée le
2026-08-21 sur `profileRetryReply` / `pendingInterviewStep`.

⚠️ **FAIL-OPEN, à dessein et comme avant.** Sans `SLACK_TEAM_ID`, on n'écarte rien : la
variable est facultative, et un déploiement qui ne l'a pas posée doit continuer de servir son
workspace. Le refus silencieux de TOUS les événements serait une panne indiscernable d'un bot
mort — précisément ce que ce dépôt combat.

**Avant `if (!want) return { accepted: true, checked: false };`**

Non configurée : on ne vérifie pas, et l'appelant journalise UNE fois que le contrôle dort.

**Avant `// Slack, et le refuser transformerait une défense en profondeur en panne intermittente.`**

⚠️ Un événement SANS `team_id` est accepté : le champ est absent de certaines charges

**Avant `if (!got) return { accepted: true, checked: true };`**

Slack, et le refuser transformerait une défense en profondeur en panne intermittente.

---

## Décisions du 2026-08-22 — le sens du verbe entre dans le nom

### Les cinq `prune()` devenus `pruneExpired` / `pruneOlderThan`

⚠️ **UN NOM, TROIS SÉMANTIQUES D'ARGUMENT.** `prune(olderThan: Date)` sur la conversation et
la déduplication, `prune(now: Date)` sur la limitation de débit, `prune(before: number)` sur
l'archive et les faits. Le même appel `prune(new Date())` supprimait **tout** sur quatre
dépôts et **rien** sur le cinquième, et aucun type ne s'y opposait : les deux premiers
prennent une `Date`, l'un comme seuil d'ancienneté, l'autre comme instant courant.

Le verbe seul ne pouvait pas porter la distinction. Elle est maintenant dans le nom
(`pruneExpired` supprime ce qui a expiré à l'instant donné ; `pruneOlderThan` supprime ce qui
précède un seuil) et l'unité est dans le paramètre (`cutoff: Date`, `cutoffMs: number`).
