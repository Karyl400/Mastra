import type {
  ChannelAccessSource,
  ChannelJoinResult,
  ChannelMemberScan,
  ChannelSnapshot,
} from '../../application/services/channel-coverage.service';
import type {
  SlackChannelMembershipPage,
  SlackJoinOutcome,
} from '../../../notification/infrastructure/providers/slack-workspace.service';
import {
  SLACK_MAX_PAGES,
  SLACK_PAGE_LIMIT,
} from '../../../notification/infrastructure/providers/slack-workspace.service';
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

  /**
   * `conversations.list` sous sa projection RICHE — la seule qui porte `num_members`.
   *
   * Elle n'est appelée que si `reportedMemberCounts` est demandé : c'est un SECOND balayage
   * complet du workspace, et le faire par défaut doublerait les appels de tout le monde pour un
   * chiffre dont seul l'inventaire a l'usage.
   */
  listChannels(): Promise<readonly { id: string; memberCount: number }[]>;

  /** `conversations.members`, déjà déroulé par le fournisseur. */
  getChannelMembers(channelId: string): Promise<readonly string[]>;
}

export interface SlackChannelAccessOptions {
  readonly maxPages?: number;

  /**
   * Demande l'assertion `num_members` de Slack, au prix d'un second `conversations.list`.
   *
   * Faux par défaut : ce composant est câblé dans `src/mastra/index.ts`, donc atteignable au
   * boot d'une fonction Vercel — celui qui est SUR le chemin des 3 secondes d'ACK de Slack. Le
   * script de synchronisation, lui, l'active.
   */
  readonly reportedMemberCounts?: boolean;
}

/**
 * Plafond du balayage des membres d'UN canal, en identifiants.
 *
 * ⚠️ Pourquoi il vit ICI et pas dans la boucle de curseur : `SlackWorkspaceService.getChannelMembers`
 * déroule `conversations.members` avec un `while (cursor)` NU, sans plafond de pages —
 * contrairement à toutes les autres boucles de ce fournisseur, qui respectent `SLACK_MAX_PAGES`.
 * Ce fichier ne peut pas corriger la boucle (elle vit dans `notification/infrastructure`, hors
 * du périmètre de ce lot), mais il peut refuser de faire passer une liste sans borne pour une
 * liste complète.
 *
 * La borne est DÉRIVÉE des deux constantes déjà en place — `SLACK_MAX_PAGES × SLACK_PAGE_LIMIT`
 * = 10 000 —, jamais saisie à la main : c'est exactement ce qu'aurait collecté une boucle
 * plafonnée. La franchir n'est donc pas une limite de capacité mais le signe d'une anomalie,
 * d'où la journalisation en `error` et le drapeau `truncated`. Un plafond silencieux se lit
 * « tout est synchronisé » — le mode d'échec que ce dépôt paie depuis `emailSent: false`.
 */
export const MEMBER_SCAN_CAP = SLACK_MAX_PAGES * SLACK_PAGE_LIMIT;

export class SlackChannelAccess implements ChannelAccessSource {
  private readonly maxPages: number;
  private readonly reportedMemberCounts: boolean;

  constructor(
    private readonly slack: SlackChannelReader,
    options: SlackChannelAccessOptions = {},
  ) {
    this.maxPages = options.maxPages ?? SLACK_MAX_PAGES;
    this.reportedMemberCounts = options.reportedMemberCounts ?? false;
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
    const reported = await this.readReportedMemberCounts();

    const channels: ChannelSnapshot[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await this.slack.listChannelMembershipsPage(cursor);

      for (const channel of page.channels) {
        if (!channel.id) continue;

        // La clé n'est POSÉE que si Slack a effectivement affirmé quelque chose. Un
        // `memberCountReported: null` systématique ferait dire à l'instantané « Slack affirme
        // qu'il n'y a rien à affirmer », là où son ABSENCE dit ce qui est vrai : cette source
        // ne porte pas l'assertion. Le consommateur retombe sur `null` par `?? null`.
        const count = reported.get(channel.id);

        channels.push({
          id: channel.id,
          name: channel.name,
          isPrivate: channel.isPrivate,
          isArchived: channel.isArchived,
          isMember: channel.isMember,
          ...(count === undefined ? {} : { memberCountReported: count }),
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

  /**
   * Membres observés d'un canal, BORNÉS.
   *
   * ⚠️ N'appeler que sur un canal où le bot est membre : `conversations.members` répond
   * `channel_not_found` sur un canal privé dont il est absent. Cette garde vit chez l'appelant
   * (`recordInventory`), qui est le seul à savoir ce que la passe d'adhésion vient de changer.
   *
   * On ne rattrape PAS l'erreur ici : un refus de Slack sur l'énumération n'est pas un état
   * métier nommé comme le sont ceux de `join`. L'appelant le convertit en échec d'inventaire,
   * par canal, sans couler la passe.
   */
  async listMembers(channelId: string): Promise<ChannelMemberScan> {
    const collected = await this.slack.getChannelMembers(channelId);

    // Les identifiants vides sont écartés : ils ne désignent personne et gonfleraient le
    // `COUNT(*)`, c'est-à-dire le seul chiffre que cet inventaire existe pour rendre.
    const memberIds = collected.filter(Boolean);

    if (memberIds.length >= MEMBER_SCAN_CAP) {
      logger.error('Slack channel member scan TRUNCATED — some members were never recorded', {
        channelId,
        collected: memberIds.length,
        cap: MEMBER_SCAN_CAP,
      });
      return { memberIds: memberIds.slice(0, MEMBER_SCAN_CAP), truncated: true };
    }

    return { memberIds, truncated: false };
  }

  /**
   * L'assertion `num_members` de Slack, par identifiant de canal. Vide si non demandée.
   *
   * ⚠️ **Un `0` est retraduit en `null`.** `SlackWorkspaceService.listChannels()` projette
   * `ch.num_members ?? 0` : l'absence du champ — fréquente sur les canaux privés — y devient
   * indiscernable d'un canal vide. Or ce chiffre n'existe que pour être COMPARÉ au `COUNT(*)`
   * des membres observés, et l'écart entre les deux est le seul signal de fraîcheur d'un
   * inventaire qu'aucun événement Slack ne dément. Enregistrer un `0` fabriqué produirait un
   * écart permanent et FAUX sur chaque canal privé — un signal de fraîcheur qui crie en
   * permanence ne signale plus rien. `null` dit ce qui est vrai : Slack n'a rien affirmé.
   *
   * Un canal réellement vide n'existe pas dans ce workspace (le bot ou le créateur y sont), donc
   * la retraduction ne perd aucune information réelle.
   *
   * Ne lève pas : l'inventaire vaut d'être enregistré même sans l'assertion de Slack — c'est le
   * compte OBSERVÉ qui fait foi.
   */
  private async readReportedMemberCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!this.reportedMemberCounts) return counts;

    try {
      for (const channel of await this.slack.listChannels()) {
        if (!channel.id) continue;
        if (channel.memberCount > 0) counts.set(channel.id, channel.memberCount);
      }
    } catch (error) {
      logger.warn('Reported member counts unavailable — the inventory will record null', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return counts;
  }
}
