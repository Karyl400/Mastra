import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import type { ModelWithRetries } from '@mastra/core/agent';
import { logger as sharedLogger } from '../logger';

/**
 * ⚠️ `gemini-3.7-flash` a été essayé PUIS ÉCARTÉ le 2026-08-21, sur mesure et non sur
 * intuition : 2 réponses `503 high demand` sur 6 en local, et deux échecs réels en
 * production dès la première campagne (« This model is currently experiencing high
 * demand »). La chaîne rattrapait — Groq répondait — mais c'est exactement le mode de panne
 * de `llama-3.3-70b-versatile` : le bot répond, et chaque message paie un aller-retour perdu.
 *
 * Relevé comparatif, 6 requêtes par modèle :
 *   gemini-3.5-flash     6/6      ← retenu
 *   gemini-3.6-flash     5/6      (1 dépassement de délai)
 *   gemini-3.7-flash     4/6      (2× 503)
 *   gemini-flash-latest  1/6      (3× 429, 2× 503)
 *
 * Les deux retenus appellent les outils, vérifié par une requête portant un vrai schéma —
 * le test qui avait écarté `qwen/qwen3.6-27b` le 2026-08-15.
 */
export const DEFAULT_GEMINI_MODEL_ID = 'gemini-3.5-flash';

export const DEFAULT_GROQ_MODEL_ID = 'openai/gpt-oss-120b';

export const DEFAULT_MISTRAL_MODEL_ID = 'mistral-large-latest';

export interface ResolvedModelIds {
  readonly gemini: string;
  readonly groq: string;
  readonly mistral: string;
  readonly primary: string;
  readonly fallback: string;
  readonly lastResort: string;
}

export function resolveModelIds(env: NodeJS.ProcessEnv = process.env): ResolvedModelIds {
  const gemini = env.GEMINI_MODEL_ID?.trim() || DEFAULT_GEMINI_MODEL_ID;
  const groq = env.GROQ_MODEL_ID?.trim() || DEFAULT_GROQ_MODEL_ID;
  const mistral = env.MISTRAL_MODEL_ID?.trim() || DEFAULT_MISTRAL_MODEL_ID;

  return {
    gemini,
    groq,
    mistral,
    primary: `google/${gemini}`,
    fallback: `groq/${groq}`,
    lastResort: `mistral/${mistral}`,
  };
}

export const {
  gemini: GEMINI_MODEL_ID,
  groq: GROQ_MODEL_ID,
  mistral: MISTRAL_MODEL_ID,
  primary: PRIMARY_MODEL_ID,
  fallback: FALLBACK_MODEL_ID,
  lastResort: LAST_RESORT_MODEL_ID,
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
  geminiApiKey?: string;
  groqApiKey?: string;
  mistralApiKey?: string;
}

export function makeModelChain(deps: ModelChainDeps = {}): ModelWithRetries[] {
  const geminiApiKey = deps.geminiApiKey ?? process.env.GOOGLE_GEMINI_API_KEY;
  const groqApiKey = deps.groqApiKey ?? process.env.GROQ_API_KEY;
  const mistralApiKey = deps.mistralApiKey ?? process.env.MISTRAL_API_KEY;
  const ids = resolveModelIds();

  const chain: Omit<ModelWithRetries, 'maxRetries'>[] = [];

  if (geminiApiKey) {
    chain.push({
      id: ids.primary,
      model: withChainFailureLogging(
        createGoogleGenerativeAI({ apiKey: geminiApiKey })(ids.gemini),
        { chainId: ids.primary, provider: 'google', modelId: ids.gemini },
      ),
    });
  }

  if (groqApiKey) {
    chain.push({
      id: ids.fallback,
      model: withChainFailureLogging(createGroq({ apiKey: groqApiKey })(ids.groq), {
        chainId: ids.fallback,
        provider: 'groq',
        modelId: ids.groq,
      }),
    });
  }

  if (mistralApiKey) {
    chain.push({
      id: ids.lastResort,
      model: withChainFailureLogging(createMistral({ apiKey: mistralApiKey })(ids.mistral), {
        chainId: ids.lastResort,
        provider: 'mistral',
        modelId: ids.mistral,
      }),
    });
  }

  if (chain.length === 0) {
    // ⚠️ On ne LÈVE PAS, et c'est délibéré. Ce module est évalué à la construction de chaque
    // agent, donc lever ferait exploser le câblage entier — y compris dans neuf fichiers de
    // tests qui ne testent pas la configuration LLM. Le contrat d'avant le 2026-08-20 était
    // déjà « la chaîne n'est jamais vide » : Groq y était poussé sans regarder sa clé.
    //
    // Ce qui change est la LISIBILITÉ : sans cette ligne, la panne se présente comme un 401
    // du fournisseur, à des étages de distance de sa cause.
    sharedLogger.error(
      'Aucun fournisseur LLM configuré — pose GOOGLE_GEMINI_API_KEY, GROQ_API_KEY ou ' +
        'MISTRAL_API_KEY. La chaîne est construite sur le primaire, qui échouera en 401.',
      { gemini: false, groq: false, mistral: false },
    );

    chain.push({
      id: ids.primary,
      model: withChainFailureLogging(createGoogleGenerativeAI({ apiKey: '' })(ids.gemini), {
        chainId: ids.primary,
        provider: 'google',
        modelId: ids.gemini,
      }),
    });
  }

  return chain.map((entry, index) => ({
    ...entry,
    maxRetries: index === chain.length - 1 ? LAST_RESORT_MAX_RETRIES : 0,
  }));
}

export const AGENT_GENERATE_TIMEOUT_MS = 40_000;
