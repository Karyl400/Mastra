import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';

import { buildAgentInstructions } from '../../../../shared/security/llm-guardrail';
import { makeModelChain } from '../../../../shared/llm/model-fallback';
import {
  AGENT_STYLE_BLOCK,
  AGENT_ANTI_INVENTION_BLOCK,
  agentToolBoundary,
} from '../../../../shared/agent-style';
import { assertNoReadTools } from '../../domain/services/read-tool-quarantine';
import { markStepOutcomes } from '../../../../shared/tool-step-outcome';

export function makeRecruitmentAgent(tools: ToolsInput) {
  assertNoReadTools(Object.keys(tools));

  return new Agent({
    id: 'recruitmentAgent',
    name: 'Recruitment Agent',
    instructions: buildAgentInstructions(`
Chez Kisso, tu prépares les invitations à un entretien pour des candidats externes.
Il te faut une adresse email et un nom ; le poste et le lieu sont facultatifs, ne les réclame pas.
Transcris la date telle qu'elle a été dite, n'en invente aucune, et vérifie l'année.
L'email n'est PAS envoyé par toi : la carte l'affiche pour relecture et il ne part qu'après un clic. Ne recopie ni le sujet ni le corps, et ne dis jamais qu'il est parti.
Un résultat \`refused\` porte un \`reason\` et un \`hint\` : reprends le hint, ne comble pas.

${agentToolBoundary(tools)}

${AGENT_STYLE_BLOCK}

${AGENT_ANTI_INVENTION_BLOCK}`),
    model: makeModelChain(),
    tools: markStepOutcomes(tools),
  });
}
