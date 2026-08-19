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

/**
 * ⚠️ La table `pending_interview_email` n'est PAS créée par les migrations `drizzle/` : elles
 * sont désynchronisées de `schema.ts` et `drizzle-kit push` se bloque contre une base
 * `libsql://` distante. DDL à appliquer à la main —
 * `scripts/ddl-pending-interview-email.sql`.
 */
export class DrizzlePendingInterviewEmailRepository implements PendingInterviewEmailRepository {
  constructor(private readonly resolveDb: () => DatabaseInstance = getDb) {}

  /**
   * ⚠️ UPSERT, jamais un simple INSERT : une seconde préparation dans la même conversation doit
   * REMPLACER la première. Deux lignes rendraient le « oui » de la personne ambigu, et elle
   * n'en voit qu'une à l'écran.
   */
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

  /**
   * ⚠️ LA SUPPRESSION EST LA PRISE, et son compte est le contrat. Deux « oui » traités par deux
   * instances ne peuvent pas envoyer deux fois : la seconde suppression rend 0, et l'appelant
   * renonce. Un `SELECT` puis un `DELETE` — la forme « naturelle » — rouvrirait cette course.
   * Même raisonnement que le `IS NULL` de `rememberDmChannel`.
   */
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
