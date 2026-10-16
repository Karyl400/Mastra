import { logger } from '../../../../shared/logger';
import type { ConversationTurn } from '../../../conversation/domain/entities/conversation-turn';
import {
  PROFILE_CHAT_SAVE_FAILED,
  PROFILE_QUESTIONS,
  captureProfileAnswer,
  collectProfileAnswers,
  nextProfileStep,
  pendingProfileStep,
  profileRetryReply,
  type ProfileAnswers,
  type ProfileStep,
} from '../../../onboarding/domain/services/profile-chat';
import { INTERVIEW_QUESTION_DAILY } from '../../../onboarding/domain/services/interview-chat';
import { runOnboarding } from '../../../onboarding/application/services/run-onboarding';
import { startDateFromJoin } from '../../../onboarding/domain/services/newcomer-identity';
import type { SlackHandlerInternals } from './handler-internals';
import { sayAndRemember } from './conversation-memory';
import { answersOnboardingQuestion, lastAssistantText } from './onboarding-turn-state';
import { joinedAtOf, knownProfileAnswers } from './profile-record';
import { warnManagersOfTopRoleClaim } from './top-role-claim-notice';

export interface ProfileStepInput {
  history: readonly ConversationTurn[];
  isDirectMessage: boolean;
  text: string;
  channel: string;
  threadTs: string | undefined;
  conversationId: string;
  user: string | undefined;
}

export async function maybeRunProfileStep(
  self: SlackHandlerInternals,
  input: ProfileStepInput,
): Promise<boolean> {
  if (!answersOnboardingQuestion(input)) return false;

  const step = pendingProfileStep(lastAssistantText(input.history));
  if (!step) return false;

  await runProfileStep(self, { ...input, step });
  return true;
}

async function runProfileStep(
  self: SlackHandlerInternals,
  input: ProfileStepInput & { step: ProfileStep },
): Promise<void> {
  const { step, history, text, channel, user } = input;

  const value = captureProfileAnswer(step, text);
  if (!value) {
    await sayAndRemember(self, input, profileRetryReply(step));
    return;
  }

  const known = await knownProfileAnswers(self, user);
  const answers = { ...known, ...collectProfileAnswers(history), [step]: value };
  const next = nextProfileStep(answers);

  if (next) {
    logger.info(`Dossier en conversation (${step} reçu) — aucun appel de modele`, { channel });
    await sayAndRemember(self, input, PROFILE_QUESTIONS[next]);
    return;
  }

  logger.info('Dossier complet en conversation — lancement du workflow', { channel });
  await submitProfile(self, input, answers as Required<ProfileAnswers>);
}

export async function submitProfile(
  self: SlackHandlerInternals,
  input: {
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
  },
  answers: Required<ProfileAnswers>,
): Promise<void> {
  try {
    await runOnboarding(
      {
        getWorkflow: (key) => self.mastra.getWorkflow(key as never),
        notify: (text) => sayAndRemember(self, input, text),
        onRecordReady: async (employeeId) => {
          await linkRequesterToRecord(self, input.user, employeeId);
          const claim = await warnManagersOfTopRoleClaim(self, input.user, answers.position);
          if (claim) await sayAndRemember(self, input, claim);
          await sayAndRemember(self, input, INTERVIEW_QUESTION_DAILY);
        },
      },
      answers,
      startDateFromJoin(await joinedAtOf(self, input.user), new Date()),
    );
  } catch (error) {
    logger.error('Enregistrement du dossier en conversation impossible', {
      error: String(error),
    });
    await sayAndRemember(self, input, PROFILE_CHAT_SAVE_FAILED);
  }
}

export async function linkRequesterToRecord(
  self: SlackHandlerInternals,
  slackUserId: string | undefined,
  employeeId: string | undefined,
): Promise<void> {
  if (!slackUserId || !employeeId) return;

  try {
    const directory = self.getDirectoryRepo();

    if (!directory) {
      logger.error('Annuaire NON relié — aucun dépôt d’annuaire n’est câblé', {
        reason: 'no_directory_repository',
        slackUserId,
        employeeId,
      });
      return;
    }

    const linked = await directory.linkEmployee(slackUserId, employeeId);
    self.requesterNames.delete(slackUserId);

    if (linked === 0) {
      logger.error('Annuaire NON relié — aucune ligne pour cette personne', {
        reason: 'no_directory_row',
        slackUserId,
        employeeId,
      });
      return;
    }

    logger.info('Annuaire relié au dossier', { slackUserId, employeeId });
  } catch (error) {
    logger.error('Annuaire NON relié — l’entretien et la frontière d’accès en dépendent', {
      slackUserId,
      employeeId,
      error: String(error),
    });
  }
}
