/**
 * Un tour de conversation : un message, et un seul, échangé avec un agent.
 *
 * On ne stocke QUE du texte. Jamais de `tool-call`, jamais de `tool-result`
 * (décision D3 de la spec) : un unique retour de `getEmployeeProfile` pesait
 * 979 tokens, soit davantage que six messages d'utilisateur réunis. Les exclure
 * est un levier de −63 % sur la fenêtre, gratuit.
 *
 * TypeScript pur — ZÉRO import de framework, la couche `domain` ne dépend de rien.
 */
export interface ConversationTurn {
  readonly id: string;
  /** Clé dérivée du contexte Slack — voir `value-objects/conversation-id.ts`. */
  readonly conversationId: string;
  readonly role: ConversationRole;
  /**
   * Texte du message.
   * - `user` : n'est écrit qu'après avoir passé `wrapAgentInput` sans lever, donc
   *   un message bloqué pour injection ne se rejoue jamais (décision D4).
   * - `assistant` : n'est écrit qu'APRÈS `sanitizeAgentOutput`, sinon l'unique
   *   filet anti-marqueurs serait contourné à chaque rejeu.
   */
  readonly content: string;
  /** Agent ayant produit ou reçu ce tour — porte aussi le routage collant (décision D5). */
  readonly agentId: string;
  /** `null` pour un tour `assistant`, qui n'émane d'aucun humain. */
  readonly slackUserId: string | null;
  readonly createdAt: Date;
}

export type ConversationRole = 'user' | 'assistant';

/** Données d'un tour avant persistance : l'identité et l'horodatage appartiennent au dépôt. */
export type NewConversationTurn = Omit<ConversationTurn, 'id' | 'createdAt'>;
