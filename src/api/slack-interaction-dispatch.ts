import {
  SEND_INTERVIEW_ACTION_ID,
  CANCEL_INTERVIEW_ACTION_ID,
  INTERVIEW_CANCELLED_REPLY,
} from '../features/recruitment/infrastructure/handlers/interview-confirm';
import { logger } from '../shared/logger';
import {
  ack,
  replyInThread,
  scheduleInteractionWork,
  tellNewcomer,
} from './slack-interaction-replies';
import { claimCard, settleCard } from './interview-card';
import { handleInterviewSend } from './interview-send.action';
import { answerProfileDone } from './profile-done.action';
import {
  decodeLegacyProfileButton,
  type SlackInteractionPayload,
} from './slack-interaction-payload';

const PROFILE_DONE_ACTION_ID = 'profile_done';

export async function handleBlockActions(payload: SlackInteractionPayload): Promise<Response> {
  const actions = payload.actions ?? [];

  const doneAction = actions.find((a) => a.action_id === PROFILE_DONE_ACTION_ID);
  if (doneAction) {
    const prefill = decodeLegacyProfileButton(doneAction.value, payload.user?.id ?? '');
    scheduleInteractionWork(
      'profile_done',
      answerProfileDone(prefill).catch((error: unknown) => {
        logger.error('Vérification « C’est fait » échouée', { error: String(error) });
      }),
    );
    return ack();
  }

  if (actions.some((a) => a.action_id === CANCEL_INTERVIEW_ACTION_ID)) {
    if (!claimCard(payload)) {
      logger.info('Carte d’entretien déjà tranchée — clic ignoré');
      return ack();
    }

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
    if (!claimCard(payload)) {
      logger.info('Carte d’entretien déjà tranchée — second clic ignoré');
      return ack();
    }

    scheduleInteractionWork(
      'interview_send',
      handleInterviewSend(payload, sendAction.value).catch((error: unknown) => {
        logger.error('Envoi d’entretien en tâche de fond échoué', { error: String(error) });
      }),
    );
    return ack();
  }

  logger.debug('block_actions sans action connue', {
    actions: actions.map((a) => a.action_id),
  });
  return ack();
}

const OBSOLETE_FORM_REPLY =
  'Ce formulaire ne fonctionne plus — je n’ai rien gardé de ce que tu viens de taper, désolé. ' +
  'On fait ça à l’écrit maintenant, c’est plus simple : écris-moi *« je veux compléter mon ' +
  'profil »* et je te guide, une question à la fois.';

export function handleViewSubmission(payload: SlackInteractionPayload): Response {
  logger.warn('Soumission reçue d’une modale supprimée — la personne est prévenue', {
    callbackId: payload.view?.callback_id ?? 'inconnu',
  });

  scheduleInteractionWork(
    'obsolete_form_submission',
    tellNewcomer(payload.user?.id, OBSOLETE_FORM_REPLY),
  );

  return ack();
}
