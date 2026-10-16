import { createTool } from '@mastra/core/tools';

import { fullName } from '../../../../shared/name-matching';
import { logger } from '../../../../shared/logger';
import {
  readSlackContext,
  canReadPersonRecord,
  writeDocumentRecipient,
  noRequesterRefusal,
} from '../../../../shared/slack-request-context';
import { makeRunGuard } from '../../../../shared/tool-idempotency';
import type { GenerateDocumentDeps } from './generate-document-deps';
import { generateDocumentInputSchema } from './generate-document.schema';
import { HINTS, NO_SUBJECT_RESULT, type DeliveryVerdict } from './document-hints';
import { readInterview, renderDocument, sanitizeDocumentInput } from './document-render';
import {
  markDeliveryOutcome,
  persistDocument,
  resolveRevisionTarget,
  revisionFingerprintOf,
} from './document-persistence';
import { deliver } from './document-delivery';
import {
  alreadyDeliveredResult,
  resolveDeliveryIntent,
  resolveSubjectId,
  warnIfForeignSubject,
} from './document-delivery-intent';

export type { GenerateDocumentDeps } from './generate-document-deps';

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
    inputSchema: generateDocumentInputSchema,
    execute: async (data, ctx) => {
      const refused = noRequesterRefusal(ctx?.requestContext, 'generateDocument', {
        saved: false as const,
        delivery: 'none' as DeliveryVerdict,
      });
      if (refused) return refused;

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
        return alreadyDeliveredResult({
          previous,
          slackCtx,
          employeeId,
          type: data.type,
          effectiveDeliverTo,
        });
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
