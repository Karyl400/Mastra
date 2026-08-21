import type {
  ArchivedMessage,
  MessageArchiveRepository,
  MessageSearchOptions,
} from '../../domain/ports/message-archive.repository';
import { matchedTermCount, queryTerms } from '../../domain/services/text-search';
import type { ForgetScope } from '../../domain/ports/message-archive.repository';

const DEFAULT_LIMIT = 20;

export class InMemoryMessageArchiveRepository implements MessageArchiveRepository {
  private readonly rows = new Map<string, ArchivedMessage>();

  async archive(message: ArchivedMessage): Promise<boolean> {
    if (this.rows.has(message.id)) return false;
    this.rows.set(message.id, message);
    return true;
  }

  async search(query: string, options: MessageSearchOptions = {}): Promise<ArchivedMessage[]> {
    if (queryTerms(query).length === 0) return [];

    return [...this.rows.values()]
      .filter((row) => !options.channelId || row.channelId === options.channelId)
      .filter((row) => !options.slackUserId || row.slackUserId === options.slackUserId)
      .map((row) => ({ row, matched: matchedTermCount(row.text, query) }))
      .filter((entry) => entry.matched > 0)
      .sort((a, b) => b.matched - a.matched || b.row.postedAt - a.row.postedAt)
      .slice(0, options.limit ?? DEFAULT_LIMIT)
      .map((entry) => entry.row);
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

  async prune(before: number): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (row.postedAt < before) {
        this.rows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  // ⚠️ La marque vit à côté des lignes, jamais dedans : `ArchivedMessage` est le contrat du
  // domaine, et y ajouter un champ d'intendance le ferait fuir dans tout ce qui le lit.
  private readonly distilled = new Map<string, number>();

  async pendingDistillation(sinceMs: number, limit: number): Promise<readonly ArchivedMessage[]> {
    const floor = Date.now() - sinceMs;
    return [...this.rows.values()]
      .filter((row) => !this.distilled.has(row.id) && row.postedAt >= floor)
      .sort((a, b) => a.postedAt - b.postedAt)
      .slice(0, limit);
  }

  async markDistilled(ids: readonly string[], at: number): Promise<number> {
    let marked = 0;
    for (const id of ids) {
      if (!this.rows.has(id)) continue;
      this.distilled.set(id, at);
      marked += 1;
    }
    return marked;
  }

  get size(): number {
    return this.rows.size;
  }
}
