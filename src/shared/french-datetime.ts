/**
 * Une date en toutes lettres, en français, dans un fuseau explicite.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi ce module existe — un défaut mesuré en production
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le 2026-08-19, `notificationAgent` a répondu, mot pour mot :
 *
 *     « Rappel planifié : « Relire le guide d'accueil », à 09 h 00 le **lundi 22 août 2026** »
 *
 * Le 22 août 2026 est un **samedi**, et la demande disait « avant lundi », donc le 24. Vérifié
 * en base : `scheduled_at` valait bien `2026-08-22T09:00:00Z`. Deux fautes dans une phrase, et
 * la seconde est la plus instructive : **le jour de la semaine était écrit par le MODÈLE**, à
 * côté d'une date qu'il avait lui-même calculée, et rien ne confrontait les deux.
 *
 * `recruitmentAgent` ne peut pas commettre cette faute — au même moment, il a produit
 * « mardi 15 septembre 2026 », exact — parce que son libellé est RENDU PAR DU CODE à partir de
 * la date. C'est toute la différence, et c'est la doctrine du dépôt : une prose se produit, un
 * fait se calcule.
 *
 * ⚠️ Ce module existait déjà, en trois exemplaires divergents : `interview-schedule.ts`,
 * `welcome-email.ts` et `document-template.ts` (qui, lui, imprimait la date BRUTE dans un
 * document signé de l'entreprise). Le `TODO.md` le recensait. Les rassembler ici est ce qui
 * permet de corriger une fois.
 *
 * TypeScript pur — ce module est importé depuis des couches `domain`.
 */

/**
 * Fuseau d'AFFICHAGE par défaut. `Africa/Lagos` = WAT, UTC+1 — les salariés sont au Nigeria.
 *
 * ⚠️ Lu dans l'environnement et non codé en dur : une erreur ici est invisible et coûteuse
 * (quelqu'un se présente à la mauvaise heure et personne ne comprend pourquoi). L'offset est
 * de toute façon IMPRIMÉ à côté de l'heure, ce qui rend l'hypothèse vérifiable.
 *
 * `RECRUITMENT_TIMEZONE` est accepté en second : c'est le nom historique, déjà posé, et le
 * retirer ferait basculer silencieusement le fuseau des entretiens.
 */
export const DISPLAY_TIMEZONE =
  process.env.DISPLAY_TIMEZONE || process.env.RECRUITMENT_TIMEZONE || 'Africa/Lagos';

/**
 * ⚠️ `Intl` peut manquer d'ICU sur un runtime minimal : il rendrait alors une chaîne anglaise
 * ou lèverait. On retombe sur l'ISO plutôt que d'échouer — une date moins lisible reste
 * vérifiable, une absence de date ne l'est pas.
 */
export function frenchDate(
  at: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  try {
    return new Intl.DateTimeFormat('fr-FR', { ...options, timeZone }).format(at);
  } catch {
    return at.toISOString();
  }
}

/** « jeudi 20 août à 14:00 » — forme courte, pour un objet d'email ou une phrase. */
export function frenchShortLabel(at: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    }).formatToParts(at);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${get('weekday')} ${get('day')} ${get('month')} à ${get('hour')}:${get('minute')}`;
  } catch {
    return at.toISOString();
  }
}

/**
 * « UTC+01:00 ».
 *
 * ⚠️ Imprimé tel quel partout où une heure est annoncée : c'est ce qui rend l'hypothèse de
 * fuseau VÉRIFIABLE par son destinataire au lieu d'être implicite.
 */
export function frenchOffsetLabel(at: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('fr-FR', {
      timeZone,
      timeZoneName: 'longOffset',
    }).formatToParts(at);
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

/** « jeudi 20 août 2026 à 14:00 (UTC+01:00) » — la forme qu'un humain peut vérifier. */
export function frenchFullLabel(at: Date, timeZone: string): string {
  return `${frenchDate(at, timeZone, { dateStyle: 'full', timeStyle: 'short' })} (${frenchOffsetLabel(at, timeZone)})`;
}
