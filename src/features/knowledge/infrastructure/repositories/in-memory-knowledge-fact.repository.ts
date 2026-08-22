import type {
  KnowledgeFact,
  KnowledgeFactRepository,
  KnowledgeFactSearchOptions,
} from '../../domain/ports/knowledge-fact.repository';
import { matchedTermCount, queryTerms } from '../../domain/services/text-search';
import type { ForgetScope } from '../../domain/ports/message-archive.repository';

const DEFAULT_LIMIT = 12;

export class InMemoryKnowledgeFactRepository implements KnowledgeFactRepository {
  private readonly rows = new Map<string, KnowledgeFact>();

  async record(fact: KnowledgeFact): Promise<boolean> {
    if (this.rows.has(fact.id)) return false;
    this.rows.set(fact.id, fact);
    return true;
  }

  async search(query: string, options: KnowledgeFactSearchOptions = {}): Promise<KnowledgeFact[]> {
    if (queryTerms(query).length === 0) return [];

    return this.scoped(options)
      .map((row) => ({ row, matched: matchedTermCount(row.summary, query) }))
      .filter((entry) => entry.matched > 0)
      .sort(
        (a, b) =>
          b.matched - a.matched || b.row.score - a.row.score || b.row.postedAt - a.row.postedAt,
      )
      .slice(0, options.limit ?? DEFAULT_LIMIT)
      .map((entry) => entry.row);
  }

  async recent(options: KnowledgeFactSearchOptions = {}): Promise<KnowledgeFact[]> {
    return this.scoped(options)
      .sort((a, b) => b.postedAt - a.postedAt)
      .slice(0, options.limit ?? DEFAULT_LIMIT);
  }

  async forgetUser(scope: ForgetScope): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (row.slackUserId !== scope.slackUserId) continue;
      if (scope.channelId !== undefined && row.channelId !== scope.channelId) continue;
      this.rows.delete(id);
      removed += 1;
    }
    return removed;
  }

  async pruneOlderThan(cutoffMs: number): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (row.postedAt < cutoffMs) {
        this.rows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  private scoped(options: KnowledgeFactSearchOptions): KnowledgeFact[] {
    return [...this.rows.values()]
      .filter((row) => !options.channelId || row.channelId === options.channelId)
      .filter((row) => !options.slackUserId || row.slackUserId === options.slackUserId);
  }

  get size(): number {
    return this.rows.size;
  }
}
