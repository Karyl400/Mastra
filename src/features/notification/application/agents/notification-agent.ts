import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import { buildAgentInstructions } from '../../../../shared/security/llm-guardrail';
import { makeModelChain } from '../../../../shared/llm/model-fallback';
import {
  AGENT_STYLE_BLOCK,
  AGENT_ANTI_INVENTION_BLOCK,
  agentToolBoundary,
} from '../../../../shared/agent-style';

/**
 * Le préambule a été resserré le 2026-08-11 pour financer la frontière négative
 * (`agentToolBoundary`) sans dépasser le FLOOR mesuré de l'agent. Le nom du tool
 * était cité en toutes lettres — `getNotificationHistory` — alors que la frontière
 * l'énumère déjà juste en dessous : la consigne se contente donc de dire QUAND
 * l'appeler, et « Ne spamme pas », qui n'ajoutait aucune règle vérifiable au
 * « pas de doublon » qui le précédait, a sauté.
 *
 * La frontière corrige un défaut mesuré sur cet agent : en C6 il a proposé un
 * rappel « programmé pour lundi 9h » — il a bien `scheduleReminder`, mais il l'a
 * annoncé sans jamais l'appeler ; et en C1 il a réclamé un email pro alors
 * qu'AUCUN de ses tools ne consomme un email. L'énumération positive de ses outils
 * ne lui disait rien de ce qui manquait.
 */
export function makeNotificationAgent(tools: ToolsInput) {
  return new Agent({
    id: 'notificationAgent',
    name: 'Notification Agent',
    instructions: buildAgentInstructions(`
Agent de communication de Kisso : vérifie l'historique avant d'envoyer (doublons).

${agentToolBoundary(tools)}

${AGENT_STYLE_BLOCK}

${AGENT_ANTI_INVENTION_BLOCK}`),
    model: makeModelChain(),
    tools: tools,
  });
}
