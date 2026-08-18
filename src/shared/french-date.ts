/**
 * Une seule façon d'écrire une date à un humain, dans tout le produit.
 *
 * ## Le défaut que ce module ferme
 *
 * Relevé le 2026-08-18, la même date était écrite de TROIS façons dans des documents qui
 * partent à la même personne :
 *
 *  1. `welcome-email.ts` rendait « lundi 1 septembre 2026 » et, faute d'ICU, retombait sur
 *     l'ISO tronquée au jour ;
 *  2. `interview-schedule.ts` a son propre `Intl.DateTimeFormat('fr-FR', …)`, avec un fuseau
 *     et un repli différents ;
 *  3. `document-template.ts` imprimait `employee.startDate` **BRUT** — soit
 *     « Votre date de début est le 2026-09-01T00:00:00.000Z », dans une lettre signée de
 *     l'entreprise.
 *
 * La troisième écriture est la seule fausse, et elle existait parce que rien ne reliait les
 * deux autres. Une règle écrite trois fois diverge à la première modification.
 *
 * ⚠️ `interview-schedule.ts` garde son propre formatage, et c'est VOULU : il rend une date
 * ET une heure dans un fuseau explicite (`RECRUITMENT_TIMEZONE`), avec l'offset imprimé dans
 * l'email — parce que c'est le seul champ qu'un modèle transcrit depuis une phrase humaine,
 * donc le seul vecteur d'erreur restant. Ce module-ci ne traite que le JOUR.
 */

/**
 * « lundi 1 septembre 2026 », ou `null` si la date est absente ou illisible.
 *
 * ⚠️ Rend `null` plutôt qu'une chaîne brute : afficher `2026-09-01T00:00:00.000Z` à un
 * arrivant est pire que de ne rien afficher, et une date inventée serait pire encore. Aux
 * appelants de faire disparaître la phrase avec le champ — c'est ce que fait déjà
 * `welcome-email.ts`, et ce que `document-template.ts` ne faisait pas.
 *
 * `timeZone: 'UTC'` parce qu'une date d'arrivée est un JOUR, pas un instant : la lire dans le
 * fuseau du serveur ferait basculer « 1er septembre » en « 31 août » selon l'endroit où la
 * fonction tourne — et Vercel ne garantit pas la région.
 */
export function formatFrenchDay(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;

  try {
    return new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(at);
  } catch {
    // ICU absent du runtime : l'ISO tronquée au jour reste lisible, contrairement à
    // l'horodatage complet. C'est le seul repli acceptable — il ne ment pas.
    return at.toISOString().slice(0, 10);
  }
}
