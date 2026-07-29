import type { QuestionnaireResponse } from '../../domain/entities/questionnaire';
import type { ResponseRepository } from '../../domain/ports/response.repository';

export class InMemoryResponseRepository implements ResponseRepository {
  private store = new Map<string, QuestionnaireResponse>();

  async findById(id: string): Promise<QuestionnaireResponse | null> {
    return this.store.get(id) ?? null;
  }

  async findByQuestionnaire(questionnaireId: string): Promise<QuestionnaireResponse[]> {
    return Array.from(this.store.values()).filter(r => r.questionnaireId === questionnaireId);
  }

  async findByEmployee(employeeId: string): Promise<QuestionnaireResponse[]> {
    return Array.from(this.store.values()).filter(r => r.employeeId === employeeId);
  }

  async save(r: QuestionnaireResponse): Promise<void> {
    this.store.set(r.id, r);
  }

  async update(r: QuestionnaireResponse): Promise<void> {
    this.store.set(r.id, r);
  }
}
