import { describe, it, expect, beforeEach } from 'vitest';

import { makeGetUserConversations } from '../../../src/features/knowledge/application/tools/get-user-conversations';
import { InMemoryBotMemoryRepository } from '../../../src/features/knowledge/infrastructure/repositories/in-memory-bot-memory.repository';
import { InMemoryDirectoryRepository } from '../../../src/features/directory/infrastructure/repositories/in-memory-directory.repository';
import type { DirectoryMemberFacts } from '../../../src/features/directory/domain/entities/directory-member';
import type { BotMemoryTurn } from '../../../src/features/knowledge/domain/ports/bot-memory.repository';
import { buildSlackRequestContext } from '../../../src/shared/slack-request-context';

/**
 * `getUserConversations` — la mémoire propre du bot.
 *
 * Deux propriétés sont sous surveillance ici, et elles ne se recouvrent pas :
 * l'autorisation (qui peut lire les échanges de qui) et le CÂBLAGE de la
 * résolution d'identité — c'est ce dernier qui a produit, trois fois dans ce
 * dépôt, la boucle « donne-moi son identifiant » → « je ne l'ai pas ».
 */

const HR = 'U0HR12345';
const GUEST = 'U0GUEST123';
const TARGET = 'U0AWA1234';

const HR_DM = 'D_HR';
const TARGET_DM = 'D_AWA';

const POLICY = { orgEmailDomains: ['kissohq.com'] };
const NOW = new Date('2026-08-12T09:00:00.000Z');

function facts(overrides: Partial<DirectoryMemberFacts> & { slackUserId: string }) {
  return {
    teamId: 'TMLKC4EPP',
    email: null,
    realName: '',
    displayName: '',
    isBot: false,
    isAdmin: false,
    isRestricted: false,
    isUltraRestricted: false,
    isDeleted: false,
    ...overrides,
  } satisfies DirectoryMemberFacts;
}

function turn(role: 'user' | 'assistant', text: string, minutesAgo: number): BotMemoryTurn {
  return {
    role,
    text,
    slackUserId: role === 'user' ? TARGET : null,
    at: new Date(NOW.getTime() - minutesAgo * 60_000),
  };
}

let directory: InMemoryDirectoryRepository;
let memory: InMemoryBotMemoryRepository;

beforeEach(async () => {
  directory = new InMemoryDirectoryRepository();
  memory = new InMemoryBotMemoryRepository();

  await directory.upsertFacts(
    facts({ slackUserId: HR, email: 'rh@kissohq.com', displayName: 'RH' }),
    NOW,
  );
  await directory.rememberDmChannel(HR, HR_DM);

  await directory.upsertFacts(
    facts({
      slackUserId: GUEST,
      email: 'invite@kissohq.com',
      displayName: 'Invité',
      isRestricted: true,
      isUltraRestricted: true,
    }),
    NOW,
  );

  await directory.upsertFacts(
    facts({ slackUserId: TARGET, email: 'awa@kissohq.com', displayName: 'Awa' }),
    NOW,
  );
  await directory.rememberDmChannel(TARGET, TARGET_DM);

  memory.seed(TARGET_DM, [
    turn('user', 'je commence lundi, quel matériel ?', 30),
    turn('assistant', 'un MacBook t’attend le premier jour', 29),
  ]);
});

type Result = {
  found: boolean;
  reason?: string;
  hint?: string;
  conversation?: string;
  shown?: number;
  scanned?: number;
};

async function run(
  person: string | undefined,
  requesterId?: string,
  channel = 'D_HR',
): Promise<Result> {
  const ctx = requesterId
    ? { requestContext: buildSlackRequestContext({ channel, slackUserId: requesterId }) }
    : {};

  const input = person === undefined ? {} : { person };

  return (await makeGetUserConversations({ directory, memory, policy: POLICY }).execute!(
    input as never,
    ctx as never,
  )) as Result;
}

describe('getUserConversations — résolution de la personne', () => {
  it('accepte un EMAIL — le câblage qui manquait', async () => {
    // Un humain ne connaît pas le `U…` de ses collègues, et le modèle non plus.
    // La boucle « donne-moi son identifiant » était garantie par le câblage.
    const result = await run('awa@kissohq.com', HR);

    expect(result.found).toBe(true);
    expect(result.conversation).toContain('MacBook');
  });

  it('accepte un identifiant Slack, casse indifférente', async () => {
    expect((await run(TARGET.toLowerCase(), HR)).found).toBe(true);
  });

  it('sans argument, répond sur la personne qui parle — zéro aller-retour', async () => {
    memory.seed(HR_DM, [turn('user', 'où en est le dossier ?', 10)]);

    const result = await run(undefined, HR);

    expect(result.found).toBe(true);
    expect(result.conversation).toContain('dossier');
  });

  it('refuse un nom propre plutôt que de deviner qui est visé', async () => {
    const result = await run('Awa', HR);

    // Deviner désignerait la mauvaise personne EN SILENCE — le pire des deux.
    expect(result.reason).toBe('person_not_resolved');
    expect(result.hint).toContain('identifiant Slack');
  });

  it('distingue « personne inconnue » de « aucun échange »', async () => {
    await directory.upsertFacts(
      facts({ slackUserId: 'U0SILENT1', email: 'muet@kissohq.com' }),
      NOW,
    );

    // `getTaskList` rendait `{tasks: [], total: 0}` pour un identifiant qui ne
    // désignait personne : le modèle en concluait « aucune tâche en cours ».
    expect((await run('inconnu@kissohq.com', HR)).reason).toBe('person_not_found');
    expect((await run('muet@kissohq.com', HR)).reason).toBe('no_recorded_conversation');
  });
});

describe('getUserConversations — autorisation', () => {
  it("REFUSE à un invité les échanges d'un tiers", async () => {
    const result = await run('awa@kissohq.com', GUEST);

    expect(result.found).toBe(false);
    expect(result.reason).toBe('insufficient_privilege');
    expect(JSON.stringify(result)).not.toContain('MacBook');
  });

  it('AUTORISE ce même invité sur ses PROPRES échanges', async () => {
    await directory.rememberDmChannel(GUEST, 'D_GUEST');
    memory.seed('D_GUEST', [turn('user', 'comment je récupère mon badge ?', 5)]);

    const result = await run(undefined, GUEST, 'D_GUEST');

    expect(result.found).toBe(true);
    expect(result.conversation).toContain('badge');
  });

  it('REFUSE hors contexte Slack, au lieu de dégrader', async () => {
    const result = await run('awa@kissohq.com');

    // Dégrader ici rendrait toutes les conversations lisibles depuis le
    // playground, c'est-à-dire depuis un chemin sans authentification.
    expect(result.found).toBe(false);
    expect(result.reason).toBe('no_requester');
  });

  it('sert le DM courant à un demandeur que l’annuaire ne connaît pas encore', async () => {
    memory.seed('D_NEW', [turn('user', 'bonjour, je suis nouveau', 2)]);

    const result = await run(undefined, 'U0NEW9999', 'D_NEW');

    // Il lit ce qu'il vient lui-même d'écrire : aucun privilège n'est accordé,
    // seule l'identité du `requestContext` est utilisée.
    expect(result.found).toBe(true);
    expect(result.conversation).toContain('nouveau');
  });
});

describe('getUserConversations — restitution', () => {
  it('encadre le contenu en données NON FIABLES', async () => {
    const result = await run('awa@kissohq.com', HR);

    expect(result.conversation).toContain('[UNTRUSTED EXTERNAL DATA');
    expect(result.conversation).toMatch(/<kisso_[0-9a-f]+_external_data>/);
  });

  it('borne la sortie quel que soit le volume de la conversation', async () => {
    memory.seed(
      TARGET_DM,
      Array.from({ length: 500 }, (_, index) => turn('user', `message ${index}`, index)),
    );

    const result = await run('awa@kissohq.com', HR);

    expect(result.shown).toBe(6);
    expect(result.scanned).toBeLessThanOrEqual(40);
    expect(result.conversation!.length).toBeLessThan(2_500);
  });

  it('dégrade proprement quand la mémoire est indisponible', async () => {
    const broken = {
      recentDirectTurns: async () => {
        throw new Error('turso down');
      },
    };

    const result = (await makeGetUserConversations({
      directory,
      memory: broken,
      policy: POLICY,
    }).execute!(
      { person: 'awa@kissohq.com' } as never,
      {
        requestContext: buildSlackRequestContext({ channel: 'D_HR', slackUserId: HR }),
      } as never,
    )) as Result;

    expect(result.reason).toBe('memory_unavailable');
    expect(result.hint).toContain('Réessayer');
  });
});
