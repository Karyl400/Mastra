import type {
  PendingInterviewEmail,
  PendingInterviewEmailRepository,
} from '../../domain/ports/pending-email.repository';

/**
 * Doublure de test. Elle partage le CONTRAT de la version Drizzle, y compris le compte rendu
 * par `clear` — c'est ce qui garantit que les tests ne soient pas verts sur un comportement que
 * la production n'a pas. Le dépôt a payé cet écart le 2026-08-19 sur `linkEmployee`.
 */
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
