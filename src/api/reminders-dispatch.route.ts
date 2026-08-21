import { registerApiRoute } from '@mastra/core/server';

import { dispatchDueReminders } from '../features/notification/application/services/dispatch-due-reminders';
import { DrizzleNotificationRepository } from '../features/notification/infrastructure/repositories/drizzle-notification.repository';
import { DrizzleEmployeeRepository } from '../features/employee/infrastructure/repositories/drizzle-employee.repository';
import { SlackAdapter } from '../features/notification/infrastructure/providers/slack.adapter';
import { SlackWorkspaceService } from '../features/notification/infrastructure/providers/slack-workspace.service';
import { createEmailProvider } from '../features/notification/infrastructure/providers/email-provider.factory';
import { REMINDER_DISPATCH_PATH } from '../features/notification/domain/services/reminder-dispatch';
import { logger } from '../shared/logger';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * L'HORLOGE EXTÉRIEURE — la seule pièce qui manquait pour qu'un rappel parte
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ce projet n'a JAMAIS pu envoyer un rappel, et la raison n'était ni un oubli ni une paresse :
 * une fonction serverless n'existe que le temps d'une requête. Aucun `setTimeout` ne survit au
 * gel, aucun processus ne tourne entre deux messages Slack. `findPending()` était écrite,
 * correcte, et n'avait aucun site d'appel — parce qu'il n'existait personne pour l'appeler.
 *
 * Le cron Vercel frappe désormais à cette porte une fois par jour. C'est tout ce qui manquait.
 *
 * ⚠️ **PAS SOUS `/api`** : `@mastra/server` refuse toute route personnalisée commençant par
 * l'`apiPrefix`, et c'est un ÉCHEC AU DÉMARRAGE, pas un 404.
 *
 * ⚠️ **PAS DE BUDGET DE 3 SECONDES ICI**, contrairement à `/slack/events` : un cron n'attend
 * pas. La remise est donc SYNCHRONE — et elle doit l'être, car `waitUntil` ne garantit rien
 * après qu'on a répondu à un appelant qui, lui, ne réessaiera pas avant demain.
 */

/**
 * ⚠️ **FAIL-CLOSED, à l'inverse du reste de ce dépôt.**
 *
 * Vercel ajoute automatiquement `Authorization: Bearer $CRON_SECRET` à ses invocations dès que
 * la variable existe. Sans elle, cette route serait une primitive publique permettant de
 * déclencher l'envoi de messages à des salariés — la seule chose que toute la feature
 * `recruitment` est construite pour ne pas offrir. En son absence on REFUSE, et on journalise
 * en `error` : un cron qui ne fait rien en silence est indiscernable d'un cron qui marche.
 */
export function authorizeCron(
  header: string | undefined,
  secret: string | undefined,
): { ok: true } | { ok: false; status: 401 | 503; reason: string } {
  if (!secret) {
    return { ok: false, status: 503, reason: 'cron_secret_not_configured' };
  }
  if (header !== `Bearer ${secret}`) {
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

      return c.json({ ok: true, ...report });
    } catch (error) {
      logger.error('Remise des rappels interrompue', { error: String(error) });
      return c.json({ ok: false, reason: 'dispatch_failed' }, 500);
    }
  },
});
