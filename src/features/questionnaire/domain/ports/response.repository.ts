import type { QuestionnaireResponse } from '../entities/questionnaire';

export interface ResponseRepository {
  findById(id: string): Promise<QuestionnaireResponse | null>;
  findByQuestionnaire(questionnaireId: string): Promise<QuestionnaireResponse[]>;
  findByEmployee(employeeId: string): Promise<QuestionnaireResponse[]>;
  save(response: QuestionnaireResponse): Promise<void>;
  update(response: QuestionnaireResponse): Promise<void>;
}
