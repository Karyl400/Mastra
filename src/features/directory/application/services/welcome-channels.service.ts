import { logger } from '../../../../shared/logger';
import { errorMessage } from '../../../../shared/errors';

export type ChannelInviteStatus =
  | 'invited'
  | 'already_in_channel'
  | 'bot_not_in_channel'
  | 'channel_not_found'
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

export interface WelcomeChannelSource {
  listChannels(): Promise<readonly WelcomeChannelRef[]>;
  invite(channelId: string, slackUserId: string): Promise<ChannelInviteResult>;
  join(channelId: string): Promise<ChannelInviteResult>;
}

export interface WelcomeChannelFailure {
  readonly name: string;
  readonly status: ChannelInviteStatus;
  readonly error?: string;
}

export interface WelcomeChannelsReport {
  readonly outcome: 'completed' | 'degraded' | 'not_configured';
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
          failures.push({ name, status: 'missing_scope' });
          continue;
        }

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

async function inviteOnce(
  source: WelcomeChannelSource,
  channel: WelcomeChannelRef,
  slackUserId: string,
): Promise<ChannelInviteResult> {
  const first = await safely(() => source.invite(channel.id, slackUserId));
  if (first.status !== 'bot_not_in_channel') return first;

  const joined = await safely(() => source.join(channel.id));
  if (joined.status !== 'invited' && joined.status !== 'already_in_channel') {
    return { status: 'bot_not_in_channel', error: joined.error };
  }

  return safely(() => source.invite(channel.id, slackUserId));
}

async function safely(call: () => Promise<ChannelInviteResult>): Promise<ChannelInviteResult> {
  try {
    return await call();
  } catch (error) {
    return { status: 'failed', error: errorMessage(error) };
  }
}

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
