import { QuestionnaireStatus, ResponseStatus, type Timestamps } from '../../../../shared/types';

export interface Question {
  id: string;
  type: string;
  text: string;
  options?: string[];
  required: boolean;
}

export interface Questionnaire extends Timestamps {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly questions: Question[];
  readonly status: QuestionnaireStatus;
}

export interface QuestionnaireResponse extends Timestamps {
  readonly id: string;
  readonly questionnaireId: string;
  readonly employeeId: string;
  readonly answers: Record<string, unknown>;
  readonly status: ResponseStatus;
  readonly score?: number | null;
  readonly reviewedBy?: string | null;
  readonly submittedAt?: string | null;
}

export function createQuestionnaire(data: Omit<Questionnaire, keyof Timestamps | 'status'>): Questionnaire {
  const now = new Date().toISOString();
  return {
    ...data,
    status: QuestionnaireStatus.Draft,
    createdAt: now,
    updatedAt: now,
  };
}

export function createResponse(data: Omit<QuestionnaireResponse, keyof Timestamps | 'status'>): QuestionnaireResponse {
  const now = new Date().toISOString();
  return {
    ...data,
    status: ResponseStatus.Pending,
    createdAt: now,
    updatedAt: now,
  };
}
