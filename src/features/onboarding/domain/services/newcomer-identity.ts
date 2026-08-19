/**
 * L'IDENTITÉ D'UN ARRIVANT et sa date de début — ce qui a survécu aux modales.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi ce module existe
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ces deux pièces vivaient dans `notification/infrastructure/handlers/profile-modal.ts`,
 * supprimé le 2026-08-19 avec les modales. Elles n'avaient rien de modal : un type de données
 * et un calcul de date pur. Les laisser dans un module de formulaire Slack les rendait
 * indisponibles à qui n'en construisait pas — et c'est bien ce qui s'est produit : le type a
 * été importé par le handler d'événements, la route d'interactivité, les blocs d'accueil et un
 * script de rattrapage, tous par un chemin qui nommait une modale qu'aucun d'eux n'ouvrait.
 *
 * Ici, en `domain`, sans aucun import : c'est du TypeScript pur, et il le reste.
 */

/**
 * Ce que le serveur sait d'un arrivant AVANT de lui parler.
 *
 * ⚠️ Le nom `ProfileModalPrefill` a été abandonné avec les modales. Il décrivait un
 * PRÉ-REMPLISSAGE de formulaire ; il ne reste aucun formulaire, et ce que ces champs portent
 * n'a jamais été un remplissage mais des FAITS — ce que Slack vient d'annoncer sur une
 * personne. Un nom qui décrit un mécanisme disparu est la première marche vers un commentaire
 * qui ment.
 */
export interface NewcomerIdentity {
  slackUserId: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  /**
   * Instant du `team_join`, en ISO 8601 — la date d'arrivée RÉELLE.
   *
   * Ce n'est pas une valeur de remplissage : c'est le fait que Slack vient d'annoncer, et
   * c'est précisément pour cela qu'aucune question de date n'est jamais posée. Une question
   * dont le serveur connaît déjà la réponse ne doit pas être posée — chaque champ demandé est
   * un champ qu'on peut remplir de travers ou laisser en plan.
   *
   * Absent quand l'arrivée n'est pas connue (rattrapage d'une personne déjà présente) :
   * l'appelant retombe alors sur l'instant courant.
   */
  joinedAt?: string | null;
}

/**
 * Journée UTC en ISO complet.
 *
 * ⚠️ Concaténation pure, jamais d'objet `Date`. Le « correctif » naturel
 * `new Date(d + 'T00:00:00').toISOString()` décale d'un jour dès que le runtime n'est pas en
 * UTC : mesuré en UTC+1, `2026-09-01` devient `2026-08-31T23:00Z`. L'écart dépend de `TZ`,
 * donc il ne se voit ni en test local ni en revue.
 */
export function normalizeStartDate(date: string): string {
  return `${date}T00:00:00.000Z`;
}

/**
 * Date de début, DÉRIVÉE de l'arrivée Slack.
 *
 * Aucune question de date n'est posée à l'arrivant parce que la réponse est déjà connue : il
 * commence le jour où le workspace l'annonce. Le repli sur `now` couvre le RATTRAPAGE — une
 * personne déjà présente quand le bot a été installé, dont l'arrivée n'a jamais été
 * annoncée — et il est exact pour elle aussi, à ceci près qu'il date la déclaration plutôt que
 * l'arrivée.
 *
 * ⚠️ Le passage par `slice(0, 10)` puis `normalizeStartDate` est délibéré : il borne au JOUR,
 * en UTC, sans jamais reconstruire une `Date` à partir d'une chaîne locale.
 */
export function startDateFromJoin(joinedAt: string | null | undefined, now: Date): string {
  const parsed = joinedAt ? new Date(joinedAt) : null;
  const valid = parsed && !Number.isNaN(parsed.getTime()) ? parsed : now;
  return normalizeStartDate(valid.toISOString().slice(0, 10));
}
