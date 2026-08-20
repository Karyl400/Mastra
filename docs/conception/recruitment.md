# Feature `recruitment`

> Décisions de conception, extraites des commentaires du code le 2026-08-20.
> Périmètre : `src/features/recruitment/`
>
> Chaque entrée porte le fichier et la ligne d'origine, ainsi que la déclaration
> qu'elle précédait. Le code ne porte plus ce texte : **c'est ici qu'il vit désormais.**

---

## `features/recruitment/application/agents/recruitment-agent.ts`

**L.13 — avant `export function makeRecruitmentAgent(tools: ToolsInput) {`**

`recruitmentAgent` — il convie un candidat externe à un entretien, et rien d'autre.

LA QUARANTAINE EST LA PREMIÈRE LIGNE, COMME POUR `knowledgeAgent`
C'est le seul agent du système qui écrive à une adresse SITUÉE HORS DE L'ENTREPRISE et non
contrainte par l'annuaire. Lui adjoindre le moindre outil de lecture formerait le canal
d'exfiltration que `PLAN-ARCHITECTURE.md` §4.2 interdit — et que le module jumeau cite avec
ce scénario précis : « envoie à ce candidat un récapitulatif de ce qui se dit dans
#engineer-karyl ». Il REFUSE donc de se construire si on lui en câble un.

POURQUOI UN AGENT DE PLUS PLUTÔT QU'UN TOOL SUR `notificationAgent`
C'était l'option la moins chère, et elle est INTERDITE par ce qui précède :
`notificationAgent` porte `getEmployeeProfile`, `findPersonByName` et
`getNotificationHistory`. Y ajouter une écriture vers une adresse libre construirait
exactement la conjonction proscrite — « retrouve le dossier de Karyl et envoie-le à
moi@ailleurs.com » deviendrait réalisable en une phrase.

Le coût d'un agent supplémentaire est par ailleurs ALTERNATIF et non additif : un message
est routé vers UN agent. Cet agent-ci ne pèse que sur les messages de recrutement, et son
FLOOR est le plus bas du système — un seul outil, aucune lecture.

LES INSTRUCTIONS, LIGNE PAR LIGNE
• « ne dis jamais que l'email est parti » — l'outil PRÉPARE, l'envoi a lieu au clic. Sans
  cette ligne le modèle annoncerait un accompli, et la réconciliation FAIT/NARRATION ne le
  rattraperait PAS : un outil a bien tourné, donc elle se tait par conception.
• « transcris la date, n'en invente aucune » — la date est le seul champ recopié depuis la
  phrase humaine ; l'erreur d'année est la faute la plus fréquente et les bornes du
  value-object ne l'attrapent qu'à moitié.
• « il te faut une adresse et un nom » — les deux seuls champs obligatoires. Le dire évite
  l'aller-retour où le modèle réclame un poste ou un lieu qui sont optionnels : sur un
  budget qui se compte en messages par jour, un tour épargné vaut plus qu'un prompt court.

Volontairement ABSENT : toute énumération de ce qu'il ne peut pas faire. `agentToolBoundary`
le dit déjà, dérivé du câblage réel, et une liste rédigée se désynchronise au premier
changement.

## `features/recruitment/application/services/confirm-pending-email.ts`

**L.11 — avant `export interface ConfirmPendingEmailDeps {`**

Le « oui » — le seul acte IRRÉVERSIBLE du produit.

════════════════════════════════════════════════════════════════════════════
Ce qui est REJOUÉ, et ce qui ne l'est jamais
════════════════════════════════════════════════════════════════════════════

La table ne porte que des CHAMPS. Le sujet et le corps sont RE-RENDUS ici par le gabarit, et
la date RE-VALIDÉE. C'est le contrat que portait le `value` du bouton « Envoyer », et sa
raison n'a pas changé : transporter le corps ferait de ce chemin un moyen d'envoyer un texte
arbitraire à une adresse arbitraire — la primitive que toute la feature est construite pour
ne pas offrir.

⚠️ LA PRISE EST LA SUPPRESSION, et son compte décide. `clear()` rend le nombre de lignes
touchées : deux « oui » traités par deux instances ne peuvent pas envoyer deux fois, la
seconde rendant 0. Un `find` puis un `delete` conditionnel — la forme « naturelle » —
rouvrirait cette course, et son symptôme serait un candidat recevant deux invitations.

⚠️ ON REND LA PRISE sur échec de transport. Rien n'est parti, donc réessayer est légitime et
c'est même la seule chose à faire ; effacer obligerait à tout redemander au modèle, soit un
aller-retour complet pour une panne SMTP de trente secondes.

**L.39 — avant `readonly sendEmail: (to: string, subject: string, body: EmailBody) => Promise<unknown>;`**

⚠️ `EmailBody` et non `string` depuis le 2026-08-20 : `interview-email.ts` produit du
TEXTE BRUT, et les deux adaptateurs le plaçaient dans un slot HTML. Le nom d'un
candidat contenant un chevron y était interprété plutôt qu'affiché.

**L.78 — avant `export function pendingReminder(pending: PendingInterviewEmail): string {`**

⚠️ La phrase de RAPPEL, quand la personne parle d'autre chose. Elle ne bloque rien : on
répond au nouveau sujet ET on garde l'email en suspens. Le rappel est là parce qu'un email
préparé et oublié est exactement le genre de promesse en creux que ce dépôt traque — sauf
qu'ici c'est l'humain qui l'oublierait, pas le code.

**L.89 — avant `export function isPendingEmailStale(pending: PendingInterviewEmail, now: Date): boolean {`**

Cette préparation est-elle ABANDONNÉE ?

⚠️ Vérifié À LA LECTURE et non par un balayage : ce projet n'a aucun cron, et une purge qui
dépend d'un automate inexistant est la promesse creuse que ce dépôt traque. Le seul moment
où l'on est sûr de regarder cette ligne est celui où quelqu'un parle dans cette conversation.

**L.100 — avant `export function staleReply(pending: PendingInterviewEmail): string {`**

Ce qu'on dit UNE FOIS quand une préparation a expiré.

⚠️ On le DIT, on ne se contente pas d'effacer. La personne a vu un email complet et une
question ; le supprimer en silence la laisserait croire qu'il est peut-être parti. Dire que
rien n'est parti est la seule chose vraie et utile — et c'est la discipline `emailSent:
false` sous `status: 'success'`, appliquée à un oubli plutôt qu'à une panne.

**L.118 — avant `if (!clickerUserId || clickerUserId !== pending.requesterUserId) {`**

⚠️ Le demandeur, et lui seul. La conversation peut avoir des témoins — en fil de canal,

**L.119 — avant `if (!clickerUserId || clickerUserId !== pending.requesterUserId) {`**

tout le monde voit la question. Sans ce contrôle, un tiers écrirait à l'extérieur au nom

**L.120 — avant `if (!clickerUserId || clickerUserId !== pending.requesterUserId) {`**

de l'entreprise en tapant trois lettres.

**L.128 — avant `const parsed = parseInterviewSchedule(pending.startsAt, now);`**

Re-validation : entre la préparation et le « oui », la date a pu devenir passée.

**L.134 — avant `await deps.pending.clear(pending.conversationId);`**

Périmée pour de bon : on efface, cette préparation ne pourra plus rien envoyer.

**L.139 — avant `const taken = await deps.pending.clear(pending.conversationId);`**

⚠️ LA PRISE. Effacer AVANT d'envoyer, et n'envoyer que si l'on a bien pris : c'est ce qui

**L.140 — avant `const taken = await deps.pending.clear(pending.conversationId);`**

rend l'envoi unique face à deux instances. L'ordre inverse enverrait deux fois.

**L.158 — avant `logger.error('Email d’entretien NON envoyé', { error: String(error) });`**

⚠️ On ne prétend JAMAIS avoir envoyé, et on REND la prise : rien n'est parti, donc

**L.159 — avant `logger.error('Email d’entretien NON envoyé', { error: String(error) });`**

réessayer est légitime. Même discipline que `emailSent: false` sous `status: 'success'`.

**L.165 — avant `logger.info('Invitation d’entretien envoyée', {`**

⚠️ Aucune écriture en base, et c'est un choix inchangé : stocker l'adresse et l'invitation

**L.166 — avant `logger.info('Invitation d’entretien envoyée', {`**

d'un NON-SALARIÉ créerait des données personnelles sans chemin d'effacement. La trace vit

**L.167 — avant `logger.info('Invitation d’entretien envoyée', {`**

dans le fil Slack et ici, en journal, sans jamais l'adresse complète.

**L.178 — avant `export type PendingEmailVerdict = 'stale' | 'deferred' | 'cancel' | 'send' | 'unrelated';`**

CE QU'IL FAUT FAIRE d'une préparation en attente — la DÉCISION, sans l'EXÉCUTION.

════════════════════════════════════════════════════════════════════════════
Pourquoi cette fonction a été extraite du handler le 2026-08-20
════════════════════════════════════════════════════════════════════════════

Elle vivait dans `resolvePendingEmail`, mêlée aux effets (effacer, envoyer, publier). Or il
fallait poser exactement la même question à un SECOND endroit — le miroir exact du
rationnement, qui doit savoir si un message sera traité SANS appel de modèle avant de le
refuser pour cause de quota. La réécrire là-bas aurait été la TROISIÈME copie d'un prédicat
dans ce dépôt, configuration où il a déjà payé : deux bords corrects, aucun câblage entre
les deux, et une divergence qui ne se voit qu'en production.

Séparer la décision de l'exécution est d'ailleurs la doctrine déjà appliquée à
`DETERMINISTIC_REPLIES` : « ce qui reste chez le handler, c'est l'EXÉCUTION — il est le seul
à avoir les dépôts et le client Slack ; ce qui vit ici, c'est la DÉCISION. »

⚠️ `onboardingQuestionPending` est passé en PARAMÈTRE et non calculé : le prédicat vit dans
la couche `infrastructure` du handler, et cette couche-ci ne peut pas l'importer sans
inverser la règle de dépendance. Un booléen traverse la frontière ; un import ne le peut pas.

**L.210 — avant `if (input.onboardingQuestionPending) return 'deferred';`**

⚠️ LA QUESTION D'ACCUEIL PRIME. Les deux erreurs ne se valent pas : capturer « oui » comme

**L.211 — avant `if (input.onboardingQuestionPending) return 'deferred';`**

un prénom se corrige d'un message, envoyer une invitation à un candidat ne se corrige pas.

**L.217 — avant `return 'unrelated';`**

La personne parle d'autre chose. On ne l'interrompt pas — on lui répond, et l'email reste

**L.218 — avant `return 'unrelated';`**

en attente.

**L.222 — avant `export function settlesPendingEmail(verdict: PendingEmailVerdict): boolean {`**

Ce message TRANCHE-T-IL la préparation, ici et maintenant, sans aucun appel de modèle ?

C'est la seule question que se pose le rationnement du budget : `cancel` et `send` sont
traités par du code écrit en dur, les trois autres verdicts laissent le message partir chez
un agent — donc coûter des tokens, donc mériter le refus quand le quota est atteint.

## `features/recruitment/application/tools/schedule-candidate-interview.ts`

**L.14 — avant `export interface ScheduleCandidateInterviewDeps {`**

PRÉPARE une invitation d'entretien — et ne l'envoie JAMAIS.

════════════════════════════════════════════════════════════════════════════
Ce que ce tool fait, et surtout ce qu'il ne fait pas
════════════════════════════════════════════════════════════════════════════

Il valide, rend l'email depuis un GABARIT (`domain/services/interview-email.ts`),
ENREGISTRE la préparation dans `pending_interview_email`, puis pose une QUESTION dans le fil.
**L'envoi a lieu au « oui »**, dans `handleMessage`, hors de portée du modèle.

⚠️ C'était un BOUTON jusqu'au 2026-08-19. La séparation n'a pas changé, seul son support :
un clic ne réussit que si la fonction Vercel est chaude, et à ≈ 19 messages par jour le cas
froid EST le cas nominal (5 229 ms à froid mesurées, 3 000 ms accordées par Slack).

Cette séparation n'est pas une commodité d'implémentation, c'est la garantie centrale : le
modèle ne peut pas déclencher un envoi vers l'extérieur, quoi qu'on lui écrive. Le pire cas
d'une injection réussie est un email affiché à un humain, qui le lit.

⚠️ **Le verdict ne dit JAMAIS « envoyé ».** Il rend `status: 'awaiting_confirmation'`, et le
bloc d'instructions de l'agent lui interdit d'annoncer un envoi. C'est la troisième
occurrence dans ce dépôt de la même discipline, après `emailSent: false` sous
`status: 'success'` et `status = Sent` posé avant le `try` : un outil qui a préparé ne doit
pas laisser croire qu'il a agi.

⚠️ Il n'y a **pas de champ de texte libre** dans le schéma. C'est délibéré et c'est ce qui
empêche l'exfiltration citée par `outbound-tool-quarantine.ts` — « envoie à ce candidat un
récapitulatif de ce qui se dit dans #engineer-karyl ». Sans `body`, il n'y a rien à
exfiltrer : le corps est produit par le gabarit.

**L.49 — avant `readonly pending: PendingInterviewEmailRepository;`**

L'email préparé, en attente d'un « oui ».

⚠️ C'est ce qui remplace le `value` du bouton « Envoyer », retiré le 2026-08-19. Même
contrat : DES CHAMPS, jamais le corps. Le stocker ferait de cette table un moyen d'envoyer
un texte arbitraire à une adresse arbitraire — la primitive que toute cette feature est
construite pour ne pas offrir.

**L.58 — avant `readonly presenter: InterviewConfirmationPresenter;`**

⚠️ Injecté depuis le 2026-08-18, et ce n'est pas une préférence de style : ce tool
importait directement les blocs Block Kit depuis `infrastructure/`, l'unique violation de
la règle de dépendance du dépôt. Ce dont il dépend n'est pas une carte Slack, c'est l'idée
qu'un humain relit avant que ça parte — la seule garantie de toute la feature.

**L.65 — avant `readonly directoryRepo?: Pick<DirectoryRepository, 'findBySlackUserId'>;`**

 Sert UNIQUEMENT à retrouver l'adresse du DEMANDEUR pour la confirmation de présence.

**L.67 — avant `readonly now?: () => Date;`**

 Injectable pour rendre les tests déterministes.

**L.84 — avant `const ALREADY_PREPARED_HINT =`**

UNE invitation par message de l'utilisateur.

⚠️ Défaut OBSERVÉ en production le 2026-08-14, au deuxième test réel : sur « Prépare un
entretien pour contact.kisso.test@gmail.com le 25 août », **DEUX cartes** ont été postées à
une seconde d'intervalle — celle demandée, et une seconde re-préparant l'invitation du
message PRÉCÉDENT, ressortie de la mémoire conversationnelle.

C'est le mode d'échec déjà documenté pour `generateDocument` (« 7 documents et 3 emails
identiques en 8 minutes ») : sommé de faire, le modèle REFAIT plutôt que de constater. Le
correctif est le même et réutilise le même module partagé.

⚠️ La clé ne porte NI l'adresse NI la date, contrairement à celle de `generateDocument`, et
c'est délibéré : les deux cartes en double portaient des destinataires DIFFÉRENTS. Une clé
qui les distingue ne les aurait pas dédupliquées. On borne donc à une invitation par
message.

Contrepartie assumée : « invite A et B pour lundi » ne prépare que la première, et le
verdict le DIT (`already_prepared`) pour que le modèle puisse l'annoncer au lieu de le
taire. C'est le bon compromis ici — rien ne part sans clic, donc le coût d'une carte
manquante est un message de plus, là où le coût d'une invitation fantôme est une convocation que
personne n'a demandée sous les yeux d'un humain qui pourrait la valider par réflexe.

⚠️ « rien ne part sans clic » se lit désormais « rien ne part sans un « oui » écrit ». La
propriété est la même, et elle est même plus forte : `readsAsYes` est strict par
construction et refuse toute nuance, là où un bouton ne distingue pas un clic délibéré d'un
clic par réflexe.

**L.148 — avant `if (!canPerformSideEffects(requestContext)) {`**

── 1. Le DROIT, avant toute lecture et avant tout rendu ────────────────

**L.149 — avant `if (!canPerformSideEffects(requestContext)) {`**

Même politique que `sendNotification` : on ne crée pas une troisième règle

**L.150 — avant `if (!canPerformSideEffects(requestContext)) {`**

d'autorisation, deux copies d'une décision divergent tôt ou tard.

**L.160 — avant `const runKey = buildRunKey(slack.eventTs, 'scheduleCandidateInterview', []);`**

── 1 bis. UNE carte par message ────────────────────────────────────────

**L.161 — avant `const runKey = buildRunKey(slack.eventTs, 'scheduleCandidateInterview', []);`**

Hors Slack, `buildRunKey` rend `undefined` et la garde est INACTIVE : le playground

**L.162 — avant `const runKey = buildRunKey(slack.eventTs, 'scheduleCandidateInterview', []);`**

et les tests ne sont bornés par aucune conversation.

**L.171 — avant `const parsed = parseInterviewSchedule(data.startsAt, now());`**

── 2. La DATE, seule donnée transcrite depuis la phrase humaine ────────

**L.177 — avant `const location = checkInterviewLocation(data.location);`**

── 3. Le LIEU : refusé, jamais amputé ──────────────────────────────────

**L.188 — avant `const replyTo = await resolveRequesterEmail(deps, slack.slackUserId);`**

── 4. À QUI le candidat répond — le demandeur, jamais `noreply@` ───────

**L.200 — avant `const conversationId = deriveConversationId({`**

⚠️ ON ENREGISTRE AVANT DE DEMANDER. L'inverse laisserait une fenêtre où la personne

**L.201 — avant `const conversationId = deriveConversationId({`**

répond « oui » à une question dont rien ne garde la trace — et le « oui » partirait

**L.202 — avant `const conversationId = deriveConversationId({`**

alors chez un agent, qui n'a aucun moyen d'envoyer quoi que ce soit. Un état qu'on

**L.203 — avant `const conversationId = deriveConversationId({`**

annonce doit exister avant qu'on l'annonce ; c'est la règle de tout ce dépôt.

**L.204 — avant `const conversationId = deriveConversationId({`**

⚠️ La CONVERSATION, pas le canal : en fil de canal, deux préparations parallèles ne

**L.205 — avant `const conversationId = deriveConversationId({`**

doivent pas se marcher dessus. En DM `threadTs` est absent par conception, donc le

**L.206 — avant `const conversationId = deriveConversationId({`**

canal EST la conversation — exactement la règle de la mémoire conversationnelle, et

**L.207 — avant `const conversationId = deriveConversationId({`**

on la réutilise plutôt que de la redériver ici.

**L.246 — avant `if (runKey) runGuard.remember(runKey, true);`**

⚠️ Mémorisé APRÈS la publication réussie, jamais avant : un échec d'affichage ne doit

**L.247 — avant `if (runKey) runGuard.remember(runKey, true);`**

pas condamner une seconde tentative légitime du modèle. Même ordre que

**L.248 — avant `if (runKey) runGuard.remember(runKey, true);`**

`generateDocument`, et pour la même raison.

**L.251 — avant `return {`**

⚠️ `awaiting_confirmation`, et le mot compte : c'est ce que le modèle va reformuler.

**L.252 — avant `return {`**

Le champ `whenLabel` lui donne de quoi NOMMER la date sans la recalculer — recalculer

**L.253 — avant `return {`**

est précisément ce qui réintroduirait une erreur de transcription dans la réponse.

**L.258 — avant `hint: "L'email complet et la question sont DÉJÀ sous les yeux de la personne. Réponds EXACTEMENT`**

⚠️ Le hint PRESCRIT la phrase, il ne décrit plus la situation — correctif du

**L.259 — avant `hint: "L'email complet et la question sont DÉJÀ sous les yeux de la personne. Réponds EXACTEMENT`**

2026-08-19, mesuré en production. Le texte précédent disait « l'email est affiché

**L.260 — avant `hint: "L'email complet et la question sont DÉJÀ sous les yeux de la personne. Réponds EXACTEMENT`**

au-dessus, n'ajoute rien » et le modèle a répondu « L'email d'entretien est prêt, il

**L.261 — avant `hint: "L'email complet et la question sont DÉJÀ sous les yeux de la personne. Réponds EXACTEMENT`**

s'affichera pour confirmation » : au FUTUR, alors que la personne l'avait déjà sous

**L.262 — avant `hint: "L'email complet et la question sont DÉJÀ sous les yeux de la personne. Réponds EXACTEMENT`**

les yeux, et en doublon de la question qui venait d'être posée. Une consigne

**L.263 — avant `hint: "L'email complet et la question sont DÉJÀ sous les yeux de la personne. Réponds EXACTEMENT`**

NÉGATIVE (« n'ajoute rien ») n'a rien à quoi s'accrocher — `progress.resolve` poste

**L.264 — avant `hint: "L'email complet et la question sont DÉJÀ sous les yeux de la personne. Réponds EXACTEMENT`**

toujours quelque chose, donc le modèle doit bien écrire une phrase. On lui donne

**L.265 — avant `hint: "L'email complet et la question sont DÉJÀ sous les yeux de la personne. Réponds EXACTEMENT`**

laquelle.

**L.272 — avant `async function resolveRequesterEmail(`**

⚠️ Ne LÈVE jamais, et l'absence d'adresse n'est PAS un échec : le gabarit omet alors la
phrase de confirmation. Faire échouer la préparation parce que le demandeur n'a pas de ligne
d'annuaire punirait le candidat pour un trou de l'annuaire — et 22 lignes sur 40 sont
incomplètes en production.

## `features/recruitment/domain/ports/interview-confirmation.presenter.ts`

**L.1 — avant `export interface InterviewConfirmationPayload {`**

Comment une invitation d'entretien est PRÉSENTÉE pour relecture, avant envoi.

## Pourquoi un port pour deux fonctions

`scheduleCandidateInterview` (couche `application`) importait directement
`buildInterviewConfirmBlocks` depuis `infrastructure/handlers/` — l'unique violation de la
règle de dépendance de tout le dépôt, relevée le 2026-08-18. Elle passait parce que le test
d'architecture ne surveillait que `domain/` ; il couvre désormais `application/` aussi.

Ce n'est pas du purisme. Ce tool ne dépend pas d'une carte Block Kit, il dépend de l'idée
qu'« un humain relit avant que ça parte » — et c'est la SEULE garantie de toute la feature :
le modèle ne fournit aucune prose sortante, le corps est rendu par un gabarit, et rien ne
part sans un clic. Cette garantie ne doit pas être attachée à Slack.

⚠️ IL NE REND PLUS DES BLOCS MAIS DU TEXTE — 2026-08-19. Les boutons ont été retirés du
produit : la relecture se conclut désormais par une QUESTION à laquelle on répond oui ou non.
Le port n'en est pas affaibli, il est même plus fidèle à ce qu'il déclare : il portait déjà
« une confirmation se PRÉSENTE, l'infrastructure sait avec quoi », et la réponse est
maintenant du texte plutôt qu'une carte. La garantie — un humain relit avant que ça parte —
est inchangée.

**L.26 — avant `readonly startsAt: string;`**

 ISO — revalidé à l'envoi, jamais rejoué sur confiance.

**L.31 — avant `readonly requesterUserId: string;`**

 Comparé à l'auteur du CLIC : la carte est visible de tous ceux qui voient le fil.

**L.36 — avant `buildConfirmationText(input: {`**

Le texte de relecture, terminé par la QUESTION.

⚠️ L'email est affiché INTÉGRALEMENT, corps compris. Un résumé (« un email va partir à
Jean ») rendrait la confirmation décorative : on ne peut pas relire ce qu'on ne voit pas,
et c'est la relecture qui est la valeur de cette étape.

**L.50 — avant `fallbackText(candidateName?: string): string;`**

 Texte de repli : Slack l'utilise pour l'aperçu et les lecteurs d'écran.

## `features/recruitment/domain/ports/pending-email.repository.ts`

**L.1 — avant `export const PENDING_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;`**

L'email préparé et NON ENVOYÉ, en attente d'un oui.

════════════════════════════════════════════════════════════════════════════
Pourquoi une TABLE, alors que tout le reste du parcours lit le fil
════════════════════════════════════════════════════════════════════════════

Les deux machines à états de l'accueil (`profile-chat`, `interview-chat`) n'ont AUCUNE table :
leur état est le dernier tour `assistant` du fil, ce qui est gratuit et suffisant tant que
l'état ne survit pas à une digression.

Ici il doit y survivre, et c'est une exigence explicite : « en cas de changement de sujet,
faire un rappel sur l'email à envoyer, et si l'utilisateur veut changer de sujet, changer de
sujet et garder l'email en suspens ». Un état qui doit tenir pendant qu'on parle d'autre chose
ne peut pas être le dernier message du bot — par définition, ce n'est plus lui.

⚠️ ON NE STOCKE QUE DES CHAMPS, JAMAIS LE CORPS. C'est le contrat que portait déjà le `value`
du bouton, et sa raison n'a pas changé : transporter le corps ferait de cette table un moyen
d'envoyer un texte arbitraire à une adresse arbitraire — la primitive que toute la feature est
construite pour ne pas offrir. Le sujet et le corps sont RE-RENDUS à l'envoi par le gabarit,
et la date RE-VALIDÉE.

⚠️ Une ligne par CONVERSATION, pas par personne : c'est la conversation qui porte le fil du
dialogue, et c'est dans ce fil qu'on répondra « oui ». Une seconde préparation dans la même
conversation REMPLACE la première — l'humain n'en voit qu'une à l'écran.

**L.27 — avant `export const PENDING_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;`**

Au-delà de cette ancienneté, une préparation est ABANDONNÉE.

════════════════════════════════════════════════════════════════════════════
Pourquoi une borne, et pourquoi celle-là
════════════════════════════════════════════════════════════════════════════

Sans elle, une préparation ne meurt jamais. Deux conséquences, et la seconde est celle qui
se voit :

 1. La ligne reste sur la Turso indéfiniment — c'est l'adresse email d'un NON-SALARIÉ, une
    donnée personnelle sans chemin d'effacement (`forget()` ne l'emporte pas : elle n'est
    pas dans la conversation). Le dépôt recense déjà ce trou pour `notifications` et
    `documents` ; on ne l'agrandit pas.
 2. Le RAPPEL est accolé à chaque réponse d'agent tant que la préparation vit. Un email
    préparé puis oublié ferait donc répéter la même parenthèse à l'infini — le bruit qui
    s'ignore, exactement ce que le rappel existe pour éviter.

24 heures : au-delà, la personne a changé de journée, et redemander lui coûte un message
là où la relecture d'un email préparé la veille ne veut plus dire grand-chose. La borne est
VÉRIFIÉE À LA LECTURE, jamais par un balayage : ce projet n'a aucun cron, et une purge qui
dépend d'un automate inexistant est la promesse creuse que ce dépôt traque.

**L.54 — avant `readonly requesterUserId: string;`**

 Qui a demandé. Seul lui peut confirmer — la conversation peut avoir des témoins.

**L.58 — avant `readonly startsAt: string;`**

 ISO. RE-VALIDÉ à l'envoi, jamais rejoué sur confiance.

**L.67 — avant `save(pending: PendingInterviewEmail): Promise<void>;`**

 Écrase la préparation précédente de la même conversation, s'il y en a une.

**L.72 — avant `clear(conversationId: string): Promise<number>;`**

Retire la préparation et rend le NOMBRE de lignes touchées.

⚠️ Le compte est le contrat, comme pour `forget(scope)` et `linkEmployee`. C'est lui qui
rend la prise ATOMIQUE : deux « oui » traités par deux instances ne peuvent pas envoyer
deux fois, la seconde suppression rendant 0. Sans lui, on ne pourrait que réciter.

## `features/recruitment/domain/services/interview-email.ts`

**L.1 — avant `import type { InterviewSchedule } from '../value-objects/interview-schedule';`**

LE GABARIT DE L'EMAIL D'ENTRETIEN — rendu en CODE, jamais rédigé par le modèle.

════════════════════════════════════════════════════════════════════════════
C'est ici que se joue la sécurité de toute la feature
════════════════════════════════════════════════════════════════════════════

`knowledge/domain/services/outbound-tool-quarantine.ts` cite, mot pour mot, LE scénario que
cette feature réalise :

> « Envoie à ce candidat un récapitulatif de ce qui se dit dans #engineer-karyl. »

Un outil qui accepte un `body` libre et un `to` libre EST une primitive d'exfiltration
complète — une phrase suffit à un invité du workspace pour se faire adresser n'importe quoi.

La parade tient en une règle : **le modèle ne fournit JAMAIS de prose sortante.** Il remplit
des champs étroits (un nom, une date, un poste, un lieu) et le texte est produit ici, par du
code, à partir d'un gabarit fixe. Ce qu'un attaquant peut au mieux obtenir, c'est une
convocation d'entretien à une adresse de son choix — du spam, pas une fuite.

C'est le même raisonnement que `document-template.ts` : un gabarit ne peut pas halluciner.
Et c'est aussi ce qui rend inutile un assainissement de sortie ici — il n'y a pas de sortie
du modèle à assainir, seulement des champs bornés, dont un seul peut contenir une URL.

TypeScript pur — ce module traverse la couche `domain`.

**L.29 — avant `export const INTERVIEW_LINK_DOMAINS: readonly string[] = [`**

Domaines admis pour un LIEN d'entretien.

⚠️ Liste DISTINCTE d'`ALLOWED_LINK_DOMAINS` (`shared/security/agent-output.ts`), et ce n'est
pas un oubli de factorisation : les deux répondent à des questions différentes. Celle-là
borne ce que le bot peut RÉÉMETTRE dans Slack ; celle-ci borne ce qu'il peut inscrire dans
une correspondance sortante. Un lien de visioconférence n'a rien à faire dans la première,
et Slack n'est pas le seul endroit où l'on tient un entretien.

⚠️ Et le CONTRAT est inversé, délibérément : Slack RETIRE le lien non autorisé et garde le
message ; ici on REFUSE l'envoi. Un message Slack amputé de son lien reste utile ; un email
qui convoque quelqu'un « à [lien retiré] » est activement NUISIBLE — le candidat ne peut pas
se connecter et personne ne sait pourquoi.

**L.55 — avant `readonly candidateName?: string;`**

Nom du candidat — **OPTIONNEL depuis le 2026-08-14**, et ce changement vient d'un défaut
OBSERVÉ en production.

Il était obligatoire. Sur « Envoie un email d'entretien à ridwanenico77@gmail.com pour le
20 août », le modèle a rendu `candidateName: "Ridwane Nico"` — un nom **fabriqué à partir
de l'adresse**, que personne n'avait donné. C'est exactement la mécanique documentée
ailleurs dans ce dépôt : **un champ requis force l'invention**, et aucune validation Zod
ne peut la voir puisque la valeur produite est parfaitement bien formée. Même famille que
`createEmployee` substituant une valeur d'allowlist valide, et que le
`votre_email@example.com` de `find-employee-by-email.ts`.

Absent ⇒ « Bonjour, », qui est une ouverture correcte et courante en français. Une
salutation sans nom vaut mieux qu'une salutation au mauvais nom — surtout dans le premier
contact d'une entreprise avec un candidat.

**L.73 — avant `readonly position?: string;`**

 Poste concerné. Omis proprement s'il est absent — jamais inventé.

**L.75 — avant `readonly location?: string;`**

 Lien de visio ou adresse physique. Validé par {@link checkInterviewLocation}.

**L.77 — avant `readonly replyTo?: string;`**

Adresse à laquelle le candidat répond pour confirmer sa présence.

⚠️ C'est celle du DEMANDEUR, résolue dans l'annuaire — **jamais `NOTIFICATION_FROM`**, qui
vaut `noreply@kisso.com` et que personne ne lit. Demander une confirmation à une adresse
sans lecteur est exactement la famille de mensonge que ce dépôt traque (`emailSent: false`
sous `status: 'success'`) : la phrase promet une réponse que rien ne recevra.

Absente ⇒ la phrase de confirmation est OMISE, pas rendue vers un puits.

**L.108 — avant `lines.push(`Date : ${input.schedule.humanReadable}`);`**

L'offset est DANS `humanReadable`. Sans lui, un candidat qui n'est pas dans le même fuseau

**L.109 — avant `lines.push(`Date : ${input.schedule.humanReadable}`);`**

se présente à la mauvaise heure — et l'erreur ne se découvre qu'au moment de l'entretien.

**L.126 — avant `export function checkInterviewLocation(location: string | undefined): LocationVerdict {`**

Un lieu est-il acceptable ?

Une adresse PHYSIQUE passe telle quelle : ce n'est pas un vecteur, seulement du texte borné.
Une URL, en revanche, sort du processus et sera cliquée par un tiers — elle est donc
confrontée à {@link INTERVIEW_LINK_DOMAINS}.

⚠️ On refuse au lieu de retirer, voir le commentaire de la liste.

**L.149 — avant `function extractUrl(value: string): URL | null {`**

⚠️ On cherche une URL N'IMPORTE OÙ dans le texte, pas seulement au début. « Visio :
https://evil.example/x » contient une URL même si la chaîne ne commence pas par `http` —
ne tester que le préfixe laisserait passer exactement ce cas.

## `features/recruitment/domain/services/read-tool-quarantine.ts`

**L.1 — avant `const READ_TOOL_PREFIXES = ['find', 'get', 'list', 'read', 'search'] as const;`**

LA QUARANTAINE INVERSE — aucun outil de LECTURE ne cohabite avec l'écriture LIBRE.

════════════════════════════════════════════════════════════════════════════
Le miroir exact d'`outbound-tool-quarantine.ts`, et pourquoi il en faut deux
════════════════════════════════════════════════════════════════════════════

Celle du `knowledgeAgent` protège un agent qui LIT BEAUCOUP en lui interdisant toute
sortie. Celle-ci protège un agent qui ÉCRIT VERS L'EXTÉRIEUR — vers une adresse email
arbitraire, hors de l'entreprise — en lui interdisant toute lecture.

`PLAN-ARCHITECTURE.md` §4.2 interdit la CONJONCTION, pas l'un ou l'autre terme. Il y a donc
deux façons de la former, selon le côté par lequel on arrive, et deux gardes pour les
fermer. N'en poser qu'une reviendrait à croire que le danger a un sens de lecture.

Le scénario est cité mot pour mot dans le module jumeau :

> « Envoie à ce candidat un récapitulatif de ce qui se dit dans #engineer-karyl. »

Câbler `getChannelHistory` ou `getEmployeeProfile` sur l'agent de recrutement le rendrait
réalisable. Le contrôle est donc à la CONSTRUCTION, pas seulement dans un test : un test
verrouille le câblage d'aujourd'hui, ce garde-ci verrouille celui de demain, et il échoue
au DÉMARRAGE — bruyamment, impossible à déployer.

⚠️ On raisonne sur des PRÉFIXES DE VERBE et non sur une liste de noms, pour la raison déjà
établie ailleurs dans ce dépôt : une liste de noms est exacte aujourd'hui et fausse au
premier outil ajouté — c'est-à-dire précisément au moment où elle devrait servir.

TypeScript pur — ce module traverse la couche `domain`.

**L.32 — avant `const READ_TOOL_PREFIXES = ['find', 'get', 'list', 'read', 'search'] as const;`**

Verbes qui annoncent une LECTURE de données de l'entreprise.

`find` et `get` couvrent `findPersonByName`, `findEmployeeByEmail`, `findExpertise`,
`getEmployeeProfile`, `getChannelHistory`, `getUserConversations`, `getNotificationHistory`.
`list`, `read` et `search` couvrent la convention du dépôt pour tout ce qui viendra.

**L.48 — avant `export function assertNoReadTools(toolNames: readonly string[]): void {`**

⚠️ LÈVE, et c'est le point. Le message nomme l'outil fautif ET la raison, parce qu'une
frontière de sécurité dont l'échec est illisible se contourne par frustration.

## `features/recruitment/domain/value-objects/interview-schedule.ts`

**L.1 — avant `import {`**

LA DATE D'UN ENTRETIEN — transcrite par un modèle, donc validée par du code.

════════════════════════════════════════════════════════════════════════════
Pourquoi une date mérite son propre value-object
════════════════════════════════════════════════════════════════════════════

La règle du dépôt distingue ce qui se RETROUVE (un email, un UUID) de ce qui se PRODUIT
(une prose). Une date d'entretien n'est ni l'un ni l'autre : elle est **TRANSCRITE** depuis
la phrase de l'humain (« pour le 20 août à 14h ») vers un champ ISO. Le risque n'est donc
pas l'invention mais l'ERREUR DE TRANSCRIPTION — et elle a deux formes connues :

 1. **L'année.** Un modèle entraîné avant l'année courante écrit volontiers `2025-08-20`
    pour « le 20 août ». L'entretien part alors dans le PASSÉ.
 2. **L'heure.** « 14h » → `02:00`, ou un décalage de fuseau silencieux.

Aucune validation Zod ne voit ces erreurs : `2025-08-20T14:00:00Z` est une chaîne ISO
parfaitement valide. D'où les deux bornes ci-dessous, qui sont les SEULES à pouvoir les
attraper, et l'affichage en toutes lettres qui laisse un humain trancher le reste.

⚠️ Ces bornes ne remplacent pas la relecture humaine, elles la rendent utile : la carte de
confirmation affiche « jeudi 20 août 2026 à 14:00 (UTC+01:00) », et une erreur d'heure ou
de jour saute aux yeux sous cette forme, là où `2026-08-20T13:00:00.000Z` ne dit rien à
personne.

TypeScript pur — ce module traverse la couche `domain`.

⚠️ Le FORMATAGE a été extrait dans `shared/french-datetime.ts` le 2026-08-19 : il existait
en trois exemplaires divergents dans ce dépôt, et le seul défaut mesuré en production venait
de celui qui n'existait pas — `scheduleReminder` laissait le modèle écrire le jour de la
semaine, qui s'est révélé faux. Ce qui reste ici, ce sont les BORNES, qui sont propres à un
entretien.

**L.35 — avant `import {`**

Fuseau d'affichage. `Africa/Lagos` = WAT, UTC+1 — le fuseau relevé dans les rapports de
test de ce dépôt.

⚠️ Il est LU DANS L'ENVIRONNEMENT et non codé en dur, parce qu'une erreur ici est invisible
et coûteuse : le candidat se présente à la mauvaise heure et personne ne comprend pourquoi.
L'offset est de toute façon IMPRIMÉ dans l'email (« (UTC+01:00) »), ce qui rend l'hypothèse
vérifiable par son destinataire au lieu d'être implicite.

**L.50 — avant `export const INTERVIEW_TIMEZONE = DISPLAY_TIMEZONE;`**

⚠️ RÉEXPORT de `DISPLAY_TIMEZONE`, plus une seconde lecture de `process.env` — corrigé le
2026-08-19. Ce module lisait `RECRUITMENT_TIMEZONE` directement, `french-datetime.ts` lit
`DISPLAY_TIMEZONE || RECRUITMENT_TIMEZONE` : poser la première variable aurait donc changé
l'affichage PARTOUT SAUF ici, sans qu'aucun test ne rougisse. Un fuseau ne fait jamais
échouer personne — il fait seulement se présenter à la mauvaise heure.

**L.59 — avant `export const MAX_INTERVIEW_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;`**

Un entretien ne peut pas être fixé à plus d'un an. Cette borne n'existe pas pour des raisons
métier mais pour attraper la faute de frappe d'année dans l'autre sens (`2027` pour `2026`),
symétrique de celle que la borne « futur » attrape.

**L.69 — avant `readonly at: Date;`**

 Instant absolu, sans ambiguïté de fuseau.

**L.71 — avant `readonly humanReadable: string;`**

 « jeudi 20 août 2026 à 14:00 (UTC+01:00) » — la forme qu'un humain peut vérifier.

**L.73 — avant `readonly shortLabel: string;`**

 « jeudi 20 août à 14:00 » — forme courte, pour l'objet de l'email.

**L.77 — avant `export function parseInterviewSchedule(`**

⚠️ Ne LÈVE jamais : rend un verdict. Un `throw` ici remonterait au modèle sous forme
d'erreur d'outil, que ce dépôt sait qu'il transforme en narration ; un verdict nommé se
rend à l'humain tel quel.

**L.90 — avant `if (at.getTime() <= now.getTime()) return { ok: false, reason: 'date_in_past' };`**

Strictement dans le futur. C'est la borne qui attrape l'erreur d'ANNÉE, de loin la plus

**L.91 — avant `if (at.getTime() <= now.getTime()) return { ok: false, reason: 'date_in_past' };`**

fréquente : un modèle écrit volontiers l'année sur laquelle il a été entraîné.

## `features/recruitment/infrastructure/handlers/interview-confirm.ts`

**L.1 — avant `import type { InterviewConfirmationPresenter } from '../../domain/ports/interview-confirmation.p`**

LA CARTE DE CONFIRMATION — le dernier point où un humain voit l'email avant qu'il ne parte.

════════════════════════════════════════════════════════════════════════════
Pourquoi une confirmation, alors que la demande disait « envoie »
════════════════════════════════════════════════════════════════════════════

Ce dépôt vient de passer une campagne entière sur un bug où un document est parti à la
MAUVAISE ADRESSE parce que le modèle avait choisi le mauvais identifiant — les dix documents
de la base portent le même UUID, dont un intitulé « Bienvenue Awa ». Ici, l'adresse n'est
même plus contrainte par un annuaire : elle est libre, elle sort de l'entreprise, et
l'envoi est IRRÉVERSIBLE.

Les deux fautes qu'un humain voit en une seconde et qu'aucun code ne peut attraper :
  - l'adresse est celle d'un homonyme, ou comporte une coquille ;
  - la date est le bon jour de la mauvaise semaine.

Le coût de la parade est UN CLIC et **zéro token** — Block Kit ne passe par aucun modèle.

⚠️ La carte est postée là où la demande a été faite. En canal, cela signifie que des tiers
la voient : c'est délibéré et sans risque ici, contrairement à la modale de profil dont le
`value` porte les données personnelles de quelqu'un (d'où sa restriction au DM). Ce qui est
affiché ici est une convocation que le demandeur vient lui-même de dicter.

**L.31 — avant `export interface InterviewConfirmPayload {`**

Ce que le bouton transporte. Il voyage dans le `value` du bloc Slack et revient signé par
Slack — c'est le même modèle de confiance que le pré-remplissage du profil.

⚠️ `requesterUserId` n'est PAS décoratif : il est comparé à l'auteur du CLIC. Sans lui,
n'importe quel témoin d'un canal pourrait déclencher un envoi vers l'extérieur au nom de
l'entreprise — la carte est visible de tous ceux qui voient le fil.

**L.41 — avant `readonly candidateName?: string;`**

 Optionnel : absent quand la demande ne portait qu'une adresse.

**L.43 — avant `readonly startsAt: string;`**

 ISO — revalidé à l'envoi, jamais rejoué sur confiance.

**L.51 — avant `const MAX_VALUE_CHARS = 2000;`**

Slack borne le `value` d'un bouton à 2 000 caractères. On l'encode en JSON compact et on
VÉRIFIE la borne à la construction plutôt que de découvrir la troncature au clic — Slack
rejette la vue entière au-delà, ce qui se manifesterait par « le bouton ne fait rien ».

**L.69 — avant `export function decodeInterviewConfirm(raw: string | undefined): InterviewConfirmPayload | null `**

 ⚠️ Ne lève jamais : un `value` illisible doit produire un refus lisible, pas une 500.

**L.92 — avant `export function buildInterviewConfirmBlocks(input: {`**

⚠️ L'email est affiché INTÉGRALEMENT, corps compris. Montrer un résumé (« un email va partir
à Jean ») rendrait la confirmation décorative : on ne peut pas relire ce qu'on ne voit pas,
et c'est précisément la relecture qui est la valeur de cette étape.

**L.117 — avant `text: { type: 'mrkdwn', text: `\`\`\`${input.subject}\n\n${input.body}\`\`\`` },`**

Bloc de code : le corps n'est ni interprété comme du mrkdwn ni tronqué en silence.

**L.129 — avant `confirm: {`**

Slack redemande confirmation côté client : le second garde-fou est gratuit, et

**L.130 — avant `confirm: {`**

celui-ci protège du clic accidentel plutôt que de l'erreur de contenu.

**L.149 — avant `export function buildSettledCardBlocks(input: {`**

La carte, RÉÉCRITE une fois qu'elle a servi — sans aucun bouton.

⚠️ C'est la pièce qui manquait. `sendBlocks` rendait son `ts` avec, en commentaire, « le
seul moyen de neutraliser un bouton après son premier clic » : la capacité était décrite
et n'avait jamais été câblée. La carte restait donc entièrement cliquable après un envoi
réussi ET après « Annuler » — sur la seule action irréversible du système.

Elle ne se contente pas d'empêcher : elle DIT ce qui s'est passé, à l'endroit même où on
a cliqué. C'est ce qui manquait le plus — une personne qui ne voit pas si son clic a porté
reclique, et c'est ainsi qu'un candidat reçoit deux invitations.

On conserve le récapitulatif (à qui, quand) : la trace de ce qui a été envoyé vit dans le
fil Slack et nulle part ailleurs — aucune ligne n'est écrite en base, par choix documenté.

**L.177 — avant `export function confirmFacts(payload: InterviewConfirmPayload, whenLabel: string): string[] {`**

 Les faits à conserver sur la carte réécrite : à qui, et quand.

**L.182 — avant `export function interviewConfirmFallback(candidateName?: string): string {`**

 Repli de notification : Slack l'utilise pour l'aperçu et les lecteurs d'écran.

**L.192 — avant `export const INTERVIEW_NOT_YOURS_REPLY =`**

⚠️ Ce refus existe parce que la carte est visible de tous ceux qui voient le fil. Un témoin
ne doit pas pouvoir écrire à l'extérieur au nom de l'entreprise.

**L.202 — avant `export const slackInterviewConfirmationPresenter: InterviewConfirmationPresenter = {`**

L'implémentation Slack du port de présentation.

⚠️ Elle vit ICI, avec les blocs qu'elle construit et l'`action_id` qu'ils portent : les
séparer ferait qu'un renommage puisse casser un seul côté — et le côté cassé, la route, ne
signalerait rien, un `action_id` inconnu se traduisant par un clic sans effet.

**L.214 — avant `export function buildInterviewConfirmText(input: {`**

La relecture, EN TEXTE — remplace la carte Block Kit le 2026-08-19.

⚠️ L'email est affiché INTÉGRALEMENT, corps compris. Un résumé (« un email va partir à
Jean ») rendrait la relecture décorative : on ne peut pas relire ce qu'on ne voit pas, et
c'est la relecture qui est la valeur de cette étape. Cette règle vient de la carte et lui
survit.

⚠️ mrkdwn Slack (`*gras*`), jamais markdown GitHub : ce texte est posté EN DUR et ne passe
par aucun filtre — `sanitizeAgentOutput` n'a qu'un seul site d'appel, la réponse d'un modèle.
Un `**` s'afficherait littéralement, ce qui a été constaté en production sur le message de
détresse, au pire endroit possible.

⚠️ La question est la DERNIÈRE ligne, et elle dit que l'envoi est DÉFINITIF. C'est le seul
acte irréversible du produit ; le mot « définitif » n'est pas une précaution de style, c'est
ce qui distingue cette question de toutes les autres auxquelles on répond machinalement.

## `features/recruitment/infrastructure/repositories/drizzle-pending-email.repository.ts`

**L.13 — avant `export class DrizzlePendingInterviewEmailRepository implements PendingInterviewEmailRepository {`**

⚠️ La table `pending_interview_email` n'est PAS créée par les migrations `drizzle/` : elles
sont désynchronisées de `schema.ts` et `drizzle-kit push` se bloque contre une base
`libsql://` distante. DDL à appliquer à la main —
`scripts/ddl-pending-interview-email.sql`.

**L.22 — avant `async save(pending: PendingInterviewEmail): Promise<void> {`**

⚠️ UPSERT, jamais un simple INSERT : une seconde préparation dans la même conversation doit
REMPLACER la première. Deux lignes rendraient le « oui » de la personne ambigu, et elle
n'en voit qu'une à l'écran.

**L.58 — avant `async clear(conversationId: string): Promise<number> {`**

⚠️ LA SUPPRESSION EST LA PRISE, et son compte est le contrat. Deux « oui » traités par deux
instances ne peuvent pas envoyer deux fois : la seconde suppression rend 0, et l'appelant
renonce. Un `SELECT` puis un `DELETE` — la forme « naturelle » — rouvrirait cette course.
Même raisonnement que le `IS NULL` de `rememberDmChannel`.

## `features/recruitment/infrastructure/repositories/in-memory-pending-email.repository.ts`

**L.6 — avant `export class InMemoryPendingInterviewEmailRepository implements PendingInterviewEmailRepository `**

Doublure de test. Elle partage le CONTRAT de la version Drizzle, y compris le compte rendu
par `clear` — c'est ce qui garantit que les tests ne soient pas verts sur un comportement que
la production n'a pas. Le dépôt a payé cet écart le 2026-08-19 sur `linkEmployee`.

