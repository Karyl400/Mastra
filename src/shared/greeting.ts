import { normalizeIntentText } from './intent-text';
import { ASSISTANT_NAME } from './assistant-identity';

const BARE_GREETINGS = new Set([
  'bonjour',
  'bonsoir',
  'salut',
  'coucou',
  'hello',
  'hey',
  'hi',
  'yo',
  're',
  'bonjour a tous',
  'bonjour a toutes et a tous',
  'salut a tous',
  'bonne journee',
  'bonne soiree',

  'test',
  'ping',
  '123',
]);

const MAX_GREETING_LENGTH = 40;

export function isBareGreeting(text: string | undefined | null): boolean {
  const raw = (text ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_GREETING_LENGTH) return false;

  return BARE_GREETINGS.has(normalizeIntentText(raw));
}

export const ANNOUNCED_CAPABILITIES: ReadonlyArray<{
  readonly text: string;
  readonly tool: string;
}> = [
  { text: "retrouver le profil de quelqu'un", tool: 'getEmployeeProfile' },
  { text: 'préparer un document', tool: 'generateDocument' },
  { text: 'envoyer un message', tool: 'sendNotification' },
  { text: "résumer ce qui s'est dit dans un canal", tool: 'getChannelHistory' },
];

const CAPABILITY_LIST = `${ANNOUNCED_CAPABILITIES.slice(0, -1)
  .map((c) => c.text)
  .join(', ')}, ou ${ANNOUNCED_CAPABILITIES[ANNOUNCED_CAPABILITIES.length - 1]!.text}`;

export const GREETING_REPLY = `Bonjour, moi c'est ${ASSISTANT_NAME}. Dis-moi ce qu'il te faut : ${CAPABILITY_LIST}.`;

export const GREETING_REPLIES: readonly string[] = [
  GREETING_REPLY,
  `Salut, c'est ${ASSISTANT_NAME}. Je peux ${CAPABILITY_LIST}. Qu'est-ce qui t'amène ?`,
  `Bonjour, ${ASSISTANT_NAME} à l'appareil. Dis-moi ce que tu cherches : ${CAPABILITY_LIST}.`,
];
