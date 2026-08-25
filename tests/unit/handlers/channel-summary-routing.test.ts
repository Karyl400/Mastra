import { describe, it, expect } from 'vitest';

import { routeToAgent } from '../../../src/features/notification/domain/services/agent-routing';
import { agentHasTool } from '../../../src/shared/agent-capabilities';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * UN JETON DE CANAL BAT UN MOT-CLÉ DE FORMAT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Symptôme relevé en production le 2026-08-25, mot pour mot :
 *
 *   « Je n'ai pas accès au fil de discussion du canal #kisso-hq. Peux-tu me copier le texte
 *     que tu souhaites que je résume ? Ainsi je pourrai créer le PDF et te l'envoyer par mail. »
 *
 * La réponse est cohérente : elle vient de `onboardingOrchestrator`, qui porte bien
 * `generateDocument` et ne porte PAS `getChannelHistory`. Le défaut n'est pas dans l'agent, il
 * est dans le ROUTAGE — et il est reproductible sans dépenser un token.
 *
 * `TOPIC_BANDS.find(...)` rend la PREMIÈRE bande qui matche, et la bande de l'orchestrateur est
 * en tête avec `pdf`, `document`, `guide`. La phrase « résume <#C…> et envoie-moi ça en PDF »
 * matche donc l'orchestrateur AVANT la bande de connaissance, alors que le seul agent capable
 * de lire un canal est `knowledgeAgent`.
 *
 * ⚠️ **C'EST LA MÊME FAMILLE QUE LE DÉFAUT DU 2026-08-12** — une bande qui ne sait pas servir la
 * demande l'emporte parce qu'elle a matché la première. La correction d'alors portait sur le
 * palier COLLANT ; celle-ci porte sur l'ordre des bandes elles-mêmes.
 *
 * ⚠️ **LE CRITÈRE N'EST PAS « la connaissance d'abord », C'EST « le signal STRUCTUREL d'abord ».**
 * Le dépôt l'écrit déjà à propos de ce même jeton : *« il est produit par le client Slack,
 * jamais tapé, et il survit à `cleanText` »*. Un `<#C…>` dans un message est un FAIT ; `pdf` est
 * un mot que quelqu'un a écrit. On ne généralise donc pas la précédence à tous les motifs —
 * `EXPERTISE_QUESTION_PATTERN` et `RECALL_QUESTION_PATTERN` restent des motifs de TEXTE, et leur
 * donner le pas ferait partir « génère un document pour la personne qui gère le backend » chez
 * un agent sans `generateDocument`, c'est-à-dire le défaut d'aujourd'hui retourné.
 *
 * ⚠️ **CE QUE CE CORRECTIF NE FAIT PAS, ET NE DOIT PAS FAIRE.** Après lui, « résume <#C…> et
 * envoie-moi ça en PDF » part chez `knowledgeAgent`, qui produira le résumé et dira qu'il ne
 * sait pas en faire un document. C'est la BONNE réponse : lire un canal puis en livrer le
 * contenu sous forme de fichier est exactement la conjonction qu'`outbound-tool-quarantine.ts`
 * interdit (§4.2). Aucun agent ne sert cette phrase entièrement, **par construction**, et le
 * produit doit le dire au lieu de proposer un contournement.
 */

const CHANNEL = '<#C0BMLKC4S5T|kisso-hq>';

describe('une demande de résumé de canal atteint l’agent qui sait lire un canal', () => {
  const summaryRequests = [
    `résume ${CHANNEL}`,
    `résume ${CHANNEL} et envoie-moi ça en PDF`,
    `fais un résumé de ${CHANNEL} dans un document`,
    `un résumé de ${CHANNEL} en guide, s'il te plaît`,
    `${CHANNEL} : qu'est-ce qui s'y est dit ? mets-le dans un docx`,
  ];

  it.each(summaryRequests)('« %s » → knowledgeAgent', (text) => {
    expect(routeToAgent(text, undefined)).toBe('knowledgeAgent');
  });

  it('l’agent choisi porte réellement l’outil de lecture de canal', () => {
    // Anti-tautologie : le test ci-dessus vérifie un NOM. Celui-ci vérifie que ce nom désigne un
    // agent capable, et il le dérive du câblage plutôt que de le supposer.
    expect(agentHasTool('knowledgeAgent', 'getChannelHistory')).toBe(true);
    expect(agentHasTool('onboardingOrchestrator', 'getChannelHistory')).toBe(false);
  });

  it('déloge même un fil mené par l’orchestrateur', () => {
    expect(routeToAgent(`résume ${CHANNEL} en PDF`, 'onboardingOrchestrator')).toBe(
      'knowledgeAgent',
    );
  });
});

describe('la précédence ne vaut QUE pour le jeton de canal', () => {
  it('sans jeton, un mot de format garde son sens — le document reste chez l’orchestrateur', () => {
    expect(routeToAgent('génère-moi le guide d’accueil en PDF', undefined)).toBe(
      'onboardingOrchestrator',
    );
  });

  it('une question d’expertise mêlée à un document ne part PAS chez knowledgeAgent', () => {
    // Le piège symétrique : donner le pas à TOUS les motifs enverrait cette phrase chez un agent
    // qui n'a pas `generateDocument`, ce qui est le défaut d'aujourd'hui, retourné.
    expect(routeToAgent('génère un document pour la personne qui gère le backend', undefined)).toBe(
      'onboardingOrchestrator',
    );
  });

  it('un nom de canal TAPÉ à la main n’est pas un jeton — il ne prend pas le pas', () => {
    // `#kisso-hq` en texte brut n'est pas produit par le client Slack. On ne lui accorde donc
    // pas la force d'un fait : c'est un mot comme un autre, et `résume` suffit déjà à router.
    expect(routeToAgent('résume #kisso-hq', undefined)).toBe('knowledgeAgent');
  });
});
