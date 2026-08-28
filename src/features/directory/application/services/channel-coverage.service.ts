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

export function makeChannelCoverage(deps: ChannelCoverageDeps): ChannelCoverageService {
  return {
    async run(): Promise<ChannelCoverageReport> {
      const { channels, truncated } = await deps.source.listChannels();

      const accessible = new Set<string>();
      const joined: ChannelRef[] = [];
      const privateNotMember: ChannelRef[] = [];
      const failures: ChannelJoinFailure[] = [];
      let alreadyMember = 0;
      let archivedSkipped = 0;
      let missingScope = false;

      for (const channel of channels) {
        if (channel.isArchived) {
          archivedSkipped += 1;
          continue;
        }

        if (channel.isMember) {
          alreadyMember += 1;
          accessible.add(channel.id);
          continue;
        }

        if (channel.isPrivate) {
          privateNotMember.push({ id: channel.id, name: channel.name });
          continue;
        }

        if (missingScope) {
          failures.push({
            channelId: channel.id,
            name: channel.name,
            status: 'missing_scope',
            error: 'missing_scope',
          });
          continue;
        }

        const result = await deps.source.join(channel.id);

        switch (result.status) {
          case 'joined':
            joined.push({ id: channel.id, name: channel.name });
            accessible.add(channel.id);
            break;

          case 'already_member':
            alreadyMember += 1;
            accessible.add(channel.id);
            break;

          case 'not_public':
            privateNotMember.push({ id: channel.id, name: channel.name });
            break;

          case 'archived':
            archivedSkipped += 1;
            break;

          case 'missing_scope':
            missingScope = true;
            failures.push({
              channelId: channel.id,
              name: channel.name,
              status: result.status,
              error: result.error,
            });
            break;

          default:
            failures.push({
              channelId: channel.id,
              name: channel.name,
              status: result.status,
              error: result.error,
            });
        }
      }

      const inventory = await recordInventory(deps, channels, accessible);

      const degraded = failures.length > 0 || truncated || isInventoryDegraded(inventory);

      const report: ChannelCoverageReport = {
        outcome: degraded ? 'degraded' : 'completed',
        scanned: channels.length,
        accessibleChannelIds: Array.from(accessible).sort(),
        joined,
        alreadyMember,
        privateNotMember,
        archivedSkipped,
        failures,
        missingScope,
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
