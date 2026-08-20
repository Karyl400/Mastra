# Plateforme (`src/api/`, `src/mastra/`, `src/infrastructure/`)

> Décisions de conception, extraites des commentaires du code le 2026-08-20.
>
> Chaque entrée porte le fichier et la ligne d'origine, ainsi que la déclaration
> qu'elle précédait. Le code ne porte plus ce texte : **c'est ici qu'il vit désormais.**

---

## `api/slack-events.route.ts`

**L.1 — avant `import { registerApiRoute } from '@mastra/core/server';`**

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

**L.38 — avant `export const SLACK_EVENTS_PATH = '/slack/events';`**

 Chemin public de l'endpoint Slack. À reporter tel quel dans l'app Slack.

**L.41 — avant `const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');`**

 ------------------------------------------------------------------------- *
Prolongation de vie de la fonction serverless (`waitUntil`)

**L.45 — avant `const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');`**

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

**L.74 — avant `export type BackgroundMechanism = 'vercel-wait-until' | 'detached';`**

 Mécanisme effectivement retenu pour faire vivre le traitement de fond.

**L.77 — avant `export function getVercelWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {`**

 `waitUntil` du lanceur Vercel, ou `undefined` hors Vercel (dev local, tests).

**L.84 — avant `export function scheduleBackgroundWork(work: Promise<unknown>): BackgroundMechanism {`**

Planifie un travail qui doit survivre à l'envoi de la réponse HTTP.

Sur Vercel, `waitUntil` empêche le gel de la fonction tant que la promesse n'est pas
réglée (dans la limite du `maxDuration`). Hors Vercel — `mastra dev`, tests, tout
serveur Node de longue durée — le simple détachement suffit puisque le processus vit.

La promesse reçue DOIT déjà être « catchée » : `waitUntil` propagerait sinon un rejet
non géré.

**L.103 — avant `export const SLACK_ACK_BUDGET_MS = 3_000;`**

 ------------------------------------------------------------------------- *
Budget d'ACK Slack — instrumentation

**L.107 — avant `export const SLACK_ACK_BUDGET_MS = 3_000;`**

Slack rejoue tout événement qu'il n'a pas vu accusé dans ce délai. Ce n'est pas une
recommandation : c'est le mécanisme qui a produit la DOUBLE RÉPONSE du 2026-08-11 12:38 UTC.
Un ACK à 6,7 s sur démarrage à froid a déclenché un rejeu (`retryNum: 1`) routé vers une
instance NEUVE, au cache vide, qui a répondu une seconde fois avec un texte différent.

**L.115 — avant `export const SLACK_ACK_AT_RISK_MS = 1_500;`**

Seuil d'alerte, à la moitié du budget.

Il existe parce que le dépassement, lui, n'est PAS observable depuis la fonction : quand
l'ACK part à 3,4 s, on voit un `200` parfaitement normal dans les logs et un doublon
inexplicable dans Slack. La seule trace exploitable de l'incident du 2026-08-11 a été
reconstruite après coup, par déduction, à partir de deux messages contradictoires postés
dans un fil. Mesurer le chemin pré-ACK est ce qui manquait pour le voir venir.

**L.126 — avant `export type AckBudgetState = 'ok' | 'at_risk' | 'exceeded';`**

 État NOMMÉ du budget d'ACK — aucune dégradation de ce chemin ne doit être muette.

**L.135 — avant `function reportAckBudget(state: AckBudgetState, details: Record<string, unknown>): void {`**

Journalise le coût du chemin pré-ACK, et seulement quand il devient intéressant.

`exceeded` part en `error` et non en `warn` : à ce stade Slack a déjà rejoué, donc un second
traitement est déjà en vol quelque part. C'est la ligne à chercher quand une double réponse
réapparaît — avant d'aller soupçonner la déduplication, qui n'est que la victime.

**L.150 — avant `export interface SlackRouteContext {`**

Sous-ensemble du `Context` Hono réellement utilisé par la route.
Permet de tester le handler sans démarrer un serveur.

**L.163 — avant `let cachedHandler: SlackEventsHandler | undefined;`**

Handler mémorisé : le cache de déduplication et le `bot_user_id` résolu via
`auth.test()` doivent survivre entre deux requêtes.

**L.170 — avant `let handlerOptionsForTests: SlackEventsHandlerOptions | undefined;`**

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

**L.192 — avant `let cachedEventsEmailProvider: ReturnType<typeof createEmailProvider> | undefined;`**

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

**L.209 — avant `function getEventsEmailProvider() {`**

 Fournisseur d'email, construit au PREMIER envoi réel — jamais au chargement du module.

**L.227 — avant `interviewRepository: new DrizzleOnboardingInterviewRepository(),`**

⚠️ Injecté ICI et nulle part ailleurs : le handler n'a délibérément AUCUN repli

**L.228 — avant `interviewRepository: new DrizzleOnboardingInterviewRepository(),`**

paresseux vers Drizzle pour ce dépôt. Un repli ferait que tout handler construit en

**L.229 — avant `interviewRepository: new DrizzleOnboardingInterviewRepository(),`**

test toucherait la base — le piège qui a rendu onze tests d'`accept()` `rate_limited`

**L.230 — avant `interviewRepository: new DrizzleOnboardingInterviewRepository(),`**

le jour où `rate_limit_counters` a existé. Absent, l'entretien conversationnel

**L.231 — avant `interviewRepository: new DrizzleOnboardingInterviewRepository(),`**

collecte et répond correctement, seule la trace manque.

**L.233 — avant `profileRepository: new DrizzleEmployeeRepository(),`**

⚠️ Le MÊME dépôt que celui de la route d'interactivité, et c'est voulu : le bouton

**L.234 — avant `profileRepository: new DrizzleEmployeeRepository(),`**

« C'est fait » et la phrase « j'ai fini » doivent rendre le même verdict. Deux

**L.235 — avant `profileRepository: new DrizzleEmployeeRepository(),`**

sources de vérité pour une seule vérification finiraient par ne plus dire la même

**L.236 — avant `profileRepository: new DrizzleEmployeeRepository(),`**

chose — la divergence corrigée deux fois en un jour sur ce même parcours.

**L.238 — avant `pendingEmailRepository: new DrizzlePendingInterviewEmailRepository(),`**

L'email d'entretien PRÉPARÉ, en attente d'un « oui » ou d'un « non ». Même contrat

**L.239 — avant `pendingEmailRepository: new DrizzlePendingInterviewEmailRepository(),`**

d'injection que les deux ci-dessus, et pour la même raison : aucun repli paresseux,

**L.240 — avant `pendingEmailRepository: new DrizzlePendingInterviewEmailRepository(),`**

donc aucun test de handler ne touche la base par accident.

**L.242 — avant `sendEmail: (to, subject, body) => getEventsEmailProvider().sendEmail(to, subject, body),`**

⚠️ PARESSEUX à l'appel, jamais à la construction : `createEmailProvider` lit la

**L.243 — avant `sendEmail: (to, subject, body) => getEventsEmailProvider().sendEmail(to, subject, body),`**

configuration SMTP et construit un transport, et ce fichier est évalué à CHAQUE

**L.244 — avant `sendEmail: (to, subject, body) => getEventsEmailProvider().sendEmail(to, subject, body),`**

démarrage à froid, donc sur le chemin des 3 secondes d'ACK. La fabrique est la même

**L.245 — avant `sendEmail: (to, subject, body) => getEventsEmailProvider().sendEmail(to, subject, body),`**

que celle de `src/mastra/index.ts` et de la route d'interactivité — une copie ferait

**L.246 — avant `sendEmail: (to, subject, body) => getEventsEmailProvider().sendEmail(to, subject, body),`**

partir les emails d'entretien par un fournisseur et ceux de notification par un

**L.247 — avant `sendEmail: (to, subject, body) => getEventsEmailProvider().sendEmail(to, subject, body),`**

autre, sans que rien ne le signale.

**L.249 — avant `...handlerOptionsForTests,`**

Les options de test l'emportent : un test qui neutralise les canaux doit pouvoir le

**L.250 — avant `...handlerOptionsForTests,`**

faire, et l'ordre inverse rendrait l'injection silencieusement inopérante.

**L.258 — avant `export function setSlackEventsHandlerOptionsForTests(`**

Installe les dépendances du handler construit par la route (tests uniquement).

Invalide le singleton au passage : sans cela, un handler déjà mémorisé — donc déjà porteur
de ses dépôts Drizzle — survivrait à l'injection et la rendrait silencieusement inopérante.

**L.272 — avant `export function resetSlackEventsHandler(): void {`**

 Réinitialise le singleton ET l'injection de test — remise à l'état de production.

**L.280 — avant `const startedAt = Date.now();`**

Horloge du budget d'ACK. Prise AVANT toute lecture : le corps de la requête, la

**L.281 — avant `const startedAt = Date.now();`**

vérification HMAC et l'admission comptent tous dans les 3 s que Slack accorde.

**L.284 — avant `const rawBody = await c.req.text();`**

1. Corps BRUT obligatoire pour le HMAC. Parser puis re-sérialiser casserait la

**L.285 — avant `const rawBody = await c.req.text();`**

   signature (espaces / ordre des clés).

**L.296 — avant `logger.warn('Rejected Slack request', { reason: verification.reason });`**

`url_verification` est signé lui aussi : la vérification s'applique à TOUS les

**L.297 — avant `logger.warn('Rejected Slack request', { reason: verification.reason });`**

types d'événements, sans exception.

**L.309 — avant `if (body.type === 'url_verification') {`**

2. Handshake Slack (envoyé AVANT que l'app soit vérifiée, mais bien signé).

**L.317 — avant `const retryNum = c.req.header('x-slack-retry-num');`**

3. Filtrage + déduplication SYNCHRONES, avant l'ACK, pour qu'un renvoi Slack ne

**L.318 — avant `const retryNum = c.req.header('x-slack-retry-num');`**

   déclenche pas un second traitement de fond.

**L.321 — avant `const admissionStartedAt = Date.now();`**

`accept()` est asynchrone depuis la déduplication partagée : la prise de clé fait un

**L.322 — avant `const admissionStartedAt = Date.now();`**

aller-retour vers Turso, et le contrôle de débit un second (les deux règles y partent

**L.323 — avant `const admissionStartedAt = Date.now();`**

désormais ENSEMBLE — cf. `SlackRateLimiter.check`). Il reste AVANT l'ACK, et c'est

**L.324 — avant `const admissionStartedAt = Date.now();`**

délibéré : les deux décisions qu'il prend gouvernent l'existence même du travail de fond.

**L.325 — avant `const admissionStartedAt = Date.now();`**

Les déplacer après l'ACK reviendrait à programmer d'abord et à décider ensuite — sur une

**L.326 — avant `const admissionStartedAt = Date.now();`**

plateforme où « programmer » veut dire tenir la fonction éveillée et où le premier geste

**L.327 — avant `const admissionStartedAt = Date.now();`**

du traitement est de poster un marqueur de progression dans Slack. Un rejeu écarté APRÈS

**L.328 — avant `const admissionStartedAt = Date.now();`**

avoir posté « Je regarde ça, un instant… » n'est plus un rejeu écarté : c'est la double

**L.329 — avant `const admissionStartedAt = Date.now();`**

réponse qu'on cherche à empêcher, avec une étape de plus.

**L.335 — avant `const work = handler.handleEvent(body).catch((error) => {`**

4. Slack renvoie tout événement non accusé en moins de 3 s, et un appel agent

**L.336 — avant `const work = handler.handleEvent(body).catch((error) => {`**

   prend 2 à 17 s (cf. TEST_REPORT.md) → traitement en tâche de fond.

**L.338 — avant `const work = handler.handleEvent(body).catch((error) => {`**

   ⚠️ SERVERLESS (Vercel) : un simple `void promise` ne suffit PAS. La fonction est

**L.339 — avant `const work = handler.handleEvent(body).catch((error) => {`**

   gelée dès la réponse envoyée et l'appel LLM en vol est tué — symptôme observé en

**L.340 — avant `const work = handler.handleEvent(body).catch((error) => {`**

   production : ACK 200, aucune réponse dans Slack, et AUCUN log après l'ACK.

**L.341 — avant `const work = handler.handleEvent(body).catch((error) => {`**

   `waitUntil()` déclare la promesse au lanceur Vercel, qui maintient l'instance

**L.342 — avant `const work = handler.handleEvent(body).catch((error) => {`**

   éveillée jusqu'à son règlement (borné par `maxDuration`).

**L.353 — avant `logger.info('Slack event scheduled', {`**

`retryNum` n'était journalisé QUE sur le chemin dupliqué. Sur le chemin

**L.354 — avant `logger.info('Slack event scheduled', {`**

accepté, l'en-tête était lu puis jeté — impossible de distinguer un rejeu

**L.355 — avant `logger.info('Slack event scheduled', {`**

Slack d'un événement jumeau (`message` + `app_mention`) quand deux

**L.356 — avant `logger.info('Slack event scheduled', {`**

réponses partent pour un seul message. C'est la ligne qui tranche.

**L.364 — avant `if (mechanism === 'detached' && process.env.VERCEL) {`**

Garde-fou d'observabilité : sur Vercel, `detached` signifie que le travail SERA

**L.365 — avant `if (mechanism === 'detached' && process.env.VERCEL) {`**

tué au gel de la fonction. C'est la ligne à chercher dans les logs si le bot

**L.366 — avant `if (mechanism === 'detached' && process.env.VERCEL) {`**

recommence à ne plus répondre.

**L.376 — avant `const ackMs = Date.now() - startedAt;`**

5. ACK immédiat — toujours 200, sinon Slack rejoue puis désactive l'endpoint.

**L.377 — avant `const ackMs = Date.now() - startedAt;`**

   Le coût réel du chemin qui précède est mesuré et NOMMÉ : c'est le seul endroit d'où

**L.378 — avant `const ackMs = Date.now() - startedAt;`**

   l'on puisse constater qu'on s'approche des 3 s, et l'instrument qui manquait le

**L.379 — avant `const ackMs = Date.now() - startedAt;`**

   2026-08-11.

**L.393 — avant `export const SLACK_EVENTS_WORK_PATH = '/internal/slack/events';`**

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

**L.1 — avant `import { registerApiRoute } from '@mastra/core/server';`**

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

**L.37 — avant `const PROFILE_DONE_ACTION_ID = 'profile_done';`**

⚠️ IDENTIFIANT HÉRITÉ — plus AUCUN émetteur depuis le 2026-08-19.

Les boutons ont été retirés du parcours : le propriétaire a signalé deux fois qu'ils ne
fonctionnaient pas sous un vrai clic humain, alors que les sondes signées mesuraient des ACK
de 393 à 1 473 ms. On a supprimé la DÉPENDANCE plutôt que de rejouer la mesure.

Cette branche est CONSERVÉE, et ce n'est pas du code mort : les messages déjà postés dans
Slack portent encore leur bouton, indéfiniment. Quelqu'un qui remonte son fil et clique doit
obtenir la vérification de son dossier — pas un `block_actions sans action connue`, c'est-à-
dire un clic sans effet et sans trace. La constante vit ici parce que c'est désormais son
unique consommateur.

**L.78 — avant `export const SLACK_INTERACTIONS_PATH = '/slack/interactions';`**

 Chemin public. À reporter dans *Interactivity & Shortcuts* de l'app Slack.

**L.81 — avant `interface SlackInteractionUser {`**

 -------------------------------------------------------------------------- *
Types de payload

**L.95 — avant `interface SlackInteractionPayload {`**

Union structurelle plutôt que discriminée : on branche sur `payload.type` en
TypeScript. Le payload est du JSON non fiable, et `z.discriminatedUnion` reste
proscrit dans ce dépôt (zod épinglé 3.25.76).

**L.110 — avant `channel?: { id?: string };`**

⚠️ `state` a été RETIRÉ de ce type le 2026-08-19, avec les modales. Le garder aurait
laissé croire que ce module lit encore une saisie de formulaire — il n'y en a plus, et
`handleViewSubmission` ne fait plus que prévenir la personne que rien n'a été gardé.

**L.115 — avant `channel?: { id?: string };`**

 Présents sur `block_actions` (pas sur `view_submission`) : où la carte a été cliquée.

**L.120 — avant `function decodeLegacyProfileButton(`**

Relit le `value` d'un bouton « C'est fait » DÉJÀ POSTÉ dans un DM.

⚠️ RAPATRIÉ ICI le 2026-08-19, depuis `profile-modal.ts` supprimé le même jour. Ce n'est
plus une pièce de formulaire : c'est le décodeur d'un legs. Slack ne rappelle pas les
messages, donc ces boutons restent cliquables indéfiniment dans les DM où ils ont été
postés, et cette route est le seul endroit qui les voie encore. Aucun code n'en émet plus.

Le payload est signé, donc digne de confiance après vérification HMAC — mais un message
ancien peut porter un format antérieur, d'où le repli sur l'identifiant seul.

**L.153 — avant `return { slackUserId: value || fallbackUserId };`**

Format historique : le `value` ne portait que l'identifiant Slack brut.

**L.158 — avant `export interface SlackInteractionsContext {`**

 Sous-ensemble du `Context` Hono réellement utilisé.

**L.167 — avant `function ack(): Response {`**

 -------------------------------------------------------------------------- *
Réponses

**L.171 — avant `function ack(): Response {`**

Accusé de réception : `200` avec un corps **VIDE**.

Sur `view_submission`, Slack n'accepte que deux formes : un corps vide (ferme
la modale) ou un corps portant `response_action`. Un `{"ok":true}` — le
réflexe hérité de la route Events — n'est ni l'un ni l'autre et affiche
« We had some trouble connecting » à l'utilisateur.

**L.190 — avant `let cachedAdapter: SlackAdapter | undefined;`**

 -------------------------------------------------------------------------- *
Adaptateur Slack mémorisé

**L.201 — avant `export function resetSlackInteractionsAdapter(): void {`**

 Réinitialise le singleton (tests).

**L.206 — avant `async function handleBlockActions(payload: SlackInteractionPayload): Promise<Response> {`**

 -------------------------------------------------------------------------- *
Traitement

**L.210 — avant `async function handleBlockActions(payload: SlackInteractionPayload): Promise<Response> {`**

Clic sur « Compléter mon profil ».

`views.open` est appelé AVANT toute autre opération : le `trigger_id` expire
3 secondes après l'interaction, et le pré-remplissage voyage déjà dans le
`value` du bouton — donc zéro appel réseau supplémentaire.

**L.220 — avant `const doneAction = actions.find((a) => a.action_id === PROFILE_DONE_ACTION_ID);`**

── « C'EST FAIT » — le nouveau point d'entrée du parcours, 2026-08-19 ────

**L.222 — avant `const doneAction = actions.find((a) => a.action_id === PROFILE_DONE_ACTION_ID);`**

⚠️ TRAITÉ EN PREMIER, et surtout AVANT la garde `trigger_id` : il n'ouvre aucune modale,

**L.223 — avant `const doneAction = actions.find((a) => a.action_id === PROFILE_DONE_ACTION_ID);`**

donc il n'en a pas besoin. C'est toute sa raison d'être. Un `trigger_id` expire 3 s après

**L.224 — avant `const doneAction = actions.find((a) => a.action_id === PROFILE_DONE_ACTION_ID);`**

le clic ; le démarrage à froid de cette fonction a été mesuré à 4,9 s le 2026-08-18, et

**L.225 — avant `const doneAction = actions.find((a) => a.action_id === PROFILE_DONE_ACTION_ID);`**

jusqu'à 16 s après une longue inactivité — c'est-à-dire le cas d'un ARRIVANT, qui est

**L.226 — avant `const doneAction = actions.find((a) => a.action_id === PROFILE_DONE_ACTION_ID);`**

par définition le premier à écrire de la journée. Faire dépendre le premier geste de

**L.227 — avant `const doneAction = actions.find((a) => a.action_id === PROFILE_DONE_ACTION_ID);`**

l'accueil d'un `trigger_id` revenait à le faire échouer systématiquement.

**L.229 — avant `const doneAction = actions.find((a) => a.action_id === PROFILE_DONE_ACTION_ID);`**

ACK immédiat, ZÉRO E/S ici : la vérification en base et la réponse partent en tâche de

**L.230 — avant `const doneAction = actions.find((a) => a.action_id === PROFILE_DONE_ACTION_ID);`**

fond. Au pire la réponse arrive quelques secondes plus tard, ce qui est le comportement

**L.231 — avant `const doneAction = actions.find((a) => a.action_id === PROFILE_DONE_ACTION_ID);`**

normal d'une conversation — jamais une erreur affichée par Slack.

**L.244 — avant `if (actions.some((a) => a.action_id === CANCEL_INTERVIEW_ACTION_ID)) {`**

── Recrutement : les deux boutons de la carte de confirmation ─────────────

**L.245 — avant `if (actions.some((a) => a.action_id === CANCEL_INTERVIEW_ACTION_ID)) {`**

Ils n'ouvrent aucune modale, donc rien ne doit les faire dépendre d'un `trigger_id`.

**L.247 — avant `if (!claimCard(payload)) {`**

⚠️ La prise se fait ICI, avant l'ACK, et pas dans la tâche de fond : c'est une décision

**L.248 — avant `if (!claimCard(payload)) {`**

synchrone sans E/S, et la mettre en tâche de fond rouvrirait la fenêtre qu'elle ferme.

**L.250 — avant `if (!claimCard(payload)) {`**

Annuler NEUTRALISE la carte. Sans cela « Envoyer » restait cliquable APRÈS une

**L.251 — avant `if (!claimCard(payload)) {`**

annulation — l'annulation n'écrivait qu'une phrase et ne retirait rien.

**L.257 — avant `scheduleInteractionWork(`**

Même régime que l'envoi ci-dessous, et pour la même raison : ce sont des appels réseau

**L.258 — avant `scheduleInteractionWork(`**

à Slack. Awaités, ils portaient l'ACK à 5,3 s (mesuré) — au-delà des 3 secondes

**L.259 — avant `scheduleInteractionWork(`**

accordées, alors qu'une annulation n'a strictement rien à faire attendre.

**L.273 — avant `if (!claimCard(payload)) {`**

⚠️ LA GARANTIE D'UN SEUL ENVOI, et elle est ici — synchrone, avant l'ACK. Un email vers

**L.274 — avant `if (!claimCard(payload)) {`**

un candidat est la seule action irréversible et SORTANTE de ce système ; le tool a sa

**L.275 — avant `if (!claimCard(payload)) {`**

garde (`runGuard`) et le workflow d'onboarding la sienne (`onboardingRunId`), ce clic

**L.276 — avant `if (!claimCard(payload)) {`**

n'en avait aucune.

**L.282 — avant `scheduleInteractionWork(`**

⚠️ TÂCHE DE FOND, et surtout PAS `await` — défaut mesuré en production le 2026-08-15 :

**L.283 — avant `scheduleInteractionWork(`**

un clic signé répondait 200 en **22,5 secondes**. L'email partait bien, mais Slack

**L.284 — avant `scheduleInteractionWork(`**

n'accorde que **3 secondes** à une interaction : passé ce délai il affiche une erreur.

**L.286 — avant `scheduleInteractionWork(`**

Pour un email SORTANT vers un candidat, la conséquence est sérieuse : la personne voit

**L.287 — avant `scheduleInteractionWork(`**

un échec, reclique, et le candidat reçoit DEUX invitations. Le bouton « marchait » tout

**L.288 — avant `scheduleInteractionWork(`**

en paraissant cassé — la pire des combinaisons, et exactement le genre d'écart entre le

**L.289 — avant `scheduleInteractionWork(`**

FAIT et ce qu'en perçoit l'utilisateur que ce dépôt traque partout ailleurs.

**L.291 — avant `scheduleInteractionWork(`**

`handleInterviewSend` rend déjà compte DANS LE FIL (`replyInThread`), succès comme

**L.292 — avant `scheduleInteractionWork(`**

échec : rien n'est perdu à répondre tout de suite. C'est le régime déjà retenu pour

**L.293 — avant `scheduleInteractionWork(`**

`view_submission`, énoncé en tête de ce fichier ; l'envoi d'entretien était resté sur le

**L.294 — avant `scheduleInteractionWork(`**

chemin synchrone alors qu'il fait un SMTP complet PUIS un appel Slack.

**L.304 — avant `logger.debug('block_actions sans action connue', {`**

⚠️ PLUS AUCUNE MODALE — 2026-08-19, et c'est une constatation, pas une préférence.

**L.306 — avant `logger.debug('block_actions sans action connue', {`**

Les deux boutons qui en ouvraient une (« Compléter mon profil », « Parlons de toi »)

**L.307 — avant `logger.debug('block_actions sans action connue', {`**

dépendaient d'un `trigger_id` valable 3 secondes. Mesuré ce jour-là sur un clic SIGNÉ en

**L.308 — avant `logger.debug('block_actions sans action connue', {`**

production : l'ACK mettait 5 229 ms à froid, 9 173 ms sur un déploiement neuf. Le portier

**L.309 — avant `logger.debug('block_actions sans action connue', {`**

d'ACK (`scripts/slack-ack-function/`) a ramené l'accusé sous la seconde, mais il ne peut

**L.310 — avant `logger.debug('block_actions sans action connue', {`**

pas sauver une modale : il répond vite parce qu'il ne connaît rien du produit, et

**L.311 — avant `logger.debug('block_actions sans action connue', {`**

l'ouverture a lieu ensuite, dans la fonction restée froide. Journaux à l'appui :

**L.312 — avant `logger.debug('block_actions sans action connue', {`**

`Unable to open the profile modal … invalid_trigger_id`.

**L.314 — avant `logger.debug('block_actions sans action connue', {`**

Les deux parcours sont désormais CONVERSATIONNELS (`profile-chat.ts`, `interview-chat.ts`)

**L.315 — avant `logger.debug('block_actions sans action connue', {`**

: zéro token, zéro `trigger_id`, et rien à ouvrir dans les trois secondes.

**L.317 — avant `logger.debug('block_actions sans action connue', {`**

⚠️ `trigger_id` n'est plus lu nulle part ici. Le laisser en garde d'entrée ferait échouer

**L.318 — avant `logger.debug('block_actions sans action connue', {`**

des boutons qui n'en ont aucun besoin — la faute déjà corrigée pour « Envoyer » et

**L.319 — avant `logger.debug('block_actions sans action connue', {`**

« Annuler ».

**L.326 — avant `let cachedEmailProvider: EmailProvider | undefined;`**

 -------------------------------------------------------------------------- *
Recrutement — l'envoi réel de l'invitation d'entretien

**L.332 — avant `function getEmailProvider(): EmailProvider {`**

⚠️ Construit PARESSEUSEMENT et partagé avec `src/mastra/index.ts` via la fabrique commune :
une copie du choix SMTP/Brevo ferait partir les emails d'entretien par un fournisseur et
ceux de notification par un autre, sans que rien ne le signale.

**L.342 — avant `export function resetRecruitmentDependencies(): void {`**

 Réinitialise le singleton (tests).

**L.347 — avant `function scheduleInteractionWork(label: string, work: Promise<unknown>): void {`**

Programme un travail de fond ET signale s'il ne survivra pas au gel de la fonction.

⚠️ `scheduleBackgroundWork` rend `'vercel-wait-until' | 'detached'`. La route Events
exploite ce verdict depuis l'origine (« Slack background work is detached on Vercel ») ;
cette route-ci l'IGNORAIT à ses quatre sites d'appel. Or c'est ici que vivent l'envoi de
l'email d'entretien, le workflow d'onboarding complet et l'enregistrement de l'entretien :
si `waitUntil` venait à disparaître, ces trois-là seraient tués en vol **sans une seule
ligne de journal**, après avoir répondu 200 à l'utilisateur.

`label` nomme le travail perdu — sans lui, la ligne d'alerte ne dirait pas lequel.

**L.368 — avant `async function replyInThread(payload: SlackInteractionPayload, text: string): Promise<void> {`**

Répond dans le fil de la carte — jamais à la racine, la carte y serait orpheline.

⚠️ Cette phrase était FAUSSE jusqu'au 2026-08-18 : la fonction appelait `sendMessage`, qui
n'avait aucun paramètre de fil, et le `thread_ts` du payload — pourtant déclaré dans le
type — n'était lu nulle part. « C'est envoyé à … » atterrissait donc à la racine du canal.

`thread_ts ?? ts` : si la carte est elle-même dans un fil on y reste ; sinon on OUVRE le
fil sous la carte. Dans les deux cas la confirmation est attachée à ce qu'elle confirme.

**L.382 — avant `const isDirectMessage = channel.startsWith('D');`**

⚠️ JAMAIS dans un DM, et c'est une règle établie de ce dépôt : threader un DM enfouit

**L.383 — avant `const isDirectMessage = channel.startsWith('D');`**

le message hors de la conversation principale, ce qui a déjà fait paraître ce bot muet

**L.384 — avant `const isDirectMessage = channel.startsWith('D');`**

pendant des heures. `resolveThreadTarget`, côté handler d'événements, applique

**L.385 — avant `const isDirectMessage = channel.startsWith('D');`**

exactement le même critère — un canal `D…` EST la conversation, il n'y a rien à

**L.386 — avant `const isDirectMessage = channel.startsWith('D');`**

threader. En canal, en revanche, la confirmation doit rester attachée à la carte

**L.387 — avant `const isDirectMessage = channel.startsWith('D');`**

qu'elle confirme.

**L.394 — avant `logger.error('Réponse de confirmation non postée', { error: String(error) });`**

Ne jamais propager : Slack rejouerait l'interaction, donc l'email partirait DEUX FOIS.

**L.395 — avant `logger.error('Réponse de confirmation non postée', { error: String(error) });`**

Un accusé perdu est bénin ; un second email à un candidat ne l'est pas.

**L.400 — avant `const settledCards = new Set<string>();`**

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

**L.416 — avant `function cardKey(payload: SlackInteractionPayload): string | null {`**

 Une carte est identifiée par le message qui la porte.

**L.423 — avant `function claimCard(payload: SlackInteractionPayload): boolean {`**

Prend la carte, ou refuse. Une carte prise ne peut plus rien déclencher.

Sans clé identifiable (payload sans `message`), on LAISSE PASSER : refuser casserait le
chemin nominal sur un détail de forme, et c'est la neutralisation visuelle qui porte alors
seule la garantie.

**L.438 — avant `function releaseCard(payload: SlackInteractionPayload): void {`**

Rend une carte prise — elle redevient cliquable.

Deux cas, et un seul principe : on ne consomme la carte que si le clic a EU un effet. Un
échec SMTP n'a rien envoyé, donc réessayer est la bonne conduite ; et un clic par un
témoin non autorisé ne doit pas détruire l'invitation du demandeur légitime, sans quoi le
contrôle d'accès deviendrait un déni de service.

**L.451 — avant `export function resetSettledCards(): void {`**

 Réservé aux tests : la garde est un état de module, il doit pouvoir repartir à zéro.

**L.456 — avant `async function settleCard(`**

Réécrit la carte sans ses boutons, avec le verdict à la place.

⚠️ Ne lève jamais et n'est jamais bloquant : une carte non réécrite est une gêne, alors
qu'une exception ici empêcherait le message de confirmation de partir. La garantie de
non-répétition est portée par `claimCard`, pas par cet appel réseau.

**L.483 — avant `async function handleInterviewSend(`**

Clic sur « Envoyer » — le SEUL endroit du système où un email part vers une adresse
extérieure non contrainte par l'annuaire.

⚠️ **Rien n'est rejoué sur confiance.** Le bouton ne transporte que des CHAMPS ; le sujet et
le corps sont re-rendus ici par le même gabarit, et la date est re-validée. Transporter le
corps dans le `value` aurait fait de ce bouton un moyen d'envoyer un texte arbitraire à une
adresse arbitraire — c'est-à-dire exactement la primitive d'exfiltration que toute la
feature est construite pour ne pas offrir.

**L.505 — avant `const clicker = payload.user?.id ?? '';`**

⚠️ Le cliqueur DOIT être celui qui a préparé l'invitation. La carte est visible de tous

**L.506 — avant `const clicker = payload.user?.id ?? '';`**

ceux qui voient le fil : sans ce contrôle, un témoin écrirait à l'extérieur au nom de

**L.507 — avant `const clicker = payload.user?.id ?? '';`**

l'entreprise. Même famille de défaut que la modale de profil en canal.

**L.511 — avant `releaseCard(payload);`**

⚠️ La carte n'est PAS neutralisée ici, et c'est voulu : le demandeur légitime doit

**L.512 — avant `releaseCard(payload);`**

encore pouvoir envoyer. Un témoin qui clique ne doit pas pouvoir détruire l'invitation

**L.513 — avant `releaseCard(payload);`**

de quelqu'un d'autre — ce serait transformer un contrôle d'accès en déni de service.

**L.514 — avant `releaseCard(payload);`**

La prise faite plus haut est donc RENDUE.

**L.520 — avant `const parsed = parseInterviewSchedule(confirm.startsAt, new Date());`**

Re-validation : entre la préparation et le clic, la date a pu devenir passée.

**L.525 — avant `await settleCard(payload, expired);`**

Neutralisée : cette carte ne pourra plus jamais rien envoyer, sa date est périmée.

**L.542 — avant `logger.error('Email d’entretien NON envoyé', { error: String(error) });`**

⚠️ On ne prétend JAMAIS avoir envoyé. Troisième occurrence de cette discipline dans ce

**L.543 — avant `logger.error('Email d’entretien NON envoyé', { error: String(error) });`**

dépôt, après `emailSent: false` sous `status: 'success'` et `status = Sent` avant le try.

**L.545 — avant `releaseCard(payload);`**

⚠️ On REND la prise : rien n'est parti, donc réessayer est légitime — et c'est même la

**L.546 — avant `releaseCard(payload);`**

seule chose à faire. Neutraliser la carte ici obligerait à tout redemander au modèle,

**L.547 — avant `releaseCard(payload);`**

soit un aller-retour LLM complet pour une panne SMTP de trente secondes.

**L.553 — avant `logger.info('Invitation d’entretien envoyée', {`**

⚠️ Aucune écriture en base, et c'est un choix : `RecipientType` n'a pas de valeur honnête

**L.554 — avant `logger.info('Invitation d’entretien envoyée', {`**

pour un candidat, et en ajouter une contaminerait le schéma de `sendNotification`. Surtout,

**L.555 — avant `logger.info('Invitation d’entretien envoyée', {`**

stocker l'adresse et l'invitation d'un NON-SALARIÉ créerait des données personnelles sans

**L.556 — avant `logger.info('Invitation d’entretien envoyée', {`**

chemin d'effacement — le trou que `TODO.md` recense déjà pour `notifications` et

**L.557 — avant `logger.info('Invitation d’entretien envoyée', {`**

`documents`. La trace vit dans le fil Slack, que les intéressés lisent, et ici en journal.

**L.566 — avant `await settleCard(payload, sent, confirmFacts(confirm, parsed.schedule.humanReadable));`**

La carte porte désormais le verdict, à l'endroit exact où l'on a cliqué : c'est ce qui

**L.567 — avant `await settleCard(payload, sent, confirmFacts(confirm, parsed.schedule.humanReadable));`**

évite le second clic bien plus sûrement qu'un message posté à côté.

**L.572 — avant `let cachedEmployeeRepo: DrizzleEmployeeRepository | undefined;`**

Écrit à la personne qui vient de valider la modale.

⚠️ Le canal est son DM, jamais le canal d'origine : la soumission d'un profil est privée
par nature, et `slackUserId` EST une clé de conversation directe valide pour
`chat.postMessage`.

Ne lève jamais : ce message accompagne un verdict, il ne doit pas pouvoir en produire un
second. Un échec ici est journalisé et rien de plus.

**L.582 — avant `let cachedEmployeeRepo: DrizzleEmployeeRepository | undefined;`**

Dépôt employé, construit PARESSEUSEMENT — même raison que `interviewRepo` plus bas : ce
module est évalué au chargement, donc sur le chemin de l'ACK. Ouvrir une connexion Turso à
l'import y ajouterait le handshake complet.

**L.593 — avant `async function answerProfileDone(prefill: NewcomerIdentity): Promise<void> {`**

Répond à « C'est fait » : on REGARDE la base, et on ne dit que ce qu'on y a vu.

⚠️ La résolution se fait par EMAIL, la seule clé que Slack nous donne et que `employees`
porte aussi — il n'existe aucune colonne `slack_user_id` dans cette table. Une adresse
absente du profil Slack rend donc `null`, ce qui est traité comme « aucun dossier » : c'est
exact, on n'a effectivement rien pu constater, et la réponse propose le formulaire.

⚠️ La note d'échec ne prétend JAMAIS que la vérification a réussi. Une base indisponible
n'est pas un dossier incomplet, et confondre les deux dirait à un arrivant que son dossier
est en défaut alors que c'est le nôtre.

**L.616 — avant `await rememberAsked(prefill.slackUserId, verdict.reply);`**

⚠️ UN SEUL CHEMIN DEPUIS LE 2026-08-19, et c'est la disparition de la dernière modale du

**L.617 — avant `await rememberAsked(prefill.slackUserId, verdict.reply);`**

produit. Le cas incomplet posait ici un bouton « Compléter mon profil » ouvrant une

**L.618 — avant `await rememberAsked(prefill.slackUserId, verdict.reply);`**

fenêtre ; elle ne s'ouvrait jamais. Un `trigger_id` expire 3 secondes après le clic, et le

**L.619 — avant `await rememberAsked(prefill.slackUserId, verdict.reply);`**

démarrage à froid de la fonction applicative a été mesuré à 5,2 s ce jour-là, sur un clic

**L.620 — avant `await rememberAsked(prefill.slackUserId, verdict.reply);`**

signé en production. Le portier d'ACK a ramené l'accusé de réception sous la seconde, mais

**L.621 — avant `await rememberAsked(prefill.slackUserId, verdict.reply);`**

il ne peut pas sauver une modale : il répond vite précisément parce qu'il ne connaît rien

**L.622 — avant `await rememberAsked(prefill.slackUserId, verdict.reply);`**

du produit, et l'ouverture a lieu ensuite, dans la fonction restée froide. Journaux à

**L.623 — avant `await rememberAsked(prefill.slackUserId, verdict.reply);`**

l'appui : `Unable to open the profile modal … invalid_trigger_id`.

**L.625 — avant `await rememberAsked(prefill.slackUserId, verdict.reply);`**

`verdict.reply` porte donc, dans TOUS les cas, la question suivante — celle de l'entretien

**L.626 — avant `await rememberAsked(prefill.slackUserId, verdict.reply);`**

quand le dossier est complet, celle du premier champ manquant sinon. Les deux machines à

**L.627 — avant `await rememberAsked(prefill.slackUserId, verdict.reply);`**

états lisent le même endroit : le dernier tour `assistant` du fil.

**L.643 — avant `async function rememberAsked(slackUserId: string | undefined, text: string): Promise<void> {`**

 Poste un texte en DM et l'inscrit dans la mémoire du fil — voir ci-dessus.

**L.669 — avant `const OBSOLETE_FORM_REPLY =`**

════════════════════════════════════════════════════════════════════════════
IL N'Y A PLUS AUCUN FORMULAIRE — mais ce chemin ne se tait pas pour autant
════════════════════════════════════════════════════════════════════════════

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

**L.706 — avant `return ack();`**

⚠️ Un ACK NU, jamais `response_action: 'errors'`. Slack réafficherait la modale avec un

**L.707 — avant `return ack();`**

message par champ, donc laisserait croire qu'un champ est à corriger — alors que c'est le

**L.708 — avant `return ack();`**

formulaire entier qui n'existe plus. La fenêtre doit se fermer, et l'explication arriver

**L.709 — avant `return ack();`**

en DM, là où la personne pourra répondre.

**L.716 — avant `const rawBody = await c.req.text();`**

Corps BRUT d'abord : le HMAC porte dessus, et le lire autrement

**L.717 — avant `const rawBody = await c.req.text();`**

(`c.req.parseBody()`) consommerait le flux.

**L.734 — avant `if (params.get('ssl_check') === '1') {`**

À l'enregistrement de la Request URL, Slack envoie un POST `ssl_check=1`

**L.735 — avant `if (params.get('ssl_check') === '1') {`**

SANS champ `payload`. Répondre autrement qu'un 200 fait REFUSER l'URL —

**L.736 — avant `if (params.get('ssl_check') === '1') {`**

et donc la fonctionnalité entière n'existe jamais.

**L.742 — avant `const encoded = params.get('payload');`**

`URLSearchParams.get` décode déjà le pourcentage : un `decodeURIComponent`

**L.743 — avant `const encoded = params.get('payload');`**

supplémentaire lèverait « URI malformed » sur le moindre accent.

**L.765 — avant `export const SLACK_INTERACTIONS_WORK_PATH = '/internal/slack/interactions';`**

Le chemin INTERNE, où le portier d'ACK rejoue la requête. Voir `SLACK_EVENTS_WORK_PATH`
pour le raisonnement complet — en deux mots : la même route, la même vérification de
signature, un chemin distinct pour que le routage Vercel ne boucle pas sur lui-même.

**L.775 — avant `requiresAuth: false,`**

OBLIGATOIRE : `server.auth` est actif (src/mastra/index.ts). Sans cette

**L.776 — avant `requiresAuth: false,`**

ligne, chaque requête Slack prend un 401 et Slack finit par désactiver

**L.777 — avant `requiresAuth: false,`**

l'endpoint — sans autre symptôme qu'une modale qui ne s'ouvre jamais.

## `infrastructure/audit/audit-log.ts`

**L.6 — avant `export interface AuditEntry {`**

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

**L.29 — avant `action: string;`**

 Verbe en majuscules : `SLACK_MESSAGE`, `AUTHZ_DENIED`, `RATE_LIMITED`.

**L.31 — avant `actorId: string;`**

 Identifiant Slack de la personne. Jamais vide — c'est le point de tout le fichier.

**L.36 — avant `status?: 'success' | 'accepted' | 'failure' | 'denied';`**

⚠️ `accepted` a été AJOUTÉ le 2026-08-19, et il manquait à un endroit précis.

Le défaut par défaut est `success`, ce qui est juste pour une action qu'on journalise
APRÈS l'avoir accomplie. Le site `SLACK_MESSAGE` écrit AVANT tout traitement — avant le
débit du budget, avant l'appel d'agent, avant la publication — et aucun chemin ne met la
ligne à jour ensuite : un message qui a épuisé le quota ou levé dans l'agent était
enregistré `success`. Même forme que `status = 'Sent'` posé avant le `try`.

`accepted` dit exactement ce qui a été constaté à cet instant : la demande est entrée. Rien
de plus, et c'est vrai.

**L.55 — avant `export async function writeAuditLog(`**

Écrit une ligne d'audit. **NE LÈVE JAMAIS, et n'est jamais attendue sur le chemin critique.**

Le raisonnement est le même que pour la déduplication partagée et le marqueur de progression :
une panne de la table d'audit ne doit pas devenir une panne du produit. Un journal manquant se
constate et se rattrape ; un bot muet a déjà coûté des heures à ce dépôt.

⚠️ La contrepartie est réelle et il faut la nommer : ce n'est PAS un journal d'audit de
conformité — un tel journal doit refuser l'action quand il ne peut pas l'enregistrer. C'est
une piste d'observabilité fiable en marche normale. La ligne à chercher quand elle manque :
    Audit log write failed

## `infrastructure/database/connection.ts`

**L.1 — avant `import { drizzle } from 'drizzle-orm/libsql';`**

============================================

**L.2 — avant `import { drizzle } from 'drizzle-orm/libsql';`**

db/connection.ts - Production-Grade DB Connection Manager (LibSQL/Turso)

**L.3 — avant `import { drizzle } from 'drizzle-orm/libsql';`**

Standards 2026: Serverless-safe, Migrations, Graceful Shutdown

**L.4 — avant `import { drizzle } from 'drizzle-orm/libsql';`**

============================================

**L.14 — avant `type DatabaseInstance = LibSQLDatabase<typeof schema>;`**

============================================

**L.15 — avant `type DatabaseInstance = LibSQLDatabase<typeof schema>;`**

1. TYPES

**L.16 — avant `type DatabaseInstance = LibSQLDatabase<typeof schema>;`**

============================================

**L.21 — avant `dbUrl: string;`**

 URL de connexion Turso/LibSQL

**L.23 — avant `authToken: string;`**

 Token d'authentification Turso

**L.25 — avant `autoMigrate: boolean;`**

 Exécuter les migrations au démarrage

**L.27 — avant `migrationsFolder: string;`**

 Dossier des migrations

**L.45 — avant `const DEFAULT_CONFIG: ConnectionConfig = {`**

============================================

**L.46 — avant `const DEFAULT_CONFIG: ConnectionConfig = {`**

2. CONFIGURATION PAR DÉFAUT

**L.47 — avant `const DEFAULT_CONFIG: ConnectionConfig = {`**

============================================

**L.56 — avant `let dbShutdownHandlersRegistered = false;`**

Flag module-scope pour éviter l'enregistrement multiple des handlers OS

**L.59 — avant `class LibSqlConnectionManager implements ConnectionManager {`**

============================================

**L.60 — avant `class LibSqlConnectionManager implements ConnectionManager {`**

3. CONNECTION MANAGER (Serverless-Safe)

**L.61 — avant `class LibSqlConnectionManager implements ConnectionManager {`**

============================================

**L.75 — avant `getDb(): DatabaseInstance {`**

============================================

**L.76 — avant `getDb(): DatabaseInstance {`**

PUBLIC API

**L.77 — avant `getDb(): DatabaseInstance {`**

============================================

**L.79 — avant `getDb(): DatabaseInstance {`**

Récupère l'instance de base de données

**L.94 — avant `async close(): Promise<void> {`**

Ferme proprement la connexion

**L.127 — avant `async healthCheck(): Promise<boolean> {`**

Vérifie l'état de santé de la connexion

**L.159 — avant `getStats(): DatabaseStats {`**

Récupère les statistiques de la base de données

**L.171 — avant `private connect(): void {`**

============================================

**L.172 — avant `private connect(): void {`**

PRIVATE METHODS

**L.173 — avant `private connect(): void {`**

============================================

**L.175 — avant `private connect(): void {`**

Établit la connexion à la base de données

**L.191 — avant `this.runMigrations().catch((e) => {`**

En mode Turso/Serverless, c'est généralement déconseillé de migrer au runtime.

**L.192 — avant `this.runMigrations().catch((e) => {`**

Mais si config.autoMigrate est activé (ex: tests locaux), on le lance de manière asynchrone.

**L.230 — avant `private async runMigrations(): Promise<void> {`**

Exécute les migrations Drizzle

**L.264 — avant `private setupGracefulShutdown(): void {`**

Configure le graceful shutdown

**L.293 — avant `export class DatabaseConnectionError extends Error {`**

============================================

**L.294 — avant `export class DatabaseConnectionError extends Error {`**

4. ERREURS PERSONNALISÉES

**L.295 — avant `export class DatabaseConnectionError extends Error {`**

============================================

**L.321 — avant `let connectionManager: ConnectionManager | null = null;`**

============================================

**L.322 — avant `let connectionManager: ConnectionManager | null = null;`**

5. INSTANCE SINGLETON (Serverless-Safe)

**L.323 — avant `let connectionManager: ConnectionManager | null = null;`**

============================================

## `infrastructure/database/schema.ts`

**L.1 — avant `import {`**

============================================

**L.2 — avant `import {`**

db/schema.ts - Production-Grade Drizzle Schema

**L.3 — avant `import {`**

Standards 2026: FKs, Indexes, Soft Delete, Audit Trail

**L.4 — avant `import {`**

============================================

**L.19 — avant `export const employees = sqliteTable(`**

============================================

**L.20 — avant `export const employees = sqliteTable(`**

1. EMPLOYEES

**L.21 — avant `export const employees = sqliteTable(`**

============================================

**L.31 — avant `department: text('department'),`**

NULLABLE depuis le 2026-08-13 : le parcours d'arrivée ne demande plus le département —
la modale « Compléter mon profil » ne pose qu'une question, le poste.

`NULL` est le seul encodage honnête de « on a délibérément cessé de collecter ça ». Une
sentinelle dans une colonne NOT NULL finit toujours par être relue comme une vraie
valeur, mode d'échec récurrent de ce dépôt.

⚠️ DDL : `scripts/ddl-employees-department-nullable.sql`, à appliquer AVANT le
déploiement. `idx_employees_department` y est supprimé et non recréé — une colonne
qu'on ne renseigne plus n'a aucune raison d'être indexée.

**L.46 — avant `onboardingStatus: text('onboarding_status').notNull().default('not_started'), // OnboardingStatu`**

EmployeeStatus

**L.47 — avant `managerId: text('manager_id'),`**

OnboardingStatus

**L.54 — avant `createdAt: text('created_at')`**

Record<string, unknown>

**L.56 — avant `createdAt: text('created_at')`**

Timestamps

**L.63 — avant `},`**

Soft delete

**L.66 — avant `emailIdx: uniqueIndex('idx_employees_email').on(table.email),`**

Indexes

**L.75 — avant `emailCheck: check('chk_employees_email', sql`${table.email} LIKE '%@%'`),`**

Contrainte: email doit contenir '@'

**L.80 — avant `export const tasks = sqliteTable(`**

============================================

**L.81 — avant `export const tasks = sqliteTable(`**

2. TASKS

**L.82 — avant `export const tasks = sqliteTable(`**

============================================

**L.89 — avant `reviewerId: text('reviewer_id'), // Pour les tâches de type Review`**

La personne qui exécute (peut différer de employeeId)

**L.90 — avant `title: text('title').notNull(),`**

Pour les tâches de type Review

**L.94 — avant `status: text('status').notNull().default('pending'), // TaskStatus`**

TaskType

**L.95 — avant `priority: text('priority').notNull().default('medium'), // TaskPriority`**

TaskStatus

**L.96 — avant `dueDate: text('due_date'),`**

TaskPriority

**L.105 — avant `metadata: text('metadata', { mode: 'json' }), // Record<string, unknown>`**

string[]

**L.106 — avant `createdAt: text('created_at')`**

Record<string, unknown>

**L.108 — avant `createdAt: text('created_at')`**

Timestamps

**L.115 — avant `},`**

Soft delete

**L.118 — avant `employeeFk: foreignKey(() => ({`**

Foreign Keys

**L.135 — avant `employeeIdx: index('idx_tasks_employee').on(table.employeeId),`**

Indexes

**L.148 — avant `export const documents = sqliteTable(`**

============================================

**L.149 — avant `export const documents = sqliteTable(`**

3. DOCUMENTS

**L.150 — avant `export const documents = sqliteTable(`**

============================================

**L.157 — avant `type: text('type').notNull(), // DocumentType`**

Si généré depuis un template

**L.159 — avant `title: text('title').notNull(),`**

DocumentType

**L.163 — avant `content: text('content'),`**

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

**L.186 — avant `storageKey: text('storage_key'), // Clé S3/GCS`**

Stockage : on stocke la référence S3, pas le contenu

**L.187 — avant `storageBucket: text('storage_bucket'),`**

Clé S3/GCS

**L.190 — avant `mimeType: text('mime_type'),`**

En bytes

**L.193 — avant `status: text('status').notNull().default('pending'), // DocumentStatus`**

DocumentFormat

**L.194 — avant `version: integer('version').notNull().default(1),`**

DocumentStatus

**L.204 — avant `createdAt: text('created_at')`**

Record<string, unknown>

**L.206 — avant `createdAt: text('created_at')`**

Timestamps

**L.213 — avant `},`**

Soft delete

**L.216 — avant `employeeFk: foreignKey(() => ({`**

Foreign Keys

**L.223 — avant `employeeIdx: index('idx_documents_employee').on(table.employeeId),`**

Indexes

**L.234 — avant `export const notifications = sqliteTable(`**

============================================

**L.235 — avant `export const notifications = sqliteTable(`**

4. NOTIFICATIONS

**L.236 — avant `export const notifications = sqliteTable(`**

============================================

**L.243 — avant `channel: text('channel').notNull(), // NotificationChannel`**

RecipientType

**L.244 — avant `priority: text('priority').notNull().default('normal'), // NotificationPriority`**

NotificationChannel

**L.245 — avant `templateId: text('template_id'),`**

NotificationPriority

**L.248 — avant `subject: text('subject').notNull(),`**

Record<string, unknown>

**L.253 — avant `errorMessage: text('error_message'),`**

NotificationStatus

**L.262 — avant `createdAt: text('created_at')`**

Record<string, unknown>

**L.264 — avant `createdAt: text('created_at')`**

Timestamps

**L.273 — avant `recipientIdx: index('idx_notifications_recipient').on(table.recipientId, table.recipientType),`**

Indexes

**L.283 — avant `export const questionnaires = sqliteTable(`**

============================================

**L.284 — avant `export const questionnaires = sqliteTable(`**

5. QUESTIONNAIRES

**L.285 — avant `export const questionnaires = sqliteTable(`**

============================================

**L.291 — avant `title: text('title').notNull(),`**

Nullable: questionnaire peut être un template

**L.295 — avant `questions: text('questions', { mode: 'json' }).notNull(), // Question[]`**

'onboarding', 'feedback', 'evaluation', 'exit'

**L.297 — avant `status: text('status').notNull().default('draft'), // QuestionnaireStatus`**

Question[]

**L.299 — avant `isAnonymous: integer('is_anonymous', { mode: 'boolean' }).default(false),`**

QuestionnaireStatus

**L.302 — avant `dueDate: text('due_date'),`**

Qui a assigné le questionnaire

**L.307 — avant `createdAt: text('created_at')`**

Timestamps

**L.319 — avant `employeeFk: foreignKey(() => ({`**

Foreign Keys

**L.326 — avant `employeeIdx: index('idx_questionnaires_employee').on(table.employeeId),`**

Indexes

**L.335 — avant `export const questionnaireResponses = sqliteTable(`**

============================================

**L.336 — avant `export const questionnaireResponses = sqliteTable(`**

6. QUESTIONNAIRE RESPONSES

**L.337 — avant `export const questionnaireResponses = sqliteTable(`**

============================================

**L.346 — avant `status: text('status').notNull().default('pending'), // ResponseStatus`**

QuestionResponse[]

**L.348 — avant `score: real('score'),`**

ResponseStatus

**L.351 — avant `timeSpentSeconds: integer('time_spent_seconds'),`**

0-100

**L.361 — avant `createdAt: text('created_at')`**

Timestamps

**L.370 — avant `questionnaireFk: foreignKey(() => ({`**

Foreign Keys

**L.387 — avant `uniqueEmployeeQuestionnaire: uniqueIndex('uq_responses_employee_questionnaire').on(`**

Unique: un employé ne peut répondre qu'une fois à un questionnaire

**L.388 — avant `uniqueEmployeeQuestionnaire: uniqueIndex('uq_responses_employee_questionnaire').on(`**

(sauf si le questionnaire le permet explicitement)

**L.394 — avant `questionnaireIdx: index('idx_responses_questionnaire').on(table.questionnaireId),`**

Indexes

**L.402 — avant `export const onboardingProgress = sqliteTable(`**

============================================

**L.403 — avant `export const onboardingProgress = sqliteTable(`**

7. ONBOARDING PROGRESS

**L.404 — avant `export const onboardingProgress = sqliteTable(`**

============================================

**L.411 — avant `status: text('status').notNull().default('not_started'), // OnboardingStatus`**

Si basé sur un template d'onboarding

**L.413 — avant `currentStep: integer('current_step').notNull().default(0),`**

OnboardingStatus

**L.416 — avant `startedAt: text('started_at'),`**

0-100

**L.423 — avant `metadata: text('metadata', { mode: 'json' }), // Record<string, unknown>`**

Référent/parrain

**L.425 — avant `createdAt: text('created_at')`**

Record<string, unknown>

**L.427 — avant `createdAt: text('created_at')`**

Timestamps

**L.436 — avant `employeeFk: foreignKey(() => ({`**

Foreign Keys

**L.448 — avant `uniqueEmployee: uniqueIndex('uq_onboarding_employee').on(table.employeeId),`**

Unique: un seul onboarding actif par employé

**L.451 — avant `statusIdx: index('idx_onboarding_progress_status').on(table.status),`**

Indexes

**L.457 — avant `export const onboardingSteps = sqliteTable(`**

============================================

**L.458 — avant `export const onboardingSteps = sqliteTable(`**

8. ONBOARDING STEPS

**L.459 — avant `export const onboardingSteps = sqliteTable(`**

============================================

**L.466 — avant `name: text('name').notNull(),`**

Optionnel: lié à une tâche existante

**L.471 — avant `status: text('status').notNull().default('pending'), // TaskStatus`**

'documents', 'training', 'meetings', 'setup'

**L.473 — avant `isRequired: integer('is_required', { mode: 'boolean' }).notNull().default(true),`**

TaskStatus

**L.476 — avant `startedAt: text('started_at'),`**

Qui est responsable de cette étape

**L.484 — avant `createdAt: text('created_at')`**

Record<string, unknown>

**L.486 — avant `createdAt: text('created_at')`**

Timestamps

**L.495 — avant `progressFk: foreignKey(() => ({`**

Foreign Keys

**L.507 — avant `progressIdx: index('idx_onboarding_steps_progress').on(table.progressId),`**

Indexes

**L.515 — avant `export const employeeDocuments = sqliteTable(`**

============================================

**L.516 — avant `export const employeeDocuments = sqliteTable(`**

9. EMPLOYEE DOCUMENTS (Junction Table)

**L.517 — avant `export const employeeDocuments = sqliteTable(`**

============================================

**L.526 — avant `status: text('status').notNull().default('pending'), // 'pending', 'acknowledged', 'signed', 'ex`**

Statut spécifique à l'association employé-document

**L.527 — avant `acknowledgedAt: text('acknowledged_at'),`**

'pending', 'acknowledged', 'signed', 'expired'

**L.531 — avant `createdAt: text('created_at')`**

Timestamps

**L.540 — avant `employeeFk: foreignKey(() => ({`**

Foreign Keys

**L.552 — avant `uniqueEmployeeDocument: uniqueIndex('uq_employee_document').on(`**

Unique: un document ne peut être assigné qu'une fois à un employé

**L.558 — avant `employeeIdx: index('idx_employee_documents_employee').on(table.employeeId),`**

Indexes

**L.565 — avant `export const auditLogs = sqliteTable(`**

============================================

**L.566 — avant `export const auditLogs = sqliteTable(`**

10. AUDIT LOGS (Enriched)

**L.567 — avant `export const auditLogs = sqliteTable(`**

============================================

**L.573 — avant `actorId: text('actor_id').notNull(),`**

e.g., 'CREATE_EMPLOYEE', 'SEND_NOTIFICATION'

**L.575 — avant `actorEmail: text('actor_email'),`**

'user', 'system', 'api', 'webhook'

**L.579 — avant `details: text('details', { mode: 'json' }), // { before, after, changes }`**

'Employee', 'Task', 'Document', etc.

**L.581 — avant `ipAddress: text('ip_address'),`**

{ before, after, changes }

**L.583 — avant `ipAddress: text('ip_address'),`**

Contexte de la requête

**L.590 — avant `status: text('status').notNull().default('success'), // 'success', 'failure', 'denied'`**

Statut

**L.591 — avant `errorMessage: text('error_message'),`**

'success', 'failure', 'denied'

**L.594 — avant `createdAt: text('created_at')`**

Timestamp

**L.600 — avant `actorIdx: index('idx_audit_logs_actor').on(table.actorId, table.actorType),`**

Indexes

**L.611 — avant `export const conversationTurns = sqliteTable(`**

============================================

**L.612 — avant `export const conversationTurns = sqliteTable(`**

11. CONVERSATION TURNS (Mémoire conversationnelle)

**L.613 — avant `export const conversationTurns = sqliteTable(`**

============================================

**L.615 — avant `export const conversationTurns = sqliteTable(`**

Table unique de la feature `conversation`. L'agent « collant » d'un fil est simplement

**L.616 — avant `export const conversationTurns = sqliteTable(`**

l'`agent_id` du dernier tour : la requête de fenêtre le ramène déjà, aucune seconde table

**L.617 — avant `export const conversationTurns = sqliteTable(`**

n'est nécessaire.

**L.619 — avant `export const conversationTurns = sqliteTable(`**

⚠️ Écart ASSUMÉ au style des 10 tables ci-dessus : elles horodatent en `text` via

**L.620 — avant `export const conversationTurns = sqliteTable(`**

`datetime('now')`, qui a une résolution à la SECONDE et un format sans fuseau. Ici

**L.621 — avant `export const conversationTurns = sqliteTable(`**

l'horodatage est le discriminant du TTL *et* de l'ordre des tours ; deux messages d'un même

**L.622 — avant `export const conversationTurns = sqliteTable(`**

échange arrivent couramment dans la même seconde, et les égalités casseraient l'ordre

**L.623 — avant `export const conversationTurns = sqliteTable(`**

chronologique dont dépend `selectWindow`. D'où un entier en millisecondes, qui donne aussi

**L.624 — avant `export const conversationTurns = sqliteTable(`**

un `Date` natif côté Drizzle — donc pas de reparsing pour l'arithmétique du TTL.

**L.630 — avant `role: text('role').notNull(), // 'user' | 'assistant'`**

`${channel}` ou `${channel}:${threadTs}`

**L.631 — avant `content: text('content').notNull(), // texte seul — jamais de tool-call ni de tool-result`**

'user' | 'assistant'

**L.632 — avant `agentId: text('agent_id').notNull(), // onboardingOrchestrator | questionnaireEngine | notificat`**

texte seul — jamais de tool-call ni de tool-result

**L.633 — avant `slackUserId: text('slack_user_id'), // null sur un tour assistant`**

onboardingOrchestrator | questionnaireEngine | notificationAgent

**L.634 — avant `createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),`**

null sur un tour assistant

**L.636 — avant `createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),`**

Timestamp

**L.640 — avant `conversationCreatedAtIdx: index('idx_conversation_turns_conversation_created_at').on(`**

Index unique servant les deux accès : fenêtre d'une conversation (égalité + tri) et purge.

**L.649 — avant `export const onboardingInterview = sqliteTable(`**

============================================

**L.650 — avant `export const onboardingInterview = sqliteTable(`**

11 ter. ONBOARDING INTERVIEW (Entretien post-profil)

**L.651 — avant `export const onboardingInterview = sqliteTable(`**

============================================

**L.653 — avant `export const onboardingInterview = sqliteTable(`**

Ce que la personne dit d'elle APRÈS avoir complété son profil : les canaux qui l'intéressent,

**L.654 — avant `export const onboardingInterview = sqliteTable(`**

ce qu'elle fait au quotidien, comment elle préfère travailler.

**L.656 — avant `export const onboardingInterview = sqliteTable(`**

── Pourquoi une table et pas `questionnaire_responses` ─────────────────────────────────

**L.657 — avant `export const onboardingInterview = sqliteTable(`**

Cette table existe déjà et porte `score`, `max_score`, `percentage`, `reviewed_by`,

**L.658 — avant `export const onboardingInterview = sqliteTable(`**

`review_notes` : elle est en forme de QUIZ CORRIGÉ. Un entretien n'a ni bonne réponse ni

**L.659 — avant `export const onboardingInterview = sqliteTable(`**

note, et sept colonnes resteraient NULL sur 100 % des lignes — un schéma qui décrit autre

**L.660 — avant `export const onboardingInterview = sqliteTable(`**

chose que ce qu'il contient finit toujours par être relu comme s'il disait vrai. Elle a de

**L.661 — avant `export const onboardingInterview = sqliteTable(`**

surcroît une clé étrangère vers `questionnaires`, qui obligerait à fabriquer une ligne de

**L.662 — avant `export const onboardingInterview = sqliteTable(`**

définition pour un formulaire écrit en dur dans le code.

**L.664 — avant `export const onboardingInterview = sqliteTable(`**

Relevé du 2026-08-14 : `questionnaire_responses` = **0 ligne** pour 5 questionnaires

**L.665 — avant `export const onboardingInterview = sqliteTable(`**

enregistrés. Personne n'a jamais pu répondre à quoi que ce soit, parce qu'aucun chemin de

**L.666 — avant `export const onboardingInterview = sqliteTable(`**

soumission n'existait. C'est ce chemin-là qu'apporte l'entretien.

**L.668 — avant `export const onboardingInterview = sqliteTable(`**

── `employee_id` EST la clé primaire ───────────────────────────────────────────────────

**L.669 — avant `export const onboardingInterview = sqliteTable(`**

Un employé a un entretien, pas une collection. Cette forme rend l'upsert trivial et

**L.670 — avant `export const onboardingInterview = sqliteTable(`**

l'invariant STRUCTUREL plutôt que conventionnel : il ne peut pas exister deux réponses

**L.671 — avant `export const onboardingInterview = sqliteTable(`**

concurrentes dont on ne saurait laquelle est courante.

**L.677 — avant `slackUserId: text('slack_user_id').notNull(),`**

 Auteur Slack — conservé pour l'effacement et pour ré-inviter sans relire `employees`.

**L.679 — avant `channels: text('channels', { mode: 'json' }).notNull(),`**

Identifiants `C…` des canaux choisis, en JSON.

Les ID et non les NOMS : un canal se renomme sans que son `C…` bouge, et c'est l'ID que
`conversations.invite` consomme. Même arbitrage que la clé de `slack_channels`.

**L.686 — avant `dailyWork: text('daily_work').notNull().default(''),`**

 Texte libre — ce que la personne fait au quotidien. Assaini avant écriture.

**L.688 — avant `workStyle: text('work_style').notNull().default(''),`**

 Texte libre — comment elle préfère travailler. Assaini avant écriture.

**L.695 — avant `slackUserIdx: index('idx_onboarding_interview_slack_user').on(table.slackUserId),`**

Sert l'effacement par personne et la relecture depuis un identifiant Slack — le seul

**L.696 — avant `slackUserIdx: index('idx_onboarding_interview_slack_user').on(table.slackUserId),`**

disponible sur le chemin d'un message.

**L.701 — avant `export const pinnedFacts = sqliteTable(`**

============================================

**L.702 — avant `export const pinnedFacts = sqliteTable(`**

11 bis. PINNED FACTS (Mémoire longue, hors TTL)

**L.703 — avant `export const pinnedFacts = sqliteTable(`**

============================================

**L.705 — avant `export const pinnedFacts = sqliteTable(`**

`conversation_turns` porte un TTL de 60 minutes et une fenêtre de 1 600 tokens : tout ce

**L.706 — avant `export const pinnedFacts = sqliteTable(`**

qu'on y écrit est destiné à disparaître. C'est le bon comportement pour un fil de

**L.707 — avant `export const pinnedFacts = sqliteTable(`**

discussion, et le mauvais pour « souviens-toi que mon poste est Backend Developer » —

**L.708 — avant `export const pinnedFacts = sqliteTable(`**

`TODO.md` le recense depuis le 2026-08-13 : la demande n'ÉPINGLAIT rien, alors que le

**L.709 — avant `export const pinnedFacts = sqliteTable(`**

modèle promettait de s'en souvenir.

**L.711 — avant `export const pinnedFacts = sqliteTable(`**

D'où une table SÉPARÉE, et non un drapeau sur `conversation_turns` : les deux ont des

**L.712 — avant `export const pinnedFacts = sqliteTable(`**

durées de vie opposées, et un `WHERE pinned = 0` dans la purge finirait par être oublié

**L.713 — avant `export const pinnedFacts = sqliteTable(`**

une fois. La séparation rend l'invariant structurel — cette table n'est JAMAIS purgée par

**L.714 — avant `export const pinnedFacts = sqliteTable(`**

le TTL.

**L.716 — avant `export const pinnedFacts = sqliteTable(`**

La clé est le `slack_user_id`, pas la conversation : un fait sur soi vaut dans tous les

**L.717 — avant `export const pinnedFacts = sqliteTable(`**

fils. C'est aussi ce qui permet à `forget()` de les emporter par la même clé.

**L.719 — avant `export const pinnedFacts = sqliteTable(`**

⚠️ Aucune borne en SQL. Le plafond (5 faits, 120 caractères) vit dans le CODE

**L.720 — avant `export const pinnedFacts = sqliteTable(`**

(`src/shared/pin-fact.ts`), parce qu'il est dicté par le budget de tokens du préambule et

**L.721 — avant `export const pinnedFacts = sqliteTable(`**

non par le stockage — et parce qu'un dépassement doit ÉVINCER le plus ancien, pas échouer.

**L.728 — avant `fact: text('fact').notNull(),`**

 Texte D'ORIGINE de la personne, assaini — jamais normalisé ni reformulé.

**L.733 — avant `userCreatedAtIdx: index('idx_pinned_facts_user_created_at').on(`**

Sert les deux accès : lecture des faits d'une personne (égalité + tri) et éviction du

**L.734 — avant `userCreatedAtIdx: index('idx_pinned_facts_user_created_at').on(`**

plus ancien. Aucun index sur `created_at` seul — rien ne purge cette table par l'âge,

**L.735 — avant `userCreatedAtIdx: index('idx_pinned_facts_user_created_at').on(`**

et c'est tout son objet.

**L.743 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

============================================

**L.744 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

11 bis. PENDING INTERVIEW EMAIL (email préparé, en attente d'un « oui »)

**L.745 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

============================================

**L.747 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

Ajoutée le 2026-08-19, quand les boutons ont été retirés du produit. La confirmation d'envoi

**L.748 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

vivait dans un Block Kit « Envoyer / Annuler » ; elle est devenue une question à laquelle on

**L.749 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

répond oui ou non.

**L.751 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

⚠️ POURQUOI UNE TABLE, alors que les deux machines à états de l'accueil n'en ont AUCUNE.

**L.752 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

Leur état est le dernier tour `assistant` du fil — gratuit, et suffisant tant que l'état ne

**L.753 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

survit pas à une digression. Ici il doit y survivre : l'exigence est de RAPPELER l'email en

**L.754 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

attente si l'on change de sujet, et de le GARDER en suspens si la personne veut vraiment

**L.755 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

changer de sujet. Un état qui doit tenir pendant qu'on parle d'autre chose ne peut pas être

**L.756 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

le dernier message du bot — par définition, ce n'est plus lui.

**L.758 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

⚠️ ON N'Y STOCKE QUE DES CHAMPS, JAMAIS LE CORPS DE L'EMAIL. C'est le contrat que portait

**L.759 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

déjà le `value` du bouton, et sa raison n'a pas changé : transporter le corps ferait de cette

**L.760 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

table un moyen d'envoyer un texte arbitraire à une adresse arbitraire, la primitive que toute

**L.761 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

la feature est construite pour ne pas offrir. Sujet et corps sont RE-RENDUS à l'envoi, la

**L.762 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

date RE-VALIDÉE.

**L.764 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

⚠️ La clé est la CONVERSATION, pas la personne : c'est dans ce fil qu'on répondra « oui ».

**L.765 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

Une seconde préparation dans la même conversation remplace la première — l'humain n'en voit

**L.766 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

qu'une à l'écran, et deux lignes signifieraient qu'un « oui » est ambigu.

**L.768 — avant `export const pendingInterviewEmail = sqliteTable('pending_interview_email', {`**

Horodatage entier en millisecondes, comme `pinned_facts` et `conversation_turns`.

**L.775 — avant `startsAt: text('starts_at').notNull(),`**

 ISO. RE-VALIDÉ à l'envoi : entre la préparation et le « oui », la date a pu passer.

**L.785 — avant `export const slackEventDedup = sqliteTable(`**

============================================

**L.786 — avant `export const slackEventDedup = sqliteTable(`**

12. SLACK EVENT DEDUP (Déduplication multi-instance)

**L.787 — avant `export const slackEventDedup = sqliteTable(`**

============================================

**L.789 — avant `export const slackEventDedup = sqliteTable(`**

Table unique de la déduplication PARTAGÉE des événements Slack. Le cache LRU du handler est

**L.790 — avant `export const slackEventDedup = sqliteTable(`**

en mémoire, donc par instance : il est incapable par construction d'écarter un rejeu routé

**L.791 — avant `export const slackEventDedup = sqliteTable(`**

vers une AUTRE instance pendant que la première traite encore l'événement — c'est-à-dire

**L.792 — avant `export const slackEventDedup = sqliteTable(`**

exactement le cas qui produit une double réponse (incident du 2026-08-11, 12:38 UTC).

**L.794 — avant `export const slackEventDedup = sqliteTable(`**

La `key` est celle du handler (`ts:<channel>:<ts>` ou `id:<event_id>`) et sert de PRIMARY

**L.795 — avant `export const slackEventDedup = sqliteTable(`**

KEY : c'est elle qui rend la prise atomique via `INSERT … ON CONFLICT DO NOTHING`.

**L.797 — avant `export const slackEventDedup = sqliteTable(`**

⚠️ Même écart assumé que `conversation_turns` sur l'horodatage : entier en millisecondes et

**L.798 — avant `export const slackEventDedup = sqliteTable(`**

non `datetime('now')` en `text`. `started_at` est le discriminant de la grâce d'abandon

**L.799 — avant `export const slackEventDedup = sqliteTable(`**

(60 s) ; une résolution à la seconde y serait grossière, et le comparer exigerait un

**L.800 — avant `export const slackEventDedup = sqliteTable(`**

reparsing à chaque prise de clé — sur le chemin d'ACK, celui qui a 3 secondes.

**L.805 — avant `status: text('status').notNull(), // 'in-flight' | 'done'`**

`ts:<channel>:<ts>` ou `id:<event_id>`

**L.806 — avant `startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),`**

'in-flight' | 'done'

**L.810 — avant `startedAtIdx: index('idx_slack_event_dedup_started_at').on(table.startedAt),`**

Sert la purge de rétention (~10 min, la fenêtre de rejeu de Slack). L'accès par clé

**L.811 — avant `startedAtIdx: index('idx_slack_event_dedup_started_at').on(table.startedAt),`**

passe déjà par l'index implicite de la PRIMARY KEY.

**L.816 — avant `export const slackDirectory = sqliteTable(`**

============================================

**L.817 — avant `export const slackDirectory = sqliteTable(`**

13. SLACK DIRECTORY (Annuaire du workspace — autorisation)

**L.818 — avant `export const slackDirectory = sqliteTable(`**

============================================

**L.820 — avant `export const slackDirectory = sqliteTable(`**

Ce qui manquait pour que « qui parle ? » ait une réponse. `slack-events.handler.ts` lisait

**L.821 — avant `export const slackDirectory = sqliteTable(`**

`event.user` pour le journal et l'anti-boucle, puis le jetait : une chaîne `U…` opaque, dont

**L.822 — avant `export const slackDirectory = sqliteTable(`**

le système ne pouvait pas dire si elle désignait la responsable RH ou un invité mono-canal.

**L.824 — avant `export const slackDirectory = sqliteTable(`**

La table porte des FAITS que Slack maintient lui-même (`is_bot`, `is_restricted`,

**L.825 — avant `export const slackDirectory = sqliteTable(`**

`is_ultra_restricted`, `deleted`), et non une liste d'identifiants tenue à la main : ajouter

**L.826 — avant `export const slackDirectory = sqliteTable(`**

un invité au workspace le rétrograde automatiquement, sans qu'aucune variable d'environnement

**L.827 — avant `export const slackDirectory = sqliteTable(`**

ne bouge. Même exigence que `agentToolBoundary(tools)`, dérivée de `Object.keys(tools)` — ce

**L.828 — avant `export const slackDirectory = sqliteTable(`**

dépôt a déjà payé trois fois le prix d'une liste rédigée qui se désynchronise du réel.

**L.830 — avant `export const slackDirectory = sqliteTable(`**

⚠️ DDL : `scripts/ddl-slack-directory.sql`, à appliquer à la main (les migrations `drizzle/`

**L.831 — avant `export const slackDirectory = sqliteTable(`**

sont désynchronisées et `drizzle-kit push` se bloque contre une base `libsql://` distante).

**L.836 — avant `slackUserId: text('slack_user_id').primaryKey(),`**

La PRIMARY KEY est `slack_user_id`, PAS l'email : un email se change dans le profil Slack,

**L.837 — avant `slackUserId: text('slack_user_id').primaryKey(),`**

l'identifiant `U…` est immuable. Une clé portée par l'email ferait qu'un changement

**L.838 — avant `slackUserId: text('slack_user_id').primaryKey(),`**

d'adresse crée un SECOND sujet avec ses propres droits — élévation de privilège par

**L.839 — avant `slackUserId: text('slack_user_id').primaryKey(),`**

simple édition de profil.

**L.843 — avant `email: text('email'),`**

NULLABLE, et ce n'est pas de la prudence de façade : `users.list` ne rend `profile.email`

**L.844 — avant `email: text('email'),`**

que si `users:read.email` est accordé ET que le compte en porte un ; les bots n'en ont

**L.845 — avant `email: text('email'),`**

pas. La politique traite « pas d'email » comme un cas NOMMÉ, jamais comme une chaîne vide

**L.846 — avant `email: text('email'),`**

comparée à un domaine — une chaîne vide finirait par matcher.

**L.849 — avant `realName: text('real_name').notNull().default(''),`**

NOT NULL avec DEFAULT '' : ces champs sont affichés et concaténés, un NULL y imprimerait

**L.850 — avant `realName: text('real_name').notNull().default(''),`**

« null » plutôt qu'un blanc. Arbitrage inverse de `email`, qui est une CLÉ de recherche.

**L.854 — avant `firstName: text('first_name'),`**

Prénom, nom et poste — lus TELS QUELS dans `profile.first_name`, `profile.last_name` et

**L.855 — avant `firstName: text('first_name'),`**

`profile.title`, jamais dérivés de `real_name`. Sur les données réelles du workspace,

**L.856 — avant `firstName: text('first_name'),`**

découper `real_name` sur l'espace marche quatre fois sur cinq et échoue sur

**L.857 — avant `firstName: text('first_name'),`**

`ridwanenico77`, qui n'a pas de prénom mais un pseudo. Une heuristique fausse une fois

**L.858 — avant `firstName: text('first_name'),`**

sur cinq n'est pas une heuristique, c'est une invention.

**L.860 — avant `firstName: text('first_name'),`**

NULLABLES, et la nullité veut dire quelque chose : Slack rend une CHAÎNE VIDE pour un

**L.861 — avant `firstName: text('first_name'),`**

champ non renseigné, qu'on normalise en `NULL`. `''` se lirait « renseigné, mais vide ».

**L.862 — avant `firstName: text('first_name'),`**

Et comme `synced_at` prouve qu'on a interrogé Slack, `NULL` signifie ici « Slack ne le

**L.863 — avant `firstName: text('first_name'),`**

précise pas » — une absence AVÉRÉE, pas une ignorance.

**L.865 — avant `firstName: text('first_name'),`**

⚠️ `title` est le poste DÉCLARATIF, édité par son porteur. Distinct de

**L.866 — avant `firstName: text('first_name'),`**

`employees.position`, qui est le poste CONTRACTUEL : deux faits, deux sources, aucun

**L.867 — avant `firstName: text('first_name'),`**

arbitrage à écrire entre eux.

**L.872 — avant `isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),`**

Flags de CONFIANCE — matière première de la politique d'autorisation. Aucun n'est

**L.873 — avant `isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),`**

nullable : « on ne sait pas si c'est un invité » ne doit pas exister comme état, la

**L.874 — avant `isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),`**

politique devrait alors décider sur un troisième cas où le défaut sûr serait

**L.875 — avant `isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),`**

indiscernable de l'ignorance.

**L.876 — avant `isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),`**

is_restricted = invité multi-canal ; is_ultra_restricted = invité mono-canal.

**L.883 — avant `dmChannelId: text('dm_channel_id'),`**

⚠️ INDÉCOUVRABLE par balayage : `conversations.list({types:'im'})` répond `missing_scope`

**L.884 — avant `dmChannelId: text('dm_channel_id'),`**

(il faudrait `im:read`, non accordé — vérifié le 2026-08-12). La colonne se remplit

**L.885 — avant `dmChannelId: text('dm_channel_id'),`**

OPPORTUNÉMENT, au premier DM reçu, où Slack livre le canal dans `event.channel`. Vide

**L.886 — avant `dmChannelId: text('dm_channel_id'),`**

signifie « cette personne ne nous a jamais écrit en direct », pas « on ne sait pas le

**L.887 — avant `dmChannelId: text('dm_channel_id'),`**

trouver ». Corollaire : une valeur perdue l'est DÉFINITIVEMENT — d'où le `set`

**L.888 — avant `dmChannelId: text('dm_channel_id'),`**

champ-par-champ de l'upsert côté repository, qui ne la nomme jamais.

**L.891 — avant `employeeId: text('employee_id').references(() => employees.id),`**

Pont vers le métier, NULLABLE dans les deux sens : tout membre du workspace n'est pas un

**L.892 — avant `employeeId: text('employee_id').references(() => employees.id),`**

employé enregistré, et tout employé n'a pas forcément de compte Slack.

**L.895 — avant `role: text('role').notNull().default('employee'), // EmployeeRole`**

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

**L.918 — avant `firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),`**

EmployeeRole

**L.920 — avant `firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),`**

Même écart assumé que `conversation_turns` : entier en millisecondes plutôt que

**L.921 — avant `firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),`**

`datetime('now')` en text. `syncedAt` gouverne la fraîcheur, `firstSeenAt` n'est écrit

**L.922 — avant `firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),`**

qu'à l'INSERT — une seule fois dans la vie de la ligne.

**L.927 — avant `emailIdx: index('idx_slack_directory_email').on(table.email),`**

NON UNIQUE à dessein : deux comptes peuvent porter la même adresse le temps d'une

**L.928 — avant `emailIdx: index('idx_slack_directory_email').on(table.email),`**

migration, et une contrainte d'unicité ferait échouer la synchronisation ENTIÈRE plutôt

**L.929 — avant `emailIdx: index('idx_slack_directory_email').on(table.email),`**

que de rapporter deux lignes.

**L.936 — avant `export const rateLimitCounters = sqliteTable(`**

============================================

**L.937 — avant `export const rateLimitCounters = sqliteTable(`**

14. RATE LIMIT COUNTERS (Limitation de débit partagée)

**L.938 — avant `export const rateLimitCounters = sqliteTable(`**

============================================

**L.940 — avant `export const rateLimitCounters = sqliteTable(`**

Un compteur en mémoire est PAR INSTANCE et disparaît au gel de la fonction serverless. Sur un

**L.941 — avant `export const rateLimitCounters = sqliteTable(`**

budget qui se mesure à la JOURNÉE (`TPD: Limit 100000` ≈ 19 messages/jour), il ne protège donc

**L.942 — avant `export const rateLimitCounters = sqliteTable(`**

RIEN : Vercel démarre une instance neuve sans que personne le demande, le compteur repart à

**L.943 — avant `export const rateLimitCounters = sqliteTable(`**

zéro pendant que le quota du fournisseur, lui, continue de courir.

**L.945 — avant `export const rateLimitCounters = sqliteTable(`**

C'est la leçon exacte de la double réponse du 2026-08-11 : le cache LRU de déduplication était

**L.946 — avant `export const rateLimitCounters = sqliteTable(`**

lui aussi en mémoire. Un état par instance ne peut, par construction, rien dire de sa voisine.

**L.948 — avant `export const rateLimitCounters = sqliteTable(`**

⚠️ DDL : `scripts/ddl-rate-limit-counters.sql`.

**L.953 — avant `key: text('key').primaryKey(),`**

`key` EST la clé primaire, et ce n'est pas un détail de modélisation : c'est elle qui rend

**L.954 — avant `key: text('key').primaryKey(),`**

l'incrément atomique via `INSERT … ON CONFLICT DO UPDATE`. Deux instances qui incrémentent

**L.955 — avant `key: text('key').primaryKey(),`**

au même instant sont départagées par la base, sans verrou applicatif — le seul mécanisme

**L.956 — avant `key: text('key').primaryKey(),`**

qui tienne quand les deux concurrents ne partagent aucune mémoire.

**L.958 — avant `key: text('key').primaryKey(),`**

La FENÊTRE est DANS la clé (`<règle>:<sujet>:<numéro de fenêtre>`), pas dans une colonne

**L.959 — avant `key: text('key').primaryKey(),`**

comparée : remettre un compteur à zéro exigerait de lire, décider, puis écrire — donc de

**L.960 — avant `key: text('key').primaryKey(),`**

rouvrir la course. Ici, changer de fenêtre change de ligne.

**L.963 — avant `count: integer('count').notNull(),`**

Sans DEFAULT : une ligne n'existe que parce qu'un incrément l'a créée. Un DEFAULT 0

**L.964 — avant `count: integer('count').notNull(),`**

laisserait croire qu'une ligne peut naître vide.

**L.967 — avant `windowStart: integer('window_start', { mode: 'timestamp_ms' }).notNull(),`**

Redondant avec le numéro de fenêtre encodé dans la clé, et c'est voulu : la clé est une

**L.968 — avant `windowStart: integer('window_start', { mode: 'timestamp_ms' }).notNull(),`**

chaîne opaque. Cette colonne répond à « depuis quand ce compteur court-il ? » sans

**L.969 — avant `windowStart: integer('window_start', { mode: 'timestamp_ms' }).notNull(),`**

reparser un identifiant.

**L.974 — avant `expiresAtIdx: index('idx_rate_limit_counters_expires_at').on(table.expiresAt),`**

Sert la PURGE : sans elle la table croîtrait indéfiniment, une ligne par sujet ET par

**L.975 — avant `expiresAtIdx: index('idx_rate_limit_counters_expires_at').on(table.expiresAt),`**

fenêtre. L'accès par clé passe déjà par l'index implicite de la PRIMARY KEY.

**L.980 — avant `export const slackChannels = sqliteTable(`**

============================================

**L.981 — avant `export const slackChannels = sqliteTable(`**

15. SLACK CHANNELS (Inventaire des canaux — feature `directory`)

**L.982 — avant `export const slackChannels = sqliteTable(`**

============================================

**L.984 — avant `export const slackChannels = sqliteTable(`**

⚠️⚠️ CES DEUX TABLES SONT UN INVENTAIRE D'OBSERVABILITÉ, JAMAIS UNE SOURCE D'AUTORISATION.

**L.986 — avant `export const slackChannels = sqliteTable(`**

La tentation est écrite d'avance : « les membres de #engineer-karyl » RESSEMBLE à une liste

**L.987 — avant `export const slackChannels = sqliteTable(`**

d'autorisation, et quelqu'un finira par la lire comme telle. Or `#engineer-karyl` est PRIVÉ,

**L.988 — avant `export const slackChannels = sqliteTable(`**

et servir son contenu à un non-membre sur la foi de ces lignes est exactement le « deputy

**L.989 — avant `export const slackChannels = sqliteTable(`**

confus » de `PLAN-ARCHITECTURE.md` §4.1 — que la feature `knowledge` ferme en interrogeant

**L.990 — avant `export const slackChannels = sqliteTable(`**

Slack EN DIRECT à chaque décision de divulgation.

**L.992 — avant `export const slackChannels = sqliteTable(`**

L'aggravant est vérifiable et n'a rien d'hypothétique : **il n'existe AUCUN chemin

**L.993 — avant `export const slackChannels = sqliteTable(`**

d'invalidation**. Les abonnements de l'app n'incluent ni `member_joined_channel`, ni

**L.994 — avant `export const slackChannels = sqliteTable(`**

`member_left_channel` (liste faisant foi : `CLAUDE.md`, section « ABONNEMENTS »).

**L.995 — avant `export const slackChannels = sqliteTable(`**

Aucun événement ne viendra jamais démentir une ligne d'ici. Ces tables ne sont donc pas

**L.996 — avant `export const slackChannels = sqliteTable(`**

« périmées dans trois jours » : elles sont fausses, et silencieuses, dès la première personne

**L.997 — avant `export const slackChannels = sqliteTable(`**

qui quitte un canal entre deux synchronisations manuelles.

**L.999 — avant `export const slackChannels = sqliteTable(`**

La règle est rendue EXÉCUTABLE, et non recommandée, par

**L.1000 — avant `export const slackChannels = sqliteTable(`**

`tests/unit/directory/channel-inventory-not-an-acl.test.ts` : il échoue si `knowledge/**`,

**L.1001 — avant `export const slackChannels = sqliteTable(`**

`access-policy.ts` ou `access-guard.ts` importent le repository de canaux.

**L.1003 — avant `export const slackChannels = sqliteTable(`**

Ce que ces tables servent, et rien d'autre : « dans quels canaux le bot est-il ?  »,

**L.1004 — avant `export const slackChannels = sqliteTable(`**

« combien de personnes y a-t-il ? », « qui y est ? », « depuis quand ? » — de l'inventaire.

**L.1006 — avant `export const slackChannels = sqliteTable(`**

⚠️ DDL : `scripts/ddl-slack-channels.sql`.

**L.1011 — avant `channelId: text('channel_id').primaryKey(),`**

La PRIMARY KEY est l'identifiant, PAS le nom. Un canal se renomme (`#random` →

**L.1012 — avant `channelId: text('channel_id').primaryKey(),`**

`#random-fr`) sans que son `C…` bouge : une clé portée par le nom ferait qu'un renommage

**L.1013 — avant `channelId: text('channel_id').primaryKey(),`**

crée un SECOND canal et laisse l'ancien vivre à côté, avec ses membres périmés. Même

**L.1014 — avant `channelId: text('channel_id').primaryKey(),`**

arbitrage que `slack_directory`, dont la clé est le `U…` et non l'email.

**L.1017 — avant `name: text('name').notNull().default(''),`**

NOT NULL DEFAULT '' : le nom est affiché et concaténé, un NULL y imprimerait « null ».

**L.1018 — avant `name: text('name').notNull().default(''),`**

Arbitrage identique à `real_name` / `display_name` de `slack_directory`.

**L.1021 — avant `isPrivate: integer('is_private', { mode: 'boolean' }).notNull().default(false),`**

Faits d'accès, tels que `conversations.list` les rend. `isMember` est le seul qui

**L.1022 — avant `isPrivate: integer('is_private', { mode: 'boolean' }).notNull().default(false),`**

détermine si `chat.postMessage` peut aboutir — c'est lui, et non « le bot est invité »,

**L.1023 — avant `isPrivate: integer('is_private', { mode: 'boolean' }).notNull().default(false),`**

qui décide d'un `not_in_channel`.

**L.1028 — avant `memberCountReported: integer('member_count_reported'),`**

⚠️ LE NOM DE CETTE COLONNE EST LE COMMENTAIRE. C'est une ASSERTION DE SLACK

**L.1029 — avant `memberCountReported: integer('member_count_reported'),`**

(`conversations.list` → `num_members`), pas un cache du `COUNT(*)` de

**L.1030 — avant `memberCountReported: integer('member_count_reported'),`**

`slack_channel_members`. Les deux viennent d'appels DISTINCTS, donc d'instants distincts,

**L.1031 — avant `memberCountReported: integer('member_count_reported'),`**

et divergent normalement.

**L.1033 — avant `memberCountReported: integer('member_count_reported'),`**

Le VRAI compte est `COUNT(*)` sur la table de jointure. L'écart entre les deux est un

**L.1034 — avant `memberCountReported: integer('member_count_reported'),`**

signal de fraîcheur GRATUIT — et le nommer `member_count` tout court aurait garanti qu'on

**L.1035 — avant `memberCountReported: integer('member_count_reported'),`**

le prenne un jour pour l'autorité, puis qu'on « corrige » l'écart en le réécrivant.

**L.1037 — avant `memberCountReported: integer('member_count_reported'),`**

NULLABLE : Slack ne rend pas toujours `num_members` (canaux privés notamment). NULL dit

**L.1038 — avant `memberCountReported: integer('member_count_reported'),`**

« Slack n'a rien affirmé », ce qu'un `0` — indiscernable d'un canal vide — ne dirait pas.

**L.1041 — avant `syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),`**

Millisecondes (Drizzle `timestamp_ms`), comme `conversation_turns`, `slack_event_dedup` et

**L.1042 — avant `syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),`**

`slack_directory` — et non le `datetime('now')` en text des 10 tables historiques.

**L.1046 — avant `syncedAtIdx: index('idx_slack_channels_synced_at').on(table.syncedAt),`**

Sert « quand cet inventaire a-t-il été confirmé pour la dernière fois ? ». Sans fraîcheur

**L.1047 — avant `syncedAtIdx: index('idx_slack_channels_synced_at').on(table.syncedAt),`**

lisible, une table sans chemin d'invalidation se lit « à jour ».

**L.1055 — avant `channelId: text('channel_id')`**

FK DÉCLARÉE, et c'est un choix : les deux lignes sont écrites par la MÊME passe de

**L.1056 — avant `channelId: text('channel_id')`**

synchronisation, le canal AVANT ses membres. `PRAGMA foreign_keys = 1` étant ACTIF sur la

**L.1057 — avant `channelId: text('channel_id')`**

Turso de production (vérifié le 2026-08-12), une appartenance orpheline échoue

**L.1058 — avant `channelId: text('channel_id')`**

bruyamment — ce qui est le comportement voulu : une appartenance sans canal ne désigne

**L.1059 — avant `channelId: text('channel_id')`**

rien.

**L.1064 — avant `slackUserId: text('slack_user_id').notNull(),`**

⚠️ AUCUNE FK VERS `slack_directory`, ET C'EST DÉLIBÉRÉ.

**L.1066 — avant `slackUserId: text('slack_user_id').notNull(),`**

Un membre de canal peut parfaitement être un compte que l'annuaire ne connaît pas encore :

**L.1067 — avant `slackUserId: text('slack_user_id').notNull(),`**

les deux synchronisations sont INDÉPENDANTES (`--members` et `--channels` s'exécutent

**L.1068 — avant `slackUserId: text('slack_user_id').notNull(),`**

séparément), une personne arrivée depuis le dernier balayage de `users.list` n'a pas de

**L.1069 — avant `slackUserId: text('slack_user_id').notNull(),`**

ligne, et les bots tiers n'en ont pas non plus.

**L.1071 — avant `slackUserId: text('slack_user_id').notNull(),`**

Avec le pragma actif, une FK ici ferait ÉCHOUER l'enregistrement précisément sur les

**L.1072 — avant `slackUserId: text('slack_user_id').notNull(),`**

comptes les plus intéressants — les nouveaux arrivants — et imposerait un ordre entre deux

**L.1073 — avant `slackUserId: text('slack_user_id').notNull(),`**

synchronisations qui n'en ont pas. Un inventaire enregistre ce qu'il OBSERVE ; il n'est

**L.1074 — avant `slackUserId: text('slack_user_id').notNull(),`**

pas la vérité référentielle des personnes.

**L.1077 — avant `firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),`**

Survit aux resynchronisations d'une personne toujours présente : c'est le champ que

**L.1078 — avant `firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),`**

`replaceMembers` ne nomme JAMAIS dans son `set`, exactement comme `upsertFacts` protège

**L.1079 — avant `firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),`**

`dm_channel_id`. Le mode d'échec évité est celui, déjà payé, de `documents.content` : une

**L.1080 — avant `firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),`**

écriture qui perd une donnée en silence.

**L.1083 — avant `syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),`**

Marqueur de passe. Il porte à lui seul la sémantique de REMPLACEMENT : la passe réécrit

**L.1084 — avant `syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),`**

`synced_at` sur les membres présents, puis supprime du canal tout ce qui porte encore un

**L.1085 — avant `syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),`**

`synced_at` antérieur. Une personne partie DISPARAÎT — les membres d'un canal à l'instant

**L.1086 — avant `syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),`**

T sont un ENSEMBLE, jamais une accumulation.

**L.1090 — avant `pk: primaryKey({ columns: [table.channelId, table.slackUserId] }),`**

PK COMPOSITE, sans clé de substitution : la ligne n'a pas d'identité propre, elle EST

**L.1091 — avant `pk: primaryKey({ columns: [table.channelId, table.slackUserId] }),`**

l'appartenance. Un `id` autogénéré autoriserait deux lignes identiques pour le même

**L.1092 — avant `pk: primaryKey({ columns: [table.channelId, table.slackUserId] }),`**

couple, et le doublon ne se verrait qu'au `COUNT(*)`, c'est-à-dire dans le seul chiffre

**L.1093 — avant `pk: primaryKey({ columns: [table.channelId, table.slackUserId] }),`**

que cette table existe pour rendre.

**L.1096 — avant `userIdx: index('idx_slack_channel_members_user').on(table.slackUserId),`**

« Dans quels canaux est cette personne ? » — la PK indexe (channel_id, slack_user_id),

**L.1097 — avant `userIdx: index('idx_slack_channel_members_user').on(table.slackUserId),`**

donc elle ne sait pas répondre dans ce sens.

**L.1100 — avant `syncedAtIdx: index('idx_slack_channel_members_synced_at').on(table.syncedAt),`**

Détection des départs : c'est la colonne sur laquelle porte la suppression de fin de passe.

**L.1105 — avant `import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';`**

============================================

**L.1106 — avant `import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';`**

16. TYPES INFÉRÉS POUR LES REQUÊTES

**L.1107 — avant `import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';`**

============================================

**L.1111 — avant `export type Employee = InferSelectModel<typeof employees>;`**

Select types (lecture)

**L.1129 — avant `export type NewEmployee = InferInsertModel<typeof employees>;`**

Insert types (création)

## `mastra/index.ts`

**L.71 — avant `void healthCheck().catch((error) => {`**

AMORÇAGE DE LA CONNEXION — mesuré, et à contre-courant du commentaire précédent

**L.74 — avant `void healthCheck().catch((error) => {`**

L'ancienne note disait « getDb() appelé ici forcerait l'ouverture au démarrage — inutile

**L.75 — avant `void healthCheck().catch((error) => {`**

en dev ». Sa prémisse est fausse en production, et le prix a été mesuré le 2026-08-12 :

**L.77 — avant `void healthCheck().catch((error) => {`**

    WARN | Slack ACK budget at risk | {"ackMs":1619,"admissionMs":1619}

**L.79 — avant `void healthCheck().catch((error) => {`**

`ackMs === admissionMs` : la totalité du budget d'accusé de réception était consommée

**L.80 — avant `void healthCheck().catch((error) => {`**

À L'INTÉRIEUR de `handler.accept()`, c'est-à-dire dans Turso. Signature, parsing et

**L.81 — avant `void healthCheck().catch((error) => {`**

construction du handler pèsent ensemble moins d'une milliseconde.

**L.83 — avant `void healthCheck().catch((error) => {`**

Ce que paie ce chemin : la déduplication partagée et le limiteur de débit font chacun un

**L.84 — avant `void healthCheck().catch((error) => {`**

aller-retour vers `aws-ap-northeast-1` (Tokyo) — mais surtout, le PREMIER d'entre eux

**L.85 — avant `void healthCheck().catch((error) => {`**

paie le handshake complet (DNS + TCP + TLS + upgrade WebSocket + hello hrana), soit 4 à

**L.86 — avant `void healthCheck().catch((error) => {`**

5 allers-retours. Slack rejoue tout événement non acquitté en 3 s, et un rejeu est

**L.87 — avant `void healthCheck().catch((error) => {`**

exactement ce qui a produit la double réponse du 2026-08-11.

**L.89 — avant `void healthCheck().catch((error) => {`**

`createClient` de libsql est SYNCHRONE et ouvre le socket de façon impérative : le coût

**L.90 — avant `void healthCheck().catch((error) => {`**

n'est payé qu'au premier `await`. L'amorcer ici fait donc chevaucher le handshake avec

**L.91 — avant `void healthCheck().catch((error) => {`**

l'évaluation du reste du bundle, au lieu de l'ajouter au chemin d'ACK. Ce n'est pas

**L.92 — avant `void healthCheck().catch((error) => {`**

« ouvrir plus tôt », c'est « ne plus le payer au pire moment ».

**L.94 — avant `void healthCheck().catch((error) => {`**

`void` et `.catch()` : aucun `await` au niveau module (il bloquerait le démarrage), et

**L.95 — avant `void healthCheck().catch((error) => {`**

une base injoignable au boot ne doit pas faire échouer le chargement — chaque appelant

**L.96 — avant `void healthCheck().catch((error) => {`**

gère déjà sa propre dégradation. On journalise, on ne relance pas.

**L.110 — avant `const emailProvider = createEmailProvider();`**

⚠️ `createEmailProvider` a été EXTRAIT vers

**L.111 — avant `const emailProvider = createEmailProvider();`**

`features/notification/infrastructure/providers/email-provider.factory.ts` le 2026-08-14 :

**L.112 — avant `const emailProvider = createEmailProvider();`**

`slack-interactions.route.ts` en a besoin (l'email d'entretien part au clic) et ne peut pas

**L.113 — avant `const emailProvider = createEmailProvider();`**

importer ce fichier-ci, qui importe la route. Le recopier ferait diverger le choix de

**L.114 — avant `const emailProvider = createEmailProvider();`**

fournisseur entre deux chemins d'envoi, sans que rien ne le signale.

**L.117 — avant `console.log('ENV CHECK', {`**

Ne JAMAIS logger la valeur d'une clé d'API — uniquement sa présence.

**L.128 — avant `const docxService = new DocxService();`**

Renderers de documents — c'est CE câblage qui fait entrer `docx` dans le bundle.

`DocxService` importe `docx` statiquement : tant qu'aucun module atteignable depuis ce
fichier ne le référençait, le bundler Mastra/Vercel ne l'embarquait pas. Le garde-fou
`verify:bundle` exige désormais sa présence (`--require …,docx` dans package.json) —
les deux vont ensemble, ajouter l'exigence sans ce câblage casserait le build.

**L.139 — avant `const directoryRepo = new DrizzleDirectoryRepository();`**

Annuaire des personnes et couverture des canaux (feature `directory`)

**L.141 — avant `const directoryRepo = new DrizzleDirectoryRepository();`**

UN SEUL WebClient : les deux adaptateurs consomment `slackWorkspace` déjà câblé. Deux

**L.142 — avant `const directoryRepo = new DrizzleDirectoryRepository();`**

clients ignoreraient chacun les appels de l'autre et franchiraient un plafond de débit que

**L.143 — avant `const directoryRepo = new DrizzleDirectoryRepository();`**

ni l'un ni l'autre ne verrait venir.

**L.145 — avant `const directoryRepo = new DrizzleDirectoryRepository();`**

⚠️ Ce sont des FACTORIES : aucune E/S au chargement du module. Ce fichier est évalué à

**L.146 — avant `const directoryRepo = new DrizzleDirectoryRepository();`**

chaque démarrage à froid, donc sur le chemin des 3 secondes d'ACK de Slack — un ACK à 6,7 s

**L.147 — avant `const directoryRepo = new DrizzleDirectoryRepository();`**

a déjà provoqué un rejeu, donc la double réponse du 2026-08-11.

**L.152 — avant `export const directorySync = makeDirectorySync({`**

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

**L.173 — avant `const channelCoverage = makeChannelCoverage({`**

⚠️ `inventory` était ABSENT jusqu'au 2026-08-14, et c'est le défaut que `TODO.md` [0 bis]

**L.174 — avant `const channelCoverage = makeChannelCoverage({`**

recensait : sans lui, `recordInventory()` rend `undefined` et n'écrit RIEN. Le service

**L.175 — avant `const channelCoverage = makeChannelCoverage({`**

n'a toujours aucun consommateur dans l'application — l'inventaire est alimenté par

**L.176 — avant `const channelCoverage = makeChannelCoverage({`**

`npm run directory:sync -- --channels --apply`, qui reconstruit ses propres instances —

**L.177 — avant `const channelCoverage = makeChannelCoverage({`**

mais il est désormais CORRECT si quelqu'un s'en sert, au lieu d'être muet.

**L.183 — avant `const findEmployeeByEmail = makeFindEmployeeByEmail(employeeRepo, directoryRepo);`**

L'annuaire Slack est le SECOND paramètre, et c'est le correctif de la panne du

**L.184 — avant `const findEmployeeByEmail = makeFindEmployeeByEmail(employeeRepo, directoryRepo);`**

2026-08-12 (« il ne retrouve pas les autres profils à part le mien ») : `employees`

**L.185 — avant `const findEmployeeByEmail = makeFindEmployeeByEmail(employeeRepo, directoryRepo);`**

n'est peuplée que par la modale « Compléter mon profil », donc elle contenait UNE

**L.186 — avant `const findEmployeeByEmail = makeFindEmployeeByEmail(employeeRepo, directoryRepo);`**

ligne pour 6 personnes réelles, tandis que `slack_directory` les portait toutes,

**L.187 — avant `const findEmployeeByEmail = makeFindEmployeeByEmail(employeeRepo, directoryRepo);`**

avec prénom, nom et poste. `directorySync` alimentait cette table depuis le

**L.188 — avant `const findEmployeeByEmail = makeFindEmployeeByEmail(employeeRepo, directoryRepo);`**

2026-08-12 sans qu'aucun tool ne la lise.

**L.191 — avant `const findPersonByName = makeFindPersonByName(employeeRepo, directoryRepo);`**

RÉSOLUTION PAR NOM — le manque qui a envoyé le document d'Awa à l'adresse de Karyl

**L.193 — avant `const findPersonByName = makeFindPersonByName(employeeRepo, directoryRepo);`**

Relevé sur la Turso de production le 2026-08-13 : les DIX documents de la base portent

**L.194 — avant `const findPersonByName = makeFindPersonByName(employeeRepo, directoryRepo);`**

l'UUID de Karyl, y compris celui intitulé « Bienvenue Awa ». Awa a pourtant sa propre

**L.195 — avant `const findPersonByName = makeFindPersonByName(employeeRepo, directoryRepo);`**

ligne `employees` — elle est simplement absente de `slack_directory`, donc

**L.196 — avant `const findPersonByName = makeFindPersonByName(employeeRepo, directoryRepo);`**

`findEmployeeByEmail` (seul résolveur existant) exigeait une adresse que personne

**L.197 — avant `const findPersonByName = makeFindPersonByName(employeeRepo, directoryRepo);`**

n'avait tapée. Sommé de fournir un `employeeId`, le modèle a réutilisé le seul UUID de

**L.198 — avant `const findPersonByName = makeFindPersonByName(employeeRepo, directoryRepo);`**

son contexte : même mécanique que l'email `votre_email@example.com`.

**L.200 — avant `const findPersonByName = makeFindPersonByName(employeeRepo, directoryRepo);`**

Les DEUX sources sont donc câblées, `employees` d'abord : Awa n'existe QUE dans

**L.201 — avant `const findPersonByName = makeFindPersonByName(employeeRepo, directoryRepo);`**

`employees`, et les quatre autres personnes vivantes du workspace QUE dans l'annuaire.

**L.205 — avant `const generateDocument = makeGenerateDocument({`**

⚠️ `getTaskList` a été RETIRÉ le 2026-08-14, avec tout le suivi de tâches.

**L.207 — avant `const generateDocument = makeGenerateDocument({`**

Les cinq tâches d'intégration étaient un plan qu'AUCUN mécanisme ne faisait avancer : ni

**L.208 — avant `const generateDocument = makeGenerateDocument({`**

humain, ni automate, ni tool ne pouvait marquer « Rencontrer ton manager » comme faite. Un

**L.209 — avant `const generateDocument = makeGenerateDocument({`**

suivi qui ne bouge jamais est un suivi qui ment — même famille de défaut que

**L.210 — avant `const generateDocument = makeGenerateDocument({`**

`emailSent: false` sous `status: 'success'` et que `status = Sent` posé avant le `try`.

**L.211 — avant `const generateDocument = makeGenerateDocument({`**

Deux des cinq renvoyaient de surcroît vers un questionnaire et un guide qui n'existaient

**L.212 — avant `const generateDocument = makeGenerateDocument({`**

pas sous la forme annoncée.

**L.214 — avant `const generateDocument = makeGenerateDocument({`**

Le seul suivi du produit est désormais la COMPLÉTION DU PROFIL, portée par

**L.215 — avant `const generateDocument = makeGenerateDocument({`**

`onboarding_progress` et lisible par `getEmployeeProfile`.

**L.216 — avant `const generateDocument = makeGenerateDocument({`**

⚠️ `evaluateResponse` a été SUPPRIMÉ du câblage le 2026-08-14 — audit de code mort.

**L.217 — avant `const generateDocument = makeGenerateDocument({`**

Il était décâblé de tout agent depuis le 2026-08-12 (son seul appelant possible était un

**L.218 — avant `const generateDocument = makeGenerateDocument({`**

modèle qui FABRIQUAIT les réponses d'un humain), mais sa CONSTRUCTION est restée, et avec

**L.219 — avant `const generateDocument = makeGenerateDocument({`**

elle celle de `questionnaireRepo` et `responseRepo`. Trois objets bâtis à chaque démarrage

**L.220 — avant `const generateDocument = makeGenerateDocument({`**

à froid pour un tool que rien ne pouvait appeler.

**L.221 — avant `const generateDocument = makeGenerateDocument({`**

`generateDocument` ne se contente plus d'écrire une ligne : il rend le fichier, le

**L.222 — avant `const generateDocument = makeGenerateDocument({`**

livre dans Slack (upload) ou par email (pièce jointe), et rend compte de la livraison.

**L.223 — avant `const generateDocument = makeGenerateDocument({`**

Le canal et le thread ne sont PAS injectés ici — ils viennent du `requestContext` par

**L.224 — avant `const generateDocument = makeGenerateDocument({`**

requête (`src/shared/slack-request-context.ts`) ; l'adresse email, elle, est résolue

**L.225 — avant `const generateDocument = makeGenerateDocument({`**

depuis l'annuaire. Aucune destination ne transite par le modèle.

**L.230 — avant `fileUpload: chatProvider,`**

`SlackAdapter` porte `uploadFile` en plus de `sendMessage` : un seul WebClient, un

**L.231 — avant `fileUpload: chatProvider,`**

seul jeton. Le scope `files:write` EST accordé — vérifié en production le 2026-08-11,

**L.232 — avant `fileUpload: chatProvider,`**

un PDF réellement posté dans un DM (`hasPermalink: true` dans les logs). L'ancienne

**L.233 — avant `fileUpload: chatProvider,`**

note affirmant le contraire a survécu à sa propre invalidation pendant une journée.

**L.236 — avant `interviewRepo,`**

── L'ENTRETIEN nourrit le gabarit, CÔTÉ SERVEUR ────────────────────────────────────

**L.238 — avant `interviewRepo,`**

Ces deux dépôts ne traversent jamais la fenêtre du modèle : `generateDocument` résout

**L.239 — avant `interviewRepo,`**

l'entretien depuis l'`employeeId`, exactement comme il résout la fiche employé. Le

**L.240 — avant `interviewRepo,`**

gabarit imprime donc de la matière réelle — ce que la personne a écrit sur son quotidien,

**L.241 — avant `interviewRepo,`**

sa façon de travailler, les canaux qu'elle a choisis — pour **zéro token**.

**L.243 — avant `interviewRepo,`**

C'est la réponse à « le guide doit être chaleureux, avec les infos connues de

**L.244 — avant `interviewRepo,`**

l'utilisateur, sans donnée générique » : jusqu'au 2026-08-14 le gabarit sortait quatre

**L.245 — avant `interviewRepo,`**

puces écrites en dur, identiques pour tout le monde.

**L.247 — avant `interviewRepo,`**

⚠️ Les DEUX sont optionnels dans le tool : sans eux le document reste produit à

**L.248 — avant `interviewRepo,`**

l'identique. C'est ce qui rend ce câblage sûr même sur une base où

**L.249 — avant `interviewRepo,`**

`onboarding_interview` n'a pas encore été appliquée.

**L.260 — avant `const scheduleReminder = makeScheduleReminder(notificationRepo, employeeRepo);`**

L'annuaire est le SECOND paramètre, et il n'est pas décoratif : il permet de refuser un

**L.261 — avant `const scheduleReminder = makeScheduleReminder(notificationRepo, employeeRepo);`**

destinataire inexistant AVANT d'enregistrer un rappel. Sans lui le tool dégrade — il ne ment

**L.262 — avant `const scheduleReminder = makeScheduleReminder(notificationRepo, employeeRepo);`**

pas, mais il accepte.

**L.264 — avant `const getNotificationHistory = makeGetNotificationHistory(notificationRepo, employeeRepo);`**

⚠️ `employeeRepo` est injecté UNIQUEMENT pour résoudre un email en identifiant, ce qui

**L.265 — avant `const getNotificationHistory = makeGetNotificationHistory(notificationRepo, employeeRepo);`**

supprime une étape entière (mesuré : 3 étapes / 4 424 tokens → 2). Voir la factory.

**L.268 — avant `const findExpertise = makeFindExpertise({`**

`discoverSlackWorkspace` a été SUPPRIMÉ le 2026-08-18. Il avait d'abord été retiré des

**L.269 — avant `const findExpertise = makeFindExpertise({`**

agents (schéma coûteux, mentionné dans aucune instruction), et ce commentaire affirmait

**L.270 — avant `const findExpertise = makeFindExpertise({`**

alors qu'il « reste câblé et testé isolément » : c'était faux. Il n'était câblé à AUCUN

**L.271 — avant `const findExpertise = makeFindExpertise({`**

agent ni à aucun autre appelant — il n'était que TESTÉ, ce qui n'est pas la même chose et

**L.272 — avant `const findExpertise = makeFindExpertise({`**

donne l'illusion d'un code vivant.

**L.274 — avant `const findExpertise = makeFindExpertise({`**

Ce qui a emporté la décision n'est pas qu'il soit mort, c'est ce qu'il portait : une action

**L.275 — avant `const findExpertise = makeFindExpertise({`**

`inviteToChannel` sans la moindre garde d'autorisation, dans un fichier qu'un futur

**L.276 — avant `const findExpertise = makeFindExpertise({`**

recâblage aurait pu rebrancher sans relire. L'invitation Slack du parcours d'onboarding, la

**L.277 — avant `const findExpertise = makeFindExpertise({`**

vraie, passe par `deps.slackProvider` dans l'étape `inviteToSlack` du workflow.

**L.278 — avant `const findExpertise = makeFindExpertise({`**

`createEmployee` a été retiré le 2026-08-11, après la campagne de tests en

**L.279 — avant `const findExpertise = makeFindExpertise({`**

production. Exposer une allowlist fermée (`department`, `position`) à un LLM ne

**L.280 — avant `const findExpertise = makeFindExpertise({`**

protège pas l'intégrité des données : le modèle substitue une valeur valide

**L.281 — avant `const findExpertise = makeFindExpertise({`**

AVANT d'appeler l'outil pour que l'appel réussisse. Mesuré : « Software

**L.282 — avant `const findExpertise = makeFindExpertise({`**

Engineer » enregistré en « Developer », et « Plomberie » enregistré en

**L.283 — avant `const findExpertise = makeFindExpertise({`**

« Engineering » — ce dernier SANS le moindre avertissement. La validation Zod

**L.284 — avant `const findExpertise = makeFindExpertise({`**

n'a jamais vu les valeurs refusées.

**L.285 — avant `const findExpertise = makeFindExpertise({`**

La création passe désormais par la modale du flux d'arrivée : liste déroulante

**L.286 — avant `const findExpertise = makeFindExpertise({`**

côté Slack, workflow appelé en code, aucun LLM sur le chemin transactionnel.

**L.287 — avant `const findExpertise = makeFindExpertise({`**

Le tool reste câblé pour l'API et le workflow.

**L.288 — avant `const findExpertise = makeFindExpertise({`**

`findExpertise` (2026-08-14) répond à « qui peut faire quoi » — la seconde moitié de la

**L.289 — avant `const findExpertise = makeFindExpertise({`**

demande adressée au `knowledgeAgent`. Il est en LECTURE PURE et ne rend que des NOMS : ni

**L.290 — avant `const findExpertise = makeFindExpertise({`**

UUID, ni adresse, ni identifiant Slack. Il satisfait donc la quarantaine ci-dessus, et sa

**L.291 — avant `const findExpertise = makeFindExpertise({`**

place est bien ici plutôt que sur l'orchestrateur — « qui s'occupe du backend ? » est une

**L.292 — avant `const findExpertise = makeFindExpertise({`**

question de connaissance du workspace, pas une étape d'onboarding.

**L.293 — avant `const findExpertise = makeFindExpertise({`**

⚠️ `interviewRepo` est la TROISIÈME matière, ajoutée le 2026-08-19 sur un défaut mesuré en

**L.294 — avant `const findExpertise = makeFindExpertise({`**

production : « qui s'occupe du support technique ? » rendait « aucun collaborateur

**L.295 — avant `const findExpertise = makeFindExpertise({`**

identifié » alors que la personne venait d'écrire, dans son entretien, qu'elle fait du

**L.296 — avant `const findExpertise = makeFindExpertise({`**

support technique. Le poste est un intitulé RH saisi une fois ; l'entretien est ce que la

**L.297 — avant `const findExpertise = makeFindExpertise({`**

personne fait, avec ses mots. Coût en tokens : ZÉRO — le tool-result reste borné à 6 noms.

**L.304 — avant `const onboardingOrchestrator = makeOnboardingOrchestrator({`**

⚠️ REMONTÉ ICI le 2026-08-19 : `findExpertise` est désormais câblé sur TROIS agents, donc il

**L.305 — avant `const onboardingOrchestrator = makeOnboardingOrchestrator({`**

doit être construit avant le premier. Voir juste en dessous pour la raison — et pour la

**L.306 — avant `const onboardingOrchestrator = makeOnboardingOrchestrator({`**

frontière qui, elle, n'a PAS bougé.

**L.314 — avant `findExpertise,`**

⚠️ « QUAND UNE INFORMATION RÉELLE EST REQUISE » — 2026-08-19, et il faut dire exactement

**L.315 — avant `findExpertise,`**

ce qui a été fait et ce qui a été REFUSÉ.

**L.317 — avant `findExpertise,`**

FAIT : `findExpertise` est la connaissance que ce système possède sur les PERSONNES —

**L.318 — avant `findExpertise,`**

poste déclaré, ce que la personne dit faire au quotidien. Un agent qui ne l'a pas ne peut

**L.319 — avant `findExpertise,`**

répondre à « qui s'occupe du backend ? » qu'en INVENTANT, et c'est le mode d'échec numéro

**L.320 — avant `findExpertise,`**

un recensé par ce dépôt. Il est en lecture pure et ne rend que des NOMS : ni UUID, ni

**L.321 — avant `findExpertise,`**

adresse, ni identifiant Slack.

**L.323 — avant `findExpertise,`**

REFUSÉ : `getChannelHistory` et `getUserConversations` restent au seul `knowledgeAgent`.

**L.324 — avant `findExpertise,`**

Ce sont des lectures AGRÉGÉES, et cet agent porte `generateDocument`, qui rend un fichier

**L.325 — avant `findExpertise,`**

ET le livre (upload Slack ou pièce jointe email). Les réunir formerait mot pour mot le

**L.326 — avant `findExpertise,`**

canal d'exfiltration de §4.2 — « récapitule #engineer-karyl et envoie-le-moi en PDF » —

**L.327 — avant `findExpertise,`**

que `outbound-tool-quarantine.ts` et `makeRecruitmentAgent` gardent chacun d'un côté. La

**L.328 — avant `findExpertise,`**

capacité reste ATTEIGNABLE : le palier thématique du routage envoie « résume… » et tout

**L.329 — avant `findExpertise,`**

jeton de canal `<#C…>` au `knowledgeAgent`, et peut déloger un fil pour cela.

**L.333 — avant `const notificationAgent = makeNotificationAgent({`**

`findEmployeeByEmail` est exposé à `onboardingOrchestrator` et `notificationAgent` depuis le

**L.334 — avant `const notificationAgent = makeNotificationAgent({`**

2026-08-11, et c'est un correctif de CÂBLAGE, pas de rédaction.

**L.336 — avant `const notificationAgent = makeNotificationAgent({`**

Tous les tools de `notificationAgent` exigent un UUID d'employé, et AUCUN ne sait faire

**L.337 — avant `const notificationAgent = makeNotificationAgent({`**

email → UUID : ce tool n'était câblé que sur l'orchestrateur. Pire, le `.describe()` de

**L.338 — avant `const notificationAgent = makeNotificationAgent({`**

`recipientId` renvoyait vers `getEmployeeProfile`, qui exige déjà un UUID — la consigne était

**L.339 — avant `const notificationAgent = makeNotificationAgent({`**

circulaire. Et `AGENT_ANTI_INVENTION_BLOCK` interdit au modèle d'en deviner un. La boucle

**L.340 — avant `const notificationAgent = makeNotificationAgent({`**

infernale de la série C (« donne-moi son identifiant » → « je ne l'ai pas » → …) était donc

**L.341 — avant `const notificationAgent = makeNotificationAgent({`**

GARANTIE par le câblage, pas probabiliste.

**L.344 — avant `const notificationAgent = makeNotificationAgent({`**

`questionnaireEngine` A ÉTÉ RETIRÉ DU REGISTRE le 2026-08-14

**L.347 — avant `const notificationAgent = makeNotificationAgent({`**

Avec son unique tool `generateQuestionnaire`. Les deux restent dans le dépôt, testés ;

**L.348 — avant `const notificationAgent = makeNotificationAgent({`**

seule leur EXPOSITION disparaît. Trois raisons, la première étant décisive :

**L.350 — avant `const notificationAgent = makeNotificationAgent({`**

 1. **Il n'a jamais rien produit d'utilisable.** Relevé sur la Turso le 2026-08-14 :

**L.351 — avant `const notificationAgent = makeNotificationAgent({`**

    `questionnaires` = 5 lignes (« Quiz sur nos valeurs »…), `questionnaire_responses` =

**L.352 — avant `const notificationAgent = makeNotificationAgent({`**

    **0 ligne**. Il n'existe ni formulaire Block Kit, ni modale, ni route de soumission :

**L.353 — avant `const notificationAgent = makeNotificationAgent({`**

    un questionnaire enregistré n'est envoyé à personne et remplissable par personne. Le

**L.354 — avant `const notificationAgent = makeNotificationAgent({`**

    tool le dit lui-même dans son `hint` — ce qui prouve qu'on le savait sans le corriger.

**L.355 — avant `const notificationAgent = makeNotificationAgent({`**

    C'est exactement pour cette raison qu'`evaluateResponse` avait dû être décâblé le

**L.356 — avant `const notificationAgent = makeNotificationAgent({`**

    2026-08-12 : son seul appelant possible était un modèle qui FABRIQUAIT les réponses.

**L.357 — avant `const notificationAgent = makeNotificationAgent({`**

 2. **Le besoin réel est ailleurs.** Ce que le questionnaire devait servir — cerner les

**L.358 — avant `const notificationAgent = makeNotificationAgent({`**

    centres d'intérêt d'un arrivant pour l'abonner aux bons canaux — est désormais rendu

**L.359 — avant `const notificationAgent = makeNotificationAgent({`**

    par l'ENTRETIEN post-profil : une modale Block Kit, remplissable, dont la soumission

**L.360 — avant `const notificationAgent = makeNotificationAgent({`**

    invite réellement aux canaux choisis. Déterministe, zéro token, et il aboutit.

**L.361 — avant `const notificationAgent = makeNotificationAgent({`**

 3. ≈ 886 tokens de FLOOR en moins, et un agent de moins dans le routage.

**L.363 — avant `const notificationAgent = makeNotificationAgent({`**

⚠️ Le routage a été nettoyé en conséquence (`ESCAPE_INTENTS`, `QUESTIONNAIRE_TOPICS`,

**L.364 — avant `const notificationAgent = makeNotificationAgent({`**

`KNOWN_AGENT_IDS`). Ce n'est pas cosmétique : `mastra.getAgent()` LÈVE sur un identifiant

**L.365 — avant `const notificationAgent = makeNotificationAgent({`**

absent du registre, donc un mot-clé pointant encore cet agent aurait fait échouer chaque

**L.366 — avant `const notificationAgent = makeNotificationAgent({`**

message qui le contient.

**L.368 — avant `const notificationAgent = makeNotificationAgent({`**

discoverSlackWorkspace n'est PAS exposé ici : les instructions de l'agent ne le

**L.369 — avant `const notificationAgent = makeNotificationAgent({`**

mentionnent jamais (sendNotification résout déjà le compte Slack côté serveur), et

**L.370 — avant `const notificationAgent = makeNotificationAgent({`**

c'est actuellement le tool le plus coûteux en tokens du set (~356 caractères de

**L.371 — avant `const notificationAgent = makeNotificationAgent({`**

schéma JSON + 426 de description). Voir CHANGELOG pour la mesure avant/après.

**L.373 — avant `findEmployeeByEmail,`**

Voir le commentaire de `questionnaireEngine` ci-dessus : sans ce tool, les quatre autres

**L.374 — avant `findEmployeeByEmail,`**

sont inatteignables dès que l'humain désigne quelqu'un par son email — c'est-à-dire

**L.375 — avant `findEmployeeByEmail,`**

presque toujours.

**L.377 — avant `findPersonByName,`**

Même raison, et le cas est encore plus fréquent ici : « envoie un rappel à Pamela »

**L.378 — avant `findPersonByName,`**

ne porte jamais d'adresse. Sans ce tool, la boucle « donne-moi son identifiant » →

**L.379 — avant `findPersonByName,`**

« je ne l'ai pas » était garantie par le câblage.

**L.385 — avant `findExpertise,`**

Même arbitrage que sur l'orchestrateur, et la même frontière : la connaissance des

**L.386 — avant `findExpertise,`**

PERSONNES, jamais la lecture agrégée des canaux. Ici le voisinage est `sendNotification`,

**L.387 — avant `findExpertise,`**

donc l'écriture externe est encore plus directe — raison de plus pour que `findExpertise`

**L.388 — avant `findExpertise,`**

ne rende que des noms, et que `title` et `evidence` en sortent ASSAINIS (correctif du

**L.389 — avant `findExpertise,`**

2026-08-19 : `title` est un poste déclaratif, édité par son porteur).

**L.394 — avant `const channelHistory = new SlackChannelHistoryAdapter(process.env.SLACK_BOT_TOKEN ?? '', {`**

AGENT KNOWLEDGE — lecture des conversations, et rien d'autre

**L.396 — avant `const channelHistory = new SlackChannelHistoryAdapter(process.env.SLACK_BOT_TOKEN ?? '', {`**

Deux sources, et deux seulement : la mémoire propre du bot (`conversation_turns`, ses DM

**L.397 — avant `const channelHistory = new SlackChannelHistoryAdapter(process.env.SLACK_BOT_TOKEN ?? '', {`**

avec les gens) et l'historique des canaux où il est invité. Rien n'est ingéré ni stocké :

**L.398 — avant `const channelHistory = new SlackChannelHistoryAdapter(process.env.SLACK_BOT_TOKEN ?? '', {`**

lecture À LA DEMANDE, fenêtre bornée — une ingestion persistante de tous les canaux

**L.399 — avant `const channelHistory = new SlackChannelHistoryAdapter(process.env.SLACK_BOT_TOKEN ?? '', {`**

constituerait une surveillance systématique des communications des salariés

**L.400 — avant `const channelHistory = new SlackChannelHistoryAdapter(process.env.SLACK_BOT_TOKEN ?? '', {`**

(AIPD obligatoire, consultation du CSE), ce que `PLAN-ARCHITECTURE.md` §4.7 refuse.

**L.402 — avant `const channelHistory = new SlackChannelHistoryAdapter(process.env.SLACK_BOT_TOKEN ?? '', {`**

⚠️ Le filtrage se fait selon les droits du DEMANDEUR, jamais selon ceux du bot. Le bot

**L.403 — avant `const channelHistory = new SlackChannelHistoryAdapter(process.env.SLACK_BOT_TOKEN ?? '', {`**

détient l'UNION des droits de tous ses canaux ; les prêter au premier venu est le

**L.404 — avant `const channelHistory = new SlackChannelHistoryAdapter(process.env.SLACK_BOT_TOKEN ?? '', {`**

« deputy confus » de §4.1 — un invité mono-canal demandant en DM le résumé de

**L.405 — avant `const channelHistory = new SlackChannelHistoryAdapter(process.env.SLACK_BOT_TOKEN ?? '', {`**

`#engineer-karyl`.

**L.407 — avant `resolveDisplayName: async (id) =>`**

Résolution des noms par l'ANNUAIRE et non par `users.info` : zéro appel Slack

**L.408 — avant `resolveDisplayName: async (id) =>`**

supplémentaire, et un nom absent retombe sur l'identifiant sans casser la lecture.

**L.414 — avant `directory: directoryRepo,`**

`DirectoryRepository` satisfait STRUCTURELLEMENT le port du tool : celui-ci ne voit que

**L.415 — avant `directory: directoryRepo,`**

les deux lectures dont il a besoin, ni `upsertFacts` ni `listAll`.

**L.424 — avant `const knowledgeAgent = makeKnowledgeAgent({`**

⚠️ AUCUN outil de SORTIE ici, et ce n'est pas une convention : `makeKnowledgeAgent` LÈVE au

**L.425 — avant `const knowledgeAgent = makeKnowledgeAgent({`**

démarrage si on lui en câble un. Lecture agrégée + écriture externe dans la même chaîne =

**L.426 — avant `const knowledgeAgent = makeKnowledgeAgent({`**

canal d'exfiltration complet (§4.2) — « envoie à ce candidat un récapitulatif de ce qui se

**L.427 — avant `const knowledgeAgent = makeKnowledgeAgent({`**

dit dans #engineer-karyl », en une phrase, par un invité. Une erreur de câblage devient donc

**L.428 — avant `const knowledgeAgent = makeKnowledgeAgent({`**

un échec au démarrage, pas une fuite.

**L.435 — avant `const pendingInterviewEmailRepo = new DrizzlePendingInterviewEmailRepository();`**

⚠️ AUCUN outil de LECTURE ici, et c'est la quarantaine INVERSE de celle ci-dessus :

**L.436 — avant `const pendingInterviewEmailRepo = new DrizzlePendingInterviewEmailRepository();`**

`makeRecruitmentAgent` LÈVE au démarrage si on lui en câble un. C'est le seul agent qui

**L.437 — avant `const pendingInterviewEmailRepo = new DrizzlePendingInterviewEmailRepository();`**

écrive à une adresse SITUÉE HORS DE L'ENTREPRISE et non contrainte par l'annuaire ; lui

**L.438 — avant `const pendingInterviewEmailRepo = new DrizzlePendingInterviewEmailRepository();`**

adjoindre `getEmployeeProfile` ou `getChannelHistory` formerait le canal d'exfiltration de

**L.439 — avant `const pendingInterviewEmailRepo = new DrizzlePendingInterviewEmailRepository();`**

§4.2 — « retrouve le dossier de Karyl et envoie-le à moi@ailleurs.com ».

**L.441 — avant `const pendingInterviewEmailRepo = new DrizzlePendingInterviewEmailRepository();`**

C'est aussi pourquoi ce tool n'est PAS posé sur `notificationAgent`, qui aurait été

**L.442 — avant `const pendingInterviewEmailRepo = new DrizzlePendingInterviewEmailRepository();`**

l'option la moins chère : il porte déjà trois outils de lecture.

**L.444 — avant `const pendingInterviewEmailRepo = new DrizzlePendingInterviewEmailRepository();`**

`directoryRepo` n'est PAS une exception à la quarantaine : le tool s'en sert pour résoudre

**L.445 — avant `const pendingInterviewEmailRepo = new DrizzlePendingInterviewEmailRepository();`**

l'adresse du DEMANDEUR (afin que le candidat puisse répondre à un humain), jamais sur une

**L.446 — avant `const pendingInterviewEmailRepo = new DrizzlePendingInterviewEmailRepository();`**

valeur choisie par le modèle — le `slackUserId` vient du `requestContext`.

**L.447 — avant `const pendingInterviewEmailRepo = new DrizzlePendingInterviewEmailRepository();`**

L'email d'entretien PRÉPARÉ, en attente d'un « oui ».

⚠️ Remplace le `value` du bouton « Envoyer », retiré le 2026-08-19 avec tous les autres.
L'état doit survivre à un changement de sujet — c'est l'exigence explicite : rappeler l'email
en attente si l'on parle d'autre chose, et le garder en suspens si la personne veut vraiment
changer de sujet. Un état qui tient pendant qu'on parle d'autre chose ne peut pas être le
dernier message du bot, donc pas le fil : il lui faut une table.

⚠️ DDL à appliquer à la main : `scripts/ddl-pending-interview-email.sql`. Les migrations
`drizzle/` sont désynchronisées de `schema.ts` et `drizzle-kit push` se bloque contre une
base `libsql://` distante.

**L.463 — avant `chat: { sendText: (channelId, text) => chatProvider.sendMessage(channelId, text) },`**

⚠️ Du TEXTE, plus des blocs — les boutons ont été retirés du produit le 2026-08-19. La

**L.464 — avant `chat: { sendText: (channelId, text) => chatProvider.sendMessage(channelId, text) },`**

relecture se conclut par une question à laquelle on répond oui ou non.

**L.467 — avant `presenter: slackInterviewConfirmationPresenter,`**

La présentation de la carte de relecture est injectée : la couche `application` ne

**L.468 — avant `presenter: slackInterviewConfirmationPresenter,`**

connaît pas Block Kit — voir `domain/ports/interview-confirmation.presenter.ts`.

**L.475 — avant `const employeeOnboardingWorkflow = createEmployeeOnboardingWorkflow({`**

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

**L.540 — avant `agents: {`**

La clé du registre doit être IDENTIQUE à l'`id` de l'agent — c'est elle que résout

**L.541 — avant `agents: {`**

`mastra.getAgent(id)`, et c'est cet identifiant que le routage collant relit en base.

**L.548 — avant `workflows: {`**

UN SEUL workflow, et c'est délibéré — voir le commentaire de `employeeOnboardingWorkflow`.

**L.549 — avant `workflows: {`**

Les trois autres ne faisaient aucune E/S et se déclaraient réussis.

**L.558 — avant `server: {`**

Une route HTTP n'existe QUE si elle est déclarée ici. Les fichiers de `src/api/`

**L.559 — avant `server: {`**

ne sont jamais montés automatiquement par Mastra.

**L.561 — avant `apiRoutes: [`**

⚠️ QUATRE routes pour DEUX endpoints. Les deux `…WorkRoute` sont les chemins internes

**L.562 — avant `apiRoutes: [`**

où le PORTIER D'ACK (`scripts/slack-ack-function/`) rejoue la requête : Slack n'accorde

**L.563 — avant `apiRoutes: [`**

que 3 secondes, et le démarrage à froid de CETTE fonction a été mesuré à 5,2 s le

**L.564 — avant `apiRoutes: [`**

2026-08-19 — le budget était épuisé avant la première instruction. Le portier n'a aucune

**L.565 — avant `apiRoutes: [`**

dépendance, donc aucun dépaquetage à payer.

**L.567 — avant `apiRoutes: [`**

Elles ne sont pas une porte dérobée : même handler, même vérification HMAC sur le corps

**L.568 — avant `apiRoutes: [`**

réexpédié à l'identique. Le chemin distinct existe pour que le routage Vercel ne renvoie

**L.569 — avant `apiRoutes: [`**

pas la requête réexpédiée au portier — ce qui serait une boucle.

**L.576 — avant `middleware: [`**

Requalifie en 400 les erreurs de validation d'entrée que Mastra renvoie en 500.

**L.577 — avant `middleware: [`**

Monté sur `/api/*` UNIQUEMENT : `/slack/events` gère ses propres codes et le rejeu

**L.578 — avant `middleware: [`**

de Slack en dépend. Une vraie panne serveur reste un 500 (voir le module).

**L.580 — avant `{ path: '*', handler: createSecurityHeadersMiddleware() },`**

Les en-têtes de sécurité, sur TOUTE réponse — d'où le joker nu et non `/api/*` : la

**L.581 — avant `{ path: '*', handler: createSecurityHeadersMiddleware() },`**

racine et `/agents` rendent du `text/html`, et c'est cette surface-là qui justifie

**L.582 — avant `{ path: '*', handler: createSecurityHeadersMiddleware() },`**

`x-frame-options`. Relevé de l'extérieur le 2026-08-18 : seul le HSTS de Vercel était

**L.583 — avant `{ path: '*', handler: createSecurityHeadersMiddleware() },`**

présent. En PREMIER pour que les en-têtes couvrent aussi les refus des gardes qui

**L.584 — avant `{ path: '*', handler: createSecurityHeadersMiddleware() },`**

suivent.

**L.586 — avant `{`**

⚠️ EN PREMIER, et l'ordre porte la sécurité : ce garde doit refuser AVANT que

**L.587 — avant `{`**

quoi que ce soit ne lise le contexte. Mastra fusionne `body.requestContext` dans le

**L.588 — avant `{`**

contexte serveur et n'écarte que `RESERVED_CONTEXT_KEYS` (`mastra__*`,

**L.589 — avant `{`**

`organizationId`) — aucune clé `slack*` n'y figure, donc un porteur de

**L.590 — avant `{`**

`MASTRA_API_TOKEN` se déclarait n'importe qui : `slackEmployeeId` décide de l'accès

**L.591 — avant `{`**

au dossier RH, `slackAccessLevel` des effets de bord. Le trou était recensé depuis

**L.592 — avant `{`**

le 2026-08-12 et fermé le 2026-08-14.

**L.600 — avant `{`**

⚠️ EN SECOND, avant la requalification d'erreur : le prompt système FUYAIT par

**L.601 — avant `{`**

`/api/agents/*` — quatre surfaces, dont DEUX sans la moindre ruse. `GET /api/agents`

**L.602 — avant `{`**

rendait les instructions des quatre agents en clair, `GET /api/agents/:id` 2 624

**L.603 — avant `{`**

caractères dont le `[SECURITY_ID:…]` de session. Aucune injection, aucun modèle,

**L.604 — avant `{`**

aucun coût. Mesuré et fermé le 2026-08-14.

**L.606 — avant `{`**

Monté sur `/api/*` et non `/api/agents/*` : un joker Hono ne couvre pas

**L.607 — avant `{`**

`/api/agents` SANS segment suivant — or c'est précisément la pire des quatre. Le

**L.608 — avant `{`**

garde teste le chemin lui-même.

**L.627 — avant `cors: { origin: [], credentials: false },`**

Sans `auth`, `getEffectiveAuthConfig()` renvoie null et `checkRouteAuth()` laisse

**L.628 — avant `cors: { origin: [], credentials: false },`**

passer TOUTES les routes /api/* sans authentification — n'importe qui sur Internet

**L.629 — avant `cors: { origin: [], credentials: false },`**

pilotait les agents (envoi d'email, création d'employés, publication Slack).

**L.630 — avant `cors: { origin: [], credentials: false },`**

`/slack/events` reste exempt via son `requiresAuth: false` (vérifié dans le source

**L.631 — avant `cors: { origin: [], credentials: false },`**

de @mastra/server) et s'authentifie par signature HMAC Slack.

**L.632 — avant `cors: { origin: [], credentials: false },`**

⚠️ SANS CETTE LIGNE, le serveur RENVOIE l'origine demandée avec

**L.633 — avant `cors: { origin: [], credentials: false },`**

`access-control-allow-credentials: true` — vérifié en production le 2026-08-18 :

**L.634 — avant `cors: { origin: [], credentials: false },`**

`Origin: https://evil.example.com` ressortait tel quel dans `access-control-allow-origin`.

**L.636 — avant `cors: { origin: [], credentials: false },`**

Honnêteté sur la portée : aucun scénario d'exploitation n'a été trouvé aujourd'hui.

**L.637 — avant `cors: { origin: [], credentials: false },`**

L'authentification est un jeton PORTEUR, qu'un navigateur n'attache jamais tout seul ;

**L.638 — avant `cors: { origin: [], credentials: false },`**

une page tierce ne gagne donc rien qu'elle ne puisse déjà faire depuis son propre

**L.639 — avant `cors: { origin: [], credentials: false },`**

serveur. Ce qu'on ferme est le jour où un cookie apparaîtrait — la combinaison

**L.640 — avant `cors: { origin: [], credentials: false },`**

origine reflétée + `credentials: true` est précisément celle qui rend ce jour-là

**L.641 — avant `cors: { origin: [], credentials: false },`**

catastrophique, et elle serait alors invisible parce que déjà en place.

**L.643 — avant `cors: { origin: [], credentials: false },`**

Liste VIDE et non `false` : `false` désactiverait le middleware CORS et laisserait

**L.644 — avant `cors: { origin: [], credentials: false },`**

l'absence d'en-tête dépendre de l'implémentation. Une liste vide ne matche aucune

**L.645 — avant `cors: { origin: [], credentials: false },`**

origine, donc aucun `access-control-allow-origin` n'est émis — et le produit n'a

**L.646 — avant `cors: { origin: [], credentials: false },`**

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
