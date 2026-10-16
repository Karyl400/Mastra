import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FUNCTION_MAX_DURATION_MS,
  MIN_GENERATE_MS,
  REPLY_MARGIN_MS,
  generateTimeoutMs,
  hasTimeForAnotherStep,
  runDeadline,
} from '../../../src/shared/llm/run-deadline';
import { AGENT_GENERATE_TIMEOUT_MS } from '../../../src/shared/llm/model-fallback';

/**
 * Audit QA du 2026-08-28, §4.2 (lot 13) — fermé le 2026-10-16.
 *
 * Pire cas mesuré : 20 s (rideau) + 40 s + 40 s (chaîne de deux étapes) = 100 s pour un plafond
 * Vercel de 60 s. La mort n'est pas une erreur, c'est un SILENCE : aucun `catch`, aucune ligne,
 * des états orphelins. Le budget est désormais UN compte à rebours partagé, dérivé du plafond.
 */
describe('l’échéance d’un message', () => {
  const T0 = 1_700_000_000_000;

  it('est dérivée du plafond de la fonction, moins la marge de réponse', () => {
    expect(runDeadline(T0)).toBe(T0 + FUNCTION_MAX_DURATION_MS - REPLY_MARGIN_MS);
  });

  it('borne un appel de modèle par le temps RESTANT, jamais au-delà de son plafond propre', () => {
    const deadline = runDeadline(T0);
    expect(generateTimeoutMs(deadline, T0)).toBe(AGENT_GENERATE_TIMEOUT_MS);
    expect(generateTimeoutMs(deadline, deadline - 12_000)).toBe(12_000);
    expect(generateTimeoutMs(deadline, deadline + 5_000)).toBe(0);
  });

  it('refuse une étape supplémentaire quand il ne reste plus de quoi la servir', () => {
    const deadline = runDeadline(T0);
    expect(hasTimeForAnotherStep(deadline, deadline - MIN_GENERATE_MS)).toBe(true);
    expect(hasTimeForAnotherStep(deadline, deadline - MIN_GENERATE_MS + 1)).toBe(false);
  });

  it('le plafond déclaré dans src/ est CELUI que le build pose sur la fonction', () => {
    const script = readFileSync(join(__dirname, '../../../scripts/fix-vercel-output.js'), 'utf8');
    const declared = /FUNCTION_MAX_DURATION_SECONDS\s*=\s*(\d+)/.exec(script)?.[1];
    expect(Number(declared) * 1000).toBe(FUNCTION_MAX_DURATION_MS);
  });
});
