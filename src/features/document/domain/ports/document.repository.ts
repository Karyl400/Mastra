import type { Document } from '../entities/document';

export interface DocumentRepository {
  findById(id: string): Promise<Document | null>;
  findByEmployee(employeeId: string): Promise<Document[]>;
  save(document: Document): Promise<void>;
  update(document: Document): Promise<void>;
}
