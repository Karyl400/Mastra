import type { Questionnaire } from '../entities/questionnaire';

export interface QuestionnaireRepository {
  findById(id: string): Promise<Questionnaire | null>;
  findAll(): Promise<Questionnaire[]>;
  save(questionnaire: Questionnaire): Promise<void>;
  update(questionnaire: Questionnaire): Promise<void>;
}
