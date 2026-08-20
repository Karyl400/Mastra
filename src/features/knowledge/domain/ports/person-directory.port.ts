export interface DirectoryPerson {
  readonly slackUserId: string;
  readonly displayName: string;
  readonly email: string | null;

  readonly dmChannelId: string | null;

  readonly isBot: boolean;
  readonly isRestricted: boolean;
  readonly isUltraRestricted: boolean;
  readonly isDeleted: boolean;

  readonly isManager: boolean;
}

export interface PersonDirectoryPort {
  findBySlackUserId(slackUserId: string): Promise<DirectoryPerson | null>;
  findByEmail(email: string): Promise<DirectoryPerson | null>;
}
