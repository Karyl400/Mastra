import { randomUUID } from 'node:crypto';
import { getDb, type DatabaseInstance } from '../database/connection';
import { auditLogs } from '../database/schema';
import { logger } from '../../shared/logger';

export interface AuditEntry {
  action: string;
  actorId: string;
  actorType?: 'user' | 'system' | 'api' | 'webhook';
  resourceType?: string;
  resourceId?: string;
  status?: 'success' | 'accepted' | 'failure' | 'denied';
  details?: Record<string, unknown>;
  requestId?: string;
  sessionId?: string;
  errorMessage?: string;
}

export async function writeAuditLog(
  entry: AuditEntry,
  resolveDb: () => DatabaseInstance = getDb,
): Promise<void> {
  try {
    await resolveDb()
      .insert(auditLogs)
      .values({
        id: randomUUID(),
        action: entry.action,
        actorId: entry.actorId,
        actorType: entry.actorType ?? 'user',
        resourceType: entry.resourceType ?? null,
        resourceId: entry.resourceId ?? null,
        status: entry.status ?? 'success',
        details: entry.details ?? null,
        requestId: entry.requestId ?? null,
        sessionId: entry.sessionId ?? null,
        errorMessage: entry.errorMessage ?? null,
      });
  } catch (error) {
    logger.warn('Audit log write failed', { action: entry.action, error });
  }
}
