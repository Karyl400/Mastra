import { logger } from '../../../../shared/logger';
import type {
  KnowledgeForgetScope,
  MessageArchiveRepository,
} from '../../domain/ports/message-archive.repository';
import type { KnowledgeFactRepository } from '../../domain/ports/knowledge-fact.repository';

export interface KnowledgeErasurePort {
  forget(scope: KnowledgeForgetScope): Promise<KnowledgeErasureReport>;
}

export interface KnowledgeErasureReport {
  readonly messages: number;
  readonly facts: number;
  readonly partial: boolean;
}

export interface KnowledgeErasureDeps {
  readonly archive: MessageArchiveRepository;
  readonly facts?: KnowledgeFactRepository | null;
}

export class KnowledgeErasureService implements KnowledgeErasurePort {
  private readonly archive: MessageArchiveRepository;
  private readonly facts: KnowledgeFactRepository | null;

  constructor(deps: KnowledgeErasureDeps) {
    this.archive = deps.archive;
    this.facts = deps.facts ?? null;
  }

  async forget(scope: KnowledgeForgetScope): Promise<KnowledgeErasureReport> {
    let facts = 0;
    let partial = false;

    if (this.facts) {
      try {
        facts = await this.facts.forget(scope);
      } catch (error) {
        partial = true;
        logger.error("Faits distillés non effacés — l'archive n'est pas touchée non plus", {
          slackUserId: scope.slackUserId,
          channelId: scope.channelId,
          error: String(error),
        });
        return { messages: 0, facts: 0, partial };
      }
    }

    let messages = 0;
    try {
      messages = await this.archive.forget(scope);
    } catch (error) {
      partial = true;
      logger.error('Archive non effacée — les faits, eux, sont partis', {
        slackUserId: scope.slackUserId,
        channelId: scope.channelId,
        error: String(error),
      });
    }

    logger.info('Effacement de la base de connaissance', {
      slackUserId: scope.slackUserId,
      channelId: scope.channelId,
      messages,
      facts,
      partial,
    });

    return { messages, facts, partial };
  }
}
