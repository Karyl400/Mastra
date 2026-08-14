import { describe, it, expect, vi } from 'vitest';

import {
  FORGEABLE_CONTEXT_PREFIX,
  createRequestContextGuard,
} from '../../../src/shared/security/request-context-guard';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * `requestContext` était FORGEABLE par le corps HTTP sur `/api/*`
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Relevé le 2026-08-12, non corrigé jusqu'ici. Mastra fusionne `body.requestContext` dans le
 * contexte serveur et n'écarte que `RESERVED_CONTEXT_KEYS` — vérifié dans
 * `@mastra/server/dist/constants-*.js` : la liste tient `mastra__*` et `organizationId`, et
 * **aucune clé `slack*`**.
 *
 * Conséquence : un appelant porteur de `MASTRA_API_TOKEN` posait `slackUserId`,
 * `slackAccessLevel: 'full'` et `slackEmployeeId` dans son corps JSON, et devenait n'importe
 * qui. `canReadPersonRecord` décide sur `slackEmployeeId` ; `getUserConversations` et
 * `canPerformSideEffects` décident sur `slackAccessLevel`. Le jeton de service valait donc
 * l'usurpation totale — y compris la lecture du dossier RH de tout le monde.
 *
 * L'invariant écrit en tête de `slack-request-context.ts` (« un canal que le modèle ne peut pas
 * écrire ») ne valait que sur `/slack/events`, seul producteur légitime — et celui-ci ne passe
 * PAS par ce middleware.
 *
 * ── Pourquoi REFUSER et non ASSAINIR ────────────────────────────────────────
 * Retirer les clés en silence laisserait l'appel aboutir avec un contexte différent de celui
 * demandé : le tool dégraderait (`readSlackContext` rend `undefined` hors Slack) et rendrait
 * une réponse plausible. Or il n'existe AUCUN appelant légitime de `/api/*` qui ait une raison
 * de poser une clé `slack*` — la seule intention possible est l'usurpation. On échoue donc
 * bruyamment, ce qui est aussi la seule forme qui laisse une trace exploitable.
 */

function jsonRequest(body: unknown): Request {
  return new Request('https://kisso.test/api/agents/x/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Le strict minimum du contexte Hono que le middleware touche. */
function honoContext(raw: Request) {
  return { req: { raw } };
}

describe('createRequestContextGuard', () => {
  it('REFUSE une requête qui pose slackAccessLevel', async () => {
    const onReject = vi.fn();
    const guard = createRequestContextGuard({ onReject });
    const next = vi.fn();

    const res = await guard(
      honoContext(jsonRequest({ messages: [], requestContext: { slackAccessLevel: 'full' } })),
      next,
    );

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(400);
    // Le handler ne doit JAMAIS être atteint : on refuse avant, pas après.
    expect(next).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith(expect.arrayContaining(['slackAccessLevel']));
  });

  it('REFUSE slackEmployeeId — la clé sur laquelle se décide l accès au dossier RH', async () => {
    const guard = createRequestContextGuard({});
    const next = vi.fn();

    const res = await guard(
      honoContext(jsonRequest({ requestContext: { slackEmployeeId: 'd20df236' } })),
      next,
    );

    expect(res!.status).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('nomme TOUTES les clés fautives, pas seulement la première', async () => {
    const onReject = vi.fn();
    const guard = createRequestContextGuard({ onReject });

    await guard(
      honoContext(
        jsonRequest({ requestContext: { slackUserId: 'U1', slackChannel: 'C1', tone: 'bref' } }),
      ),
      vi.fn(),
    );

    const named = onReject.mock.calls[0]![0] as string[];
    expect(named).toContain('slackUserId');
    expect(named).toContain('slackChannel');
    expect(named).not.toContain('tone');
  });

  it('est insensible à la CASSE — `SlackAccessLevel` ne doit pas contourner', async () => {
    // Le registre de Mastra est un objet JS ordinaire : la casse n'y est pas normalisée, mais
    // un lecteur pressé pourrait croire que seule la forme exacte compte. On refuse la famille.
    const guard = createRequestContextGuard({});

    const res = await guard(
      honoContext(jsonRequest({ requestContext: { SlackAccessLevel: 'full' } })),
      vi.fn(),
    );

    expect(res!.status).toBe(400);
  });

  it('LAISSE PASSER un requestContext sans clé slack', async () => {
    const guard = createRequestContextGuard({});
    const next = vi.fn();

    const res = await guard(
      honoContext(jsonRequest({ requestContext: { locale: 'fr', organizationId: 'kisso' } })),
      next,
    );

    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('LAISSE PASSER une requête sans requestContext du tout', async () => {
    const guard = createRequestContextGuard({});
    const next = vi.fn();

    await guard(honoContext(jsonRequest({ messages: ['bonjour'] })), next);

    expect(next).toHaveBeenCalled();
  });

  it('ne consomme PAS le corps — le handler doit encore pouvoir le lire', async () => {
    // Régression de première importance : lire `c.req.raw.json()` sans cloner viderait le
    // flux, et TOUTE requête `/api/*` légitime partirait ensuite sur un corps vide. Le
    // middleware casserait précisément ce qu'il est censé protéger.
    const guard = createRequestContextGuard({});
    const raw = jsonRequest({ messages: ['bonjour'] });
    const ctx = honoContext(raw);

    await guard(ctx, vi.fn());

    await expect(ctx.req.raw.json()).resolves.toEqual({ messages: ['bonjour'] });
  });

  it('laisse passer un corps NON-JSON sans lever', async () => {
    // Un corps illisible n'est pas notre affaire — Mastra le rejettera lui-même. Lever ici
    // transformerait une faute d'appelant en 500, exactement ce que le middleware voisin
    // (`caller-error-mapping`) existe pour éviter.
    const guard = createRequestContextGuard({});
    const next = vi.fn();
    const raw = new Request('https://kisso.test/api/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'ceci nest pas du json',
    });

    await expect(guard(honoContext(raw), next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('laisse passer un GET, qui n a pas de corps', async () => {
    const guard = createRequestContextGuard({});
    const next = vi.fn();
    const raw = new Request('https://kisso.test/api/agents', { method: 'GET' });

    await guard(honoContext(raw), next);

    expect(next).toHaveBeenCalled();
  });

  it('expose le préfixe surveillé — il DOIT rester aligné sur slack-request-context', async () => {
    // Les clés réelles sont déclarées dans `src/shared/slack-request-context.ts`. Ce test ne
    // duplique pas la liste (elle bougerait), il verrouille l'invariant : toutes commencent
    // par ce préfixe, donc le garde les couvre TOUTES, y compris celles pas encore écrites.
    const contextModule = await import('../../../src/shared/slack-request-context');
    const declaredKeys = Object.entries(contextModule)
      .filter(([name]) => name.endsWith('_KEY'))
      .map(([, value]) => value as string);

    expect(declaredKeys.length).toBeGreaterThan(0);
    for (const key of declaredKeys) {
      expect(key.toLowerCase().startsWith(FORGEABLE_CONTEXT_PREFIX)).toBe(true);
    }
  });
});
