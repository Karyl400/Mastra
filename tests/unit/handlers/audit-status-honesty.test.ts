import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mastra } from '@mastra/core';

import {
  type SlackEventsHandlerOptions,
  type SlackMessageEvent,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { makeSlackHandler } from '../../helpers/slack-handler';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * Le journal d'audit disait « success » avant que quoi que ce soit ait eu lieu
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `writeAuditLog` applique `status: entry.status ?? 'success'`, et le site `SLACK_MESSAGE`
 * n'en passait AUCUN. Il est écrit avant `chargeModelBudget`, avant le marqueur de
 * progression, avant l'appel d'agent, avant la publication — et aucun chemin ne met la ligne à
 * jour ensuite. Un message qui a épuisé le budget, levé dans l'agent, ou n'a jamais reçu de
 * réponse était donc enregistré `success`.
 *
 * La colonne est INDEXÉE (`schema.ts`) précisément pour qu'un humain filtre dessus. Et les
 * deux autres sites — `RATE_LIMITED` et `AUTHZ_DENIED` — passent correctement `'denied'`, ce
 * qui rend l'omission lisible comme un oubli plutôt que comme un arbitrage.
 *
 * C'est la même forme que `status = 'Sent'` posé avant le `try`, corrigé le 2026-08-11, et que
 * `emailSent: false` sous `status: 'success'`.
 *
 * ⚠️ ON NE MET PAS LA LIGNE À JOUR APRÈS COUP — on dit la vérité du moment où on écrit. Ce
 * qu'on observe à cet instant, c'est que le message a été ACCEPTÉ pour traitement ; c'est tout,
 * et c'est exact.
 *
 * ⚠️ **La suite de cette phrase a changé le 2026-08-25, et il faut le dire.** Elle affirmait
 * qu'une seconde écriture « coûterait une E/S de plus sur le chemin des 3 secondes, pour un
 * journal que personne ne lit encore ». Les deux moitiés sont tombées : `AGENT_RUN` est écrit
 * dans le travail de FOND, bien après l'ACK, et `void`é ; et le journal est lu — `/dashboard`
 * en dérive la latence, les réponses requalifiées et l'usage des outils.
 *
 * Ce qui reste vrai, et que ce test garde : `AGENT_RUN` est une SECONDE LIGNE, jamais une mise
 * à jour de celle-ci. Voir `agent-run-audit.test.ts`.
 */

const HUMAN = 'U0BJBDGTJUD';

function makeHandler() {
  const audit = vi.fn(async (_entry: { action: string; status?: string }) => undefined);

  // Les HUIT dépendances neutralisables le sont par la fabrique partagée — voir son en-tête,
  // qui porte le détail de ce que chaque oubli coûte. Ne restent ici que les deux pièces dont
  // ce fichier a vraiment besoin : un agent qui ÉCHOUE (c'est exactement le cas où « success »
  // était un mensonge) et le journal d'audit, qu'on observe.
  const { handler } = makeSlackHandler({
    mastra: {
      getAgent: vi.fn(() => {
        throw new Error('modèle indisponible');
      }),
    } as unknown as Mastra,
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
  ts: '1700000000.000200',
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('le journal d’audit ne conclut pas d’avance', () => {
  it('n’enregistre JAMAIS « success » pour un message dont le sort est inconnu', async () => {
    const { handler, audit } = makeHandler();

    await handler.handleMessage(dm('retrouve l’employé dont l’email est karyl@kisso.com'));

    const slackMessage = audit.mock.calls
      .map((call) => call[0] as unknown as { action: string; status?: string })
      .find((entry) => entry.action === 'SLACK_MESSAGE');

    expect(slackMessage).toBeDefined();
    expect(slackMessage?.status).toBe('accepted');
    expect(slackMessage?.status).not.toBe('success');
  });
});
