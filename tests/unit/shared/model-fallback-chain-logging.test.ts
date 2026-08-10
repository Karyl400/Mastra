import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { APICallError } from 'ai';

/**
 * Ces tests verrouillent le journalisation de la CHAÎNE COMPLÈTE des échecs
 * de `makeModelChain` — pas seulement l'erreur brute finale renvoyée au
 * client (déjà couverte par `model-fallback.test.ts`).
 *
 * Constat empirique (voir rapport) qui motive ce fichier : en pratique, le
 * log `Upstream LLM API error` émis par Mastra pour le DERNIER maillon
 * attribue parfois le `provider`/`modelId` du PREMIER maillon à l'erreur du
 * DERNIER — un log trompeur qui a fait perdre du temps en diagnostic. Ces
 * tests vérifient que `makeModelChain` journalise chaque échec de maillon,
 * de façon fiable et correctement attribuée, via `src/shared/logger`
 * (structuré, PII-masqué), indépendamment de la configuration du logger
 * Mastra au niveau de l'Agent.
 *
 * `@ai-sdk/groq` et `@ai-sdk/mistral` sont mockés ici pour piloter les
 * échecs sans appel réseau — mock local à ce fichier, sans effet sur
 * `model-fallback.test.ts` (registres de modules Vitest isolés par fichier).
 */

const calls: string[] = [];
let groqFailTimes = Infinity;
let mistralFailTimes = 0;

function makeControllableModel(modelId: string, provider: string, failTimesRef: () => number) {
  let attempts = 0;
  return {
    specificationVersion: 'v4' as const,
    provider,
    modelId,
    supportedUrls: {},
    async doGenerate() {
      calls.push(modelId);
      attempts += 1;
      if (attempts <= failTimesRef()) {
        throw new APICallError({
          message: `${provider} failure`,
          url: `https://${provider}.invalid/v1/chat`,
          requestBodyValues: {},
          statusCode: 429,
          isRetryable: true,
        });
      }
      return {
        content: [{ type: 'text' as const, text: `ok:${modelId}` }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error('doStream not used by generate()');
    },
  };
}

vi.mock('@ai-sdk/groq', () => ({
  createGroq: () => (modelId: string) => makeControllableModel(modelId, 'groq.chat', () => groqFailTimes),
}));

vi.mock('@ai-sdk/mistral', () => ({
  createMistral: () => (modelId: string) => makeControllableModel(modelId, 'mistral.chat', () => mistralFailTimes),
}));

describe('makeModelChain — journalisation de la chaîne complète des échecs', () => {
  beforeEach(() => {
    vi.stubEnv('GROQ_API_KEY', 'test-groq-key');
    vi.stubEnv('MISTRAL_API_KEY', 'test-mistral-key');
    calls.length = 0;
    groqFailTimes = Infinity;
    mistralFailTimes = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('journalise via src/shared/logger la panne du premier maillon, même quand le repli réussit', async () => {
    const { logger } = await import('../../../src/shared/logger');
    const errorSpy = vi.spyOn(logger, 'error');

    const { makeModelChain, PRIMARY_MODEL_ID } = await import('../../../src/shared/llm/model-fallback');

    const agent = new Agent({
      id: 'chainLoggingProbe',
      name: 'chainLoggingProbe',
      instructions: 'x',
      model: makeModelChain({ groqApiKey: 'g', mistralApiKey: 'm' }),
    });

    const result = await agent.generate('bonjour');

    expect(calls).toEqual(['llama-3.3-70b-versatile', 'mistral-large-latest']);
    expect(result.text).toBe('ok:mistral-large-latest');

    // La panne Groq doit être journalisée avec l'identifiant du maillon qui a
    // réellement échoué — pas celui d'un autre maillon de la chaîne.
    expect(errorSpy).toHaveBeenCalled();
    const loggedGroqFailure = errorSpy.mock.calls.find(
      (call) => JSON.stringify(call).includes(PRIMARY_MODEL_ID) && JSON.stringify(call).includes('llama-3.3-70b-versatile'),
    );
    expect(loggedGroqFailure).toBeDefined();
  });

  it('journalise la panne du DERNIER maillon aussi, quand toute la chaîne échoue', async () => {
    groqFailTimes = Infinity;
    mistralFailTimes = Infinity;

    const { logger } = await import('../../../src/shared/logger');
    const errorSpy = vi.spyOn(logger, 'error');

    const { makeModelChain, FALLBACK_MODEL_ID } = await import('../../../src/shared/llm/model-fallback');

    const agent = new Agent({
      id: 'chainLoggingExhaustedProbe',
      name: 'chainLoggingExhaustedProbe',
      instructions: 'x',
      model: makeModelChain({ groqApiKey: 'g', mistralApiKey: 'm' }),
    });

    await expect(agent.generate('bonjour')).rejects.toThrow();

    const loggedMistralFailure = errorSpy.mock.calls.find(
      (call) => JSON.stringify(call).includes(FALLBACK_MODEL_ID) && JSON.stringify(call).includes('mistral-large-latest'),
    );
    expect(loggedMistralFailure).toBeDefined();
  });

  it("n'appelle pas le logger d'échec quand le premier maillon réussit du premier coup", async () => {
    groqFailTimes = 0;

    const { logger } = await import('../../../src/shared/logger');
    const errorSpy = vi.spyOn(logger, 'error');

    const { makeModelChain } = await import('../../../src/shared/llm/model-fallback');

    const agent = new Agent({
      id: 'chainLoggingHappyProbe',
      name: 'chainLoggingHappyProbe',
      instructions: 'x',
      model: makeModelChain({ groqApiKey: 'g', mistralApiKey: 'm' }),
    });

    const result = await agent.generate('bonjour');

    expect(result.text).toBe('ok:llama-3.3-70b-versatile');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
