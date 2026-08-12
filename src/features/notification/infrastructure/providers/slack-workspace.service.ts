import { WebClient } from '@slack/web-api';
import type {
  SlackWorkspaceProvider,
  SlackChannel,
  SlackMember,
} from '../../domain/ports/slack-workspace.port';
import { logger } from '../../../../shared/logger';

/** Forme commune aux réponses `users.list`, `users.lookupByEmail` et `users.info`. */
interface SlackApiUser {
  id?: string;
  name?: string;
  real_name?: string | null;
  is_bot?: boolean;
  is_admin?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  /** Nom de champ de Slack : `deleted`, et non `is_deleted` comme les autres drapeaux. */
  deleted?: boolean;
  team_id?: string;
  profile?: {
    email?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    display_name?: string | null;
    real_name?: string | null;
  };
}

/**
 * Taille de page demandée à Slack. Le DÉFAUT de `users.list` et de `conversations.list` est
 * **100**, jamais « tout » : une lecture sans curseur rend un workspace partiel sans le dire.
 */
export const SLACK_PAGE_LIMIT = 200;

/**
 * Plafond de pages, appliqué à TOUTE boucle de curseur de ce fichier.
 *
 * Il n'existait pas : `while (cursor)` faisait confiance au serveur pour terminer. Un curseur
 * qui ne se vide jamais — bug d'API, réponse tronquée, curseur rejoué — bouclait indéfiniment
 * dans une fonction Vercel dont le budget est de 60 s.
 *
 * 50 pages × 200 = 10 000 entrées, deux ordres de grandeur au-dessus du workspace Kisso. Le
 * franchir n'est donc pas une limite de capacité mais le signe d'une anomalie — d'où la
 * journalisation en `error` et non en `warn` : un plafond silencieux se lit « tout est
 * synchronisé », qui est exactement le mode d'échec que ce dépôt paie depuis `emailSent: false`.
 */
export const SLACK_MAX_PAGES = 50;

/** Une page de `users.list`, déjà projetée. Le curseur reste au contrôle de l'appelant. */
export interface SlackMemberPage {
  members: SlackMember[];
  /** Absent = dernière page. */
  nextCursor?: string;
}

/**
 * Un canal vu sous l'angle de l'ACCÈS, et non de la description.
 *
 * Type SÉPARÉ de `SlackChannel` à dessein : `SlackChannel` est ce que le tool
 * `discoverSlackWorkspace` montre à un modèle (topic, purpose, memberCount — des tokens payés
 * à chaque aller-retour), là où la couverture de canaux n'a besoin que de « public ou privé,
 * archivé ou non, dedans ou dehors ». Fondre les deux ferait porter à chaque énumération
 * envoyée au modèle des champs qui ne l'intéressent pas, et inversement.
 */
export interface SlackChannelMembership {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  /** `true` si le bot est déjà dans le canal — c'est ce que `chat.postMessage` exige. */
  isMember: boolean;
}

export interface SlackChannelMembershipPage {
  channels: SlackChannelMembership[];
  nextCursor?: string;
}

/**
 * Issue NOMMÉE d'une tentative d'adhésion. Aucune n'est une exception :
 *
 *  - `not_public` n'est PAS une panne. `conversations.join` ne fonctionne que sur un canal
 *    public ; un canal privé exige une invitation humaine. Le traiter en erreur ferait
 *    échouer une synchronisation dont tout le reste a fonctionné — c'est l'arbitrage
 *    « non applicable ≠ dégradé » déjà tranché sur l'invitation Slack de l'onboarding.
 *  - `already_member` est le cas IDEMPOTENT : rejoindre deux fois ne fait rien et n'est pas
 *    un échec.
 *  - `missing_scope` est la seule issue qui appelle un geste HUMAIN (ajouter `channels:join`
 *    dans *OAuth & Permissions*, **puis réinstaller l'app** — l'ajout seul ne propage rien).
 */
export type SlackJoinStatus =
  | 'joined'
  | 'already_member'
  | 'not_public'
  | 'archived'
  | 'missing_scope'
  | 'not_found'
  | 'failed';

export interface SlackJoinOutcome {
  status: SlackJoinStatus;
  /** Code d'erreur brut de Slack, conservé pour le journal. Jamais montré à un utilisateur. */
  error?: string;
}

/** Découpe « Marie Claire Dupont » en « Marie » / « Claire Dupont ». */
function splitRealName(realName: string): { firstName: string; lastName: string } {
  const [first, ...rest] = realName.trim().split(/\s+/).filter(Boolean);
  return { firstName: first ?? '', lastName: rest.join(' ') };
}

/**
 * Projection unique de l'utilisateur Slack vers `SlackMember`.
 *
 * Les trois méthodes d'annuaire la partagent : trois mappings parallèles
 * auraient divergé au premier champ ajouté.
 */
export function toMember(user: SlackApiUser): SlackMember {
  const realName = user.real_name || '';
  const derived = splitRealName(realName);

  return {
    id: user.id ?? '',
    name: user.name ?? '',
    realName,
    // `?? null` et non `|| ''` : une chaîne vide passerait une simple validation de présence,
    // et l'email est une CLÉ de recherche. L'absence doit rester nommée.
    email: user.profile?.email ?? null,
    // `||` et non `??` : Slack renvoie une chaîne vide — pas `undefined` —
    // pour un prénom non renseigné, et `??` la laisserait passer.
    firstName: user.profile?.first_name || derived.firstName,
    lastName: user.profile?.last_name || derived.lastName,
    // Cascade complète, jusqu'à `name` : un refus d'autorisation journalisé sans aucun nom est
    // inexploitable. C'est le champ que lit la politique quand elle doit dire QUI a été refusé.
    displayName:
      user.profile?.display_name || user.profile?.real_name || realName || user.name || '',
    isBot: user.is_bot ?? false,
    isAdmin: user.is_admin ?? false,
    // Lus TELS QUELS, sans déduction : Slack pose les deux drapeaux sur un invité mono-canal, et
    // dériver l'un de l'autre interdirait de durcir ce seul cas.
    isRestricted: user.is_restricted ?? false,
    isUltraRestricted: user.is_ultra_restricted ?? false,
    isDeleted: user.deleted ?? false,
    teamId: user.team_id ?? '',
  };
}

/**
 * LA ligne à chercher quand l'annuaire paraît complet et ne l'est pas.
 *
 * En `error` et non en `warn` : une troncature muette est indiscernable d'un workspace petit,
 * et la politique d'autorisation qui s'en nourrit rétrograderait des gens légitimes au motif
 * qu'ils sont en page 2.
 */
function logTruncation(method: string, pages: number, collected: number): void {
  logger.error('Slack pagination cap reached — the result is TRUNCATED', {
    method,
    pages,
    collected,
    cap: SLACK_MAX_PAGES,
  });
}

export class SlackWorkspaceService implements SlackWorkspaceProvider {
  private client: WebClient;

  constructor(botToken: string) {
    this.client = new WebClient(botToken);
  }

  async listChannels(): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const response = await this.client.conversations.list({
        types: 'public_channel,private_channel',
        limit: SLACK_PAGE_LIMIT,
        cursor,
      });

      for (const ch of response.channels ?? []) {
        channels.push({
          id: ch.id ?? '',
          name: ch.name ?? '',
          isPrivate: ch.is_private ?? false,
          memberCount: ch.num_members ?? 0,
          topic: ch.topic?.value ?? '',
          purpose: ch.purpose?.value ?? '',
        });
      }

      cursor = response.response_metadata?.next_cursor || undefined;
      pages += 1;
    } while (cursor && pages < SLACK_MAX_PAGES);

    if (cursor) logTruncation('conversations.list', pages, channels.length);

    logger.info('Slack channels discovered', { count: channels.length });
    return channels;
  }

  /**
   * ⚠️ Les comptes DÉSACTIVÉS sont écartés ici, et ce filtre est correct POUR CET APPELANT
   * (le tool de découverte n'a que faire d'un ancien salarié). Il ne l'est PAS pour l'annuaire :
   * `isDeleted` est le fait qui fait REFUSER un compte désactivé, et une source qui ne le livre
   * jamais laisserait la politique accorder l'accès à un ex-salarié indéfiniment. C'est pourquoi
   * la synchronisation d'annuaire passe par `listMembersPage`, non filtrée.
   */
  async listMembers(): Promise<SlackMember[]> {
    const members: SlackMember[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await this.listMembersPage(cursor);

      for (const member of page.members) {
        if (member.isDeleted) continue;
        members.push(member);
      }

      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < SLACK_MAX_PAGES);

    if (cursor) logTruncation('users.list', pages, members.length);

    logger.info('Slack members discovered', { count: members.length });
    return members;
  }

  /**
   * UNE page de `users.list`, sans aucun filtre.
   *
   * Primitive à curseur plutôt que balayage complet : c'est l'appelant qui connaît sa politique
   * de plafond et qui doit pouvoir DIRE qu'il a été tronqué. Un balayage qui rend un tableau nu
   * ne peut pas l'avouer — il rend « moins de gens », ce qui se lit « il n'y en a pas plus ».
   */
  async listMembersPage(
    cursor?: string,
    limit: number = SLACK_PAGE_LIMIT,
  ): Promise<SlackMemberPage> {
    const response = await this.client.users.list({ limit, cursor });

    return {
      members: (response.members ?? []).map(toMember),
      nextCursor: response.response_metadata?.next_cursor || undefined,
    };
  }

  /**
   * UNE page de `conversations.list`, projetée sur l'appartenance.
   *
   * `exclude_archived` n'est PAS posé : un canal archivé doit être VU pour être écarté par un
   * état nommé, sinon il disparaît du décompte et l'on ne sait plus distinguer « archivé » de
   * « inexistant ».
   */
  async listChannelMembershipsPage(
    cursor?: string,
    limit: number = SLACK_PAGE_LIMIT,
  ): Promise<SlackChannelMembershipPage> {
    const response = await this.client.conversations.list({
      types: 'public_channel,private_channel',
      limit,
      cursor,
    });

    return {
      channels: (response.channels ?? []).map((ch) => ({
        id: ch.id ?? '',
        name: ch.name ?? '',
        isPrivate: ch.is_private ?? false,
        isArchived: ch.is_archived ?? false,
        // `?? false` : l'absence du drapeau se lit « pas membre ». Le défaut sûr est celui qui
        // fait TENTER l'adhésion — un `join` inutile est idempotent, un `postMessage` dans un
        // canal dont on croit à tort être membre échoue en `not_in_channel`, silencieusement.
        isMember: ch.is_member ?? false,
      })),
      nextCursor: response.response_metadata?.next_cursor || undefined,
    };
  }

  /**
   * Rejoint un canal PUBLIC. Ne lève jamais : chaque refus de Slack devient un état nommé.
   *
   * Le scope `channels:join` est accordé depuis longtemps mais **aucun code n'émettait cet
   * appel** — d'où un bot membre de 2 canaux sur 5, et un `chat.postMessage` qui échouait en
   * `not_in_channel` dans les trois autres. Cet échec-là est INVISIBLE pour l'utilisateur : le
   * message d'erreur de repli est posté dans le même canal inaccessible, donc échoue aussi.
   */
  async joinChannel(channelId: string): Promise<SlackJoinOutcome> {
    try {
      const response = await this.client.conversations.join({ channel: channelId });

      // Slack ne lève pas quand on est déjà dedans : il répond `ok` avec un avertissement. Sans
      // cette lecture, une adhésion déjà acquise serait comptée comme une adhésion nouvelle et
      // le rapport surestimerait ce que ce passage a réellement changé.
      const warning = String((response as { warning?: string }).warning ?? '');
      if (warning.includes('already_in_channel')) return { status: 'already_member' };

      logger.info('Joined Slack channel', { channelId });
      return { status: 'joined' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('already_in_channel')) return { status: 'already_member' };
      if (message.includes('method_not_supported_for_channel_type')) {
        return { status: 'not_public', error: 'method_not_supported_for_channel_type' };
      }
      if (message.includes('is_archived')) return { status: 'archived', error: 'is_archived' };
      if (message.includes('missing_scope')) {
        return { status: 'missing_scope', error: 'missing_scope' };
      }
      if (message.includes('channel_not_found')) {
        return { status: 'not_found', error: 'channel_not_found' };
      }

      logger.warn('Failed to join Slack channel', { channelId, error: message });
      return { status: 'failed', error: message };
    }
  }

  async findUserByEmail(email: string): Promise<SlackMember | null> {
    try {
      const response = await this.client.users.lookupByEmail({ email });
      const user = response.user;
      if (!user) return null;

      return toMember(user);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('users_not_found')) {
        logger.warn('Slack user not found by email', { email });
        return null;
      }
      throw err;
    }
  }

  async getUserById(userId: string): Promise<SlackMember | null> {
    try {
      const response = await this.client.users.info({ user: userId });
      const user = response.user;
      if (!user) return null;

      return toMember(user);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // `users.info` répond `user_not_found` au singulier, là où
      // `users.lookupByEmail` répond `users_not_found`. Les deux sont acceptés.
      if (message.includes('user_not_found') || message.includes('users_not_found')) {
        logger.warn('Slack user not found by id', { userId });
        return null;
      }
      throw err;
    }
  }

  async inviteToChannel(channelId: string, userId: string): Promise<void> {
    try {
      await this.client.conversations.invite({
        channel: channelId,
        users: userId,
      });
      logger.info('User invited to Slack channel', { channelId, userId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('already_in_channel')) {
        logger.info('User already in channel', { channelId, userId });
        return;
      }
      throw err;
    }
  }

  async getChannelMembers(channelId: string): Promise<string[]> {
    const memberIds: string[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.client.conversations.members({
        channel: channelId,
        limit: 200,
        cursor,
      });

      memberIds.push(...(response.members ?? []));
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return memberIds;
  }
}
