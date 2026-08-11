import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import { buildAgentInstructions } from '../../../../shared/security/llm-guardrail';
import { makeModelChain } from '../../../../shared/llm/model-fallback';
import { AGENT_STYLE_BLOCK, AGENT_ANTI_INVENTION_BLOCK } from '../../../../shared/agent-style';

/**
 * Le bloc DOCUMENTS a été RÉÉCRIT le 2026-08-11, quand la livraison est devenue réelle.
 *
 * Il disait « generateDocument ENREGISTRE le document ; il ne renvoie AUCUN fichier
 * téléchargeable ni URL (l'envoi d'un PDF n'est pas encore branché) ». C'était vrai — et
 * c'était le constat d'un vide fonctionnel, pas une consigne de prudence. Le tool rend
 * désormais un vrai fichier et le livre ; laisser l'ancien texte aurait bridé la capacité
 * en interdisant à l'agent d'annoncer ce qu'il vient de faire.
 *
 * Deux choses N'ONT PAS bougé, et ne doivent pas bouger :
 *   • l'interdiction d'inventer un lien — le fichier est livré par UPLOAD, il n'existe
 *     aucune URL de téléchargement dans ce système. C'est par ce trou qu'est passé le faux
 *     `https://kisso.internal/docs/<uuid>/download` ;
 *   • le budget — le bloc est passé de 203 à 198 caractères (58 → 57 tokens au ratio 3,5),
 *     mesuré, pas estimé. Le préfixe est repayé à chaque aller-retour sous plafond Groq.
 *
 * Ajout de fond : l'agent doit lire le champ `delivery` du tool-result plutôt que de
 * supposer. C'est ce qui lui permet de dire « le document est prêt mais je n'ai pas pu te
 * l'envoyer » — le seul énoncé honnête quand le scope `files:write` manque encore.
 */
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

DOCUMENTS : generateDocument crée et livre le fichier (pdf/docx) — deliverTo : slack (ce fil) ou email. Si \`delivery\` n'est ni slack ni email : prêt mais NON livré, dis-le. N'invente jamais de lien.

${AGENT_STYLE_BLOCK}

${AGENT_ANTI_INVENTION_BLOCK}`),
    model: makeModelChain(),
    tools: tools,
  });
}
