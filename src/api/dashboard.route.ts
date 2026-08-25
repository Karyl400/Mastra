import { registerApiRoute } from '@mastra/core/server';

import { DrizzleDashboardFactsRepository } from '../features/dashboard/infrastructure/repositories/drizzle-dashboard-facts.repository';
import { buildSnapshot } from '../features/dashboard/domain/services/dashboard-snapshot';
import {
  LIVE_WINDOW_MS,
  WINDOW_HOURS,
  type DashboardFactsRepository,
} from '../features/dashboard/domain/ports/dashboard-facts.repository';
import { constantTimeEquals } from '../shared/security/api-auth';
import { logger } from '../shared/logger';
import { DASHBOARD_PAGE } from './dashboard-page';

export const DASHBOARD_PATH = '/dashboard';

export const DASHBOARD_METRICS_PATH = '/dashboard/metrics';

export function authorizeDashboard(
  header: string | undefined,
  secret: string | undefined,
): { ok: true } | { ok: false; status: 401 | 503; reason: string } {
  const configured = secret?.trim();
  if (!configured) {
    return { ok: false, status: 503, reason: 'dashboard_token_not_configured' };
  }
  if (!constantTimeEquals(header ?? '', `Bearer ${configured}`)) {
    return { ok: false, status: 401, reason: 'bad_dashboard_authorization' };
  }
  return { ok: true };
}

let repository: DashboardFactsRepository | null = null;

function getRepository(): DashboardFactsRepository {
  repository ??= new DrizzleDashboardFactsRepository();
  return repository;
}

export const dashboardPageRoute = registerApiRoute(DASHBOARD_PATH, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Tableau de bord — la coquille, sans aucune donnée',
    description:
      'Sert la page. Elle ne porte AUCUNE mesure : les chiffres sont demandés ensuite par le ' +
      'navigateur avec un jeton. Un GET sur cette URL ne révèle donc rien.',
    tags: ['dashboard'],
    responses: { 200: { description: 'Page servie' } },
  },
  handler: (c) =>
    c.newResponse(DASHBOARD_PAGE, 200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    }),
});

export const dashboardMetricsRoute = registerApiRoute(DASHBOARD_METRICS_PATH, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Les mesures du tableau de bord',
    description:
      'Lecture seule, aucun appel de modèle. Chaque métrique déclare sa source ; celles qui ' +
      'n’en ont pas rendent la RAISON de leur absence, jamais une valeur par défaut.',
    tags: ['dashboard'],
    responses: {
      200: { description: 'Instantané' },
      401: { description: 'Jeton absent ou faux' },
      503: { description: 'DASHBOARD_TOKEN non configuré — la route refuse de servir' },
    },
  },
  handler: async (c) => {
    const verdict = authorizeDashboard(c.req.header('authorization'), process.env.DASHBOARD_TOKEN);

    if (!verdict.ok) {
      logger.warn('Tableau de bord refusé', { reason: verdict.reason });
      return c.json({ ok: false, reason: verdict.reason }, verdict.status);
    }

    const now = new Date();

    try {
      const facts = await getRepository().readFacts(now);
      return c.json({
        ok: true,
        at: now.toISOString(),
        windowHours: WINDOW_HOURS,
        liveWindowMinutes: LIVE_WINDOW_MS / 60_000,
        unreadableTables: facts.unreadableTables,
        metrics: buildSnapshot(facts),
        feed: facts.feed,
      });
    } catch (error) {
      logger.error('Lecture du tableau de bord impossible', { error });
      return c.json({ ok: false, reason: 'facts_unavailable' }, 503);
    }
  },
});
