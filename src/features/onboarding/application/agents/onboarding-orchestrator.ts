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
 * ── Ce qui a été SUPPRIMÉ le 2026-08-11, et pourquoi ────────────────────────
 * « Pour une notification ou un email, passe la main à l'agent de notification. »
 *
 * Aucun mécanisme de passation n'existe : ni tool, ni primitive de routage
 * accessible au modèle. Le choix de l'agent est fait EN AMONT, dans
 * `slack-events.handler.ts`, sur le texte du message ; un agent en cours
 * d'exécution ne peut rien transmettre à un autre. Cette ligne ordonnait donc
 * l'impossible — et une instruction impossible n'est pas neutre : elle invite le
 * modèle à NARRER la délégation (« je transmets ça à l'agent de notification »),
 * ce qui se lit comme une action réalisée. Elle était en plus repayée à chaque
 * aller-retour. Elle est remplacée par la frontière dérivée ci-dessous, qui dit
 * la vérité : ces outils-là, et rien d'autre.
 *
 * ── Le bloc CRÉATION D'EMPLOYÉ, resserré et non supprimé ────────────────────
 * C'est le seul refus qui ait fonctionné en production (A3), et le chemin de
 * remplacement qu'il cite est RÉEL : `handleTeamJoin` ouvre un DM portant le
 * bouton « Compléter mon profil », la modale collecte les données et le workflow
 * est appelé en code, sans LLM. Ce qui manquait était sa CONDITION : ce DM ne part
 * que quand la personne rejoint le workspace Slack. Dire « elle recevra un
 * formulaire » sans dire quand laisse croire à une RH que le dossier est réglé,
 * alors que rien ne partira tant que l'arrivée n'a pas eu lieu.
 *
 * ── Le bloc DOCUMENTS ───────────────────────────────────────────────────────
 * Il a été réécrit le 2026-08-11 quand la livraison est devenue réelle : le tool
 * rend un vrai fichier et le livre. Deux choses n'ont pas bougé : l'interdiction
 * d'inventer un lien (le fichier est livré par UPLOAD, aucune URL de
 * téléchargement n'existe dans ce système — c'est par ce trou qu'est passé le faux
 * `https://kisso.internal/docs/<uuid>/download`), et l'obligation de lire le champ
 * `delivery` plutôt que de supposer.
 *
 * S'y ajoute la seule contrainte existante sur le CONTENU d'un document.
 * `sanitizeAgentOutput` ne s'applique qu'à `response.text` : les arguments de tool
 * ne le traversent jamais. Vérifié en décodant la CMap de vrais PDF — les emojis
 * sortent en glyphe `.notdef` (carrés, Roboto étant la seule police du VFS) et le
 * markdown s'imprime littéralement. Un filet de code est posé par ailleurs et
 * reste le seul garant réel ; cette consigne est la ceinture, pas les bretelles.
 */
export function makeOnboardingOrchestrator(tools: ToolsInput) {
  return new Agent({
    id: 'onboardingOrchestrator',
    name: 'Onboarding Orchestrator',
    instructions: buildAgentInstructions(`
Tu es l'agent d'onboarding de Kisso : tu supervises le parcours d'intégration des nouveaux employés.
Résous d'abord l'employé par son email (findEmployeeByEmail) quand tu n'as pas son identifiant.

${agentToolBoundary(tools)}

CRÉATION D'EMPLOYÉ : tu ne peux PAS créer d'employé. L'enregistrement part du DM « Compléter mon profil », reçu quand la personne rejoint Slack — dis-le, n'invente jamais une création réussie.

DOCUMENTS : generateDocument crée et livre le fichier (pdf/docx) — deliverTo : slack (ce fil) ou email. Son \`content\` n'est filtré par rien : ni markdown ni emoji. Si \`delivery\` n'est ni slack ni email : prêt mais NON livré, dis-le. N'invente jamais de lien.

${AGENT_STYLE_BLOCK}

${AGENT_ANTI_INVENTION_BLOCK}`),
    model: makeModelChain(),
    tools: tools,
  });
}
