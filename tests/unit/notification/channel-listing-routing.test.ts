import { describe, it, expect } from 'vitest';

import { routeToAgent } from '../../../src/features/notification/domain/services/agent-routing';

/**
 * 2026-10-18 — « Liste moi toutes les channels auquels je n'appartient pas » partait chez
 * `onboardingOrchestrator`, qui ne porte aucun outil de canal et répondait, exactement :
 * *« Je ne peux pas consulter la liste des canaux Slack. »*
 *
 * `listChannels` existe désormais sur `knowledgeAgent` ; sans une porte d'entrée, il serait
 * resté inatteignable sur les phrases réelles — le défaut de `knowledgeAgent` avant le
 * 2026-08-14. Corpus à DEUX colonnes : « canal » est un mot courant, et un verbe d'ACTION sur un
 * canal (inviter, ajouter, créer) n'est pas une demande de liste.
 */

const LISTES_DE_CANAUX = [
  "Liste-moi les canaux auxquels j'appartiens",
  "liste moi toutes les channels auquels je n'appartient pas",
  'liste les canaux',
  'quels sont les canaux ?',
  'Quels canaux existent dans le workspace ?',
  'dans quels canaux je suis ?',
  'montre-moi les canaux publics',
  'combien de canaux y a-t-il',
  'les canaux dont je suis membre',
  'donne-moi tous les channels',
];

const HORS_SUJET = [
  'ajoute-moi au canal random',
  'invite Awa dans le canal engineering',
  'crée un canal pour le projet',
  'envoie un message dans le canal',
  'génère-moi le guide des canaux à rejoindre en pdf',
  "j'ai besoin d'aide pour mon profil",
];

describe('une demande de liste de canaux atteint la connaissance', () => {
  it.each(LISTES_DE_CANAUX)('« %s » → knowledgeAgent', (phrase) => {
    expect(routeToAgent(phrase)).toBe('knowledgeAgent');
  });

  it.each(HORS_SUJET)('CONTRÔLE — « %s » ne part PAS à la connaissance', (phrase) => {
    expect(routeToAgent(phrase)).not.toBe('knowledgeAgent');
  });

  it('peut déloger un fil tenu par un agent qui ne porte pas l’outil', () => {
    expect(routeToAgent('liste les canaux', 'notificationAgent')).toBe('knowledgeAgent');
  });

  it('ne déloge JAMAIS un fil déjà chez la connaissance', () => {
    expect(routeToAgent('liste les canaux', 'knowledgeAgent')).toBe('knowledgeAgent');
  });
});
