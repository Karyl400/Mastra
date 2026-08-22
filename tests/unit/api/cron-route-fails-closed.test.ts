import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { remindersDispatchRoute } from '../../../src/api/reminders-dispatch.route';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE REFUS DU CRON EST-IL BRANCHÉ ? — et non « la règle est-elle juste »
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ TROUVÉ PAR MUTATION LE 2026-08-22. En remplaçant `if (!verdict.ok)` par `if (false)`
 * dans `reminders-dispatch.route.ts`, la suite entière restait VERTE. La route aurait servi
 * toute requête non authentifiée, et rien ne l'aurait dit.
 *
 * `authorizeCron` était pourtant testée — mais **uniquement comme fonction pure**. Le verdict
 * était calculé correctement, et rien ne vérifiait que le handler l'HONORE. C'est exactement
 * la double leçon Hono déjà payée deux fois par ce dépôt (`createCallerErrorMiddleware`
 * inopérant, rédaction de sortie muette) : le prédicat était juste, le branchement était mort.
 *
 * ⚠️ Ce que cette route protège n'est pas un confort : sans `CRON_SECRET`, elle serait une
 * primitive PUBLIQUE permettant d'expédier des messages à des salariés. D'où le fail-closed
 * en 503, à l'inverse du fail-open qui gouverne le reste du dépôt.
 *
 * ⚠️ On ne teste QUE les chemins de refus. Le chemin autorisé construit de vrais dépôts
 * Drizzle et de vrais clients Slack — le faire tourner ici ouvrirait une base et partirait
 * sur le réseau. Le refus, lui, rend la main avant toute construction : c'est précisément la
 * propriété qu'on veut garder.
 */

interface JsonCapture {
  readonly body: unknown;
  readonly status: number;
}

async function invokeWith(authorization: string | undefined): Promise<JsonCapture> {
  const captured: { value?: JsonCapture } = {};

  const context = {
    req: { header: (name: string) => (name === 'authorization' ? authorization : undefined) },
    json: (body: unknown, status = 200) => {
      captured.value = { body, status };
      return { body, status };
    },
  };

  const { handler } = remindersDispatchRoute as unknown as {
    handler: (c: unknown) => Promise<unknown>;
  };

  await handler(context);

  if (!captured.value) throw new Error('le handler n’a rendu aucune réponse JSON');
  return captured.value;
}

const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
});

describe('la route de remise des rappels refuse RÉELLEMENT, pas seulement en théorie', () => {
  it('sans CRON_SECRET configuré : 503, et rien ne part', async () => {
    delete process.env.CRON_SECRET;

    const response = await invokeWith('Bearer peu importe');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ ok: false, reason: 'cron_secret_not_configured' });
  });

  it('sans en-tête Authorization : 401', async () => {
    process.env.CRON_SECRET = 'secret-de-test-suffisamment-long';

    const response = await invokeWith(undefined);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ ok: false, reason: 'bad_cron_authorization' });
  });

  it('avec un mauvais secret : 401', async () => {
    process.env.CRON_SECRET = 'secret-de-test-suffisamment-long';

    const response = await invokeWith('Bearer mauvais-secret');

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ ok: false, reason: 'bad_cron_authorization' });
  });

  it('un secret entouré d’espaces ne contourne pas la comparaison', async () => {
    process.env.CRON_SECRET = 'secret-de-test-suffisamment-long';

    const response = await invokeWith('Bearer  secret-de-test-suffisamment-long ');

    expect(response.status).toBe(401);
  });
});
