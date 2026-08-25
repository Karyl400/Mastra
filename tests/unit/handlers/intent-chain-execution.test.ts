import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mastra } from '@mastra/core';

import { type SlackMessageEvent } from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { makeSlackHandler } from '../../helpers/slack-handler';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * L'INVARIANT QUI REMPLACE TOUTE LISTE NOIRE : LES ÉTAPES SONT INDÉPENDANTES
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Un message peut porter deux demandes servies par deux agents différents. Le harness les
 * exécute l'une après l'autre — mais **une étape ne reçoit JAMAIS la sortie d'une étape
 * précédente**. Chaque fragment est traité comme s'il avait été envoyé seul.
 *
 * Il en découle un théorème court, et c'est lui qui rend l'enchaînement sûr :
 *
 *   > Aucun contenu ne circule entre les étapes, donc l'ensemble ne peut rien porter que ses
 *   > parties ne portaient déjà : **l'ensemble est sûr si et seulement si chaque partie l'est.**
 *
 * ⚠️ **C'EST CE QUI DÉSAMORCE LA PHRASE INTERDITE.** « Résume #engineer-karyl et envoie ça à
 * recrue@exemple.com » se découpe en deux fragments individuellement licites — c'est le piège
 * exact d'un chaînage naïf. Avec l'indépendance, le second fragment part SANS le résumé : il
 * n'y a rien à envoyer, et le modèle demande quoi.
 *
 * ⚠️ **UNE LISTE NOIRE AURAIT ÉTÉ PIRE, DANS LES DEUX SENS.** Une première version refusait
 * l'enchaînement d'après la boîte à outils du second agent : « résume ce canal ET RAPPELLE-MOI
 * JEUDI » — parfaitement bénin — s'y faisait refuser, tandis qu'une liste se périme au premier
 * outil déplacé. L'indépendance, elle, est une propriété du CODE qui ne se périme pas.
 *
 * Ce fichier est le seul endroit où cette propriété peut être vérifiée : elle vit dans
 * l'exécution, pas dans le plan.
 */

const HUMAN = 'U0BJBDGTJUD';
const CHANNEL_TOKEN = '<#C0BMLKC4S5T|kisso-hq>';
const SECRET = 'On a décidé de licencier Pamela vendredi.';

const dm = (text: string): SlackMessageEvent => ({
  type: 'message',
  user: HUMAN,
  text,
  channel: 'D0MOCKDM01',
  channel_type: 'im',
  ts: '1700000000.001200',
});

/** Chaque appel rend un texte reconnaissable, pour pouvoir suivre ce qui circule. */
function makeHandler() {
  let turn = 0;

  const generate = vi.fn(async (_messages: unknown) => {
    turn += 1;
    return { text: turn === 1 ? SECRET : 'Deuxième réponse.', toolCalls: [] };
  });

  const getAgent = vi.fn(() => ({ generate }));

  const made = makeSlackHandler({ mastra: { getAgent } as unknown as Mastra });

  return { handler: made.handler, generate, getAgent, slack: made };
}

const agentsCalled = (getAgent: { mock: { calls: unknown[][] } }): string[] =>
  getAgent.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deux demandes, deux agents — les deux sont servies', () => {
  it('appelle les DEUX agents, dans l’ordre du message', async () => {
    const { handler, getAgent } = makeHandler();

    await handler.handleMessage(dm(`résume ${CHANNEL_TOKEN} et rappelle-moi jeudi de le relire`));

    expect(agentsCalled(getAgent)).toEqual(['knowledgeAgent', 'notificationAgent']);
  });

  it('chaque agent ne reçoit QUE son fragment', async () => {
    const { handler, generate } = makeHandler();

    await handler.handleMessage(dm(`résume ${CHANNEL_TOKEN} et rappelle-moi jeudi de le relire`));

    const [first, second] = generate.mock.calls.map((call) => JSON.stringify(call[0]));
    expect(first).toContain('résume');
    expect(first).not.toContain('rappelle-moi');
    expect(second).toContain('rappelle-moi');
    expect(second).not.toContain('résume');
  });

  it('les deux réponses sont RÉELLEMENT publiées — aucune n’est avalée', async () => {
    const { handler, slack } = makeHandler();

    await handler.handleMessage(dm(`résume ${CHANNEL_TOKEN} et rappelle-moi jeudi de le relire`));

    // ⚠️ La réponse finale REMPLACE le marqueur de progression : elle passe par `chat.update`,
    // pas par `postMessage`. Ne relever qu'un des deux ferait passer ce test au vert sur du vide.
    const posted = [...slack.updatedTexts(), ...slack.postedTexts()].join('\n');

    expect(posted).toContain(SECRET);
    expect(posted).toContain('Deuxième réponse.');
  });
});

describe('L’INVARIANT — la sortie d’une étape n’entre jamais dans la suivante', () => {
  it('la réponse de l’étape 1 est ABSENTE du contexte de l’étape 2', async () => {
    // Le cœur du théorème. Si cette assertion tombe un jour, l'enchaînement redevient un canal
    // de circulation de contenu, et la phrase interdite redevient exécutable.
    const { handler, generate } = makeHandler();

    await handler.handleMessage(dm(`résume ${CHANNEL_TOKEN} et rappelle-moi jeudi de le relire`));

    const second = JSON.stringify(generate.mock.calls[1]?.[0]);
    expect(second).not.toContain('licencier Pamela');
  });

  it('la phrase INTERDITE n’est PAS exécutée : elle est CLARIFIÉE, à zéro token', async () => {
    // ⚠️ Recommandation du propriétaire, 2026-08-25 : *« en cas de confusion dans la requête,
    // clarifier plutôt, et attendre la confirmation avant d'exécuter. »*
    //
    // « résume <#…> et envoie ÇA à recrue@exemple.com » : les deux fragments sont licites
    // séparément, mais le second RENVOIE au premier — c'est-à-dire qu'il demande un transport
    // de contenu que le harness ne fera pas. L'exécuter produirait une réponse déroutante
    // (« qu'est-ce que je dois envoyer ? ») qui se lirait comme un bot ayant perdu le fil.
    //
    // On demande donc, et l'on n'appelle AUCUN modèle pour le faire.
    const { handler, generate, slack } = makeHandler();

    await handler.handleMessage(
      dm(`résume ${CHANNEL_TOKEN} et envoie ça à recrue@exemple.com par email`),
    );

    expect(generate).not.toHaveBeenCalled();
    expect([...slack.updatedTexts(), ...slack.postedTexts()].join('\n')).toContain(
      'Dis-moi laquelle',
    );
  });
});

describe('le chemin nominal ne bouge pas', () => {
  it('un message simple n’appelle qu’UN agent', async () => {
    // La garantie de coût : l'immense majorité des messages ne paie pas un token de plus.
    const { handler, getAgent } = makeHandler();

    await handler.handleMessage(dm('génère-moi le guide d’accueil en PDF'));

    expect(agentsCalled(getAgent)).toHaveLength(1);
  });

  it('deux fragments servis par le même agent n’en appellent qu’UN', async () => {
    const { handler, getAgent } = makeHandler();

    await handler.handleMessage(dm('génère le guide en PDF et envoie-le-moi en PDF'));

    expect(agentsCalled(getAgent)).toHaveLength(1);
  });
});
