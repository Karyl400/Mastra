import { eq } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { questionnaires } from '../../../../infrastructure/database/schema';
import { Questionnaire, Question } from '../../domain/entities/questionnaire';
import { QuestionnaireRepository } from '../../domain/ports/questionnaire.repository';

export class DrizzleQuestionnaireRepository implements QuestionnaireRepository {
  async save(questionnaire: Questionnaire): Promise<void> {
    const db = getDb();
    await db.insert(questionnaires).values({
      ...questionnaire,
      questions: questionnaire.questions as unknown as any,
    }).onConflictDoUpdate({
      target: questionnaires.id,
      set: {
        ...questionnaire,
        questions: questionnaire.questions as unknown as any,
      },
    });
  }

  async update(questionnaire: Questionnaire): Promise<void> {
    await this.save(questionnaire);
  }

  async findById(id: string): Promise<Questionnaire | null> {
    const db = getDb();
    const result = await db.select().from(questionnaires).where(eq(questionnaires.id, id)).get();
    if (!result) return null;
    return result as unknown as Questionnaire;
  }

  async findAll(): Promise<Questionnaire[]> {
    const db = getDb();
    const result = await db.select().from(questionnaires);
    return result as unknown as Questionnaire[];
  }
}
