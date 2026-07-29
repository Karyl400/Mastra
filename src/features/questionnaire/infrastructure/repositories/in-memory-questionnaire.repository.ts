import type { Questionnaire } from '../../domain/entities/questionnaire';
import type { QuestionnaireRepository } from '../../domain/ports/questionnaire.repository';

export class InMemoryQuestionnaireRepository implements QuestionnaireRepository {
  private store = new Map<string, Questionnaire>();

  async findById(id: string): Promise<Questionnaire | null> {
    return this.store.get(id) ?? null;
  }

  async findAll(): Promise<Questionnaire[]> {
    return Array.from(this.store.values());
  }

  async save(q: Questionnaire): Promise<void> {
    this.store.set(q.id, q);
  }

  async update(q: Questionnaire): Promise<void> {
    this.store.set(q.id, q);
  }
}
