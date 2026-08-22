import { describe, expect, it, vi } from 'vitest';
import type { Mastra } from '@mastra/core';
import { SlackEventsHandler } from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
/**
 * ⚠️ Deux aides ont été RETIRÉES d'ici le 2026-08-22 : `decodePrefill` et `buttonValueOf`, qui
 * lisaient le `value` du bouton « Compléter mon profil » posté par le DM d'accueil. Elles
 * n'étaient plus appelées par aucun test, et la raison est en amont : `buildWelcomeBlocks` a
 * cessé d'émettre le moindre bouton le 2026-08-19, quand les modales sont tombées (le
 * `trigger_id` expire en 3 s, et sur une fonction froide le clic arrive trop tard). Il n'y a
 * donc plus de `value` à décoder — ce n'est pas une assertion perdue, c'est une surface
 * disparue. Ce que le DM d'accueil transporte se vérifie désormais sur son TEXTE — tous les
 * tests ci-dessous sérialisent les blocs postés et lisent la chaîne obtenue.
 */

/** Forme minimale d'un bloc Slack : ces tests ne font que le sérialiser. */
type SlackBlockLike = Record<string, unknown>;

/** Sous-ensemble de `DirectoryMemberFacts` réellement inspecté ici. */
interface DirectoryFactsLike {
  slackUserId: string;
  email: string | null;
  firstName: string | null;
}

/**
 * ⚠️ Les TROIS dépendances qui touchent la base sont neutralisées — `conversationRepository`,
 * `dedupRepository` et `rateLimiter`. Sans cela, tout handler construit à la main fabrique un
 * `DrizzleRateLimitRepository` : compteurs partagés entre tests, persistés d'un run à l'autre.
 * `directoryRepository` est ici une doublure, donc déjà couvert.
 */
function makeHandler(overrides: Record<string, unknown> = {}) {
  // Les signatures sont DÉCLARÉES : `vi.fn(async () => …)` produit un tuple d'arguments vide,
  // et toute lecture de `mock.calls[0][n]` devient alors une erreur de compilation.
  const sendBlocks =
    vi.fn<(channel: string, text: string, blocks: SlackBlockLike[]) => Promise<void>>();
  const upsertFacts = vi.fn<(facts: DirectoryFactsLike, now: Date) => Promise<void>>();
  const run = vi.fn(async () => ({
    outcome: 'completed' as const,
    joinedNames: ['kisso-hq', 'random'],
    failures: [],
  }));

  const handler = new SlackEventsHandler('xoxb-test', {} as Mastra, {
    chatProvider: { sendBlocks } as never,
    workspaceProvider: {
      getUserById: vi.fn(async () => ({
        id: 'U_NEW',
        email: 'lea@kisso.com',
        firstName: 'Léa',
        lastName: 'Bamba',
        teamId: 'T1',
      })),
    } as never,
    directoryRepository: {
      upsertFacts,
      findBySlackUserId: vi.fn(async () => null),
      findByEmail: vi.fn(async () => null),
      rememberDmChannel: vi.fn(async () => undefined),
      linkEmployee: vi.fn(async () => undefined),
      listAll: vi.fn(async () => []),
    } as never,
    welcomeChannels: { run } as never,
    conversationRepository: null,
    dedupRepository: null,
    rateLimiter: null,
    accessGuard: null,
    ...overrides,
  });

  return { handler, sendBlocks, upsertFacts, run };
}

const EVENT = {
  type: 'team_join' as const,
  user: {
    id: 'U_NEW',
    profile: { first_name: 'Léa', last_name: 'Bamba', email: 'lea@kisso.com' },
  },
};

describe('handleTeamJoin', () => {
  it("écrit l'arrivant dans l'annuaire dès la seconde zéro", async () => {
    const { handler, upsertFacts } = makeHandler();
    await handler.handleTeamJoin(EVENT as never);

    expect(upsertFacts).toHaveBeenCalledTimes(1);
    const facts = upsertFacts.mock.calls[0]![0];
    expect(facts.slackUserId).toBe('U_NEW');
    expect(facts.email).toBe('lea@kisso.com');
    expect(facts.firstName).toBe('Léa');
  });

  it("invite dans les canaux d'accueil", async () => {
    const { handler, run } = makeHandler();
    await handler.handleTeamJoin(EVENT as never);
    expect(run).toHaveBeenCalledWith('U_NEW');
  });

  it("n'expose AUCUN bouton, et ne transporte donc plus aucune donnée personnelle", async () => {
    // ⚠️ 2026-08-19. Ce test vérifiait que le `value` du bouton transportait `joinedAt` et
    // l'email. Les boutons ont été retirés du parcours ; la date d'arrivée vient désormais de
    // `slack_directory.first_seen_at`, que `upsertFacts` pose au `team_join`. C'est la MÊME
    // information par un chemin plus robuste : elle ne quitte jamais le serveur, donc rien ne
    // peut la falsifier ni la perdre en route.
    const { handler, sendBlocks } = makeHandler();
    await handler.handleTeamJoin(EVENT as never);

    const json = JSON.stringify(sendBlocks.mock.calls[0]![2]);
    expect(json).not.toContain('action_id');
    expect(json).not.toContain('button');
    expect(json).not.toContain('lea@kisso.com');
  });

  it("le DM part MÊME si l'invitation aux canaux échoue entièrement", async () => {
    const { handler, sendBlocks } = makeHandler({
      welcomeChannels: {
        run: vi.fn(async () => {
          throw new Error('slack down');
        }),
      },
    });

    await handler.handleTeamJoin(EVENT as never);
    expect(sendBlocks).toHaveBeenCalledTimes(1);
  });

  it("le DM part MÊME si l'écriture dans l'annuaire échoue", async () => {
    const { handler, sendBlocks } = makeHandler({
      directoryRepository: {
        upsertFacts: vi.fn(async () => {
          throw new Error('turso down');
        }),
        findBySlackUserId: vi.fn(async () => null),
        findByEmail: vi.fn(async () => null),
        rememberDmChannel: vi.fn(async () => undefined),
        linkEmployee: vi.fn(async () => undefined),
        listAll: vi.fn(async () => []),
      },
    });

    await handler.handleTeamJoin(EVENT as never);
    expect(sendBlocks).toHaveBeenCalledTimes(1);
  });

  it('cite les canaux rejoints dans le message de bienvenue', async () => {
    const { handler, sendBlocks } = makeHandler();
    await handler.handleTeamJoin(EVENT as never);

    const blocks = JSON.stringify(sendBlocks.mock.calls[0]![2]);
    expect(blocks).toContain('#kisso-hq');
    expect(blocks).toContain('#random');
  });

  it("ne cite aucun canal quand aucun n'a abouti", async () => {
    const { handler, sendBlocks } = makeHandler({
      welcomeChannels: {
        run: vi.fn(async () => ({ outcome: 'not_configured', joinedNames: [], failures: [] })),
      },
    });

    await handler.handleTeamJoin(EVENT as never);
    expect(JSON.stringify(sendBlocks.mock.calls[0]![2])).not.toContain('#');
  });

  it('ne fait rien sans identifiant Slack', async () => {
    const { handler, sendBlocks, upsertFacts, run } = makeHandler();
    await handler.handleTeamJoin({ type: 'team_join', user: {} } as never);

    expect(sendBlocks).not.toHaveBeenCalled();
    expect(upsertFacts).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("n'invite dans aucun canal quand le service est absent", async () => {
    const { handler, sendBlocks } = makeHandler({ welcomeChannels: null });
    await handler.handleTeamJoin(EVENT as never);

    expect(sendBlocks).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sendBlocks.mock.calls[0]![2])).not.toContain('#');
  });
});
