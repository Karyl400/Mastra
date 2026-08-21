/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE JETON DE SERVICE CONTOURNAIT LA FRONTIÈRE PAR VACANCE, PAS PAR USURPATION
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le 2026-08-14, ce dépôt a fermé une brèche réelle : `body.requestContext` permettait à un
 * porteur de `MASTRA_API_TOKEN` de **se déclarer n'importe qui**, donc de lire le dossier RH de
 * tout le monde. `createRequestContextGuard` refuse désormais toute clé `slack*` venue du corps.
 *
 * L'audit du 2026-08-21 a trouvé la moitié restée ouverte, et elle est **strictement plus
 * puissante** :
 *
 *     function mayTouchRecord(requestContext, targetEmployeeId) {
 *       const context = readSlackContext(requestContext);
 *       if (!context) return true;          // ← pas de contexte Slack ⇒ AUTORISÉ
 *
 * S'usurper exige de connaître les clés. **Ne rien déclarer n'exige rien.** Or Mastra expose
 * `POST /api/tools/:toolId/execute` et `POST /api/agents/:id/tools/:toolId/execute` ; le jeton
 * les ouvre toutes (aucun `server.rbac` n'est déclaré), le contexte est alors vide, et
 * `getEmployeeProfile`, `generateDocument`, `sendNotification`, `scheduleReminder`,
 * `updateOnboardingStatus` s'exécutent sur l'identifiant de n'importe qui.
 *
 * ⚠️ **POURQUOI ON FERME LA ROUTE ET NON LE FAIL-OPEN.** Ce `return true` n'est pas un oubli :
 * c'est le cas NORMAL du playground, d'un workflow et d'un test — `readSlackContext` rend
 * `undefined` hors Slack par conception, et « au tool de dégrader » est une décision écrite.
 * Le renverser ferait refuser des chemins internes légitimes, et le symptôme serait un produit
 * qui ne sait plus rien faire — la panne exacte que le garde d'autorisation évite déjà en
 * refusant de s'appliquer tant qu'aucun manager n'est désigné.
 *
 * Ce qu'il faut retirer, c'est la SURFACE : l'exécution d'un outil par HTTP n'a **aucun
 * consommateur** dans ce dépôt (vérifié — zéro occurrence dans `src/`, `scripts/`, `tests/`).
 * Une capacité sans usage qui vaut l'usurpation totale n'est pas une capacité, c'est une dette.
 *
 * ⚠️ **La frontière ne dépend pas de ce garde**, et c'est ce qui la rend sûre : si quelqu'un le
 * retire un jour, on retombe sur l'état d'aujourd'hui, pas plus bas. Il ferme une porte, il ne
 * porte pas la serrure.
 */
import { describe, it, expect } from 'vitest';

import {
  createToolExecutionGuard,
  isToolExecutionPath,
} from '../../../src/shared/security/tool-execution-guard';

describe('isToolExecutionPath', () => {
  it('reconnaît les deux formes exposées par Mastra', () => {
    expect(isToolExecutionPath('/api/tools/generateDocument/execute')).toBe(true);
    expect(
      isToolExecutionPath('/api/agents/onboardingOrchestrator/tools/sendNotification/execute'),
    ).toBe(true);
  });

  it("laisse passer tout le reste de l'API", () => {
    // ⚠️ Anti-faux-positif. Un garde trop large casserait le playground et les routes de
    // workflow, qui n'exécutent pas d'outil isolé et n'ont jamais été le problème.
    expect(isToolExecutionPath('/api/agents')).toBe(false);
    expect(isToolExecutionPath('/api/agents/knowledgeAgent')).toBe(false);
    expect(isToolExecutionPath('/api/agents/knowledgeAgent/generate')).toBe(false);
    expect(isToolExecutionPath('/api/agents/knowledgeAgent/stream')).toBe(false);
    expect(isToolExecutionPath('/api/workflows/employeeOnboardingWorkflow/start')).toBe(false);
    expect(isToolExecutionPath('/api/tools')).toBe(false);
    expect(isToolExecutionPath('/slack/events')).toBe(false);
  });

  it('ignore la casse et la chaîne de requête', () => {
    expect(isToolExecutionPath('/api/tools/getEmployeeProfile/execute?debug=1')).toBe(true);
  });

  it("n'est pas contournable par un slash de fin ni par un double slash", () => {
    // Le chemin vient d'une URL contrôlée par l'appelant : tout ce qui NORMALISE côté serveur
    // sans être vu par le garde est un contournement.
    expect(isToolExecutionPath('/api/tools/generateDocument/execute/')).toBe(true);
    expect(isToolExecutionPath('//api/tools/generateDocument/execute')).toBe(true);
  });
});

describe('createToolExecutionGuard', () => {
  function ctx(path: string) {
    return { req: { path, raw: new Request(`https://x.test${path}`, { method: 'POST' }) } };
  }

  it("refuse l'exécution d'un outil par HTTP, en 403", async () => {
    let refused: string | undefined;
    const guard = createToolExecutionGuard({ onReject: (p) => (refused = p) });

    const response = (await guard(ctx('/api/tools/getEmployeeProfile/execute'), async () => {
      throw new Error('next() ne doit pas être appelé');
    })) as Response;

    expect(response.status).toBe(403);
    expect(refused).toBe('/api/tools/getEmployeeProfile/execute');

    const body = (await response.json()) as { error: string };
    // Le refus dit QUOI faire, pas comment le contourner — même contrat que NEUTRAL_REFUSAL.
    expect(body.error).toMatch(/Slack/i);
  });

  it('laisse passer une route normale', async () => {
    let passed = false;
    const guard = createToolExecutionGuard({});

    const response = await guard(ctx('/api/agents/knowledgeAgent/generate'), async () => {
      passed = true;
    });

    expect(passed).toBe(true);
    expect(response).toBeUndefined();
  });
});
