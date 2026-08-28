import type {
  DocumentRenderInput,
  DocumentRenderer,
  RenderedDocument,
} from '../../domain/ports/document-renderer';
import { DEFAULT_TITLES } from '../../domain/services/document-template';
import {
  sanitizeDocumentSource,
  sanitizeDocumentText,
} from '../../../../shared/security/agent-output';
import { logger } from '../../../../shared/logger';
import { errorMessage } from '../../../../shared/errors';
import type { OnboardingInterviewRepository } from '../../../onboarding/domain/ports/onboarding-interview.repository';
import { DocumentFormat, DocumentType } from '../../../../shared/types';
import type { HintKey } from './document-hints';

export async function readInterview(
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

export function sanitizeDocumentInput(input: {
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

export async function renderDocument(params: {
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
