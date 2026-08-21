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
 * ⚠️ **UNE CONSIGNE RETIRÉE LE 2026-08-21, ET IL FALLAIT LA RETIRER : ELLE ÉTAIT DEVENUE FAUSSE.**
 *
 * Elle disait « Un rappel est seulement ENREGISTRÉ : aucun automate ne l'enverra, dis-le sans
 * détour ». C'était exact jusqu'au cron quotidien (`domain/services/reminder-dispatch.ts`).
 * Depuis, elle demandait à Marcel d'affirmer quelque chose de FAUX — la faute que tout ce dépôt
 * est construit pour éviter, retournée contre lui.
 *
 * ⚠️ Elle n'est remplacée par RIEN. Le moment de remise n'est pas confié à une consigne : le
 * tool ne rend plus que `deliveredOn` (« le lundi 24 août 2026 au matin », sans heure) et le
 * handler accole la précision manquante. Une consigne est PROBABLE — celle-ci avait d'ailleurs
 * été mesurée en échec le 2026-08-19, la réponse suivante gagnant une heure d'envoi précise.
 * Le code est GARANTI, et il coûte zéro token par aller-retour.
 */
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
