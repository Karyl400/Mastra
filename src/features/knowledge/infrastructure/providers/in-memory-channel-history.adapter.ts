import {
  ChannelUnavailableError,
  type ChannelHistoryPort,
  type ChannelHistoryReadOptions,
  type ChannelMessage,
  type ChannelUnavailableReason,
} from '../../domain/ports/channel-history.port';

/**
 * Doublure du `ChannelHistoryPort` — c'est elle, et non un mock manuel de
 * `WebClient`, qui sert de vis-à-vis aux tests des tools.
 *
 * Elle porte les trois comportements dont dépend la sécurité de la feature :
 * l'appartenance PAR DEMANDEUR (et non par bot), la fenêtre de fraîcheur, et
 * l'indisponibilité typée. Une doublure qui rendrait tout à tout le monde
 * validerait au vert le deputy confus lui-même.
 */
export class InMemoryChannelHistoryAdapter implements ChannelHistoryPort {
  private readonly members = new Map<string, Set<string>>();
  private readonly messages = new Map<string, ChannelMessage[]>();
  private readonly failures = new Map<string, ChannelUnavailableReason>();

  /** Déclare les membres d'un canal — ceux du DEMANDEUR, pas ceux du bot. */
  setMembers(channelId: string, slackUserIds: readonly string[]): void {
    this.members.set(channelId, new Set(slackUserIds));
  }

  seed(channelId: string, messages: readonly ChannelMessage[]): void {
    this.messages.set(channelId, [...messages]);
  }

  /** Simule un canal où le bot n'est pas, ou une panne Slack. */
  failWith(channelId: string, reason: ChannelUnavailableReason): void {
    this.failures.set(channelId, reason);
  }

  async isMember(channelId: string, slackUserId: string): Promise<boolean> {
    return this.members.get(channelId)?.has(slackUserId) ?? false;
  }

  async fetchRecent(
    channelId: string,
    options: ChannelHistoryReadOptions,
  ): Promise<ChannelMessage[]> {
    const failure = this.failures.get(channelId);
    if (failure) {
      throw new ChannelUnavailableError(failure, `canal ${channelId} indisponible (${failure})`);
    }

    const cutoff = Date.now() - options.sinceMs;

    const fresh = (this.messages.get(channelId) ?? []).filter(
      (message) => message.at.getTime() >= cutoff,
    );

    // Comme le vrai adaptateur : les plus RÉCENTS d'abord côté source, remis à
    // l'endroit ensuite. Un `slice` sur l'ordre d'insertion ferait passer au vert
    // une borne que Slack ne tient pas.
    const newestFirst = [...fresh].sort((a, b) => b.at.getTime() - a.at.getTime());

    return newestFirst.slice(0, options.limit).reverse();
  }
}
