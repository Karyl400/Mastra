import { eq } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { documents } from '../../../../infrastructure/database/schema';
import { Document } from '../../domain/entities/document';
import { DocumentRepository } from '../../domain/ports/document.repository';

export class DrizzleDocumentRepository implements DocumentRepository {
  async save(document: Document): Promise<void> {
    const db = getDb();
    await db.insert(documents).values(document).onConflictDoUpdate({
      target: documents.id,
      set: document,
    });
  }

  async update(document: Document): Promise<void> {
    await this.save(document);
  }

  async findById(id: string): Promise<Document | null> {
    const db = getDb();
    const result = await db.select().from(documents).where(eq(documents.id, id)).get();
    if (!result) return null;
    return result as Document;
  }

  async findByEmployee(employeeId: string): Promise<Document[]> {
    const db = getDb();
    const result = await db.select().from(documents).where(eq(documents.employeeId, employeeId));
    return result as Document[];
  }
}
