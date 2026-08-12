import { WebClient } from '@slack/web-api';

import { logger } from '../../../../shared/logger';
import {
  ChannelUnavailableError,
  type ChannelHistoryPort,
  type ChannelHistoryReadOptions,
  type ChannelMessage,
} from '../../domain/ports/channel-history.port';

/**
 * `conversations.history` / `conversations.members` — l'historique d'un canal.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SCOPES
 * ────────────────────────────────────────────────────────────────────────────
 * `channels:history`, `groups:history` et `im:history` SONT accordés (vérifié),
 * ainsi que `channels:read` / `groups:read` qui servent `conversations.members`.
 * Aucun geste humain n'est requis pour lire — mais le bot n'est aujourd'hui
 * membre que de 2 canaux sur 5, et `conversations.history` répond
 * `not_in_channel` partout ailleurs. Ce refus-là est traduit en un verdict
 * nommé, parce que c'est le seul cas qui appelle une action humaine (inviter le
 * bot), et parce que le dépôt a déjà payé cher les échecs muets.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠️ `isMember` PORTE SUR LE DEMANDEUR, PAS SUR LE BOT
 * ────────────────────────────────────────────────────────────────────────────
 * C'est la seule raison d'être de cette méthode. Slack n'expose pas « cet
 * utilisateur est-il dans ce canal ? » : `users.conversations` sans token
 * utilisateur répond pour le BOT, ce qui est exactement la question à ne pas
 * poser (§4.1). On énumère donc les membres du canal et on y cherche le
 * demandeur — un aller-retour, contre la confidentialité de tous les canaux
 * privés.
 *
 * L'énumération est PLAFONNÉE (`MAX_MEMBER_PAGES`). Un canal plus grand que ce
 * plafond rend `false` : refuser un accès légitime coûte une phrase, l'accorder
 * à tort coûte un canal privé.
 */

/** 1 000 membres par page × 5 pages : au-delà, on refuse plutôt que de deviner. */
const MEMBER_PAGE_SIZE = 1000;
const MAX_MEMBER_PAGES = 5;

/** Résout un `U…` en nom lisible. Injecté — l'adaptateur fonctionne sans. */
export type DisplayNameResolver = (slackUserId: string) => Promise<string | null>;

export interface SlackChannelHistoryOptions {
  readonly client?: WebClient;
  /**
   * En pratique : la recherche d'annuaire. Optionnelle à dessein — sans elle les
   * extraits portent l'identifiant brut, ce qui reste exploitable. La livraison
   * ne doit pas dépendre d'un confort d'affichage.
   */
  readonly resolveDisplayName?: DisplayNameResolver;
}

/** Lit `data.error` d'une erreur `@slack/web-api` sans dépendre de son typage. */
function slackErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const code = (data as { error?: unknown }).error;
  return typeof code === 'string' ? code : undefined;
}

function toUnavailable(error: unknown, channelId: string): ChannelUnavailableError {
  const code = slackErrorCode(error);

  if (code === 'not_in_channel' || code === 'missing_scope' || code === 'channel_not_found') {
    // `channel_not_found` est rendu par Slack pour un canal privé où le bot n'est
    // PAS membre : de son point de vue, le canal n'existe pas. Le traduire en
    // « canal inexistant » enverrait chercher une faute de frappe là où il faut
    // une invitation — c'est le même canal, vu à travers l'absence du bot.
    const reason = code === 'channel_not_found' ? 'channel_not_found' : 'bot_not_in_channel';
    return new ChannelUnavailableError(
      reason,
      `Slack a refusé la lecture de ${channelId} (${code})`,
      { cause: error },
    );
  }

  return new ChannelUnavailableError('unavailable', `Slack indisponible pour ${channelId}`, {
    cause: error,
  });
}

export class SlackChannelHistoryAdapter implements ChannelHistoryPort {
  private readonly slack: WebClient;
  private readonly resolveDisplayName?: DisplayNameResolver;

  constructor(botToken: string, options: SlackChannelHistoryOptions = {}) {
    this.slack = options.client ?? new WebClient(botToken);
    this.resolveDisplayName = options.resolveDisplayName;
  }

  /**
   * Ne lève JAMAIS : toute erreur vaut « non membre ».
   *
   * Distinguer ici « canal inconnu » de « bot absent » ferait de cette méthode un
   * oracle d'existence de canaux privés, interrogeable par n'importe qui en DM.
   */
  async isMember(channelId: string, slackUserId: string): Promise<boolean> {
    let cursor: string | undefined;

    try {
      for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
        const response = await this.slack.conversations.members({
          channel: channelId,
          limit: MEMBER_PAGE_SIZE,
          cursor,
        });

        const members = Array.isArray(response.members) ? response.members : [];
        if (members.includes(slackUserId)) return true;

        cursor = response.response_metadata?.next_cursor || undefined;
        if (!cursor) return false;
      }

      logger.warn('Knowledge — canal trop grand pour vérifier l’appartenance, accès refusé', {
        channelId,
        pages: MAX_MEMBER_PAGES,
      });
      return false;
    } catch (error) {
      logger.warn('Knowledge — conversations.members a échoué, appartenance non prouvée', {
        channelId,
        slackError: slackErrorCode(error),
      });
      return false;
    }
  }

  async fetchRecent(
    channelId: string,
    options: ChannelHistoryReadOptions,
  ): Promise<ChannelMessage[]> {
    // `oldest` est un horodatage Slack : des SECONDES epoch, en chaîne. Le passer
    // en millisecondes rendrait une fenêtre située en l'an 57000 — donc zéro
    // message, silencieusement.
    const oldest = ((Date.now() - options.sinceMs) / 1000).toFixed(6);

    let messages: unknown[];
    try {
      const response = await this.slack.conversations.history({
        channel: channelId,
        limit: options.limit,
        oldest,
        inclusive: false,
      });
      messages = Array.isArray(response.messages) ? response.messages : [];
    } catch (error) {
      throw toUnavailable(error, channelId);
    }

    const raw = messages
      .map((message) => this.toRawMessage(message))
      .filter((message): message is RawChannelMessage => message !== null);

    return this.withLabels(raw);
  }

  /**
   * Projette un message Slack, ou `null` s'il n'a rien à dire.
   *
   * Les `subtype` sont écartés : `channel_join`, `channel_leave`, `bot_message`,
   * les épinglages… Ce sont des ÉVÉNEMENTS, pas des propos, et ils occuperaient
   * les six places du budget sur un canal calme — l'agent conclurait qu'il ne
   * s'est rien dit alors qu'il n'a regardé que les allées et venues.
   */
  private toRawMessage(message: unknown): RawChannelMessage | null {
    if (typeof message !== 'object' || message === null) return null;

    const record = message as {
      type?: unknown;
      subtype?: unknown;
      text?: unknown;
      user?: unknown;
      bot_id?: unknown;
      ts?: unknown;
    };

    if (record.type !== 'message') return null;
    if (typeof record.subtype === 'string') return null;

    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (!text) return null;

    const ts = typeof record.ts === 'string' ? Number.parseFloat(record.ts) : Number.NaN;
    if (!Number.isFinite(ts)) return null;

    return {
      authorId: typeof record.user === 'string' ? record.user : null,
      text,
      at: new Date(ts * 1000),
      isBot: typeof record.bot_id === 'string',
    };
  }

  /**
   * Résout les noms d'affichage — une fois par auteur DISTINCT.
   *
   * Un canal de 40 messages compte rarement plus de cinq intervenants ; résoudre
   * par message multiplierait les allers-retours par huit pour un résultat
   * identique. Un échec de résolution retombe sur l'identifiant : un extrait
   * signé `U0BM…` reste lisible, un extrait manquant non.
   */
  private async withLabels(raw: readonly RawChannelMessage[]): Promise<ChannelMessage[]> {
    const labels = new Map<string, string>();

    if (this.resolveDisplayName) {
      const authorIds = [...new Set(raw.map((m) => m.authorId).filter((id): id is string => !!id))];

      for (const authorId of authorIds) {
        try {
          const name = await this.resolveDisplayName(authorId);
          if (name) labels.set(authorId, name);
        } catch {
          // Confort d'affichage, jamais un point de panne.
        }
      }
    }

    return raw.map((message) => ({
      authorId: message.authorId,
      authorLabel: message.authorId
        ? (labels.get(message.authorId) ?? message.authorId)
        : message.isBot
          ? 'Kisso'
          : '?',
      text: message.text,
      at: message.at,
      isBot: message.isBot,
    }));
  }
}

interface RawChannelMessage {
  readonly authorId: string | null;
  readonly text: string;
  readonly at: Date;
  readonly isBot: boolean;
}
