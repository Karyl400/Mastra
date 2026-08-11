import type { ConversationTurn, NewConversationTurn } from '../entities/conversation-turn';

/**
 * TTL UNIQUE gouvernant à la fois la mémoire conversationnelle ET le routage collant
 * (décision D1 de la spec) : 60 minutes d'inactivité.
 *
 * Un seul paramètre plutôt que trois — mémoire, collance, rétention — qui divergeraient au
 * premier réglage. Au-delà de ce délai, le fil est considéré clos : ni contexte rejoué, ni
 * agent collant.
 */
export const CONVERSATION_TTL_MS = 60 * 60 * 1000;

export interface RecentTurnsOptions {
  /** Fenêtre de fraîcheur. En pratique `CONVERSATION_TTL_MS`. */
  readonly ttlMs: number;
  /**
   * Garde-fou de REQUÊTE (ex. 50) : plafonne ce qu'on charge avant de fenêtrer, pour ne
   * jamais tirer un fil entier de mille messages en mémoire. Ce n'est PAS le plafond de
   * contexte — celui-là se compte en tokens, via `selectWindow`.
   */
  readonly limit: number;
}

export interface ConversationRepository {
  append(turn: NewConversationTurn): Promise<ConversationTurn>;

  /** Tours d'une conversation, du plus ancien au plus récent, ignorant ceux au-delà du TTL. */
  recentTurns(conversationId: string, options: RecentTurnsOptions): Promise<ConversationTurn[]>;

  /** Purge les tours au-delà du TTL. Appelé opportunément, pas par un cron. */
  prune(olderThan: Date): Promise<number>;
}
