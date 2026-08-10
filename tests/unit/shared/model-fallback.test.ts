import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { APICallError } from 'ai';
import {
  makeModelChain,
  PRIMARY_MODEL_ID,
  FALLBACK_MODEL_ID,
  LAST_RESORT_MAX_RETRIES,
} from '../../../src/shared/llm/model-fallback';

/**
 * Fabrique un LanguageModel v4 factice — la version de spécification que
 * `@ai-sdk/groq` 4.x et `@ai-sdk/mistral` exposent réellement, et l'une des
 * seules acceptées par `assertSupportsPreparedModels` de Mastra pour un
 * tableau de modèles.
 *
 * `generate()` passe par `doGenerate`, pas par `doStream`.
 */
function makeFakeModel(options: {
  modelId: string;
  /** Nombre d'appels initiaux qui échouent en 429 avant de réussir. `Infinity` = échoue toujours. */
  failTimes: number;
  /** Message porté par l'`APICallError` 429. */
  message?: string;
  /** Journal partagé des appels, dans l'ordre. */
  calls: string[];
}) {
  let attempts = 0;
  return {
    specificationVersion: 'v4' as const,
    provider: 'fake',
    modelId: options.modelId,
    supportedUrls: {},
    async doGenerate() {
      options.calls.push(options.modelId);
      attempts += 1;
      if (attempts <= options.failTimes) {
        throw new APICallError({
          message: options.message ?? 'Rate limit exceeded',
          url: 'https://fake.invalid/v1/chat',
          requestBodyValues: {},
          statusCode: 429,
          isRetryable: true,
        });
      }
      return {
        content: [{ type: 'text' as const, text: `ok:${options.modelId}` }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error('doStream not used by generate()');
    },
  } as never;
}

describe('makeModelChain — configuration de la chaîne de repli', () => {
  beforeEach(() => {
    vi.stubEnv('GROQ_API_KEY', 'test-groq-key');
    vi.stubEnv('MISTRAL_API_KEY', 'test-mistral-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('expose Groq en primaire puis Mistral en repli, dans cet ordre', () => {
    const chain = makeModelChain({ groqApiKey: 'g', mistralApiKey: 'm' });

    expect(chain).toHaveLength(2);
    expect(chain[0]?.id).toBe(PRIMARY_MODEL_ID);
    expect(chain[1]?.id).toBe(FALLBACK_MODEL_ID);
  });

  it('donne des identifiants stables et déterministes (pas de randomUUID)', () => {
    const a = makeModelChain({ groqApiKey: 'g', mistralApiKey: 'm' });
    const b = makeModelChain({ groqApiKey: 'g', mistralApiKey: 'm' });

    expect(a.map((entry) => entry.id)).toEqual(b.map((entry) => entry.id));
  });

  it("n'accorde un budget de reprise qu'au DERNIER maillon", () => {
    const chain = makeModelChain({ groqApiKey: 'g', mistralApiKey: 'm' });

    // Basculer vers un autre fournisseur coûte moins cher que patienter sur
    // celui qui vient d'annoncer un quota épuisé.
    expect(chain[0]?.maxRetries).toBe(0);
    // Plus rien vers quoi basculer : reprise bornée en dernière défense.
    expect(chain[1]?.maxRetries).toBe(LAST_RESORT_MAX_RETRIES);
    expect(LAST_RESORT_MAX_RETRIES).toBeGreaterThan(0);
  });

  it('omet Mistral sans MISTRAL_API_KEY et transfère le budget de reprise à Groq', () => {
    vi.stubEnv('MISTRAL_API_KEY', '');
    const chain = makeModelChain({ groqApiKey: 'g' });

    // Un maillon sans identifiants masquerait l'erreur réelle du primaire,
    // puisque c'est l'erreur du DERNIER modèle qui est renvoyée au client.
    expect(chain).toHaveLength(1);
    expect(chain[0]?.id).toBe(PRIMARY_MODEL_ID);
    expect(chain[0]?.maxRetries).toBe(LAST_RESORT_MAX_RETRIES);
  });

  it('lit les clés depuis process.env par défaut', () => {
    expect(makeModelChain()).toHaveLength(2);

    vi.stubEnv('MISTRAL_API_KEY', '');
    expect(makeModelChain()).toHaveLength(1);
  });

  it('résout des modèles Mastra exploitables via getModelList()', async () => {
    const agent = new Agent({
      id: 'chainProbe',
      name: 'chainProbe',
      instructions: 'x',
      model: makeModelChain({ groqApiKey: 'g', mistralApiKey: 'm' }),
    });

    const list = await agent.getModelList();

    expect(list?.map((entry) => entry.id)).toEqual([PRIMARY_MODEL_ID, FALLBACK_MODEL_ID]);
    expect(list?.map((entry) => entry.model.modelId)).toEqual([
      'llama-3.3-70b-versatile',
      'mistral-large-latest',
    ]);
    expect(list?.map((entry) => entry.maxRetries)).toEqual([0, LAST_RESORT_MAX_RETRIES]);
    expect(list?.every((entry) => entry.enabled)).toBe(true);
  });
});

/**
 * Ces tests vérifient le comportement RÉEL du moteur de repli de Mastra 1.57 en
 * injectant des modèles factices qui échouent — pas seulement la forme de la
 * configuration. Ils verrouillent les invariants sur lesquels repose
 * `makeModelChain`.
 */
describe('Moteur de repli Mastra — sémantique observée', () => {
  it('bascule sur le modèle suivant quand le primaire renvoie un 429', async () => {
    const calls: string[] = [];
    const agent = new Agent({
      id: 'failoverProbe',
      name: 'failoverProbe',
      instructions: 'x',
      model: [
        { id: 'primary', model: makeFakeModel({ modelId: 'primary', failTimes: Infinity, calls }), maxRetries: 0 },
        { id: 'fallback', model: makeFakeModel({ modelId: 'fallback', failTimes: 0, calls }), maxRetries: 0 },
      ],
    });

    const result = await agent.generate('bonjour');

    // Un 429 déclenche bien le basculement : le repli n'est PAS filtré par
    // classe d'erreur dans cette version.
    expect(calls).toEqual(['primary', 'fallback']);
    expect(result.text).toBe('ok:fallback');
  });

  it("remonte l'erreur BRUTE du dernier modèle quand toute la chaîne échoue", async () => {
    const calls: string[] = [];
    const agent = new Agent({
      id: 'exhaustedProbe',
      name: 'exhaustedProbe',
      instructions: 'x',
      model: [
        {
          id: 'primary',
          model: makeFakeModel({ modelId: 'primary', failTimes: Infinity, message: 'Groq quota', calls }),
          maxRetries: 0,
        },
        {
          id: 'fallback',
          model: makeFakeModel({ modelId: 'fallback', failTimes: Infinity, message: 'Rate limit exceeded', calls }),
          maxRetries: 0,
        },
      ],
    });

    // Reproduit le symptôme déployé : le message renvoyé est celui du DERNIER
    // maillon, sans encapsulation « Exhausted all fallback models ».
    await expect(agent.generate('bonjour')).rejects.toThrow('Rate limit exceeded');
    expect(calls).toEqual(['primary', 'fallback']);
  });

  it('maxRetries > 0 fait bien reprendre un 429 transitoire sur le dernier maillon', async () => {
    const calls: string[] = [];
    const agent = new Agent({
      id: 'retryProbe',
      name: 'retryProbe',
      instructions: 'x',
      model: [
        {
          id: 'only',
          model: makeFakeModel({ modelId: 'only', failTimes: 1, calls }),
          maxRetries: LAST_RESORT_MAX_RETRIES,
        },
      ],
    });

    const result = await agent.generate('bonjour');

    expect(calls).toEqual(['only', 'only']);
    expect(result.text).toBe('ok:only');
  });

  it('maxRetries à 0 abandonne dès le premier 429 (comportement par défaut de Mastra)', async () => {
    const calls: string[] = [];
    const agent = new Agent({
      id: 'noRetryProbe',
      name: 'noRetryProbe',
      instructions: 'x',
      model: [
        { id: 'only', model: makeFakeModel({ modelId: 'only', failTimes: 1, calls }), maxRetries: 0 },
      ],
    });

    await expect(agent.generate('bonjour')).rejects.toThrow('Rate limit exceeded');
    expect(calls).toEqual(['only']);
  });
});
