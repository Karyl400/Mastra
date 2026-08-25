import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mastra } from '@mastra/core';

import {
  type SlackEventsHandlerOptions,
  type SlackMessageEvent,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { makeSlackHandler } from '../../helpers/slack-handler';
import { AUDIT_ACTIONS } from '../../../src/shared/audit-actions';
import { isActingTool } from '../../../src/shared/agent-capabilities';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LES APPELS D'OUTILS N'ÉTAIENT PERSISTÉS NULLE PART
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Dette n° 1 de `docs/tool-design-audit.md`, et elle avait une forme particulière : ce n'est
 * pas qu'on ne savait pas mesurer, c'est qu'on mesurait **puis on jetait**.
 *
 * `readToolCallNames` lisait les outils appelés, `durationMs` était chronométré, la
 * réconciliation FAIT/NARRATION rendait son verdict — et les trois partaient dans
 * `logger.info`. Les logs Vercel sont propres à chaque déploiement et **repartent à zéro après
 * un redéploiement**, ce que ce dépôt documente lui-même comme méthode de diagnostic.
 *
 * Conséquence mesurable : sur un dépôt qui tire TOUTES ses décisions de mesures, aucune mesure
 * durable n'existait sur ses propres outils. Quel outil échoue le plus ? Combien de
 * `ambiguous` sur `findPersonByName` ? Un enchaînement raté est-il reconstructible ? Aucune
 * réponse au-delà de quelques jours.
 *
 * ⚠️ **CE N'EST PAS UNE MISE À JOUR DE LA LIGNE `SLACK_MESSAGE`.** `audit-status-honesty.test.ts`
 * verrouille le fait qu'on n'écrit jamais un sort qu'on ne connaît pas encore, et cette règle
 * tient : `SLACK_MESSAGE` dit « accepté pour traitement » au moment où c'est vrai. `AGENT_RUN`
 * est une SECONDE ligne, écrite à la conclusion, qui dit ce qui s'est réellement passé.
 *
 * ⚠️ L'argument de coût qui figurait dans ce dépôt — « une E/S de plus sur le chemin des
 * 3 secondes, pour un journal que personne ne lit » — ne s'applique pas ici, et ses deux
 * moitiés sont fausses depuis le 2026-08-25 : l'écriture vit dans le travail de FOND, bien
 * après l'ACK, et elle est `void`ée ; et le journal est désormais lu — `/dashboard` en dérive
 * la latence, les réponses requalifiées et l'usage des outils.
 *
 * ⚠️ **AUCUN CONTENU DE MESSAGE N'ENTRE DANS `details`** — noms d'outils, durée, étapes,
 * tokens, verdicts. La même règle que le flux du tableau de bord.
 */

const HUMAN = 'U0BJBDGTJUD';

type AuditEntry = {
  action: string;
  status?: string;
  resourceId?: string;
  errorMessage?: string;
  details?: Record<string, unknown>;
};

function makeHandler(response: { text: string; toolCalls?: unknown } | Error) {
  const audit = vi.fn(async (_entry: AuditEntry) => undefined);

  const getAgent =
    response instanceof Error
      ? vi.fn(() => {
          throw response;
        })
      : vi.fn().mockReturnValue({ generate: vi.fn().mockResolvedValue(response) });

  const { handler } = makeSlackHandler({
    mastra: { getAgent } as unknown as Mastra,
    auditSink: audit as unknown as SlackEventsHandlerOptions['auditSink'],
  });

  return { handler, audit };
}

const dm = (text: string): SlackMessageEvent => ({
  type: 'message',
  user: HUMAN,
  text,
  channel: 'D0MOCKDM01',
  channel_type: 'im',
  ts: '1700000000.000900',
});

const runEntry = (audit: { mock: { calls: unknown[][] } }): AuditEntry | undefined =>
  audit.mock.calls
    .map((call) => call[0] as AuditEntry)
    .find((entry) => entry.action === AUDIT_ACTIONS.agentRun);

const ASK = 'retrouve l’employé dont l’email est karyl@kisso.com';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AGENT_RUN — la trace d’exécution est persistée', () => {
  it('enregistre les outils appelés, la durée et les étapes', async () => {
    const { handler, audit } = makeHandler({
      text: 'Voici ce que j’ai trouvé.',
      toolCalls: [
        { type: 'tool-call', payload: { toolName: 'findEmployeeByEmail' } },
        { type: 'tool-call', payload: { toolName: 'generateDocument' } },
      ],
    });

    await handler.handleMessage(dm(ASK));

    const entry = runEntry(audit);
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('success');
    expect(entry?.resourceId).toBe('onboardingOrchestrator');
    expect(entry?.details?.toolCalls).toEqual(['findEmployeeByEmail', 'generateDocument']);
    expect(typeof entry?.details?.durationMs).toBe('number');
  });

  it('sépare les outils AGISSANTS des lectures — la partition est dérivée de TOOL_EFFECTS', async () => {
    // Ce champ est ce qui rend le journal exploitable : « combien de messages ont réellement
    // AGI » n'est pas « combien d'outils ont tourné ». La liste attendue est calculée depuis
    // `TOOL_EFFECTS`, jamais recopiée — c'est la dette n° 5 du même audit.
    const called = ['findEmployeeByEmail', 'getEmployeeProfile', 'generateDocument'];
    const { handler, audit } = makeHandler({
      text: 'Voici le document.',
      toolCalls: called.map((toolName) => ({ type: 'tool-call', payload: { toolName } })),
    });

    await handler.handleMessage(dm(ASK));

    const entry = runEntry(audit);
    expect(entry?.details?.toolCalls).toEqual(called);
    expect(entry?.details?.actedOn).toEqual(called.filter((name) => isActingTool(name)));
    expect(entry?.details?.actedOn).toEqual(['generateDocument']);
  });

  it('marque `failure` quand la réconciliation a requalifié la réponse', async () => {
    // Le seul détecteur d'incohérence du produit devient enfin COMPTABLE. Sans cela, le
    // tableau de bord ne pouvait qu'afficher « mesuré à l'exécution, écrit nulle part ».
    const { handler, audit } = makeHandler({
      text: 'C’est fait, je t’ai envoyé le guide.',
      toolCalls: [],
    });

    await handler.handleMessage(dm(ASK));

    const entry = runEntry(audit);
    expect(entry?.status).toBe('failure');
    expect(entry?.details?.unsupportedClaim).toBeTruthy();
  });

  it('enregistre aussi le run dont l’AGENT n’a pas pu être résolu', async () => {
    // ⚠️ Trou trouvé en écrivant ce test. `tryGetAgent` AVALE la levée de `mastra.getAgent` et
    // rend `null` ; le handler poste alors une excuse et sort par un `return` PRÉCOCE, avant le
    // `catch`. Ce chemin — celui d'un registre cassé, donc d'un bot muet pour tout le monde —
    // ne laissait absolument aucune trace persistée. C'est exactement la panne qu'on voudrait
    // retrouver le lendemain.
    const { handler, audit } = makeHandler(new Error('modèle indisponible'));

    await handler.handleMessage(dm(ASK));

    const entry = runEntry(audit);
    expect(entry?.status).toBe('failure');
    expect(entry?.errorMessage).toBe('agent_unresolved');
    expect(entry?.details?.phase).toBe('resolve-agent');
  });

  it('n’écrit AUCUN contenu de message dans le journal', async () => {
    const secret = 'mon numéro de sécurité sociale est 1234567890123';
    const { handler, audit } = makeHandler({ text: 'Bien noté.', toolCalls: [] });

    await handler.handleMessage(dm(secret));

    const serialized = JSON.stringify(audit.mock.calls);
    expect(serialized).not.toContain('sécurité sociale');
    expect(serialized).not.toContain('Bien noté');
  });
});
