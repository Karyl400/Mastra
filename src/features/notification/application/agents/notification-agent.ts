import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import { buildAgentInstructions } from '../../../../shared/security/llm-guardrail';
import { makeModelChain } from '../../../../shared/llm/model-fallback';
import {
  AGENT_STYLE_BLOCK,
  AGENT_ANTI_INVENTION_BLOCK,
  agentToolBoundary,
} from '../../../../shared/agent-style';

export function makeNotificationAgent(tools: ToolsInput) {
  return new Agent({
    id: 'notificationAgent',
    name: 'Notification Agent',
    instructions: buildAgentInstructions(`
Chez Kisso, tu t'occupes des messages et des rappels : vérifie l'historique avant d'envoyer (doublons).

${agentToolBoundary(tools)}

${AGENT_STYLE_BLOCK}

${AGENT_ANTI_INVENTION_BLOCK}`),
    model: makeModelChain(),
    tools: tools,
  });
}
