import { INTERVIEW_QUESTION_DAILY } from './interview-chat';
import {
  PROFILE_CHAT_INTRO_NO_RECORD,
  PROFILE_QUESTIONS,
  PROFILE_STEP_ORDER,
  type ProfileAnswers,
  type ProfileStep,
  answersFromRecord,
  nextProfileStep,
  profileChatIntroMissing,
  profileChatIntroPartial,
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

const FIELD_LABELS: Readonly<Record<ProfileStep, string>> = {
  firstName: 'ton prénom',
  lastName: 'ton nom',
  email: 'ton adresse email',
  position: 'l’intitulé de ton poste',
};

export function verifyProfile(
  snapshot: ProfileSnapshot | null,
  known: ProfileAnswers = {},
): ProfileVerdict {
  const onRecord = answersFromRecord(snapshot);

  if (snapshot !== null && nextProfileStep(onRecord) === null) {
    return { complete: true, missing: [], reply: NEXT_STEP, needsProfileChat: false };
  }

  const merged: ProfileAnswers = { ...known, ...onRecord };
  const missing = PROFILE_STEP_ORDER.filter((step) => !merged[step]?.trim()).map(
    (step) => FIELD_LABELS[step],
  );

  const step = nextProfileStep(merged) ?? nextProfileStep(onRecord) ?? PROFILE_STEP_ORDER[0]!;

  const intro = introFor(snapshot, missing);

  return {
    complete: false,
    missing,
    reply: `${intro}\n\n${PROFILE_QUESTIONS[step]}`,
    needsProfileChat: true,
  };
}

function introFor(snapshot: ProfileSnapshot | null, missing: readonly string[]): string {
  if (snapshot !== null) return profileChatIntroMissing(missing);
  return missing.length === PROFILE_STEP_ORDER.length
    ? PROFILE_CHAT_INTRO_NO_RECORD
    : profileChatIntroPartial(missing);
}

export const PROFILE_CHECK_UNAVAILABLE =
  'Je n’arrive pas à consulter les dossiers en ce moment, donc je ne peux pas te confirmer ' +
  'que le tien est complet. Redemande-moi dans un instant.';
