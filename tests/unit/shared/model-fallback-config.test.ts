import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * Les identifiants de modèle viennent de l'environnement, et l'étiquette en DÉRIVE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le 2026-08-15, `llama-3.3-70b-versatile` a disparu du compte Groq (404
 * `model_not_found`). Le bot répondait quand même — la chaîne de repli faisait son travail —
 * mais chaque message payait un aller-retour Groq perdu avant de tomber chez Mistral et ses
 * 4 requêtes/minute. Changer de modèle a demandé un commit, un build et un déploiement.
 *
 * Deux propriétés sont vérifiées ici, et la SECONDE est celle qui compte :
 *
 * 1. Les identifiants sont lus depuis `GROQ_MODEL_ID` / `MISTRAL_MODEL_ID`, littéral actuel
 *    en défaut. Un modèle mort se remplace désormais par une variable d'environnement.
 *
 * 2. `PRIMARY_MODEL_ID` / `FALLBACK_MODEL_ID` et le modèle RÉELLEMENT demandé sortent d'une
 *    SEULE résolution. C'est exactement ce qui avait laissé un modèle mort survivre : la
 *    doctrine du dépôt veut qu'une étiquette et la valeur qu'elle nomme ne soient jamais
 *    deux littéraux séparés. Un test qui vérifierait seulement le défaut laisserait
 *    repasser ce défaut-là.
 *
 * ⚠️ `vi.resetModules()` + import dynamique : les constantes exportées sont évaluées à
 * l'import du module. Les lire une fois pour toutes en tête de fichier rendrait la
 * surcharge d'environnement invérifiable.
 */

const ENV_KEYS = [
  'GEMINI_MODEL_ID',
  'GROQ_MODEL_ID',
  'MISTRAL_MODEL_ID',
  'GOOGLE_GEMINI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
] as const;

const MODULE_PATH = '../../../src/shared/llm/model-fallback';

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

async function load() {
  return import(MODULE_PATH);
}

describe('identifiants de modèle', () => {
  describe('défauts', () => {
    it('retombe sur les littéraux actuels quand rien n’est configuré', async () => {
      const m = await load();
      expect(m.GEMINI_MODEL_ID).toBe('gemini-3.5-flash');
      expect(m.GROQ_MODEL_ID).toBe('openai/gpt-oss-120b');
      expect(m.MISTRAL_MODEL_ID).toBe('mistral-large-latest');
    });

    it('ignore une variable vide ou faite d’espaces', async () => {
      process.env.GEMINI_MODEL_ID = '  ';
      process.env.GROQ_MODEL_ID = '   ';
      process.env.MISTRAL_MODEL_ID = '';
      const m = await load();
      expect(m.GEMINI_MODEL_ID).toBe('gemini-3.5-flash');
      expect(m.GROQ_MODEL_ID).toBe('openai/gpt-oss-120b');
      expect(m.MISTRAL_MODEL_ID).toBe('mistral-large-latest');
    });
  });

  describe('surcharge par l’environnement', () => {
    it('lit GEMINI_MODEL_ID, GROQ_MODEL_ID et MISTRAL_MODEL_ID', async () => {
      process.env.GEMINI_MODEL_ID = 'gemini-3.6-flash';
      process.env.GROQ_MODEL_ID = 'openai/gpt-oss-20b';
      process.env.MISTRAL_MODEL_ID = 'mistral-small-latest';
      const m = await load();
      expect(m.GEMINI_MODEL_ID).toBe('gemini-3.6-flash');
      expect(m.GROQ_MODEL_ID).toBe('openai/gpt-oss-20b');
      expect(m.MISTRAL_MODEL_ID).toBe('mistral-small-latest');
    });

    it('rogne les espaces autour de la valeur', async () => {
      process.env.GROQ_MODEL_ID = '  openai/gpt-oss-20b  ';
      const m = await load();
      expect(m.GROQ_MODEL_ID).toBe('openai/gpt-oss-20b');
    });
  });

  describe('dérivation — étiquette et modèle demandé sortent d’une seule résolution', () => {
    it('dérive les trois étiquettes sur le défaut', async () => {
      const m = await load();
      expect(m.PRIMARY_MODEL_ID).toBe(`google/${m.GEMINI_MODEL_ID}`);
      expect(m.FALLBACK_MODEL_ID).toBe(`groq/${m.GROQ_MODEL_ID}`);
      expect(m.LAST_RESORT_MODEL_ID).toBe(`mistral/${m.MISTRAL_MODEL_ID}`);
    });

    it('dérive les trois étiquettes sur une valeur surchargée', async () => {
      process.env.GEMINI_MODEL_ID = 'gemini-3.6-flash';
      process.env.GROQ_MODEL_ID = 'openai/gpt-oss-20b';
      process.env.MISTRAL_MODEL_ID = 'mistral-small-latest';
      const m = await load();
      expect(m.PRIMARY_MODEL_ID).toBe('google/gemini-3.6-flash');
      expect(m.FALLBACK_MODEL_ID).toBe('groq/openai/gpt-oss-20b');
      expect(m.LAST_RESORT_MODEL_ID).toBe('mistral/mistral-small-latest');
    });

    it('fait porter à la chaîne le modèle configuré, étiquette COMPRISE', async () => {
      process.env.GEMINI_MODEL_ID = 'gemini-3.6-flash';
      process.env.GROQ_MODEL_ID = 'openai/gpt-oss-20b';
      process.env.MISTRAL_MODEL_ID = 'mistral-small-latest';
      const { makeModelChain } = await load();

      const chain = makeModelChain({ geminiApiKey: 'k', groqApiKey: 'g', mistralApiKey: 'm' });

      expect(chain.map((e: { id: string }) => e.id)).toEqual([
        'google/gemini-3.6-flash',
        'groq/openai/gpt-oss-20b',
        'mistral/mistral-small-latest',
      ]);
      expect(chain.map((e: { model: { modelId: string } }) => e.model.modelId)).toEqual([
        'gemini-3.6-flash',
        'openai/gpt-oss-20b',
        'mistral-small-latest',
      ]);
    });

    /**
     * Le piège que ce test ferme : dans `src/mastra/index.ts`, `dotenv.config()` vit dans le
     * CORPS du module, donc il s'exécute APRÈS l'évaluation de tous les imports — y compris
     * celle de `model-fallback`. Un identifiant posé dans `.env` (et non par la plateforme)
     * n'existe donc pas encore quand les constantes sont figées. `makeModelChain` doit
     * relire l'environnement à l'APPEL, sans quoi l'étiquette et le modèle demandé
     * divergeraient — le défaut d'origine, sous une autre forme.
     */
    it('relit l’environnement à l’appel, pas seulement à l’import', async () => {
      const { makeModelChain } = await load();

      process.env.GEMINI_MODEL_ID = 'gemini-3.6-flash';
      const chain = makeModelChain({ geminiApiKey: 'k', groqApiKey: 'g', mistralApiKey: 'm' });

      expect(chain[0].id).toBe('google/gemini-3.6-flash');
      expect(chain[0].model.modelId).toBe('gemini-3.6-flash');
    });
  });
});
