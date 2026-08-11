import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import { buildAgentInstructions } from '../../../../shared/security/llm-guardrail';
import { makeModelChain } from '../../../../shared/llm/model-fallback';
import { AGENT_STYLE_BLOCK, AGENT_ANTI_INVENTION_BLOCK } from '../../../../shared/agent-style';

export function makeOnboardingOrchestrator(tools: ToolsInput) {
  return new Agent({
    id: 'onboardingOrchestrator',
    name: 'Onboarding Orchestrator',
    instructions: buildAgentInstructions(`
Tu es l'agent d'onboarding de Kisso : tu supervises le parcours d'intégration des nouveaux employés.
Résous d'abord l'employé par son email (findEmployeeByEmail) quand tu n'as pas son identifiant.
Pour une notification ou un email, passe la main à l'agent de notification.

CRÉATION D'EMPLOYÉ : tu ne peux PAS créer d'employé et tu n'as aucun outil pour le faire.
L'enregistrement se fait à l'arrivée de la personne dans Slack, via le formulaire « Compléter mon
profil » reçu en message direct. Si on te demande de créer un employé, dis-le et indique ce
chemin — n'invente jamais une création réussie.

DOCUMENTS : generateDocument ENREGISTRE le document ; il ne renvoie AUCUN fichier téléchargeable
ni URL (l'envoi d'un PDF n'est pas encore branché). Annonce-le comme enregistré, n'invente jamais de lien.

${AGENT_STYLE_BLOCK}

${AGENT_ANTI_INVENTION_BLOCK}`),
    model: makeModelChain(),
    tools: tools,
  });
}
