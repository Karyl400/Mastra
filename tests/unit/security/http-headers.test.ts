import { describe, it, expect } from 'vitest';

import {
  SECURITY_HEADERS,
  createSecurityHeadersMiddleware,
} from '../../../src/shared/security/http-headers';

/**
 * ⚠️ Ces tests portent sur `c.res`, JAMAIS sur la valeur de retour — et c'est l'invariant
 * central de ce fichier. Les tests unitaires des deux middlewares précédents assertaient le
 * RETOUR : ils sont restés au vert pendant que le code était mort en production, et le prompt
 * système fuyait. Un test qui vérifie la mauvaise chose est pire qu'aucun test.
 */
const runMiddleware = async (initial: Response): Promise<Response> => {
  const ctx = { res: initial } as { res: Response };
  await createSecurityHeadersMiddleware()(ctx as never, async () => {});
  return ctx.res;
};

describe('en-têtes de sécurité', () => {
  it('les pose sur `c.res`, pas dans une valeur de retour', async () => {
    const res = await runMiddleware(new Response('{}', { status: 200 }));

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value);
    }
  });

  it('préserve le statut, le corps et les en-têtes existants', async () => {
    // Une reconstruction de réponse qui perdrait le `content-type` casserait tout appelant
    // JSON — le correctif deviendrait la panne.
    const res = await runMiddleware(
      new Response('{"ok":true}', {
        status: 401,
        headers: { 'content-type': 'application/json', 'x-metier': 'conservé' },
      }),
    );

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"ok":true}');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-metier')).toBe('conservé');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('écrase une valeur plus permissive posée en amont', async () => {
    const res = await runMiddleware(
      new Response('', { headers: { 'x-frame-options': 'ALLOWALL' } }),
    );

    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
