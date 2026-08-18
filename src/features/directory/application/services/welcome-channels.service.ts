import { logger } from '../../../../shared/logger';
import { errorMessage } from '../../../../shared/errors';

/**
 * INVITATION D'UN ARRIVANT dans les canaux publics d'accueil.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Pourquoi un service DISTINCT de `ChannelCoverageService`
 * ────────────────────────────────────────────────────────────────────────────
 * La couverture règle l'appartenance du BOT (`conversations.join`, sur lui-même) ; celui-ci
 * règle l'appartenance d'un TIERS (`conversations.invite`, sur quelqu'un d'autre). Ce sont
 * deux droits différents, deux scopes différents et deux modes d'échec différents. Les fondre
 * donnerait un service dont on ne saurait plus dire, en lisant un rapport dégradé, qui n'a pas
 * pu entrer où — et le bot est déjà membre des six canaux, donc la couverture ne rendrait
 * jamais rien d'utile sur ce chemin.
 *
 * ⚠️ `already_in_channel` est un SUCCÈS. L'objectif est « l'arrivant est dans le canal », pas
 * « nous l'y avons mis ». Le compter comme une erreur rendrait dégradée toute réexécution —
 * même arbitrage que `alreadyMember` dans la couverture, et que « non applicable ≠ dégradé »
 * sur l'invitation Slack du workflow d'onboarding.
 *
 * ⚠️ Le service est *best-effort* de bout en bout et ne lève JAMAIS : son appelant est
 * `handleTeamJoin`, dont le DM de bienvenue ne doit dépendre d'aucun canal. Un arrivant sans
 * canal mais avec son message de bienvenue peut demander de l'aide ; l'inverse ne le peut pas.
 *
 * ⚠️ TypeScript pur côté logique — seule la journalisation est importée.
 */

export type ChannelInviteStatus =
  | 'invited'
  | 'already_in_channel'
  /** Le BOT n'est pas membre : il doit rejoindre avant de pouvoir inviter quelqu'un. */
  | 'bot_not_in_channel'
  | 'channel_not_found'
  /** Scope manquant — seule issue qui appelle un geste HUMAIN. */
  | 'missing_scope'
  | 'failed';

export interface ChannelInviteResult {
  readonly status: ChannelInviteStatus;
  readonly error?: string;
}

export interface WelcomeChannelRef {
  readonly id: string;
  readonly name: string;
}

/**
 * La source, déclarée par son CONSOMMATEUR — `application` ne connaît pas Slack.
 *
 * L'adaptateur qui la relie au fournisseur Slack vit en `infrastructure`, seule couche où le
 * croisement entre deux features est légitime. Même construction que `MemberSource` et
 * `ChannelAccessSource`.
 */
export interface WelcomeChannelSource {
  /** Canaux du workspace, nom ET identifiant. La résolution se fait ici, pas en config. */
  listChannels(): Promise<readonly WelcomeChannelRef[]>;
  invite(channelId: string, slackUserId: string): Promise<ChannelInviteResult>;
  /**
   * Le bot se rend membre du canal.
   *
   * Rendu sous le MÊME vocabulaire que `invite` — un seul type de résultat, donc un seul
   * `switch` à lire dans le service, là où deux vocabulaires proches auraient fabriqué la
   * confusion qu'ils prétendaient éviter.
   */
  join(channelId: string): Promise<ChannelInviteResult>;
}

export interface WelcomeChannelFailure {
  readonly name: string;
  readonly status: ChannelInviteStatus;
  readonly error?: string;
}

export interface WelcomeChannelsReport {
  /**
   * `not_configured` est DISTINCT de `completed` : « personne n'a demandé d'invitation » ne se
   * lit pas comme « toutes les invitations ont abouti ». Sans cette valeur, une variable
   * d'environnement oubliée produirait un rapport parfaitement vert.
   */
  readonly outcome: 'completed' | 'degraded' | 'not_configured';
  /** Noms des canaux où l'arrivant se trouve à l'issue du passage — pour le DM. */
  readonly joinedNames: readonly string[];
  readonly failures: readonly WelcomeChannelFailure[];
}

export interface WelcomeChannelsDeps {
  readonly source: WelcomeChannelSource;
  readonly channelNames: readonly string[];
}

export interface WelcomeChannelsService {
  run(slackUserId: string): Promise<WelcomeChannelsReport>;
}

export function makeWelcomeChannels(deps: WelcomeChannelsDeps): WelcomeChannelsService {
  return {
    async run(slackUserId: string): Promise<WelcomeChannelsReport> {
      if (deps.channelNames.length === 0) {
        // `warn` et non `error` : ne rien configurer est un choix légitime. Mais le silence
        // total ferait ressembler l'absence de configuration à une panne d'invitation, et
        // c'est précisément la ligne qu'on cherchera le jour où un arrivant n'atterrit nulle
        // part.
        logger.warn('No welcome channels configured — skipping newcomer invitations', {
          slackUserId,
        });
        return { outcome: 'not_configured', joinedNames: [], failures: [] };
      }

      let byName: Map<string, WelcomeChannelRef>;
      try {
        const channels = await deps.source.listChannels();
        byName = new Map(channels.map((c) => [c.name.toLowerCase(), c]));
      } catch (error) {
        // Sans annuaire de canaux, AUCUN nom n'est résoluble : on rend un échec PAR canal
        // demandé plutôt qu'un rapport vide, qui se lirait « rien à faire ».
        logger.error('Unable to list Slack channels for the welcome invitations', {
          error,
          slackUserId,
        });
        return {
          outcome: 'degraded',
          joinedNames: [],
          failures: deps.channelNames.map((name) => ({
            name,
            status: 'failed' as const,
            error: errorMessage(error),
          })),
        };
      }

      const joinedNames: string[] = [];
      const failures: WelcomeChannelFailure[] = [];
      let missingScope = false;

      for (const name of deps.channelNames) {
        const channel = byName.get(name);
        if (!channel) {
          failures.push({ name, status: 'channel_not_found' });
          continue;
        }

        if (missingScope) {
          // La tentative suivante échouerait identiquement : on enregistre sans dépenser un
          // appel de plus. Même arbitrage que `ChannelCoverageService`.
          failures.push({ name, status: 'missing_scope' });
          continue;
        }

        // SÉQUENTIEL, jamais `Promise.all` : `conversations.invite` est plafonné par Slack, et
        // une salve simultanée se ferait rate-limiter — le remède produirait le symptôme.
        const outcome = await inviteOnce(deps.source, channel, slackUserId);

        if (outcome.status === 'invited' || outcome.status === 'already_in_channel') {
          joinedNames.push(name);
          continue;
        }

        if (outcome.status === 'missing_scope') missingScope = true;
        failures.push({ name, status: outcome.status, error: outcome.error });
      }

      const report: WelcomeChannelsReport = {
        outcome: failures.length > 0 ? 'degraded' : 'completed',
        joinedNames,
        failures,
      };

      logReport(report, slackUserId, missingScope);
      return report;
    },
  };
}

/**
 * Une invitation, avec UN seul rattrapage : si le bot n'est pas membre du canal, il le rejoint
 * et réessaie.
 *
 * Jamais deux fois — un `join` qui échoue est définitif pour ce passage, et boucler
 * consommerait du quota d'API pour répéter le même refus.
 */
async function inviteOnce(
  source: WelcomeChannelSource,
  channel: WelcomeChannelRef,
  slackUserId: string,
): Promise<ChannelInviteResult> {
  const first = await safely(() => source.invite(channel.id, slackUserId));
  if (first.status !== 'bot_not_in_channel') return first;

  const joined = await safely(() => source.join(channel.id));
  if (joined.status !== 'invited' && joined.status !== 'already_in_channel') {
    // On conserve le statut de l'INVITATION (`bot_not_in_channel`, la cause réelle) et
    // l'erreur du `join` (ce qui a empêché de la lever). Écraser le premier par le second
    // dirait « le bot n'a pas pu rejoindre » sans dire pourquoi on essayait.
    return { status: 'bot_not_in_channel', error: joined.error };
  }

  return safely(() => source.invite(channel.id, slackUserId));
}

/** Un port qui lève malgré son contrat ne doit pas couler la boucle. */
async function safely(call: () => Promise<ChannelInviteResult>): Promise<ChannelInviteResult> {
  try {
    return await call();
  } catch (error) {
    return { status: 'failed', error: errorMessage(error) };
  }
}

/**
 * Journalise l'issue. `missing_scope` d'abord : c'est la seule issue qui appelle un geste
 * humain, et la noyer dans le message générique de dégradation ferait manquer la seule chose
 * à faire.
 */
function logReport(
  report: WelcomeChannelsReport,
  slackUserId: string,
  missingScope: boolean,
): void {
  if (missingScope) {
    logger.error(
      'Newcomer channel invitations blocked — a Slack scope is missing. Add `channels:manage` ' +
        'in OAuth & Permissions, THEN reinstall the app: adding the scope alone propagates nothing.',
      { slackUserId, failures: report.failures.length },
    );
    return;
  }

  if (report.outcome === 'degraded') {
    logger.error('Newcomer channel invitations degraded', {
      slackUserId,
      joined: report.joinedNames,
      failures: report.failures,
    });
    return;
  }

  logger.info('Newcomer invited to the welcome channels', {
    slackUserId,
    joined: report.joinedNames,
  });
}
