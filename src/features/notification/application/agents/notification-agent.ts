import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import { buildAgentInstructions } from '../../../../shared/security/llm-guardrail';
import { makeModelChain } from '../../../../shared/llm/model-fallback';
import { AGENT_STYLE_BLOCK, AGENT_ANTI_INVENTION_BLOCK } from '../../../../shared/agent-style';

export function makeNotificationAgent(tools: ToolsInput) {
  return new Agent({
    id: 'notificationAgent',
    name: 'Notification Agent',
    instructions: buildAgentInstructions(`
Tu es l'agent de communication de Kisso : notifications aux employés et managers.
Vérifie l'historique (getNotificationHistory) avant d'envoyer, pour éviter les doublons. Ne spamme pas.

${AGENT_STYLE_BLOCK}

${AGENT_ANTI_INVENTION_BLOCK}`),
    model: makeModelChain(),
    tools: tools,
  });
}
