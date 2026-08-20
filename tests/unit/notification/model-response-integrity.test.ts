/**
 * DEUX ÉCHECS DU MODÈLE QUE PERSONNE NE VOYAIT.
 *
 * ── [89] `finishReason` n'était JAMAIS lu ────────────────────────────────────
 * `grep 'finishReason|maxOutputTokens|maxTokens'` sur `src/` rendait ZÉRO occurrence. Aucun
 * plafond de sortie n'est posé, et la raison d'arrêt n'était pas regardée. Une réponse
 * coupée par le plafond du fournisseur partait donc dans Slack phrase inachevée, PUIS était
 * mémorisée — donc rejouée à tous les tours suivants pendant 60 minutes.
 *
 * C'était le seul point des cent de l'audit où le défaut n'avait AUCUN détecteur : ni signal
 * pour la personne, ni ligne dans les logs.
 *
 * ⚠️ On ne pose toujours pas de `maxTokens`, et c'est délibéré : le borner nous ferait
 * FABRIQUER la troncature qu'on cherche à détecter. On lit ce que le fournisseur dit.
 *
 * ── [87] Une réponse VIDE devenait un refus de SÉCURITÉ ───────────────────────
 * `sanitizeAgentOutput('')` rend `NEUTRAL_REFUSAL` — « Je ne peux pas traiter ce message tel
 * quel. Reformule-le. » Or rien n'a été refusé : le modèle n'a simplement rien produit. Le
 * message est FAUX, il pousse à reformuler donc à brûler du quota sur un budget de ≈ 19
 * messages/jour, et c'était le seul des trois retours du filtre à ne RIEN journaliser :
 * `logSanitizerVerdicts` ne voit ni `redacted` ni `strippedUrls`, et
 * `logger.info('Slack response sent')` passait au vert.
 *
 * On ne change pas ce que `sanitizeAgentOutput` rend — son contrat est bon pour un texte
 * vraiment vide. On rend l'événement VISIBLE, et on distingue les deux causes.
 */
import { describe, it, expect } from 'vitest';

import {
  describeModelResponse,
  MODEL_TRUNCATED_NOTICE,
} from '../../../src/shared/llm/model-response';

describe('describeModelResponse — troncature', () => {
  it('reconnaît une réponse coupée par le plafond du fournisseur', () => {
    expect(describeModelResponse({ text: 'Voici les trois prem', finishReason: 'length' })).toEqual(
      expect.objectContaining({ truncated: true, empty: false }),
    );
  });

  it('accepte les variantes de nom rendues par les fournisseurs', () => {
    // Le SDK normalise en `length`, mais la valeur brute d'un fournisseur peut être
    // `max_tokens` ou `MAX_TOKENS`. On reconnaît sur la FORME, jamais sur une égalité
    // stricte à une seule chaîne — c'est ce qui a laissé un modèle mort survivre dans le
    // code jusqu'au 2026-08-15.
    for (const reason of ['length', 'max_tokens', 'MAX_TOKENS', 'maxTokens']) {
      expect(describeModelResponse({ text: 'x', finishReason: reason }).truncated).toBe(true);
    }
  });

  it('ne crie pas sur un arrêt NORMAL', () => {
    for (const reason of ['stop', 'tool-calls', undefined, null]) {
      expect(
        describeModelResponse({ text: 'Réponse complète.', finishReason: reason }).truncated,
      ).toBe(false);
    }
  });

  it('porte une note à ACCOLER, jamais un remplacement', () => {
    // Même arbitrage que la réconciliation FAIT/NARRATION : une réponse tronquée reste
    // utile, on ne la jette pas. On dit qu'elle est incomplète.
    expect(MODEL_TRUNCATED_NOTICE).toMatch(/incompl|coup/i);
    expect(MODEL_TRUNCATED_NOTICE.length).toBeLessThan(200);
  });
});

describe('describeModelResponse — réponse vide', () => {
  it('distingue le VIDE du refus de sécurité', () => {
    expect(describeModelResponse({ text: '', finishReason: 'stop' }).empty).toBe(true);
    expect(describeModelResponse({ text: '   \n  ', finishReason: 'stop' }).empty).toBe(true);
    expect(describeModelResponse({ text: 'Bonjour.', finishReason: 'stop' }).empty).toBe(false);
  });

  it('traite une absence de texte comme un vide, jamais comme une panne', () => {
    expect(describeModelResponse({ text: undefined, finishReason: 'stop' }).empty).toBe(true);
    expect(describeModelResponse({}).empty).toBe(true);
  });

  it('NE LÈVE JAMAIS sur une forme inattendue', () => {
    // Cette fonction est sur le chemin nominal de chaque réponse : une exception ici
    // transformerait une anomalie de forme en panne du tour.
    expect(() => describeModelResponse(null)).not.toThrow();
    expect(() => describeModelResponse('pas un objet')).not.toThrow();
    expect(describeModelResponse(null).empty).toBe(true);
  });
});
