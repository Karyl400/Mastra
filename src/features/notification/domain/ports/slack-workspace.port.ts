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
  /** Prénom du profil Slack ; à défaut, premier mot de `realName`. */
  firstName: string;
  /** Nom du profil Slack ; à défaut, reste de `realName`. */
  lastName: string;
  isBot: boolean;
  isAdmin: boolean;
  teamId: string;
}

export interface SlackWorkspaceProvider {
  listChannels(): Promise<SlackChannel[]>;
  listMembers(): Promise<SlackMember[]>;
  findUserByEmail(email: string): Promise<SlackMember | null>;
  /**
   * Résout un membre par son identifiant Slack.
   *
   * Nécessaire au flux d'arrivée : le payload `team_join` ne porte de façon
   * fiable que `user.id` — l'email peut manquer tant que le profil n'est pas
   * complété.
   */
  getUserById(userId: string): Promise<SlackMember | null>;
  inviteToChannel(channelId: string, userId: string): Promise<void>;
  getChannelMembers(channelId: string): Promise<string[]>;
}
