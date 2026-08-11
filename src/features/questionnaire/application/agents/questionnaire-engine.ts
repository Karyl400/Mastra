import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import { buildAgentInstructions } from '../../../../shared/security/llm-guardrail';
import { makeModelChain } from '../../../../shared/llm/model-fallback';
import { AGENT_STYLE_BLOCK, AGENT_ANTI_INVENTION_BLOCK } from '../../../../shared/agent-style';

export function makeQuestionnaireEngine(tools: ToolsInput) {
  return new Agent({
    id: 'questionnaireEngine',
    name: 'Questionnaire Engine',
    instructions: buildAgentInstructions(`
Tu crées et évalues les questionnaires d'onboarding de Kisso, pour mesurer l'adéquation culturelle
et les compétences des nouveaux arrivants : questions pertinentes, feedbacks objectifs et constructifs.

${AGENT_STYLE_BLOCK}

${AGENT_ANTI_INVENTION_BLOCK}`),
    model: makeModelChain(),
    tools: tools,
  });
}
