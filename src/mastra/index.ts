import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({
  path: path.resolve(process.cwd(), '.env'),
});
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { VercelDeployer } from '@mastra/deployer-vercel';

import { DrizzleEmployeeRepository } from '../features/employee/infrastructure/repositories/drizzle-employee.repository';
import { DrizzleTaskRepository } from '../features/employee/infrastructure/repositories/drizzle-task.repository';
import { DrizzleQuestionnaireRepository } from '../features/questionnaire/infrastructure/repositories/drizzle-questionnaire.repository';
import { DrizzleResponseRepository } from '../features/questionnaire/infrastructure/repositories/drizzle-response.repository';
import { DrizzleDocumentRepository } from '../features/document/infrastructure/repositories/drizzle-document.repository';
import { DrizzleNotificationRepository } from '../features/notification/infrastructure/repositories/drizzle-notification.repository';
import { DrizzleOnboardingRepository } from '../features/onboarding/infrastructure/repositories/drizzle-onboarding.repository';

import { getDb, healthCheck } from '../infrastructure/database/connection';

import { makeFindEmployeeByEmail } from '../features/employee/application/tools/find-employee-by-email';
import { makeGetEmployeeProfile } from '../features/employee/application/tools/get-employee-profile';
import { makeUpdateOnboardingStatus } from '../features/onboarding/application/tools/update-onboarding-status';
import { makeGetTaskList } from '../features/employee/application/tools/get-task-list';
import { makeGenerateQuestionnaire } from '../features/questionnaire/application/tools/generate-questionnaire';
import { makeEvaluateResponse } from '../features/questionnaire/application/tools/evaluate-response';
import { makeGenerateDocument } from '../features/document/application/tools/generate-document';
import { makeSendNotification } from '../features/notification/application/tools/send-notification';
import { makeScheduleReminder } from '../features/notification/application/tools/schedule-reminder';
import { makeGetNotificationHistory } from '../features/notification/application/tools/get-notification-history';

import { makeOnboardingOrchestrator } from '../features/onboarding/application/agents/onboarding-orchestrator';
import { makeQuestionnaireEngine } from '../features/questionnaire/application/agents/questionnaire-engine';
import { makeNotificationAgent } from '../features/notification/application/agents/notification-agent';
import { makeKnowledgeAgent } from '../features/knowledge/application/agents/knowledge-agent';

import { DrizzleDirectoryRepository } from '../features/directory/infrastructure/repositories/drizzle-directory.repository';
import { SlackMemberSource } from '../features/directory/infrastructure/providers/slack-member-source.adapter';
import { SlackChannelAccess } from '../features/directory/infrastructure/providers/slack-channel-access.adapter';
import { makeDirectorySync } from '../features/directory/application/services/directory-sync.service';
import { makeChannelCoverage } from '../features/directory/application/services/channel-coverage.service';

import { DrizzleBotMemoryRepository } from '../features/knowledge/infrastructure/repositories/drizzle-bot-memory.repository';
import { SlackChannelHistoryAdapter } from '../features/knowledge/infrastructure/providers/slack-channel-history.adapter';
import { makeGetUserConversations } from '../features/knowledge/application/tools/get-user-conversations';
import { makeGetChannelHistory } from '../features/knowledge/application/tools/get-channel-history';

import { BrevoAdapter } from '../features/notification/infrastructure/providers/brevo.adapter';
import { SmtpAdapter } from '../features/notification/infrastructure/providers/smtp.adapter';
import type { EmailProvider } from '../features/notification/domain/ports/providers';
import { SlackAdapter } from '../features/notification/infrastructure/providers/slack.adapter';
import { SlackWorkspaceService } from '../features/notification/infrastructure/providers/slack-workspace.service';
import { PdfmakeService } from '../features/document/infrastructure/services/pdfmake.service';
import { DocxService } from '../features/document/infrastructure/services/docx.service';

import { createEmployeeOnboardingWorkflow } from '../features/onboarding/application/workflows/employee-onboarding';

import { slackEventsRoute } from '../api/slack-events.route';
import { slackInteractionsRoute } from '../api/slack-interactions.route';
import { createApiAuthConfig } from '../shared/security/api-auth';
import { createCallerErrorMiddleware } from '../shared/security/caller-error-mapping';
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
const taskRepo = new DrizzleTaskRepository();
const questionnaireRepo = new DrizzleQuestionnaireRepository();
const responseRepo = new DrizzleResponseRepository();
const documentRepo = new DrizzleDocumentRepository();
const notificationRepo = new DrizzleNotificationRepository();
const onboardingRepo = new DrizzleOnboardingRepository();

/**
 * Sélection du fournisseur email.
 *
 * SMTP l'emporte dès que `SMTP_HOST`, `SMTP_USER` et `SMTP_PASS` sont tous renseignés,
 * sinon on retombe sur Brevo. Raison : le compte transactionnel Brevo n'est pas activé
 * (`403 permission_denied` sur `POST /v3/smtp/email`, y compris avec un expéditeur
 * pourtant validé), donc SMTP est aujourd'hui le seul chemin qui envoie réellement.
 *
 * ⚠️ Gmail : `SMTP_PASS` doit être un mot de passe d'APPLICATION (16 caractères), pas
 * le mot de passe du compte — sinon `534-5.7.9 Application-specific password required`.
 */
function createEmailProvider(): EmailProvider {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.NOTIFICATION_FROM;

  if (host && user && pass) {
    return new SmtpAdapter({
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      user,
      pass,
      from: from || user,
      fromName: 'Kisso Onboarding',
    });
  }

  return new BrevoAdapter(process.env.BREVO_API_KEY ?? '', from ?? 'noreply@kissohq.com');
}

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
export const channelCoverage = makeChannelCoverage({ source: slackChannelAccess });

// L'annuaire Slack est le SECOND paramètre, et c'est le correctif de la panne du
// 2026-08-12 (« il ne retrouve pas les autres profils à part le mien ») : `employees`
// n'est peuplée que par la modale « Compléter mon profil », donc elle contenait UNE
// ligne pour 6 personnes réelles, tandis que `slack_directory` les portait toutes,
// avec prénom, nom et poste. `directorySync` alimentait cette table depuis le
// 2026-08-12 sans qu'aucun tool ne la lise.
const findEmployeeByEmail = makeFindEmployeeByEmail(employeeRepo, directoryRepo);
const getEmployeeProfile = makeGetEmployeeProfile(employeeRepo, onboardingRepo, taskRepo);
const updateOnboardingStatus = makeUpdateOnboardingStatus(onboardingRepo);
// L'annuaire est le SECOND paramètre, et il n'est pas décoratif : sans lui, un UUID inconnu
// rend `{tasks: [], totalTasks: 0}` — indiscernable d'un employé réellement sans tâche. Le
// modèle affirmait alors « aucune tâche en cours » pour un identifiant qui ne désigne personne.
const getTaskList = makeGetTaskList(taskRepo, employeeRepo);
const generateQuestionnaire = makeGenerateQuestionnaire(questionnaireRepo);
const evaluateResponse = makeEvaluateResponse(questionnaireRepo, responseRepo);
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
});
const sendNotification = makeSendNotification(
  notificationRepo,
  employeeRepo,
  emailProvider,
  chatProvider,
  slackWorkspace,
);
// Même raison que `getTaskList` : l'annuaire permet de refuser un destinataire inexistant
// AVANT d'enregistrer un rappel. Sans lui le tool dégrade — il ne ment pas, mais il accepte.
const scheduleReminder = makeScheduleReminder(notificationRepo, employeeRepo);
const getNotificationHistory = makeGetNotificationHistory(notificationRepo);

// `discoverSlackWorkspace` a été retiré : il n'est mentionné dans AUCUNE instruction de
// l'agent (vérifié par grep), et son schéma était le poste de coût le plus lourd après
// `createEmployee`. Même raisonnement que pour `notificationAgent`, appliqué ici par
// cohérence. L'invitation Slack du parcours d'onboarding ne passe pas par ce tool mais par
// `deps.slackProvider` dans l'étape `inviteToSlack` de `employeeOnboardingWorkflow`.
// Le tool reste câblé et testé isolément — seule son exposition à cet agent est retirée.
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
  getEmployeeProfile,
  updateOnboardingStatus,
  getTaskList,
  generateDocument,
});

// `findEmployeeByEmail` est exposé aux TROIS agents depuis le 2026-08-11, et c'est un
// correctif de CÂBLAGE, pas de rédaction.
//
// Tous les tools de `questionnaireEngine` et de `notificationAgent` exigent un UUID
// d'employé, et AUCUN ne sait faire email → UUID : ce tool n'était câblé que sur
// l'orchestrateur. Pire, le `.describe()` de `recipientId` renvoyait vers
// `getEmployeeProfile`, qui exige déjà un UUID — la consigne était circulaire. Et
// `AGENT_ANTI_INVENTION_BLOCK` interdit au modèle d'en deviner un. La boucle infernale de la
// série C (« donne-moi son identifiant » → « je ne l'ai pas » → …) était donc GARANTIE par le
// câblage, pas probabiliste : c'est la répétition du bug du 2026-08-10, corrigé côté routage
// et jamais côté outillage.
//
// Coût mesuré : ≈ +120 tokens de schéma par agent, repayés à chaque aller-retour. Assumé —
// un agent qui ne peut pas résoudre une personne ne peut RIEN faire, quel que soit son prix.
// ⚠️ `evaluateResponse` est DÉLIBÉRÉMENT ABSENT — retiré le 2026-08-12 après mesure.
//
// Son schéma était cassé (`z.record()` → objet sans `properties`), donc Groq refusait
// l'appel à 100 % : le tool était inappelable, et cette panne masquait le vrai défaut.
// Dès le schéma corrigé, le premier test de production a donné ceci — deux fois de suite,
// sans qu'aucun humain n'ait répondu à quoi que ce soit :
//
//   questionnaire_responses: employee_id=d20df236…, score=100,
//   answers={"q1":"Innovation","q2":"Innovation","q3":"Oui"}
//
// Le modèle a INVENTÉ les réponses de la personne et les a enregistrées comme une
// soumission, horodatée, à son nom. C'est structurel, pas probabiliste : il n'existe
// AUCUN chemin par lequel un humain puisse soumettre des réponses — ni formulaire Block
// Kit, ni modale, ni route. Le seul appelant possible de ce tool est donc un modèle qui
// fabrique son entrée, et `AGENT_ANTI_INVENTION_BLOCK` ne l'en empêche pas : le schéma
// EXIGE des réponses, alors il en produit (même mécanique que l'email
// `votre_email@example.com`, documentée dans `find-employee-by-email.ts`).
//
// Le tool reste dans le dépôt, corrigé et testé : il redeviendra câblable le jour où un
// vrai chemin de soumission existera. Le rebrancher avant cela, c'est fabriquer des
// données RH. Effet de bord favorable : ≈ 120 tokens de schéma en moins par aller-retour.
//
// ⚠️ `findEmployeeByEmail` et `getEmployeeProfile` ont été RETIRÉS de cet agent le
// 2026-08-13. Leur justification, écrite le 2026-08-11, était : « tous les tools de
// `questionnaireEngine` exigent un UUID d'employé, et aucun ne sait faire email → UUID ».
// Elle était vraie — tant qu'`evaluateResponse` était câblé. Il a été retiré le 2026-08-12,
// et la justification est morte avec lui sans que personne ne relise la ligne.
//
// Ce qu'il reste : `generateQuestionnaire`, dont le schéma est `{title, description,
// questions[]}`. **Aucun champ ne désigne une personne.** Résoudre quelqu'un ne pouvait donc
// influencer AUCUN résultat de cet agent : les deux tools étaient du coût pur, réémis à
// chaque aller-retour.
//
// Deux gains, et le second compte davantage :
//  1. ≈ 250 tokens de schéma en moins par aller-retour (FLOOR 1244 → ~995, soit −20 %) ;
//  2. `getEmployeeProfile` lit un DOSSIER RH COMPLET. C'est le tool que la frontière
//     `canReadPersonRecord` a dû garder le 2026-08-13. L'exposer à un agent qui n'en a aucun
//     usage, c'est offrir une surface d'accès aux données de plus sans contrepartie — et la
//     surface la moins défendable est celle dont personne ne peut nommer l'utilité.
const questionnaireEngine = makeQuestionnaireEngine({
  generateQuestionnaire,
});

// discoverSlackWorkspace n'est PAS exposé ici : les instructions de l'agent ne le
// mentionnent jamais (sendNotification résout déjà le compte Slack côté serveur), et
// c'est actuellement le tool le plus coûteux en tokens du set (~356 caractères de
// schéma JSON + 426 de description). Voir CHANGELOG pour la mesure avant/après.
const notificationAgent = makeNotificationAgent({
  // Voir le commentaire de `questionnaireEngine` ci-dessus : sans ce tool, les quatre autres
  // sont inatteignables dès que l'humain désigne quelqu'un par son email — c'est-à-dire
  // presque toujours.
  findEmployeeByEmail,
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
const knowledgeAgent = makeKnowledgeAgent({ getUserConversations, getChannelHistory });

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
  taskRepo,
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
    questionnaireEngine,
    notificationAgent,
    knowledgeAgent,
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
    auth: createApiAuthConfig({
      onMisconfigured: (message) => logger.error(message),
    }),
  },
});
