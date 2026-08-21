import { registerApiRoute } from '@mastra/core/server';

import { dispatchDueReminders } from '../features/notification/application/services/dispatch-due-reminders';
import { DrizzleNotificationRepository } from '../features/notification/infrastructure/repositories/drizzle-notification.repository';
import { DrizzleEmployeeRepository } from '../features/employee/infrastructure/repositories/drizzle-employee.repository';
import { SlackAdapter } from '../features/notification/infrastructure/providers/slack.adapter';
import { SlackWorkspaceService } from '../features/notification/infrastructure/providers/slack-workspace.service';
import { createEmailProvider } from '../features/notification/infrastructure/providers/email-provider.factory';
import { REMINDER_DISPATCH_PATH } from '../features/notification/domain/services/reminder-dispatch';
import { logger } from '../shared/logger';
import { pruneKnowledge } from '../features/knowledge/application/services/prune-knowledge';
import { DrizzleMessageArchiveRepository } from '../features/knowledge/infrastructure/repositories/drizzle-message-archive.repository';
import { DrizzleKnowledgeFactRepository } from '../features/knowledge/infrastructure/repositories/drizzle-knowledge-fact.repository';
import { constantTimeEquals } from '../shared/security/api-auth';

export function authorizeCron(
  header: string | undefined,
  secret: string | undefined,
): { ok: true } | { ok: false; status: 401 | 503; reason: string } {
  if (!secret) {
    return { ok: false, status: 503, reason: 'cron_secret_not_configured' };
  }
  if (!constantTimeEquals(header ?? '', `Bearer ${secret}`)) {
    return { ok: false, status: 401, reason: 'bad_cron_authorization' };
  }
  return { ok: true };
}

export const remindersDispatchRoute = registerApiRoute(REMINDER_DISPATCH_PATH, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Remise quotidienne des rappels enregistrés',
    description:
      'Invoquée par le cron Vercel. Envoie les rappels dont le jour est arrivé, puis en rend ' +
      'le compte. Aucun appel de modèle.',
    tags: ['cron'],
    responses: {
      200: { description: 'Remise effectuée' },
      401: { description: 'En-tête Authorization absent ou faux' },
      503: { description: 'CRON_SECRET non configuré — la route refuse de servir' },
    },
  },
  handler: async (c) => {
    const verdict = authorizeCron(
      c.req.header('authorization'),
      process.env.CRON_SECRET?.trim() || undefined,
    );

    if (!verdict.ok) {
      logger.error('Remise des rappels refusée', { reason: verdict.reason });
      return c.json({ ok: false, reason: verdict.reason }, verdict.status);
    }

    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken) {
      logger.error('Remise des rappels impossible : SLACK_BOT_TOKEN absent');
      return c.json({ ok: false, reason: 'slack_token_missing' }, 503);
    }

    try {
      const report = await dispatchDueReminders({
        notifications: new DrizzleNotificationRepository(),
        employees: new DrizzleEmployeeRepository(),
        email: createEmailProvider(),
        chat: new SlackAdapter(botToken),
        slackWorkspace: new SlackWorkspaceService(botToken),
      });

      const retention = await pruneKnowledge({
        archive: new DrizzleMessageArchiveRepository(),
        facts: new DrizzleKnowledgeFactRepository(),
        retentionDays: process.env.KNOWLEDGE_RETENTION_DAYS,
      });

      return c.json({ ok: true, ...report, retention });
    } catch (error) {
      logger.error('Remise des rappels interrompue', { error: String(error) });
      return c.json({ ok: false, reason: 'dispatch_failed' }, 500);
    }
  },
});
