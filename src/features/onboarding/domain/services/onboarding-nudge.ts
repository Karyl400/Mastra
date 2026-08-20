import { pickVariant } from '../../../../shared/reply-variants';
import type { ProfileStep } from './profile-chat';
import type { InterviewStep } from './interview-chat';

/**
 * LE RAPPEL DISCRET — quand quelqu'un laisse son dossier en plan et parle d'autre chose.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Le défaut, signalé par le propriétaire
 * ════════════════════════════════════════════════════════════════════════════
 *
 * « Lorsqu'un nouvel arrivant complète son profil puis ne dit pas "c'est fait" ou équivalent
 * mais change de sujet, le ramener subtilement à la complétion du profil. »
 *
 * Ce qui se passait : une question d'accueil attend, la personne demande autre chose. Le
 * message ne ressemble pas à une réponse (`answersOnboardingQuestion` rend `false` sur une
 * question posée au bot), il part donc chez un agent, qui répond — **et le fil d'accueil est
 * abandonné sans un mot**. La machine à états n'a aucun rappel : son état EST le dernier tour
 * `assistant` du fil, or ce tour vient d'être remplacé par la réponse de l'agent. Le dossier
 * ne se termine jamais, et personne ne sait pourquoi.
 *
 * ⚠️ Ce n'est pas un défaut de mémoire mais de STRUCTURE : répondre au nouveau sujet EFFACE
 * l'état. Sans rappel accolé, l'accueil ne peut pas reprendre.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi ACCOLÉ, et jamais posté à part
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Exactement la forme retenue pour l'email d'entretien en attente : la personne a changé de
 * sujet, on lui répond D'ABORD. Deux messages feraient paraître le bot bavard là où il ne
 * fait que ne pas oublier, et un rappel posté seul se lit comme un reproche.
 *
 * ⚠️ Il ne BLOQUE rien et ne redemande rien : c'est une phrase en italique à la fin d'une
 * réponse utile. « Subtilement » est une contrainte de forme, et elle est tenue par le code —
 * pas par une consigne au modèle, qui la formulerait autrement à chaque fois.
 *
 * ZÉRO token : texte écrit en dur, aucun modèle sur ce chemin.
 */

/**
 * Ce qui manque, dit avec les MÊMES mots que la question posée.
 *
 * ⚠️ Nommer le champ plutôt que dire « ton profil » : la personne sait alors exactement ce
 * qu'il reste à faire, et la reprise coûte une phrase au lieu d'un aller-retour. C'est la même
 * exigence que `FIELD_LABELS` dans `profile-completion.ts` — une réponse qui emploie d'autres
 * mots que la question envoie chercher un champ qui n'existe pas sous ce nom.
 */
const PROFILE_LABELS: Readonly<Record<ProfileStep, string>> = {
  firstName: 'ton prénom',
  lastName: 'ton nom de famille',
  email: 'ton adresse email',
  position: 'l’intitulé de ton poste',
};

const INTERVIEW_LABELS: Readonly<Record<InterviewStep, string>> = {
  dailyWork: 'ce que tu fais au quotidien',
  workStyle: 'ta façon de travailler',
};

/**
 * Trois formulations, choisies DÉTERMINISTEMENT sur l'horodatage du message.
 *
 * La répétition littérale est ce qui fait « machine » — c'est le constat du Conseil du
 * 2026-08-18 — et un rappel est par nature le texte qu'une personne verra le plus souvent :
 * c'est donc celui où la répétition coûte le plus cher. Jamais `Math.random()` : un test ne
 * peut pas verrouiller une réponse aléatoire, et un diagnostic ne peut pas la rejouer.
 */
const VARIANTS: readonly string[] = [
  '_(Au fait, il me manque encore %s pour boucler ton dossier.)_',
  '_(Quand tu veux : il me reste %s à noter pour ton dossier.)_',
  '_(Je garde ton dossier de côté — il n’y manque que %s.)_',
];

export interface PendingOnboardingStep {
  readonly kind: 'profile' | 'interview';
  readonly step: ProfileStep | InterviewStep;
}

/**
 * Le rappel à accoler, ou `undefined` s'il n'y a rien en attente.
 *
 * ⚠️ Rend `undefined` plutôt qu'une chaîne vide : l'appelant décide d'accoler ou non, et un
 * `''` accolé laisserait deux sauts de ligne en fin de message — une trace visible d'un
 * mécanisme qui ne s'est pas déclenché.
 */
export function onboardingNudge(
  pending: PendingOnboardingStep | undefined,
  messageTs?: string,
): string | undefined {
  if (!pending) return undefined;

  const label =
    pending.kind === 'profile'
      ? PROFILE_LABELS[pending.step as ProfileStep]
      : INTERVIEW_LABELS[pending.step as InterviewStep];

  if (!label) return undefined;

  return pickVariant(VARIANTS, messageTs).replace('%s', label);
}
