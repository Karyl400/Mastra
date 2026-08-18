/**
 * Route HTTP de l'interactivité Slack — clic de bouton et soumission de modale.
 *
 * Distincte de `/slack/events` pour une raison de format, pas d'organisation :
 * les payloads d'interactivité arrivent en `application/x-www-form-urlencoded`
 * (champ `payload=<json>`), là où la route Events ne sait lire que du JSON.
 *
 * ⚠️ Comme pour la route Events, un fichier posé dans `src/api/` n'est PAS monté
 * automatiquement : cette route n'existe que parce que `slackInteractionsRoute`
 * est passé à `server.apiRoutes` dans `src/mastra/index.ts`.
 *
 * ⚠️ Le préfixe `/api` est réservé — une route personnalisée qui commence par lui
 * fait échouer le DÉMARRAGE du serveur, ce n'est pas un 404. D'où `/slack/…`.
 *
 * ⚠️ Cette route applique DEUX régimes opposés, et c'est délibéré :
 *   - `block_actions`   → `views.open` SYNCHRONE, aucune E/S avant lui.
 *                         Le `trigger_id` expire en 3 secondes.
 *   - `view_submission` → traitement lourd en TÂCHE DE FOND (lot 4 : le workflow
 *                         fait base + SMTP + Slack, largement au-delà de 3 s).
 * Ne pas « harmoniser » les deux : c'est ce qui casserait la modale.
 */
import { createHash } from 'node:crypto';
import { registerApiRoute } from '@mastra/core/server';
import type { Mastra } from '@mastra/core';

import { SlackAdapter } from '../features/notification/infrastructure/providers/slack.adapter';
import { COMPLETE_PROFILE_ACTION_ID } from '../features/notification/infrastructure/handlers/slack-events.handler';
import {
  PROFILE_MODAL_CALLBACK_ID,
  buildProfileModal,
  decodePrefill,
  errorsByBlockId,
  profileSubmissionSchema,
  readProfileSubmission,
  startDateFromJoin,
  type SlackViewState,
  type ValidatedProfile,
} from '../features/notification/infrastructure/handlers/profile-modal';
import {
  SEND_INTERVIEW_ACTION_ID,
  CANCEL_INTERVIEW_ACTION_ID,
  INTERVIEW_SENT_REPLY,
  INTERVIEW_CANCELLED_REPLY,
  INTERVIEW_NOT_YOURS_REPLY,
  INTERVIEW_SEND_FAILED_REPLY,
  decodeInterviewConfirm,
  buildSettledCardBlocks,
  confirmFacts,
} from '../features/recruitment/infrastructure/handlers/interview-confirm';
import {
  MODAL_FAILED_REPLY,
  PROFILE_SUBMISSION_FAILED_REPLY,
  describeMissingSteps,
  profileSubmissionDegradedReply,
} from '../features/onboarding/domain/services/onboarding-replies';
import { parseInterviewSchedule } from '../features/recruitment/domain/value-objects/interview-schedule';
import { buildInterviewEmail } from '../features/recruitment/domain/services/interview-email';
import { createEmailProvider } from '../features/notification/infrastructure/providers/email-provider.factory';
import type { EmailProvider } from '../features/notification/domain/ports/providers';
import {
  INTERVIEW_MODAL_CALLBACK_ID,
  START_INTERVIEW_ACTION_ID,
  buildInterviewModal,
  decodeInterviewPrefill,
  interviewSubmissionSchema,
  readInterviewSubmission,
  type InterviewChannelOption,
  type ValidatedInterview,
} from '../features/notification/infrastructure/handlers/interview-modal';
import {
  OnboardingOutcome,
  describeDegradation,
  type StepFailure,
} from '../features/onboarding/domain/value-objects/onboarding-outcome';
import { DrizzleOnboardingInterviewRepository } from '../features/onboarding/infrastructure/repositories/drizzle-onboarding-interview.repository';
import { DrizzleChannelInventoryRepository } from '../features/directory/infrastructure/repositories/drizzle-channel.repository';
import { SlackWorkspaceService } from '../features/notification/infrastructure/providers/slack-workspace.service';
import {
  buildInterviewInviteBlocks,
  interviewDoneReply,
  INTERVIEW_FAILED_REPLY,
  INTERVIEW_INVITE_TEXT,
} from '../features/notification/infrastructure/handlers/interview-invite';
import { scheduleBackgroundWork } from './slack-events.route';
import { verifySlackSignature } from '../shared/security/slack-signature';
import { logger } from '../shared/logger';

/** Chemin public. À reporter dans *Interactivity & Shortcuts* de l'app Slack. */
export const SLACK_INTERACTIONS_PATH = '/slack/interactions';

/* -------------------------------------------------------------------------- *
 * Types de payload
 * -------------------------------------------------------------------------- */

interface SlackInteractionUser {
  id?: string;
  name?: string;
}

interface SlackBlockAction {
  action_id?: string;
  value?: string;
}

/**
 * Union structurelle plutôt que discriminée : on branche sur `payload.type` en
 * TypeScript. Le payload est du JSON non fiable, et `z.discriminatedUnion` reste
 * proscrit dans ce dépôt (zod épinglé 3.25.76).
 */
interface SlackInteractionPayload {
  type?: string;
  trigger_id?: string;
  user?: SlackInteractionUser;
  team?: { id?: string };
  actions?: SlackBlockAction[];
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: SlackViewState;
  };
  /** Présents sur `block_actions` (pas sur `view_submission`) : où la carte a été cliquée. */
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string };
}

/** Sous-ensemble du `Context` Hono réellement utilisé. */
export interface SlackInteractionsContext {
  req: {
    text(): Promise<string>;
    header(name: string): string | undefined;
  };
  get(key: 'mastra'): Mastra;
}

/* -------------------------------------------------------------------------- *
 * Réponses
 * -------------------------------------------------------------------------- */

/**
 * Accusé de réception : `200` avec un corps **VIDE**.
 *
 * Sur `view_submission`, Slack n'accepte que deux formes : un corps vide (ferme
 * la modale) ou un corps portant `response_action`. Un `{"ok":true}` — le
 * réflexe hérité de la route Events — n'est ni l'un ni l'autre et affiche
 * « We had some trouble connecting » à l'utilisateur.
 */
function ack(): Response {
  return new Response(null, { status: 200 });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/* -------------------------------------------------------------------------- *
 * Adaptateur Slack mémorisé
 * -------------------------------------------------------------------------- */

let cachedAdapter: SlackAdapter | undefined;

export function getSlackInteractionsAdapter(): SlackAdapter {
  cachedAdapter ??= new SlackAdapter(process.env.SLACK_BOT_TOKEN ?? '');
  return cachedAdapter;
}

/** Réinitialise le singleton (tests). */
export function resetSlackInteractionsAdapter(): void {
  cachedAdapter = undefined;
}

/* -------------------------------------------------------------------------- *
 * Traitement
 * -------------------------------------------------------------------------- */

/**
 * Clic sur « Compléter mon profil ».
 *
 * `views.open` est appelé AVANT toute autre opération : le `trigger_id` expire
 * 3 secondes après l'interaction, et le pré-remplissage voyage déjà dans le
 * `value` du bouton — donc zéro appel réseau supplémentaire.
 */
async function handleBlockActions(payload: SlackInteractionPayload): Promise<Response> {
  const triggerId = payload.trigger_id;
  const actions = payload.actions ?? [];

  const profileAction = actions.find((a) => a.action_id === COMPLETE_PROFILE_ACTION_ID);
  const interviewAction = actions.find((a) => a.action_id === START_INTERVIEW_ACTION_ID);

  // ── Recrutement : les deux boutons de la carte de confirmation ─────────────
  // Traités AVANT la garde `trigger_id` : ils n'ouvrent aucune modale, donc ils n'ont pas
  // besoin d'un `trigger_id`. Les placer après ferait échouer l'envoi sur une garde qui ne
  // les concerne pas.
  if (actions.some((a) => a.action_id === CANCEL_INTERVIEW_ACTION_ID)) {
    // ⚠️ La prise se fait ICI, avant l'ACK, et pas dans la tâche de fond : c'est une décision
    // synchrone sans E/S, et la mettre en tâche de fond rouvrirait la fenêtre qu'elle ferme.
    //
    // Annuler NEUTRALISE la carte. Sans cela « Envoyer » restait cliquable APRÈS une
    // annulation — l'annulation n'écrivait qu'une phrase et ne retirait rien.
    if (!claimCard(payload)) {
      logger.info('Carte d’entretien déjà tranchée — clic ignoré');
      return ack();
    }

    // Même régime que l'envoi ci-dessous, et pour la même raison : ce sont des appels réseau
    // à Slack. Awaités, ils portaient l'ACK à 5,3 s (mesuré) — au-delà des 3 secondes
    // accordées, alors qu'une annulation n'a strictement rien à faire attendre.
    scheduleInteractionWork(
      'interview_cancel',
      settleCard(payload, INTERVIEW_CANCELLED_REPLY)
        .then(() => replyInThread(payload, INTERVIEW_CANCELLED_REPLY))
        .catch((error: unknown) => {
          logger.error('Réponse d’annulation non postée', { error: String(error) });
        }),
    );
    return ack();
  }

  const sendAction = actions.find((a) => a.action_id === SEND_INTERVIEW_ACTION_ID);
  if (sendAction) {
    // ⚠️ LA GARANTIE D'UN SEUL ENVOI, et elle est ici — synchrone, avant l'ACK. Un email vers
    // un candidat est la seule action irréversible et SORTANTE de ce système ; le tool a sa
    // garde (`runGuard`) et le workflow d'onboarding la sienne (`onboardingRunId`), ce clic
    // n'en avait aucune.
    if (!claimCard(payload)) {
      logger.info('Carte d’entretien déjà tranchée — second clic ignoré');
      return ack();
    }

    // ⚠️ TÂCHE DE FOND, et surtout PAS `await` — défaut mesuré en production le 2026-08-15 :
    // un clic signé répondait 200 en **22,5 secondes**. L'email partait bien, mais Slack
    // n'accorde que **3 secondes** à une interaction : passé ce délai il affiche une erreur.
    //
    // Pour un email SORTANT vers un candidat, la conséquence est sérieuse : la personne voit
    // un échec, reclique, et le candidat reçoit DEUX invitations. Le bouton « marchait » tout
    // en paraissant cassé — la pire des combinaisons, et exactement le genre d'écart entre le
    // FAIT et ce qu'en perçoit l'utilisateur que ce dépôt traque partout ailleurs.
    //
    // `handleInterviewSend` rend déjà compte DANS LE FIL (`replyInThread`), succès comme
    // échec : rien n'est perdu à répondre tout de suite. C'est le régime déjà retenu pour
    // `view_submission`, énoncé en tête de ce fichier ; l'envoi d'entretien était resté sur le
    // chemin synchrone alors qu'il fait un SMTP complet PUIS un appel Slack.
    scheduleInteractionWork(
      'interview_send',
      handleInterviewSend(payload, sendAction.value).catch((error: unknown) => {
        logger.error('Envoi d’entretien en tâche de fond échoué', { error: String(error) });
      }),
    );
    return ack();
  }

  if (!profileAction && !interviewAction) return ack();

  if (!triggerId) {
    logger.warn('block_actions without a trigger_id, cannot open the modal');
    return ack();
  }

  // ⚠️ AUCUNE E/S avant `views.open`, dans les DEUX branches : le `trigger_id` expire
  // 3 secondes après l'interaction. Le pré-remplissage voyage déjà dans le `value` du bouton
  // — c'est précisément pour cela qu'il y voyage.
  if (interviewAction) {
    const prefill = decodeInterviewPrefill(interviewAction.value, payload.user?.id ?? '');
    try {
      await getSlackInteractionsAdapter().openModal(triggerId, buildInterviewModal(prefill));
      logger.info('Interview modal opened', {
        userId: prefill.slackUserId,
        channelsOffered: prefill.channels.length,
      });
    } catch (error) {
      // ⚠️ Sans ce message, le symptôme est « le bouton ne fait rien » — indiagnosticable
      // côté utilisateur, et indiscernable d'une Request URL mal configurée.
      logger.error('Unable to open the interview modal', { error, userId: prefill.slackUserId });
      scheduleInteractionWork(
        'interview_modal_failed',
        tellNewcomer(prefill.slackUserId, MODAL_FAILED_REPLY),
      );
    }
    return ack();
  }

  const prefill = decodePrefill(profileAction!.value, payload.user?.id ?? '');

  try {
    await getSlackInteractionsAdapter().openModal(triggerId, buildProfileModal(prefill));
    logger.info('Profile modal opened', { userId: prefill.slackUserId });
  } catch (error) {
    // Ne jamais propager : Slack rejouerait, et le trigger_id serait de toute
    // façon expiré au second essai. Mais on le DIT — voir la branche entretien ci-dessus.
    logger.error('Unable to open the profile modal', { error, userId: prefill.slackUserId });
    scheduleInteractionWork(
      'profile_modal_failed',
      tellNewcomer(prefill.slackUserId, MODAL_FAILED_REPLY),
    );
  }

  return ack();
}

/* -------------------------------------------------------------------------- *
 * Recrutement — l'envoi réel de l'invitation d'entretien
 * -------------------------------------------------------------------------- */

let cachedEmailProvider: EmailProvider | undefined;

/**
 * ⚠️ Construit PARESSEUSEMENT et partagé avec `src/mastra/index.ts` via la fabrique commune :
 * une copie du choix SMTP/Brevo ferait partir les emails d'entretien par un fournisseur et
 * ceux de notification par un autre, sans que rien ne le signale.
 */
function getEmailProvider(): EmailProvider {
  cachedEmailProvider ??= createEmailProvider();
  return cachedEmailProvider;
}

/** Réinitialise le singleton (tests). */
export function resetRecruitmentDependencies(): void {
  cachedEmailProvider = undefined;
}

/**
 * Programme un travail de fond ET signale s'il ne survivra pas au gel de la fonction.
 *
 * ⚠️ `scheduleBackgroundWork` rend `'vercel-wait-until' | 'detached'`. La route Events
 * exploite ce verdict depuis l'origine (« Slack background work is detached on Vercel ») ;
 * cette route-ci l'IGNORAIT à ses quatre sites d'appel. Or c'est ici que vivent l'envoi de
 * l'email d'entretien, le workflow d'onboarding complet et l'enregistrement de l'entretien :
 * si `waitUntil` venait à disparaître, ces trois-là seraient tués en vol **sans une seule
 * ligne de journal**, après avoir répondu 200 à l'utilisateur.
 *
 * `label` nomme le travail perdu — sans lui, la ligne d'alerte ne dirait pas lequel.
 */
function scheduleInteractionWork(label: string, work: Promise<unknown>): void {
  const mechanism = scheduleBackgroundWork(work);
  if (mechanism === 'detached' && process.env.VERCEL) {
    logger.error('Travail d’interactivité détaché sur Vercel — waitUntil indisponible', {
      work: label,
    });
  }
}

/**
 * Répond dans le fil de la carte — jamais à la racine, la carte y serait orpheline.
 *
 * ⚠️ Cette phrase était FAUSSE jusqu'au 2026-08-18 : la fonction appelait `sendMessage`, qui
 * n'avait aucun paramètre de fil, et le `thread_ts` du payload — pourtant déclaré dans le
 * type — n'était lu nulle part. « C'est envoyé à … » atterrissait donc à la racine du canal.
 *
 * `thread_ts ?? ts` : si la carte est elle-même dans un fil on y reste ; sinon on OUVRE le
 * fil sous la carte. Dans les deux cas la confirmation est attachée à ce qu'elle confirme.
 */
async function replyInThread(payload: SlackInteractionPayload, text: string): Promise<void> {
  const channel = payload.channel?.id;
  if (!channel) return;
  try {
    const threadTs = payload.message?.thread_ts ?? payload.message?.ts;
    await getSlackInteractionsAdapter().sendMessage(channel, text, threadTs);
  } catch (error) {
    // Ne jamais propager : Slack rejouerait l'interaction, donc l'email partirait DEUX FOIS.
    // Un accusé perdu est bénin ; un second email à un candidat ne l'est pas.
    logger.error('Réponse de confirmation non postée', { error: String(error) });
  }
}

/**
 * Cartes déjà tranchées — envoyées, annulées ou refusées.
 *
 * ⚠️ GARDE EN MÉMOIRE, par instance, et il faut dire ce qu'elle couvre et ce qu'elle ne
 * couvre pas. Elle couvre le cas RÉEL : la même personne reclique sur la même carte quelques
 * secondes plus tard, sur l'instance encore chaude. Elle ne couvre pas deux clics
 * simultanés routés vers deux instances différentes.
 *
 * On ne paie PAS un aller-retour Turso pour ce reliquat, et c'est un arbitrage assumé : la
 * seconde barrière — la carte réécrite sans bouton — retire l'affordance elle-même, donc le
 * scénario résiduel exige deux clics dans la fenêtre de quelques centaines de millisecondes
 * qui précède la réécriture. Le magasin partagé existe (`slack_event_dedup`) si ce reliquat
 * devenait un incident réel ; aujourd'hui il n'en est pas un.
 */
const settledCards = new Set<string>();

/** Une carte est identifiée par le message qui la porte. */
function cardKey(payload: SlackInteractionPayload): string | null {
  const channel = payload.channel?.id;
  const ts = payload.message?.ts;
  return channel && ts ? `${channel}:${ts}` : null;
}

/**
 * Prend la carte, ou refuse. Une carte prise ne peut plus rien déclencher.
 *
 * Sans clé identifiable (payload sans `message`), on LAISSE PASSER : refuser casserait le
 * chemin nominal sur un détail de forme, et c'est la neutralisation visuelle qui porte alors
 * seule la garantie.
 */
function claimCard(payload: SlackInteractionPayload): boolean {
  const key = cardKey(payload);
  if (!key) return true;
  if (settledCards.has(key)) return false;
  settledCards.add(key);
  return true;
}

/**
 * Rend une carte prise — elle redevient cliquable.
 *
 * Deux cas, et un seul principe : on ne consomme la carte que si le clic a EU un effet. Un
 * échec SMTP n'a rien envoyé, donc réessayer est la bonne conduite ; et un clic par un
 * témoin non autorisé ne doit pas détruire l'invitation du demandeur légitime, sans quoi le
 * contrôle d'accès deviendrait un déni de service.
 */
function releaseCard(payload: SlackInteractionPayload): void {
  const key = cardKey(payload);
  if (key) settledCards.delete(key);
}

/** Réservé aux tests : la garde est un état de module, il doit pouvoir repartir à zéro. */
export function resetSettledCards(): void {
  settledCards.clear();
}

/**
 * Réécrit la carte sans ses boutons, avec le verdict à la place.
 *
 * ⚠️ Ne lève jamais et n'est jamais bloquant : une carte non réécrite est une gêne, alors
 * qu'une exception ici empêcherait le message de confirmation de partir. La garantie de
 * non-répétition est portée par `claimCard`, pas par cet appel réseau.
 */
async function settleCard(
  payload: SlackInteractionPayload,
  verdict: string,
  facts?: readonly string[],
): Promise<void> {
  const channel = payload.channel?.id;
  const ts = payload.message?.ts;
  if (!channel || !ts) return;
  try {
    await getSlackInteractionsAdapter().updateMessage(
      channel,
      ts,
      verdict,
      buildSettledCardBlocks({ verdict, facts }),
    );
  } catch (error) {
    logger.error('Carte d’entretien non neutralisée', { error: String(error) });
  }
}

/**
 * Clic sur « Envoyer » — le SEUL endroit du système où un email part vers une adresse
 * extérieure non contrainte par l'annuaire.
 *
 * ⚠️ **Rien n'est rejoué sur confiance.** Le bouton ne transporte que des CHAMPS ; le sujet et
 * le corps sont re-rendus ici par le même gabarit, et la date est re-validée. Transporter le
 * corps dans le `value` aurait fait de ce bouton un moyen d'envoyer un texte arbitraire à une
 * adresse arbitraire — c'est-à-dire exactement la primitive d'exfiltration que toute la
 * feature est construite pour ne pas offrir.
 */
async function handleInterviewSend(
  payload: SlackInteractionPayload,
  rawValue: string | undefined,
): Promise<void> {
  const confirm = decodeInterviewConfirm(rawValue);
  if (!confirm) {
    logger.warn('Confirmation d’entretien illisible');
    await settleCard(payload, INTERVIEW_SEND_FAILED_REPLY);
    await replyInThread(payload, INTERVIEW_SEND_FAILED_REPLY);
    return;
  }

  // ⚠️ Le cliqueur DOIT être celui qui a préparé l'invitation. La carte est visible de tous
  // ceux qui voient le fil : sans ce contrôle, un témoin écrirait à l'extérieur au nom de
  // l'entreprise. Même famille de défaut que la modale de profil en canal.
  const clicker = payload.user?.id ?? '';
  if (clicker !== confirm.requesterUserId) {
    logger.warn('Envoi d’entretien refusé — cliqueur différent du demandeur');
    // ⚠️ La carte n'est PAS neutralisée ici, et c'est voulu : le demandeur légitime doit
    // encore pouvoir envoyer. Un témoin qui clique ne doit pas pouvoir détruire l'invitation
    // de quelqu'un d'autre — ce serait transformer un contrôle d'accès en déni de service.
    // La prise faite plus haut est donc RENDUE.
    releaseCard(payload);
    await replyInThread(payload, INTERVIEW_NOT_YOURS_REPLY);
    return;
  }

  // Re-validation : entre la préparation et le clic, la date a pu devenir passée.
  const parsed = parseInterviewSchedule(confirm.startsAt, new Date());
  if (!parsed.ok) {
    logger.warn('Envoi d’entretien refusé — date invalide au clic', { reason: parsed.reason });
    const expired = "Cette date n'est plus valide — rien n'est parti. Redemande-moi l'invitation.";
    // Neutralisée : cette carte ne pourra plus jamais rien envoyer, sa date est périmée.
    await settleCard(payload, expired);
    await replyInThread(payload, expired);
    return;
  }

  const email = buildInterviewEmail({
    candidateName: confirm.candidateName,
    schedule: parsed.schedule,
    position: confirm.position,
    location: confirm.location,
    replyTo: confirm.replyTo,
  });

  try {
    await getEmailProvider().sendEmail(confirm.to, email.subject, email.body);
  } catch (error) {
    // ⚠️ On ne prétend JAMAIS avoir envoyé. Troisième occurrence de cette discipline dans ce
    // dépôt, après `emailSent: false` sous `status: 'success'` et `status = Sent` avant le try.
    logger.error('Email d’entretien NON envoyé', { error: String(error) });
    // ⚠️ On REND la prise : rien n'est parti, donc réessayer est légitime — et c'est même la
    // seule chose à faire. Neutraliser la carte ici obligerait à tout redemander au modèle,
    // soit un aller-retour LLM complet pour une panne SMTP de trente secondes.
    releaseCard(payload);
    await replyInThread(payload, INTERVIEW_SEND_FAILED_REPLY);
    return;
  }

  // ⚠️ Aucune écriture en base, et c'est un choix : `RecipientType` n'a pas de valeur honnête
  // pour un candidat, et en ajouter une contaminerait le schéma de `sendNotification`. Surtout,
  // stocker l'adresse et l'invitation d'un NON-SALARIÉ créerait des données personnelles sans
  // chemin d'effacement — le trou que `TODO.md` recense déjà pour `notifications` et
  // `documents`. La trace vit dans le fil Slack, que les intéressés lisent, et ici en journal.
  logger.info('Invitation d’entretien envoyée', {
    recipientDomain: confirm.to.split('@')[1] ?? 'inconnu',
    when: parsed.schedule.at.toISOString(),
    hasPosition: Boolean(confirm.position),
    hasLocation: Boolean(confirm.location),
  });

  const sent = INTERVIEW_SENT_REPLY(confirm.to, parsed.schedule.humanReadable);
  // La carte porte désormais le verdict, à l'endroit exact où l'on a cliqué : c'est ce qui
  // évite le second clic bien plus sûrement qu'un message posté à côté.
  await settleCard(payload, sent, confirmFacts(confirm, parsed.schedule.humanReadable));
  await replyInThread(payload, sent);
}

/**
 * Écrit à la personne qui vient de valider la modale.
 *
 * ⚠️ Le canal est son DM, jamais le canal d'origine : la soumission d'un profil est privée
 * par nature, et `slackUserId` EST une clé de conversation directe valide pour
 * `chat.postMessage`.
 *
 * Ne lève jamais : ce message accompagne un verdict, il ne doit pas pouvoir en produire un
 * second. Un échec ici est journalisé et rien de plus.
 */
async function tellNewcomer(slackUserId: string | undefined, text: string): Promise<void> {
  if (!slackUserId) {
    logger.warn('Verdict d’onboarding non transmis — aucun utilisateur Slack identifié');
    return;
  }
  try {
    await getSlackInteractionsAdapter().sendMessage(slackUserId, text);
  } catch (error) {
    logger.error('Verdict d’onboarding non transmis', { error: String(error) });
  }
}

/**
 * Identifiant de run dérivé de l'email.
 *
 * Deux soumissions du même profil produisent le même `runId`, donc le même run
 * — y compris depuis deux instances serverless concurrentes. C'est ce qui rend
 * l'idempotence indépendante du cache mémoire de `create-employee.ts`, inopérant
 * hors d'un processus unique.
 */
export function onboardingRunId(email: string): string {
  const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return `onboarding-${digest.slice(0, 32)}`;
}

/**
 * Exécute le workflow d'intégration. Appelé en TÂCHE DE FOND uniquement.
 *
 * ⚠️ `getWorkflow()` prend la CLÉ DU REGISTRE (`src/mastra/index.ts`), pas l'`id`
 * interne du workflow — ce dernier ne se résout que via `getWorkflowById`. Une
 * clé erronée rend `undefined` et lève un `TypeError` **dans la tâche de fond**,
 * donc invisible.
 */
async function runOnboarding(
  mastra: Mastra,
  profile: ValidatedProfile,
  startDate: string,
  slackUserId: string | undefined,
): Promise<void> {
  const workflow = mastra.getWorkflow('employeeOnboardingWorkflow' as never) as unknown as {
    createRun(options?: { runId?: string }): Promise<{
      start(args: { inputData: unknown }): Promise<{
        status: string;
        result?: {
          // ⚠️ `employeeId` est bien dans `onboardingOutputSchema` — il est déclaré ici parce
          // que ce type est écrit à la main : `getWorkflow()` rend `unknown` et Mastra ne
          // publie pas le type de sortie. C'est lui qui relie le dossier créé à l'entretien.
          employeeId?: string;
          outcome?: OnboardingOutcome;
          emailSent?: boolean;
          slackInvited?: boolean;
          degradedSteps?: StepFailure[];
        };
        error?: unknown;
      }>;
    }>;
  };

  if (!workflow) {
    logger.error('Workflow employeeOnboardingWorkflow introuvable dans le registre Mastra');
    await tellNewcomer(slackUserId, PROFILE_SUBMISSION_FAILED_REPLY);
    return;
  }

  const run = await workflow.createRun({ runId: onboardingRunId(profile.email) });

  const result = await run.start({
    inputData: {
      firstName: profile.firstName,
      lastName: profile.lastName,
      email: profile.email,
      // Plus JAMAIS renseigné : le parcours d'arrivée a cessé de collecter le département
      // le 2026-08-13, et `employees.department` est nullable depuis la même date.
      department: null,
      position: profile.position,
      // Dérivée de l'instant du `team_join`, jamais saisie : voir `startDateFromJoin`.
      startDate,
      // Aucune correspondance département → canal n'existe aujourd'hui : le workflow saute
      // alors l'invitation Slack, sans échouer. L'arrivant est de toute façon déjà entré
      // dans les canaux d'accueil, au `team_join`, par un chemin qui ne passe pas ici.
      slackChannelId: null,
    },
  });

  if (result.status !== 'success') {
    logger.error('Onboarding workflow failed', {
      email: profile.email,
      outcome: OnboardingOutcome.Failed,
      error: result.error,
    });
    // ⚠️ Il n'y a PAS de dossier ici : c'est le seul cas où l'on demande de recommencer. La
    // soumission est idempotente, une seconde tentative ne créera pas de doublon.
    await tellNewcomer(slackUserId, PROFILE_SUBMISSION_FAILED_REPLY);
    return;
  }

  // ⚠️ `result.status === 'success'` ne signifie QUE « le workflow est allé au
  // bout ». Le verdict est `result.result.outcome` : les étapes best-effort
  // (email, invitation Slack, tâches) avalent leur exception et laissent le run
  // en `success` même quand rien n'est parti. Journaliser le seul `status`
  // reproduirait exactement le faux « PASS » que ce champ existe pour éliminer.
  const degradedSteps = result.result?.degradedSteps ?? [];

  if (result.result?.outcome === OnboardingOutcome.Degraded) {
    logger.error('Onboarding workflow completed in DEGRADED mode', {
      email: profile.email,
      outcome: result.result.outcome,
      degradedSteps: describeDegradation(degradedSteps),
      emailSent: result.result?.emailSent,
      slackInvited: result.result?.slackInvited,
    });

    // ⚠️ Le dossier EXISTE : on ne demande pas de recommencer, on NOMME ce qui manque. Sans
    // ce message, l'arrivant recevait l'invitation à l'entretien exactement comme en cas de
    // succès et ignorait qu'un email de bienvenue aurait dû lui parvenir.
    //
    // La liste vient du verdict réel, jamais devinée : annoncer un email non parti alors
    // qu'il l'est serait le mensonge inverse de celui qu'on corrige. Une liste vide — étapes
    // dégradées non traduisibles — n'envoie rien plutôt qu'un message creux.
    const missing = describeMissingSteps(degradedSteps);
    if (missing.length > 0) {
      await tellNewcomer(slackUserId, profileSubmissionDegradedReply(missing));
    }
  } else {
    logger.info('Onboarding workflow completed', {
      email: profile.email,
      outcome: result.result?.outcome,
      emailSent: result.result?.emailSent,
      slackInvited: result.result?.slackInvited,
    });
  }

  // ⚠️ Proposé sur `completed` ET sur `degraded`, et cette distinction compte.
  //
  // `degraded` signifie « l'employé EST créé, une étape best-effort a échoué » — un email de
  // bienvenue non parti, une invitation Slack manquée. C'est un ABOUTISSEMENT, pas un échec :
  // le workflow existe précisément pour ne pas perdre la création sur une indisponibilité SMTP
  // de trente secondes. Refuser l'entretien dans ce cas priverait de ses canaux quelqu'un dont
  // le dossier est parfaitement valide, et le priverait justement le jour où quelque chose a
  // déjà mal tourné.
  //
  // Le cas `failed`, lui, sort plus haut par `return` : là, il n'y a pas de dossier.
  await offerInterview(result.result?.employeeId, slackUserId);
}

/**
 * Propose l'entretien, une fois le dossier RÉELLEMENT créé.
 *
 * ⚠️ Appelé sur `completed` ET sur `degraded` — voir la justification à son site d'appel —
 * mais JAMAIS après un `failed`, qui sort plus haut par `return` : proposer « parlons de toi »
 * à quelqu'un dont la création vient d'échouer supposerait un succès que personne n'a
 * vérifié, la faute exacte du `emailSent: false` sous `status: 'success'`.
 *
 * ⚠️ La phrase qui figurait ici — « appelé uniquement après un `outcome` NON DÉGRADÉ » —
 * était FAUSSE, et contredisait le commentaire de son propre site d'appel à cinq lignes
 * d'écart.
 *
 * Ne LÈVE jamais. Un entretien manqué est une gêne ; une exception ici remonterait dans la
 * tâche de fond du workflow d'onboarding et masquerait son propre verdict.
 */
async function offerInterview(
  employeeId: string | undefined,
  slackUserId: string | undefined,
): Promise<void> {
  if (!employeeId || !slackUserId) {
    logger.warn('Interview not offered — missing employee or Slack user', {
      hasEmployee: Boolean(employeeId),
      hasUser: Boolean(slackUserId),
    });
    return;
  }

  try {
    // Lu ICI et non au clic : ce chemin est en tâche de fond, sans contrainte de 3 secondes,
    // alors que `views.open` en a une. C'est ce qui permet au bouton de transporter la liste
    // et à la modale de s'ouvrir sans aucune E/S.
    const channels = await offerableChannels();

    if (channels.length === 0) {
      // L'inventaire est alimenté à la main : une base neuve ou jamais synchronisée n'a
      // aucun canal. On propose quand même l'entretien — les deux questions libres gardent
      // tout leur sens — mais on le SIGNALE, parce que c'est le symptôme d'un
      // `sync-slack-directory --channels --apply` jamais lancé.
      logger.warn('No offerable channel in the inventory — interview will have no channel field');
    }

    await getSlackInteractionsAdapter().sendBlocks(
      slackUserId,
      INTERVIEW_INVITE_TEXT,
      buildInterviewInviteBlocks({ employeeId, slackUserId, channels }),
    );

    logger.info('Interview offered', { employeeId, channelsOffered: channels.length });
  } catch (error) {
    logger.error('Unable to offer the interview', { error, employeeId });
  }
}

/**
 * Soumission de la modale.
 *
 * En cas d'erreur de validation, `response_action: 'errors'` réaffiche la modale
 * avec les messages par champ **sans perdre la saisie**. Les clés sont des
 * `block_id` — une clé inconnue est silencieusement ignorée par Slack.
 */
function handleViewSubmission(payload: SlackInteractionPayload, mastra: Mastra): Response {
  if (payload.view?.callback_id === INTERVIEW_MODAL_CALLBACK_ID) {
    return handleInterviewSubmission(payload);
  }

  if (payload.view?.callback_id !== PROFILE_MODAL_CALLBACK_ID) return ack();

  const raw = readProfileSubmission(payload.view.state ?? {});
  const parsed = profileSubmissionSchema.safeParse(raw);

  if (!parsed.success) {
    const errors = errorsByBlockId(parsed.error);
    logger.info('Profile submission rejected', { fields: Object.keys(errors) });
    return jsonResponse({ response_action: 'errors', errors });
  }

  const prefill = decodePrefill(payload.view.private_metadata, payload.user?.id ?? '');

  // La date d'arrivée voyage dans le `private_metadata`, signé par Slack. On ne la redemande
  // ni à l'humain ni à l'API : elle est connue depuis le `team_join`.
  const startDate = startDateFromJoin(prefill.joinedAt, new Date());

  logger.info('Profile submission accepted', {
    slackUserId: prefill.slackUserId,
    startDate,
  });

  // TÂCHE DE FOND — régime OPPOSÉ à celui de `block_actions` ci-dessus : le
  // workflow écrit en base, envoie un email SMTP et appelle Slack, largement
  // au-delà des 3 secondes accordées à cette réponse. Sur Vercel, `waitUntil`
  // empêche le gel de la fonction avant la fin.
  const work = runOnboarding(mastra, parsed.data, startDate, prefill.slackUserId).catch(
    (error: unknown) => {
      logger.error('Background onboarding failed', { error, email: parsed.data.email });
    },
  );
  scheduleInteractionWork('profile_submission', work);

  return ack();
}

/* -------------------------------------------------------------------------- *
 * Entretien post-profil
 * -------------------------------------------------------------------------- */

let cachedInterviewRepo: DrizzleOnboardingInterviewRepository | undefined;
let cachedChannelRepo: DrizzleChannelInventoryRepository | undefined;
let cachedWorkspace: SlackWorkspaceService | undefined;

/**
 * Dépôts et client Slack, construits PARESSEUSEMENT.
 *
 * Ce module est évalué au chargement de `src/mastra/index.ts`, donc à chaque démarrage à
 * froid — c'est-à-dire sur le chemin des 3 secondes d'ACK de Slack. Ouvrir une connexion
 * Turso ici y ajouterait le handshake complet, et un ACK à 6,7 s a déjà provoqué un rejeu,
 * donc une double réponse en production.
 */
function interviewRepo(): DrizzleOnboardingInterviewRepository {
  cachedInterviewRepo ??= new DrizzleOnboardingInterviewRepository();
  return cachedInterviewRepo;
}

function channelRepo(): DrizzleChannelInventoryRepository {
  cachedChannelRepo ??= new DrizzleChannelInventoryRepository();
  return cachedChannelRepo;
}

function workspace(): SlackWorkspaceService {
  cachedWorkspace ??= new SlackWorkspaceService(process.env.SLACK_BOT_TOKEN ?? '');
  return cachedWorkspace;
}

/** Réinitialise les singletons (tests). */
export function resetInterviewDependencies(): void {
  cachedInterviewRepo = undefined;
  cachedChannelRepo = undefined;
  cachedWorkspace = undefined;
}

/**
 * Canaux proposables à l'entretien.
 *
 * ⚠️ DEUX filtres, et aucun n'est optionnel :
 *  - `!isArchived` — l'inventaire de production compte 32 canaux dont **26 archivés**.
 *    Proposer un canal archivé garantit un échec d'invitation, donc une promesse cassée
 *    dans la réponse rendue à la personne.
 *  - `isMember` — `conversations.invite` échoue si le bot n'est pas lui-même dans le canal.
 *    C'est une condition de FAISABILITÉ, distincte du droit du demandeur.
 *
 * ⚠️ L'inventaire est alimenté À LA MAIN (`scripts/sync-slack-directory.mts --channels
 * --apply`) : aucun événement ne le tient à jour, `member_joined_channel` n'étant pas abonné.
 * Il est donc PÉRIMABLE, et c'est pour cela que l'invitation distingue l'échec du succès au
 * lieu de supposer que la liste dit vrai.
 */
async function offerableChannels(): Promise<InterviewChannelOption[]> {
  const channels = await channelRepo().listChannels();
  return channels
    .filter((channel) => !channel.isArchived && channel.isMember && channel.name.length > 0)
    .map((channel) => ({ channelId: channel.channelId, name: channel.name }));
}

/**
 * Invite la personne aux canaux qu'elle a cochés.
 *
 * DÉTERMINISTE de bout en bout : la liste vient de Slack, transite par le `value` signé du
 * bouton, et est revalidée en forme des deux côtés. Aucun modèle sur ce chemin — c'est ce qui
 * distingue cet entretien du questionnaire qu'il remplace, dont la seule sortie était un
 * enregistrement que personne ne lisait.
 *
 * ⚠️ Chaque échec est ISOLÉ. Un canal archivé entre deux synchronisations ne doit pas priver
 * la personne des quatre autres.
 */
async function inviteToChannels(
  slackUserId: string,
  selected: readonly string[],
  nameOf: ReadonlyMap<string, string>,
): Promise<{ joined: string[]; already: string[]; failed: string[] }> {
  const joined: string[] = [];
  const already: string[] = [];
  const failed: string[] = [];

  for (const channelId of selected) {
    const name = nameOf.get(channelId) ?? channelId;
    try {
      await workspace().inviteToChannel(channelId, slackUserId);
      joined.push(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // `already_in_channel` n'est PAS un échec : la personne y est, l'intention est
      // satisfaite. Le compter comme raté ferait annoncer un problème inexistant.
      if (message.includes('already_in_channel')) {
        already.push(name);
      } else {
        logger.warn('Interview channel invite failed', { channelId, error: message });
        failed.push(name);
      }
    }
  }

  return { joined, already, failed };
}

/**
 * Enregistre l'entretien puis applique ses effets. Appelé en TÂCHE DE FOND uniquement.
 *
 * ⚠️ L'ordre est imposé : on ENREGISTRE d'abord, on invite ensuite. Si l'écriture échoue, la
 * personne est prévenue et rien n'a bougé ; si l'invitation échoue, ses réponses sont sauves
 * et la réponse le dit canal par canal. L'ordre inverse pourrait l'ajouter à cinq canaux tout
 * en perdant ce qu'elle a écrit, sans qu'aucune des deux moitiés ne le signale.
 */
async function applyInterview(
  slackUserId: string,
  employeeId: string,
  answers: ValidatedInterview,
  nameOf: ReadonlyMap<string, string>,
): Promise<void> {
  const slack = getSlackInteractionsAdapter();
  const now = new Date();

  try {
    await interviewRepo().save({
      employeeId,
      slackUserId,
      channels: answers.channels,
      dailyWork: answers.dailyWork,
      workStyle: answers.workStyle,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    logger.error('Interview could not be saved', { error, employeeId });
    await slack.sendMessage(slackUserId, INTERVIEW_FAILED_REPLY);
    return;
  }

  const outcome = await inviteToChannels(slackUserId, answers.channels, nameOf);

  logger.info('Interview recorded', {
    employeeId,
    channelsSelected: answers.channels.length,
    joined: outcome.joined.length,
    already: outcome.already.length,
    failed: outcome.failed.length,
    // Les LONGUEURS, jamais le contenu : ce sont des réponses personnelles.
    dailyWorkLength: answers.dailyWork.length,
    workStyleLength: answers.workStyle.length,
  });

  await slack.sendMessage(slackUserId, interviewDoneReply(outcome));
}

/**
 * Soumission de l'entretien.
 *
 * Régime identique à celui de la modale de profil : ACK immédiat, traitement lourd en tâche
 * de fond. Une invitation par canal plus une écriture Turso dépassent largement les
 * 3 secondes accordées à cette réponse.
 */
function handleInterviewSubmission(payload: SlackInteractionPayload): Response {
  const prefill = decodeInterviewPrefill(payload.view?.private_metadata, payload.user?.id ?? '');
  const raw = readInterviewSubmission(payload.view?.state ?? {});
  const parsed = interviewSubmissionSchema.safeParse(raw);

  if (!parsed.success) {
    // Les trois champs sont optionnels et bornés côté vue : un échec ici signale un payload
    // forgé, pas une erreur de saisie. On ferme sans rien réafficher — il n'y a pas de champ
    // à corriger — mais on le journalise, parce que c'est la signature d'un appel hostile.
    logger.warn('Interview submission rejected', {
      fields: Object.keys(parsed.error.flatten().fieldErrors),
    });
    // ⚠️ On le DIT. La modale se fermait exactement comme sur un succès : la personne croyait
    // ses réponses enregistrées alors que rien ne l'était. Le vocabulaire d'échec existait
    // déjà et n'était utilisé que pour la panne de base.
    scheduleInteractionWork(
      'interview_submission_rejected',
      tellNewcomer(payload.user?.id, INTERVIEW_FAILED_REPLY),
    );
    return ack();
  }

  if (!prefill.employeeId || !prefill.slackUserId) {
    // Sans employé, l'entretien n'a pas de clé : `employee_id` est la PRIMARY KEY. On échoue
    // bruyamment plutôt que d'écrire une ligne orpheline que personne ne relirait.
    logger.error('Interview submission without an employee id', {
      hasUser: Boolean(prefill.slackUserId),
    });
    // Cas réel et non théorique : un bouton posté avant un changement de format rend
    // `employeeId: ''`. La personne clique sur une invitation d'hier et sa modale se ferme
    // dans le vide — elle doit savoir que rien n'a été gardé.
    scheduleInteractionWork(
      'interview_submission_no_employee',
      tellNewcomer(prefill.slackUserId || payload.user?.id, INTERVIEW_FAILED_REPLY),
    );
    return ack();
  }

  const nameOf = new Map(prefill.channels.map((channel) => [channel.channelId, channel.name]));

  const work = applyInterview(prefill.slackUserId, prefill.employeeId, parsed.data, nameOf).catch(
    (error: unknown) => {
      logger.error('Background interview handling failed', { error });
    },
  );
  scheduleInteractionWork('interview_submission', work);

  return ack();
}

export async function handleSlackInteractionRequest(
  c: SlackInteractionsContext,
): Promise<Response> {
  // Corps BRUT d'abord : le HMAC porte dessus, et le lire autrement
  // (`c.req.parseBody()`) consommerait le flux.
  const rawBody = await c.req.text();

  const verification = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    timestamp: c.req.header('x-slack-request-timestamp'),
    signature: c.req.header('x-slack-signature'),
    rawBody,
  });

  if (!verification.valid) {
    logger.warn('Rejected Slack interaction', { reason: verification.reason });
    return jsonResponse({ error: 'unauthorized', reason: verification.reason }, 401);
  }

  const params = new URLSearchParams(rawBody);

  // À l'enregistrement de la Request URL, Slack envoie un POST `ssl_check=1`
  // SANS champ `payload`. Répondre autrement qu'un 200 fait REFUSER l'URL —
  // et donc la fonctionnalité entière n'existe jamais.
  if (params.get('ssl_check') === '1') {
    logger.info('Slack ssl_check acknowledged');
    return ack();
  }

  // `URLSearchParams.get` décode déjà le pourcentage : un `decodeURIComponent`
  // supplémentaire lèverait « URI malformed » sur le moindre accent.
  const encoded = params.get('payload');
  if (!encoded) {
    logger.warn('Slack interaction without a payload field');
    return jsonResponse({ error: 'missing_payload' }, 400);
  }

  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse(encoded) as SlackInteractionPayload;
  } catch (error) {
    logger.warn('Slack interaction payload is not valid JSON', { error });
    return jsonResponse({ error: 'invalid_payload' }, 400);
  }

  if (payload.type === 'block_actions') return handleBlockActions(payload);
  if (payload.type === 'view_submission') return handleViewSubmission(payload, c.get('mastra'));

  logger.debug('Slack interaction ignored', { type: payload.type });
  return ack();
}

export const slackInteractionsRoute = registerApiRoute(SLACK_INTERACTIONS_PATH, {
  method: 'POST',
  // OBLIGATOIRE : `server.auth` est actif (src/mastra/index.ts). Sans cette
  // ligne, chaque requête Slack prend un 401 et Slack finit par désactiver
  // l'endpoint — sans autre symptôme qu'une modale qui ne s'ouvre jamais.
  requiresAuth: false,
  openapi: {
    summary: 'Slack interactivity webhook',
    description:
      'Reçoit les interactions Slack (block_actions, view_submission). ' +
      'Signature HMAC-SHA256 vérifiée. Ouvre la modale de profil et valide sa soumission.',
    tags: ['slack'],
    responses: {
      200: { description: 'Interaction accusée (corps vide) ou erreurs de validation' },
      400: { description: 'Payload absent ou illisible' },
      401: { description: 'Signature Slack invalide, absente ou expirée' },
    },
  },
  handler: async (c) => handleSlackInteractionRequest(c as unknown as SlackInteractionsContext),
});
