import { describe, it, expect, vi, beforeEach } from 'vitest';

import { makeSearchKnowledge } from '../../../src/features/knowledge/application/tools/search-knowledge';
import { InMemoryMessageArchiveRepository } from '../../../src/features/knowledge/infrastructure/repositories/in-memory-message-archive.repository';
import { InMemoryKnowledgeFactRepository } from '../../../src/features/knowledge/infrastructure/repositories/in-memory-knowledge-fact.repository';
import { KnowledgeIngestionService } from '../../../src/features/knowledge/application/services/knowledge-ingestion.service';
import type { PersonDirectoryPort } from '../../../src/features/knowledge/domain/ports/person-directory.port';
import type { ChannelHistoryPort } from '../../../src/features/knowledge/domain/ports/channel-history.port';
import { buildSlackRequestContext } from '../../../src/shared/slack-request-context';

/**
 * LA RECHERCHE — ce que l'agent lit à la demande, et ce qu'il ne peut pas lire.
 *
 * Deux frontières, et elles ne se recouvrent pas :
 *   1. l'APPARTENANCE AU CANAL, qui vaut pour tout le monde, manager compris. L'archive
 *      contient les canaux PRIVÉS où le bot est invité ; sans ce filtre une recherche rendrait
 *      leur contenu à quelqu'un qui n'y est pas, ce que `getChannelHistory` refuse déjà ;
 *   2. la RECHERCHE NOMINATIVE, réservée au manager. Chercher « ce que X a dit » est une
 *      question sur une PERSONNE, pas sur un sujet.
 */

const MANAGER = 'U0MANAGER1';
const EMPLOYEE = 'U0EMPLOYE1';
const PUBLIC_CHANNEL = 'C0KISSOHQ1';
const PRIVATE_CHANNEL = 'G0PRIVE001';

const DECISION = 'On a décidé de reporter la migration à jeudi';

function person(slackUserId: string, isManager: boolean) {
  return {
    slackUserId,
    email: `${slackUserId.toLowerCase()}@kissohq.com`,
    displayName: isManager ? 'Nazer A.' : 'Karyl S.',
    isBot: false,
    isRestricted: false,
    isUltraRestricted: false,
    isDeleted: false,
    isManager,
  };
}

function makeTool(
  options: {
    memberOf?: readonly string[];
    /** Ce que Slack rendrait si on le relisait EN DIRECT, canal par canal. */
    live?: Readonly<Record<string, readonly { text: string; authorId: string }[]>>;
  } = {},
) {
  const archive = new InMemoryMessageArchiveRepository();
  const facts = new InMemoryKnowledgeFactRepository();
  const ingestion = new KnowledgeIngestionService({ archive, facts });

  const memberOf = new Set(options.memberOf ?? [PUBLIC_CHANNEL, PRIVATE_CHANNEL]);

  const directory = {
    findBySlackUserId: vi.fn(async (id: string) =>
      id === MANAGER ? person(MANAGER, true) : id === EMPLOYEE ? person(EMPLOYEE, false) : null,
    ),
    findByEmail: vi.fn(async (email: string) =>
      email === person(EMPLOYEE, false).email ? person(EMPLOYEE, false) : null,
    ),
  } as unknown as PersonDirectoryPort;

  // ⚠️ `listMemberChannels` est DÉRIVÉ de `memberOf`, jamais d'une seconde liste : c'est cette
  // doublure qui décide quels canaux la lecture en direct balaie, et deux sources divergeraient
  // — le test verrouillerait alors une frontière que la production n'applique pas.
  const channels = {
    isMember: vi.fn(async (channelId: string) => memberOf.has(channelId)),
    listMemberChannels: vi.fn(async (_id: string, limit: number) =>
      [...memberOf]
        .filter((c) => !c.startsWith('D'))
        .slice(0, limit)
        .map((id) => ({ id, name: id.toLowerCase() })),
    ),
    fetchRecent: vi.fn(async (channelId: string) =>
      (options.live?.[channelId] ?? []).map((m) => ({
        authorId: m.authorId,
        authorLabel: m.authorId,
        text: m.text,
        at: new Date('2026-08-20T10:00:00.000Z'),
        isBot: false,
      })),
    ),
  } as unknown as ChannelHistoryPort;

  const tool = makeSearchKnowledge({ directory, facts, archive, channels });

  return { tool, ingestion, archive, facts, directory, channels };
}

function context(slackUserId: string) {
  return {
    requestContext: buildSlackRequestContext({ channel: 'D0DIRECT01', slackUserId }),
  } as never;
}

async function run(tool: ReturnType<typeof makeTool>['tool'], input: object, who: string) {
  return (await tool.execute!(input as never, context(who))) as Record<string, unknown>;
}

async function seed(
  ingestion: KnowledgeIngestionService,
  overrides: Partial<{
    id: string;
    channelId: string;
    slackUserId: string;
    text: string;
    postedAt: number;
  }> = {},
) {
  await ingestion.ingest({
    id: overrides.id ?? `${PUBLIC_CHANNEL}:1700000000.000100`,
    channelId: overrides.channelId ?? PUBLIC_CHANNEL,
    slackUserId: overrides.slackUserId ?? EMPLOYEE,
    text: overrides.text ?? DECISION,
    threadTs: null,
    postedAt: overrides.postedAt ?? Date.parse('2026-08-18T09:00:00Z'),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('searchKnowledge — ce qui est rendu', () => {
  it('rend le fait DÉJÀ mis en forme, sans relire le canal', async () => {
    const { tool, ingestion, channels } = makeTool();
    await seed(ingestion);

    const result = await run(tool, { query: 'migration' }, EMPLOYEE);

    expect(result.found).toBe(true);
    expect(result.tier).toBe('facts');
    expect(String(result.knowledge)).toContain('Décision —');
    expect(String(result.knowledge)).toContain('reporter la migration');
    // ⚠️ La promesse du niveau 2 : à la demande, on LIT une ligne écrite à l'ingestion.
    expect(channels.fetchRecent).not.toHaveBeenCalled();
  });

  it('nomme la personne, jamais son identifiant Slack', async () => {
    const { tool, ingestion } = makeTool();
    await seed(ingestion);

    const result = await run(tool, { query: 'migration' }, EMPLOYEE);

    expect(String(result.knowledge)).toContain('Karyl S.');
    expect(String(result.knowledge)).not.toContain(EMPLOYEE);
  });

  it('retombe sur les messages bruts quand aucun fait ne correspond', async () => {
    const { tool, ingestion } = makeTool();
    await seed(ingestion, { text: 'je passe au bureau ce matin' });

    const result = await run(tool, { query: 'bureau' }, EMPLOYEE);

    expect(result.found).toBe(true);
    expect(result.tier).toBe('messages');
  });

  it('dit qu’il ne sait rien plutôt que de combler — quand Slack non plus ne sait rien', async () => {
    const { tool } = makeTool();

    const result = await run(tool, { query: 'kubernetes' }, EMPLOYEE);

    expect(result.found).toBe(false);
    expect(result.reason).toBe('nothing_known');
  });

  /**
   * ════════════════════════════════════════════════════════════════════════
   * LIRE SLACK AVANT DE PRÉTENDRE NE RIEN SAVOIR
   * ════════════════════════════════════════════════════════════════════════
   *
   * ⚠️ Ce repli n'existait pas avant le 2026-08-21 : `nothing_known` portait un `hint` invitant
   * le modèle à appeler `getChannelHistory`. Une CONSIGNE — et ce dépôt en a mesuré cinq en
   * échec. Pire, les deux niveaux de la base étaient VIDES en production (0 ligne dans
   * `channel_messages` et `knowledge_facts`) : `nothing_known` était la seule réponse que cet
   * outil savait rendre, et rien ne le signalait.
   *
   * « Rien en base » et « rien n'a été dit » sont deux choses différentes. La réponse les
   * confondait.
   */
  it('RELIT le canal en direct quand la base est vide, et le trouve', async () => {
    const { tool } = makeTool({
      live: {
        [PUBLIC_CHANNEL]: [{ text: 'on part sur kubernetes en octobre', authorId: MANAGER }],
      },
    });

    const result = await run(tool, { query: 'kubernetes' }, EMPLOYEE);

    expect(result.found).toBe(true);
    expect(result.tier).toBe('live');
    expect(String(result.knowledge)).toContain('kubernetes');
  });

  it('la couverture DIT que la lecture était directe — la provenance change la conclusion', async () => {
    const { tool } = makeTool({
      live: { [PUBLIC_CHANNEL]: [{ text: 'on part sur kubernetes', authorId: MANAGER }] },
    });

    const result = await run(tool, { query: 'kubernetes' }, EMPLOYEE);

    expect(String(result.knowledge)).toMatch(/relire|relu|à l’instant|dernier mois/i);
  });

  it('ne balaie QUE les canaux du demandeur — la frontière tient par construction', async () => {
    // Le canal privé existe et contient la réponse, mais le demandeur n'en est pas membre : il
    // n'entre même pas dans la liste balayée, donc il n'y a rien à filtrer après coup.
    const { tool, channels } = makeTool({
      memberOf: [PUBLIC_CHANNEL],
      live: { [PRIVATE_CHANNEL]: [{ text: 'secret kubernetes', authorId: MANAGER }] },
    });

    const result = await run(tool, { query: 'kubernetes' }, EMPLOYEE);

    expect(result.found).toBe(false);
    expect(result.reason).toBe('nothing_known');
    expect(channels.fetchRecent).not.toHaveBeenCalledWith(PRIVATE_CHANNEL, expect.anything());
  });

  it('la base PRIME : quand elle répond, aucune lecture en direct n’a lieu', async () => {
    // Le chemin nominal ne paie rien. C'est la même règle que `settlesWithoutModel`, qui ne vit
    // qu'après un refus : on ne fait grossir que le chemin rare.
    const { tool, ingestion, channels } = makeTool();
    await seed(ingestion);

    const result = await run(tool, { query: 'migration' }, EMPLOYEE);

    expect(result.found).toBe(true);
    expect(channels.fetchRecent).not.toHaveBeenCalled();
  });

  it('un canal illisible est SAUTÉ, il ne fait pas échouer la recherche', async () => {
    const { tool, channels } = makeTool({
      live: { [PUBLIC_CHANNEL]: [{ text: 'kubernetes', authorId: MANAGER }] },
    });
    (channels.fetchRecent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('slack down'),
    );

    const result = await run(tool, { query: 'kubernetes' }, EMPLOYEE);

    // Le pire cas reste « je ne sais pas » — exactement la réponse d'avant le repli.
    expect(result.found).toBe(false);
  });

  it('encadre le texte retrouvé comme une DONNÉE non fiable', async () => {
    const { tool, ingestion } = makeTool();
    await seed(ingestion);

    const result = await run(tool, { query: 'migration' }, EMPLOYEE);

    expect(String(result.knowledge)).toContain('UNTRUSTED');
  });

  it('rend une taille INDÉPENDANTE du volume ingéré', async () => {
    // La propriété qui compte n'est pas le chiffre mais l'indépendance : le tool-result entre
    // dans l'historique et est réémis à CHAQUE aller-retour suivant. S'il grandit avec la base,
    // le budget se dégrade tout seul à mesure que le produit sert.
    async function measure(messages: number) {
      const { tool, ingestion } = makeTool();
      for (let i = 0; i < messages; i += 1) {
        await seed(ingestion, {
          id: `${PUBLIC_CHANNEL}:17000000${String(i).padStart(3, '0')}.000100`,
          text: `On a décidé de reporter la migration numéro ${i} ${'très longuement '.repeat(20)}`,
          postedAt: Date.parse('2026-08-18T09:00:00Z') + i * 1000,
        });
      }
      const result = await run(tool, { query: 'migration' }, EMPLOYEE);
      return JSON.stringify(result).length;
    }

    const peu = await measure(6);
    const beaucoup = await measure(200);

    // Pas d'égalité au caractère près : le nombre de correspondances est annoncé, et il tient
    // en quelques chiffres. Ce qui compte est qu'il ne PROPORTIONNE pas — 200 messages coûtent
    // ce que 6 coûtent, à la marge d'un compteur près.
    expect(Math.abs(beaucoup - peu)).toBeLessThan(50);

    // Même enveloppe que `getChannelHistory` : 6 lignes de 180 caractères plus la bannière.
    // Cet outil ne coûte donc pas plus cher que la lecture directe qu'il remplace.
    expect(Math.round(beaucoup / 3.5), `tool-result de ${beaucoup} caractères`).toBeLessThan(550);
  });
});

describe('searchKnowledge — l’appartenance au canal', () => {
  it('n’expose PAS un canal privé à qui n’en est pas membre', async () => {
    const { tool, ingestion } = makeTool({ memberOf: [PUBLIC_CHANNEL] });
    await seed(ingestion, {
      id: `${PRIVATE_CHANNEL}:1700000000.000200`,
      channelId: PRIVATE_CHANNEL,
    });

    const result = await run(tool, { query: 'migration' }, EMPLOYEE);

    expect(result.found).toBe(false);
    expect(result.reason).toBe('no_readable_channel');
  });

  it('la refuse AUSSI au manager — le rôle ne fait pas entrer dans un canal', async () => {
    const { tool, ingestion } = makeTool({ memberOf: [] });
    await seed(ingestion, {
      id: `${PRIVATE_CHANNEL}:1700000000.000200`,
      channelId: PRIVATE_CHANNEL,
    });

    const result = await run(tool, { query: 'migration' }, MANAGER);

    expect(result.found).toBe(false);
    expect(result.reason).toBe('no_readable_channel');
  });

  it('écarte un canal dont l’appartenance est indécidable — jamais fail-open', async () => {
    const { tool, ingestion, channels } = makeTool();
    await seed(ingestion);
    vi.mocked(channels.isMember).mockRejectedValueOnce(new Error('slack down'));

    const result = await run(tool, { query: 'migration' }, EMPLOYEE);

    expect(result.found).toBe(false);
  });
});

describe('searchKnowledge — la recherche nominative', () => {
  it('SEUL le manager cherche ce qu’une autre personne a dit', async () => {
    const { tool, ingestion } = makeTool();
    await seed(ingestion);

    const result = await run(tool, { query: 'migration', person: MANAGER }, EMPLOYEE);

    expect(result.found).toBe(false);
    expect(result.reason).toBe('insufficient_privilege');
  });

  it('le manager, lui, y a droit', async () => {
    const { tool, ingestion } = makeTool();
    await seed(ingestion);

    const result = await run(tool, { query: 'migration', person: EMPLOYEE }, MANAGER);

    expect(result.found).toBe(true);
  });

  it('chacun peut chercher CE QU’IL A dit lui-même', async () => {
    const { tool, ingestion } = makeTool();
    await seed(ingestion);

    const result = await run(tool, { query: 'migration', person: EMPLOYEE }, EMPLOYEE);

    expect(result.found).toBe(true);
  });

  it('n’est JAMAIS un oracle d’existence — adresse inconnue et refus se confondent', async () => {
    // ⚠️ Le verdict tombe AVANT toute lecture d'annuaire. Sinon `person_not_found` contre
    // `insufficient_privilege` énumère l'annuaire une adresse à la fois.
    const { tool, ingestion, directory } = makeTool();
    await seed(ingestion);

    const connu = await run(
      tool,
      { query: 'migration', person: 'u0manager1@kissohq.com' },
      EMPLOYEE,
    );
    const inconnu = await run(
      tool,
      { query: 'migration', person: 'fantome@kissohq.com' },
      EMPLOYEE,
    );

    expect(connu.reason).toBe('insufficient_privilege');
    expect(inconnu.reason).toBe('insufficient_privilege');
    expect(directory.findByEmail).not.toHaveBeenCalled();
  });

  it('refuse hors Slack, où personne n’est identifié', async () => {
    const { tool } = makeTool();

    const result = (await tool.execute!({ query: 'migration' } as never, {} as never)) as Record<
      string,
      unknown
    >;

    expect(result.found).toBe(false);
    expect(result.reason).toBe('no_requester');
  });
});
