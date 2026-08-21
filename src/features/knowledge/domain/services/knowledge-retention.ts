/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA RÉTENTION EST OPT-IN, ET C'EST UNE LEÇON PAYÉE DANS CE DÉPÔT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `prune(before)` est déclarée dans les deux ports de `knowledge` et implémentée quatre fois.
 * L'audit du 2026-08-21 a mesuré **zéro appelant**. `channel_messages` et `knowledge_facts`
 * sont les deux seules tables qui grossissent à chaque message — DM compris depuis le
 * 2026-08-21 — et rien ne les bornait.
 *
 * ⚠️ **POURQUOI OPT-IN PLUTÔT QU'UNE VALEUR PAR DÉFAUT.** Le 2026-08-21, allumer le cron des
 * rappels a réveillé d'un coup tout ce qui dormait en base : des rappels écrits des semaines
 * plus tôt sont partis dans la même minute. Une purge se comporte de la même façon, en pire —
 * **le premier passage supprimerait d'un bloc tout ce qui dépasse la fenêtre, et c'est
 * irréversible.** Une valeur par défaut ferait de ce déploiement-ci une suppression de masse
 * que personne n'a demandée.
 *
 * On exige donc `KNOWLEDGE_RETENTION_DAYS`. Absente ⇒ **rien n'est purgé**, et on le
 * JOURNALISE : une rétention qui ne tourne pas en silence est indiscernable d'une rétention
 * qui marche — exactement le mode de panne que ce dépôt traque partout.
 */

/** Borne basse : en deçà, on efface ce que la conversation courante vient d'archiver. */
export const MIN_RETENTION_DAYS = 7;

export interface RetentionWindow {
  readonly enabled: boolean;
  readonly days: number | null;
  /** Instant avant lequel une ligne est purgeable. `null` quand la rétention est désactivée. */
  readonly before: number | null;
  readonly reason?: 'not_configured' | 'not_a_number' | 'below_minimum';
}

export function resolveRetentionWindow(
  raw: string | undefined,
  now: Date = new Date(),
): RetentionWindow {
  const trimmed = raw?.trim();
  if (!trimmed) return { enabled: false, days: null, before: null, reason: 'not_configured' };

  const days = Number(trimmed);
  if (!Number.isFinite(days) || days <= 0) {
    return { enabled: false, days: null, before: null, reason: 'not_a_number' };
  }

  /**
   * ⚠️ **Une fenêtre trop courte est REFUSÉE, pas corrigée en silence.** `KNOWLEDGE_RETENTION_DAYS=1`
   * effacerait ce que la conversation d'hier vient d'archiver, et le symptôme serait « le bot
   * ne se souvient de rien » — un diagnostic qui ne désigne jamais une variable d'environnement.
   * Refuser et le dire coûte une ligne de journal ; corriger en silence coûte une soirée.
   */
  if (days < MIN_RETENTION_DAYS) {
    return { enabled: false, days, before: null, reason: 'below_minimum' };
  }

  return { enabled: true, days, before: now.getTime() - days * 86_400_000 };
}
