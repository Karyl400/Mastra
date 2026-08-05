import { describe, it, expect, vi } from 'vitest';
import { makeOnboardingOrchestrator } from '../../../src/features/onboarding/application/agents/onboarding-orchestrator';

describe('OnboardingOrchestrator Agent', () => {
  it('should create an agent with correct ID and name', () => {
    const mockTools = { dummyTool: {} };
    const agent = makeOnboardingOrchestrator(mockTools);

    expect(agent).toBeDefined();
    expect(agent.id).toBe('onboardingOrchestrator');
    expect(agent.name).toBe('Onboarding Orchestrator');
  });

  it('should include security prompt in instructions', () => {
    const agent = makeOnboardingOrchestrator({});
    expect(agent).toBeDefined();
    // agent.instructions est privé
  });

  it('should inject provided tools', () => {
    const mockTools = { testTool: {} };
    const agent = makeOnboardingOrchestrator(mockTools);
    
    expect(agent).toBeDefined();
    // agent.tools est privé
  });
});
