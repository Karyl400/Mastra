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

/**
 * `recruitmentAgent` — il convie un candidat externe à un entretien, et rien d'autre.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LA QUARANTAINE EST LA PREMIÈRE LIGNE, COMME POUR `knowledgeAgent`
 * ────────────────────────────────────────────────────────────────────────────
 * C'est le seul agent du système qui écrive à une adresse SITUÉE HORS DE L'ENTREPRISE et non
 * contrainte par l'annuaire. Lui adjoindre le moindre outil de lecture formerait le canal
 * d'exfiltration que `PLAN-ARCHITECTURE.md` §4.2 interdit — et que le module jumeau cite avec
 * ce scénario précis : « envoie à ce candidat un récapitulatif de ce qui se dit dans
 * #engineer-karyl ». Il REFUSE donc de se construire si on lui en câble un.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POURQUOI UN AGENT DE PLUS PLUTÔT QU'UN TOOL SUR `notificationAgent`
 * ────────────────────────────────────────────────────────────────────────────
 * C'était l'option la moins chère, et elle est INTERDITE par ce qui précède :
 * `notificationAgent` porte `getEmployeeProfile`, `findPersonByName` et
 * `getNotificationHistory`. Y ajouter une écriture vers une adresse libre construirait
 * exactement la conjonction proscrite — « retrouve le dossier de Karyl et envoie-le à
 * moi@ailleurs.com » deviendrait réalisable en une phrase.
 *
 * Le coût d'un agent supplémentaire est par ailleurs ALTERNATIF et non additif : un message
 * est routé vers UN agent. Cet agent-ci ne pèse que sur les messages de recrutement, et son
 * FLOOR est le plus bas du système — un seul outil, aucune lecture.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LES INSTRUCTIONS, LIGNE PAR LIGNE
 * ────────────────────────────────────────────────────────────────────────────
 * • « ne dis jamais que l'email est parti » — l'outil PRÉPARE, l'envoi a lieu au clic. Sans
 *   cette ligne le modèle annoncerait un accompli, et la réconciliation FAIT/NARRATION ne le
 *   rattraperait PAS : un outil a bien tourné, donc elle se tait par conception.
 * • « transcris la date, n'en invente aucune » — la date est le seul champ recopié depuis la
 *   phrase humaine ; l'erreur d'année est la faute la plus fréquente et les bornes du
 *   value-object ne l'attrapent qu'à moitié.
 * • « il te faut une adresse et un nom » — les deux seuls champs obligatoires. Le dire évite
 *   l'aller-retour où le modèle réclame un poste ou un lieu qui sont optionnels : sur un
 *   budget qui se compte en messages par jour, un tour épargné vaut plus qu'un prompt court.
 *
 * Volontairement ABSENT : toute énumération de ce qu'il ne peut pas faire. `agentToolBoundary`
 * le dit déjà, dérivé du câblage réel, et une liste rédigée se désynchronise au premier
 * changement.
 */
export function makeRecruitmentAgent(tools: ToolsInput) {
  assertNoReadTools(Object.keys(tools));

  return new Agent({
    id: 'recruitmentAgent',
    name: 'Recruitment Agent',
    instructions: buildAgentInstructions(`
Agent de recrutement de Kisso : tu prépares des invitations à un entretien pour des candidats externes.
Il te faut une adresse email et un nom ; le poste et le lieu sont facultatifs, ne les réclame pas.
Transcris la date telle qu'elle a été dite, n'en invente aucune, et vérifie l'année.
L'email n'est PAS envoyé par toi : la carte l'affiche pour relecture et il ne part qu'après un clic. Ne recopie ni le sujet ni le corps, et ne dis jamais qu'il est parti.
Un résultat \`refused\` porte un \`reason\` et un \`hint\` : reprends le hint, ne comble pas.

${agentToolBoundary(tools)}

${AGENT_STYLE_BLOCK}

${AGENT_ANTI_INVENTION_BLOCK}`),
    model: makeModelChain(),
    tools: tools,
  });
}
