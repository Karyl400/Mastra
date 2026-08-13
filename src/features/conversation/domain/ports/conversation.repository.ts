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

/**
 * Portée d'un effacement demandé par une PERSONNE — à ne pas confondre avec `prune`, qui est
 * une purge de rétention déclenchée par le temps.
 *
 * Les deux ne peuvent pas partager une méthode : `prune` supprime ce qui est vieux, partout ;
 * ici on supprime ce qui appartient à quelqu'un, quel que soit son âge. Confondre les deux
 * donnerait à une demande d'effacement une portée globale.
 */
export interface ForgetScope {
  readonly conversationId: string;
  /**
   * Quand il est fourni, SEULS les tours émis par cette personne sont supprimés.
   *
   * C'est ce qui distingue un DM d'un fil de canal, et la distinction est nécessaire. En DM
   * la conversation EST l'espace privé d'une seule personne (`deriveConversationId` retombe
   * sur le canal `D…`) : tout y est à elle, tours `assistant` compris, donc on efface tout.
   * Dans un fil de canal, plusieurs humains parlent — effacer le fil entier parce que l'un
   * d'eux le demande supprimerait les messages des autres, ce que personne n'a demandé.
   *
   * ⚠️ Les tours `assistant` portent `slackUserId: null` : filtrer par personne les laisse
   * donc en place. C'est correct et voulu — `selectWindow` s'arrête sur une salve
   * d'`assistant` sans question en amont plutôt que de la rejouer nue, donc les réponses
   * orphelines cessent d'être rejouées d'elles-mêmes.
   */
  readonly slackUserId?: string | null;
}

export interface ConversationRepository {
  append(turn: NewConversationTurn): Promise<ConversationTurn>;

  /** Tours d'une conversation, du plus ancien au plus récent, ignorant ceux au-delà du TTL. */
  recentTurns(conversationId: string, options: RecentTurnsOptions): Promise<ConversationTurn[]>;

  /** Purge les tours au-delà du TTL. Appelé opportunément, pas par un cron. */
  prune(olderThan: Date): Promise<number>;

  /**
   * Efface à la demande, et rend le NOMBRE de tours réellement supprimés.
   *
   * Le compte n'est pas un confort de journalisation : c'est lui qui permet à la réponse de
   * dire ce qui s'est passé plutôt que de l'affirmer. Sans lui, le bot ne pourrait que
   * réciter « c'est fait » — précisément le défaut que ce dépôt corrige partout ailleurs.
   */
  forget(scope: ForgetScope): Promise<number>;
}
