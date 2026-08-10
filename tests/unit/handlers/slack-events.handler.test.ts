import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { Mastra } from '@mastra/core';

// Aucun test unitaire ne doit toucher l'API Slack réelle.
vi.mock('@slack/web-api', () => ({
  WebClient: class FakeWebClient {
    auth = { test: vi.fn().mockResolvedValue({ ok: true, user_id: 'U0BMBEJTBMJ' }) };
    chat = { postMessage: vi.fn().mockResolvedValue({ ok: true }) };
  },
}));

import {
  SlackEventsHandler,
  type SlackEvent,
  type SlackEventEnvelope,
  type SlackMessageEvent,
  type SlackTeamJoinEvent,
  type SlackEventsHandlerOptions,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { wrapAgentInput } from '../../../src/shared/security/llm-guardrail';

const BOT_USER_ID = 'U0BMBEJTBMJ';
const BOT_ID = 'B0BM9MK4G65';
const HUMAN = 'U000HUMAN01';

interface MockSlack {
  auth: { test: ReturnType<typeof vi.fn> };
  chat: { postMessage: ReturnType<typeof vi.fn> };
}

function makeSlackMock(overrides: Partial<MockSlack> = {}): MockSlack {
  return {
    auth: { test: vi.fn().mockResolvedValue({ ok: true, user_id: BOT_USER_ID }) },
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) },
    ...overrides,
  };
}

function makeMastraMock(generatedText = 'Réponse de l’agent') {
  const generate = vi.fn().mockResolvedValue({ text: generatedText });
  const getAgent = vi.fn().mockReturnValue({ generate });
  return { mastra: { getAgent } as unknown as Mastra, getAgent, generate };
}

/**
 * Doublures des deux dépendances du chemin `team_join`.
 *
 * Elles sont injectées par options — comme `slackClient` — plutôt que reprises
 * de `src/mastra/index.ts` : la route importe déjà `index.ts`, donc l'inverse
 * créerait un cycle d'import.
 */
function makeTeamJoinDeps() {
  const sendBlocks = vi.fn().mockResolvedValue({ ts: '1700000000.000400' });
  const getUserById = vi.fn().mockResolvedValue(null);
  return {
    chatProvider: { sendBlocks },
    workspaceProvider: { getUserById },
    sendBlocks,
    getUserById,
  };
}

function makeHandler(
  options: {
    slack?: MockSlack;
    mastra?: Mastra;
    chatProvider?: { sendBlocks: ReturnType<typeof vi.fn> };
    workspaceProvider?: { getUserById: ReturnType<typeof vi.fn> };
  } = {},
) {
  const slack = options.slack ?? makeSlackMock();
  const mastraMock = makeMastraMock();
  const handler = new SlackEventsHandler('xoxb-test-token', options.mastra ?? mastraMock.mastra, {
    slackClient: slack as unknown as WebClient,
    chatProvider: options.chatProvider as unknown as SlackEventsHandlerOptions['chatProvider'],
    workspaceProvider:
      options.workspaceProvider as unknown as SlackEventsHandlerOptions['workspaceProvider'],
  });
  return { handler, slack, ...mastraMock };
}

function envelope(event: SlackEvent, eventId = 'Ev0TEST0001'): SlackEventEnvelope {
  return {
    type: 'event_callback',
    team_id: 'TMLKC4EPP',
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    event,
  };
}

// Ces fabriques sont typées sur `SlackMessageEvent`, PAS sur l'union `SlackEvent` :
// `Partial<Union>` est homomorphe et distribue sur les membres, ce qui élargirait
// `user` en `string | objet` et rendrait l'étalement inassignable (TS2322).
const mention = (overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent => ({
  type: 'app_mention',
  user: HUMAN,
  text: `<@${BOT_USER_ID}> bonjour`,
  channel: 'C0MOCKCHAN',
  channel_type: 'channel',
  ts: '1700000000.000100',
  ...overrides,
});

const dm = (overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent => ({
  type: 'message',
  user: HUMAN,
  text: 'bonjour',
  channel: 'D0MOCKDM01',
  channel_type: 'im',
  ts: '1700000000.000200',
  ...overrides,
});

const NEWCOMER = 'U0NEWCOMER1';

/**
 * Payload `team_join` réel : `user` est un OBJET complet, et l'événement ne porte
 * ni `channel`, ni `ts`, ni `text`, ni `subtype`, ni `bot_id`.
 */
const teamJoin = (userOverrides: Partial<SlackTeamJoinEvent['user']> = {}): SlackTeamJoinEvent => ({
  type: 'team_join',
  event_ts: '1700000000.000300',
  user: {
    id: NEWCOMER,
    name: 'alice',
    real_name: 'Alice Martin',
    is_bot: false,
    deleted: false,
    profile: {
      email: 'alice@kisso.com',
      first_name: 'Alice',
      last_name: 'Martin',
    },
    ...userOverrides,
  },
});

describe('SlackEventsHandler — accept() (décision synchrone, avant l’ACK)', () => {
  let ctx: ReturnType<typeof makeHandler>;

  beforeEach(() => {
    ctx = makeHandler();
  });

  it('accepts an app_mention in a channel', () => {
    expect(ctx.handler.accept(envelope(mention()))).toEqual({
      action: 'process',
      event: expect.objectContaining({ type: 'app_mention' }),
    });
  });

  it('accepts a message with channel_type "im" (DM)', () => {
    expect(ctx.handler.accept(envelope(dm()))).toEqual({
      action: 'process',
      event: expect.objectContaining({ channel_type: 'im' }),
    });
  });

  it('ignores a plain channel message so a mention never yields two replies', () => {
    // Slack émet app_mention ET message.channels pour la même mention.
    const decision = ctx.handler.accept(
      envelope(dm({ channel_type: 'channel', channel: 'C0MOCKCHAN' }), 'Ev0CHANNEL'),
    );
    expect(decision).toEqual({ action: 'ignore', reason: 'not_a_dm' });
  });

  it('ignores events carrying bot_id (infinite loop guard)', () => {
    expect(ctx.handler.accept(envelope(dm({ bot_id: BOT_ID })))).toEqual({
      action: 'ignore',
      reason: 'bot_message',
    });
  });

  it('ignores events with subtype "bot_message"', () => {
    expect(ctx.handler.accept(envelope(dm({ subtype: 'bot_message' })))).toEqual({
      action: 'ignore',
      reason: 'bot_message',
    });
  });

  it('ignores non event_callback envelopes and unsupported event types', () => {
    expect(ctx.handler.accept({ type: 'url_verification', challenge: 'x' })).toEqual({
      action: 'ignore',
      reason: 'not_event_callback',
    });
    expect(ctx.handler.accept(envelope({ type: 'reaction_added', channel: 'C1' }))).toEqual({
      action: 'ignore',
      reason: 'unsupported_event_type',
    });
    expect(ctx.handler.accept({ type: 'event_callback' })).toEqual({
      action: 'ignore',
      reason: 'no_event',
    });
  });

  it('ignores message subtypes such as message_changed / channel_join', () => {
    expect(ctx.handler.accept(envelope(dm({ subtype: 'message_changed' })))).toEqual({
      action: 'ignore',
      reason: 'unsupported_event_type',
    });
  });

  it('ignores a mention with no text left once the bot mention is stripped', () => {
    expect(ctx.handler.accept(envelope(mention({ text: `<@${BOT_USER_ID}>   ` })))).toEqual({
      action: 'ignore',
      reason: 'empty_text',
    });
  });

  it('deduplicates a Slack retry carrying the same event_id', () => {
    const first = ctx.handler.accept(envelope(dm(), 'Ev0DUPLICATE'));
    const retry = ctx.handler.accept(envelope(dm(), 'Ev0DUPLICATE'), { retryNum: '1' });

    expect(first.action).toBe('process');
    expect(retry).toEqual({ action: 'ignore', reason: 'duplicate' });
  });

  it('falls back to channel:ts for dedup when event_id is absent', () => {
    const withoutId: SlackEventEnvelope = { type: 'event_callback', event: dm() };
    expect(ctx.handler.accept(withoutId).action).toBe('process');
    expect(ctx.handler.accept(withoutId)).toEqual({ action: 'ignore', reason: 'duplicate' });
  });

  it('does not deduplicate two genuinely distinct events', () => {
    expect(ctx.handler.accept(envelope(dm({ ts: '1.1' }), 'Ev0A')).action).toBe('process');
    expect(ctx.handler.accept(envelope(dm({ ts: '2.2' }), 'Ev0B')).action).toBe('process');
  });
});

describe('SlackEventsHandler — double réponse en DM (régression 2026-08-10)', () => {
  let ctx: ReturnType<typeof makeHandler>;

  beforeEach(() => {
    ctx = makeHandler();
  });

  it('ignore un app_mention émis dans un canal de DM', () => {
    // Mentionner le bot dans un DM émet À LA FOIS `message` (channel_type 'im')
    // et `app_mention`. Le filtre `not_a_dm` ne dédouble que les canaux : sans
    // cette garde, le bot répond DEUX FOIS — observé en production.
    //
    // Le test porte sur le préfixe `D` du canal, PAS sur `channel_type` :
    // le payload `app_mention` de Slack ne porte pas ce champ.
    const decision = ctx.handler.accept(
      envelope(mention({ channel: 'D0MOCKDM01', channel_type: undefined }), 'Ev0MENTIONDM'),
    );

    expect(decision).toEqual({ action: 'ignore', reason: 'duplicate_mention' });
  });

  it('continue d’accepter un app_mention dans un vrai canal', () => {
    expect(ctx.handler.accept(envelope(mention(), 'Ev0MENTIONCH')).action).toBe('process');
  });

  it('ne traite qu’une fois deux événements jumeaux d’event_id différents', () => {
    // `message` et `app_mention` d'une même prise de parole ont des `event_id`
    // distincts mais partagent toujours `channel` et `ts`. La clé de
    // déduplication doit donc préférer `channel:ts` à `event_id`.
    const first = ctx.handler.accept(
      envelope(dm({ channel: 'D0TWIN', ts: '1700000000.000900' }), 'Ev0TWIN_A'),
    );
    const twin = ctx.handler.accept(
      envelope(dm({ channel: 'D0TWIN', ts: '1700000000.000900' }), 'Ev0TWIN_B'),
    );

    expect(first.action).toBe('process');
    expect(twin).toEqual({ action: 'ignore', reason: 'duplicate' });
  });

  it('déduplique toujours team_join sur event_id, faute de canal et de ts', () => {
    expect(ctx.handler.accept(envelope(teamJoin(), 'Ev0JOINKEY')).action).toBe('process');
    expect(ctx.handler.accept(envelope(teamJoin(), 'Ev0JOINKEY'))).toEqual({
      action: 'ignore',
      reason: 'duplicate',
    });
  });
});

describe('SlackEventsHandler — accept() sur team_join (arrivée d’un nouvel employé)', () => {
  let ctx: ReturnType<typeof makeHandler>;

  beforeEach(() => {
    ctx = makeHandler();
  });

  it('accepts a genuine team_join payload', () => {
    // Un team_join n'a NI channel, NI ts, NI text : les gardes écrites pour les
    // messages doivent toutes être conditionnées au type, sinon il est rejeté.
    expect(ctx.handler.accept(envelope(teamJoin(), 'Ev0JOIN01'))).toEqual({
      action: 'process',
      event: expect.objectContaining({ type: 'team_join' }),
    });
  });

  it('does not reject team_join as empty_text although it carries no text', () => {
    // Régression visée : `cleanText(undefined) === ''` → falsy → 100 % des
    // team_join seraient sortis en `empty_text`.
    const decision = ctx.handler.accept(envelope(teamJoin(), 'Ev0JOIN02'));
    expect(decision).not.toEqual(expect.objectContaining({ reason: 'empty_text' }));
  });

  it('ignores a bot joining the workspace', () => {
    // La garde anti-boucle des messages (`bot_id` / `subtype` / `bot_profile`)
    // est structurellement incapable de le voir : ces champs n'existent pas sur
    // un team_join. Sans garde dédiée, le bot enverrait un DM à chaque app
    // installée — voire à lui-même.
    expect(ctx.handler.accept(envelope(teamJoin({ is_bot: true }), 'Ev0JOIN03'))).toEqual({
      action: 'ignore',
      reason: 'bot_join',
    });
  });

  it('ignores an app user and a workflow bot', () => {
    expect(ctx.handler.accept(envelope(teamJoin({ is_app_user: true }), 'Ev0JOIN04'))).toEqual({
      action: 'ignore',
      reason: 'bot_join',
    });
    expect(ctx.handler.accept(envelope(teamJoin({ is_workflow_bot: true }), 'Ev0JOIN05'))).toEqual({
      action: 'ignore',
      reason: 'bot_join',
    });
  });

  it('ignores Slackbot itself', () => {
    expect(ctx.handler.accept(envelope(teamJoin({ id: 'USLACKBOT' }), 'Ev0JOIN06'))).toEqual({
      action: 'ignore',
      reason: 'bot_join',
    });
  });

  it('ignores a deleted account', () => {
    expect(ctx.handler.accept(envelope(teamJoin({ deleted: true }), 'Ev0JOIN07'))).toEqual({
      action: 'ignore',
      reason: 'deleted_user',
    });
  });

  it('ignores a single-channel guest and a Slack Connect stranger', () => {
    // Décision métier assumée : un invité mono-canal n'est jamais une embauche
    // Kisso, un externe Slack Connect non plus. L'invité MULTI-canal
    // (`is_restricted`) passe en revanche — ce sont les prestataires, qui sont
    // bien intégrés.
    expect(
      ctx.handler.accept(envelope(teamJoin({ is_ultra_restricted: true }), 'Ev0JOIN08')),
    ).toEqual({ action: 'ignore', reason: 'restricted_user' });
    expect(ctx.handler.accept(envelope(teamJoin({ is_stranger: true }), 'Ev0JOIN09'))).toEqual({
      action: 'ignore',
      reason: 'restricted_user',
    });
    expect(
      ctx.handler.accept(envelope(teamJoin({ is_restricted: true }), 'Ev0JOIN10')).action,
    ).toBe('process');
  });

  it('ignores a team_join with no usable user id', () => {
    const decision = ctx.handler.accept(
      { type: 'event_callback', event_id: 'Ev0JOIN11', event: { type: 'team_join' } },
      {},
    );
    expect(decision).toEqual({ action: 'ignore', reason: 'no_user' });
  });

  it('deduplicates a team_join retry on event_id alone', () => {
    // team_join n'a ni channel ni ts : le repli `channel:ts` de dedupKey() est
    // inopérant, seul `event_id` protège du double DM de bienvenue.
    expect(ctx.handler.accept(envelope(teamJoin(), 'Ev0JOINDUP')).action).toBe('process');
    expect(ctx.handler.accept(envelope(teamJoin(), 'Ev0JOINDUP'), { retryNum: '1' })).toEqual({
      action: 'ignore',
      reason: 'duplicate',
    });
  });
});

describe('SlackEventsHandler — vérification du workspace d’origine (team_id)', () => {
  const ORIGINAL = process.env.SLACK_TEAM_ID;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SLACK_TEAM_ID;
    else process.env.SLACK_TEAM_ID = ORIGINAL;
  });

  it('accepts every workspace when SLACK_TEAM_ID is unset (fail-open)', () => {
    // Délibérément fail-OPEN. La variable n'existe ni dans .env ni parmi les 15
    // variables Vercel de production : un fail-closed couperait 100 % du trafic
    // Slack, silencieusement — la route rend 200 en toute circonstance — et
    // avec une CI verte. Le HMAC lie déjà la requête au signing secret de
    // l'app, qui est mono-workspace.
    delete process.env.SLACK_TEAM_ID;
    const ctx = makeHandler();

    expect(ctx.handler.accept(envelope(dm(), 'Ev0TEAM01')).action).toBe('process');
  });

  it('accepts an event coming from the configured workspace', () => {
    process.env.SLACK_TEAM_ID = 'TMLKC4EPP';
    const ctx = makeHandler();

    expect(ctx.handler.accept(envelope(dm(), 'Ev0TEAM02')).action).toBe('process');
  });

  it('ignores an event from another workspace once SLACK_TEAM_ID is set', () => {
    process.env.SLACK_TEAM_ID = 'TOTHERWORKSPACE';
    const ctx = makeHandler();

    expect(ctx.handler.accept(envelope(dm(), 'Ev0TEAM03'))).toEqual({
      action: 'ignore',
      reason: 'wrong_team',
    });
  });
});

describe('SlackEventsHandler — handleTeamJoin (DM de bienvenue)', () => {
  it('sends a block message straight to the newcomer’s user id', async () => {
    // `chat.postMessage` accepte un identifiant utilisateur comme `channel` et
    // ouvre le DM au besoin : `conversations.open` est inutile, et `chat:write`
    // suffit.
    const deps = makeTeamJoinDeps();
    const { handler } = makeHandler(deps);

    await handler.handleTeamJoin(teamJoin());

    expect(deps.sendBlocks).toHaveBeenCalledTimes(1);
    const [channel, fallback, blocks] = deps.sendBlocks.mock.calls[0];
    expect(channel).toBe(NEWCOMER);
    expect(fallback).toMatch(/bienvenue/i);
    expect(JSON.stringify(blocks)).toMatch(/Compléter mon profil/);
  });

  it('greets the newcomer by first name', async () => {
    const deps = makeTeamJoinDeps();
    const { handler } = makeHandler(deps);

    await handler.handleTeamJoin(teamJoin());

    expect(JSON.stringify(deps.sendBlocks.mock.calls[0])).toMatch(/Alice/);
  });

  it('does not call users.info when the payload already carries the email', async () => {
    // Le repli est un second aller-retour réseau sur un chemin déjà budgété
    // par waitUntil : ne le payer que si nécessaire.
    const deps = makeTeamJoinDeps();
    const { handler } = makeHandler(deps);

    await handler.handleTeamJoin(teamJoin());

    expect(deps.getUserById).not.toHaveBeenCalled();
  });

  it('falls back to users.info when the payload carries no email', async () => {
    const deps = makeTeamJoinDeps();
    deps.getUserById.mockResolvedValue({
      id: NEWCOMER,
      name: 'alice',
      realName: 'Alice Martin',
      email: 'alice@kisso.com',
      firstName: 'Alice',
      lastName: 'Martin',
      isBot: false,
      isAdmin: false,
      teamId: 'TMLKC4EPP',
    });
    const { handler } = makeHandler(deps);

    await handler.handleTeamJoin(teamJoin({ profile: {} }));

    expect(deps.getUserById).toHaveBeenCalledWith(NEWCOMER);
    expect(deps.sendBlocks).toHaveBeenCalledTimes(1);
  });

  it('still sends the DM when the email cannot be resolved at all', async () => {
    // L'email absent ne bloque pas : le DM part sur l'identifiant Slack et la
    // modale le collectera.
    const deps = makeTeamJoinDeps();
    deps.getUserById.mockResolvedValue(null);
    const { handler } = makeHandler(deps);

    await handler.handleTeamJoin(teamJoin({ profile: {} }));

    expect(deps.sendBlocks).toHaveBeenCalledTimes(1);
  });

  it('sends the DM even when the directory lookup throws', async () => {
    const deps = makeTeamJoinDeps();
    deps.getUserById.mockRejectedValue(new Error('ratelimited'));
    const { handler } = makeHandler(deps);

    await handler.handleTeamJoin(teamJoin({ profile: {} }));

    expect(deps.sendBlocks).toHaveBeenCalledTimes(1);
  });

  it('never rethrows — a Slack retry would produce a second welcome DM', async () => {
    const deps = makeTeamJoinDeps();
    deps.sendBlocks.mockRejectedValue(new Error('cannot_dm_bot'));
    const { handler } = makeHandler(deps);

    await expect(handler.handleTeamJoin(teamJoin())).resolves.toBeUndefined();
  });

  it('routes a team_join through handleEvent without calling auth.test', async () => {
    // getBotUserId() est un aller-retour réseau sans objet ici : la boucle
    // « le bot poste en tant qu'utilisateur » n'existe pas sur team_join.
    const deps = makeTeamJoinDeps();
    const { handler, slack } = makeHandler(deps);

    await handler.handleEvent(envelope(teamJoin(), 'Ev0JOINRUN'));

    expect(deps.sendBlocks).toHaveBeenCalledTimes(1);
    expect(slack.auth.test).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });
});

/**
 * Régression : marquer l'événement « vu » dès `accept()` le perdait DÉFINITIVEMENT quand
 * la fonction serverless était gelée en plein traitement — le rejeu Slack tombait sur la
 * clé déjà posée et était silencieusement jeté. Le cache mémorise désormais un statut.
 */
describe('SlackEventsHandler — déduplication in-flight / done', () => {
  it('drops a retry while the first attempt is still in flight (no double processing)', () => {
    const { handler } = makeHandler();
    const payload = () => envelope(dm(), 'Ev0INFLIGHT');

    expect(handler.accept(payload()).action).toBe('process');
    // handleEvent n'a pas encore rendu la main : le rejeu concurrent doit être ignoré.
    expect(handler.accept(payload(), { retryNum: '1' })).toEqual({
      action: 'ignore',
      reason: 'duplicate',
    });
  });

  it('still drops a retry once the first attempt has completed', async () => {
    const { handler } = makeHandler();
    const payload = () => envelope(dm(), 'Ev0DONE');

    expect(handler.accept(payload()).action).toBe('process');
    await handler.handleEvent(payload());

    // Statut `done` : même très longtemps après, le rejeu reste un doublon.
    expect(handler.accept(payload(), { retryNum: '1' })).toEqual({
      action: 'ignore',
      reason: 'duplicate',
    });
  });

  it('reprocesses an in-flight event abandoned past the grace period (frozen function)', () => {
    // `inFlightGraceMs: 0` simule un traitement dont la durée de vie maximale est dépassée.
    const handler = new SlackEventsHandler('xoxb-test-token', makeMastraMock().mastra, {
      slackClient: makeSlackMock() as unknown as WebClient,
      inFlightGraceMs: 0,
    });
    const payload = () => envelope(dm(), 'Ev0FROZEN');

    expect(handler.accept(payload()).action).toBe('process');
    // La fonction a été gelée : aucun `done` n'a été posé → le rejeu Slack repasse.
    expect(handler.accept(payload(), { retryNum: '1' }).action).toBe('process');
  });

  it('keeps dropping a completed event even with a zero grace period', async () => {
    const handler = new SlackEventsHandler('xoxb-test-token', makeMastraMock().mastra, {
      slackClient: makeSlackMock() as unknown as WebClient,
      inFlightGraceMs: 0,
    });
    const payload = () => envelope(dm(), 'Ev0DONE0MS');

    expect(handler.accept(payload()).action).toBe('process');
    await handler.handleEvent(payload());

    // `done` n'est jamais considéré comme abandonné : la grâce ne s'applique qu'à
    // `in-flight`. Sans cette distinction, toute réponse déjà postée serait repostée.
    expect(handler.accept(payload(), { retryNum: '1' })).toEqual({
      action: 'ignore',
      reason: 'duplicate',
    });
  });

  it('releases the dedup key when the background work rejects, so Slack can retry', async () => {
    class ExplodingHandler extends SlackEventsHandler {
      override async handleMessage(): Promise<void> {
        throw new Error('function killed mid-flight');
      }
    }
    const handler = new ExplodingHandler('xoxb-test-token', makeMastraMock().mastra, {
      slackClient: makeSlackMock() as unknown as WebClient,
    });
    const payload = () => envelope(dm(), 'Ev0BOOM');

    expect(handler.accept(payload()).action).toBe('process');
    await expect(handler.handleEvent(payload())).rejects.toThrow('function killed mid-flight');

    // La clé a été libérée : le rejeu repart immédiatement, sans attendre la grâce.
    expect(handler.accept(payload(), { retryNum: '1' }).action).toBe('process');
  });
});

describe('SlackEventsHandler — routeToAgent()', () => {
  const { handler } = makeHandler();

  it.each([
    ['peux-tu lancer le questionnaire ?', 'questionnaireEngine'],
    ['je veux une évaluation', 'questionnaireEngine'],
    ['démarre le quiz', 'questionnaireEngine'],
    ['fais passer un test technique', 'questionnaireEngine'],
    ['envoie une notification', 'notificationAgent'],
    ['programme un rappel', 'notificationAgent'],
    ['envoie un email à Jean', 'notificationAgent'],
    ['poste un message dans le canal', 'notificationAgent'],
    ['bonjour, où en est mon onboarding ?', 'onboardingOrchestrator'],
    ['', 'onboardingOrchestrator'],
  ])('routes "%s" to %s', (text, expected) => {
    expect(handler.routeToAgent(text)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(handler.routeToAgent('QUESTIONNAIRE')).toBe('questionnaireEngine');
    expect(handler.routeToAgent('RAPPEL')).toBe('notificationAgent');
  });

  it('gives questionnaire keywords priority over notification keywords', () => {
    expect(handler.routeToAgent('envoie un email avec le questionnaire')).toBe(
      'questionnaireEngine',
    );
  });

  /**
   * Régression mesurée en production le 2026-08-10.
   *
   * Le mot « email » aiguillait vers `notificationAgent`, qui ne possède ni
   * `findEmployeeByEmail` ni `createEmployee`. Or une demande de recherche par
   * email contient NÉCESSAIREMENT le mot « email » : la fonctionnalité était
   * structurellement inatteignable. Observé : « Retrouve l'identifiant de
   * l'employé dont l'email est … » → « Je n'ai pas réussi à récupérer
   * l'historique des notifications. »
   *
   * Les deux créations réussies ce jour-là ne l'ont été que parce que la
   * formulation évitait le mot — une roulette, pas un chemin fiable.
   */
  it.each([
    ["retrouve l'identifiant de l'employé dont l'email est karyl@kisso.com", 'recherche par email'],
    ['crée un employé : Awa TRAORE, email awa@kisso.com, département Product', 'création + email'],
    ["crée un employé pour un test d'intégration : Awa TRAORE", 'création + test'],
    ["quelles sont les tâches d'intégration de l'employé 123 ?", 'tâches'],
    ["génère le document de bienvenue de l'employé 123", 'document'],
  ])('routes an orchestrator intent to onboardingOrchestrator (%s)', (text) => {
    expect(handler.routeToAgent(text)).toBe('onboardingOrchestrator');
  });

  it('laisse les demandes réellement centrées sur les notifications à leur agent', () => {
    expect(handler.routeToAgent("quel est l'historique des notifications de l'employé 123 ?")).toBe(
      'notificationAgent',
    );
    expect(
      handler.routeToAgent("envoie une notification par email à l'employé 123, sujet : Bienvenue"),
    ).toBe('notificationAgent');
    expect(
      handler.routeToAgent(
        "planifie un rappel dans 3 jours pour l'employé 123 : compléter son profil",
      ),
    ).toBe('notificationAgent');
  });

  it("n'aiguille plus sur un mot-clé enchâssé à DROITE dans un mot plus long", () => {
    // La garde n'existait qu'à gauche : « rappelle », « messagerie » et
    // « testez » déclenchaient tous un détournement.
    expect(handler.routeToAgent('rappelle-toi de notre échange')).toBe('onboardingOrchestrator');
    expect(handler.routeToAgent('ouvre la messagerie interne')).toBe('onboardingOrchestrator');
  });

  it('tolère le pluriel des mots-clés', () => {
    expect(handler.routeToAgent('les emails sont-ils partis ?')).toBe('notificationAgent');
    expect(handler.routeToAgent('montre-moi les questionnaires')).toBe('questionnaireEngine');
  });

  /**
   * Régression : "test" était matché par sous-chaîne (`String.includes`), donc capturé
   * par n'importe quel mot français qui contient la séquence "test" ailleurs qu'en
   * début de mot — "conteste", "attester", "contestation", "protestation"... Ces phrases
   * courantes n'ont RIEN à voir avec un questionnaire et doivent suivre le routage par
   * défaut (onboardingOrchestrator).
   */
  it.each([
    'je conteste cette décision',
    'peux-tu attester de mon poste',
    'je veux contester ceci',
    'la contestation est en cours',
    'protestation en cours dans le service',
  ])('does not treat "%s" as a questionnaire keyword match (false positive on "test")', (text) => {
    expect(handler.routeToAgent(text)).toBe('onboardingOrchestrator');
  });

  it('still matches "test" as a standalone word, including punctuation-adjacent', () => {
    expect(handler.routeToAgent('lance le test.')).toBe('questionnaireEngine');
    expect(handler.routeToAgent('Test ?')).toBe('questionnaireEngine');
  });
});

describe('SlackEventsHandler — getBotUserId()', () => {
  it('resolves the bot user id via auth.test and caches the call', async () => {
    const { handler, slack } = makeHandler();

    await expect(handler.getBotUserId()).resolves.toBe(BOT_USER_ID);
    await expect(handler.getBotUserId()).resolves.toBe(BOT_USER_ID);

    expect(slack.auth.test).toHaveBeenCalledTimes(1);
  });

  it('returns undefined and stays retryable when auth.test fails', async () => {
    const slack = makeSlackMock({
      auth: { test: vi.fn().mockRejectedValue(new Error('invalid_auth')) },
    });
    const { handler } = makeHandler({ slack });

    await expect(handler.getBotUserId()).resolves.toBeUndefined();
    await expect(handler.getBotUserId()).resolves.toBeUndefined();
    expect(slack.auth.test).toHaveBeenCalledTimes(2);
  });
});

describe('SlackEventsHandler — handleEvent() (traitement de fond)', () => {
  it('drops an event whose author is the bot user itself', async () => {
    const { handler, slack, getAgent } = makeHandler();

    await handler.handleEvent(envelope(dm({ user: BOT_USER_ID })));

    expect(getAgent).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('routes a mention to the resolved agent, wraps the input and replies in-thread', async () => {
    const { handler, slack, getAgent, generate } = makeHandler();

    await handler.handleEvent(
      envelope(mention({ text: `<@${BOT_USER_ID}> lance le questionnaire` })),
    );

    expect(getAgent).toHaveBeenCalledWith('questionnaireEngine');
    // Le texte Slack brut ne doit plus jamais partir tel quel dans generate() : il est
    // encadré par wrapAgentInput() (délimiteurs, détection d'injection). Le wrapping est
    // déterministe pour un même texte (même session partagée par processus, cf.
    // llm-guardrail.ts), donc comparable ici bit-à-bit.
    expect(generate).toHaveBeenCalledWith(wrapAgentInput('lance le questionnaire'));
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C0MOCKCHAN',
      text: 'Réponse de l’agent',
      thread_ts: '1700000000.000100',
    });
  });

  it('routes a DM to the onboarding orchestrator and replies in the main conversation (no thread)', async () => {
    const { handler, slack, getAgent } = makeHandler();

    await handler.handleEvent(envelope(dm({ text: 'bonjour, où en est mon dossier ?' })));

    expect(getAgent).toHaveBeenCalledWith('onboardingOrchestrator');
    // DM sans thread_ts d'origine : la réponse va dans la conversation principale, pas dans
    // un thread caché — régression corrigée (thread_ts = thread_ts ?? ts enfouissait
    // systématiquement la réponse en DM, le bot a semblé silencieux pendant des heures).
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: 'D0MOCKDM01',
      text: 'Réponse de l’agent',
    });
  });

  it('replies inside the existing thread when thread_ts is present in a channel mention', async () => {
    const { handler, slack } = makeHandler();

    await handler.handleEvent(
      envelope(mention({ ts: '1700000000.000999', thread_ts: '1700000000.000100' })),
    );

    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: '1700000000.000100' }),
    );
  });

  it('keeps threading a DM that already belongs to an existing thread', async () => {
    const { handler, slack } = makeHandler();

    await handler.handleEvent(
      envelope(dm({ ts: '1700000000.000999', thread_ts: '1700000000.000100' })),
    );

    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'D0MOCKDM01', thread_ts: '1700000000.000100' }),
    );
  });

  it('posts a fallback message when the agent is not registered', async () => {
    const getAgent = vi.fn().mockReturnValue(undefined);
    const slack = makeSlackMock();
    const handler = new SlackEventsHandler('xoxb-test-token', { getAgent } as unknown as Mastra, {
      slackClient: slack as unknown as WebClient,
    });

    await handler.handleEvent(envelope(dm()));

    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('non disponible') }),
    );
  });

  it('never throws when the agent generation fails, and posts an error message', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('LLM timeout'));
    const getAgent = vi.fn().mockReturnValue({ generate });
    const slack = makeSlackMock();
    const handler = new SlackEventsHandler('xoxb-test-token', { getAgent } as unknown as Mastra, {
      slackClient: slack as unknown as WebClient,
    });

    await expect(handler.handleEvent(envelope(dm()))).resolves.toBeUndefined();
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('une erreur') }),
    );
  });

  it('swallows a Slack posting failure instead of producing an unhandled rejection', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('LLM timeout'));
    const getAgent = vi.fn().mockReturnValue({ generate });
    const slack = makeSlackMock({
      chat: { postMessage: vi.fn().mockRejectedValue(new Error('channel_not_found')) },
    });
    const handler = new SlackEventsHandler('xoxb-test-token', { getAgent } as unknown as Mastra, {
      slackClient: slack as unknown as WebClient,
    });

    await expect(handler.handleEvent(envelope(dm()))).resolves.toBeUndefined();
  });
});

describe('SlackEventsHandler — handleUrlVerification()', () => {
  it('echoes the challenge', async () => {
    const { handler } = makeHandler();
    await expect(
      handler.handleUrlVerification({ type: 'url_verification', challenge: 'abc123' }),
    ).resolves.toEqual({ challenge: 'abc123' });
  });
});
