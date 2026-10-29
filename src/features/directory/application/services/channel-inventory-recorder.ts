import { logger } from '../../../../shared/logger';
import { errorMessage } from '../../../../shared/errors';
import type { ChannelInventoryRepository } from '../../domain/ports/channel.repository';
import type {
  ChannelCoverageDeps,
  ChannelInventoryFailure,
  ChannelInventoryReport,
  ChannelMemberScan,
  ChannelSnapshot,
} from './channel-coverage.types';

export async function recordInventory(
  deps: ChannelCoverageDeps,
  channels: readonly ChannelSnapshot[],
  accessible: ReadonlySet<string>,
): Promise<ChannelInventoryReport | undefined> {
  const repository = deps.inventory;
  const listMembers = deps.source.listMembers?.bind(deps.source);
  if (!repository || !listMembers) {
    return undefined;
  }

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
    if (outcome.channelRecorded) {
      channelsRecorded += 1;
    }
    if (outcome.members !== undefined) {
      channelsWithMembers += 1;
      membersRecorded += outcome.members;
      if (outcome.truncated) {
        truncatedChannels.push(channel.id);
      }
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

  if (!isMember) {
    return { channelRecorded: true };
  }

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

export function isInventoryDegraded(inventory: ChannelInventoryReport | undefined): boolean {
  if (!inventory) {
    return false;
  }
  return inventory.failures.length > 0 || inventory.truncatedChannels.length > 0;
}
