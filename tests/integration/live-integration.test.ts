import { describe, it, expect } from 'vitest';

// Ce test vérifie l'API Mastra réellement déployée.
// Base URL configurable : LIVE_TEST_BASE_URL (ex. http://localhost:4111 pour
// `mastra dev`), avec le déploiement Vercel de prod comme valeur par défaut.
const BASE_URL = process.env.LIVE_TEST_BASE_URL ?? 'https://mastra-71ya.vercel.app';

// Depuis l'ajout de `server.auth` (src/shared/security/api-auth.ts), TOUTES les
// routes `/api/*` exigent un bearer token. Sans lui : 401. Le token doit être
// celui du déploiement ciblé par BASE_URL.
const API_TOKEN = process.env.MASTRA_API_TOKEN ?? '';

const authHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...extra,
  ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
});

describe('Live Integration Tests - Mastra deployment', () => {
  it('should have MASTRA_API_TOKEN configured (les routes /api/* sont fail-closed)', () => {
    expect(
      API_TOKEN,
      'MASTRA_API_TOKEN manquant : les appels /api/* renverront 401. ' +
        'Renseigner la variable dans .env avec le token du déploiement visé.',
    ).not.toBe('');
  });

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

  const testEmail = 'karylsoumaila1@gmail.com';
  const managerEmail = 'ridwanenico77@gmail.com';
  const channelId = 'C0BJGBVB5HP';

  it('should expose the deployment and list its agents', async () => {
    const response = await fetch(`${BASE_URL}/api/agents`, { headers: authHeaders() });
    expect(response.status).toBe(200);

    const agents = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(agents)).toContain('onboardingOrchestrator');
  }, 30000);

  it('should successfully ping the API and create an employee', async () => {
    console.log(`Starting live test for employee creation with email: ${testEmail}`);

    // Route générée par Mastra pour un agent : POST /api/agents/:agentId/generate
    const response = await fetch(`${BASE_URL}/api/agents/onboardingOrchestrator/generate`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        messages: [
          `Je suis le service RH. Crée un nouvel employé avec les infos suivantes:
           Prénom: Jane
           Nom: Doe
           Email: ${testEmail}
           Département: Engineering
           Poste: Backend Developer
           Manager Email: ${managerEmail}
           Slack Channel: ${channelId}
           Date de début: 2026-09-01`,
        ],
      }),
    });

    if (response.status !== 200) {
      console.error('API Error:', await response.text());
    }
    // Le statut HTTP doit être 200
    expect(response.status).toBe(200);

    const data = (await response.json()) as { text?: string };
    console.log('Orchestrator Response:', JSON.stringify(data, null, 2));

    // L'agent doit répondre avec un texte confirmant la création
    expect(data).toBeDefined();
    expect(data.text).toBeDefined();

    // On vérifie que la réponse indique un succès (mot clé)
    const responseText = (data.text ?? '').toLowerCase();
    expect(responseText).toMatch(/(succès|créé|created|successfully|ajouté)/);
  }, 60000); // L'agent LLM + DB peut prendre du temps
});
