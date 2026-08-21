import { textEmailBody } from '../../../notification/domain/services/email-body';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { DocumentRepository } from '../../domain/ports/document.repository';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type {
  DocumentRenderInput,
  DocumentRenderer,
  RenderedDocument,
} from '../../domain/ports/document-renderer';
import type {
  EmailProvider,
  FileUploadProvider,
} from '../../../notification/domain/ports/providers';
import { createDocument, type Document } from '../../domain/entities/document';
import { DEFAULT_TITLES } from '../../domain/services/document-template';
import { uuidSchema } from '../../../../shared/validation';
import { fullName } from '../../../../shared/name-matching';
import {
  sanitizeDocumentSource,
  sanitizeDocumentText,
} from '../../../../shared/security/agent-output';
import { logger } from '../../../../shared/logger';
import {
  readSlackContext,
  canReadPersonRecord,
  writeDocumentRecipient,
} from '../../../../shared/slack-request-context';
import type { OnboardingInterviewRepository } from '../../../onboarding/domain/ports/onboarding-interview.repository';
import { buildRunKey, makeRunGuard } from '../../../../shared/tool-idempotency';
import { DocumentFormat, DocumentStatus, DocumentType } from '../../../../shared/types';
import { errorMessage } from '../../../../shared/errors';

type DeliveryVerdict = 'slack' | 'email' | 'none' | 'failed';

const HINTS = {
  document_not_found:
    "Aucun document de ce type n'existe encore pour cette personne : RIEN n'a été corrigé et " +
    "rien n'a été créé. Ne prétends pas avoir corrigé. Rappelle le tool sans `revises` pour " +
    'en produire un.',
  employee_not_found:
    "Aucun employé ne porte cet identifiant : rien n'a été généré. Ne l'invente pas, demande " +
    "l'email de la personne et passe par findEmployeeByEmail.",
  no_slack_context:
    "Aucun canal Slack connu ici : le document est enregistré mais n'a été envoyé nulle part. " +
    'Dis-le, ne promets aucun envoi.',
  missing_scope:
    "Le bot n'a pas le droit d'envoyer des fichiers dans Slack : document enregistré, non livré. " +
    'Dis-le simplement, sans lien ni pièce jointe promise.',
  no_email:
    'Aucune adresse email connue pour cet employé : document enregistré, non envoyé. Dis-le.',
  delivery_failed:
    "L'envoi a échoué : le document est prêt et enregistré, mais non livré. Dis-le, et ne " +
    'propose aucun lien de téléchargement.',
  not_rendered:
    "Aucun fichier n'a pu être produit : seul le texte est enregistré. Dis que le document " +
    "existe mais qu'aucun fichier n'a été envoyé.",
  not_authorized:
    "Tu n'as pas le droit de produire un document au nom de cette personne. Dis-le simplement, " +
    'sans inventer de motif. Ne réessaie pas avec un autre outil et ne reformule pas la demande.',
} as const;

type HintKey = keyof typeof HINTS;

function isMissingScope(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth++) {
    const data = (current as { data?: { error?: unknown } }).data;
    if (typeof data?.error === 'string' && data.error === 'missing_scope') return true;

    const message = current instanceof Error ? current.message : '';
    if (message.includes('missing_scope') || message.includes('files:write')) return true;

    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface GenerateDocumentDeps {
  documentRepo: DocumentRepository;
  employeeRepo: EmployeeRepository;
  renderers: readonly DocumentRenderer[];
  fileUpload?: FileUploadProvider;
  emailProvider?: EmailProvider;
  interviewRepo?: OnboardingInterviewRepository;
  channelRepo?: { listChannels(): Promise<ReadonlyArray<{ channelId: string; name: string }>> };
}

const RENDERABLE_FORMATS = [DocumentFormat.Pdf, DocumentFormat.Docx] as const;

async function readInterview(
  interviewRepo: OnboardingInterviewRepository | undefined,
  channelRepo:
    { listChannels(): Promise<ReadonlyArray<{ channelId: string; name: string }>> } | undefined,
  employeeId: string,
): Promise<DocumentRenderInput['interview']> {
  if (!interviewRepo) return undefined;

  try {
    const interview = await interviewRepo.findByEmployee(employeeId);
    if (!interview) return undefined;

    let channels: string[] = [];
    if (channelRepo && interview.channels.length > 0) {
      const nameOf = new Map(
        (await channelRepo.listChannels()).map((channel) => [channel.channelId, channel.name]),
      );
      channels = interview.channels
        .map((channelId) => nameOf.get(channelId))
        .filter((name): name is string => Boolean(name && name.length > 0));
    }

    return { dailyWork: interview.dailyWork, workStyle: interview.workStyle, channels };
  } catch (error) {
    logger.warn('Entretien indisponible — document produit sans sa matière personnelle', {
      error: errorMessage(error),
    });
    return undefined;
  }
}

function revisionFingerprintOf(revises: boolean | undefined, content: string): string | undefined {
  return revises ? `revise:${fingerprint(content)}` : undefined;
}

function fingerprint(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i += 1) {
    hash = (hash * 31 + content.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function byMostRecentlyUpdated(a: Document, b: Document): number {
  if (a.updatedAt === b.updatedAt) return 0;
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

async function resolveRevisionTarget(
  documentRepo: DocumentRepository,
  revises: boolean | undefined,
  employeeId: string,
  type: DocumentType,
): Promise<{ refused: false; target?: { id: string; createdAt: string } } | { refused: true }> {
  if (!revises) return { refused: false };

  const all = await documentRepo.findByEmployee(employeeId);
  const latest = all.filter((d) => d.type === type).sort(byMostRecentlyUpdated)[0];

  if (!latest) {
    logger.warn('Correction refusée — aucun document de ce type pour cette personne', {
      employeeId,
      type,
    });
    return { refused: true };
  }

  return { refused: false, target: { id: latest.id, createdAt: latest.createdAt } };
}

async function persistDocument(
  documentRepo: DocumentRepository,
  params: {
    revised: { id: string; createdAt: string } | undefined;
    employeeId: string;
    type: DocumentType;
    title: string;
    content: string;
    format: DocumentFormat;
  },
): Promise<Document> {
  const { revised } = params;

  const doc = createDocument({
    id: revised?.id ?? crypto.randomUUID(),
    employeeId: params.employeeId,
    type: params.type,
    title: params.title,
    content: params.content,
    format: params.format,
  });

  const now = new Date().toISOString();
  const generated: Document = {
    ...doc,
    createdAt: revised ? revised.createdAt : doc.createdAt,
    status: DocumentStatus.Generated,
    generatedAt: now,
    updatedAt: now,
  };

  if (revised) await documentRepo.update(generated);
  else await documentRepo.save(generated);

  logger.info(revised ? 'Document corrigé' : 'Document généré', {
    id: generated.id,
    format: params.format,
  });

  return generated;
}

async function markDeliveryOutcome(
  documentRepo: DocumentRepository,
  generated: Document,
  delivery: DeliveryVerdict,
): Promise<void> {
  if (delivery !== 'slack' && delivery !== 'email') return;

  try {
    await documentRepo.update({
      ...generated,
      status: DocumentStatus.Sent,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Document livré mais statut non mis à jour', {
      id: generated.id,
      delivery,
      error: errorMessage(error),
    });
  }
}

export function makeGenerateDocument(deps: GenerateDocumentDeps) {
  const {
    documentRepo,
    employeeRepo,
    renderers,
    fileUpload,
    emailProvider,
    interviewRepo,
    channelRepo,
  } = deps;

  const runGuard = makeRunGuard();

  return createTool({
    id: 'generateDocument',
    description: 'Génère un document (guide, contrat, lettre…) et le livre dans Slack ou par email',
    inputSchema: z.object({
      employeeId: uuidSchema.optional().describe('UUID annuaire — omets-le pour le demandeur'),
      type: z.nativeEnum(DocumentType),
      title: z.string().min(1).max(200).describe('rédige-le, ne le demande pas'),
      content: z
        .string()
        .min(1)
        .max(20000)
        .describe(
          'Le texte du document, que TU rédiges toi-même. Ne le demande JAMAIS à la personne : le rédiger EST le travail attendu ici.',
        ),
      format: z.enum(RENDERABLE_FORMATS).optional().default(DocumentFormat.Pdf),
      deliverTo: z.enum(['slack', 'email', 'none']).optional().default('slack'),
      revises: z
        .boolean()
        .optional()
        .describe(
          'true pour CORRIGER le dernier document de ce type déjà produit pour cette personne, au lieu d’en créer un second.',
        ),
    }),
    execute: async (data, ctx) => {
      const slackCtx = readSlackContext(ctx?.requestContext);
      const employeeId = resolveSubjectId(data.employeeId, slackCtx);

      if (!employeeId) return NO_SUBJECT_RESULT;

      const { title, content } = sanitizeDocumentInput({
        title: data.title,
        content: data.content,
        type: data.type,
        employeeId,
      });

      logger.info('Génération document', {
        employeeId,
        type: data.type,
        title,
        format: data.format,
        deliverTo: data.deliverTo,
      });

      const { effectiveDeliverTo, dedupKey } = resolveDeliveryIntent({
        slackCtx,
        deliverTo: data.deliverTo,
        employeeId,
        type: data.type,
        format: data.format,
        title,
        revisionFingerprint: revisionFingerprintOf(data.revises, content),
      });

      if (!canReadPersonRecord(ctx?.requestContext, employeeId)) {
        logger.warn('Document refusé — demandeur non autorisé pour cette personne', {
          employeeId,
        });
        return {
          saved: false as const,
          delivery: 'none' as DeliveryVerdict,
          reason: 'not_authorized',
          hint: HINTS.not_authorized,
        };
      }

      const previous = dedupKey
        ? runGuard.get<{ result: Record<string, unknown>; eventTs?: string }>(dedupKey)
        : undefined;

      if (previous) {
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

      const employee = await employeeRepo.findById(employeeId);
      if (!employee) {
        logger.warn('Document refusé — aucun employé pour cet identifiant', {
          employeeId,
        });
        return {
          saved: false as const,
          delivery: 'none' as DeliveryVerdict,
          reason: 'employee_not_found',
          hint: HINTS.employee_not_found,
        };
      }

      const revision = await resolveRevisionTarget(
        documentRepo,
        data.revises,
        employeeId,
        data.type,
      );
      if (revision.refused) {
        return {
          saved: false as const,
          delivery: 'none' as DeliveryVerdict,
          reason: 'document_not_found',
          hint: HINTS.document_not_found,
        };
      }
      const revised = revision.target;

      warnIfForeignSubject(slackCtx?.employeeId, employeeId, effectiveDeliverTo);

      const { rendered, producedFormat, failure } = await renderDocument({
        renderers,
        type: data.type,
        format: data.format,
        title,
        content,
        employee,
        interview: await readInterview(interviewRepo, channelRepo, employeeId),
      });

      const generated = await persistDocument(documentRepo, {
        revised,
        employeeId,
        type: data.type,
        title,
        content,
        format: producedFormat,
      });

      const delivered = await deliver({
        intent: effectiveDeliverTo,
        rendered,
        slackCtx,
        fileUpload,
        emailProvider,
        employeeEmail: employee.email,
        employeeId,
        title,
        failure,
      });
      const { delivery, reason } = delivered;

      await markDeliveryOutcome(documentRepo, generated, delivery);

      const recipient = fullName(employee.firstName, employee.lastName);

      writeDocumentRecipient(ctx?.requestContext, recipient);

      const result = {
        saved: true as const,
        ...(revised ? { revised: true as const } : {}),
        documentId: generated.id,
        format: producedFormat,
        delivery,
        recipient,
        ...(rendered ? { filename: rendered.filename } : {}),
        ...(reason ? { reason, hint: HINTS[reason] } : {}),
      };

      if (dedupKey && (delivery === 'slack' || delivery === 'email')) {
        runGuard.remember(dedupKey, { result, eventTs: slackCtx?.eventTs });
      }

      return result;
    },
  });
}

function resolveDeliveryIntent(params: {
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

function warnIfForeignSubject(
  requesterId: string | undefined,
  subjectId: string,
  deliverTo: DeliveryIntent,
): void {
  if (!requesterId || requesterId === subjectId) return;
  logger.warn('Document produit pour une AUTRE personne que le demandeur', {
    subjectId,
    requesterId,
    deliverTo,
  });
}

function resolveSubjectId(
  provided: string | undefined,
  slackCtx: { employeeId?: string } | undefined,
): string | undefined {
  return provided ?? slackCtx?.employeeId;
}

const NO_SUBJECT_RESULT = {
  saved: false as const,
  delivery: 'none' as DeliveryVerdict,
  reason: 'employee_not_found' as const,
  hint: HINTS.employee_not_found,
};

function sanitizeDocumentInput(input: {
  title: string;
  content: string;
  type: DocumentType;
  employeeId: string;
}): { title: string; content: string } {
  const data = input;
  const { employeeId } = input;
  const safeTitle = sanitizeDocumentText(data.title);
  const safeContent = sanitizeDocumentSource(data.content);

  const markers = [...new Set([...safeTitle.redacted, ...safeContent.redacted])];
  const hosts = [...new Set([...safeTitle.strippedUrls, ...safeContent.strippedUrls])];

  if (markers.length > 0) {
    logger.error('Document content carried internal markers — markers removed', {
      employeeId,
      type: data.type,
      markers,
    });
  }

  if (hosts.length > 0) {
    logger.error('Document content carried fabricated links — links removed', {
      employeeId,
      type: data.type,
      hosts,
    });
  }

  const title = safeTitle.text.length > 0 ? safeTitle.text : DEFAULT_TITLES[data.type];
  const content = safeContent.text;

  return { title, content };
}

async function renderDocument(params: {
  renderers: readonly DocumentRenderer[];
  type: DocumentType;
  format: DocumentFormat;
  title: string;
  content: string;
  employee: {
    firstName: string;
    lastName: string;
    email: string;
    position?: string;
    startDate?: string;
  };
  interview: Awaited<ReturnType<typeof readInterview>>;
}): Promise<{
  rendered: RenderedDocument | undefined;
  producedFormat: DocumentFormat;
  failure: HintKey | undefined;
}> {
  const { renderers, type, format, title, content, employee, interview } = params;

  const renderer =
    renderers.find((candidate) => candidate.format === format) ??
    renderers.find((candidate) => candidate.format === DocumentFormat.Pdf);

  let rendered: RenderedDocument | undefined;
  let failure: HintKey | undefined;

  if (!renderer) {
    logger.error('Aucun renderer disponible — document enregistré sans fichier', {
      format: format,
    });
    failure = 'not_rendered';
  } else {
    try {
      rendered = await renderer.render({
        type: type,
        title,
        content,
        interview,
        employee: {
          firstName: employee.firstName,
          lastName: employee.lastName,
          email: employee.email,
          position: employee.position,
          startDate: employee.startDate,
        },
      });
    } catch (error: unknown) {
      logger.error('Rendu du document échoué — enregistrement sans fichier', {
        format: renderer.format,
        error: errorMessage(error),
      });
      failure = 'not_rendered';
    }
  }

  const producedFormat = rendered ? (renderer?.format ?? format) : format;

  return { rendered, producedFormat, failure };
}

type DeliveryIntent = 'slack' | 'email' | 'none';

interface DeliveryOutcome {
  delivery: DeliveryVerdict;
  reason: HintKey | undefined;
}

function toVerdict(sent: { ok: true } | { ok: false; reason: HintKey }): DeliveryOutcome {
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

async function deliver(params: {
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
  return { delivery, reason };
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
