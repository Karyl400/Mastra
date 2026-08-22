import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mastra } from '@mastra/core';

import { type SlackMessageEvent } from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { writeDocumentRecipient } from '../../../src/shared/slack-request-context';
import { makeDirectoryDouble, makeSlackHandler } from '../../helpers/slack-handler';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « Ce document a été produit pour X » — la TROISIÈME consigne mesurée en échec
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le bloc DOCUMENTS impose au modèle de citer le `recipient` depuis le 2026-08-14. C'est la
 * mesure de VISIBILITÉ contre l'erreur de destinataire : « Bienvenue Awa » enregistré sous
 * l'UUID de Karyl, et le fichier parti à l'adresse de Karyl. Mesuré en production le
 * 2026-08-19, sur DEUX sondes document : le modèle ne le cite pas.
 *
 * Une mesure de visibilité qui ne se déclenche jamais est PIRE qu'absente — on la croit en
 * place. Le handler accole donc la note lui-même. Après la couverture des extraits et la
 * rédaction du contenu, c'est la troisième fois que ce dépôt fait ce chemin : une consigne est
 * probable, le code est garanti.
 */

const HUMAN = 'U0BJBDGTJUD';
const DM = 'D0MOCKDM01';

function makeHandler(agentText: string, recipient: string | null) {
  // Les HUIT dépendances neutralisables le sont par la fabrique partagée (voir son en-tête).
  // Ce fichier ne spécialise que l'agent — dont on rejoue le canal d'écriture — et l'annuaire,
  // qui doit NOMMER quelqu'un pour que `textMentionsName` ait de quoi travailler.
  const { handler, slack } = makeSlackHandler({
    mastra: {
      getAgent: vi.fn(() => ({
        // Le tool écrit dans le `requestContext` pendant le run : on rejoue exactement ce
        // canal-là, celui qui ne traverse ni le prompt ni le tool-result.
        generate: async (_messages: unknown, opts: { requestContext?: unknown }) => {
          if (recipient) writeDocumentRecipient(opts?.requestContext, recipient);
          return { text: agentText };
        },
      })),
    } as unknown as Mastra,
    directoryRepository: makeDirectoryDouble({
      slackUserId: HUMAN,
      realName: 'Karyl SOUMAILA',
      displayName: 'Karyl SOUMAILA',
      firstName: 'Karyl',
      lastName: 'SOUMAILA',
      email: 'karyl@kisso.com',
      employeeId: null,
    }),
  });

  return { handler, slack };
}

function dm(text: string, ts = '1700000000.000200'): SlackMessageEvent {
  return { type: 'message', user: HUMAN, text, channel: DM, channel_type: 'im', ts };
}

/** La réponse finale REMPLACE le marqueur de progression : elle passe par `chat.update`. */
const finalText = (slack: { chat: { update: { mock: { calls: unknown[][] } } } }) =>
  String((slack.chat.update.mock.calls.at(-1)?.[0] as { text?: string })?.text ?? '');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('la note est accolée quand le modèle ne nomme PAS la personne', () => {
  it('nomme le destinataire à la place du modèle', async () => {
    const { handler, slack } = makeHandler(
      'Le guide a été généré au format PDF et envoyé dans ce fil.',
      'Awa TRAORE',
    );

    await handler.handleMessage(dm('Génère le guide'));

    expect(finalText(slack)).toContain('Awa TRAORE');
    expect(finalText(slack)).toContain('Ce document a été produit pour');
  });
});

describe('elle NE l’est PAS quand la réponse est déjà juste', () => {
  it('ne double pas une réponse qui nomme déjà la personne', async () => {
    // ⚠️ Une redite de machine sur une réponse déjà juste est exactement le ton qu'on cherche
    // par ailleurs à supprimer — et un avertissement systématique devient du bruit, donc
    // s'ignore, ce qui le ramènerait au défaut qu'il corrige.
    const { handler, slack } = makeHandler(
      'C’est prêt pour Awa TRAORE — le PDF est dans ce fil.',
      'Awa TRAORE',
    );

    await handler.handleMessage(dm('Génère le guide'));

    expect(finalText(slack)).not.toContain('Ce document a été produit pour');
  });

  it('accepte le PRÉNOM SEUL — c’est nommer quelqu’un', async () => {
    const { handler, slack } = makeHandler('Voilà, c’est prêt pour Awa.', 'Awa TRAORE');

    await handler.handleMessage(dm('Génère le guide'));

    expect(finalText(slack)).not.toContain('Ce document a été produit pour');
  });
});

describe('aucun document, aucune note', () => {
  it('une réponse ordinaire n’est jamais annotée', async () => {
    const { handler, slack } = makeHandler('Le support technique est géré par Karyl.', null);

    await handler.handleMessage(dm('Qui gère le support ?'));

    expect(finalText(slack)).not.toContain('Ce document a été produit pour');
  });
});
