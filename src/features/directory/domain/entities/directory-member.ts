export interface DirectoryMember {
  readonly slackUserId: string;
  readonly teamId: string;

  readonly email: string | null;
  readonly realName: string;
  readonly displayName: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly title: string | null;

  readonly isBot: boolean;
  readonly isAdmin: boolean;
  readonly isRestricted: boolean;
  readonly isUltraRestricted: boolean;
  readonly isDeleted: boolean;

  readonly dmChannelId: string | null;

  readonly employeeId: string | null;

  readonly isManager: boolean;

  readonly firstSeenAt: Date;
  readonly syncedAt: Date;
}

export interface DirectoryMemberFacts {
  readonly slackUserId: string;
  readonly teamId: string;
  readonly email: string | null;
  readonly realName: string;
  readonly displayName: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly title: string | null;
  readonly isBot: boolean;
  readonly isAdmin: boolean;
  readonly isRestricted: boolean;
  readonly isUltraRestricted: boolean;
  readonly isDeleted: boolean;
}
