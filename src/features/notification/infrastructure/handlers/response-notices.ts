import { textMentionsName } from '../../../../shared/name-matching';
import { escalationName } from '../../../../shared/escalation';
import {
  readAuthorizationNotice,
  readDocumentRecipient,
  readReminderDelivery,
} from '../../../../shared/slack-request-context';
import { agentHasTool } from '../../../../shared/agent-capabilities';
import {
  PROMISED_DELIVERY_NOTICE,
  UNSUPPORTED_CLAIM_NOTICE,
} from '../../domain/services/claim-reconciliation';

export function buildRecipientNotice(requestContext: unknown, answer: string): string {
  const recipient = readDocumentRecipient(requestContext);
  if (!recipient || textMentionsName(answer, recipient)) {
    return '';
  }
  return `\n\n_(Ce document a été produit pour ${recipient}.)_`;
}

export function buildAuthorizationNotice(requestContext: unknown, answer: string): string {
  const notice = readAuthorizationNotice(requestContext);
  if (!notice) {
    return '';
  }
  if (textMentionsName(answer, escalationName())) {
    return '';
  }
  return `\n\n_(${notice})_`;
}

const CHANNEL_TOKEN = /<#C[^>]{1,140}>/i;

export function buildChannelRedirectNotice(text: string, agentId: string, answer: string): string {
  if (!CHANNEL_TOKEN.test(text)) {
    return '';
  }
  if (agentHasTool(agentId, 'getChannelHistory')) {
    return '';
  }
  if (/demande-moi (?:seulement |simplement )?le r[ée]sum[ée]/i.test(answer)) {
    return '';
  }

  return (
    '\n\n_(Pour un résumé de canal, demande-le seul — sans PDF ni email dans la même phrase. ' +
    'Je le lis alors moi-même, au lieu de te demander de me le recopier.)_'
  );
}

export const REMINDER_UNDO_HINT = ' Dis-moi « annule le rappel » si tu changes d’avis.';

export function buildReminderNotice(requestContext: unknown, answer: string): string {
  const label = readReminderDelivery(requestContext);
  if (!label) {
    return '';
  }

  if (answer.includes(label) || /au matin\b/i.test(answer)) {
    return `\n\n_(${REMINDER_UNDO_HINT.trim()})_`;
  }

  const day = label.replace(/^le /i, '').replace(/ au matin$/i, '');
  if (answer.includes(day)) {
    return `\n\n_(Au matin — je ne passe qu'une fois par jour.${REMINDER_UNDO_HINT})_`;
  }

  return `\n\n_(Je te le remettrai ${label} — je ne passe qu'une fois par jour.${REMINDER_UNDO_HINT})_`;
}

export function appendNotes(notes: readonly (string | undefined)[]): string {
  const present = notes.filter((note): note is string => Boolean(note));
  return present.length === 0 ? '' : `\n\n${present.join('\n\n')}`;
}

export function composeAnswer(input: {
  answer: string;
  requestContext: unknown;
  text: string;
  agentId: string;
  unsupportedClaim: string | null;
  deliveryPromise: string | null;
  notes: readonly (string | undefined)[];
}): string {
  const { answer, requestContext, text, agentId } = input;

  return (
    answer +
    (input.unsupportedClaim ? UNSUPPORTED_CLAIM_NOTICE : '') +
    (input.deliveryPromise ? PROMISED_DELIVERY_NOTICE : '') +
    buildRecipientNotice(requestContext, answer) +
    buildAuthorizationNotice(requestContext, answer) +
    buildReminderNotice(requestContext, answer) +
    buildChannelRedirectNotice(text, agentId, answer) +
    appendNotes(input.notes)
  );
}
