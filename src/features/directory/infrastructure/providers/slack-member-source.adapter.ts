import type { DirectoryMemberFacts } from '../../domain/entities/directory-member';
import type { MemberSource } from '../../domain/ports/member-source';
import type { SlackMember } from '../../../notification/domain/ports/slack-workspace.port';
import type { SlackMemberPage } from '../../../notification/infrastructure/providers/slack-workspace.service';
import { SLACK_MAX_PAGES } from '../../../notification/infrastructure/providers/slack-workspace.service';
import { logger } from '../../../../shared/logger';

/**
 * L'annuaire, alimenté depuis Slack.
 *
 * ----------------------------------------------------------------------------
 * POURQUOI CE FICHIER VIT EN `infrastructure`
 * ----------------------------------------------------------------------------
 * Il relie deux features : le port `MemberSource` (`directory/domain`) et
 * `SlackWorkspaceService` (`notification/infrastructure`). `member-source.ts` documente ce
 * choix — l'`infrastructure` est la seule couche où le croisement est légitime, et c'est
 * exactement ce que fait cet adaptateur : rien d'autre qu'une projection.
 *
 * ----------------------------------------------------------------------------
 * ⚠️ IL NE CRÉE PAS DE SECOND `WebClient`
 * ----------------------------------------------------------------------------
 * Il consomme le service Slack déjà câblé. Un second client dupliquerait le jeton, les
 * réglages de retry et les compteurs de rate-limit — deux clients ignorant chacun les appels
 * de l'autre franchiraient un plafond que ni l'un ni l'autre ne verrait venir.
 */

/**
 * Le strict nécessaire côté Slack — deux méthodes.
 *
 * L'adaptateur ne dépend PAS de `SlackWorkspaceProvider` (7 méthodes, dont `inviteToChannel`,
 * une capacité d'écriture) : un annuaire dont le rôle est de lire qui est qui n'a aucune raison
 * de tenir un droit d'inviter. C'est aussi ce qui rend la doublure de test triviale.
 */
export interface SlackMemberReader {
  listMembersPage(cursor?: string, limit?: number): Promise<SlackMemberPage>;
  getUserById(userId: string): Promise<SlackMember | null>;
}

export interface SlackMemberSourceOptions {
  /** Plafond de pages. Défaut : celui du service Slack. Surchargé par les tests. */
  readonly maxPages?: number;
}

/**
 * Projection `SlackMember` → `DirectoryMemberFacts`.
 *
 * Elle NE FILTRE RIEN — ni les bots, ni les comptes désactivés, ni les invités. Chacun de ces
 * trois états est précisément ce que la politique d'autorisation lit pour REFUSER ou
 * rétrograder : une source qui les écarterait produirait un annuaire où seuls figurent les
 * gens à qui l'on dit oui, c'est-à-dire aucune décision.
 */
function toFacts(member: SlackMember): DirectoryMemberFacts {
  return {
    slackUserId: member.id,
    teamId: member.teamId,
    email: member.email,
    realName: member.realName,
    displayName: member.displayName,
    isBot: member.isBot,
    isAdmin: member.isAdmin,
    isRestricted: member.isRestricted,
    isUltraRestricted: member.isUltraRestricted,
    isDeleted: member.isDeleted,
  };
}

export class SlackMemberSource implements MemberSource {
  private readonly maxPages: number;

  /**
   * ⚠️ `truncated` est un fait du DERNIER balayage, pas un état durable. Il existe parce que
   * `MemberSource.fetchAll()` rend un tableau nu : un tableau ne sait pas dire qu'il est
   * incomplet. Sans ce drapeau, une synchronisation plafonnée rapporterait « 10 000 membres
   * synchronisés » et serait indiscernable d'une synchronisation intégrale.
   */
  private truncated = false;

  constructor(
    private readonly slack: SlackMemberReader,
    options: SlackMemberSourceOptions = {},
  ) {
    this.maxPages = options.maxPages ?? SLACK_MAX_PAGES;
  }

  /**
   * `null` sur un compte introuvable — jamais une exception.
   *
   * Cette méthode est atteignable depuis le chemin de l'ACK Slack (3 secondes) : y lever pour
   * un identifiant inconnu coûterait le traitement du message entier. `getUserById` traduit
   * déjà `user_not_found` en `null` ; ce qui reste (réseau, 5xx, rate-limit) remonte, et c'est
   * volontaire — une panne de Slack n'est pas une absence de personne.
   */
  async fetchById(slackUserId: string): Promise<DirectoryMemberFacts | null> {
    const member = await this.slack.getUserById(slackUserId);
    if (!member || !member.id) return null;

    return toFacts(member);
  }

  /**
   * Balayage complet — PAGINÉ, BORNÉ, et bavard quand il est borné.
   *
   * `users.list` rend **100 entrées par défaut** et n'annonce sa suite que par
   * `response_metadata.next_cursor`. Une lecture sans curseur — la forme « évidente » —
   * synchroniserait donc un annuaire partiel : la politique d'autorisation rétrograderait
   * ensuite en `unknown_actor` toute personne qui a eu le tort d'être en page 2. Le symptôme
   * (« le bot ne reconnaît que la moitié de l'équipe ») ne désignerait pas sa cause.
   *
   * Les membres sans identifiant sont écartés : `slack_user_id` est la clé primaire, une chaîne
   * vide y créerait UN sujet fantôme que toutes les lignes suivantes viendraient écraser.
   */
  async fetchAll(): Promise<DirectoryMemberFacts[]> {
    const facts: DirectoryMemberFacts[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let skipped = 0;

    this.truncated = false;

    do {
      const page = await this.slack.listMembersPage(cursor);

      for (const member of page.members) {
        if (!member.id) {
          skipped += 1;
          continue;
        }
        facts.push(toFacts(member));
      }

      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < this.maxPages);

    if (cursor) {
      this.truncated = true;
      logger.error('Directory member scan TRUNCATED — the workspace was not fully read', {
        pages,
        collected: facts.length,
        cap: this.maxPages,
      });
    }

    if (skipped > 0) {
      logger.warn('Slack members skipped — no user id', { skipped });
    }

    logger.info('Directory member scan completed', {
      collected: facts.length,
      pages,
      truncated: this.truncated,
    });

    return facts;
  }

  /** Le dernier `fetchAll()` a-t-il touché le plafond de pages ? */
  wasLastFetchTruncated(): boolean {
    return this.truncated;
  }
}
