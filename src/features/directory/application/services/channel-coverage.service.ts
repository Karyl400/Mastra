import { logger } from '../../../../shared/logger';
import type {
  ChannelCoverageDeps,
  ChannelCoverageReport,
  ChannelCoverageService,
  ChannelJoinFailure,
  ChannelRef,
} from './channel-coverage.types';
import { isInventoryDegraded, recordInventory } from './channel-inventory-recorder';

export * from './channel-coverage.types';

interface Tally {
  accessible: Set<string>;
  joined: ChannelRef[];
  privateNotMember: ChannelRef[];
  failures: ChannelJoinFailure[];
  alreadyMember: number;
  archivedSkipped: number;
  missingScope: boolean;
}

function newTally(): Tally {
  return {
    accessible: new Set<string>(),
    joined: [],
    privateNotMember: [],
    failures: [],
    alreadyMember: 0,
    archivedSkipped: 0,
    missingScope: false,
  };
}

type JoinResult = Awaited<ReturnType<ChannelCoverageDeps['source']['join']>>;

function recordJoinResult(tally: Tally, channel: ChannelRef, result: JoinResult): void {
  const ref = { id: channel.id, name: channel.name };

  switch (result.status) {
    case 'joined':
      tally.joined.push(ref);
      tally.accessible.add(channel.id);
      break;

    case 'already_member':
      tally.alreadyMember += 1;
      tally.accessible.add(channel.id);
      break;

    case 'not_public':
      tally.privateNotMember.push(ref);
      break;

    case 'archived':
      tally.archivedSkipped += 1;
      break;

    case 'missing_scope':
      tally.missingScope = true;
      tally.failures.push({
        channelId: channel.id,
        name: channel.name,
        status: result.status,
        error: result.error,
      });
      break;

    default:
      tally.failures.push({
        channelId: channel.id,
        name: channel.name,
        status: result.status,
        error: result.error,
      });
  }
}

async function coverChannel(
  deps: ChannelCoverageDeps,
  channel: Awaited<ReturnType<ChannelCoverageDeps['source']['listChannels']>>['channels'][number],
  tally: Tally,
): Promise<void> {
  if (channel.isArchived) {
    tally.archivedSkipped += 1;
    return;
  }

  if (channel.isMember) {
    tally.alreadyMember += 1;
    tally.accessible.add(channel.id);
    return;
  }

  if (channel.isPrivate) {
    tally.privateNotMember.push({ id: channel.id, name: channel.name });
    return;
  }

  if (tally.missingScope) {
    tally.failures.push({
      channelId: channel.id,
      name: channel.name,
      status: 'missing_scope',
      error: 'missing_scope',
    });
    return;
  }

  recordJoinResult(tally, channel, await deps.source.join(channel.id));
}

export function makeChannelCoverage(deps: ChannelCoverageDeps): ChannelCoverageService {
  return {
    async run(): Promise<ChannelCoverageReport> {
      const { channels, truncated } = await deps.source.listChannels();
      const tally = newTally();

      for (const channel of channels) {
        await coverChannel(deps, channel, tally);
      }

      const inventory = await recordInventory(deps, channels, tally.accessible);
      const degraded = tally.failures.length > 0 || truncated || isInventoryDegraded(inventory);

      const report: ChannelCoverageReport = {
        outcome: degraded ? 'degraded' : 'completed',
        scanned: channels.length,
        accessibleChannelIds: Array.from(tally.accessible).sort(),
        joined: tally.joined,
        alreadyMember: tally.alreadyMember,
        privateNotMember: tally.privateNotMember,
        archivedSkipped: tally.archivedSkipped,
        failures: tally.failures,
        missingScope: tally.missingScope,
        truncated,
        ...(inventory ? { inventory } : {}),
      };

      logCoverage(report);

      return report;
    },
  };
}

function logCoverage(report: ChannelCoverageReport): void {
  if (report.missingScope) {
    logger.error(
      'Slack channel coverage blocked — the `channels:join` scope is missing. Add it in ' +
        'OAuth & Permissions, THEN reinstall the app: adding the scope alone propagates nothing.',
      { pending: report.failures.length },
    );
    return;
  }

  if (report.outcome === 'degraded') {
    logger.error('Slack channel coverage degraded', {
      failures: report.failures,
      truncated: report.truncated,
    });
    return;
  }

  logger.info('Slack channel coverage completed', {
    scanned: report.scanned,
    joined: report.joined.length,
    alreadyMember: report.alreadyMember,
    privateNotMember: report.privateNotMember.length,
    accessible: report.accessibleChannelIds.length,
    channelsRecorded: report.inventory?.channelsRecorded,
    membersRecorded: report.inventory?.membersRecorded,
  });
}
