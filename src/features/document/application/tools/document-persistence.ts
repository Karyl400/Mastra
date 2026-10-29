import type { DocumentRepository } from '../../domain/ports/document.repository';
import { createDocument, type Document } from '../../domain/entities/document';
import { logger } from '../../../../shared/logger';
import { errorMessage } from '../../../../shared/errors';
import { DocumentFormat, DocumentStatus, DocumentType } from '../../../../shared/types';
import type { DeliveryVerdict } from './document-hints';

export function revisionFingerprintOf(
  revises: boolean | undefined,
  content: string,
): string | undefined {
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
  if (a.updatedAt === b.updatedAt) {
    return 0;
  }
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

export async function resolveRevisionTarget(
  documentRepo: DocumentRepository,
  revises: boolean | undefined,
  employeeId: string,
  type: DocumentType,
): Promise<{ refused: false; target?: { id: string; createdAt: string } } | { refused: true }> {
  if (!revises) {
    return { refused: false };
  }

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

export async function persistDocument(
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

  if (revised) {
    await documentRepo.update(generated);
  } else {
    await documentRepo.save(generated);
  }

  logger.info(revised ? 'Document corrigé' : 'Document généré', {
    id: generated.id,
    format: params.format,
  });

  return generated;
}

export async function markDeliveryOutcome(
  documentRepo: DocumentRepository,
  generated: Document,
  delivery: DeliveryVerdict,
): Promise<void> {
  if (delivery !== 'slack' && delivery !== 'email') {
    return;
  }

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
