export interface ChannelMessage {
  readonly authorId: string | null;
  readonly authorLabel: string;
  readonly text: string;
  readonly at: Date;
  readonly isBot: boolean;
}

export type ChannelUnavailableReason = 'bot_not_in_channel' | 'channel_not_found' | 'unavailable';

export class ChannelUnavailableError extends Error {
  constructor(
    readonly reason: ChannelUnavailableReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ChannelUnavailableError';
  }
}

export interface ChannelHistoryReadOptions {
  readonly sinceMs: number;
  readonly limit: number;
}

export interface ChannelHistoryPort {
  isMember(channelId: string, slackUserId: string): Promise<boolean>;

  fetchRecent(channelId: string, options: ChannelHistoryReadOptions): Promise<ChannelMessage[]>;

  /**
   * ⚠️ **LES CANAUX DU DEMANDEUR, pas ceux du bot — et la distinction est la garantie.**
   *
   * Ajouté le 2026-08-21 pour que `searchKnowledge` puisse lire Slack EN DIRECT avant de
   * prétendre ne rien savoir. En partant des canaux dont le DEMANDEUR est membre, la frontière
   * de divulgation est tenue par la construction même de la liste : il n'y a rien à filtrer
   * après coup, donc rien à oublier de filtrer.
   *
   * Rend une liste vide plutôt que de lever : un repli qui échoue doit dégrader vers « je ne
   * sais pas », jamais faire échouer la recherche.
   */
  listMemberChannels(slackUserId: string, limit: number): Promise<string[]>;
}
