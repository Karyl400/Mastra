import { textEmailBody, type EmailBody } from '../../../notification/domain/services/email-body';
import { readsAsNo, readsAsYes } from '../../../../shared/confirmation';
import { logger } from '../../../../shared/logger';
import { buildInterviewEmail } from '../../domain/services/interview-email';
import { parseInterviewSchedule } from '../../domain/value-objects/interview-schedule';
import {
  PENDING_EMAIL_TTL_MS,
  type PendingInterviewEmail,
} from '../../domain/ports/pending-email.repository';

export interface ConfirmPendingEmailDeps {
  readonly pending: {
    find(conversationId: string): Promise<PendingInterviewEmail | null>;
    save(pending: PendingInterviewEmail): Promise<void>;
    clear(conversationId: string): Promise<number>;
  };
  readonly sendEmail: (to: string, subject: string, body: EmailBody) => Promise<unknown>;
  readonly now?: () => Date;
}

export type ConfirmOutcome =
  | { readonly kind: 'sent'; readonly reply: string }
  | { readonly kind: 'cancelled'; readonly reply: string }
  | { readonly kind: 'not_yours'; readonly reply: string }
  | { readonly kind: 'expired'; readonly reply: string }
  | { readonly kind: 'failed'; readonly reply: string }
  | { readonly kind: 'already_settled'; readonly reply: string };

export const NOT_YOURS_REPLY =
  'Cet email a été préparé par quelqu’un d’autre — c’est à cette personne de le confirmer.';

export const CANCELLED_REPLY =
  'D’accord, je ne l’envoie pas. Rien n’est parti. Redemande-le-moi quand tu veux.';

export const SEND_FAILED_REPLY =
  'Je n’ai pas réussi à envoyer cet email — rien n’est parti. Réessaie dans un instant en me redisant « oui ».';

export const ALREADY_SETTLED_REPLY =
  'Cet email a déjà été tranché — il n’y a plus rien en attente de mon côté.';

export function expiredReply(): string {
  return 'Cette date n’est plus valide, donc rien n’est parti. Redemande-moi l’invitation avec une nouvelle date.';
}

export function sentReply(pending: PendingInterviewEmail, humanReadableDate: string): string {
  const nom = pending.candidateName?.trim();
  const qui = nom ? `${nom} (${pending.to})` : pending.to;
  return `C’est envoyé à *${qui}*, pour le *${humanReadableDate}*.`;
}

export function pendingReminder(pending: PendingInterviewEmail): string {
  const nom = pending.candidateName?.trim() || pending.to;
  return `_(Au fait : l’email d’entretien pour ${nom} attend toujours ton « oui » — ou ton « non ».)_`;
}

export function isPendingEmailStale(pending: PendingInterviewEmail, now: Date): boolean {
  return now.getTime() - pending.createdAt.getTime() > PENDING_EMAIL_TTL_MS;
}

export function staleReply(pending: PendingInterviewEmail): string {
  const nom = pending.candidateName?.trim() || pending.to;
  return `_(J’ai laissé tomber l’email d’entretien pour ${nom} — il attendait depuis plus d’un jour. Rien n’est parti. Redemande-le-moi si tu en as encore besoin.)_`;
}

export async function confirmPendingEmail(
  deps: ConfirmPendingEmailDeps,
  pending: PendingInterviewEmail,
  clickerUserId: string | undefined,
): Promise<ConfirmOutcome> {
  if (!clickerUserId || clickerUserId !== pending.requesterUserId) {
    logger.warn('Envoi d’entretien refusé — le répondant n’est pas le demandeur');
    return { kind: 'not_yours', reply: NOT_YOURS_REPLY };
  }

  const now = (deps.now ?? (() => new Date()))();

  const parsed = parseInterviewSchedule(pending.startsAt, now);
  if (!parsed.ok) {
    logger.warn('Envoi d’entretien refusé — date invalide au moment du oui', {
      reason: parsed.reason,
    });
    await deps.pending.clear(pending.conversationId);
    return { kind: 'expired', reply: expiredReply() };
  }

  const taken = await deps.pending.clear(pending.conversationId);
  if (taken === 0) {
    logger.info('Email d’entretien déjà tranché — second « oui » ignoré');
    return { kind: 'already_settled', reply: ALREADY_SETTLED_REPLY };
  }

  const email = buildInterviewEmail({
    candidateName: pending.candidateName ?? undefined,
    schedule: parsed.schedule,
    position: pending.position ?? undefined,
    location: pending.location ?? undefined,
    replyTo: pending.replyTo ?? undefined,
  });

  try {
    await deps.sendEmail(pending.to, email.subject, textEmailBody(email.body));
  } catch (error) {
    logger.error('Email d’entretien NON envoyé', { error: String(error) });
    await deps.pending.save(pending);
    return { kind: 'failed', reply: SEND_FAILED_REPLY };
  }

  logger.info('Invitation d’entretien envoyée', {
    recipientDomain: pending.to.split('@')[1] ?? 'inconnu',
    when: parsed.schedule.at.toISOString(),
    hasPosition: Boolean(pending.position),
    hasLocation: Boolean(pending.location),
  });

  return { kind: 'sent', reply: sentReply(pending, parsed.schedule.humanReadable) };
}

export type PendingEmailVerdict = 'stale' | 'deferred' | 'cancel' | 'send' | 'unrelated';

export function pendingEmailVerdict(input: {
  readonly pending: PendingInterviewEmail;
  readonly text: string;
  readonly onboardingQuestionPending: boolean;
  readonly now: Date;
}): PendingEmailVerdict {
  if (isPendingEmailStale(input.pending, input.now)) return 'stale';

  if (input.onboardingQuestionPending) return 'deferred';

  if (readsAsNo(input.text)) return 'cancel';
  if (readsAsYes(input.text)) return 'send';

  return 'unrelated';
}

export function settlesPendingEmail(verdict: PendingEmailVerdict): boolean {
  return verdict === 'cancel' || verdict === 'send';
}
