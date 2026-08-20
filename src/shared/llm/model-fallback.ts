import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import type { ModelWithRetries } from '@mastra/core/agent';
import { logger as sharedLogger } from '../logger';

export const DEFAULT_GROQ_MODEL_ID = 'openai/gpt-oss-120b';

export const DEFAULT_MISTRAL_MODEL_ID = 'mistral-large-latest';

export interface ResolvedModelIds {
  readonly groq: string;
  readonly mistral: string;
  readonly primary: string;
  readonly fallback: string;
}

export function resolveModelIds(env: NodeJS.ProcessEnv = process.env): ResolvedModelIds {
  const groq = env.GROQ_MODEL_ID?.trim() || DEFAULT_GROQ_MODEL_ID;
  const mistral = env.MISTRAL_MODEL_ID?.trim() || DEFAULT_MISTRAL_MODEL_ID;
  return {
    groq,
    mistral,
    primary: `groq/${groq}`,
    fallback: `mistral/${mistral}`,
  };
}

export const {
  groq: GROQ_MODEL_ID,
  mistral: MISTRAL_MODEL_ID,
  primary: PRIMARY_MODEL_ID,
  fallback: FALLBACK_MODEL_ID,
} = resolveModelIds();

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
  const ids = resolveModelIds();

  const chain: Omit<ModelWithRetries, 'maxRetries'>[] = [
    {
      id: ids.primary,
      model: withChainFailureLogging(createGroq({ apiKey: groqApiKey })(ids.groq), {
        chainId: ids.primary,
        provider: 'groq',
        modelId: ids.groq,
      }),
    },
  ];

  if (mistralApiKey) {
    chain.push({
      id: ids.fallback,
      model: withChainFailureLogging(createMistral({ apiKey: mistralApiKey })(ids.mistral), {
        chainId: ids.fallback,
        provider: 'mistral',
        modelId: ids.mistral,
      }),
    });
  }

  return chain.map((entry, index) => ({
    ...entry,
    maxRetries: index === chain.length - 1 ? LAST_RESORT_MAX_RETRIES : 0,
  }));
}

export const AGENT_GENERATE_TIMEOUT_MS = 40_000;
