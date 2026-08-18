import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({
  path: path.resolve(process.cwd(), '.env'),
});
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { VercelDeployer } from '@mastra/deployer-vercel';

import { DrizzleEmployeeRepository } from '../features/employee/infrastructure/repositories/drizzle-employee.repository';
import { DrizzleDocumentRepository } from '../features/document/infrastructure/repositories/drizzle-document.repository';
import { DrizzleNotificationRepository } from '../features/notification/infrastructure/repositories/drizzle-notification.repository';
import { DrizzleOnboardingRepository } from '../features/onboarding/infrastructure/repositories/drizzle-onboarding.repository';
import { DrizzleOnboardingInterviewRepository } from '../features/onboarding/infrastructure/repositories/drizzle-onboarding-interview.repository';
import { DrizzleChannelInventoryRepository } from '../features/directory/infrastructure/repositories/drizzle-channel.repository';

import { healthCheck } from '../infrastructure/database/connection';

import { makeFindEmployeeByEmail } from '../features/employee/application/tools/find-employee-by-email';
import { makeFindPersonByName } from '../features/employee/application/tools/find-person-by-name';
import { makeGetEmployeeProfile } from '../features/employee/application/tools/get-employee-profile';
import { makeUpdateOnboardingStatus } from '../features/onboarding/application/tools/update-onboarding-status';
import { makeGenerateDocument } from '../features/document/application/tools/generate-document';
import { makeSendNotification } from '../features/notification/application/tools/send-notification';
import { makeScheduleReminder } from '../features/notification/application/tools/schedule-reminder';
import { makeGetNotificationHistory } from '../features/notification/application/tools/get-notification-history';

import { makeOnboardingOrchestrator } from '../features/onboarding/application/agents/onboarding-orchestrator';
import { makeNotificationAgent } from '../features/notification/application/agents/notification-agent';
import { makeKnowledgeAgent } from '../features/knowledge/application/agents/knowledge-agent';
import { makeRecruitmentAgent } from '../features/recruitment/application/agents/recruitment-agent';
import { makeScheduleCandidateInterview } from '../features/recruitment/application/tools/schedule-candidate-interview';
import { slackInterviewConfirmationPresenter } from '../features/recruitment/infrastructure/handlers/interview-confirm';

import { DrizzleDirectoryRepository } from '../features/directory/infrastructure/repositories/drizzle-directory.repository';
import { SlackMemberSource } from '../features/directory/infrastructure/providers/slack-member-source.adapter';
import { SlackChannelAccess } from '../features/directory/infrastructure/providers/slack-channel-access.adapter';
import { makeDirectorySync } from '../features/directory/application/services/directory-sync.service';
import { makeChannelCoverage } from '../features/directory/application/services/channel-coverage.service';

import { DrizzleBotMemoryRepository } from '../features/knowledge/infrastructure/repositories/drizzle-bot-memory.repository';
import { SlackChannelHistoryAdapter } from '../features/knowledge/infrastructure/providers/slack-channel-history.adapter';
import { makeGetUserConversations } from '../features/knowledge/application/tools/get-user-conversations';
import { makeGetChannelHistory } from '../features/knowledge/application/tools/get-channel-history';
import { makeFindExpertise } from '../features/knowledge/application/tools/find-expertise';

import { SmtpAdapter } from '../features/notification/infrastructure/providers/smtp.adapter';
import { createEmailProvider } from '../features/notification/infrastructure/providers/email-provider.factory';
import { SlackAdapter } from '../features/notification/infrastructure/providers/slack.adapter';
import { SlackWorkspaceService } from '../features/notification/infrastructure/providers/slack-workspace.service';
import { PdfmakeService } from '../features/document/infrastructure/services/pdfmake.service';
import { DocxService } from '../features/document/infrastructure/services/docx.service';

import { createEmployeeOnboardingWorkflow } from '../features/onboarding/application/workflows/employee-onboarding';

import { slackEventsRoute } from '../api/slack-events.route';
import { slackInteractionsRoute } from '../api/slack-interactions.route';
import { createApiAuthConfig } from '../shared/security/api-auth';
import { createCallerErrorMiddleware } from '../shared/security/caller-error-mapping';
import { createRequestContextGuard } from '../shared/security/request-context-guard';
import { createSecurityHeadersMiddleware } from '../shared/security/http-headers';
import { createAgentApiGuard } from '../shared/security/agent-api-guard';
import { logger } from '../shared/logger';

// ─────────────────────────────────────────────────────────────────────────────
// AMORÇAGE DE LA CONNEXION — mesuré, et à contre-courant du commentaire précédent
// ─────────────────────────────────────────────────────────────────────────────
//
// L'ancienne note disait « getDb() appelé ici forcerait l'ouverture au démarrage — inutile
// en dev ». Sa prémisse est fausse en production, et le prix a été mesuré le 2026-08-12 :
//
//     WARN | Slack ACK budget at risk | {"ackMs":1619,"admissionMs":1619}
//
// `ackMs === admissionMs` : la totalité du budget d'accusé de réception était consommée
// À L'INTÉRIEUR de `handler.accept()`, c'est-à-dire dans Turso. Signature, parsing et
// construction du handler pèsent ensemble moins d'une milliseconde.
//
// Ce que paie ce chemin : la déduplication partagée et le limiteur de débit font chacun un
// aller-retour vers `aws-ap-northeast-1` (Tokyo) — mais surtout, le PREMIER d'entre eux
// paie le handshake complet (DNS + TCP + TLS + upgrade WebSocket + hello hrana), soit 4 à
// 5 allers-retours. Slack rejoue tout événement non acquitté en 3 s, et un rejeu est
// exactement ce qui a produit la double réponse du 2026-08-11.
//
// `createClient` de libsql est SYNCHRONE et ouvre le socket de façon impérative : le coût
// n'est payé qu'au premier `await`. L'amorcer ici fait donc chevaucher le handshake avec
// l'évaluation du reste du bundle, au lieu de l'ajouter au chemin d'ACK. Ce n'est pas
// « ouvrir plus tôt », c'est « ne plus le payer au pire moment ».
//
// `void` et `.catch()` : aucun `await` au niveau module (il bloquerait le démarrage), et
// une base injoignable au boot ne doit pas faire échouer le chargement — chaque appelant
// gère déjà sa propre dégradation. On journalise, on ne relance pas.
void healthCheck().catch((error) => {
  logger.warn('Amorçage de la connexion à la base sans succès — chaque appelant dégradera', {
    error,
  });
});

const employeeRepo = new DrizzleEmployeeRepository();
const documentRepo = new DrizzleDocumentRepository();
const notificationRepo = new DrizzleNotificationRepository();
const onboardingRepo = new DrizzleOnboardingRepository();
const interviewRepo = new DrizzleOnboardingInterviewRepository();
const channelInventoryRepo = new DrizzleChannelInventoryRepository();

// ⚠️ `createEmailProvider` a été EXTRAIT vers
// `features/notification/infrastructure/providers/email-provider.factory.ts` le 2026-08-14 :
// `slack-interactions.route.ts` en a besoin (l'email d'entretien part au clic) et ne peut pas
// importer ce fichier-ci, qui importe la route. Le recopier ferait diverger le choix de
// fournisseur entre deux chemins d'envoi, sans que rien ne le signale.
const emailProvider = createEmailProvider();

// Ne JAMAIS logger la valeur d'une clé d'API — uniquement sa présence.
console.log('ENV CHECK', {
  cwd: process.cwd(),
  emailProvider: emailProvider instanceof SmtpAdapter ? 'smtp' : 'brevo',
  hasBrevoKey: Boolean(process.env.BREVO_API_KEY),
  hasSmtpPass: Boolean(process.env.SMTP_PASS),
  env: process.env.NODE_ENV,
});
const chatProvider = new SlackAdapter(process.env.SLACK_BOT_TOKEN ?? '');
const slackWorkspace = new SlackWorkspaceService(process.env.SLACK_BOT_TOKEN ?? '');
const pdfService = new PdfmakeService();
/**
 * Renderers de documents — c'est CE câblage qui fait entrer `docx` dans le bundle.
 *
 * `DocxService` importe `docx` statiquement : tant qu'aucun module atteignable depuis ce
 * fichier ne le référençait, le bundler Mastra/Vercel ne l'embarquait pas. Le garde-fou
 * `verify:bundle` exige désormais sa présence (`--require …,docx` dans package.json) —
 * les deux vont ensemble, ajouter l'exigence sans ce câblage casserait le build.
 */
const docxService = new DocxService();

// ─────────────────────────────────────────────────────────────────────────────
// Annuaire des personnes et couverture des canaux (feature `directory`)
// ─────────────────────────────────────────────────────────────────────────────
// UN SEUL WebClient : les deux adaptateurs consomment `slackWorkspace` déjà câblé. Deux
// clients ignoreraient chacun les appels de l'autre et franchiraient un plafond de débit que
// ni l'un ni l'autre ne verrait venir.
//
// ⚠️ Ce sont des FACTORIES : aucune E/S au chargement du module. Ce fichier est évalué à
// chaque démarrage à froid, donc sur le chemin des 3 secondes d'ACK de Slack — un ACK à 6,7 s
// a déjà provoqué un rejeu, donc la double réponse du 2026-08-11.
const directoryRepo = new DrizzleDirectoryRepository();
const slackMemberSource = new SlackMemberSource(slackWorkspace);
const slackChannelAccess = new SlackChannelAccess(slackWorkspace);

/**
 * Synchronisation de l'annuaire et couverture des canaux.
 *
 * ⚠️ NE TOURNENT PAS AU BOOT, délibérément — voir ci-dessus. Trois rythmes, par ordre de
 * valeur :
 *  1. **au fil de l'eau** : le handler Slack résout un `slackUserId` inconnu par UN
 *     `users.info` puis écrit la ligne. C'est ce qui rend la frontière d'autorisation opérante
 *     SANS aucune synchronisation préalable ;
 *  2. **à la demande** : `npx tsx scripts/sync-slack-directory.mts` (dry-run), `--apply` pour
 *     écrire. À lancer après chaque arrivée ou départ groupé ;
 *  3. **périodique** : un cron quotidien serait le complément naturel — il rattrape les
 *     DÉPARTS, que `deleted: true` n'annonce par aucun événement abonné. Pas encore créé : la
 *     route devrait être protégée, elle déclenche des écritures et N appels Slack.
 *
 * Exportés pour être appelables depuis un script ou une future route, jamais invoqués ici.
 */
export const directorySync = makeDirectorySync({
  source: slackMemberSource,
  repository: directoryRepo,
  employees: employeeRepo,
});
export // ⚠️ `inventory` était ABSENT jusqu'au 2026-08-14, et c'est le défaut que `TODO.md` [0 bis]
// recensait : sans lui, `recordInventory()` rend `undefined` et n'écrit RIEN. Le service
// n'a toujours aucun consommateur dans l'application — l'inventaire est alimenté par
// `npm run directory:sync -- --channels --apply`, qui reconstruit ses propres instances —
// mais il est désormais CORRECT si quelqu'un s'en sert, au lieu d'être muet.
const channelCoverage = makeChannelCoverage({
  source: slackChannelAccess,
  inventory: channelInventoryRepo,
});

// L'annuaire Slack est le SECOND paramètre, et c'est le correctif de la panne du
// 2026-08-12 (« il ne retrouve pas les autres profils à part le mien ») : `employees`
// n'est peuplée que par la modale « Compléter mon profil », donc elle contenait UNE
// ligne pour 6 personnes réelles, tandis que `slack_directory` les portait toutes,
// avec prénom, nom et poste. `directorySync` alimentait cette table depuis le
// 2026-08-12 sans qu'aucun tool ne la lise.
const findEmployeeByEmail = makeFindEmployeeByEmail(employeeRepo, directoryRepo);
// ─────────────────────────────────────────────────────────────────────────────
// RÉSOLUTION PAR NOM — le manque qui a envoyé le document d'Awa à l'adresse de Karyl
// ─────────────────────────────────────────────────────────────────────────────
// Relevé sur la Turso de production le 2026-08-13 : les DIX documents de la base portent
// l'UUID de Karyl, y compris celui intitulé « Bienvenue Awa ». Awa a pourtant sa propre
// ligne `employees` — elle est simplement absente de `slack_directory`, donc
// `findEmployeeByEmail` (seul résolveur existant) exigeait une adresse que personne
// n'avait tapée. Sommé de fournir un `employeeId`, le modèle a réutilisé le seul UUID de
// son contexte : même mécanique que l'email `votre_email@example.com`.
//
// Les DEUX sources sont donc câblées, `employees` d'abord : Awa n'existe QUE dans
// `employees`, et les quatre autres personnes vivantes du workspace QUE dans l'annuaire.
const findPersonByName = makeFindPersonByName(employeeRepo, directoryRepo);
const getEmployeeProfile = makeGetEmployeeProfile(employeeRepo, onboardingRepo);
const updateOnboardingStatus = makeUpdateOnboardingStatus(onboardingRepo);
// ⚠️ `getTaskList` a été RETIRÉ le 2026-08-14, avec tout le suivi de tâches.
//
// Les cinq tâches d'intégration étaient un plan qu'AUCUN mécanisme ne faisait avancer : ni
// humain, ni automate, ni tool ne pouvait marquer « Rencontrer ton manager » comme faite. Un
// suivi qui ne bouge jamais est un suivi qui ment — même famille de défaut que
// `emailSent: false` sous `status: 'success'` et que `status = Sent` posé avant le `try`.
// Deux des cinq renvoyaient de surcroît vers un questionnaire et un guide qui n'existaient
// pas sous la forme annoncée.
//
// Le seul suivi du produit est désormais la COMPLÉTION DU PROFIL, portée par
// `onboarding_progress` et lisible par `getEmployeeProfile`.
// ⚠️ `evaluateResponse` a été SUPPRIMÉ du câblage le 2026-08-14 — audit de code mort.
// Il était décâblé de tout agent depuis le 2026-08-12 (son seul appelant possible était un
// modèle qui FABRIQUAIT les réponses d'un humain), mais sa CONSTRUCTION est restée, et avec
// elle celle de `questionnaireRepo` et `responseRepo`. Trois objets bâtis à chaque démarrage
// à froid pour un tool que rien ne pouvait appeler.
// `generateDocument` ne se contente plus d'écrire une ligne : il rend le fichier, le
// livre dans Slack (upload) ou par email (pièce jointe), et rend compte de la livraison.
// Le canal et le thread ne sont PAS injectés ici — ils viennent du `requestContext` par
// requête (`src/shared/slack-request-context.ts`) ; l'adresse email, elle, est résolue
// depuis l'annuaire. Aucune destination ne transite par le modèle.
const generateDocument = makeGenerateDocument({
  documentRepo,
  employeeRepo,
  renderers: [pdfService, docxService],
  // `SlackAdapter` porte `uploadFile` en plus de `sendMessage` : un seul WebClient, un
  // seul jeton. Le scope `files:write` EST accordé — vérifié en production le 2026-08-11,
  // un PDF réellement posté dans un DM (`hasPermalink: true` dans les logs). L'ancienne
  // note affirmant le contraire a survécu à sa propre invalidation pendant une journée.
  fileUpload: chatProvider,
  emailProvider,
  // ── L'ENTRETIEN nourrit le gabarit, CÔTÉ SERVEUR ────────────────────────────────────
  //
  // Ces deux dépôts ne traversent jamais la fenêtre du modèle : `generateDocument` résout
  // l'entretien depuis l'`employeeId`, exactement comme il résout la fiche employé. Le
  // gabarit imprime donc de la matière réelle — ce que la personne a écrit sur son quotidien,
  // sa façon de travailler, les canaux qu'elle a choisis — pour **zéro token**.
  //
  // C'est la réponse à « le guide doit être chaleureux, avec les infos connues de
  // l'utilisateur, sans donnée générique » : jusqu'au 2026-08-14 le gabarit sortait quatre
  // puces écrites en dur, identiques pour tout le monde.
  //
  // ⚠️ Les DEUX sont optionnels dans le tool : sans eux le document reste produit à
  // l'identique. C'est ce qui rend ce câblage sûr même sur une base où
  // `onboarding_interview` n'a pas encore été appliquée.
  interviewRepo,
  channelRepo: channelInventoryRepo,
});
const sendNotification = makeSendNotification(
  notificationRepo,
  employeeRepo,
  emailProvider,
  chatProvider,
  slackWorkspace,
);
// L'annuaire est le SECOND paramètre, et il n'est pas décoratif : il permet de refuser un
// destinataire inexistant AVANT d'enregistrer un rappel. Sans lui le tool dégrade — il ne ment
// pas, mais il accepte.
const scheduleReminder = makeScheduleReminder(notificationRepo, employeeRepo);
// ⚠️ `employeeRepo` est injecté UNIQUEMENT pour résoudre un email en identifiant, ce qui
// supprime une étape entière (mesuré : 3 étapes / 4 424 tokens → 2). Voir la factory.
const getNotificationHistory = makeGetNotificationHistory(notificationRepo, employeeRepo);

// `discoverSlackWorkspace` a été SUPPRIMÉ le 2026-08-18. Il avait d'abord été retiré des
// agents (schéma coûteux, mentionné dans aucune instruction), et ce commentaire affirmait
// alors qu'il « reste câblé et testé isolément » : c'était faux. Il n'était câblé à AUCUN
// agent ni à aucun autre appelant — il n'était que TESTÉ, ce qui n'est pas la même chose et
// donne l'illusion d'un code vivant.
//
// Ce qui a emporté la décision n'est pas qu'il soit mort, c'est ce qu'il portait : une action
// `inviteToChannel` sans la moindre garde d'autorisation, dans un fichier qu'un futur
// recâblage aurait pu rebrancher sans relire. L'invitation Slack du parcours d'onboarding, la
// vraie, passe par `deps.slackProvider` dans l'étape `inviteToSlack` du workflow.
// `createEmployee` a été retiré le 2026-08-11, après la campagne de tests en
// production. Exposer une allowlist fermée (`department`, `position`) à un LLM ne
// protège pas l'intégrité des données : le modèle substitue une valeur valide
// AVANT d'appeler l'outil pour que l'appel réussisse. Mesuré : « Software
// Engineer » enregistré en « Developer », et « Plomberie » enregistré en
// « Engineering » — ce dernier SANS le moindre avertissement. La validation Zod
// n'a jamais vu les valeurs refusées.
// La création passe désormais par la modale du flux d'arrivée : liste déroulante
// côté Slack, workflow appelé en code, aucun LLM sur le chemin transactionnel.
// Le tool reste câblé pour l'API et le workflow.
const onboardingOrchestrator = makeOnboardingOrchestrator({
  findEmployeeByEmail,
  findPersonByName,
  getEmployeeProfile,
  updateOnboardingStatus,
  generateDocument,
});

// `findEmployeeByEmail` est exposé à `onboardingOrchestrator` et `notificationAgent` depuis le
// 2026-08-11, et c'est un correctif de CÂBLAGE, pas de rédaction.
//
// Tous les tools de `notificationAgent` exigent un UUID d'employé, et AUCUN ne sait faire
// email → UUID : ce tool n'était câblé que sur l'orchestrateur. Pire, le `.describe()` de
// `recipientId` renvoyait vers `getEmployeeProfile`, qui exige déjà un UUID — la consigne était
// circulaire. Et `AGENT_ANTI_INVENTION_BLOCK` interdit au modèle d'en deviner un. La boucle
// infernale de la série C (« donne-moi son identifiant » → « je ne l'ai pas » → …) était donc
// GARANTIE par le câblage, pas probabiliste.
//
// ─────────────────────────────────────────────────────────────────────────────
// `questionnaireEngine` A ÉTÉ RETIRÉ DU REGISTRE le 2026-08-14
// ─────────────────────────────────────────────────────────────────────────────
//
// Avec son unique tool `generateQuestionnaire`. Les deux restent dans le dépôt, testés ;
// seule leur EXPOSITION disparaît. Trois raisons, la première étant décisive :
//
//  1. **Il n'a jamais rien produit d'utilisable.** Relevé sur la Turso le 2026-08-14 :
//     `questionnaires` = 5 lignes (« Quiz sur nos valeurs »…), `questionnaire_responses` =
//     **0 ligne**. Il n'existe ni formulaire Block Kit, ni modale, ni route de soumission :
//     un questionnaire enregistré n'est envoyé à personne et remplissable par personne. Le
//     tool le dit lui-même dans son `hint` — ce qui prouve qu'on le savait sans le corriger.
//     C'est exactement pour cette raison qu'`evaluateResponse` avait dû être décâblé le
//     2026-08-12 : son seul appelant possible était un modèle qui FABRIQUAIT les réponses.
//  2. **Le besoin réel est ailleurs.** Ce que le questionnaire devait servir — cerner les
//     centres d'intérêt d'un arrivant pour l'abonner aux bons canaux — est désormais rendu
//     par l'ENTRETIEN post-profil : une modale Block Kit, remplissable, dont la soumission
//     invite réellement aux canaux choisis. Déterministe, zéro token, et il aboutit.
//  3. ≈ 886 tokens de FLOOR en moins, et un agent de moins dans le routage.
//
// ⚠️ Le routage a été nettoyé en conséquence (`ESCAPE_INTENTS`, `QUESTIONNAIRE_TOPICS`,
// `KNOWN_AGENT_IDS`). Ce n'est pas cosmétique : `mastra.getAgent()` LÈVE sur un identifiant
// absent du registre, donc un mot-clé pointant encore cet agent aurait fait échouer chaque
// message qui le contient.

// discoverSlackWorkspace n'est PAS exposé ici : les instructions de l'agent ne le
// mentionnent jamais (sendNotification résout déjà le compte Slack côté serveur), et
// c'est actuellement le tool le plus coûteux en tokens du set (~356 caractères de
// schéma JSON + 426 de description). Voir CHANGELOG pour la mesure avant/après.
const notificationAgent = makeNotificationAgent({
  // Voir le commentaire de `questionnaireEngine` ci-dessus : sans ce tool, les quatre autres
  // sont inatteignables dès que l'humain désigne quelqu'un par son email — c'est-à-dire
  // presque toujours.
  findEmployeeByEmail,
  // Même raison, et le cas est encore plus fréquent ici : « envoie un rappel à Pamela »
  // ne porte jamais d'adresse. Sans ce tool, la boucle « donne-moi son identifiant » →
  // « je ne l'ai pas » était garantie par le câblage.
  findPersonByName,
  sendNotification,
  scheduleReminder,
  getNotificationHistory,
  getEmployeeProfile,
});

// ─────────────────────────────────────────────────────────────────────────────
// AGENT KNOWLEDGE — lecture des conversations, et rien d'autre
// ─────────────────────────────────────────────────────────────────────────────
// Deux sources, et deux seulement : la mémoire propre du bot (`conversation_turns`, ses DM
// avec les gens) et l'historique des canaux où il est invité. Rien n'est ingéré ni stocké :
// lecture À LA DEMANDE, fenêtre bornée — une ingestion persistante de tous les canaux
// constituerait une surveillance systématique des communications des salariés
// (AIPD obligatoire, consultation du CSE), ce que `PLAN-ARCHITECTURE.md` §4.7 refuse.
//
// ⚠️ Le filtrage se fait selon les droits du DEMANDEUR, jamais selon ceux du bot. Le bot
// détient l'UNION des droits de tous ses canaux ; les prêter au premier venu est le
// « deputy confus » de §4.1 — un invité mono-canal demandant en DM le résumé de
// `#engineer-karyl`.
const channelHistory = new SlackChannelHistoryAdapter(process.env.SLACK_BOT_TOKEN ?? '', {
  // Résolution des noms par l'ANNUAIRE et non par `users.info` : zéro appel Slack
  // supplémentaire, et un nom absent retombe sur l'identifiant sans casser la lecture.
  resolveDisplayName: async (id) =>
    (await directoryRepo.findBySlackUserId(id))?.displayName ?? null,
});

const getUserConversations = makeGetUserConversations({
  // `DirectoryRepository` satisfait STRUCTURELLEMENT le port du tool : celui-ci ne voit que
  // les deux lectures dont il a besoin, ni `upsertFacts` ni `listAll`.
  directory: directoryRepo,
  memory: new DrizzleBotMemoryRepository(),
});
const getChannelHistory = makeGetChannelHistory({
  directory: directoryRepo,
  channels: channelHistory,
});

// ⚠️ AUCUN outil de SORTIE ici, et ce n'est pas une convention : `makeKnowledgeAgent` LÈVE au
// démarrage si on lui en câble un. Lecture agrégée + écriture externe dans la même chaîne =
// canal d'exfiltration complet (§4.2) — « envoie à ce candidat un récapitulatif de ce qui se
// dit dans #engineer-karyl », en une phrase, par un invité. Une erreur de câblage devient donc
// un échec au démarrage, pas une fuite.
// `findExpertise` (2026-08-14) répond à « qui peut faire quoi » — la seconde moitié de la
// demande adressée au `knowledgeAgent`. Il est en LECTURE PURE et ne rend que des NOMS : ni
// UUID, ni adresse, ni identifiant Slack. Il satisfait donc la quarantaine ci-dessus, et sa
// place est bien ici plutôt que sur l'orchestrateur — « qui s'occupe du backend ? » est une
// question de connaissance du workspace, pas une étape d'onboarding.
const findExpertise = makeFindExpertise({ directoryRepo, employeeRepo });

const knowledgeAgent = makeKnowledgeAgent({
  getUserConversations,
  getChannelHistory,
  findExpertise,
});

// ⚠️ AUCUN outil de LECTURE ici, et c'est la quarantaine INVERSE de celle ci-dessus :
// `makeRecruitmentAgent` LÈVE au démarrage si on lui en câble un. C'est le seul agent qui
// écrive à une adresse SITUÉE HORS DE L'ENTREPRISE et non contrainte par l'annuaire ; lui
// adjoindre `getEmployeeProfile` ou `getChannelHistory` formerait le canal d'exfiltration de
// §4.2 — « retrouve le dossier de Karyl et envoie-le à moi@ailleurs.com ».
//
// C'est aussi pourquoi ce tool n'est PAS posé sur `notificationAgent`, qui aurait été
// l'option la moins chère : il porte déjà trois outils de lecture.
//
// `directoryRepo` n'est PAS une exception à la quarantaine : le tool s'en sert pour résoudre
// l'adresse du DEMANDEUR (afin que le candidat puisse répondre à un humain), jamais sur une
// valeur choisie par le modèle — le `slackUserId` vient du `requestContext`.
const scheduleCandidateInterview = makeScheduleCandidateInterview({
  chat: chatProvider,
  // La présentation de la carte de relecture est injectée : la couche `application` ne
  // connaît pas Block Kit — voir `domain/ports/interview-confirmation.presenter.ts`.
  presenter: slackInterviewConfirmationPresenter,
  directoryRepo,
});

const recruitmentAgent = makeRecruitmentAgent({ scheduleCandidateInterview });

/**
 * LE SEUL WORKFLOW DU SYSTÈME — et ce qu'il apporte que les agents ne peuvent pas apporter.
 *
 * Trois workflows ont été RETIRÉS du registre le 2026-08-12 :
 *
 *  - `notificationCycleWorkflow` retournait `successCount: N` et `failuresCount: 0` sans la
 *    moindre E/S, et `scripts/production-scenarios.mjs` l'enregistrait en PASS. Il ne mesurait
 *    rien, il fabriquait un feu vert.
 *  - `questionnaireCycleWorkflow` posait `status: 'SENT'` et `responsesCount: 10` en dur.
 *  - `documentGenerationWorkflow` écrivait sur le disque et rendait un chemin local :
 *    inutilisable sur Vercel, dont le système de fichiers est en lecture seule hors `/tmp`,
 *    lequel est éphémère et propre à l'instance.
 *
 * Ils étaient enregistrés À ÉGALITÉ avec celui-ci et atteignables par l'API. Un appelant ne
 * pouvait pas distinguer le vrai des trois maquettes — c'est-à-dire que la présence des trois
 * dévaluait le seul qui fonctionne.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * VALEUR AJOUTÉE de `employeeOnboardingWorkflow` dans le processus
 * ────────────────────────────────────────────────────────────────────────────
 *
 *  1. **Il coûte ZÉRO token.** C'est la propriété décisive sur un budget de 100 000 tokens
 *     par JOUR (≈ 19 messages). Le même parcours conduit par un agent consomme ~6 838 tokens
 *     en 2 étapes ; ici, 0. Le chemin transactionnel n'a aucun LLM dessus.
 *
 *  2. **Il est déterministe là où un agent est probabiliste.** C'est la leçon du retrait de
 *     `createEmployee` des agents : exposer une allowlist (`department`, `position`) à un
 *     modèle ne protège pas l'intégrité des données — le modèle SUBSTITUE une valeur valide
 *     avant d'appeler l'outil pour que l'appel réussisse. Mesuré en production :
 *     « Plomberie » enregistré en « Engineering », sans le moindre avertissement. La
 *     validation Zod n'a jamais vu la valeur refusée. Ici l'entrée vient d'une liste
 *     déroulante Slack, validée en code.
 *
 *  3. **Il rend un VERDICT, pas un booléen.** `OnboardingOutcome` ∈
 *     `completed | degraded | failed`, accompagné de `degradedSteps: { step, reason }[]`.
 *     Trois étapes best-effort sont inventoriées (`onboardingTasks`, `welcomeEmail`,
 *     `slackInvite`) : un email jamais parti se lit désormais, là où il se noyait dans un
 *     `emailSent: false` sous un run `status: 'success'` — d'où trois lecteurs successifs qui
 *     ont conclu à tort qu'un email était parti.
 *     ⚠️ `run.status` reste `'success'` (champ de Mastra, non modifiable) : le verdict vit
 *     dans la CHARGE UTILE. C'est `outcome` qu'il faut lire, jamais `run.status`.
 *
 *  4. **Il n'avorte pas sur une indisponibilité de trente secondes.** Perdre l'employé créé,
 *     ses tâches et son invitation parce que SMTP a hoqueté serait une régression, pas une
 *     rigueur. `degraded` est un aboutissement.
 *
 * Il est déjà INTÉGRÉ au produit : `src/api/slack-interactions.route.ts` le déclenche à la
 * soumission de la modale « Compléter mon profil », elle-même envoyée par `handleTeamJoin`
 * quand une personne rejoint le workspace. Aucun LLM sur ce chemin.
 */
const employeeOnboardingWorkflow = createEmployeeOnboardingWorkflow({
  employeeRepo,
  onboardingRepo,
  notificationRepo,
  emailProvider,
  slackProvider: slackWorkspace,
});

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('CRITICAL: DATABASE_URL is required in production environment.');
}

export const mastra = new Mastra({
  deployer: new VercelDeployer(),
  // La clé du registre doit être IDENTIQUE à l'`id` de l'agent — c'est elle que résout
  // `mastra.getAgent(id)`, et c'est cet identifiant que le routage collant relit en base.
  agents: {
    onboardingOrchestrator,
    notificationAgent,
    knowledgeAgent,
    recruitmentAgent,
  },
  // UN SEUL workflow, et c'est délibéré — voir le commentaire de `employeeOnboardingWorkflow`.
  // Les trois autres ne faisaient aucune E/S et se déclaraient réussis.
  workflows: {
    employeeOnboardingWorkflow,
  },
  storage: new LibSQLStore({
    id: 'mastra-store',
    url: databaseUrl,
    authToken: process.env.DATABASE_AUTH_TOKEN,
  }),
  // Une route HTTP n'existe QUE si elle est déclarée ici. Les fichiers de `src/api/`
  // ne sont jamais montés automatiquement par Mastra.
  server: {
    apiRoutes: [slackEventsRoute, slackInteractionsRoute],
    // Requalifie en 400 les erreurs de validation d'entrée que Mastra renvoie en 500.
    // Monté sur `/api/*` UNIQUEMENT : `/slack/events` gère ses propres codes et le rejeu
    // de Slack en dépend. Une vraie panne serveur reste un 500 (voir le module).
    middleware: [
      // Les en-têtes de sécurité, sur TOUTE réponse — d'où le joker nu et non `/api/*` : la
      // racine et `/agents` rendent du `text/html`, et c'est cette surface-là qui justifie
      // `x-frame-options`. Relevé de l'extérieur le 2026-08-18 : seul le HSTS de Vercel était
      // présent. En PREMIER pour que les en-têtes couvrent aussi les refus des gardes qui
      // suivent.
      { path: '*', handler: createSecurityHeadersMiddleware() },
      // ⚠️ EN PREMIER, et l'ordre porte la sécurité : ce garde doit refuser AVANT que
      // quoi que ce soit ne lise le contexte. Mastra fusionne `body.requestContext` dans le
      // contexte serveur et n'écarte que `RESERVED_CONTEXT_KEYS` (`mastra__*`,
      // `organizationId`) — aucune clé `slack*` n'y figure, donc un porteur de
      // `MASTRA_API_TOKEN` se déclarait n'importe qui : `slackEmployeeId` décide de l'accès
      // au dossier RH, `slackAccessLevel` des effets de bord. Le trou était recensé depuis
      // le 2026-08-12 et fermé le 2026-08-14.
      {
        path: '/api/*',
        handler: createRequestContextGuard({
          onReject: (keys) =>
            logger.error('requestContext forgé refusé sur /api/*', { keys: keys.join(',') }),
        }),
      },
      // ⚠️ EN SECOND, avant la requalification d'erreur : le prompt système FUYAIT par
      // `/api/agents/*` — quatre surfaces, dont DEUX sans la moindre ruse. `GET /api/agents`
      // rendait les instructions des quatre agents en clair, `GET /api/agents/:id` 2 624
      // caractères dont le `[SECURITY_ID:…]` de session. Aucune injection, aucun modèle,
      // aucun coût. Mesuré et fermé le 2026-08-14.
      //
      // Monté sur `/api/*` et non `/api/agents/*` : un joker Hono ne couvre pas
      // `/api/agents` SANS segment suivant — or c'est précisément la pire des quatre. Le
      // garde teste le chemin lui-même.
      {
        path: '/api/*',
        handler: createAgentApiGuard({
          onRefused: (types) =>
            logger.error("Tentative d'extraction du prompt refusée sur /api/agents", {
              types: types.join(','),
            }),
          onRedacted: (what) =>
            logger.warn('Fuite de configuration rédigée sur /api/agents', { what }),
        }),
      },
      {
        path: '/api/*',
        handler: createCallerErrorMiddleware({
          onRemap: (message) => logger.info('Caller error requalifiée 500→400', { message }),
        }),
      },
    ],
    // Sans `auth`, `getEffectiveAuthConfig()` renvoie null et `checkRouteAuth()` laisse
    // passer TOUTES les routes /api/* sans authentification — n'importe qui sur Internet
    // pilotait les agents (envoi d'email, création d'employés, publication Slack).
    // `/slack/events` reste exempt via son `requiresAuth: false` (vérifié dans le source
    // de @mastra/server) et s'authentifie par signature HMAC Slack.
    // ⚠️ SANS CETTE LIGNE, le serveur RENVOIE l'origine demandée avec
    // `access-control-allow-credentials: true` — vérifié en production le 2026-08-18 :
    // `Origin: https://evil.example.com` ressortait tel quel dans `access-control-allow-origin`.
    //
    // Honnêteté sur la portée : aucun scénario d'exploitation n'a été trouvé aujourd'hui.
    // L'authentification est un jeton PORTEUR, qu'un navigateur n'attache jamais tout seul ;
    // une page tierce ne gagne donc rien qu'elle ne puisse déjà faire depuis son propre
    // serveur. Ce qu'on ferme est le jour où un cookie apparaîtrait — la combinaison
    // origine reflétée + `credentials: true` est précisément celle qui rend ce jour-là
    // catastrophique, et elle serait alors invisible parce que déjà en place.
    //
    // Liste VIDE et non `false` : `false` désactiverait le middleware CORS et laisserait
    // l'absence d'en-tête dépendre de l'implémentation. Une liste vide ne matche aucune
    // origine, donc aucun `access-control-allow-origin` n'est émis — et le produit n'a
    // aucun client navigateur d'aucune origine, ce qui rend le refus total exact.
    cors: { origin: [], credentials: false },
    auth: createApiAuthConfig({
      onMisconfigured: (message) => logger.error(message),
    }),
  },
});
