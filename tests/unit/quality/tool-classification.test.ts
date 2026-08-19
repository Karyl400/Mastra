import { describe, it, expect } from 'vitest';

import { AGENT_TOOLS } from '../../../src/shared/agent-capabilities';
import {
  ACTING_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  hasActingToolCall,
} from '../../../src/features/notification/domain/services/claim-reconciliation';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * Le test que `claim-reconciliation.ts` annonçait depuis sa naissance
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Son en-tête portait, mot pour mot : « ⚠️ Verrouillé par
 * `tests/unit/quality/tool-classification.test.ts` : tout outil câblé dans
 * `src/mastra/index.ts` doit être classé ici OU être un acteur assumé. Une liste écrite à la
 * main se désynchronise au premier changement de câblage. »
 *
 * **Le fichier n'existait pas.** Et la liste s'était désynchronisée exactement comme annoncé,
 * en une seule journée — le 2026-08-14, qui a retiré `getTaskList` et ajouté
 * `findPersonByName` et `findExpertise` :
 *
 *   • `getTaskList` y figurait encore, alors que l'outil n'existe plus ;
 *   • `findPersonByName` et `findExpertise` en étaient absents.
 *
 * Un nom absent de `READ_ONLY_TOOL_NAMES` est réputé ACTEUR — arbitrage juste, le défaut sûr
 * étant le silence. Mais `findPersonByName` est câblé sur `onboardingOrchestrator` ET
 * `notificationAgent`, et c'est le PREMIER GESTE de presque toute demande nommant quelqu'un :
 * la réconciliation FAIT/NARRATION se taisait donc sur le chemin le plus fréquent du produit.
 *
 * Le garde-fou qui répond au verdict n° 1 de l'utilisatrice testeuse — « il parle exactement
 * de la même façon quand il a fait le travail et quand il l'a inventé » — était éteint là où
 * elle le testait.
 */

const WIRED_TOOLS = [...new Set(Object.values(AGENT_TOOLS).flat())].sort();

describe('classification des outils — la liste ne peut plus dériver du câblage', () => {
  it('classe TOUT outil câblé, en lecteur ou en acteur', () => {
    const unclassified = WIRED_TOOLS.filter(
      (tool) => !READ_ONLY_TOOL_NAMES.has(tool) && !ACTING_TOOL_NAMES.has(tool),
    );

    expect(unclassified).toEqual([]);
  });

  it('ne classe AUCUN outil qui ne soit plus câblé', () => {
    // Le sens qui manquait : `getTaskList` est resté douze jours dans la liste des lecteurs
    // après la suppression de l'outil. Un nom mort n'a jamais fait rougir personne.
    const wired = new Set(WIRED_TOOLS);
    const orphans = [...READ_ONLY_TOOL_NAMES, ...ACTING_TOOL_NAMES].filter((t) => !wired.has(t));

    expect(orphans).toEqual([]);
  });

  it('ne classe jamais un outil DEUX FOIS — un lecteur qui agit est une contradiction', () => {
    const both = [...READ_ONLY_TOOL_NAMES].filter((tool) => ACTING_TOOL_NAMES.has(tool));

    expect(both).toEqual([]);
  });
});

describe('les conséquences de la classification, vérifiées sur `hasActingToolCall`', () => {
  it('ne DÉSARME PAS la réconciliation sur une simple résolution de personne', () => {
    // C'est le cas exact qui était cassé. `findPersonByName` est le premier geste attendu de
    // deux agents sur trois ; s'il compte comme un acteur, « c'est fait » n'est plus jamais
    // requalifié sur la majorité du trafic.
    expect(hasActingToolCall(['findPersonByName'])).toBe(false);
    expect(hasActingToolCall(['findExpertise'])).toBe(false);
    expect(hasActingToolCall(['findEmployeeByEmail', 'getEmployeeProfile'])).toBe(false);
  });

  it('reste armée dès qu’un seul outil AGIT, quel que soit le nombre de lectures autour', () => {
    expect(hasActingToolCall(['findPersonByName', 'sendNotification'])).toBe(true);
    expect(hasActingToolCall(['generateDocument'])).toBe(true);
    expect(hasActingToolCall(['scheduleReminder'])).toBe(true);
    expect(hasActingToolCall(['updateOnboardingStatus'])).toBe(true);
    expect(hasActingToolCall(['scheduleCandidateInterview'])).toBe(true);
  });

  it('traite un nom INCONNU comme un acteur — le défaut sûr est le silence', () => {
    // Mastra a déjà changé la forme du champ une fois : `readToolCalls` journalisait
    // « unknown » sur 100 % des appels. Un nom illisible doit produire un silence, jamais une
    // accusation portée à tort contre un modèle qui a réellement agi.
    expect(hasActingToolCall(['unknown'])).toBe(true);
    expect(hasActingToolCall(['toolQuiNExistePas'])).toBe(true);
  });
});
