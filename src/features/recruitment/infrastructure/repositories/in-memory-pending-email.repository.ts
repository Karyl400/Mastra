import type {
  PendingInterviewEmail,
  PendingInterviewEmailRepository,
} from '../../domain/ports/pending-email.repository';

export class InMemoryPendingInterviewEmailRepository implements PendingInterviewEmailRepository {
  private readonly rows = new Map<string, PendingInterviewEmail>();

  async save(pending: PendingInterviewEmail): Promise<void> {
    this.rows.set(pending.conversationId, pending);
  }

  async find(conversationId: string): Promise<PendingInterviewEmail | null> {
    return this.rows.get(conversationId) ?? null;
  }

  async clear(conversationId: string): Promise<number> {
    return this.rows.delete(conversationId) ? 1 : 0;
  }
}
