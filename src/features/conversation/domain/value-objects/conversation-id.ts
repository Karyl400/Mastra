/**
 * Dérivation de la clé de conversation depuis le contexte Slack (décision D1 de la spec) :
 *
 *     conversationId = threadTs ? `${channel}:${threadTs}` : channel
 *
 * Pourquoi cette règle exactement, et pas « toujours threader » :
 *
 * - **En DM, `threadTs` est `undefined` PAR CONCEPTION.** Threader un DM avait rendu le bot
 *   silencieux en production ; le handler Slack ne calcule donc aucun `thread_ts` sur un
 *   `channel_type === 'im'`. La conversation est alors le canal `D…` lui-même : un DM est un
 *   fil unique et continu entre un humain et le bot, ce qui est exactement le comportement
 *   attendu de la mémoire.
 *
 * - **En canal, l'appelant passe `thread_ts ?? ts`.** Un thread est une conversation : tous ses
 *   messages partagent le `thread_ts` de leur racine. Un message posté hors thread ouvre la
 *   sienne, identifiée par son propre `ts` — sans quoi tout le canal, toutes discussions et tous
 *   interlocuteurs confondus, formerait une seule mémoire commune.
 *
 * Conséquence assumée : en canal, deux messages racine successifs du même utilisateur sont deux
 * conversations distinctes. C'est le prix de l'isolement entre threads, et Slack n'offre pas de
 * meilleur discriminant.
 *
 * TypeScript pur — ZÉRO import de framework.
 */

export interface SlackConversationRef {
  /** Identifiant de canal Slack : `D…` (DM), `C…` (public), `G…` (privé). */
  readonly channel: string;
  /** `thread_ts ?? ts` en canal ; `undefined` en DM, par conception. */
  readonly threadTs?: string | null;
}

export function deriveConversationId({ channel, threadTs }: SlackConversationRef): string {
  const normalizedChannel = channel.trim();
  if (!normalizedChannel) {
    // Sans cette garde, une clé vide fusionnerait TOUTES les conversations en une seule
    // mémoire partagée — une fuite de contexte entre utilisateurs, pas un simple bug.
    throw new Error('deriveConversationId: channel is required');
  }

  const normalizedThreadTs = threadTs?.trim();
  return normalizedThreadTs ? `${normalizedChannel}:${normalizedThreadTs}` : normalizedChannel;
}
