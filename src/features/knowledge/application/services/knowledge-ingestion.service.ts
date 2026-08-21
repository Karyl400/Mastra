import { logger } from '../../../../shared/logger';
import type {
  ArchivedMessage,
  MessageArchiveRepository,
} from '../../domain/ports/message-archive.repository';
import type { KnowledgeFactRepository } from '../../domain/ports/knowledge-fact.repository';
import { distillFact } from '../../domain/services/fact-distillation';
import { CURTAIN_BATCH_SIZE, runFactCurtain } from './fact-curtain.service';
import type { FactSummarizerPort } from '../../domain/ports/fact-summarizer.port';

export interface KnowledgeIngestionPort {
  ingest(message: ArchivedMessage): Promise<void>;
}

export interface KnowledgeIngestionDeps {
  readonly archive: MessageArchiveRepository;
  readonly facts?: KnowledgeFactRepository | null;
  readonly summarizer?: FactSummarizerPort | null;
}

export class KnowledgeIngestionService implements KnowledgeIngestionPort {
  private readonly archive: MessageArchiveRepository;
  private readonly facts: KnowledgeFactRepository | null;
  private readonly summarizer: FactSummarizerPort | null;

  constructor(deps: KnowledgeIngestionDeps) {
    this.archive = deps.archive;
    this.facts = deps.facts ?? null;
    this.summarizer = deps.summarizer ?? null;
  }

  async ingest(message: ArchivedMessage): Promise<void> {
    const stored = await this.archive.archive(message);
    if (!stored) return;

    const classified = await this.distil(message);

    if (!classified) await this.raiseCurtain();
  }

  private async raiseCurtain(): Promise<void> {
    if (!this.facts || !this.summarizer) return;

    try {
      await runFactCurtain({
        archive: this.archive,
        facts: this.facts,
        summarizer: this.summarizer,
      });
    } catch (error) {
      logger.warn('Second rideau — passe abandonnée, le niveau 1 garde tout', {
        batch: CURTAIN_BATCH_SIZE,
        error: String(error),
      });
    }
  }

  private async distil(message: ArchivedMessage): Promise<boolean> {
    if (!this.facts) return false;

    const distilled = distillFact(message.text);
    if (!distilled) return false;

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
      await this.archive.markDistilled([message.id], Date.now()).catch(() => 0);
      return true;
    } catch (error) {
      logger.warn('Fait non distillé — le niveau 1 garde le message, la recherche dégrade', {
        channel: message.channelId,
        error: String(error),
      });
      return false;
    }
  }
}
