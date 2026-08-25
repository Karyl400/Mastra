import { describe, it, expect, vi } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  classifyToolOutcome,
  markStepOutcomes,
  STEP_OUTCOME_MARKER,
} from '../../../src/shared/tool-step-outcome';
import { readStepBlocked, SLACK_STEP_BLOCKED_KEY } from '../../../src/shared/slack-request-context';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA MARQUE D'ÉCHEC N'EST PLUS LE PRIVILÈGE D'UN SEUL OUTIL
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Livrée le 2026-08-25, la marque `slackStepBlocked` n'était posée que par `getChannelHistory`.
 * C'était inscrit en dette nommée dans `TODO.md`, et le propriétaire a tranché le jour même :
 * *« pose la marque d'échec posée sur getChannelHistory sur les autres outils »*.
 *
 * ⚠️ **ELLE EST DÉRIVÉE, PAS RECOPIÉE — ET C'EST TOUT LE LOT.** Poser treize appels à
 * `writeStepBlocked` à la main aurait produit treize occasions d'en oublier un, et une liste
 * qui se périme au premier outil ajouté. Ce module lit la FORME du résultat, que les treize
 * outils partagent déjà : un drapeau positif (`found` / `saved` / `sent` / `stored` /
 * `updated`), un `status`, un `reason`. Un outil écrit demain est couvert sans qu'on y pense.
 *
 * ⚠️ **UN DRAPEAU POSITIF VRAI L'EMPORTE SUR UN `reason`.** `generateDocument` rend
 * `{ saved: true, delivery: 'failed', reason: 'delivery_failed' }` : le document EXISTE, il
 * n'a pas été livré. Ce dépôt a un mot pour cela — *dégradé* — et le distingue d'*échoué*
 * depuis le 2026-08-11. Une chaîne ne s'arrête donc pas là-dessus. Choix conservateur assumé :
 * le pire cas est l'ancien comportement, jamais une régression.
 *
 * ⚠️ **ET LE SUCCÈS EFFACE.** Un agent qui appelle `findPersonByName` sans résultat puis le
 * rappelle avec une autre orthographe a RÉUSSI son étape. Sans effacement, la marque du
 * premier appel condamnerait la suite de la chaîne — un défaut que la version à un seul outil
 * portait déjà, invisible parce que `getChannelHistory` n'est appelé qu'une fois.
 */

const SUCCESS: ReadonlyArray<{ tool: string; result: unknown }> = [
  { tool: 'getChannelHistory', result: { found: true, conversation: '…', shown: 6, scanned: 37 } },
  { tool: 'findPersonByName', result: { found: true, employeeId: 'uuid', name: 'Awa' } },
  { tool: 'getEmployeeProfile', result: { found: true, profile: {} } },
  { tool: 'findExpertise', result: { found: true, people: [] } },
  { tool: 'searchKnowledge', result: { found: true, lines: '…' } },
  { tool: 'getUserConversations', result: { found: true, conversation: '…' } },
  { tool: 'sendNotification', result: { id: 'n1', channel: 'email', status: 'sent', sentAt: 'x' } },
  { tool: 'scheduleReminder', result: { stored: true, deliveredOn: 'le lundi 24 août au matin' } },
  {
    tool: 'updateOnboardingStatus',
    result: { updated: true, status: 'completed', currentStep: 1 },
  },
  {
    tool: 'updateOnboardingStatus (statut « blocked »)',
    result: { updated: true, status: 'blocked' },
  },
  { tool: 'generateDocument', result: { saved: true, documentId: 'd1', delivery: 'slack' } },
  {
    tool: 'generateDocument (livraison dégradée)',
    result: { saved: true, documentId: 'd1', delivery: 'failed', reason: 'delivery_failed' },
  },
  {
    tool: 'generateDocument (déjà livré)',
    result: { saved: true, documentId: 'd1', delivery: 'slack', alreadyDelivered: true },
  },
  {
    tool: 'scheduleCandidateInterview',
    result: { status: 'awaiting_confirmation', candidate: 'Jean' },
  },
  { tool: 'getNotificationHistory', result: { notifications: [{}], total: 1, shown: 1 } },
];

const REFUSAL: ReadonlyArray<{ tool: string; result: unknown; reason: string }> = [
  {
    tool: 'getChannelHistory (bot hors du canal)',
    result: { found: false, reason: 'bot_not_in_channel', hint: '…' },
    reason: 'bot_not_in_channel',
  },
  {
    tool: 'findEmployeeByEmail',
    result: { found: false, reason: 'not_resolvable' },
    reason: 'not_resolvable',
  },
  {
    tool: 'findPersonByName (ambigu)',
    result: { found: false, reason: 'ambiguous' },
    reason: 'ambiguous',
  },
  {
    tool: 'getEmployeeProfile (non autorisé)',
    result: { found: false, reason: 'not_authorized' },
    reason: 'not_authorized',
  },
  {
    tool: 'scheduleReminder (non autorisé)',
    result: { stored: false, reason: 'not_authorized', hint: '…' },
    reason: 'not_authorized',
  },
  {
    tool: 'sendNotification (non autorisé)',
    result: { sent: false, reason: 'not_authorized', hint: '…' },
    reason: 'not_authorized',
  },
  {
    tool: 'sendNotification (transport en échec)',
    result: { id: 'n1', channel: 'email', status: 'failed', sentAt: null },
    reason: 'failed',
  },
  {
    tool: 'updateOnboardingStatus (rien enregistré)',
    result: { updated: false, reason: 'not_persisted', hint: '…' },
    reason: 'not_persisted',
  },
  {
    tool: 'generateDocument (non autorisé)',
    result: { saved: false, delivery: 'none', reason: 'not_authorized', hint: '…' },
    reason: 'not_authorized',
  },
  {
    tool: 'scheduleCandidateInterview (refusé)',
    result: { status: 'refused', reason: 'forbidden', hint: '…' },
    reason: 'forbidden',
  },
  {
    tool: 'getNotificationHistory (identifiant manquant)',
    result: { notifications: [], total: 0, shown: 0, reason: 'missing_identifier', hint: '…' },
    reason: 'missing_identifier',
  },
  {
    tool: 'entrée refusée par Mastra',
    result: { error: true, message: 'Tool validation failed' },
    reason: 'invalid_call',
  },
];

describe('classifyToolOutcome — les issues servies', () => {
  it.each(SUCCESS)('$tool ne bloque pas', ({ result }) => {
    expect(classifyToolOutcome(result).outcome).toBe('served');
  });
});

describe('classifyToolOutcome — les refus', () => {
  it.each(REFUSAL)('$tool bloque, et nomme « $reason »', ({ result, reason }) => {
    expect(classifyToolOutcome(result)).toEqual({ outcome: 'blocked', reason });
  });
});

describe('classifyToolOutcome — ce qui n’est pas une forme connue', () => {
  it('un résultat qui n’est pas un objet est servi', () => {
    expect(classifyToolOutcome('du texte').outcome).toBe('served');
    expect(classifyToolOutcome(undefined).outcome).toBe('served');
    expect(classifyToolOutcome(null).outcome).toBe('served');
  });

  it('un objet sans verdict est servi — on ne devine pas', () => {
    expect(classifyToolOutcome({ people: [], coverage: '…' }).outcome).toBe('served');
  });
});

function toolThatReturns(result: unknown) {
  return {
    id: 'fake',
    execute: vi.fn(async (_input: unknown, _ctx?: unknown) => result),
  };
}

describe('markStepOutcomes — la marque suit le résultat', () => {
  it('un refus pose la marque dans le requestContext', async () => {
    const tools = markStepOutcomes({ t: toolThatReturns({ found: false, reason: 'no_match' }) });
    const requestContext = new RequestContext();

    await tools.t.execute({}, { requestContext });

    expect(readStepBlocked(requestContext)).toBe('no_match');
  });

  it('un succès EFFACE une marque posée juste avant', async () => {
    const requestContext = new RequestContext();
    requestContext.set(SLACK_STEP_BLOCKED_KEY, 'no_match');

    const tools = markStepOutcomes({ t: toolThatReturns({ found: true, employeeId: 'u' }) });
    await tools.t.execute({}, { requestContext });

    expect(readStepBlocked(requestContext)).toBeUndefined();
  });

  it('un outil qui LÈVE pose la marque et laisse passer l’erreur', async () => {
    const boom = {
      id: 'boom',
      execute: vi.fn(async (_input: unknown, _ctx?: unknown): Promise<unknown> => {
        throw new Error('Destinataire introuvable');
      }),
    };
    const tools = markStepOutcomes({ boom });
    const requestContext = new RequestContext();

    await expect(tools.boom.execute({}, { requestContext })).rejects.toThrow(
      'Destinataire introuvable',
    );
    expect(readStepBlocked(requestContext)).toBe('tool_error');
  });

  it('le résultat de l’outil traverse le marquage sans être touché', async () => {
    const original = { found: true, conversation: 'texte', shown: 6 };
    const tools = markStepOutcomes({ t: toolThatReturns(original) });

    const returned = await tools.t.execute({}, { requestContext: new RequestContext() });

    expect(returned).toEqual(original);
  });

  it('hors Slack, l’absence de requestContext ne casse rien', async () => {
    const tools = markStepOutcomes({ t: toolThatReturns({ found: false, reason: 'no_match' }) });

    await expect(tools.t.execute({}, undefined)).resolves.toEqual({
      found: false,
      reason: 'no_match',
    });
  });

  it('marquer deux fois n’enveloppe qu’une fois', async () => {
    const tool = toolThatReturns({ found: true });
    markStepOutcomes({ tool });
    const first = tool.execute;
    markStepOutcomes({ tool });

    expect(tool.execute).toBe(first);
    expect((tool as unknown as Record<symbol, unknown>)[STEP_OUTCOME_MARKER]).toBe(true);
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * CONTRE UN VRAI `Tool` MASTRA — la moitié qui compte
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ Les doublures ci-dessus prouvent la logique, pas le CÂBLAGE. Ce dépôt a déjà eu un
 * middleware mort depuis son écriture parce que ses tests assertaient le retour au lieu de
 * `c.res` : verts sur du code mort. Ici le risque exact est que `requestContext` n'arrive pas
 * dans le SECOND argument de `tool.execute` — auquel cas le marquage ne lèverait rien, ne
 * casserait rien, et ne ferait rien.
 *
 * `createTool` enveloppe déjà `execute` d'une validation d'entrée. On enveloppe donc une
 * enveloppe, et c'est la vraie forme du montage.
 */
describe('markStepOutcomes sur un Tool Mastra réel', () => {
  const build = (result: unknown) =>
    createTool({
      id: 'realTool',
      description: 'outil de test',
      inputSchema: z.object({ who: z.string().min(1) }),
      execute: async () => result,
    });

  it('le requestContext arrive bien, et le refus est marqué', async () => {
    const tool = build({ found: false, reason: 'no_match' });
    markStepOutcomes({ tool });
    const requestContext = new RequestContext();

    await tool.execute({ who: 'Awa' }, { requestContext });

    expect(readStepBlocked(requestContext)).toBe('no_match');
  });

  it('un succès efface, sur le même vrai Tool', async () => {
    const tool = build({ found: true, employeeId: 'u' });
    markStepOutcomes({ tool });
    const requestContext = new RequestContext();
    requestContext.set(SLACK_STEP_BLOCKED_KEY, 'no_match');

    await tool.execute({ who: 'Awa' }, { requestContext });

    expect(readStepBlocked(requestContext)).toBeUndefined();
  });

  it('une ENTRÉE refusée par Mastra bloque aussi — elle ne lève pas, elle rend un objet', async () => {
    // Mesuré le 2026-08-25 : `validateToolInput` RETOURNE `{ error: true, message }` au modèle.
    // C'est un appel qui n'a rien fait, donc une étape qui n'a rien fait.
    const tool = build({ found: true });
    markStepOutcomes({ tool });
    const requestContext = new RequestContext();

    const outcome = await tool.execute({} as { who: string }, { requestContext });

    expect((outcome as { error?: unknown }).error).toBe(true);
    expect(readStepBlocked(requestContext)).toBe('invalid_call');
  });
});
