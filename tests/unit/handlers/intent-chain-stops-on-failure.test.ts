import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mastra } from '@mastra/core';

import { type SlackMessageEvent } from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { makeSlackHandler } from '../../helpers/slack-handler';
import { SLACK_STEP_BLOCKED_KEY } from '../../../src/shared/slack-request-context';
import { CHAIN_STOPPED_NOTICE } from '../../../src/features/notification/domain/services/intent-chain';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * UNE CHAÎNE NE CONTINUE PAS SUR UNE ÉTAPE QUI N'A RIEN PU FAIRE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Verdict du propriétaire, 2026-08-25, sur la première version de l'enchaînement :
 * *« pourquoi maintient-il le rappel si le résumé n'a pas été fait ? Ça ne sert à rien. »*
 *
 * Il avait raison, et la trace de production le montre en deux messages :
 *
 *   1. « Je ne peux pas résumer le canal kisso-hq. »
 *   2. « Rappel programmé pour jeudi 27 août 2026 au matin. »
 *
 * Un rappel « de relire le compte rendu » posé alors qu'aucun compte rendu n'existe est du
 * bruit qui arrivera jeudi matin. Pire : l'ensemble se lit comme un bot qui n'écoute pas.
 *
 * ⚠️ **CELA NE CASSE PAS LE THÉORÈME D'INDÉPENDANCE, ET LA RAISON EST PRÉCISE.** L'invariant
 * est qu'*aucun CONTENU ne circule entre les étapes* — c'est lui qui rend l'enchaînement sûr
 * (`intent-chain-execution.test.ts`). Or une ISSUE n'est pas un contenu :
 *
 *   - elle vaut UN BIT, produit par le harness et jamais par le modèle ;
 *   - elle ne porte aucun texte, donc rien qu'un attaquant contrôle ;
 *   - et elle ne peut que RETIRER du travail, jamais en déclencher.
 *
 * Un canal qui ne transporte pas de donnée et qui ne sait que s'arrêter n'exfiltre rien.
 *
 * ⚠️ **C'EST AUSSI LE FILET DE RATTRAPAGE DU DÉTECTEUR D'ANAPHORE.** `refersToPreviousStep`
 * reconnaît « ça », « ce résumé », « envoie-le-moi » — il ne reconnaît PAS « de relire le compte
 * rendu », qui renvoie pourtant bel et bien à l'étape 1. Aucune liste de tournures ne sera
 * complète. S'arrêter sur échec couvre exactement les cas où la dépendance était réelle et non
 * détectée, sans rien avoir à énumérer.
 *
 * ⚠️ **ET ON LE DIT.** Le silence sur la seconde demande est le défaut d'origine ; l'exécuter
 * dans le vide en est un autre. La troisième voie — s'arrêter ET l'annoncer — coûte ZÉRO token
 * et laisse la main à la personne.
 */

const HUMAN = 'U0BJBDGTJUD';
const CHANNEL_TOKEN = '<#CMLKC4S5T|kisso-hq>';
const CHAIN = `résume ${CHANNEL_TOKEN} et rappelle-moi jeudi de relire le compte rendu`;

const dm = (text: string): SlackMessageEvent => ({
  type: 'message',
  user: HUMAN,
  text,
  channel: 'D0MOCKDM01',
  channel_type: 'im',
  ts: '1700000000.001300',
});

/** `blockFirst` simule un outil qui a refusé : il pose la marque que `refuse()` pose en vrai. */
function makeHandler(options: { blockFirst: boolean }) {
  let turn = 0;

  const generate = vi.fn(async (_messages: unknown, opts: { requestContext?: unknown }) => {
    turn += 1;
    if (turn === 1 && options.blockFirst) {
      (opts.requestContext as { set(k: string, v: unknown): void }).set(
        SLACK_STEP_BLOCKED_KEY,
        'not_channel_member',
      );
      return { text: 'Je ne peux pas lire ce canal.', toolCalls: [] };
    }
    return {
      text: turn === 1 ? 'Voici le résumé.' : 'Rappel programmé pour jeudi.',
      toolCalls: [],
    };
  });

  const getAgent = vi.fn(() => ({ generate }));
  const made = makeSlackHandler({ mastra: { getAgent } as unknown as Mastra });

  return { handler: made.handler, generate, getAgent, slack: made };
}

const agentsCalled = (getAgent: { mock: { calls: unknown[][] } }): string[] =>
  getAgent.mock.calls.map((call) => String(call[0]));

const allText = (slack: { updatedTexts(): string[]; postedTexts(): string[] }): string =>
  [...slack.updatedTexts(), ...slack.postedTexts()].join('\n');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('l’étape 1 a échoué — on n’enchaîne pas', () => {
  it('le SECOND agent n’est jamais appelé', async () => {
    const { handler, getAgent } = makeHandler({ blockFirst: true });

    await handler.handleMessage(dm(CHAIN));

    expect(agentsCalled(getAgent)).toEqual(['knowledgeAgent']);
  });

  it('la réponse honnête de l’étape 1 est publiée — on ne l’avale pas', async () => {
    const { handler, slack } = makeHandler({ blockFirst: true });

    await handler.handleMessage(dm(CHAIN));

    expect(allText(slack)).toContain('Je ne peux pas lire ce canal.');
  });

  it('et l’arrêt est DIT — jamais un silence sur la seconde demande', async () => {
    const { handler, slack } = makeHandler({ blockFirst: true });

    await handler.handleMessage(dm(CHAIN));

    expect(allText(slack)).toContain(CHAIN_STOPPED_NOTICE);
  });

  it('aucun rappel n’est annoncé', async () => {
    const { handler, slack } = makeHandler({ blockFirst: true });

    await handler.handleMessage(dm(CHAIN));

    expect(allText(slack)).not.toContain('Rappel programmé');
  });
});

describe('l’étape 1 a réussi — rien ne change', () => {
  it('les deux agents tournent et les deux réponses sortent', async () => {
    const { handler, getAgent, slack } = makeHandler({ blockFirst: false });

    await handler.handleMessage(dm(CHAIN));

    expect(agentsCalled(getAgent)).toEqual(['knowledgeAgent', 'notificationAgent']);
    expect(allText(slack)).toContain('Voici le résumé.');
    expect(allText(slack)).toContain('Rappel programmé pour jeudi.');
  });

  it('et l’arrêt n’est PAS annoncé', async () => {
    // La moitié qui protège de l'excès de zèle : une chaîne qui va au bout ne se commente pas.
    const { handler, slack } = makeHandler({ blockFirst: false });

    await handler.handleMessage(dm(CHAIN));

    expect(allText(slack)).not.toContain(CHAIN_STOPPED_NOTICE);
  });
});

describe('un message SIMPLE ne peut pas être « arrêté »', () => {
  it('un refus d’outil hors chaîne ne poste aucune note d’arrêt', async () => {
    // ⚠️ La marque est posée par tout refus de `getChannelHistory`, chaîne ou pas. Sans cette
    // garde, un simple « résume #kisso-hq » qui échoue recevrait une phrase parlant d'une
    // « suite » qui n'a jamais existé.
    const { handler, slack } = makeHandler({ blockFirst: true });

    await handler.handleMessage(dm(`résume ${CHANNEL_TOKEN}`));

    expect(allText(slack)).toContain('Je ne peux pas lire ce canal.');
    expect(allText(slack)).not.toContain(CHAIN_STOPPED_NOTICE);
  });
});
