/**
 * Authentification des routes HTTP intégrées de Mastra (`/api/*`).
 *
 * ## Le trou qu'on bouche
 *
 * `new Mastra({ server: { apiRoutes: [...] } })` sans clé `auth` laisse **toutes** les
 * routes générées par le framework ouvertes sur Internet. Vérifié dans la source :
 *
 *  - `@mastra/server/dist/server/server-adapter/index.js` → `getEffectiveAuthConfig()`
 *    renvoie `null` quand ni `studio.auth` ni `server.auth` ne sont définis ;
 *  - `checkRouteAuth()` commence par `if (!effectiveAuth) return null;` → aucune route
 *    n'est jamais contrôlée.
 *
 * Concrètement : `POST /api/agents/onboardingOrchestrator/generate` répondait 200 à
 * n'importe qui, ce qui donne le contrôle des agents (envoi d'email depuis la vraie
 * boîte de l'organisation, création d'employés, génération de documents, publication
 * Slack). La signature HMAC de `/slack/events` ne protège rien puisqu'il suffit de
 * passer par les routes `/api/*`.
 *
 * ## Ce que fait cette config
 *
 * Un `MastraAuthConfig` (`@mastra/core/server`) minimal : un unique bearer token partagé,
 * comparé en temps constant. `authenticateToken` renvoie `null` → le middleware du
 * framework répond `401 {"error":"Invalid or expired token"}`.
 *
 * Portée : `defaultAuthConfig` de `@mastra/server` protège `['/api/*']` et laisse publics
 * `['/api', '/api/auth/*']`. On n'ajoute donc **rien** dans `protected` / `public` :
 * le défaut couvre exactement les routes intégrées.
 *
 * `/slack/events` reste joignable par Slack : la route est déclarée avec
 * `requiresAuth: false` (`src/api/slack-events.route.ts`) et `checkRouteAuth()` fait
 * `if (route.requiresAuth === false) return null;` **avant** toute vérification de token.
 * Le même verdict est atteint par le second chemin (`coreAuthMiddleware` →
 * `isProtectedPath()` → `isProtectedCustomRoute()`), qui lit la map
 * `customRouteAuthConfig` construite dans `createHonoServer` à partir de
 * `route.requiresAuth !== false`. Sa protection reste sa signature HMAC Slack
 * (`src/shared/security/slack-signature.ts`).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { MastraAuthConfig } from '@mastra/core/server';

/** Nom de la variable d'environnement portant le secret partagé. */
export const API_TOKEN_ENV_VAR = 'MASTRA_API_TOKEN';

/**
 * Longueur minimale acceptée pour le secret.
 * 32 caractères ≈ 128 bits si le token est hexadécimal ; la valeur générée en fait 64.
 * En dessous, on considère la configuration comme absente plutôt que faible.
 */
export const MIN_API_TOKEN_LENGTH = 32;

/** Utilisateur renvoyé par `authenticateToken` quand le token est valide. */
export interface ApiServiceUser {
  readonly id: string;
  readonly type: 'service';
}

/** Identité unique associée au token partagé (pas de multi-tenant ici). */
export const API_SERVICE_USER: ApiServiceUser = Object.freeze({
  id: 'service-account',
  type: 'service',
});

/**
 * Comparaison à temps constant, insensible à la longueur.
 *
 * `timingSafeEqual` exige deux buffers de même taille et *throw* sinon. Comparer les
 * longueurs d'abord fuiterait la longueur du secret. On hache donc les deux valeurs en
 * SHA-256 : les digests font toujours 32 octets, la comparaison est donc toujours
 * possible et son coût ne dépend d'aucun secret.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/** Retire un éventuel préfixe `Bearer ` et les espaces autour. */
function normalizeToken(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/^Bearer\s+/i, '').trim();
}

/**
 * Lit et valide le secret configuré. Renvoie `null` si absent ou trop court.
 * N'expose jamais la valeur — les appelants ne doivent logger que sa présence.
 */
export function readConfiguredApiToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[API_TOKEN_ENV_VAR];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < MIN_API_TOKEN_LENGTH) return null;
  return trimmed;
}

export interface VerifyApiTokenOptions {
  /** Secret attendu (`null` = non configuré). */
  expectedToken: string | null;
  /** Token présenté par l'appelant, avec ou sans préfixe `Bearer `. */
  presentedToken: string | null | undefined;
}

/**
 * Cœur de la vérification, pur et testable sans serveur HTTP.
 *
 * ## Fail-closed sur secret absent — décision assumée
 *
 * Si `MASTRA_API_TOKEN` n'est pas défini, cette fonction renvoie `false` pour **toute**
 * requête : les routes `/api/*` répondent 401 en bloc.
 *
 * L'arbitrage :
 *  - *fail-open* (laisser passer quand le secret manque) recrée à l'identique la faille
 *    qu'on corrige, et la recrée silencieusement — une variable oubliée sur un nouvel
 *    environnement rouvre l'API au monde entier sans le moindre signal. Inacceptable ;
 *  - *fail-closed* peut rendre le déploiement inutilisable si la variable manque. C'est
 *    le coût accepté : une panne visible et réparable en une commande
 *    (`vercel env add MASTRA_API_TOKEN production`) vaut mieux qu'une brèche invisible.
 *
 * Le rayon d'explosion est volontairement borné : on refuse **à la requête**, on ne
 * *throw* pas au démarrage. Un throw au boot ferait échouer l'instanciation de Mastra
 * entière — donc aussi `/slack/events`, qui n'a pas besoin de ce secret et possède déjà
 * sa propre authentification (HMAC). Refuser requête par requête garde le webhook Slack
 * opérationnel, laisse `/api` (public par défaut) répondre, et rend le diagnostic
 * immédiat : un 401 uniforme + un log d'erreur explicite au premier appel.
 */
export function verifyApiToken({ expectedToken, presentedToken }: VerifyApiTokenOptions): boolean {
  if (expectedToken === null || expectedToken.length < MIN_API_TOKEN_LENGTH) {
    return false;
  }

  const presented = normalizeToken(presentedToken);
  if (presented.length === 0) {
    return false;
  }

  return constantTimeEquals(presented, expectedToken);
}

export interface CreateApiAuthConfigOptions {
  /** Environnement à lire (injectable pour les tests). */
  env?: NodeJS.ProcessEnv;
  /** Journalisation de l'absence de secret. Ne reçoit jamais la valeur du token. */
  onMisconfigured?: (message: string) => void;
}

/**
 * Construit le `MastraAuthConfig` à passer dans `server.auth` de `src/mastra/index.ts`.
 *
 * Le secret est relu à **chaque** requête (et non capturé à la construction) pour que le
 * runtime serverless de Vercel, qui injecte l'environnement au démarrage de l'instance,
 * n'ait pas besoin d'un redéploiement du module pour prendre en compte une rotation.
 */
export function createApiAuthConfig(
  options: CreateApiAuthConfigOptions = {}
): MastraAuthConfig<ApiServiceUser> {
  const { env = process.env, onMisconfigured } = options;

  // Un seul avertissement par instance : inutile de noyer les logs à chaque 401.
  let warned = false;
  const warnOnce = () => {
    if (warned) return;
    warned = true;
    onMisconfigured?.(
      `${API_TOKEN_ENV_VAR} absent ou trop court (< ${MIN_API_TOKEN_LENGTH} caractères) : ` +
        'toutes les routes /api/* répondent 401 (fail-closed). ' +
        'Définir la variable dans .env et sur Vercel pour rétablir le service.'
    );
  };

  return {
    // `protected` / `public` sont laissés au défaut de @mastra/server
    // (protected: ['/api/*'], public: ['/api', '/api/auth/*']).
    authenticateToken: async (token, _request) => {
      const expectedToken = readConfiguredApiToken(env);
      if (expectedToken === null) {
        warnOnce();
      }

      if (!verifyApiToken({ expectedToken, presentedToken: token })) {
        // `null` → le middleware Mastra répond 401 « Invalid or expired token ».
        // Le cast est nécessaire : la signature du framework déclare `Promise<TUser>`
        // alors que son implémentation traite explicitement `null` comme un échec
        // (`if (!user) return { status: 401, ... }`).
        return null as unknown as ApiServiceUser;
      }

      return API_SERVICE_USER;
    },
  };
}
