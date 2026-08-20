import { logger } from '../../../../shared/logger';
import type {
  ArchivedMessage,
  MessageArchiveRepository,
} from '../../domain/ports/message-archive.repository';
import type { KnowledgeFactRepository } from '../../domain/ports/knowledge-fact.repository';
import { distillFact } from '../../domain/services/fact-distillation';

export interface KnowledgeIngestionPort {
  ingest(message: ArchivedMessage): Promise<void>;
}

export interface KnowledgeIngestionDeps {
  readonly archive: MessageArchiveRepository;
  readonly facts?: KnowledgeFactRepository | null;
}

export class KnowledgeIngestionService implements KnowledgeIngestionPort {
  private readonly archive: MessageArchiveRepository;
  private readonly facts: KnowledgeFactRepository | null;

  constructor(deps: KnowledgeIngestionDeps) {
    this.archive = deps.archive;
    this.facts = deps.facts ?? null;
  }

  async ingest(message: ArchivedMessage): Promise<void> {
    const stored = await this.archive.archive(message);
    if (!stored) return;

    await this.distil(message);
  }

  private async distil(message: ArchivedMessage): Promise<void> {
    if (!this.facts) return;

    const distilled = distillFact(message.text);
    if (!distilled) return;

    try {
      await this.facts.record({
        id: message.id,
        channelId: message.channelId,
        slackUserId: message.slackUserId,
        kind: distilled.kind,
        summary: distilled.summary,
        score: distilled.score,
        postedAt: message.postedAt,
      });
    } catch (error) {
      logger.warn('Fait non distillé — le niveau 1 garde le message, la recherche dégrade', {
        channel: message.channelId,
        error: String(error),
      });
    }
  }
}
