import type {
  ArchivedMessage,
  MessageArchiveRepository,
  MessageSearchOptions,
} from '../../domain/ports/message-archive.repository';
import { matchedTermCount, queryTerms } from '../../domain/services/text-search';

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

  async forgetUser(slackUserId: string): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (row.slackUserId === slackUserId) {
        this.rows.delete(id);
        removed += 1;
      }
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

  get size(): number {
    return this.rows.size;
  }
}
