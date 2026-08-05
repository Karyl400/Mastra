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
  isBot: boolean;
  isAdmin: boolean;
  teamId: string;
}

export interface SlackWorkspaceProvider {
  listChannels(): Promise<SlackChannel[]>;
  listMembers(): Promise<SlackMember[]>;
  findUserByEmail(email: string): Promise<SlackMember | null>;
  inviteToChannel(channelId: string, userId: string): Promise<void>;
  getChannelMembers(channelId: string): Promise<string[]>;
}
