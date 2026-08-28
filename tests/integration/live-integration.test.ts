import { describe, it, expect } from 'vitest';

// Ce test vérifie l'API Mastra réellement déployée.
// Base URL configurable : LIVE_TEST_BASE_URL (ex. http://localhost:4111 pour
// `mastra dev`), avec le déploiement Vercel de prod comme valeur par défaut.
const BASE_URL = process.env.LIVE_TEST_BASE_URL ?? 'https://mastra-71ya.vercel.app';

// Depuis l'ajout de `server.auth` (src/shared/security/api-auth.ts), TOUTES les
// routes `/api/*` exigent un bearer token. Sans lui : 401. Le token doit être
// celui du déploiement ciblé par BASE_URL.
const API_TOKEN = process.env.MASTRA_API_TOKEN ?? '';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * CE FICHIER ÉCRIVAIT EN PRODUCTION — audit du 2026-08-28, § 4.3
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Il postait « Crée un nouvel employé — Prénom: Jane, Nom: Doe » sur
 * `POST /api/agents/onboardingOrchestrator/generate` du déploiement de PRODUCTION. Le
 * `globalSetup` crée pourtant une base SQLite jetable — elle ne protégeait pas ce fichier, qui
 * sort par HTTP. Chaque exécution coûtait une vraie ligne `employees` sur la Turso de production
 * ET un appel de modèle sur les ~20 de la journée.
 *
 * ⚠️ Le mode de panne n'est pas l'écriture : c'est qu'AUCUNE mesure faite ensuite en production
 * n'est fiable. Un audit qui compte les dossiers pendant que la suite en crée est un audit qui
 * mesure ses propres traces.
 *
 * **Ce qui reste est en LECTURE SEULE.** Les appels authentifiés — même en lecture — exigent
 * `LIVE_SMOKE=1` : lancer `npm run test:integration` ne doit jamais présenter un jeton de
 * service à un déploiement sans qu'on l'ait demandé. Les contrôles de refus (401), eux, tournent
 * toujours : ils n'envoient aucune donnée et vérifient une frontière.
 */
const LIVE_SMOKE = process.env.LIVE_SMOKE === '1';
const authenticated = LIVE_SMOKE ? it : it.skip;

const authHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...extra,
  ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
});

describe('Live Integration Tests - Mastra deployment', () => {
  authenticated(
    'should have MASTRA_API_TOKEN configured (les routes /api/* sont fail-closed)',
    () => {
      expect(
        API_TOKEN,
        'MASTRA_API_TOKEN manquant : les appels /api/* renverront 401. ' +
          'Renseigner la variable dans .env avec le token du déploiement visé.',
      ).not.toBe('');
    },
  );

  it('should reject unauthenticated calls to /api/agents with 401', async () => {
    const response = await fetch(`${BASE_URL}/api/agents`);
    expect(response.status).toBe(401);
  }, 30000);

  it('should reject a wrong bearer token with 401', async () => {
    const response = await fetch(`${BASE_URL}/api/agents`, {
      headers: { Authorization: `Bearer ${'0'.repeat(64)}` },
    });
    expect(response.status).toBe(401);
  }, 30000);

  authenticated(
    'should expose the deployment and list its agents',
    async () => {
      const response = await fetch(`${BASE_URL}/api/agents`, { headers: authHeaders() });
      expect(response.status).toBe(200);

      const agents = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(agents)).toContain('onboardingOrchestrator');
    },
    30000,
  );

  it('refuse un `generate` NON authentifié — le chemin qui écrivait ici', async () => {
    // Ce qui reste de l'ancien test, retourné : au lieu de DEMANDER une création d'employé, on
    // vérifie que la route par laquelle elle passait est fermée sans jeton. C'est la surface
    // que l'audit du 2026-08-28 a mesurée exploitable AVEC un jeton (§ 1.1) — le second verrou
    // appartient au bord de l'outil, et cette assertion ne prétend pas le remplacer.
    const response = await fetch(`${BASE_URL}/api/agents/onboardingOrchestrator/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: ['ping'] }),
    });

    expect(response.status).toBe(401);
  }, 30000);
});
