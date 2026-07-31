import type { Document } from '../../domain/entities/document';
import type { DocumentRepository } from '../../domain/ports/document.repository';

export class InMemoryDocumentRepository implements DocumentRepository {
  private store = new Map<string, Document>();

  async findById(id: string): Promise<Document | null> {
    const doc = this.store.get(id);
    return doc ? { ...doc } : null;           // ✅ défensive copy
  }

  async findByEmployee(employeeId: string): Promise<Document[]> {
    return Array.from(this.store.values())
      .filter(d => d.employeeId === employeeId)
      .map(d => ({ ...d }));                   // ✅ défensive copy
  }

  async save(d: Document): Promise<void> {
    this.store.set(d.id, { ...d });            // ✅ stocke une copie
  }

  async delete(id: string): Promise<void> {    // ✅ ajouté
    this.store.delete(id);
  }

  clear(): void {                              // ✅ utilitaire tests
    this.store.clear();
  }
}