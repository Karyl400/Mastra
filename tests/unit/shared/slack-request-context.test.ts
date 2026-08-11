import { describe, it, expect } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';

import {
  SLACK_CHANNEL_KEY,
  SLACK_THREAD_TS_KEY,
  SLACK_USER_ID_KEY,
  buildSlackRequestContext,
  readSlackContext,
} from '../../../src/shared/slack-request-context';

describe('slack-request-context — aller-retour build → read', () => {
  it('rend le canal, le thread et l’utilisateur tels qu’ils ont été posés', () => {
    const requestContext = buildSlackRequestContext({
      channel: 'C0MOCKCHAN',
      threadTs: '1700000000.000100',
      slackUserId: 'U000HUMAN01',
    });

    expect(readSlackContext(requestContext)).toEqual({
      channel: 'C0MOCKCHAN',
      threadTs: '1700000000.000100',
      slackUserId: 'U000HUMAN01',
    });
  });

  it('n’expose PAS de threadTs quand il n’y en a pas (cas du DM)', () => {
    // Le cas qui compte : en DM, `threadTs` est `undefined` par conception. Un `thread_ts`
    // qui réapparaîtrait ici enfouirait le fichier livré hors de la conversation principale,
    // exactement le défaut qui a fait paraître le bot muet en production.
    const requestContext = buildSlackRequestContext({ channel: 'D0MOCKDM01' });

    expect(requestContext.has(SLACK_THREAD_TS_KEY)).toBe(false);
    expect(readSlackContext(requestContext)?.threadTs).toBeUndefined();
  });

  it('utilise les clés contractuelles, lisibles sans passer par les accesseurs', () => {
    // Ces trois clés sont le contrat entre le producteur (handler Slack) et les
    // consommateurs (tools d'autres features). Les figer par un test évite qu'un
    // renommage silencieux ne coupe la livraison sans qu'aucun type ne bouge.
    const requestContext = buildSlackRequestContext({
      channel: 'C1',
      threadTs: '2.2',
      slackUserId: 'U1',
    });

    expect(requestContext.get(SLACK_CHANNEL_KEY)).toBe('C1');
    expect(requestContext.get(SLACK_THREAD_TS_KEY)).toBe('2.2');
    expect(requestContext.get(SLACK_USER_ID_KEY)).toBe('U1');
  });

  it('ignore un threadTs ou un slackUserId vides plutôt que de les propager', () => {
    const requestContext = buildSlackRequestContext({
      channel: 'D0MOCKDM01',
      threadTs: '   ',
      slackUserId: '',
    });

    expect(readSlackContext(requestContext)).toEqual({ channel: 'D0MOCKDM01' });
  });
});

describe('slack-request-context — lecture défensive', () => {
  // `readSlackContext` est appelée depuis un tool qui peut aussi tourner HORS Slack
  // (playground Mastra, API HTTP, workflow, test unitaire). `undefined` y signifie
  // « je ne sais pas où poster » — un cas NORMAL, jamais une erreur.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['une chaîne', 'C0MOCKCHAN'],
    ['un nombre', 42],
    ['un objet sans get()', { slackChannel: 'C0MOCKCHAN' }],
    ['un objet dont get n’est pas une fonction', { get: 'C0MOCKCHAN' }],
  ])('rend undefined pour %s', (_label, value) => {
    expect(readSlackContext(value)).toBeUndefined();
  });

  it('rend undefined pour un RequestContext vide (appel hors Slack)', () => {
    expect(readSlackContext(new RequestContext())).toBeUndefined();
  });

  it('rend undefined quand le canal est vide ou uniquement des espaces', () => {
    // Sans canal, il n'y a rien à livrer : un contexte partiel vaut pas de contexte.
    expect(readSlackContext(new RequestContext([[SLACK_CHANNEL_KEY, '']]))).toBeUndefined();
    expect(readSlackContext(new RequestContext([[SLACK_CHANNEL_KEY, '   ']]))).toBeUndefined();
  });

  it('rend undefined quand le canal n’est pas une chaîne', () => {
    expect(readSlackContext(new RequestContext([[SLACK_CHANNEL_KEY, 12345]]))).toBeUndefined();
    expect(
      readSlackContext(new RequestContext([[SLACK_CHANNEL_KEY, { id: 'C1' }]])),
    ).toBeUndefined();
  });

  it('garde le canal et écarte les champs annexes de type inattendu', () => {
    // Dégradation partielle assumée : un `threadTs` corrompu ne doit pas coûter la
    // livraison, il doit seulement ramener au comportement « pas de thread ».
    const requestContext = new RequestContext([
      [SLACK_CHANNEL_KEY, 'C0MOCKCHAN'],
      [SLACK_THREAD_TS_KEY, 17000000],
      [SLACK_USER_ID_KEY, { id: 'U1' }],
    ]);

    expect(readSlackContext(requestContext)).toEqual({ channel: 'C0MOCKCHAN' });
  });

  it('ne lève jamais, même si get() explose', () => {
    const hostile = {
      get() {
        throw new Error('registry corrompu');
      },
    };

    expect(() => readSlackContext(hostile)).not.toThrow();
    expect(readSlackContext(hostile)).toBeUndefined();
  });

  it('accepte tout porteur d’un get() compatible, pas seulement RequestContext', () => {
    // Le tool reçoit `ctx.requestContext` du runtime Mastra : on lit par CONTRAT
    // structurel (`get(key)`), pas par `instanceof`, qui casserait dès qu'une version
    // de Mastra fournirait une autre implémentation ou un proxy.
    const duck = {
      get: (key: string) => (key === SLACK_CHANNEL_KEY ? 'D0MOCKDM01' : undefined),
    };

    expect(readSlackContext(duck)).toEqual({ channel: 'D0MOCKDM01' });
  });
});
