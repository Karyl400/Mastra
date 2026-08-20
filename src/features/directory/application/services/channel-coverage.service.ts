import { logger } from '../../../../shared/logger';
import type { ChannelInventoryRepository } from '../../domain/ports/channel.repository';
import { errorMessage } from '../../../../shared/errors';

export interface ChannelSnapshot {
  readonly id: string;
  readonly name: string;
  readonly isPrivate: boolean;
  readonly isArchived: boolean;
  readonly isMember: boolean;

  readonly memberCountReported?: number | null;
}

export interface ChannelMemberScan {
  readonly memberIds: readonly string[];
  readonly truncated: boolean;
}

export type ChannelJoinStatus =
  | 'joined'
  | 'already_member'
  | 'not_public'
  | 'archived'
  | 'missing_scope'
  | 'not_found'
  | 'failed';

export interface ChannelJoinResult {
  readonly status: ChannelJoinStatus;
  readonly error?: string;
}

export interface ChannelAccessSource {
  listChannels(): Promise<{ channels: readonly ChannelSnapshot[]; truncated: boolean }>;
  join(channelId: string): Promise<ChannelJoinResult>;

  listMembers?(channelId: string): Promise<ChannelMemberScan>;
}

export interface ChannelJoinFailure {
  readonly channelId: string;
  readonly name: string;
  readonly status: ChannelJoinStatus;
  readonly error?: string;
}

export interface ChannelRef {
  readonly id: string;
  readonly name: string;
}

export interface ChannelCoverageReport {
  readonly outcome: 'completed' | 'degraded';
  readonly scanned: number;
  readonly accessibleChannelIds: readonly string[];
  readonly joined: readonly ChannelRef[];
  readonly alreadyMember: number;
  readonly privateNotMember: readonly ChannelRef[];
  readonly archivedSkipped: number;
  readonly failures: readonly ChannelJoinFailure[];
  readonly missingScope: boolean;
  readonly truncated: boolean;
  readonly inventory?: ChannelInventoryReport;
}

export interface ChannelInventoryFailure {
  readonly channelId: string;
  readonly name: string;
  readonly error: string;
}

export interface ChannelInventoryReport {
  readonly channelsRecorded: number;
  readonly channelsWithMembers: number;
  readonly membersRecorded: number;
  readonly truncatedChannels: readonly string[];
  readonly failures: readonly ChannelInventoryFailure[];
}

export interface ChannelCoverageDeps {
  readonly source: ChannelAccessSource;

  readonly inventory?: ChannelInventoryRepository;

  readonly now?: () => Date;
}

export interface ChannelCoverageService {
  run(): Promise<ChannelCoverageReport>;
}

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

async function recordInventory(
  deps: ChannelCoverageDeps,
  channels: readonly ChannelSnapshot[],
  accessible: ReadonlySet<string>,
): Promise<ChannelInventoryReport | undefined> {
  const repository = deps.inventory;
  const listMembers = deps.source.listMembers?.bind(deps.source);
  if (!repository || !listMembers) return undefined;

  const now = (deps.now ?? (() => new Date()))();

  const failures: ChannelInventoryFailure[] = [];
  const truncatedChannels: string[] = [];
  let channelsRecorded = 0;
  let channelsWithMembers = 0;
  let membersRecorded = 0;

  for (const channel of channels) {
    const outcome = await recordOneChannel(
      repository,
      listMembers,
      channel,
      accessible.has(channel.id),
      now,
    );

    if (outcome.error !== undefined) {
      failures.push({ channelId: channel.id, name: channel.name, error: outcome.error });
    }
    if (outcome.channelRecorded) channelsRecorded += 1;
    if (outcome.members !== undefined) {
      channelsWithMembers += 1;
      membersRecorded += outcome.members;
      if (outcome.truncated) truncatedChannels.push(channel.id);
    }
  }

  if (failures.length > 0 || truncatedChannels.length > 0) {
    logger.error('Slack channel inventory degraded', { failures, truncatedChannels });
  }

  return {
    channelsRecorded,
    channelsWithMembers,
    membersRecorded,
    truncatedChannels,
    failures,
  };
}

interface ChannelRecordOutcome {
  readonly channelRecorded: boolean;
  readonly members?: number;
  readonly truncated?: boolean;
  readonly error?: string;
}

async function recordOneChannel(
  repository: ChannelInventoryRepository,
  listMembers: (channelId: string) => Promise<ChannelMemberScan>,
  channel: ChannelSnapshot,
  isMember: boolean,
  now: Date,
): Promise<ChannelRecordOutcome> {
  try {
    await repository.upsertChannel(
      {
        channelId: channel.id,
        name: channel.name,
        isPrivate: channel.isPrivate,
        isArchived: channel.isArchived,
        isMember,
        memberCountReported: channel.memberCountReported ?? null,
      },
      now,
    );
  } catch (error) {
    return { channelRecorded: false, error: errorMessage(error) };
  }

  if (!isMember) return { channelRecorded: true };

  try {
    const scan = await listMembers(channel.id);
    await repository.replaceMembers(channel.id, scan.memberIds, now);
    return {
      channelRecorded: true,
      members: scan.memberIds.length,
      truncated: scan.truncated,
    };
  } catch (error) {
    return { channelRecorded: true, error: errorMessage(error) };
  }
}

function isInventoryDegraded(inventory: ChannelInventoryReport | undefined): boolean {
  if (!inventory) return false;
  return inventory.failures.length > 0 || inventory.truncatedChannels.length > 0;
}
