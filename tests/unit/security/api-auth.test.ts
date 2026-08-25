import { describe, it, expect, vi } from 'vitest';
import {
  API_SERVICE_USER,
  API_TOKEN_ENV_VAR,
  MIN_API_TOKEN_LENGTH,
  constantTimeEquals,
  createApiAuthConfig,
  readConfiguredApiToken,
  verifyApiToken,
} from '../../../src/shared/security/api-auth';

/** Token de test : 64 caractères hex, même forme que celui généré en production. */
const VALID_TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);

const envWith = (token?: string): NodeJS.ProcessEnv =>
  (token === undefined ? {} : { [API_TOKEN_ENV_VAR]: token }) as NodeJS.ProcessEnv;

/** `authenticateToken` reçoit une requête ; aucun de nos tests ne la lit. */
const fakeRequest = { header: () => undefined } as never;

describe('API auth — vérification du bearer token des routes /api/*', () => {
  describe('readConfiguredApiToken', () => {
    it('1. retourne le token quand il est présent et assez long', () => {
      expect(readConfiguredApiToken(envWith(VALID_TOKEN))).toBe(VALID_TOKEN);
    });

    it('2. retourne null quand la variable est absente', () => {
      expect(readConfiguredApiToken(envWith())).toBeNull();
    });

    it('3. retourne null quand la variable est vide ou blanche', () => {
      expect(readConfiguredApiToken(envWith(''))).toBeNull();
      expect(readConfiguredApiToken(envWith('   '))).toBeNull();
    });

    it('4. rejette un token trop court (secret faible traité comme absent)', () => {
      expect(readConfiguredApiToken(envWith('x'.repeat(MIN_API_TOKEN_LENGTH - 1)))).toBeNull();
      expect(readConfiguredApiToken(envWith('x'.repeat(MIN_API_TOKEN_LENGTH)))).toBe(
        'x'.repeat(MIN_API_TOKEN_LENGTH),
      );
    });

    it('5. tolère les espaces autour de la valeur', () => {
      expect(readConfiguredApiToken(envWith(`  ${VALID_TOKEN}  `))).toBe(VALID_TOKEN);
    });
  });

  describe('constantTimeEquals', () => {
    it('6. reconnaît deux chaînes identiques', () => {
      expect(constantTimeEquals(VALID_TOKEN, VALID_TOKEN)).toBe(true);
    });

    it('7. distingue deux chaînes de même longueur', () => {
      expect(constantTimeEquals(VALID_TOKEN, OTHER_TOKEN)).toBe(false);
    });

    it('8. ne throw pas sur des longueurs différentes (timingSafeEqual brut throw)', () => {
      // C'est la raison du hachage SHA-256 préalable : les digests font toujours
      // 32 octets, donc la comparaison est possible quelle que soit l'entrée.
      expect(() => constantTimeEquals('court', VALID_TOKEN)).not.toThrow();
      expect(constantTimeEquals('court', VALID_TOKEN)).toBe(false);
      expect(constantTimeEquals('', VALID_TOKEN)).toBe(false);
      expect(constantTimeEquals(VALID_TOKEN + 'suffixe', VALID_TOKEN)).toBe(false);
    });

    it('9. ne se laisse pas berner par un préfixe du secret', () => {
      expect(constantTimeEquals(VALID_TOKEN.slice(0, 63), VALID_TOKEN)).toBe(false);
    });
  });

  describe('verifyApiToken', () => {
    it('10. accepte le bon token', () => {
      expect(verifyApiToken({ expectedToken: VALID_TOKEN, presentedToken: VALID_TOKEN })).toBe(
        true,
      );
    });

    it('11. accepte le bon token préfixé par « Bearer »', () => {
      expect(
        verifyApiToken({ expectedToken: VALID_TOKEN, presentedToken: `Bearer ${VALID_TOKEN}` }),
      ).toBe(true);
      expect(
        verifyApiToken({ expectedToken: VALID_TOKEN, presentedToken: `bearer ${VALID_TOKEN}` }),
      ).toBe(true);
    });

    it('12. refuse un token absent', () => {
      expect(verifyApiToken({ expectedToken: VALID_TOKEN, presentedToken: undefined })).toBe(false);
      expect(verifyApiToken({ expectedToken: VALID_TOKEN, presentedToken: null })).toBe(false);
      expect(verifyApiToken({ expectedToken: VALID_TOKEN, presentedToken: '' })).toBe(false);
      expect(verifyApiToken({ expectedToken: VALID_TOKEN, presentedToken: 'Bearer ' })).toBe(false);
    });

    it('13. refuse un mauvais token', () => {
      expect(verifyApiToken({ expectedToken: VALID_TOKEN, presentedToken: OTHER_TOKEN })).toBe(
        false,
      );
      expect(
        verifyApiToken({ expectedToken: VALID_TOKEN, presentedToken: VALID_TOKEN.slice(0, 63) }),
      ).toBe(false);
      expect(
        verifyApiToken({ expectedToken: VALID_TOKEN, presentedToken: VALID_TOKEN + 'x' }),
      ).toBe(false);
    });

    it('14. FAIL-CLOSED : refuse tout quand aucun secret n’est configuré', () => {
      expect(verifyApiToken({ expectedToken: null, presentedToken: VALID_TOKEN })).toBe(false);
      expect(verifyApiToken({ expectedToken: null, presentedToken: '' })).toBe(false);
      expect(verifyApiToken({ expectedToken: null, presentedToken: undefined })).toBe(false);
    });

    it('15. FAIL-CLOSED : refuse tout quand le secret configuré est trop faible', () => {
      const weak = 'short';
      expect(verifyApiToken({ expectedToken: weak, presentedToken: weak })).toBe(false);
    });
  });

  describe('createApiAuthConfig', () => {
    it('16. expose un authenticateToken et laisse protected/public au défaut Mastra', () => {
      const config = createApiAuthConfig({ env: envWith(VALID_TOKEN) });
      expect(typeof config.authenticateToken).toBe('function');
      // defaultAuthConfig de @mastra/server protège déjà '/api/*'.
      expect(config.protected).toBeUndefined();
      expect(config.public).toBeUndefined();
    });

    it('17. renvoie l’utilisateur de service pour un token valide', async () => {
      const config = createApiAuthConfig({ env: envWith(VALID_TOKEN) });
      await expect(config.authenticateToken!(VALID_TOKEN, fakeRequest)).resolves.toEqual(
        API_SERVICE_USER,
      );
    });

    it('18. renvoie null pour un token manquant (→ 401 côté Mastra)', async () => {
      const config = createApiAuthConfig({ env: envWith(VALID_TOKEN) });
      await expect(config.authenticateToken!('', fakeRequest)).resolves.toBeNull();
    });

    it('19. renvoie null pour un mauvais token (→ 401 côté Mastra)', async () => {
      const config = createApiAuthConfig({ env: envWith(VALID_TOKEN) });
      await expect(config.authenticateToken!(OTHER_TOKEN, fakeRequest)).resolves.toBeNull();
    });

    it('20. FAIL-CLOSED : refuse même le « bon » token si la variable est absente', async () => {
      const config = createApiAuthConfig({ env: envWith() });
      await expect(config.authenticateToken!(VALID_TOKEN, fakeRequest)).resolves.toBeNull();
    });

    it('21. signale une seule fois la mauvaise configuration, sans exposer de secret', async () => {
      const onMisconfigured = vi.fn();
      const config = createApiAuthConfig({ env: envWith(), onMisconfigured });

      await config.authenticateToken!(VALID_TOKEN, fakeRequest);
      await config.authenticateToken!(OTHER_TOKEN, fakeRequest);

      expect(onMisconfigured).toHaveBeenCalledTimes(1);
      const message = onMisconfigured.mock.calls[0]?.[0] as string;
      expect(message).toContain(API_TOKEN_ENV_VAR);
      expect(message).not.toContain(VALID_TOKEN);
    });

    it('22. ne signale rien quand la configuration est correcte', async () => {
      const onMisconfigured = vi.fn();
      const config = createApiAuthConfig({ env: envWith(VALID_TOKEN), onMisconfigured });
      await config.authenticateToken!(VALID_TOKEN, fakeRequest);
      expect(onMisconfigured).not.toHaveBeenCalled();
    });

    it('23. relit l’environnement à chaque requête (rotation du secret sans reboot)', async () => {
      const env = envWith(VALID_TOKEN);
      const config = createApiAuthConfig({ env });

      await expect(config.authenticateToken!(VALID_TOKEN, fakeRequest)).resolves.toEqual(
        API_SERVICE_USER,
      );

      env[API_TOKEN_ENV_VAR] = OTHER_TOKEN;

      await expect(config.authenticateToken!(VALID_TOKEN, fakeRequest)).resolves.toBeNull();
      await expect(config.authenticateToken!(OTHER_TOKEN, fakeRequest)).resolves.toEqual(
        API_SERVICE_USER,
      );
    });
  });
});
