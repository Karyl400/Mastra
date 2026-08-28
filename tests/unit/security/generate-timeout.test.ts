/**
 * LE TIMEOUT SUR `agent.generate` — le seul échec qui ne produisait AUCUNE trace.
 *
 * Constat du 2026-08-20 : `agent.generate()` était appelé sans `abortSignal` et sans aucune
 * borne de durée, dans une fonction dont `maxDuration` vaut 60 s. Il n'existe par ailleurs
 * aucun utilitaire de reprise dans ce dépôt — `src/shared/retry.ts`, que `CLAUDE.md` liste
 * parmi les modules transverses, N'EXISTE PAS.
 *
 * Ce que cela produisait, et pourquoi c'est le pire symptôme possible ici :
 *
 *   1. l'ACK à 200 est déjà parti, donc Slack ne rejouera JAMAIS l'événement ;
 *   2. la fonction est tuée à `maxDuration` pendant l'appel ;
 *   3. `progress.resolve()` n'est jamais appelé, `progress.fail()` non plus ;
 *   4. la personne reste sur « Je regarde ça, un instant… » indéfiniment ;
 *   5. AUCUNE ligne d'erreur n'est écrite — l'invocation meurt avant de pouvoir en écrire une.
 *
 * La grâce d'abandon de 60 s ne couvre pas ce cas : elle ne s'arme que sur un rejeu, et il
 * n'y a pas de rejeu après un ACK réussi.
 *
 * Le correctif ne rend pas l'appel plus rapide — il le rend NOMMABLE. Un échec bruyant vaut
 * mieux qu'un silence : c'est la doctrine que ce dépôt applique partout ailleurs
 * (`emailSent: false` sous `status: 'success'`, `documents.content` perdu sans erreur,
 * `status = Sent` posé avant l'envoi).
 */
import { describe, it, expect } from 'vitest';

import {
  userFacingFailure,
  describeErrorChain,
  TIMEOUT_FAILURE,
  GENERIC_FAILURE,
  QUOTA_FAILURE,
} from '../../../src/shared/user-facing-failure';
import { AGENT_GENERATE_TIMEOUT_MS } from '../../../src/shared/llm/model-fallback';

describe('AGENT_GENERATE_TIMEOUT_MS', () => {
  it('laisse de la marge sous `maxDuration` pour poster le message d’échec', () => {
    // `maxDuration` vaut 60 s (`fix-vercel-output.js`). Un timeout à 59 s expirerait en même
    // temps que la fonction : on aurait la borne SANS le message, c'est-à-dire exactement le
    // silence qu'on corrige.
    expect(AGENT_GENERATE_TIMEOUT_MS).toBeLessThanOrEqual(45_000);
  });

  it('reste très au-dessus du pire cas mesuré', () => {
    // Runs mesurés en production : 2 à 17 s, jusqu'à ~21 s avec le back-off du dernier
    // maillon. Une borne trop basse couperait des réponses qui allaient aboutir — et le
    // coût d'un tour perdu est de 5 % du quota du jour.
    expect(AGENT_GENERATE_TIMEOUT_MS).toBeGreaterThanOrEqual(35_000);
  });
});

describe('userFacingFailure — un délai dépassé se distingue d’une panne', () => {
  it('reconnaît un `TimeoutError` de `AbortSignal.timeout`', () => {
    // C'est le nom exact que pose la plateforme. On ne le devine pas : ce test le fixe.
    const error = new DOMException('The operation was aborted due to timeout', 'TimeoutError');

    expect(userFacingFailure(error)).toBe(TIMEOUT_FAILURE);
  });

  it('reconnaît un `AbortError`, la forme rendue par certaines couches du SDK', () => {
    const error = Object.assign(new Error('Aborted'), { name: 'AbortError' });

    expect(userFacingFailure(error)).toBe(TIMEOUT_FAILURE);
  });

  it('suit la chaîne `cause` — Mastra réemballe l’erreur du dernier maillon', () => {
    const inner = new DOMException('timeout', 'TimeoutError');
    const wrapped = Object.assign(new Error('Upstream LLM API error'), { cause: inner });

    expect(userFacingFailure(wrapped)).toBe(TIMEOUT_FAILURE);
  });

  it("dit qu'il faut RÉESSAYER, jamais de signaler un défaut", () => {
    // La distinction est la raison d'être de ce message. Le générique invite à « remonter »
    // le problème : sur un délai dépassé c'est faux et coûteux, réessayer aboutit souvent.
    expect(TIMEOUT_FAILURE).toMatch(/réessaie/i);
    expect(TIMEOUT_FAILURE).not.toBe(GENERIC_FAILURE);
  });

  it('ne confond pas une panne ordinaire avec un délai dépassé', () => {
    expect(userFacingFailure(new Error('boom'))).toBe(GENERIC_FAILURE);
  });
});

describe('userFacingFailure — le quota au fond d’un RetryError', () => {
  function retryErrorAvec429(): unknown {
    const rate = Object.assign(new Error('Rate limit reached … tokens per minute (TPM)'), {
      name: 'AI_APICallError',
      statusCode: 429,
    });
    return Object.assign(new Error('Failed after 3 attempts.'), {
      name: 'AI_RetryError',
      errors: [new Error('a'), new Error('b'), rate],
      lastError: rate,
    });
  }

  it('la prémisse : un RetryError ne porte AUCUNE cause', () => {
    expect((retryErrorAvec429() as { cause?: unknown }).cause).toBeUndefined();
  });

  it('reconnaît le quota là où le SDK le range VRAIMENT', () => {
    expect(userFacingFailure(retryErrorAvec429())).toBe(QUOTA_FAILURE);
  });

  it('l’INSTRUMENT voit ce que le verdict voit — sinon il ment sur ce qu’il mesure', () => {
    expect(JSON.stringify(describeErrorChain(retryErrorAvec429()))).toContain('429');
  });

  it('un délai dépassé prime toujours sur un quota enfoui', () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    (timeout as { errors?: unknown }).errors = [retryErrorAvec429()];
    expect(userFacingFailure(timeout)).toBe(TIMEOUT_FAILURE);
  });

  it('ne boucle pas sur un graphe cyclique', () => {
    const a = new Error('a') as Error & { cause?: unknown; errors?: unknown[] };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    a.errors = [b, a];
    expect(userFacingFailure(a)).toBe(GENERIC_FAILURE);
  });
});
