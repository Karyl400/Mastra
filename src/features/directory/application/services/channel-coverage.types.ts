import type { ChannelInventoryRepository } from '../../domain/ports/channel.repository';

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
