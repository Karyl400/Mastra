import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mastra } from '@mastra/core';

import { type SlackMessageEvent } from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { makeSlackHandler } from '../../helpers/slack-handler';
import { SLACK_LOAN_DELIVERED_KEY } from '../../../src/shared/slack-request-context';
import { UNSUPPORTED_CLAIM_NOTICE } from '../../../src/features/notification/domain/services/claim-reconciliation';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * UN PRÊT QUI A LIVRÉ EST UN ACTE — sinon le garde-fou dément une VÉRITÉ
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le prêt `channelDigest` s'exécute à l'intérieur de `getChannelHistory`, qui est classé
 * `read` dans `TOOL_EFFECTS` — et à raison : c'est un outil de lecture.
 *
 * Mais quand `asDocument: true` a réellement déposé un fichier dans le fil, l'agent qui écrit
 * « voilà, le résumé est en PDF juste au-dessus » dit la VÉRITÉ. La réconciliation
 * FAIT/NARRATION, elle, ne verrait qu'un appel de lecture et accolerait son démenti :
 * *« Je me relis : aucun outil n'a tourné… »*
 *
 * ⚠️ **LE PIRE USAGE D'UN GARDE-FOU EST DE DÉMENTIR CE QUI EST VRAI.** Ce dépôt l'a déjà écrit
 * à propos d'un scénario de campagne qui interdisait « le questionnaire a été généré » alors que
 * Marcel avait produit un vrai PDF. Sans ce correctif, la feature serait cassée par le garde-fou
 * censé la protéger — exactement comme la DIRECTIVE 6.1 prescrivant une sortie que le filtre de
 * sortie censurait.
 *
 * ⚠️ **On ne reclasse PAS `getChannelHistory` en `write`.** Ce serait faux dans le cas nominal
 * (aucun document demandé), cela ferait taire la réconciliation sur toutes les lectures de
 * canal, et cela ferait rougir la quarantaine de préfixe. Le signal passe par le
 * `requestContext` — le canal qui ne traverse jamais la fenêtre du modèle — et il n'est écrit
 * qu'après une livraison RÉELLEMENT constatée.
 */

const HUMAN = 'U0BJBDGTJUD';

const dm = (text: string): SlackMessageEvent => ({
  type: 'message',
  user: HUMAN,
  text,
  channel: 'D0MOCKDM01',
  channel_type: 'im',
  ts: '1700000000.001100',
});

/**
 * Agent qui simule le prêt : il annonce un accompli, n'appelle qu'une LECTURE, et pose dans le
 * `requestContext` la marque qu'un outil aurait posée après une livraison réussie.
 */
function makeHandler(options: { markDelivered: boolean }) {
  const posted: string[] = [];

  const generate = vi.fn(async (_messages: unknown, opts: { requestContext?: unknown }) => {
    if (options.markDelivered) {
      (opts.requestContext as { set(k: string, v: unknown): void }).set(
        SLACK_LOAN_DELIVERED_KEY,
        'channelDigest',
      );
    }
    return {
      text: 'C’est fait : le résumé est en PDF juste au-dessus.',
      toolCalls: [{ type: 'tool-call', payload: { toolName: 'getChannelHistory' } }],
    };
  });

  const { handler, slack } = makeSlackHandler({
    mastra: { getAgent: vi.fn().mockReturnValue({ generate }) } as unknown as Mastra,
  });

  return { handler, posted, slack };
}

/**
 * ⚠️ La réponse finale part par `chat.update` (le marqueur de progression est REMPLACÉ), pas par
 * `postMessage`. Relever l'un sans l'autre ferait passer ce test au vert sur du vide.
 */
const allPostedText = (slack: {
  chat: {
    postMessage: { mock: { calls: unknown[][] } };
    update: { mock: { calls: unknown[][] } };
  };
}): string =>
  [...slack.chat.postMessage.mock.calls, ...slack.chat.update.mock.calls]
    .flat()
    .map((arg) => (arg as { text?: string })?.text ?? '')
    .join('\n');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('la réconciliation reconnaît un prêt qui a livré', () => {
  it('NE DÉMENT PAS une annonce vraie quand le prêt a déposé le fichier', async () => {
    const { handler, slack } = makeHandler({ markDelivered: true });

    await handler.handleMessage(dm('résume <#C0BMLKC4S5T|kisso-hq> en PDF'));

    expect(allPostedText(slack)).not.toContain(UNSUPPORTED_CLAIM_NOTICE.slice(0, 30));
  });

  it('DÉMENT toujours une annonce non appuyée quand rien n’a été livré', async () => {
    // L'autre moitié, sans laquelle la première ne prouve rien : le garde-fou doit rester armé.
    const { handler, slack } = makeHandler({ markDelivered: false });

    await handler.handleMessage(dm('résume <#C0BMLKC4S5T|kisso-hq> en PDF'));

    expect(allPostedText(slack)).toContain(UNSUPPORTED_CLAIM_NOTICE.slice(0, 30));
  });
});
