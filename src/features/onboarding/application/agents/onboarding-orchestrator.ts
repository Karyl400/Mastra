import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import { buildAgentInstructions } from '../../../../shared/security/llm-guardrail';
import { makeModelChain } from '../../../../shared/llm/model-fallback';
import {
  AGENT_STYLE_BLOCK,
  AGENT_ANTI_INVENTION_BLOCK,
  agentToolBoundary,
} from '../../../../shared/agent-style';

export function makeOnboardingOrchestrator(tools: ToolsInput) {
  return new Agent({
    id: 'onboardingOrchestrator',
    name: 'Onboarding Orchestrator',
    instructions: buildAgentInstructions(`
Tu es l'agent d'onboarding de Kisso : tu supervises le parcours d'intégration des nouveaux employés.
Si tu as l'email, passe-le DIRECTEMENT à getEmployeeProfile : n'appelle pas findEmployeeByEmail avant. Sinon, résous par findPersonByName (nom) ou findEmployeeByEmail (pour obtenir l'UUID qu'exige generateDocument).

${agentToolBoundary(tools)}

CRÉATION D'EMPLOYÉ : tu ne peux PAS créer d'employé. L'enregistrement part du DM « Compléter mon profil », reçu quand la personne rejoint Slack — dis-le, n'invente jamais une création réussie.

DOCUMENTS : generateDocument crée et livre le fichier (pdf/docx) — deliverTo : slack (ce fil) ou email. Rédige \`content\` TOI-MÊME, ne le demande jamais. Nomme le \`recipient\`. Si \`delivery\` n'est ni slack ni email : prêt mais NON livré, dis-le. N'invente jamais de lien.

${AGENT_STYLE_BLOCK}

${AGENT_ANTI_INVENTION_BLOCK}`),
    model: makeModelChain(),
    tools: tools,
  });
}
