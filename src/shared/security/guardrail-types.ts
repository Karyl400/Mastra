export interface VaultConfig {
  primaryKey: Buffer;
  retiredKeys: Buffer[];
  securitySalt: string;
  cacheTTL: number;
}

export interface KeyVersion {
  version: number;
  key: Buffer;
  createdAt: Date;
}

export interface SessionData {
  sessionId: string;
  delimiters: DelimiterSet;
  securityHash: string;
  turnCount: number;
  createdAt: Date;
  lastActivity: Date;
}

export interface DelimiterSet {
  prefix: string;
  suffix: string;
  tagPrefix: string;
}

export interface IKeyManager {
  getEncryptionKey(): Buffer;
  getActiveVersion(): number;
  getDecryptionKeys(): Buffer[];
  rotate(): void;
}

export interface ISessionManager {
  getOrCreate(sessionId: string): SessionData;
  revoke(sessionId: string): boolean;
  cleanup(): number;
  destroy(): void;
  readonly activeSessionCount: number;
}
