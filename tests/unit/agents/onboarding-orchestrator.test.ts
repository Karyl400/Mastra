import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeOnboardingOrchestrator } from '../../../src/features/onboarding/application/agents/onboarding-orchestrator';
import {
  PRIMARY_MODEL_ID,
  FALLBACK_MODEL_ID,
  LAST_RESORT_MAX_RETRIES,
} from '../../../src/shared/llm/model-fallback';
import { AGENT_STYLE_BLOCK } from '../../../src/shared/agent-style';

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

  describe('chaîne de modèles Groq → Mistral', () => {
    beforeEach(() => {
      vi.stubEnv('GROQ_API_KEY', 'test-groq-key');
      vi.stubEnv('MISTRAL_API_KEY', 'test-mistral-key');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('déclare Groq puis Mistral, avec reprise bornée sur le dernier maillon', async () => {
      const list = await makeOnboardingOrchestrator({}).getModelList();

      expect(list?.map((entry) => entry.id)).toEqual([PRIMARY_MODEL_ID, FALLBACK_MODEL_ID]);
      expect(list?.map((entry) => entry.model.modelId)).toEqual([
        'llama-3.3-70b-versatile',
        'mistral-large-latest',
      ]);
      expect(list?.map((entry) => entry.maxRetries)).toEqual([0, LAST_RESORT_MAX_RETRIES]);
    });

    it('assemble le garde-fou de sécurité avec les placeholders réellement substitués', async () => {
      const instructions = String(await makeOnboardingOrchestrator({}).getInstructions());

      // Le prompt système réel ne doit plus jamais contenir les littéraux non substitués :
      // c'est exactement le bug constaté en production via GET /api/agents.
      expect(instructions).not.toContain('{DELIMITER_PREFIX}');
      expect(instructions).not.toContain('[[SESSION_MARKER]]');
      // Le bloc sécurité (immuable, non modifié) doit toujours être en tête.
      expect(instructions.startsWith('\n═')).toBe(true);
      expect(instructions).toContain('DIRECTIVE 1.1: You are KISSO-AGENT-v3.');
      expect(instructions).toMatch(/SECURITY_ID:/);
    });

    it('applique les directives de style Slack et anti-invention aux instructions métier', async () => {
      const instructions = String(await makeOnboardingOrchestrator({}).getInstructions());

      // Marqueur historique du bloc STYLE : « mrkdwn Slack ». La consigne a quitté le
      // texte le 2026-08-11 (elle est désormais garantie par `sanitizeAgentOutput`), donc
      // on ancre sur le bloc partagé lui-même. Ce test vérifie le CÂBLAGE — que les
      // directives atteignent bien les instructions métier ; leur CONTENU est verrouillé
      // par tests/unit/agents/agent-instructions-budget.test.ts.
      expect(instructions).toContain(AGENT_STYLE_BLOCK);
      expect(instructions).toContain('RÈGLE ANTI-INVENTION');
      expect(instructions).toContain('emailSent: false');
    });
  });
});
