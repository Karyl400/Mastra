import { describe, it, expect } from 'vitest';

import { routeToAgent } from '../../../src/features/notification/domain/services/agent-routing';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * CINQUIÈME OCCURRENCE DU PIÈGE DE L'ACCENT — audit du 2026-08-28, § 1.6
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `RECALL_QUESTION_PATTERN` portait `d[ié]cid` : la classe contenait `i` et `é`, et **pas
 * `e`**. La forme correcte — `[ée]t[ée]` — était écrite à la ligne SUIVANTE : la preuve que
 * c'est une faute de frappe est dans le fichier lui-même.
 *
 * ⚠️ `routeToAgent` ne fait que `toLowerCase()` : il ne plie AUCUN accent. Sur un clavier de
 * téléphone, où une bonne part du français s'écrit sans accents, `searchKnowledge` n'était donc
 * jamais atteint — la demande partait chez `onboardingOrchestrator`, qui ne porte pas cet outil
 * et ne pouvait répondre qu'en INVENTANT.
 *
 * Le corpus a DEUX colonnes, comme celui de la détresse : les phrases qui doivent atteindre la
 * connaissance, et celles qui ne doivent pas y aller. N'en exercer qu'une moitié ne mesure rien.
 */

const RAPPELS_DE_MEMOIRE = [
  "qu'est-ce qu'on a decide hier",
  "qu'est-ce qu'on a décidé hier",
  "qu'est-ce qu'on a decide pour la migration",
  'ce qui a ete decide',
  'ce qui a été décidé',
  'ce qui a ete evoque en reunion',
  'ce qui a été évoqué en réunion',
  "qu'a-t-on decide sur le sujet",
  "qu'avons-nous decide finalement",
];

const HORS_SUJET = [
  'crée un employé pour Awa',
  'envoie un rappel à Pamela lundi',
  'génère-moi le guide en pdf',
];

describe('le rappel de mémoire atteint la connaissance, accentué OU NON', () => {
  it.each(RAPPELS_DE_MEMOIRE)('« %s » → knowledgeAgent', (phrase) => {
    expect(routeToAgent(phrase)).toBe('knowledgeAgent');
  });

  it.each(HORS_SUJET)('CONTRÔLE — « %s » ne part PAS à la connaissance', (phrase) => {
    expect(routeToAgent(phrase)).not.toBe('knowledgeAgent');
  });
});
