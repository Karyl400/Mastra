import { describe, it, expect, vi } from 'vitest';
import {
  isCallerError,
  createCallerErrorMiddleware,
  CALLER_ERROR_STATUS,
} from '../../../src/shared/security/caller-error-mapping';

describe('isCallerError', () => {
  describe('requalifie', () => {
    it.each([
      'Invalid input data: \n- employeeId: Required',
      'Invalid initial data: \n- foo: Required',
      'Invalid request context: \n- bar: Required',
    ])('reconnaît %j', (message) => {
      expect(isCallerError({ status: 500, message })).toBe(true);
    });

    it('tolère une indentation de tête', () => {
      expect(isCallerError({ status: 500, message: '  Invalid input data: x' })).toBe(true);
    });
  });

  describe("ne touche à rien d'autre", () => {
    it('laisse un 401 (couche auth) intact', () => {
      expect(isCallerError({ status: 401, message: 'Unauthorized' })).toBe(false);
    });

    it('laisse un 404 intact', () => {
      expect(isCallerError({ status: 404, message: 'Not found' })).toBe(false);
    });

    it('laisse un 422 intact', () => {
      expect(isCallerError({ status: 422, message: 'Invalid input data: x' })).toBe(false);
    });

    it('laisse une VRAIE panne serveur en 500', () => {
      expect(isCallerError({ status: 500, message: 'Cannot find module js-md5' })).toBe(false);
    });

    it("ne requalifie pas si les mots-clés n'ouvrent pas le message", () => {
      expect(
        isCallerError({
          status: 500,
          message: 'Database crashed while reporting Invalid input data:',
        }),
      ).toBe(false);
    });

    it('gère message absent, vide, ou erreur nulle', () => {
      expect(isCallerError({ status: 500 })).toBe(false);
      expect(isCallerError({ status: 500, message: '' })).toBe(false);
      expect(isCallerError(null)).toBe(false);
      expect(isCallerError(undefined)).toBe(false);
    });
  });
});

describe('createCallerErrorMiddleware', () => {
  it('laisse passer une requête qui réussit', async () => {
    const mw = createCallerErrorMiddleware();
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(mw({}, next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("transforme une faute d'appelant 500 en 400 en conservant le corps", async () => {
    const body = JSON.stringify({ error: 'Invalid input data: \n- employeeId: Required' });
    const err = Object.assign(new Error('Invalid input data: \n- employeeId: Required'), {
      status: 500,
      getResponse: () =>
        new Response(body, { status: 500, headers: { 'content-type': 'application/json' } }),
    });

    const onRemap = vi.fn();
    const mw = createCallerErrorMiddleware({ onRemap });
    const res = (await mw({}, () => Promise.reject(err))) as Response;

    expect(res.status).toBe(CALLER_ERROR_STATUS);
    expect(res.status).toBe(400);
    await expect(res.text()).resolves.toBe(body);
    expect(onRemap).toHaveBeenCalledOnce();
  });

  it('reconstruit un corps quand getResponse est absent', async () => {
    const err = Object.assign(new Error('Invalid input data: \n- x: Required'), { status: 500 });
    const mw = createCallerErrorMiddleware();
    const res = (await mw({}, () => Promise.reject(err))) as Response;

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid input data: \n- x: Required' });
  });

  it('RELANCE une vraie panne serveur sans la masquer', async () => {
    const err = Object.assign(new Error("Cannot find module 'js-md5'"), { status: 500 });
    const mw = createCallerErrorMiddleware();

    await expect(mw({}, () => Promise.reject(err))).rejects.toThrow(/js-md5/);
  });

  it('RELANCE un 401 sans le convertir', async () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    const mw = createCallerErrorMiddleware();

    await expect(mw({}, () => Promise.reject(err))).rejects.toThrow(/Unauthorized/);
  });
});

describe('inspection de la RÉPONSE (chemin réel en production)', () => {
  it('requalifie une réponse 500 dont le corps est une erreur de validation', async () => {
    const body = JSON.stringify({ error: 'Invalid input data: \n- employeeId: Required' });
    const c = {
      res: new Response(body, { status: 500, headers: { 'content-type': 'application/json' } }),
    };

    const onRemap = vi.fn();
    const mw = createCallerErrorMiddleware({ onRemap });
    await mw(c, async () => undefined);

    // ⚠️ L'assertion porte sur `c.res`, PAS sur la valeur de retour — et ce test asseyait le
    // retour jusqu'au 2026-08-14, ce qui l'a laissé au vert pendant que le middleware était
    // INOPÉRANT en production. Dans Hono, le retour d'un middleware n'est pris en compte que
    // s'il n'a pas appelé `next()` ; après `next()`, seule l'affectation de `c.res` compte.
    //
    // Symptôme resté inexpliqué jusque-là : le scénario « entrée invalide → HTTP 4xx »
    // rendait 500 en production, et la cause avait été notée comme indéterminée.
    expect(c.res.status).toBe(400);
    await expect(c.res.text()).resolves.toBe(body);
    expect(onRemap).toHaveBeenCalledOnce();
  });

  it('laisse une VRAIE panne 500 intacte', async () => {
    const body = JSON.stringify({ error: "Cannot find module 'js-md5'" });
    const c = { res: new Response(body, { status: 500 }) };

    const out = await createCallerErrorMiddleware()(c, async () => undefined);
    expect(out).toBeUndefined();
  });

  it('ne touche pas une réponse 200', async () => {
    const c = { res: new Response('{"ok":true}', { status: 200 }) };
    const out = await createCallerErrorMiddleware()(c, async () => undefined);
    expect(out).toBeUndefined();
  });

  it('ne consomme pas le corps de la réponse originale', async () => {
    const c = {
      res: new Response(JSON.stringify({ error: 'Invalid input data: x' }), { status: 500 }),
    };
    await createCallerErrorMiddleware()(c, async () => undefined);
    expect(c.res.bodyUsed).toBe(false);
  });
});
