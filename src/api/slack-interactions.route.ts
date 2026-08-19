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
 * ⚠️ PLUS AUCUNE MODALE DEPUIS LE 2026-08-19, et c'est une constatation, pas une
 * préférence. Un `trigger_id` Slack expire 3 secondes après le clic ; mesuré ce jour-là
 * sur un clic SIGNÉ en production, l'ACK de cette route mettait 5 229 ms à froid et
 * 9 173 ms sur un déploiement neuf. Le portier d'ACK (`scripts/slack-ack-function/`) a
 * ramené l'accusé sous la seconde, mais il ne peut pas sauver une modale : il répond vite
 * précisément parce qu'il ne connaît rien du produit, et la fenêtre s'ouvre ensuite, depuis
 * la fonction restée froide. Journaux à l'appui : `invalid_trigger_id`.
 *
 * Tous les boutons se contentent donc d'ACQUITTER, et le travail part en tâche de fond. Les
 * deux parcours qui ouvraient une fenêtre sont devenus CONVERSATIONNELS (`profile-chat.ts`,
 * `interview-chat.ts`).
 *
 * ⚠️ Le traitement de `view_submission` est CONSERVÉ mais devenu INATTEIGNABLE : plus aucun
 * bouton n'ouvre de vue, donc Slack n'en enverra plus. Il est laissé en place le temps d'un
 * lot dédié — le retirer emporte `profile-modal.ts`, `interview-modal.ts` et
 * `applyInterview`, c'est-à-dire l'invitation aux canaux, et cela ne se fait pas dans le même
 * commit qu'un parcours neuf. Voir `TODO.md`.
 */
import { registerApiRoute } from '@mastra/core/server';
import type { Mastra } from '@mastra/core';

import { SlackAdapter } from '../features/notification/infrastructure/providers/slack.adapter';
/**
 * ⚠️ IDENTIFIANT HÉRITÉ — plus AUCUN émetteur depuis le 2026-08-19.
 *
 * Les boutons ont été retirés du parcours : le propriétaire a signalé deux fois qu'ils ne
 * fonctionnaient pas sous un vrai clic humain, alors que les sondes signées mesuraient des ACK
 * de 393 à 1 473 ms. On a supprimé la DÉPENDANCE plutôt que de rejouer la mesure.
 *
 * Cette branche est CONSERVÉE, et ce n'est pas du code mort : les messages déjà postés dans
 * Slack portent encore leur bouton, indéfiniment. Quelqu'un qui remonte son fil et clique doit
 * obtenir la vérification de son dossier — pas un `block_actions sans action connue`, c'est-à-
 * dire un clic sans effet et sans trace. La constante vit ici parce que c'est désormais son
 * unique consommateur.
 */
const PROFILE_DONE_ACTION_ID = 'profile_done';

import { verifyProfile } from '../features/onboarding/domain/services/profile-completion';
import { INTERVIEW_QUESTION_DAILY } from '../features/onboarding/domain/services/interview-chat';
import { DrizzleEmployeeRepository } from '../features/employee/infrastructure/repositories/drizzle-employee.repository';
import {
  PROFILE_MODAL_CALLBACK_ID,
  decodePrefill,
  errorsByBlockId,
  profileSubmissionSchema,
  readProfileSubmission,
  startDateFromJoin,
  type ProfileModalPrefill,
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
import { runOnboarding } from '../features/onboarding/application/services/run-onboarding';
import { parseInterviewSchedule } from '../features/recruitment/domain/value-objects/interview-schedule';
import { buildInterviewEmail } from '../features/recruitment/domain/services/interview-email';
import { createEmailProvider } from '../features/notification/infrastructure/providers/email-provider.factory';
import type { EmailProvider } from '../features/notification/domain/ports/providers';
import {
  INTERVIEW_MODAL_CALLBACK_ID,
  decodeInterviewPrefill,
  interviewSubmissionSchema,
  readInterviewSubmission,
  type ValidatedInterview,
} from '../features/notification/infrastructure/handlers/interview-modal';
import { DrizzleOnboardingInterviewRepository } from '../features/onboarding/infrastructure/repositories/drizzle-onboarding-interview.repository';
import { SlackWorkspaceService } from '../features/notification/infrastructure/providers/slack-workspace.service';
import {
  interviewDoneReply,
  INTERVIEW_FAILED_REPLY,
} from '../features/notification/infrastructure/handlers/interview-invite';
import { scheduleBackgroundWork } from './slack-events.route';
import { verifySlackSignature } from '../shared/security/slack-signature';
import { logger } from '../shared/logger';
import { DrizzleConversationRepository } from '../features/conversation/infrastructure/repositories/drizzle-conversation.repository';
import { deriveConversationId } from '../features/conversation/domain/value-objects/conversation-id';
import { DEFAULT_AGENT_ID } from '../features/notification/domain/services/agent-routing';

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
  const actions = payload.actions ?? [];

  // ── « C'EST FAIT » — le nouveau point d'entrée du parcours, 2026-08-19 ────
  //
  // ⚠️ TRAITÉ EN PREMIER, et surtout AVANT la garde `trigger_id` : il n'ouvre aucune modale,
  // donc il n'en a pas besoin. C'est toute sa raison d'être. Un `trigger_id` expire 3 s après
  // le clic ; le démarrage à froid de cette fonction a été mesuré à 4,9 s le 2026-08-18, et
  // jusqu'à 16 s après une longue inactivité — c'est-à-dire le cas d'un ARRIVANT, qui est
  // par définition le premier à écrire de la journée. Faire dépendre le premier geste de
  // l'accueil d'un `trigger_id` revenait à le faire échouer systématiquement.
  //
  // ACK immédiat, ZÉRO E/S ici : la vérification en base et la réponse partent en tâche de
  // fond. Au pire la réponse arrive quelques secondes plus tard, ce qui est le comportement
  // normal d'une conversation — jamais une erreur affichée par Slack.
  const doneAction = actions.find((a) => a.action_id === PROFILE_DONE_ACTION_ID);
  if (doneAction) {
    const prefill = decodePrefill(doneAction.value, payload.user?.id ?? '');
    scheduleInteractionWork(
      'profile_done',
      answerProfileDone(prefill).catch((error: unknown) => {
        logger.error('Vérification « C’est fait » échouée', { error: String(error) });
      }),
    );
    return ack();
  }

  // ── Recrutement : les deux boutons de la carte de confirmation ─────────────
  // Ils n'ouvrent aucune modale, donc rien ne doit les faire dépendre d'un `trigger_id`.
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

  // ⚠️ PLUS AUCUNE MODALE — 2026-08-19, et c'est une constatation, pas une préférence.
  //
  // Les deux boutons qui en ouvraient une (« Compléter mon profil », « Parlons de toi »)
  // dépendaient d'un `trigger_id` valable 3 secondes. Mesuré ce jour-là sur un clic SIGNÉ en
  // production : l'ACK mettait 5 229 ms à froid, 9 173 ms sur un déploiement neuf. Le portier
  // d'ACK (`scripts/slack-ack-function/`) a ramené l'accusé sous la seconde, mais il ne peut
  // pas sauver une modale : il répond vite parce qu'il ne connaît rien du produit, et
  // l'ouverture a lieu ensuite, dans la fonction restée froide. Journaux à l'appui :
  // `Unable to open the profile modal … invalid_trigger_id`.
  //
  // Les deux parcours sont désormais CONVERSATIONNELS (`profile-chat.ts`, `interview-chat.ts`)
  // : zéro token, zéro `trigger_id`, et rien à ouvrir dans les trois secondes.
  //
  // ⚠️ `trigger_id` n'est plus lu nulle part ici. Le laisser en garde d'entrée ferait échouer
  // des boutons qui n'en ont aucun besoin — la faute déjà corrigée pour « Envoyer » et
  // « Annuler ».
  logger.debug('block_actions sans action connue', {
    actions: actions.map((a) => a.action_id),
  });
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
    // ⚠️ JAMAIS dans un DM, et c'est une règle établie de ce dépôt : threader un DM enfouit
    // le message hors de la conversation principale, ce qui a déjà fait paraître ce bot muet
    // pendant des heures. `resolveThreadTarget`, côté handler d'événements, applique
    // exactement le même critère — un canal `D…` EST la conversation, il n'y a rien à
    // threader. En canal, en revanche, la confirmation doit rester attachée à la carte
    // qu'elle confirme.
    const isDirectMessage = channel.startsWith('D');
    const threadTs = isDirectMessage
      ? undefined
      : (payload.message?.thread_ts ?? payload.message?.ts);
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
/**
 * Dépôt employé, construit PARESSEUSEMENT — même raison que `interviewRepo` plus bas : ce
 * module est évalué au chargement, donc sur le chemin de l'ACK. Ouvrir une connexion Turso à
 * l'import y ajouterait le handshake complet.
 */
let cachedEmployeeRepo: DrizzleEmployeeRepository | undefined;
function employeeRepo(): DrizzleEmployeeRepository {
  cachedEmployeeRepo ??= new DrizzleEmployeeRepository();
  return cachedEmployeeRepo;
}

/**
 * Répond à « C'est fait » : on REGARDE la base, et on ne dit que ce qu'on y a vu.
 *
 * ⚠️ La résolution se fait par EMAIL, la seule clé que Slack nous donne et que `employees`
 * porte aussi — il n'existe aucune colonne `slack_user_id` dans cette table. Une adresse
 * absente du profil Slack rend donc `null`, ce qui est traité comme « aucun dossier » : c'est
 * exact, on n'a effectivement rien pu constater, et la réponse propose le formulaire.
 *
 * ⚠️ La note d'échec ne prétend JAMAIS que la vérification a réussi. Une base indisponible
 * n'est pas un dossier incomplet, et confondre les deux dirait à un arrivant que son dossier
 * est en défaut alors que c'est le nôtre.
 */
async function answerProfileDone(prefill: ProfileModalPrefill): Promise<void> {
  const email = prefill.email?.trim();
  const employee = email ? await employeeRepo().findByEmail(email) : null;
  const verdict = verifyProfile(employee);

  logger.info('« C’est fait » vérifié', {
    slackUserId: prefill.slackUserId,
    complete: verdict.complete,
    missing: verdict.missing.length,
  });

  // ⚠️ UN SEUL CHEMIN DEPUIS LE 2026-08-19, et c'est la disparition de la dernière modale du
  // produit. Le cas incomplet posait ici un bouton « Compléter mon profil » ouvrant une
  // fenêtre ; elle ne s'ouvrait jamais. Un `trigger_id` expire 3 secondes après le clic, et le
  // démarrage à froid de la fonction applicative a été mesuré à 5,2 s ce jour-là, sur un clic
  // signé en production. Le portier d'ACK a ramené l'accusé de réception sous la seconde, mais
  // il ne peut pas sauver une modale : il répond vite précisément parce qu'il ne connaît rien
  // du produit, et l'ouverture a lieu ensuite, dans la fonction restée froide. Journaux à
  // l'appui : `Unable to open the profile modal … invalid_trigger_id`.
  //
  // `verdict.reply` porte donc, dans TOUS les cas, la question suivante — celle de l'entretien
  // quand le dossier est complet, celle du premier champ manquant sinon. Les deux machines à
  // états lisent le même endroit : le dernier tour `assistant` du fil.
  await rememberAsked(prefill.slackUserId, verdict.reply);
}

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
 * Lance le workflow d'intégration pour une soumission de MODALE.
 *
 * ⚠️ La règle elle-même a été extraite le 2026-08-19 dans
 * `onboarding/application/services/run-onboarding.ts` : depuis que le dossier peut aussi se
 * remplir EN CONVERSATION (`profile-chat.ts` — une modale ne s'ouvre pas sur ce déploiement,
 * mesuré), il y a deux appelants pour un même geste. Ce dépôt a déjà payé cette
 * configuration : deux chemins vers le formulaire de profil avaient divergé en un jour.
 *
 * Ne reste ici que ce qui est PROPRE à ce chemin : comment parler à la personne, et le fait
 * d'enchaîner sur l'entretien.
 */
async function runOnboardingFromModal(
  mastra: Mastra,
  profile: ValidatedProfile,
  startDate: string,
  slackUserId: string | undefined,
): Promise<void> {
  await runOnboarding(
    {
      getWorkflow: (key) => mastra.getWorkflow(key as never),
      notify: (text) => tellNewcomer(slackUserId, text),
      onRecordReady: (employeeId) => offerInterview(employeeId, slackUserId),
    },
    profile,
    startDate,
  );
}
/**
 * Pose la première question de l'entretien ET la MÉMORISE.
 *
 * ⚠️ LES DEUX SONT INDISSOCIABLES, et l'oublier a cassé la fonctionnalité à sa première mise
 * en production le 2026-08-19. L'état de l'entretien conversationnel EST le dernier tour
 * `assistant` du fil : une question posée sans être écrite dans `conversation_turns` est
 * invisible pour `pendingInterviewStep`, donc la réponse de la personne part chez l'agent au
 * lieu d'être capturée. Le symptôme trompe — la question s'affiche parfaitement, seule la
 * suite se perd.
 *
 * ⚠️ La clé de conversation est le canal `D…` RENDU PAR SLACK, jamais le `U…` qu'on lui a
 * passé : `chat.postMessage` accepte un identifiant d'utilisateur et ouvre lui-même le DM.
 * Écrire la mémoire sous `U…` la rendrait introuvable pour le handler, qui ne voit que `D…`.
 *
 * Ne LÈVE jamais : la mémoire est un CONFORT dans tout ce dépôt, elle dégrade en silence.
 * Sans elle, la question reste posée et la réponse part chez l'agent — dégradé, pas cassé.
 */
async function askInterviewQuestion(slackUserId: string): Promise<void> {
  await rememberAsked(slackUserId, INTERVIEW_QUESTION_DAILY);
}

/** Poste un texte en DM et l'inscrit dans la mémoire du fil — voir ci-dessus. */
async function rememberAsked(slackUserId: string | undefined, text: string): Promise<void> {
  if (!slackUserId) return;
  const { channel } = await getSlackInteractionsAdapter().sendMessage(slackUserId, text);

  try {
    await conversationRepo().append({
      conversationId: deriveConversationId({ channel }),
      role: 'assistant',
      content: text,
      agentId: DEFAULT_AGENT_ID,
      slackUserId: null,
    });
  } catch (error) {
    logger.error('Question d’entretien posée mais non mémorisée — la réponse ira à l’agent', {
      error: String(error),
    });
  }
}

let cachedConversationRepo: DrizzleConversationRepository | undefined;
function conversationRepo(): DrizzleConversationRepository {
  cachedConversationRepo ??= new DrizzleConversationRepository();
  return cachedConversationRepo;
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
    // ⚠️ PLUS DE BOUTON, PLUS DE MODALE — 2026-08-19. On pose simplement la première question.
    //
    // Le bouton « Parlons de toi » ouvrait une modale, donc dépendait d'un `trigger_id` qui
    // expire 3 secondes après le clic. Le démarrage à froid de cette fonction a été mesuré à
    // 4,9 s le 2026-08-18, et jusqu'à 16 s après une longue inactivité — c'est-à-dire dans la
    // situation exacte d'un arrivant, qui est par définition le premier à écrire de la
    // journée. Le bouton ne pouvait pas fonctionner, et son échec était muet : Slack affiche
    // une erreur générique, rien n'atteint ces logs.
    //
    // Un message écrit n'a aucune contrainte de ce type. La suite de l'échange est reconnue
    // par `pendingInterviewStep`, qui relit le dernier tour du bot — aucun état stocké, aucune
    // lecture supplémentaire, et ZÉRO token : les deux questions sont des constantes.
    //
    // ⚠️ L'inventaire des canaux n'est PLUS lu ici. Il ne servait qu'à remplir le
    // `multi_static_select` de la modale, et le lire pour rien coûterait une requête Turso à
    // chaque arrivée. L'invitation aux canaux reste servie par la modale tant qu'elle existe
    // (`applyInterview`), et par `ONBOARDING_WELCOME_CHANNELS` au `team_join`.
    await askInterviewQuestion(slackUserId);

    logger.info('Interview started as a conversation', { employeeId });
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
  const work = runOnboardingFromModal(mastra, parsed.data, startDate, prefill.slackUserId).catch(
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

function workspace(): SlackWorkspaceService {
  cachedWorkspace ??= new SlackWorkspaceService(process.env.SLACK_BOT_TOKEN ?? '');
  return cachedWorkspace;
}

/** Réinitialise les singletons (tests). */
export function resetInterviewDependencies(): void {
  cachedInterviewRepo = undefined;
  cachedWorkspace = undefined;
}

/*
 * ⚠️ `offerableChannels()` a été SUPPRIMÉE le 2026-08-19, avec le bouton qui l'appelait.
 *
 * Elle ne servait qu'à remplir le `multi_static_select` de la modale « Parlons de toi », et
 * cette modale a été retirée du parcours parce qu'elle NE S'OUVRAIT PAS : un `trigger_id`
 * expire 3 secondes après le clic, et le démarrage à froid de cette fonction a été mesuré à
 * 4,9 s — jusqu'à 16 s après une longue inactivité, c'est-à-dire exactement la situation d'un
 * arrivant. L'entretien est désormais un échange écrit (`interview-chat.ts`).
 *
 * ⚠️ CE QUE CELA COÛTE, et il faut le dire plutôt que de le laisser découvrir : le choix des
 * canaux ne fait plus partie de l'entretien. L'invitation automatique subsiste au `team_join`
 * via `ONBOARDING_WELCOME_CHANNELS`, et `handleInterviewSubmission` reste câblé — les boutons
 * déjà postés dans les DM continuent de fonctionner, leur `value` transportant la liste. Mais
 * aucun NOUVEAU bouton n'en propose. C'est une capacité en moins, assumée : elle valait moins
 * qu'un accueil qui échoue à sa première étape.
 *
 * Les deux filtres qu'elle portait restent vrais et sont conservés ici pour qui la
 * réintroduirait : `!isArchived` (26 des 32 canaux de l'inventaire le sont, en proposer un
 * garantit un échec d'invitation) et `isMember` (`conversations.invite` échoue si le bot n'est
 * pas lui-même dans le canal — condition de FAISABILITÉ, distincte du droit du demandeur).
 */

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

/**
 * Le chemin INTERNE, où le portier d'ACK rejoue la requête. Voir `SLACK_EVENTS_WORK_PATH`
 * pour le raisonnement complet — en deux mots : la même route, la même vérification de
 * signature, un chemin distinct pour que le routage Vercel ne boucle pas sur lui-même.
 */
export const SLACK_INTERACTIONS_WORK_PATH = '/internal/slack/interactions';

function slackInteractionsRouteAt(path: string) {
  return registerApiRoute(path, {
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
}

export const slackInteractionsRoute = slackInteractionsRouteAt(SLACK_INTERACTIONS_PATH);
export const slackInteractionsWorkRoute = slackInteractionsRouteAt(SLACK_INTERACTIONS_WORK_PATH);
