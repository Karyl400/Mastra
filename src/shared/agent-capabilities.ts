/**
 * QUI PEUT FAIRE QUOI — le câblage agent → outils, déclaré UNE SEULE FOIS.
 *
 * ## Pourquoi ce module existe
 *
 * Ce câblage était recopié à la main à DEUX endroits en plus de `src/mastra/index.ts` :
 * la constante `WIRING` de `tests/unit/agents/agent-instructions-budget.test.ts` et le script
 * `_measure.mts`. `CLAUDE.md` relève que les deux copies étaient PÉRIMÉES — elles n'incluaient
 * pas `findEmployeeByEmail` sur deux agents sur trois, donc toute mesure de budget en tirait
 * un total faux. C'est la classe de défaut la plus fréquente de ce dépôt : deux bords corrects,
 * aucun lien entre les deux, et rien qui rougisse quand ils divergent.
 *
 * ## Ce qu'il rend possible, et qui n'existait pas
 *
 * Le ROUTAGE peut enfin demander « cet agent sait-il faire ça ? » au lieu de deviner par
 * mots-clés. C'est ce qui corrige l'état absorbant mesuré le 2026-08-12 : après « Envoie un
 * rappel à Pamela » (échappement `rappel` → `notificationAgent`), la demande « Génère-moi le
 * guide en PDF » RESTAIT chez `notificationAgent`, qui n'a pas `generateDocument` — le fil
 * était piégé une heure durant, la clé de conversation étant le canal en DM.
 *
 * ## ⚠️ Contrat avec `src/mastra/index.ts`
 *
 * Les valeurs ci-dessous doivent refléter les objets `tools` passés aux trois factories.
 * `tests/unit/agents/agent-capabilities.test.ts` vérifie que la frontière négative rendue par
 * `agentToolBoundary()` — elle, DÉRIVÉE de `Object.keys(tools)` au démarrage réel — énumère
 * exactement ces noms. Une divergence fait donc rougir un test au lieu de fausser un routage
 * en silence.
 */

/**
 * ⚠️ `questionnaireEngine` n'y figure plus : agent retiré du registre le 2026-08-14, en même
 * temps que son unique outil. Le laisser ici ferait router vers un identifiant absent, et
 * `mastra.getAgent()` LÈVE dans ce cas (`MASTRA_GET_AGENT_BY_NAME_NOT_FOUND`) — donc un fil
 * condamné, pas un simple mauvais aiguillage.
 */
export const AGENT_TOOLS: Readonly<Record<string, readonly string[]>> = {
  onboardingOrchestrator: [
    'findEmployeeByEmail',
    'findPersonByName',
    'getEmployeeProfile',
    'updateOnboardingStatus',
    'generateDocument',
  ],
  notificationAgent: [
    'findEmployeeByEmail',
    'findPersonByName',
    'sendNotification',
    'scheduleReminder',
    'getNotificationHistory',
    'getEmployeeProfile',
  ],
  // Aucun outil de SORTIE, et ce n'est pas une convention : `makeKnowledgeAgent` LÈVE au
  // démarrage si on lui en câble un. Lecture agrégée + écriture externe dans la même chaîne
  // est un canal d'exfiltration complet, actionnable en une phrase par un invité.
  knowledgeAgent: ['getUserConversations', 'getChannelHistory', 'findExpertise'],
  // ⚠️ UN SEUL outil, et AUCUN de lecture : `makeRecruitmentAgent` LÈVE au démarrage si on lui
  // en câble un. C'est le seul agent qui écrive à une adresse hors de l'entreprise et non
  // contrainte par l'annuaire — quarantaine INVERSE de celle de `knowledgeAgent`, et pour la
  // même raison (PLAN-ARCHITECTURE.md §4.2 interdit la CONJONCTION, quel que soit le côté par
  // lequel on y arrive).
  recruitmentAgent: ['scheduleCandidateInterview'],
};

/**
 * Cet agent porte-t-il cet outil ? Un agent inconnu ne porte rien — jamais d'exception.
 *
 * ⚠️ `Object.hasOwn` n'est PAS une précaution de style : sans lui, la promesse ci-dessus
 * était fausse pour cinq identifiants. `AGENT_TOOLS['toString']` ne rend pas `undefined`
 * mais la méthode héritée d'`Object.prototype` — sur laquelle `?.` ne court-circuite pas,
 * puisqu'elle n'est ni `null` ni `undefined` — d'où `…includes is not a function`. Idem
 * `constructor`, `valueOf`, `hasOwnProperty`, `__proto__`.
 *
 * L'identifiant vient de `conversation_turns.agent_id`, une colonne de texte libre relue au
 * tour suivant par le palier COLLANT du routage. Une ligne portant l'un de ces cinq noms
 * condamnait le fil : chaque message levait avant même d'atteindre le modèle.
 * `KNOWN_AGENT_IDS` filtre déjà en amont, mais une fonction dont le contrat dit « jamais
 * d'exception » ne doit pas dépendre de la vigilance de son appelant.
 */
export function agentHasTool(agentId: string, toolName: string): boolean {
  if (!Object.hasOwn(AGENT_TOOLS, agentId)) return false;
  return AGENT_TOOLS[agentId].includes(toolName);
}
