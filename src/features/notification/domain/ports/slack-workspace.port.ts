export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  memberCount: number;
  topic: string;
  purpose: string;
}

export interface SlackMember {
  id: string;
  name: string;
  realName: string;
  email: string | null;
  firstName: string;
  lastName: string;
  displayName: string;
  title: string;
  isBot: boolean;
  isAdmin: boolean;
  isRestricted: boolean;
  isUltraRestricted: boolean;
  isDeleted: boolean;
  teamId: string;
}

export interface SlackWorkspaceProvider {
  listChannels(): Promise<SlackChannel[]>;
  listMembers(): Promise<SlackMember[]>;
  findUserByEmail(email: string): Promise<SlackMember | null>;
  getUserById(userId: string): Promise<SlackMember | null>;
  inviteToChannel(channelId: string, userId: string): Promise<void>;
  getChannelMembers(channelId: string): Promise<string[]>;
}

export const SLACK_PAGE_LIMIT = 200;

export const SLACK_MAX_PAGES = 50;

export interface SlackMemberPage {
  members: SlackMember[];
  nextCursor?: string;
}

export interface SlackChannelMembership {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  isMember: boolean;
}

export interface SlackChannelMembershipPage {
  channels: SlackChannelMembership[];
  nextCursor?: string;
}

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
  error?: string;
}
