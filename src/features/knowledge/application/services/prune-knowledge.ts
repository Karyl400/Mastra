import { logger } from '../../../../shared/logger';
import type { MessageArchiveRepository } from '../../domain/ports/message-archive.repository';
import type { KnowledgeFactRepository } from '../../domain/ports/knowledge-fact.repository';
import {
  MIN_RETENTION_DAYS,
  resolveRetentionWindow,
} from '../../domain/services/knowledge-retention';

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

export async function pruneKnowledge(deps: PruneDeps): Promise<PruneReport> {
  const window = resolveRetentionWindow(deps.retentionDays, deps.now?.() ?? new Date());

  if (!window.enabled || window.before === null) {
    const rejectedAValue = window.reason !== 'not_configured';
    const report =
      'Aucune rétention appliquée — messages archivés et faits distillés sont conservés ' +
      'SANS BORNE, DM compris. Poser KNOWLEDGE_RETENTION_DAYS (minimum ' +
      `${MIN_RETENTION_DAYS}) pour y remédier.`;

    if (rejectedAValue) logger.error(report, { reason: window.reason, days: window.days });
    else logger.warn(report, { reason: window.reason });

    return { enabled: false, days: window.days, messages: 0, facts: 0, reason: window.reason };
  }

  let facts = 0;
  let messages = 0;

  try {
    if (deps.facts) facts = await deps.facts.pruneOlderThan(window.before);
    messages = await deps.archive.pruneOlderThan(window.before);
    logger.info('Rétention appliquée', { days: window.days, messages, facts });
  } catch (error) {
    logger.error('Rétention interrompue — sans conséquence sur la remise des rappels', {
      days: window.days,
      error: String(error),
    });
  }

  return { enabled: true, days: window.days, messages, facts };
}
