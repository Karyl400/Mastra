export interface SlackChannelRecord {
  readonly channelId: string;
  readonly name: string;
  readonly isPrivate: boolean;
  readonly isArchived: boolean;
  readonly isMember: boolean;

  readonly memberCountReported: number | null;

  readonly syncedAt: Date;
}

export interface SlackChannelFacts {
  readonly channelId: string;
  readonly name: string;
  readonly isPrivate: boolean;
  readonly isArchived: boolean;
  readonly isMember: boolean;
  readonly memberCountReported: number | null;
}

export interface SlackChannelMembership {
  readonly channelId: string;
  readonly slackUserId: string;
  readonly firstSeenAt: Date;
  readonly syncedAt: Date;
}

export interface SlackChannelInventoryEntry {
  readonly channel: SlackChannelRecord;
  readonly observedMemberCount: number;
}
