import { frenchDayLabel } from '../../../../shared/french-datetime';
import { DISPLAY_TIMEZONE } from '../../../../shared/french-datetime';
import { NotificationStatus } from '../../../../shared/types';
import type { Notification } from '../entities/notification';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * CE QUI FAIT PARTIR UN RAPPEL — et pourquoi rien ne le faisait avant
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `scheduleReminder` écrivait une ligne en base et le disait sans détour : « Aucun automate ne
 * le reprend : rien ne part seul. » C'était exact — et ce n'est pas un rappel. Dans ce système
 * RIEN NE S'EXÉCUTE tant que personne ne frappe à la porte : la fonction Vercel ne vit que le
 * temps d'une requête HTTP, il n'existe aucun processus long, et `findPending()` — pourtant
 * écrite et correcte — n'avait AUCUN site d'appel. La cause n'était donc ni un oubli ni une
 * paresse : il manquait la seule chose qu'un serverless ne peut pas se donner à lui-même, une
 * HORLOGE EXTÉRIEURE.
 *
 * Le cron Vercel est cette horloge. Il frappe à la porte une fois par jour, et c'est tout ce
 * qui manquait.
 *
 * ⚠️ **LA GRANULARITÉ EST UN FAIT DE PLATEFORME, PAS UN CHOIX.** Le plan Hobby n'autorise
 * qu'une exécution PAR JOUR (« Cron expressions that would run more frequently will fail
 * during deployment ») et ne garantit l'heure qu'à ±59 min. Un rappel demandé « pour lundi
 * 9 h » ne peut donc pas partir à 9 h 00. Deux erreurs possibles, et elles ne se valent pas :
 * arriver le MATIN du bon jour, ou arriver le LENDEMAIN. On choisit le bon jour — un rappel
 * est un objet à granularité de JOURNÉE dans l'usage réel.
 *
 * ⚠️ **CE MODULE EST DONC AUSSI CE QUI EMPÊCHE MARCEL DE PROMETTRE UNE HEURE.** `deliveryLabel`
 * nomme le moment RÉEL de remise, jamais celui qui a été demandé. Le tool rendait
 * « lundi 24 août 2026 à 09 h00 » : une précision que la plateforme ne peut pas tenir, donc
 * la même famille de mensonge que `emailSent: false` sous `status: 'success'`.
 */

/**
 * ⚠️ **LA VÉRITÉ VIT DANS `vercel.json`, PAS ICI.** C'est elle que Vercel lit, et
 * `fix-vercel-output.js` la RECOPIE dans `config.json` au build plutôt que d'en tenir une
 * seconde. Cette constante est le miroir dont le code a besoin pour calculer une date de
 * remise, et `tests/unit/notification/reminder-dispatch-wiring.test.ts` échoue si les deux
 * divergent. Une planification écrite à deux endroits finit par dire deux choses, et le jour
 * où ça arrive personne ne le voit : le rappel part simplement à la mauvaise heure.
 */
export const REMINDER_DISPATCH_PATH = '/internal/reminders/dispatch';
export const REMINDER_DISPATCH_SCHEDULE = '0 6 * * *';
export const REMINDER_DISPATCH_HOUR_UTC = 6;

/**
 * Une exécution ne traite qu'un lot borné. Sans borne, un incident (base repartie, horloge
 * fausse) enverrait d'un coup tout l'historique — et une rafale de courriels est irréversible.
 */
export const MAX_REMINDERS_PER_RUN = 25;

/**
 * ⚠️ **ALLUMER UN ORDONNANCEUR RÉVEILLE TOUT CE QUI DORMAIT — constaté en production le
 * 2026-08-21, à la première exécution.**
 *
 * `scheduleReminder` écrivait des lignes `scheduled` depuis des semaines, et rien ne les
 * reprenait : elles étaient inertes. À la seconde où la remise a existé, **trois rappels échus
 * de la veille sont partis pour de bon**, et onze autres attendaient leur jour. C'était correct
 * — et c'est exactement le mode de panne qu'on aurait eu en pire si la table avait porté six
 * mois d'historique : une avalanche, le jour de la mise en service, sans que personne l'ait
 * demandée.
 *
 * Le plafond par exécution borne la RAFALE, pas le BACKLOG : il l'étale sur des jours.
 *
 * Au-delà de cette péremption, un rappel n'est plus rendu, il est ANNULÉ. « Je te rappelle ceci
 * pour le 20 juillet » remis le 21 août n'est pas un service, c'est de la confusion — et une
 * personne qui reçoit ça n'a aucun moyen de savoir si c'est un bug ou une intention.
 *
 * ⚠️ Sept jours, et pas moins : rater d'un jour ou deux doit rester rattrapable, c'est toute la
 * raison d'être de la reprise. Ce qu'on refuse est l'exhumation, pas le retard.
 */
export const STALE_AFTER_DAYS = 7;

const DAY_MS = 86_400_000;

const DISPATCHABLE: ReadonlySet<string> = new Set([
  NotificationStatus.Scheduled,
  NotificationStatus.Pending,
]);

/**
 * ⚠️ **UNE PRISE QUI NE SE TERMINE JAMAIS PERDRAIT LE RAPPEL POUR TOUJOURS.**
 *
 * On prend AVANT d'envoyer, et l'état de prise (`sending`) sort le rappel de `findPending()` —
 * c'est précisément ce qui interdit le doublon. Mais une fonction Vercel peut être tuée entre
 * les deux : dépassement de `maxDuration`, redéploiement, incident de plateforme. Le rappel
 * resterait alors `sending`, invisible de toute exécution ultérieure, et personne ne le saurait.
 *
 * C'est le mode de panne que ce dépôt traque partout : pas une erreur, un SILENCE. Même forme
 * que `Reprocessing an abandoned Slack event` — au-delà d'une grâce, on considère que
 * l'invocation qui tenait la prise est morte, et on reprend.
 *
 * ⚠️ La grâce doit dépasser très largement `maxDuration` (60 s) : la reprendre trop tôt
 * rouvrirait la course qu'on vient de fermer, et le symptôme serait un doublon dans la boîte
 * de quelqu'un. Six heures, contre une remise quotidienne : on ne peut rater qu'un seul tour.
 */
export const STRANDED_CLAIM_MS = 6 * 60 * 60 * 1000;

export function isStrandedClaim(
  notification: Pick<Notification, 'status' | 'updatedAt'>,
  now: Date,
): boolean {
  if (notification.status !== NotificationStatus.Sending) return false;
  const at = Date.parse(notification.updatedAt ?? '');
  if (Number.isNaN(at)) return false;
  return now.getTime() - at >= STRANDED_CLAIM_MS;
}

/**
 * Le jour civil, dans le fuseau d'affichage — jamais en UTC. À 23 h à Cotonou on est déjà
 * demain en UTC+2 et encore hier en UTC-5 : comparer des jours sans fuseau, c'est se tromper
 * de journée une fois sur trois.
 */
function localDayKey(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * Le rappel est DÛ dès que le jour demandé est arrivé — pas à l'heure demandée.
 *
 * ⚠️ Attendre l'heure exacte serait le pire des deux mondes : la remise quotidienne a lieu le
 * matin, donc un rappel « lundi 9 h » ne serait vu comme dû qu'à la remise du MARDI. Le
 * garde-fou censé éviter d'arriver trop tôt ferait systématiquement arriver un jour trop tard.
 */
export function isDueForDispatch(
  notification: Pick<Notification, 'status' | 'scheduledAt' | 'updatedAt'>,
  now: Date,
  timeZone: string = DISPLAY_TIMEZONE,
): boolean {
  if (!DISPATCHABLE.has(notification.status) && !isStrandedClaim(notification, now)) return false;
  if (!notification.scheduledAt) return false;

  const at = Date.parse(notification.scheduledAt);
  if (Number.isNaN(at)) return false;

  if (now.getTime() - at > STALE_AFTER_DAYS * DAY_MS) return false;

  return localDayKey(new Date(at), timeZone) <= localDayKey(now, timeZone);
}

/**
 * Périmé : le jour est passé depuis trop longtemps pour que la remise ait encore un sens.
 * Distinct de « pas encore dû » — c'est un état terminal, pas une attente.
 */
export function isStaleReminder(
  notification: Pick<Notification, 'status' | 'scheduledAt'>,
  now: Date,
): boolean {
  if (
    !DISPATCHABLE.has(notification.status) &&
    notification.status !== NotificationStatus.Sending
  ) {
    return false;
  }
  const at = notification.scheduledAt ? Date.parse(notification.scheduledAt) : Number.NaN;
  if (Number.isNaN(at)) return false;
  return now.getTime() - at > STALE_AFTER_DAYS * DAY_MS;
}

export function selectStaleReminders(all: readonly Notification[], now: Date): Notification[] {
  return all.filter((n) => isStaleReminder(n, now));
}

export function selectDueReminders(
  all: readonly Notification[],
  now: Date,
  limit: number = MAX_REMINDERS_PER_RUN,
  timeZone: string = DISPLAY_TIMEZONE,
): Notification[] {
  return all
    .filter((n) => isDueForDispatch(n, now, timeZone))
    .sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''))
    .slice(0, limit);
}

/**
 * Le moment où ce rappel sera RÉELLEMENT remis : la remise quotidienne du jour demandé, ou
 * celle du lendemain si celle d'aujourd'hui est déjà passée.
 *
 * ⚠️ Rendu au modèle À LA PLACE de la date demandée. Il n'a alors aucune occasion d'annoncer
 * une heure — non parce qu'on le lui interdit (une consigne est PROBABLE), mais parce que la
 * précision n'est plus dans sa fenêtre.
 */
export function nextDeliveryAt(scheduledAt: string, now: Date): Date | null {
  const at = Date.parse(scheduledAt);
  if (Number.isNaN(at)) return null;

  const run = new Date(at);
  run.setUTCHours(REMINDER_DISPATCH_HOUR_UTC, 0, 0, 0);

  // Demandé pour aujourd'hui après la remise du matin, ou pour une heure déjà passée : la
  // prochaine horloge est celle de demain. On ne peut pas remonter le temps, on le dit.
  while (run.getTime() < now.getTime()) run.setTime(run.getTime() + DAY_MS);

  return run;
}

export function deliveryLabel(
  scheduledAt: string,
  now: Date,
  timeZone: string = DISPLAY_TIMEZONE,
): string | null {
  const at = nextDeliveryAt(scheduledAt, now);
  return at ? `${frenchDayLabel(at, timeZone)} au matin` : null;
}

/**
 * ⚠️ LA MISE EN CONTEXTE EST ÉCRITE PAR LE CODE, jamais par le modèle.
 *
 * Un message qui arrive seul, des jours plus tard, sans dire d'où il vient, se lit comme un
 * message spontané du bot — donc comme une initiative qu'il n'a pas prise. Nommer la demande
 * et sa date est ce qui en fait un RAPPEL plutôt qu'une interruption.
 *
 * Le sujet et le corps, eux, restent ceux qui ont été enregistrés : les refabriquer à la
 * remise reviendrait à envoyer un texte que personne n'a relu.
 */
export function reminderPreamble(
  scheduledAt: string | null | undefined,
  timeZone: string = DISPLAY_TIMEZONE,
): string {
  const at = scheduledAt ? Date.parse(scheduledAt) : Number.NaN;
  if (Number.isNaN(at)) {
    return 'Tu m’avais demandé de te remettre ceci en tête.';
  }
  return `Tu m’avais demandé de te remettre ceci en tête pour ${frenchDayLabel(new Date(at), timeZone)}.`;
}
