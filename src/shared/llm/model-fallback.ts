import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import type { ModelWithRetries } from '@mastra/core/agent';
import { logger as sharedLogger } from '../logger';

export const GROQ_MODEL_ID = 'openai/gpt-oss-120b';

export const MISTRAL_MODEL_ID = 'mistral-large-latest';

export const PRIMARY_MODEL_ID = `groq/${GROQ_MODEL_ID}`;

export const FALLBACK_MODEL_ID = `mistral/${MISTRAL_MODEL_ID}`;

export const LAST_RESORT_MAX_RETRIES = 1;

export function withChainFailureLogging<M extends object>(
  model: M,
  meta: { chainId: string; provider: string; modelId: string },
): M {
  return new Proxy(model, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if ((prop === 'doGenerate' || prop === 'doStream') && typeof value === 'function') {
        const original = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) =>
          Promise.resolve(original.apply(target, args)).catch((error: unknown) => {
            sharedLogger.error(`Maillon LLM en échec dans la chaîne de repli: ${meta.chainId}`, {
              chainId: meta.chainId,
              provider: meta.provider,
              modelId: meta.modelId,
              errorName: error instanceof Error ? error.name : typeof error,
              errorMessage: error instanceof Error ? error.message : String(error),
              statusCode:
                typeof error === 'object' && error !== null && 'statusCode' in error
                  ? (error as { statusCode?: unknown }).statusCode
                  : undefined,
            });
            throw error;
          });
      }
      return value;
    },
  });
}

export interface ModelChainDeps {
  groqApiKey?: string;
  mistralApiKey?: string;
}

export function makeModelChain(deps: ModelChainDeps = {}): ModelWithRetries[] {
  const groqApiKey = deps.groqApiKey ?? process.env.GROQ_API_KEY;
  const mistralApiKey = deps.mistralApiKey ?? process.env.MISTRAL_API_KEY;

  const chain: Omit<ModelWithRetries, 'maxRetries'>[] = [
    {
      id: PRIMARY_MODEL_ID,
      model: withChainFailureLogging(createGroq({ apiKey: groqApiKey })(GROQ_MODEL_ID), {
        chainId: PRIMARY_MODEL_ID,
        provider: 'groq',
        modelId: GROQ_MODEL_ID,
      }),
    },
  ];

  if (mistralApiKey) {
    chain.push({
      id: FALLBACK_MODEL_ID,
      model: withChainFailureLogging(createMistral({ apiKey: mistralApiKey })(MISTRAL_MODEL_ID), {
        chainId: FALLBACK_MODEL_ID,
        provider: 'mistral',
        modelId: MISTRAL_MODEL_ID,
      }),
    });
  }

  return chain.map((entry, index) => ({
    ...entry,
    maxRetries: index === chain.length - 1 ? LAST_RESORT_MAX_RETRIES : 0,
  }));
}

export const AGENT_GENERATE_TIMEOUT_MS = 40_000;
