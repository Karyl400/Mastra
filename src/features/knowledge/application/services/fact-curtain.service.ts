import { logger } from '../../../../shared/logger';
import { sanitizeNotificationBody } from '../../../../shared/security/agent-output';
import {
  FACT_SUMMARY_MAX_CHARS,
  KNOWLEDGE_FACT_MIN_SCORE,
  type FactKind,
} from '../../domain/services/fact-distillation';
import type { KnowledgeFactRepository } from '../../domain/ports/knowledge-fact.repository';
import type { MessageArchiveRepository } from '../../domain/ports/message-archive.repository';
import type { FactSummarizerPort } from '../../domain/ports/fact-summarizer.port';

export const CURTAIN_BATCH_SIZE = 5;

export const CURTAIN_WINDOW_MS = 6 * 60 * 60 * 1000;

const KNOWN_KINDS: ReadonlySet<string> = new Set<FactKind>([
  'decision',
  'engagement',
  'blocage',
  'echeance',
  'question',
]);

export interface FactCurtainDeps {
  readonly archive: MessageArchiveRepository;
  readonly facts: KnowledgeFactRepository;
  readonly summarizer: FactSummarizerPort;
  readonly now?: () => number;
}

export interface CurtainReport {
  readonly examined: number;
  readonly recorded: number;
  readonly rejected: number;
}

export async function runFactCurtain(deps: FactCurtainDeps): Promise<CurtainReport> {
  const now = deps.now?.() ?? Date.now();

  const pending = await deps.archive.pendingDistillation(CURTAIN_WINDOW_MS, CURTAIN_BATCH_SIZE);
  if (pending.length < CURTAIN_BATCH_SIZE) {
    return { examined: 0, recorded: 0, rejected: 0 };
  }

  const byId = new Map(pending.map((message) => [message.id, message]));

  let summarized: readonly { index: number; kind: string; summary: string }[];
  try {
    summarized = await deps.summarizer.summarize(
      pending.map((message) => ({ id: message.id, text: message.text })),
    );
  } catch (error) {
    logger.warn('Second rideau — modèle indisponible, le lot est marqué et le niveau 1 tient', {
      batch: pending.length,
      error: String(error),
    });
    await deps.archive.markDistilled([...byId.keys()], now);
    return { examined: pending.length, recorded: 0, rejected: 0 };
  }

  let recorded = 0;
  let rejected = 0;

  for (const candidate of summarized) {
    const source = pending[candidate.index - 1];

    if (!source) {
      rejected += 1;
      continue;
    }

    if (!KNOWN_KINDS.has(candidate.kind)) {
      rejected += 1;
      continue;
    }

    const safe = sanitizeNotificationBody(candidate.summary);
    const summary = safe.text.trim().slice(0, FACT_SUMMARY_MAX_CHARS);

    if (safe.redacted.length > 0 || safe.strippedUrls.length > 0) {
      logger.error('Second rideau — sortie du modèle assainie avant stockage', {
        redacted: safe.redacted,
        strippedUrls: safe.strippedUrls,
      });
    }

    if (summary.length === 0) {
      rejected += 1;
      continue;
    }

    try {
      await deps.facts.record({
        id: source.id,
        channelId: source.channelId,
        slackUserId: source.slackUserId,
        kind: candidate.kind as FactKind,
        summary,
        score: KNOWLEDGE_FACT_MIN_SCORE,
        postedAt: source.postedAt,
      });
      recorded += 1;
    } catch (error) {
      rejected += 1;
      logger.warn('Second rideau — fait non enregistré', { id: source.id, error: String(error) });
    }
  }

  await deps.archive.markDistilled([...byId.keys()], now);

  logger.info('Second rideau passé', { examined: pending.length, recorded, rejected });

  return { examined: pending.length, recorded, rejected };
}
