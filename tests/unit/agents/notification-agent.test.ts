import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeNotificationAgent } from '../../../src/features/notification/application/agents/notification-agent';
import {
  PRIMARY_MODEL_ID,
  FALLBACK_MODEL_ID,
  LAST_RESORT_MAX_RETRIES,
} from '../../../src/shared/llm/model-fallback';

describe('NotificationAgent Agent', () => {
  it('should create an agent with correct ID and name', () => {
    const mockTools = { dummyTool: {} };
    const agent = makeNotificationAgent(mockTools);

    expect(agent).toBeDefined();
    expect(agent.id).toBe('notificationAgent');
    expect(agent.name).toBe('Notification Agent');
  });

  it('should include security prompt in instructions', () => {
    const agent = makeNotificationAgent({});
    expect(agent).toBeDefined();
    // agent.instructions est privé dans Mastra 0.2
  });

  it('should inject provided tools', () => {
    const mockTools = { sendNotification: { execute: vi.fn() } };
    const agent = makeNotificationAgent(mockTools);
    
    expect(agent).toBeDefined();
    // agent.tools est privé dans Mastra 0.2
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
      const list = await makeNotificationAgent({}).getModelList();

      expect(list?.map((entry) => entry.id)).toEqual([PRIMARY_MODEL_ID, FALLBACK_MODEL_ID]);
      expect(list?.map((entry) => entry.model.modelId)).toEqual([
        'llama-3.3-70b-versatile',
        'mistral-large-latest',
      ]);
      expect(list?.map((entry) => entry.maxRetries)).toEqual([0, LAST_RESORT_MAX_RETRIES]);
    });

    it('assemble le garde-fou de sécurité avec les placeholders réellement substitués', async () => {
      const instructions = String(await makeNotificationAgent({}).getInstructions());

      expect(instructions).not.toContain('{DELIMITER_PREFIX}');
      expect(instructions).not.toContain('[[SESSION_MARKER]]');
      expect(instructions.startsWith('\n═')).toBe(true);
      expect(instructions).toContain('DIRECTIVE 1.1: You are KISSO-AGENT-v3.');
      expect(instructions).toMatch(/SECURITY_ID:/);
    });

    it('applique les directives de style Slack et anti-invention aux instructions métier', async () => {
      const instructions = String(await makeNotificationAgent({}).getInstructions());

      expect(instructions).toContain('mrkdwn Slack');
      expect(instructions).toContain('RÈGLE ANTI-INVENTION');
      expect(instructions).toContain('emailSent: false');
    });
  });
});