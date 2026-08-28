import {
  INTERVIEW_SENT_REPLY,
  INTERVIEW_NOT_YOURS_REPLY,
  INTERVIEW_SEND_FAILED_REPLY,
  decodeInterviewConfirm,
  confirmFacts,
} from '../features/recruitment/infrastructure/handlers/interview-confirm';
import { parseInterviewSchedule } from '../features/recruitment/domain/value-objects/interview-schedule';
import { buildInterviewEmail } from '../features/recruitment/domain/services/interview-email';
import { createEmailProvider } from '../features/notification/infrastructure/providers/email-provider.factory';
import type { EmailProvider } from '../features/notification/domain/ports/providers';
import { textEmailBody } from '../features/notification/domain/services/email-body';
import { logger } from '../shared/logger';
import { replyInThread } from './slack-interaction-replies';
import { releaseCard, settleCard } from './interview-card';
import { type SlackInteractionPayload } from './slack-interaction-payload';

let cachedEmailProvider: EmailProvider | undefined;

function getEmailProvider(): EmailProvider {
  cachedEmailProvider ??= createEmailProvider();
  return cachedEmailProvider;
}

export function resetRecruitmentDependencies(): void {
  cachedEmailProvider = undefined;
}

export async function handleInterviewSend(
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

  const clicker = payload.user?.id ?? '';
  if (clicker !== confirm.requesterUserId) {
    logger.warn('Envoi d’entretien refusé — cliqueur différent du demandeur');
    releaseCard(payload);
    await replyInThread(payload, INTERVIEW_NOT_YOURS_REPLY);
    return;
  }

  const parsed = parseInterviewSchedule(confirm.startsAt, new Date());
  if (!parsed.ok) {
    logger.warn('Envoi d’entretien refusé — date invalide au clic', { reason: parsed.reason });
    const expired = "Cette date n'est plus valide — rien n'est parti. Redemande-moi l'invitation.";
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
    await getEmailProvider().sendEmail(confirm.to, email.subject, textEmailBody(email.body));
  } catch (error) {
    logger.error('Email d’entretien NON envoyé', { error: String(error) });
    releaseCard(payload);
    await replyInThread(payload, INTERVIEW_SEND_FAILED_REPLY);
    return;
  }

  logger.info('Invitation d’entretien envoyée', {
    recipientDomain: confirm.to.split('@')[1] ?? 'inconnu',
    when: parsed.schedule.at.toISOString(),
    hasPosition: Boolean(confirm.position),
    hasLocation: Boolean(confirm.location),
  });

  const sent = INTERVIEW_SENT_REPLY(confirm.to, parsed.schedule.humanReadable);
  await settleCard(payload, sent, confirmFacts(confirm, parsed.schedule.humanReadable));
  await replyInThread(payload, sent);
}
