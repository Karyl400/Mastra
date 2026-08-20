import { INTERVIEW_QUESTION_DAILY } from './interview-chat';
import {
  PROFILE_CHAT_INTRO_NO_RECORD,
  PROFILE_QUESTIONS,
  answersFromRecord,
  nextProfileStep,
  profileChatIntroMissing,
} from './profile-chat';

export interface ProfileSnapshot {
  readonly firstName: string | null | undefined;
  readonly lastName: string | null | undefined;
  readonly email: string | null | undefined;
  readonly position: string | null | undefined;
}

export interface ProfileVerdict {
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly reply: string;
  readonly needsProfileChat: boolean;
}

const NEXT_STEP =
  `Ton dossier est complet, je l’ai vérifié. *Parlons de toi*, maintenant — deux questions, ` +
  `pas plus.\n\n${INTERVIEW_QUESTION_DAILY}`;

const FIELD_LABELS: Readonly<Record<keyof ProfileSnapshot, string>> = {
  firstName: 'ton prénom',
  lastName: 'ton nom',
  email: 'ton adresse email',
  position: 'l’intitulé de ton poste',
};

const FIELD_ORDER: ReadonlyArray<keyof ProfileSnapshot> = [
  'firstName',
  'lastName',
  'email',
  'position',
];

function filled(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function verifyProfile(snapshot: ProfileSnapshot | null): ProfileVerdict {
  if (snapshot === null) {
    return {
      complete: false,
      missing: FIELD_ORDER.map((field) => FIELD_LABELS[field]),
      reply: `${PROFILE_CHAT_INTRO_NO_RECORD}\n\n${PROFILE_QUESTIONS.firstName}`,
      needsProfileChat: true,
    };
  }

  const missing = FIELD_ORDER.filter((field) => !filled(snapshot[field])).map(
    (field) => FIELD_LABELS[field],
  );

  if (missing.length === 0) {
    return { complete: true, missing: [], reply: NEXT_STEP, needsProfileChat: false };
  }

  const step = nextProfileStep(answersFromRecord(snapshot))!;
  return {
    complete: false,
    missing,
    reply: `${profileChatIntroMissing(missing)}\n\n${PROFILE_QUESTIONS[step]}`,
    needsProfileChat: true,
  };
}

export const PROFILE_CHECK_UNAVAILABLE =
  'Je n’arrive pas à consulter les dossiers en ce moment, donc je ne peux pas te confirmer ' +
  'que le tien est complet. Redemande-moi dans un instant.';
