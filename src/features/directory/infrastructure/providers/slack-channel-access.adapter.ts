import type {
  ChannelAccessSource,
  ChannelJoinResult,
  ChannelSnapshot,
} from '../../application/services/channel-coverage.service';
import type {
  SlackChannelMembershipPage,
  SlackJoinOutcome,
} from '../../../notification/infrastructure/providers/slack-workspace.service';
import { SLACK_MAX_PAGES } from '../../../notification/infrastructure/providers/slack-workspace.service';
import { logger } from '../../../../shared/logger';

/**
 * Le pont entre `ChannelCoverageService` (qui ne connaît pas Slack) et `SlackWorkspaceService`
 * (qui ne connaît que lui). Rien d'autre : pas une décision, pas une politique.
 *
 * Il vit en `infrastructure` pour la même raison que `SlackMemberSource` — c'est la seule
 * couche où deux features peuvent se croiser.
 */

/**
 * Le strict nécessaire côté Slack : lire une page de canaux, rejoindre un canal.
 *
 * `SlackWorkspaceService` le satisfait structurellement. On ne dépend pas de
 * `SlackWorkspaceProvider` : ses 7 méthodes incluent `inviteToChannel`, un droit d'écriture sur
 * l'appartenance des AUTRES, dont la couverture de canaux n'a aucun usage.
 */
export interface SlackChannelReader {
  listChannelMembershipsPage(cursor?: string, limit?: number): Promise<SlackChannelMembershipPage>;
  joinChannel(channelId: string): Promise<SlackJoinOutcome>;
}

export interface SlackChannelAccessOptions {
  readonly maxPages?: number;
}

export class SlackChannelAccess implements ChannelAccessSource {
  private readonly maxPages: number;

  constructor(
    private readonly slack: SlackChannelReader,
    options: SlackChannelAccessOptions = {},
  ) {
    this.maxPages = options.maxPages ?? SLACK_MAX_PAGES;
  }

  /**
   * Balayage PAGINÉ et BORNÉ, comme celui des membres.
   *
   * `conversations.list` rend 100 entrées par défaut. Un balayage partiel ne laisserait pas le
   * bot dans un canal : il l'empêcherait d'y ENTRER, et le symptôme serait un `not_in_channel`
   * silencieux des mois plus tard, sur un canal que personne ne se souvient d'avoir créé après
   * la centième ligne.
   *
   * Les canaux sans identifiant sont écartés : un `join('')` ne peut rien rejoindre et
   * fabriquerait un échec qui ne désigne rien.
   */
  async listChannels(): Promise<{ channels: ChannelSnapshot[]; truncated: boolean }> {
    const channels: ChannelSnapshot[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await this.slack.listChannelMembershipsPage(cursor);

      for (const channel of page.channels) {
        if (!channel.id) continue;
        channels.push({
          id: channel.id,
          name: channel.name,
          isPrivate: channel.isPrivate,
          isArchived: channel.isArchived,
          isMember: channel.isMember,
        });
      }

      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < this.maxPages);

    const truncated = Boolean(cursor);
    if (truncated) {
      logger.error('Slack channel scan TRUNCATED — some channels were never considered', {
        pages,
        collected: channels.length,
        cap: this.maxPages,
      });
    }

    return { channels, truncated };
  }

  /** `joinChannel` ne lève jamais : chaque refus de Slack est déjà un état nommé. */
  async join(channelId: string): Promise<ChannelJoinResult> {
    const outcome = await this.slack.joinChannel(channelId);
    return { status: outcome.status, error: outcome.error };
  }
}
