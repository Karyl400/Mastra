import { describe, it, expect } from 'vitest';
import { createQuestionnaire, createResponse } from '../../../src/features/questionnaire/domain/entities/questionnaire';
import { QuestionnaireStatus, ResponseStatus } from '../../../src/shared/types';

describe('Domain: Questionnaire', () => {

  describe('createQuestionnaire', () => {
    it('221. should create a questionnaire in Draft status', () => {
      const q = createQuestionnaire({
        id: 'q-1',
        title: 'Security 101',
        description: 'Basic security training',
        questions: [
          { id: 'q-1-1', type: 'text', text: 'What is phishing?', required: true }
        ]
      });

      expect(q.id).toBe('q-1');
      expect(q.status).toBe(QuestionnaireStatus.Draft);
      expect(q.createdAt).toBeDefined();
    });
  });

  describe('createResponse', () => {
    it('222. should not allow prototype pollution via answers Record<string, unknown>', () => {
      // The user raised a point about Record<string, unknown> allowing prototype pollution
      // Let's write a test that simulates a malicious payload
      const maliciousPayload = JSON.parse('{"__proto__":{"polluted":true}, "answer1":"test"}');
      
      const response = createResponse({
        id: 'resp-1',
        questionnaireId: 'q-1',
        employeeId: 'emp-1',
        answers: maliciousPayload
      });

      // If the domain doesn't sanitize the Record, this might fail (or pollute the object)
      expect((response.answers as any).polluted).toBeUndefined();
      expect(({} as any).polluted).toBeUndefined();
    });
  });

});
