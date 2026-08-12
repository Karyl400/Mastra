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
  /**
   * Cascade `profile.display_name` → `profile.real_name` → `real_name` → `name`, et elle
   * descend jusqu'au bout : un refus d'autorisation doit TOUJOURS pouvoir nommer quelqu'un.
   */
  displayName: string;
  isBot: boolean;
  isAdmin: boolean;
  /**
   * Drapeaux de CONFIANCE, matière première de la politique d'autorisation.
   *
   * `isRestricted` = invité multi-canal, `isUltraRestricted` = invité mono-canal. Slack pose les
   * DEUX sur un invité mono-canal, et on les lit tels quels : déduire l'un de l'autre
   * interdirait à la politique de durcir le seul cas mono-canal — celui du scénario §4.1 de
   * `PLAN-ARCHITECTURE.md`, où un invité demande en DM le résumé d'un canal privé.
   */
  isRestricted: boolean;
  isUltraRestricted: boolean;
  /**
   * Compte désactivé. C'est ce qui permet de REFUSER un ancien salarié, là où un compte inconnu
   * (`null` rendu par le port) est seulement rétrogradé.
   */
  isDeleted: boolean;
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
