import { GREETING_REPLIES, GREETING_REPLY, isBareGreeting } from '../../../../shared/greeting';
import { DISTRESS_REPLY, detectsDistress } from '../../../../shared/distress';
import { requestsErasure } from '../../../../shared/forget';
import { extractPinnedFact } from '../../../../shared/pin-fact';
import { requestsProfileForm } from '../../../../shared/profile-request';
import { claimsProfileDone } from '../../../../shared/profile-done';
import {
  CONTENT_FREE_REPLIES,
  CONTENT_FREE_REPLY,
  TOO_LONG_REPLIES,
  TOO_LONG_REPLY,
  hasNoTextualContent,
} from '../../../../shared/message-shape';
import { pickVariant } from '../../../../shared/reply-variants';
import { MAX_USER_INPUT_LENGTH } from '../../../../shared/security/llm-guardrail';

export const FILE_SHARE_SUBTYPE = 'file_share';

export const FILE_ATTACHMENT_REPLY =
  'Je ne sais pas lire les pièces jointes — ni les images, ni les PDF, ni les documents. ' +
  "Dis-moi en quelques mots ce dont tu as besoin et je m'en occupe.";

export interface DeterministicReplyInput {
  readonly text: string;
  readonly subtype?: string;
  readonly messageTs?: string;
  readonly isDirectMessage?: boolean;
}

export interface DeterministicReply {
  readonly name: string;
  readonly matches: (input: DeterministicReplyInput) => boolean;
  readonly reply: string | null;
  readonly variants?: readonly string[];
  readonly remembersTurn?: boolean;
  readonly action?: 'erasure' | 'pin_fact' | 'profile_form' | 'profile_done';
  readonly logFields?: (input: DeterministicReplyInput) => Record<string, unknown>;
}

export const DETERMINISTIC_REPLIES: readonly DeterministicReply[] = [
  {
    name: 'bare_greeting',
    matches: ({ text }) => isBareGreeting(text),
    reply: GREETING_REPLY,
    variants: GREETING_REPLIES,
    remembersTurn: true,
  },
  {
    name: 'file_attachment',
    matches: ({ subtype }) => subtype === FILE_SHARE_SUBTYPE,
    reply: FILE_ATTACHMENT_REPLY,
  },
  {
    name: 'no_textual_content',
    matches: ({ text }) => hasNoTextualContent(text),
    reply: CONTENT_FREE_REPLY,
    variants: CONTENT_FREE_REPLIES,
  },
  {
    name: 'over_length',
    matches: ({ text }) => text.length > MAX_USER_INPUT_LENGTH,
    reply: TOO_LONG_REPLY,
    variants: TOO_LONG_REPLIES,
    logFields: ({ text }) => ({ textLength: text.length }),
  },
  {
    name: 'distress',
    matches: ({ text }) => detectsDistress(text),
    reply: DISTRESS_REPLY,
    logFields: ({ isDirectMessage }) => ({ isDirectMessage }),
  },
  {
    name: 'profile_done',
    matches: ({ text, isDirectMessage }) => isDirectMessage === true && claimsProfileDone(text),
    reply: null,
    action: 'profile_done',
  },
  {
    name: 'erasure_request',
    matches: ({ text }) => requestsErasure(text),
    reply: null,
    action: 'erasure',
  },
  {
    name: 'pin_fact',
    matches: ({ text }) => extractPinnedFact(text) !== null,
    reply: null,
    action: 'pin_fact',
  },
  {
    name: 'profile_form_request',
    matches: ({ text }) => requestsProfileForm(text),
    reply: null,
    action: 'profile_form',
  },
];

export function isAnsweredWithoutModel(input: DeterministicReplyInput): boolean {
  return DETERMINISTIC_REPLIES.some((entry) => entry.matches(input));
}

export function findStaticReply(input: DeterministicReplyInput): DeterministicReply | undefined {
  return DETERMINISTIC_REPLIES.find((entry) => entry.reply !== null && entry.matches(input));
}

export function replyFor(entry: DeterministicReply, input: DeterministicReplyInput): string | null {
  if (entry.reply === null) return null;
  if (!entry.variants) return entry.reply;
  return pickVariant(entry.variants, input.messageTs);
}

export function findActingReply(input: DeterministicReplyInput): DeterministicReply | undefined {
  return DETERMINISTIC_REPLIES.find((entry) => entry.action !== undefined && entry.matches(input));
}
