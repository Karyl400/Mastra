import { unwrapSlackLinks } from '../../../../shared/slack-links';

export type ProfileStep = 'firstName' | 'lastName' | 'email' | 'position';

export const PROFILE_STEP_ORDER: readonly ProfileStep[] = [
  'firstName',
  'lastName',
  'email',
  'position',
];

export const PROFILE_QUESTIONS: Readonly<Record<ProfileStep, string>> = {
  firstName: 'Commençons par le plus simple : quel est ton *prénom* ?',
  lastName: 'Et ton *nom de famille* ?',
  email:
    'Quelle est ton *adresse email* ? Celle de l’entreprise si tu l’as déjà, sinon ton adresse personnelle — ça marche aussi.',
  position: 'Dernière chose : *l’intitulé de ton poste* ? Par exemple « Backend Developer ».',
};

export type ProfileAnswers = Partial<Record<ProfileStep, string>>;

export interface ProfileTurn {
  readonly role: string;
  readonly content: string;
}

const MAX_ANSWER_CHARS: Readonly<Record<ProfileStep, number>> = {
  firstName: 60,
  lastName: 60,
  email: 120,
  position: 80,
};

function looksLikeEmail(value: string): boolean {
  if (/\s/u.test(value)) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && domain.length - dot > 2;
}

const REFUSAL_PATTERNS: readonly RegExp[] = [
  /^je (?:ne |n['’])?(?:sais|ai) pas\b/iu,
  /^(?:aucun|aucune|rien)\b/iu,
  /^c['’]est\s+quoi\b/iu,
];

function isRefusal(value: string): boolean {
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(value));
}

export function pendingProfileStep(lastAssistantText: string | undefined): ProfileStep | null {
  const text = (lastAssistantText ?? '').trim();
  if (!text) return null;
  for (const step of [...PROFILE_STEP_ORDER].reverse()) {
    if (text.includes(PROFILE_QUESTIONS[step])) return step;
  }
  return null;
}

export function captureProfileAnswer(step: ProfileStep, text: string | undefined): string | null {
  const trimmed = unwrapSlackLinks(text).trim().replace(/\s+/g, ' ');
  if (!trimmed || isRefusal(trimmed)) return null;
  if (trimmed.length > MAX_ANSWER_CHARS[step]) return null;

  if (step === 'email') return looksLikeEmail(trimmed) ? trimmed.toLowerCase() : null;
  if (!/\p{L}/u.test(trimmed)) return null;
  if (trimmed.length < 2) return null;
  return trimmed;
}

export function collectProfileAnswers(turns: readonly ProfileTurn[]): ProfileAnswers {
  const answers: ProfileAnswers = {};
  let awaiting: ProfileStep | null = null;

  for (const turn of turns) {
    if (turn.role === 'assistant') {
      awaiting = pendingProfileStep(turn.content);
      continue;
    }
    if (turn.role !== 'user' || !awaiting) continue;
    const value = captureProfileAnswer(awaiting, turn.content);
    if (value) answers[awaiting] = value;
    awaiting = null;
  }

  return answers;
}

export function answersFromRecord(
  record: Partial<Record<ProfileStep, string | null | undefined>> | null,
): ProfileAnswers {
  const answers: ProfileAnswers = {};
  if (!record) return answers;
  for (const step of PROFILE_STEP_ORDER) {
    const value = record[step];
    if (typeof value === 'string' && value.trim()) answers[step] = value.trim();
  }
  return answers;
}

export function nextProfileStep(answers: ProfileAnswers): ProfileStep | null {
  return PROFILE_STEP_ORDER.find((step) => !answers[step]?.trim()) ?? null;
}

export function profileRetryReply(step: ProfileStep): string {
  if (step === 'email') {
    return (
      'Je n’ai pas reconnu d’adresse email — il m’en faut une avec un `@` et un domaine, ' +
      'comme `…@kissohq.com` ou `…@gmail.com`. La forme avant le `@` n’a aucune importance, ' +
      'et une adresse personnelle convient très bien.' +
      `\n\n${PROFILE_QUESTIONS.email}`
    );
  }
  return `Je n’ai pas su en tirer une réponse. ${PROFILE_QUESTIONS[step]}`;
}

export const PROFILE_CHAT_INTRO_NO_RECORD =
  'Je ne trouve pas encore de dossier à ton nom — on va arranger ça ensemble, ici même. ' +
  'Quatre questions, une réponse par message, et on n’en parle plus.';

export function profileChatIntroPartial(missing: readonly string[]): string {
  return (
    `Je n’ai pas encore de dossier à ton nom, mais j’ai déjà une partie de tes réponses — ` +
    `il me manque ${listOf(missing)}. On finit ça ici, une réponse par message.`
  );
}

export function profileChatIntroMissing(missing: readonly string[]): string {
  return `J’ai bien un dossier à ton nom, mais il me manque ${listOf(missing)}. On complète ça ici, une réponse par message.`;
}

function listOf(missing: readonly string[]): string {
  return missing.length === 1
    ? missing[0]!
    : `${missing.slice(0, -1).join(', ')} et ${missing.at(-1)!}`;
}

export const PROFILE_CHAT_SAVE_FAILED =
  'Je n’ai pas réussi à enregistrer ton dossier. Ce n’est pas de ton fait — redis-moi ' +
  '« j’ai fini » dans un instant et je réessaie.';

export interface DirectoryIdentity {
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly email?: string | null;
  readonly title?: string | null;
}

export function answersFromDirectory(
  identity: DirectoryIdentity | null | undefined,
): ProfileAnswers {
  const answers: ProfileAnswers = {};
  if (!identity) return answers;

  const firstName = captureProfileAnswer('firstName', identity.firstName ?? undefined);
  const lastName = captureProfileAnswer('lastName', identity.lastName ?? undefined);
  const email = captureProfileAnswer('email', identity.email ?? undefined);

  if (firstName) answers.firstName = firstName;
  if (lastName) answers.lastName = lastName;
  if (email) answers.email = email;

  return answers;
}

export const PROFILE_ALREADY_COMPLETE =
  'Ton dossier est déjà complet — je n’ai rien à te redemander. Si quelque chose y est ' +
  'inexact, dis-le moi et je le corrige.';
