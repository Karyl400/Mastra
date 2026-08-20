import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { logger } from '../../../../shared/logger';
import { buildRunKey, makeRunGuard } from '../../../../shared/tool-idempotency';
import { canPerformSideEffects, readSlackContext } from '../../../../shared/slack-request-context';
import type { DirectoryRepository } from '../../../directory/domain/ports/directory.repository';
import { parseInterviewSchedule } from '../../domain/value-objects/interview-schedule';
import { buildInterviewEmail, checkInterviewLocation } from '../../domain/services/interview-email';
import type { InterviewConfirmationPresenter } from '../../domain/ports/interview-confirmation.presenter';
import type { PendingInterviewEmailRepository } from '../../domain/ports/pending-email.repository';
import { deriveConversationId } from '../../../conversation/domain/value-objects/conversation-id';

export interface ScheduleCandidateInterviewDeps {
  readonly chat: {
    sendText(channelId: string, text: string): Promise<unknown>;
  };
  readonly pending: PendingInterviewEmailRepository;
  readonly presenter: InterviewConfirmationPresenter;
  readonly directoryRepo?: Pick<DirectoryRepository, 'findBySlackUserId'>;
  readonly now?: () => Date;
}

const REFUSALS = {
  forbidden:
    "Tu n'as pas le droit d'écrire à l'extérieur au nom de l'entreprise. Dis-le simplement.",
  no_slack_context:
    'Cette action doit être demandée depuis Slack — je ne peux pas afficher la confirmation ailleurs.',
  invalid_date: "La date n'est pas lisible. Redemande-la, et n'en invente aucune.",
  date_in_past: 'Cette date est déjà passée. Vérifie le jour ET l’année, puis redemande.',
  date_too_far: 'Cette date est à plus d’un an. Vérifie l’année, puis redemande.',
  link_domain_not_allowed:
    "Ce lien de visio n'est pas d'un service reconnu, donc je ne l'envoie pas. Propose une adresse physique, ou un lien Meet, Zoom ou Teams.",
  post_failed: "Je n'ai pas pu afficher la confirmation. Rien n'a été envoyé.",
} as const;

const ALREADY_PREPARED_HINT =
  'Une invitation a déjà été préparée pour ce message. Dis-le simplement, et invite la personne à te redemander dans un message séparé pour un second candidat.';

export function makeScheduleCandidateInterview(deps: ScheduleCandidateInterviewDeps) {
  const now = deps.now ?? (() => new Date());
  const runGuard = makeRunGuard();

  return createTool({
    id: 'scheduleCandidateInterview',
    description:
      "Prépare l'email d'invitation à un entretien pour un candidat externe, et l'affiche pour confirmation. N'envoie rien lui-même.",
    inputSchema: z.object({
      candidateEmail: z.string().email().describe('Adresse du candidat.'),
      candidateName: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe(
          'Nom du candidat, UNIQUEMENT s’il a été donné. Ne le déduis jamais de l’adresse email.',
        ),
      startsAt: z
        .string()
        .describe(
          'Date et heure de l’entretien en ISO 8601, ex. 2026-08-20T14:00:00+01:00. Transcris ce qui a été dit, n’invente ni jour ni heure.',
        ),
      position: z.string().max(80).optional().describe('Poste concerné, si précisé.'),
      location: z
        .string()
        .max(200)
        .optional()
        .describe('Lieu physique ou lien de visio, si précisé.'),
    }),
    execute: async (data, ctx) => {
      const requestContext = (ctx as { requestContext?: unknown })?.requestContext;

      if (!canPerformSideEffects(requestContext)) {
        return { status: 'refused', reason: 'forbidden', hint: REFUSALS.forbidden };
      }

      const slack = readSlackContext(requestContext);
      if (!slack?.channel || !slack.slackUserId) {
        return { status: 'refused', reason: 'no_slack_context', hint: REFUSALS.no_slack_context };
      }

      const runKey = buildRunKey(slack.eventTs, 'scheduleCandidateInterview', []);
      if (runKey && runGuard.get(runKey)) {
        logger.warn('Invitation déjà préparée dans ce run — second appel ignoré', {
          recipientDomain: data.candidateEmail.split('@')[1] ?? 'inconnu',
        });
        return { status: 'refused', reason: 'already_prepared', hint: ALREADY_PREPARED_HINT };
      }

      const parsed = parseInterviewSchedule(data.startsAt, now());
      if (!parsed.ok) {
        return { status: 'refused', reason: parsed.reason, hint: REFUSALS[parsed.reason] };
      }

      const location = checkInterviewLocation(data.location);
      if (!location.ok) {
        logger.warn('Lien d’entretien refusé', { host: location.host });
        return {
          status: 'refused',
          reason: 'link_domain_not_allowed',
          hint: REFUSALS.link_domain_not_allowed,
        };
      }

      const replyTo = await resolveRequesterEmail(deps, slack.slackUserId);

      const email = buildInterviewEmail({
        candidateName: data.candidateName,
        schedule: parsed.schedule,
        position: data.position,
        location: data.location,
        replyTo,
      });

      try {
        const conversationId = deriveConversationId({
          channel: slack.channel,
          threadTs: slack.threadTs,
        });

        await deps.pending.save({
          conversationId,
          requesterUserId: slack.slackUserId,
          to: data.candidateEmail,
          candidateName: data.candidateName ?? null,
          startsAt: parsed.schedule.at.toISOString(),
          position: data.position ?? null,
          location: data.location ?? null,
          replyTo: replyTo ?? null,
          createdAt: (deps.now ?? (() => new Date()))(),
        });

        const texte = deps.presenter.buildConfirmationText({
          payload: {
            to: data.candidateEmail,
            candidateName: data.candidateName,
            startsAt: parsed.schedule.at.toISOString(),
            position: data.position,
            location: data.location,
            replyTo,
            requesterUserId: slack.slackUserId,
          },
          humanReadableDate: parsed.schedule.humanReadable,
          subject: email.subject,
          body: email.body,
        });

        await deps.chat.sendText(slack.channel, texte);
      } catch (error) {
        logger.error('Confirmation d’entretien non affichée', { error: String(error) });
        return { status: 'refused', reason: 'post_failed', hint: REFUSALS.post_failed };
      }

      if (runKey) runGuard.remember(runKey, true);

      return {
        status: 'awaiting_confirmation',
        recipient: data.candidateEmail,
        whenLabel: parsed.schedule.humanReadable,
        hint: "L'email complet et la question sont DÉJÀ sous les yeux de la personne. Réponds EXACTEMENT : « Dis-moi « oui » ou « non ». » Rien d'autre — ne répète pas l'email, ne le résume pas, et ne dis jamais qu'il est envoyé.",
      };
    },
  });
}

async function resolveRequesterEmail(
  deps: ScheduleCandidateInterviewDeps,
  slackUserId: string,
): Promise<string | undefined> {
  if (!deps.directoryRepo) return undefined;
  try {
    const member = await deps.directoryRepo.findBySlackUserId(slackUserId);
    return member?.email ?? undefined;
  } catch (error) {
    logger.warn('Adresse du demandeur non résolue', { error: String(error) });
    return undefined;
  }
}
