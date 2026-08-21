import { logger } from '../../../../shared/logger';
import type { MessageArchiveRepository } from '../../domain/ports/message-archive.repository';
import type { KnowledgeFactRepository } from '../../domain/ports/knowledge-fact.repository';
import { resolveRetentionWindow } from '../../domain/services/knowledge-retention';

export interface PruneReport {
  readonly enabled: boolean;
  readonly days: number | null;
  readonly messages: number;
  readonly facts: number;
  readonly reason?: string;
}

export interface PruneDeps {
  readonly archive: MessageArchiveRepository;
  readonly facts?: KnowledgeFactRepository | null;
  readonly retentionDays?: string;
  readonly now?: () => Date;
}

/**
 * ⚠️ **NE PROPAGE JAMAIS.** La purge partage l'unique horloge de ce produit avec la remise des
 * rappels. Un échec de purge ne doit pas empêcher un rappel de partir : le premier est réparable
 * demain, le second ne l'est pas — la personne aura manqué son échéance.
 *
 * ⚠️ **Les faits sont purgés AVANT les messages**, même ordre que l'effacement : l'état
 * intermédiaire acceptable est « des messages sans faits » (rejouable par distillation), jamais
 * « des faits sans messages » (une affirmation dont la source a disparu).
 */
export async function pruneKnowledge(deps: PruneDeps): Promise<PruneReport> {
  const window = resolveRetentionWindow(deps.retentionDays, deps.now?.() ?? new Date());

  if (!window.enabled || window.before === null) {
    // Une rétention qui ne tourne pas EN SILENCE est indiscernable d'une rétention qui marche.
    logger.info('Rétention de la base de connaissance non appliquée', {
      reason: window.reason,
      days: window.days,
    });
    return { enabled: false, days: window.days, messages: 0, facts: 0, reason: window.reason };
  }

  let facts = 0;
  let messages = 0;

  try {
    if (deps.facts) facts = await deps.facts.prune(window.before);
    messages = await deps.archive.prune(window.before);
    logger.info('Rétention appliquée', { days: window.days, messages, facts });
  } catch (error) {
    logger.error('Rétention interrompue — sans conséquence sur la remise des rappels', {
      days: window.days,
      error: String(error),
    });
  }

  return { enabled: true, days: window.days, messages, facts };
}
