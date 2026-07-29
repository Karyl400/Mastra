import { eq } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { questionnaireResponses } from '../../../../infrastructure/database/schema';
import { QuestionnaireResponse } from '../../domain/entities/questionnaire';
import { ResponseRepository } from '../../domain/ports/response.repository';

export class DrizzleResponseRepository implements ResponseRepository {
  async save(response: QuestionnaireResponse): Promise<void> {
    const db = getDb();
    await db.insert(questionnaireResponses).values({
      ...response,
      answers: response.answers as unknown as any,
    }).onConflictDoUpdate({
      target: questionnaireResponses.id,
      set: {
        ...response,
        answers: response.answers as unknown as any,
      }
    });
  }

  async update(response: QuestionnaireResponse): Promise<void> {
    await this.save(response);
  }

  async findById(id: string): Promise<QuestionnaireResponse | null> {
    const db = getDb();
    const result = await db.select().from(questionnaireResponses).where(eq(questionnaireResponses.id, id)).get();
    if (!result) return null;
    return result as unknown as QuestionnaireResponse;
  }

  async findByQuestionnaire(questionnaireId: string): Promise<QuestionnaireResponse[]> {
    const db = getDb();
    const result = await db.select().from(questionnaireResponses).where(eq(questionnaireResponses.questionnaireId, questionnaireId));
    return result as unknown as QuestionnaireResponse[];
  }

  async findByEmployee(employeeId: string): Promise<QuestionnaireResponse[]> {
    const db = getDb();
    const result = await db.select().from(questionnaireResponses).where(eq(questionnaireResponses.employeeId, employeeId));
    return result as unknown as QuestionnaireResponse[];
  }
}
