import { createHash } from 'crypto';

import { logger } from '../logger';
import { sessionCounter } from './guardrail-metrics';
import { DelimiterGenerator } from './delimiter-generator';
import type { ISessionManager, SessionData } from './guardrail-types';

export class SessionManager implements ISessionManager {
  private sessions: Map<string, SessionData>;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly maxSessionAge: number;
  private readonly maxSessions: number = 10000;

  constructor(config?: { maxSessionAge?: number; cleanupIntervalMs?: number }) {
    this.sessions = new Map();
    this.maxSessionAge = config?.maxSessionAge || 1800000;

    this.cleanupInterval = setInterval(() => this.cleanup(), config?.cleanupIntervalMs || 300000);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  getOrCreate(sessionId: string): SessionData {
    const existing = this.sessions.get(sessionId);

    if (existing) {
      existing.lastActivity = new Date();
      return existing;
    }

    const delimiters = DelimiterGenerator.generate();
    const session: SessionData = {
      sessionId,
      delimiters,
      securityHash: createHash('sha256')
        .update(sessionId + delimiters.prefix)
        .digest('hex')
        .substring(0, 12),
      turnCount: 0,
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    this.sessions.set(sessionId, session);

    if (this.sessions.size > this.maxSessions) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey) {
        this.sessions.delete(oldestKey);
      }
    }

    sessionCounter.add(1);

    return session;
  }

  revoke(sessionId: string): boolean {
    const existed = this.sessions.has(sessionId);
    this.sessions.delete(sessionId);

    if (existed) {
      logger.info('Session revoked', { sessionId });
      sessionCounter.add(-1);
    }

    return existed;
  }

  cleanup(): number {
    const now = Date.now();
    let removedCount = 0;

    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > this.maxSessionAge) {
        this.sessions.delete(id);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      sessionCounter.add(-removedCount);
      logger.debug('Session cleanup completed', {
        removedCount,
        remainingCount: this.sessions.size,
      });
    }

    return removedCount;
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    sessionCounter.add(-this.sessions.size);
    this.sessions.clear();
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }
}

export function createFixedSessionManager(sessionId: string): ISessionManager {
  const delimiters = DelimiterGenerator.generate();
  const session: SessionData = {
    sessionId,
    delimiters,
    securityHash: createHash('sha256')
      .update(sessionId + delimiters.prefix)
      .digest('hex')
      .substring(0, 12),
    turnCount: 0,
    createdAt: new Date(),
    lastActivity: new Date(),
  };

  return {
    getOrCreate: () => {
      session.lastActivity = new Date();
      return session;
    },
    revoke: () => false,
    cleanup: () => 0,
    destroy: () => {},
    get activeSessionCount() {
      return 1;
    },
  };
}
