import { textEmailBody } from '../../../notification/domain/services/email-body';

import type { RenderedDocument } from '../../domain/ports/document-renderer';
import type {
  EmailProvider,
  FileUploadProvider,
} from '../../../notification/domain/ports/providers';
import { logger } from '../../../../shared/logger';
import { errorMessage } from '../../../../shared/errors';
import { slackErrorMentions } from '../../../../shared/slack/slack-error';
import type { DeliveryIntent, DeliveryOutcome, DeliveryVerdict, HintKey } from './document-hints';

export function isMissingScope(error: unknown): boolean {
  return slackErrorMentions(error, 'missing_scope') || slackErrorMentions(error, 'files:write');
}

export function toVerdict(sent: { ok: true } | { ok: false; reason: HintKey }): DeliveryOutcome {
  return sent.ok
    ? { delivery: 'email', reason: undefined }
    : { delivery: 'failed', reason: sent.reason };
}

async function deliverToSlack(params: {
  slackCtx: { channel: string; threadTs?: string };
  fileUpload: FileUploadProvider | undefined;
  emailProvider: EmailProvider | undefined;
  employeeEmail: string | null | undefined;
  title: string;
  rendered: RenderedDocument;
}): Promise<DeliveryOutcome> {
  const { slackCtx, fileUpload, emailProvider, employeeEmail, title, rendered } = params;

  try {
    const { permalink } = await uploadToSlack(fileUpload, slackCtx, rendered, title);
    logger.info('Document livré dans Slack', {
      channel: slackCtx.channel,
      filename: rendered.filename,
      hasPermalink: Boolean(permalink),
    });
    return { delivery: 'slack', reason: undefined };
  } catch (error: unknown) {
    const missingScope = isMissingScope(error);
    logger.error('Livraison Slack échouée', {
      channel: slackCtx.channel,
      missingScope,
      error: errorMessage(error),
    });

    const fallback = toVerdict(
      await deliverByEmail(emailProvider, employeeEmail ?? undefined, title, rendered),
    );
    if (fallback.delivery === 'email') return fallback;
    return { delivery: 'failed', reason: missingScope ? 'missing_scope' : fallback.reason };
  }
}

export async function deliver(params: {
  intent: DeliveryIntent;
  rendered: RenderedDocument | undefined;
  slackCtx: { channel: string; threadTs?: string } | undefined;
  fileUpload: FileUploadProvider | undefined;
  emailProvider: EmailProvider | undefined;
  employeeEmail: string | null | undefined;
  employeeId: string;
  title: string;
  failure: HintKey | undefined;
}): Promise<DeliveryOutcome> {
  const {
    intent: effectiveDeliverTo,
    rendered,
    slackCtx,
    fileUpload,
    emailProvider,
    employeeEmail,
    employeeId,
    title,
    failure,
  } = params;

  const delivery: DeliveryVerdict = 'none';
  const reason: HintKey | undefined = failure;

  if (!rendered || effectiveDeliverTo === 'none') return { delivery, reason };

  if (effectiveDeliverTo === 'email') {
    return toVerdict(
      await deliverByEmail(emailProvider, employeeEmail ?? undefined, title, rendered),
    );
  }

  if (!slackCtx) {
    logger.info('Pas de contexte Slack — document enregistré sans livraison', { employeeId });
    return { delivery: 'none', reason: 'no_slack_context' };
  }

  return await deliverToSlack({
    slackCtx,
    fileUpload,
    emailProvider,
    employeeEmail,
    title,
    rendered,
  });
}

async function uploadToSlack(
  fileUpload: FileUploadProvider | undefined,
  slackContext: { channel: string; threadTs?: string },
  rendered: RenderedDocument,
  title: string,
): Promise<{ permalink?: string }> {
  if (!fileUpload) throw new Error('Aucun fournisseur de fichiers câblé');

  return await fileUpload.uploadFile({
    channel: slackContext.channel,
    ...(slackContext.threadTs ? { threadTs: slackContext.threadTs } : {}),
    bytes: rendered.bytes,
    filename: rendered.filename,
    title,
  });
}

async function deliverByEmail(
  emailProvider: EmailProvider | undefined,
  to: string | undefined,
  title: string,
  rendered: RenderedDocument,
): Promise<{ ok: true } | { ok: false; reason: HintKey }> {
  if (!to) {
    logger.error('Livraison email impossible — aucune adresse dans l’annuaire');
    return { ok: false, reason: 'no_email' };
  }
  if (!emailProvider) {
    logger.error('Livraison email impossible — aucun fournisseur email câblé');
    return { ok: false, reason: 'delivery_failed' };
  }

  try {
    await emailProvider.sendEmail(to, title, textEmailBody(`Voici le document « ${title} ».`), [
      { filename: rendered.filename, bytes: rendered.bytes, mimeType: rendered.mimeType },
    ]);
    logger.info('Document livré par email', { filename: rendered.filename });
    return { ok: true };
  } catch (error: unknown) {
    logger.error('Livraison email échouée', { error: errorMessage(error) });
    return { ok: false, reason: 'delivery_failed' };
  }
}
