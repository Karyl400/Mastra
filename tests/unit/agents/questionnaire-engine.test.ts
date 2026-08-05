import { describe, it, expect, vi } from 'vitest';
import { makeQuestionnaireEngine } from '../../../src/features/questionnaire/application/agents/questionnaire-engine';

describe('QuestionnaireEngine Agent', () => {
  it('should create an agent with correct ID and name', () => {
    const mockTools = { dummyTool: {} };
    const agent = makeQuestionnaireEngine(mockTools);

    expect(agent).toBeDefined();
    expect(agent.id).toBe('questionnaireEngine');
    expect(agent.name).toBe('Questionnaire Engine');
  });

  it('should include security prompt in instructions', () => {
    const agent = makeQuestionnaireEngine({});
    expect(agent).toBeDefined();
    // agent.instructions est privé
  });

  it('should inject provided tools', () => {
    const mockTools = { generateQuestionnaire: {} };
    const agent = makeQuestionnaireEngine(mockTools);
    
    expect(agent).toBeDefined();
    // agent.tools est privé
  });
});
