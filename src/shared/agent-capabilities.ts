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
};

/** Cet agent porte-t-il cet outil ? Un agent inconnu ne porte rien — jamais d'exception. */
export function agentHasTool(agentId: string, toolName: string): boolean {
  return AGENT_TOOLS[agentId]?.includes(toolName) ?? false;
}
