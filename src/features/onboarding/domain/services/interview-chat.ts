import { unwrapSlackLinks } from '../../../../shared/slack-links';

export const INTERVIEW_QUESTION_DAILY =
  'Dis-moi *ce que tu fais au quotidien*, en une phrase — je m’en sers pour préparer ton ' +
  'guide d’accueil, et pour te retrouver quand un collègue cherche quelqu’un sur ce sujet.';

export const INTERVIEW_QUESTION_STYLE =
  'Noté. Et *comment tu préfères travailler* ? Une phrase suffit : en asynchrone, beaucoup ' +
  'd’échanges, peu de réunions, ce que tu veux.';

export type InterviewStep = 'dailyWork' | 'workStyle';

export function pendingInterviewStep(lastAssistantText: string | undefined): InterviewStep | null {
  const text = (lastAssistantText ?? '').trim();
  if (!text) return null;
  if (text.includes(INTERVIEW_QUESTION_STYLE.slice(0, 40))) return 'workStyle';
  if (text.includes(INTERVIEW_QUESTION_DAILY.slice(0, 40))) return 'dailyWork';
  return null;
}

export const MAX_INTERVIEW_ANSWER_CHARS = 280;

export function captureInterviewAnswer(text: string | undefined): string | null {
  const trimmed = unwrapSlackLinks(text).trim().replace(/\s+/g, ' ');
  if (trimmed.length < 4) return null;
  if (isNotAnAnswer(trimmed)) return null;
  return trimmed.slice(0, MAX_INTERVIEW_ANSWER_CHARS);
}

function isNotAnAnswer(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[’´`]/g, "'");

  return /^(?:c'est|cest|j'ai|jai|je n'ai|je nai)\b.{0,24}\b(?:fait|fini|termine|bon)\b/.test(
    normalized,
  );
}

export const INTERVIEW_TOO_SHORT_REPLY =
  'Il me faut un peu plus que ça — une phrase, même courte. Sinon dis-moi « passe », et on ' +
  'verra ça plus tard.';

export function interviewRetryReply(step: InterviewStep): string {
  const question = step === 'workStyle' ? INTERVIEW_QUESTION_STYLE : INTERVIEW_QUESTION_DAILY;
  return `${INTERVIEW_TOO_SHORT_REPLY}\n\n${question}`;
}

export function skipsInterview(text: string | undefined): boolean {
  const normalized = (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .trim();
  return /^(passe|plus tard|pas maintenant|skip|non merci|non)\b/.test(normalized);
}

export const INTERVIEW_SKIPPED_REPLY =
  'Pas de souci, on laisse ça de côté. Si tu changes d’avis, écris-moi « j’ai fini » et on ' +
  'repart de là.';

const FIRST_PERSON = /(?<!\p{L})(?:je|j[’']|mon|ma|mes|moi)(?!\p{L})/u;

const INTERROGATIVE_OPENERS =
  /^(?:qui|quel(?:le)?s?|quoi|comment|pourquoi|quand|ou|où|combien|est-ce|a qui|à qui|quelqu)/u;

export function isQuestionToBot(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  const normalized = trimmed
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');

  if (INTERROGATIVE_OPENERS.test(normalized)) return true;

  if (FIRST_PERSON.test(trimmed.toLowerCase())) return false;

  return trimmed.endsWith('?');
}
