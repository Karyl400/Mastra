import {
  sanitizeNotificationBody,
  sanitizeNotificationSubject,
  type SanitizedDocumentText,
} from '../../../../shared/security/agent-output';
import { logger } from '../../../../shared/logger';

export interface SafeOutboundText {
  readonly subject: string;
  readonly body: string;
  readonly redacted: readonly string[];
  readonly strippedUrls: readonly string[];
}

function merge(
  subject: SanitizedDocumentText,
  body: SanitizedDocumentText,
): { redacted: string[]; strippedUrls: string[] } {
  return {
    redacted: [...new Set([...subject.redacted, ...body.redacted])],
    strippedUrls: [...new Set([...subject.strippedUrls, ...body.strippedUrls])],
  };
}

export function safeOutboundText(
  raw: { subject: string; body: string },
  context: Record<string, string | undefined>,
): SafeOutboundText {
  const subject = sanitizeNotificationSubject(raw.subject);
  const body = sanitizeNotificationBody(raw.body);
  const { redacted, strippedUrls } = merge(subject, body);

  if (redacted.length > 0 || strippedUrls.length > 0) {
    logger.error('Texte sortant assaini', { ...context, redacted, strippedUrls });
  }

  return { subject: subject.text, body: body.text, redacted, strippedUrls };
}
