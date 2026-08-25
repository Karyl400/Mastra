import { describe, it, expect } from 'vitest';

import { routeToAgent } from '../../../src/features/notification/domain/services/agent-routing';
import { agentHasTool } from '../../../src/shared/agent-capabilities';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « RAPPELLE-MOI JEUDI » N'ATTEIGNAIT PAS L'AGENT QUI POSE LES RAPPELS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Trouvé le 2026-08-25 en traçant le routage, pas en relisant le code.
 *
 * `NOTIFICATION_TOPICS` porte le mot NOMINAL `rappel`, avec le seul pluriel `s?`. Le bord droit
 * `(?![\p{L}])` — ajouté à dessein le 2026-08-11 — fait donc que `rappelle` ne matche PAS
 * `rappel`. C'était voulu : sans lui, « je te rappelle que le projet démarre lundi » détournait
 * vers l'agent de notification alors que ce n'est pas une demande de rappel.
 *
 * ⚠️ **Mais la garde a emporté la formulation la plus naturelle de la demande.** « Rappelle-moi
 * jeudi de relancer Awa » partait chez `onboardingOrchestrator`, **qui ne porte pas
 * `scheduleReminder`** — même famille que le résumé de canal parti chez un agent sans
 * `getChannelHistory`. La personne obtient un agent qui ne peut pas faire ce qu'elle demande.
 *
 * ⚠️ **LE CRITÈRE PORTE SUR L'ACTE DE LANGAGE, PAS SUR LE MOT** — la même règle que
 * `forget.ts`, où « je ne veux surtout pas que tu oublies » ne doit rien effacer. Ce qui
 * distingue la demande de la simple mention, c'est l'IMPÉRATIF suivi d'un pronom enclitique :
 * `rappelle-moi`, `rappelle-lui`, `rappelle-nous`, `rappelle-leur`. « Je te rappelle que… » n'a
 * pas cette forme, et doit continuer de ne pas détourner.
 */

describe('la demande de rappel atteint l’agent qui sait la servir', () => {
  const requests = [
    'rappelle-moi jeudi de relire le compte rendu',
    'rappelle-moi de relancer Awa lundi',
    'rappelle moi mardi de valider le budget',
    'rappelle-lui jeudi qu’il doit compléter son dossier',
    'rappelle-nous vendredi de préparer la réunion',
    'rappelle-moi demain de relancer le prestataire',
    'rappelle-moi dans 3 jours de vérifier les accès',
  ];

  it.each(requests)('« %s » → notificationAgent', (text) => {
    expect(routeToAgent(text, undefined)).toBe('notificationAgent');
  });

  it('et cet agent porte RÉELLEMENT l’outil — on vérifie une capacité, pas un nom', () => {
    expect(agentHasTool('notificationAgent', 'scheduleReminder')).toBe(true);
    expect(agentHasTool('onboardingOrchestrator', 'scheduleReminder')).toBe(false);
  });

  it('la formulation nominale continue de fonctionner', () => {
    expect(routeToAgent('programme un rappel pour jeudi', undefined)).toBe('notificationAgent');
  });
});

describe('la simple MENTION ne détourne toujours pas', () => {
  const mentions = [
    'je te rappelle que le projet démarre lundi',
    'il me rappelle quelqu’un, ce prénom',
    'ça me rappelle la réunion de mars',
  ];

  it.each(mentions)('« %s » ne part PAS chez notificationAgent', (text) => {
    // Le faux positif que le bord droit avait été ajouté pour fermer le 2026-08-11. Le rouvrir
    // en élargissant `rappel` à tout `rappelle*` serait une régression, pas un correctif.
    expect(routeToAgent(text, undefined)).not.toBe('notificationAgent');
  });
});

/**
 * ⚠️ **CE QUI DISTINGUE LA DEMANDE DE LA REFORMULATION EST UNE DATE, PAS UN VERBE.**
 *
 * Trouvé par un test EXISTANT que la première version de ce correctif faisait rougir :
 * « rappelle-moi ça », dans un fil mené par `knowledgeAgent`, ne demande pas un rappel — il
 * demande de REDIRE. L'impératif avec pronom enclitique ne suffit donc pas : il faut aussi un
 * repère temporel.
 *
 * C'est la même leçon que `forget.ts`, où « je ne veux surtout pas que tu oublies » ne doit
 * rien effacer : **le critère porte sur l'acte de langage complet, jamais sur un mot isolé.**
 */
describe('« rappelle-moi » SANS date n’est pas une demande de rappel', () => {
  const restatements = [
    ['rappelle-moi ça', 'knowledgeAgent'],
    ['rappelle-moi ce qu’on a dit', 'knowledgeAgent'],
  ] as const;

  it.each(restatements)('« %s » reste sur le fil en cours', (text, sticky) => {
    expect(routeToAgent(text, sticky)).toBe(sticky);
  });

  it('mais avec une date, elle déloge bien le fil', () => {
    expect(routeToAgent('rappelle-moi ça jeudi', 'knowledgeAgent')).toBe('notificationAgent');
  });
});
