import { eq } from 'drizzle-orm';

import { getDb, type DatabaseInstance } from '../../../../infrastructure/database/connection';
import {
  pendingInterviewEmail,
  type PendingInterviewEmailRow,
} from '../../../../infrastructure/database/schema';
import type {
  PendingInterviewEmail,
  PendingInterviewEmailRepository,
} from '../../domain/ports/pending-email.repository';

export class DrizzlePendingInterviewEmailRepository implements PendingInterviewEmailRepository {
  constructor(private readonly resolveDb: () => DatabaseInstance = getDb) {}

  async save(pending: PendingInterviewEmail): Promise<void> {
    const db = this.resolveDb();
    const values = {
      conversationId: pending.conversationId,
      requesterUserId: pending.requesterUserId,
      to: pending.to,
      candidateName: pending.candidateName ?? null,
      startsAt: pending.startsAt,
      position: pending.position ?? null,
      location: pending.location ?? null,
      replyTo: pending.replyTo ?? null,
      createdAt: pending.createdAt,
    };

    await db
      .insert(pendingInterviewEmail)
      .values(values)
      .onConflictDoUpdate({ target: pendingInterviewEmail.conversationId, set: values });
  }

  async find(conversationId: string): Promise<PendingInterviewEmail | null> {
    const db = this.resolveDb();
    const row = await db
      .select()
      .from(pendingInterviewEmail)
      .where(eq(pendingInterviewEmail.conversationId, conversationId))
      .get();

    return row ? toDomain(row) : null;
  }

  async clear(conversationId: string): Promise<number> {
    const db = this.resolveDb();
    const result = await db
      .delete(pendingInterviewEmail)
      .where(eq(pendingInterviewEmail.conversationId, conversationId));

    return Number((result as { rowsAffected?: number }).rowsAffected ?? 0);
  }
}

function toDomain(row: PendingInterviewEmailRow): PendingInterviewEmail {
  return {
    conversationId: row.conversationId,
    requesterUserId: row.requesterUserId,
    to: row.to,
    candidateName: row.candidateName,
    startsAt: row.startsAt,
    position: row.position,
    location: row.location,
    replyTo: row.replyTo,
    createdAt: row.createdAt,
  };
}
