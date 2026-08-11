import { eq, isNull, and } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { documents } from '../../../../infrastructure/database/schema';
import type { Document } from '../../domain/entities/document';
import type { DocumentRepository } from '../../domain/ports/document.repository';
import { toDomainDocument, toPersistenceDocument } from './document.mapper';

export class DrizzleDocumentRepository implements DocumentRepository {
  async save(document: Document): Promise<void> {
    const db = getDb();
    const row = toPersistenceDocument(document);
    await db.insert(documents).values(row).onConflictDoUpdate({
      target: documents.id,
      set: row,
    });
  }

  async update(document: Document): Promise<void> {
    await this.save(document);
  }

  async findById(id: string): Promise<Document | null> {
    const db = getDb();
    const row = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
      .get();
    return row ? toDomainDocument(row) : null;
  }

  async findByEmployee(employeeId: string): Promise<Document[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(documents)
      .where(and(eq(documents.employeeId, employeeId), isNull(documents.deletedAt)));
    return rows.map(toDomainDocument);
  }

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(documents)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(documents.id, id));
  }
}
