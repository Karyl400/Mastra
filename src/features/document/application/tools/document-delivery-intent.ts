import { logger } from '../../../../shared/logger';
import { buildRunKey } from '../../../../shared/tool-idempotency';
import { DocumentFormat, DocumentType } from '../../../../shared/types';
import type { DeliveryIntent } from './document-hints';

export function resolveDeliveryIntent(params: {
  slackCtx: { channel: string; threadTs?: string } | undefined;
  deliverTo: DeliveryIntent;
  employeeId: string;
  type: DocumentType;
  format: DocumentFormat;
  title: string;
  revisionFingerprint?: string;
}): { effectiveDeliverTo: DeliveryIntent; dedupKey: string | undefined } {
  const { slackCtx, title, employeeId } = params;
  const data = params;
  let conversationKey: string | undefined;
  if (slackCtx) {
    conversationKey = slackCtx.threadTs
      ? `${slackCtx.channel}:${slackCtx.threadTs}`
      : slackCtx.channel;
  }

  const effectiveDeliverTo =
    data.deliverTo === 'none' && slackCtx ? ('slack' as const) : data.deliverTo;

  if (effectiveDeliverTo !== data.deliverTo) {
    logger.info('deliverTo=none ignoré dans une conversation Slack — livraison dans le fil', {
      employeeId,
      type: data.type,
    });
  }

  const dedupKey = buildRunKey(conversationKey, 'generateDocument', [
    employeeId,
    data.type,
    title,
    data.format,
    effectiveDeliverTo,
    ...(params.revisionFingerprint ? [params.revisionFingerprint] : []),
  ]);

  return { effectiveDeliverTo, dedupKey };
}

export function warnIfForeignSubject(
  requesterId: string | undefined,
  subjectId: string,
  deliverTo: DeliveryIntent,
): void {
  if (!requesterId || requesterId === subjectId) {
    return;
  }
  logger.warn('Document produit pour une AUTRE personne que le demandeur', {
    subjectId,
    requesterId,
    deliverTo,
  });
}

export function resolveSubjectId(
  provided: string | undefined,
  slackCtx: { employeeId?: string } | undefined,
): string | undefined {
  return provided ?? slackCtx?.employeeId;
}

export function alreadyDeliveredResult(params: {
  previous: { result: Record<string, unknown>; eventTs?: string };
  slackCtx: { eventTs?: string } | undefined;
  employeeId: string;
  type: DocumentType;
  effectiveDeliverTo: DeliveryIntent;
}) {
  const { previous, slackCtx, employeeId, effectiveDeliverTo } = params;
  const data = params;

  const sameRun = Boolean(slackCtx?.eventTs) && previous.eventTs === slackCtx?.eventTs;
  logger.warn(
    sameRun
      ? 'Document déjà produit dans ce run — second appel ignoré'
      : 'Document déjà livré dans cette conversation — régénération évitée',
    { employeeId: employeeId, type: data.type, deliverTo: effectiveDeliverTo },
  );

  return {
    ...previous.result,
    alreadyDelivered: true as const,
    hint:
      "Ce document a DÉJÀ été produit et livré dans cette conversation ; rien n'a été " +
      "refait. Dis-le et renvoie la personne vers l'envoi précédent — ne prétends pas " +
      "l'avoir regénéré.",
  };
}
