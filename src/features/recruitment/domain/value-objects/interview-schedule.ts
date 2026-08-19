/**
 * LA DATE D'UN ENTRETIEN — transcrite par un modèle, donc validée par du code.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi une date mérite son propre value-object
 * ════════════════════════════════════════════════════════════════════════════
 *
 * La règle du dépôt distingue ce qui se RETROUVE (un email, un UUID) de ce qui se PRODUIT
 * (une prose). Une date d'entretien n'est ni l'un ni l'autre : elle est **TRANSCRITE** depuis
 * la phrase de l'humain (« pour le 20 août à 14h ») vers un champ ISO. Le risque n'est donc
 * pas l'invention mais l'ERREUR DE TRANSCRIPTION — et elle a deux formes connues :
 *
 *  1. **L'année.** Un modèle entraîné avant l'année courante écrit volontiers `2025-08-20`
 *     pour « le 20 août ». L'entretien part alors dans le PASSÉ.
 *  2. **L'heure.** « 14h » → `02:00`, ou un décalage de fuseau silencieux.
 *
 * Aucune validation Zod ne voit ces erreurs : `2025-08-20T14:00:00Z` est une chaîne ISO
 * parfaitement valide. D'où les deux bornes ci-dessous, qui sont les SEULES à pouvoir les
 * attraper, et l'affichage en toutes lettres qui laisse un humain trancher le reste.
 *
 * ⚠️ Ces bornes ne remplacent pas la relecture humaine, elles la rendent utile : la carte de
 * confirmation affiche « jeudi 20 août 2026 à 14:00 (UTC+01:00) », et une erreur d'heure ou
 * de jour saute aux yeux sous cette forme, là où `2026-08-20T13:00:00.000Z` ne dit rien à
 * personne.
 *
 * TypeScript pur — ce module traverse la couche `domain`.
 *
 * ⚠️ Le FORMATAGE a été extrait dans `shared/french-datetime.ts` le 2026-08-19 : il existait
 * en trois exemplaires divergents dans ce dépôt, et le seul défaut mesuré en production venait
 * de celui qui n'existait pas — `scheduleReminder` laissait le modèle écrire le jour de la
 * semaine, qui s'est révélé faux. Ce qui reste ici, ce sont les BORNES, qui sont propres à un
 * entretien.
 */

/**
 * Fuseau d'affichage. `Africa/Lagos` = WAT, UTC+1 — le fuseau relevé dans les rapports de
 * test de ce dépôt.
 *
 * ⚠️ Il est LU DANS L'ENVIRONNEMENT et non codé en dur, parce qu'une erreur ici est invisible
 * et coûteuse : le candidat se présente à la mauvaise heure et personne ne comprend pourquoi.
 * L'offset est de toute façon IMPRIMÉ dans l'email (« (UTC+01:00) »), ce qui rend l'hypothèse
 * vérifiable par son destinataire au lieu d'être implicite.
 */
import { frenchFullLabel, frenchShortLabel } from '../../../../shared/french-datetime';

export const INTERVIEW_TIMEZONE = process.env.RECRUITMENT_TIMEZONE || 'Africa/Lagos';

/**
 * Un entretien ne peut pas être fixé à plus d'un an. Cette borne n'existe pas pour des raisons
 * métier mais pour attraper la faute de frappe d'année dans l'autre sens (`2027` pour `2026`),
 * symétrique de celle que la borne « futur » attrape.
 */
export const MAX_INTERVIEW_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

export type InterviewScheduleError = 'invalid_date' | 'date_in_past' | 'date_too_far';

export interface InterviewSchedule {
  /** Instant absolu, sans ambiguïté de fuseau. */
  readonly at: Date;
  /** « jeudi 20 août 2026 à 14:00 (UTC+01:00) » — la forme qu'un humain peut vérifier. */
  readonly humanReadable: string;
  /** « jeudi 20 août à 14:00 » — forme courte, pour l'objet de l'email. */
  readonly shortLabel: string;
}

/**
 * ⚠️ Ne LÈVE jamais : rend un verdict. Un `throw` ici remonterait au modèle sous forme
 * d'erreur d'outil, que ce dépôt sait qu'il transforme en narration ; un verdict nommé se
 * rend à l'humain tel quel.
 */
export function parseInterviewSchedule(
  isoDateTime: string,
  now: Date,
): { ok: true; schedule: InterviewSchedule } | { ok: false; reason: InterviewScheduleError } {
  const at = new Date(isoDateTime);

  if (Number.isNaN(at.getTime())) return { ok: false, reason: 'invalid_date' };

  // Strictement dans le futur. C'est la borne qui attrape l'erreur d'ANNÉE, de loin la plus
  // fréquente : un modèle écrit volontiers l'année sur laquelle il a été entraîné.
  if (at.getTime() <= now.getTime()) return { ok: false, reason: 'date_in_past' };

  if (at.getTime() - now.getTime() > MAX_INTERVIEW_HORIZON_MS) {
    return { ok: false, reason: 'date_too_far' };
  }

  return {
    ok: true,
    schedule: {
      at,
      humanReadable: frenchFullLabel(at, INTERVIEW_TIMEZONE),
      shortLabel: frenchShortLabel(at, INTERVIEW_TIMEZONE),
    },
  };
}
