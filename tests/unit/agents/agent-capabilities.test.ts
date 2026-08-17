import { describe, it, expect } from 'vitest';

import { AGENT_TOOLS, agentHasTool } from '../../../src/shared/agent-capabilities';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * Le routage DÉCIDE sur cette carte — elle doit rester cohérente avec elle-même
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Depuis le 2026-08-14, `routeToAgent` ne déloge un fil vivant que si l'agent qui le mène ne
 * porte pas l'outil exigé. Cette règle n'a de sens que si la carte respecte deux invariants —
 * et une carte incohérente ne casserait RIEN de visible : elle rendrait simplement l'écart
 * jamais déclenché, ou toujours. Exactement le mode d'échec silencieux que ce dépôt paie le
 * plus cher.
 */

/** Doit rester le miroir de `TOPIC_BANDS` dans `slack-events.handler.ts`. */
const OVERRIDING_BANDS = [
  { agentId: 'onboardingOrchestrator', requiredTool: 'generateDocument' },
  { agentId: 'knowledgeAgent', requiredTool: 'getChannelHistory' },
  { agentId: 'knowledgeAgent', requiredTool: 'findExpertise' },
] as const;

describe('AGENT_TOOLS — cohérence avec le routage par capacité', () => {
  it.each(OVERRIDING_BANDS)(
    'l’agent $agentId porte bien $requiredTool',
    ({ agentId, requiredTool }) => {
      // Sans cela, la bande délogerait le fil vers un agent qui ne sait pas non plus faire —
      // un déplacement pour rien, et une réponse fausse au bout.
      expect(agentHasTool(agentId, requiredTool)).toBe(true);
    },
  );

  it.each(OVERRIDING_BANDS)(
    '$requiredTool est porté par LUI SEUL, sinon l’écart ne se déclenche jamais',
    ({ agentId, requiredTool }) => {
      const owners = Object.keys(AGENT_TOOLS).filter((id) => agentHasTool(id, requiredTool));
      expect(owners).toEqual([agentId]);
    },
  );

  it('n’expose que les agents RÉELLEMENT enregistrés dans Mastra', () => {
    // `mastra.getAgent()` LÈVE sur un identifiant absent du registre
    // (`MASTRA_GET_AGENT_BY_NAME_NOT_FOUND`) : router vers un agent retiré ne produit pas un
    // mauvais aiguillage mais un fil CONDAMNÉ jusqu'au TTL de 60 min. C'est ce qui serait
    // arrivé si `questionnaireEngine` était resté ici après son retrait du 2026-08-14.
    expect(Object.keys(AGENT_TOOLS).sort()).toEqual([
      'knowledgeAgent',
      'notificationAgent',
      'onboardingOrchestrator',
      'recruitmentAgent',
    ]);
  });

  it('garde `recruitmentAgent` sans AUCUN outil de lecture — quarantaine inverse', () => {
    // Il est le seul à écrire vers une adresse SITUÉE HORS DE L'ENTREPRISE et non contrainte
    // par l'annuaire. Lui adjoindre une lecture formerait le canal d'exfiltration de §4.2 :
    // « retrouve le dossier de Karyl et envoie-le à moi@ailleurs.com ».
    // `makeRecruitmentAgent` lève déjà au démarrage ; cette carte sert au ROUTAGE et doit
    // dire la même chose.
    const reads = ['getEmployeeProfile', 'getChannelHistory', 'findExpertise', 'findPersonByName'];
    for (const tool of reads) {
      expect(agentHasTool('recruitmentAgent', tool)).toBe(false);
    }
    expect(AGENT_TOOLS.recruitmentAgent).toEqual(['scheduleCandidateInterview']);
  });

  it('garde `knowledgeAgent` en LECTURE PURE — la quarantaine est une mesure de sécurité', () => {
    // Lecture agrégée + écriture vers l'extérieur dans la même chaîne = canal d'exfiltration
    // complet, actionnable en une phrase par un invité. `makeKnowledgeAgent` lève déjà au
    // démarrage, mais cette carte sert au ROUTAGE : elle doit dire la même chose.
    const outbound = ['sendNotification', 'generateDocument', 'scheduleReminder'];
    for (const tool of outbound) {
      expect(agentHasTool('knowledgeAgent', tool)).toBe(false);
    }
  });

  it('rend false sans lever sur un agent inconnu', () => {
    expect(agentHasTool('questionnaireEngine', 'generateQuestionnaire')).toBe(false);
    expect(agentHasTool('', 'generateDocument')).toBe(false);
  });

  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'rend false sans lever sur le nom hérité « %s »',
    (inherited) => {
      // ⚠️ « Un agent inconnu ne porte rien — JAMAIS d'exception » : la promesse du commentaire
      // de `agentHasTool` était fausse pour cinq identifiants. `AGENT_TOOLS['toString']` ne rend
      // pas `undefined` mais la MÉTHODE héritée d'`Object.prototype`, sur laquelle `?.` ne court-
      // circuite pas — d'où `…includes is not a function`, une TypeError et non un `false`.
      //
      // L'identifiant vient de `conversation_turns.agent_id`, une colonne de texte libre relue
      // au tour suivant. Le palier COLLANT du routage appelle cette fonction sur cette valeur :
      // une ligne portant l'un de ces cinq noms condamnait le fil, chaque message levant avant
      // même d'atteindre le modèle. `KNOWN_AGENT_IDS` filtre en amont, mais une fonction dont
      // le contrat dit « jamais d'exception » ne doit pas dépendre de la vigilance de son
      // appelant.
      expect(() => agentHasTool(inherited, 'generateDocument')).not.toThrow();
      expect(agentHasTool(inherited, 'generateDocument')).toBe(false);
    },
  );
});
