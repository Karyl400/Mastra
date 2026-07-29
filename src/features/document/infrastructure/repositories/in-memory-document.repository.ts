import type { Document } from '../../domain/entities/document';
import type { DocumentRepository } from '../../domain/ports/document.repository';

export class InMemoryDocumentRepository implements DocumentRepository {
  private store = new Map<string, Document>();

  async findById(id: string): Promise<Document | null> {
    return this.store.get(id) ?? null;
  }

  async findByEmployee(employeeId: string): Promise<Document[]> {
    return Array.from(this.store.values()).filter(d => d.employeeId === employeeId);
  }

  async save(d: Document): Promise<void> {
    this.store.set(d.id, d);
  }

  async update(d: Document): Promise<void> {
    this.store.set(d.id, d);
  }
}
