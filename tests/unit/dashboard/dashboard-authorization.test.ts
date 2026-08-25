import { describe, it, expect } from 'vitest';

import { authorizeDashboard } from '../../../src/api/dashboard.route';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * FAIL-CLOSED, comme `CRON_SECRET` et à l'inverse du reste du dépôt
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le fail-open gouverne presque tout ici, et à raison : `readSlackContext` rend `undefined` hors
 * Slack, le marqueur de progression n'est jamais un point de panne, la mémoire dégrade en
 * silence. Dans chacun de ces cas, l'échec retire un confort.
 *
 * Ici il ouvrirait une route qui rend, en un GET, l'état d'avancement nominatif du personnel et
 * le compte des messages de chacun. Sans secret, cette page EST une fuite de données RH. Le refus
 * est donc un 503 — « je refuse de servir », et non un 401 qui suggérerait qu'un jeton existe.
 */
describe('authorizeDashboard', () => {
  it('REFUSE DE SERVIR quand aucun secret n’est configuré', () => {
    expect(authorizeDashboard('Bearer whatever', undefined)).toEqual({
      ok: false,
      status: 503,
      reason: 'dashboard_token_not_configured',
    });
  });

  it('refuse aussi un secret vide ou fait d’espaces — une variable posée à vide n’est pas posée', () => {
    expect(authorizeDashboard('Bearer ', '   ').ok).toBe(false);
    expect(authorizeDashboard('Bearer x', '').ok).toBe(false);
  });

  it('refuse un en-tête absent', () => {
    expect(authorizeDashboard(undefined, 'secret')).toEqual({
      ok: false,
      status: 401,
      reason: 'bad_dashboard_authorization',
    });
  });

  it('refuse un jeton faux, et refuse le secret nu sans le schéma', () => {
    expect(authorizeDashboard('Bearer wrong', 'secret').ok).toBe(false);
    expect(authorizeDashboard('secret', 'secret').ok).toBe(false);
  });

  it('accepte le bon jeton', () => {
    expect(authorizeDashboard('Bearer secret', 'secret')).toEqual({ ok: true });
  });
});
