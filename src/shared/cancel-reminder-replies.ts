import { ESCALATION_CONTACT } from './escalation';
import type { CancellableReminder } from './cancel-reminder-scope';

export function reminderCancelledReply(subject: string, deliveredOn: string | null): string {
  const when = deliveredOn ? ` Il ne partira pas ${deliveredOn}.` : ' Il ne partira pas.';
  return `C'est annulé : « ${subject} ».${when}`;
}

export function remindersCancelledReply(count: number, asked: number = count): string {
  const noun = count > 1 ? 'rappels' : 'rappel';
  const head = `C'est annulé : ${count} ${noun} en attente, plus aucun ne partira.`;

  const missed = asked - count;
  if (missed <= 0) {
    return head;
  }

  const tail =
    missed > 1
      ? ` ${missed} autres étaient déjà en cours de remise, je n'ai pas pu les arrêter.`
      : " Un autre était déjà en cours de remise, je n'ai pas pu l'arrêter.";
  return head + tail;
}

export function reminderCancelChoiceReply(candidates: readonly CancellableReminder[]): string {
  const lines = candidates
    .map(({ subject, deliveredOn }) =>
      deliveredOn ? `• ${deliveredOn} — « ${subject} »` : `• « ${subject} »`,
    )
    .join('\n');

  return (
    'Tu as plusieurs rappels en attente, et je ne veux pas deviner lequel :\n' +
    `${lines}\n` +
    'Dis-moi lequel, ou demande-moi de les annuler tous.'
  );
}

export const NO_REMINDER_TO_CANCEL_REPLY =
  "Tu n'as aucun rappel en attente — il n'y a rien à annuler.";

export function remindersPartlyUnreachable(errored: number): string {
  return errored > 1
    ? ` Pour ${errored} autres, ma base n'a pas répondu — je ne sais pas s'ils partiront.` +
        ' Redemande-le dans un moment.'
    : " Pour un autre, ma base n'a pas répondu — je ne sais pas s'il partira." +
        ' Redemande-le dans un moment.';
}

export const REMINDER_ALREADY_SENT_REPLY =
  "Ce rappel est déjà en cours de remise, je ne peux plus l'arrêter. Il va donc arriver — " +
  'excuse-moi pour le bruit.';

export const REMINDER_CANCEL_FAILED_REPLY =
  "Je n'ai pas réussi à annuler ce rappel — ma base est indisponible à l'instant. Redemande-le" +
  ` dans un moment, ou signale-le à ${ESCALATION_CONTACT}.`;

export const REMINDER_CANCEL_NO_RECORD_REPLY =
  'Je ne retrouve pas de dossier à ton nom, donc je ne sais pas de quels rappels tu parles. ' +
  'Dis-moi « je veux compléter mon profil » et on règle ça.';
