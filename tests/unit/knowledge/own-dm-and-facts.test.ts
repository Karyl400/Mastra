import { describe, it, expect, vi } from 'vitest';

import { makeSearchKnowledge } from '../../../src/features/knowledge/application/tools/search-knowledge';
import { KnowledgeIngestionService } from '../../../src/features/knowledge/application/services/knowledge-ingestion.service';
import { CURTAIN_WINDOW_MS } from '../../../src/features/knowledge/application/services/fact-curtain.service';
import { InMemoryMessageArchiveRepository } from '../../../src/features/knowledge/infrastructure/repositories/in-memory-message-archive.repository';
import { InMemoryKnowledgeFactRepository } from '../../../src/features/knowledge/infrastructure/repositories/in-memory-knowledge-fact.repository';
import { ChannelUnavailableError } from '../../../src/features/knowledge/domain/ports/channel-history.port';
import type { ChannelHistoryPort } from '../../../src/features/knowledge/domain/ports/channel-history.port';
import type {
  DirectoryPerson,
  PersonDirectoryPort,
} from '../../../src/features/knowledge/domain/ports/person-directory.port';
import { buildSlackRequestContext } from '../../../src/shared/slack-request-context';

/**
 * 2026-10-18 — deux défauts de la mémoire, trouvés en sondant `knowledgeAgent` en production.
 *
 * 1. **Un salarié ne retrouvait pas SON PROPRE DM.** `readableChannels` tranchait un DM par
 *    `conversations.members`, qui exige `im:read` — scope que l'app n'a pas. Journal de
 *    production : `conversations.members a échoué … missing_scope` sur `D0BM9MK9QJV`. L'erreur
 *    était avalée en `false` : seul le manager lisait un DM. La règle écrite dans CLAUDE.md
 *    (« son propre DM toujours ») n'était donc pas appliquée.
 *
 * 2. **Les DM adressés au bot étaient distillés en « faits » d'équipe.** Sur 9 faits en base,
 *    6 étaient des commandes de test du propriétaire (« annule le rappel de jeudi »,
 *    « Retrouve le profil de… ») rangées comme des ÉCHÉANCES. Une commande au bot n'est pas un
 *    savoir d'équipe, et elle ressortait de « qu'est-ce qui a été décidé récemment ? ».
 */

const ME = 'U0ME000001';
const OTHER = 'U0OTHER001';
const MANAGER = 'U0MANAGER1';
const MY_DM = 'D0MYDM0001';
const OTHER_DM = 'D0OTHERDM1';
const HQ = 'C0KISSOHQ1';

const person = (id: string, isManager = false): DirectoryPerson => ({
  slackUserId: id,
  displayName: id,
  email: null,
  dmChannelId: null,
  isBot: false,
  isRestricted: false,
  isUltraRestricted: false,
  isDeleted: false,
  isManager,
});

function setup() {
  const archive = new InMemoryMessageArchiveRepository();
  const facts = new InMemoryKnowledgeFactRepository();
  const ingestion = new KnowledgeIngestionService({ archive, facts });

  const directory: PersonDirectoryPort = {
    findBySlackUserId: async (id) => person(id, id === MANAGER),
    findByEmail: async () => null,
  };

  // Slack tel qu'il est en production : sans `im:read`, `conversations.members` REFUSE un DM.
  const channels = {
    isMember: vi.fn(async (channelId: string) => {
      if (channelId.startsWith('D')) {
        throw new ChannelUnavailableError('unavailable', 'missing_scope');
      }
      return true;
    }),
    listMemberChannels: vi.fn(async () => []),
    listVisibleChannels: vi.fn(async () => ({ mine: [], others: [] })),
    fetchRecent: vi.fn(async () => []),
  } as unknown as ChannelHistoryPort;

  const tool = makeSearchKnowledge({ directory, facts, archive, channels });
  return { tool, ingestion, archive, facts, channels };
}

const ask = async (tool: ReturnType<typeof setup>['tool'], query: string, who: string) =>
  (await tool.execute!(
    { query } as never,
    {
      requestContext: buildSlackRequestContext({ channel: 'D0ASKER001', slackUserId: who }),
    } as never,
  )) as { found: boolean; reason?: string; knowledge?: string };

const say = (
  ingestion: KnowledgeIngestionService,
  channelId: string,
  slackUserId: string,
  text: string,
  at = Date.now(),
) =>
  ingestion.ingest({
    id: `${channelId}:${at}`,
    channelId,
    slackUserId,
    text,
    threadTs: null,
    postedAt: at,
  });

describe('un salarié retrouve son PROPRE DM, sans que Slack ait à le prouver', () => {
  it('un non-manager retrouve ce qu’il a écrit dans son DM', async () => {
    const { tool, ingestion } = setup();
    await say(ingestion, MY_DM, ME, 'Je préfère travailler le matin sur la facturation');

    const out = await ask(tool, 'facturation', ME);

    expect(out.found).toBe(true);
    expect(String(out.knowledge)).toContain('facturation');
  });

  it('mais PAS le DM de quelqu’un d’autre', async () => {
    const { tool, ingestion } = setup();
    await say(ingestion, OTHER_DM, OTHER, 'Mon salaire pose un problème de facturation');

    const out = await ask(tool, 'facturation', ME);

    expect(out.found).toBe(false);
    expect(JSON.stringify(out)).not.toContain('salaire');
  });

  it('le manager lit toujours les DM d’autrui — décision assumée du 2026-08-21', async () => {
    const { tool, ingestion } = setup();
    await say(ingestion, OTHER_DM, OTHER, 'Un souci de facturation à signaler');

    const out = await ask(tool, 'facturation', MANAGER);

    expect(out.found).toBe(true);
  });

  it('un canal ordinaire reste tranché par l’appartenance, comme avant', async () => {
    const { tool, ingestion, channels } = setup();
    await say(ingestion, HQ, OTHER, 'Point facturation mardi');

    const out = await ask(tool, 'facturation', ME);

    expect(out.found).toBe(true);
    expect(channels.isMember).toHaveBeenCalledWith(HQ, ME);
  });

  it('ne demande JAMAIS à Slack l’appartenance à un DM — l’appel n’aboutirait pas', async () => {
    const { tool, ingestion, channels } = setup();
    await say(ingestion, MY_DM, ME, 'Une note sur la facturation');

    await ask(tool, 'facturation', ME);

    const askedAboutDm = vi
      .mocked(channels.isMember)
      .mock.calls.some(([channelId]) => String(channelId).startsWith('D'));
    expect(askedAboutDm).toBe(false);
  });
});

describe('un DM adressé au bot n’est pas un savoir d’équipe', () => {
  it('une « décision » dite en DM est archivée mais PAS distillée en fait', async () => {
    const { ingestion, facts, archive } = setup();
    await say(ingestion, MY_DM, ME, 'On a décidé de partir sur Postgres pour la base');

    expect(await facts.search('Postgres', {})).toHaveLength(0);
    expect(await archive.search('Postgres', {})).toHaveLength(1);
  });

  it('la même phrase dans un CANAL produit bien un fait', async () => {
    const { ingestion, facts } = setup();
    await say(ingestion, HQ, ME, 'On a décidé de partir sur Postgres pour la base');

    expect(await facts.search('Postgres', {})).toHaveLength(1);
  });

  it('un DM n’entre pas dans les lots du second rideau — le texte ne part pas chez un tiers', async () => {
    const { ingestion, archive } = setup();
    // Phrase SANS motif reconnu par le code : c'est celle qui, avant, restait « en attente »
    // et partait au modèle avec les quatre autres du lot.
    await say(ingestion, MY_DM, ME, 'Une simple note personnelle sur ma semaine');

    expect(await archive.findPendingDistillation(CURTAIN_WINDOW_MS, 10)).toHaveLength(0);
  });
});
