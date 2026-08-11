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
 * (`agentToolBoundary`) sans dépasser le FLOOR mesuré de l'agent.
 *
 * Ce qui a sauté — « pour mesurer l'adéquation culturelle et les compétences des
 * nouveaux arrivants » — décrivait l'INTENTION métier, que le modèle n'a aucun
 * moyen d'appliquer ; ce qui reste — questions pertinentes, feedback objectif —
 * porte sur la sortie, donc sur quelque chose d'observable.
 *
 * La frontière, elle, corrige un défaut mesuré sur cet agent précisément : en B5
 * il a proposé « je peux lui renvoyer le lien » alors qu'il n'a AUCUN tool d'envoi,
 * et en B6 il a inventé une règle métier (« je ne peux pas modifier un
 * questionnaire qu'elle n'a pas encore reçu ») pour habiller l'absence de tout
 * tool de modification. Dans les deux cas, l'énumération positive de ses outils ne
 * lui disait rien de ce qui manquait.
 */
export function makeQuestionnaireEngine(tools: ToolsInput) {
  return new Agent({
    id: 'questionnaireEngine',
    name: 'Questionnaire Engine',
    instructions: buildAgentInstructions(`
Tu crées et évalues les questionnaires d'onboarding de Kisso : questions pertinentes, feedback objectif.

${agentToolBoundary(tools)}

${AGENT_STYLE_BLOCK}

${AGENT_ANTI_INVENTION_BLOCK}`),
    model: makeModelChain(),
    tools: tools,
  });
}
