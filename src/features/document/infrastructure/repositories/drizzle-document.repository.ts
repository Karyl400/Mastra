import { eq, isNull, and } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { documents } from '../../../../infrastructure/database/schema';
import type { Document } from '../../domain/entities/document';
import type { DocumentRepository } from '../../domain/ports/document.repository';

export class DrizzleDocumentRepository implements DocumentRepository {
  async save(document: Document): Promise<void> {
    const db = getDb();
    await db.insert(documents).values(toPersistence(document)).onConflictDoUpdate({
      target: documents.id,
      set: toPersistence(document),
    });
  }

  async update(document: Document): Promise<void> {
    await this.save(document);
  }

  async findById(id: string): Promise<Document | null> {
    const db = getDb();
    const row = await db.select().from(documents)
      .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
      .get();
    return row ? toDomain(row) : null;
  }

  async findByEmployee(employeeId: string): Promise<Document[]> {
    const db = getDb();
    const rows = await db.select().from(documents)
      .where(and(eq(documents.employeeId, employeeId), isNull(documents.deletedAt)));
    return rows.map(toDomain);
  }

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db.update(documents)
      .set({ deletedAt: new Date().toISOString() } as any)
      .where(eq(documents.id, id));
  }
}

// Mappers (à adapter selon la vraie entité Document)
function toDomain(row: typeof documents.$inferSelect): Document {
  return row as unknown as Document;
}

function toPersistence(doc: Document): typeof documents.$inferInsert {
  return doc as unknown as typeof documents.$inferInsert;
}