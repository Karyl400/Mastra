import {
  containsInternalMarkers,
  INTERNAL_MARKERS_GLOBAL,
  REDACTED_MARKER_PLACEHOLDER,
} from './internal-markers';
import { filterLinks, stripDisallowedLinks } from './outbound-links';
import {
  dropUnknownQualifiers,
  stripEmojis,
  stripMarkdownMarkup,
  toSlackMrkdwn,
} from './slack-mrkdwn';

export { containsInternalMarkers, REDACTED_MARKER_PLACEHOLDER } from './internal-markers';
export { ALLOWED_LINK_DOMAINS, STRIPPED_LINK_PLACEHOLDER } from './outbound-links';

export const NEUTRAL_REFUSAL =
  'Je ne peux pas traiter ce message tel quel. Reformule-le en une ou deux phrases, ' +
  'en disant ce que tu veux obtenir — je réessaie tout de suite.';

export interface SanitizedAgentOutput {
  text: string;
  redacted: string[];
  strippedUrls: string[];
}

export const STATUS_OBJECT_REPLACEMENT =
  "Je n'ai pas pu mener cette demande à terme. Dis-moi précisément ce que tu cherches, et je réessaie.";

function isStatusObject(text: string): boolean {
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      ('status' in parsed || 'reason' in parsed)
    );
  } catch {
    return false;
  }
}

export function sanitizeAgentOutput(raw: string | undefined | null): SanitizedAgentOutput {
  const text = (raw ?? '').trim();

  if (!text) {
    return { text: NEUTRAL_REFUSAL, redacted: [], strippedUrls: [] };
  }

  if (isStatusObject(text)) {
    return { text: STATUS_OBJECT_REPLACEMENT, redacted: [], strippedUrls: [] };
  }

  const redacted = containsInternalMarkers(text);

  if (redacted.length > 0) {
    return { text: NEUTRAL_REFUSAL, redacted, strippedUrls: [] };
  }

  const { text: withoutLinks, hostnames } = stripDisallowedLinks(text);

  return {
    text: dropUnknownQualifiers(toSlackMrkdwn(withoutLinks)),
    redacted: [],
    strippedUrls: hostnames,
  };
}

const MARKDOWN_LINK = /\[([^\]\n]{0,200})\]\(([^)\s]{0,2000})\)/g;

export interface SanitizedDocumentText {
  text: string;
  redacted: string[];
  strippedUrls: string[];
}

function redactAndFilter(raw: string | undefined | null): SanitizedDocumentText {
  const redacted: string[] = [];
  let text = (raw ?? '').replace(/\r\n?/g, '\n');

  for (const { label, pattern } of INTERNAL_MARKERS_GLOBAL) {
    const next = text.replace(pattern, REDACTED_MARKER_PLACEHOLDER);
    if (next === text) {
      continue;
    }
    redacted.push(label);
    text = next;
  }

  const seen = new Set<string>();
  text = filterLinks(text.replace(MARKDOWN_LINK, '$1 $2'), seen);

  return { text, redacted, strippedUrls: [...seen] };
}

export const NOTIFICATION_BODY_PLACEHOLDER =
  "(Le contenu de cette notification a été retiré : il n'a pas passé le contrôle de sortie.)";

export function sanitizeNotificationBody(raw: string | undefined | null): SanitizedDocumentText {
  const { text, redacted, strippedUrls } = redactAndFilter(raw);
  const clean = dropUnknownQualifiers(text).trim();

  return {
    text: clean.length > 0 ? clean : NOTIFICATION_BODY_PLACEHOLDER,
    redacted,
    strippedUrls,
  };
}

export const NOTIFICATION_SUBJECT_PLACEHOLDER = 'Notification Kisso';

const SUBJECT_MAX_LENGTH = 200;

export function sanitizeNotificationSubject(raw: string | undefined | null): SanitizedDocumentText {
  const { text, redacted, strippedUrls } = redactAndFilter(raw);
  const flattened = dropUnknownQualifiers(text)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return {
    text:
      flattened.length > 0
        ? flattened.slice(0, SUBJECT_MAX_LENGTH)
        : NOTIFICATION_SUBJECT_PLACEHOLDER,
    redacted,
    strippedUrls,
  };
}

export function sanitizeDocumentSource(raw: string | undefined | null): SanitizedDocumentText {
  const { text, redacted, strippedUrls } = redactAndFilter(raw);

  return {
    text: dropUnknownQualifiers(stripEmojis(text).trim()),
    redacted,
    strippedUrls,
  };
}

export function sanitizeDocumentText(raw: string | undefined | null): SanitizedDocumentText {
  const source = sanitizeDocumentSource(raw);
  return { ...source, text: stripMarkdownMarkup(source.text) };
}
