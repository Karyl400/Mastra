import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import * as schema from '../../../src/infrastructure/database/schema';
import { pendingInterviewEmail } from '../../../src/infrastructure/database/schema';
import { DrizzlePendingInterviewEmailRepository } from '../../../src/features/recruitment/infrastructure/repositories/drizzle-pending-email.repository';
import { InMemoryPendingInterviewEmailRepository } from '../../../src/features/recruitment/infrastructure/repositories/in-memory-pending-email.repository';
import type {
  PendingInterviewEmail,
  PendingInterviewEmailRepository,
} from '../../../src/features/recruitment/domain/ports/pending-email.repository';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE COMPTE RENDU PAR `clear()` EST LA GARANTIE DE NON-DOUBLE-ENVOI
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Cette suite tourne sur les DEUX implémentations pour une raison précise : la doublure
 * in-memory sert de socle à tous les tests du handler, et c'est elle qui décide si le second
 * « oui » envoie ou non. Une doublure qui rendrait `1` là où SQLite rend `0` ferait passer au
 * vert un code qui envoie deux invitations à un candidat.
 *
 * L'implémentation Drizzle est exercée contre une VRAIE base libsql en mémoire : « le DELETE
 * n'a touché aucune ligne » ne se démontre que contre du vrai SQL.
 */

function createTableSql(): string {
  const config = getTableConfig(pendingInterviewEmail);
  const columns = config.columns.map((column) => {
    const parts = [`"${column.name}"`, column.getSQLType()];
    if (column.primary) parts.push('PRIMARY KEY');
    else if (column.notNull) parts.push('NOT NULL');
    return parts.join(' ');
  });
  return `CREATE TABLE "${config.name}" (${columns.join(', ')})`;
}

let client: Client | null = null;

async function makeDrizzleRepo(): Promise<PendingInterviewEmailRepository> {
  client = createClient({ url: ':memory:' });
  await client.execute(createTableSql());
  return new DrizzlePendingInterviewEmailRepository(() => drizzle(client!, { schema }));
}

const CONV = 'D0KARYL';

function preparation(over: Partial<PendingInterviewEmail> = {}): PendingInterviewEmail {
  return {
    conversationId: CONV,
    requesterUserId: 'U0KARYL',
    to: 'jean@exemple.com',
    candidateName: 'Jean DUPONT',
    startsAt: '2026-09-20T13:00:00.000Z',
    position: 'Backend Developer',
    location: null,
    replyTo: 'karyl@kisso.com',
    createdAt: new Date('2026-08-19T10:00:00.000Z'),
    ...over,
  };
}

const implementations: Array<{
  nom: string;
  make: () => Promise<PendingInterviewEmailRepository>;
}> = [
  { nom: 'DrizzlePendingInterviewEmailRepository', make: makeDrizzleRepo },
  {
    nom: 'InMemoryPendingInterviewEmailRepository',
    make: async () => new InMemoryPendingInterviewEmailRepository(),
  },
];

describe.each(implementations)('$nom — contrat PendingInterviewEmailRepository', ({ make }) => {
  let repo: PendingInterviewEmailRepository;

  beforeEach(async () => {
    repo = await make();
  });

  afterEach(() => {
    client?.close();
    client = null;
  });

  it('rend `null` quand rien n’attend — jamais une ligne vide', async () => {
    expect(await repo.find(CONV)).toBeNull();
  });

  it('conserve chaque champ, y compris les absents', async () => {
    await repo.save(preparation({ position: null, replyTo: null }));
    const found = (await repo.find(CONV))!;

    expect(found.to).toBe('jean@exemple.com');
    expect(found.candidateName).toBe('Jean DUPONT');
    expect(found.startsAt).toBe('2026-09-20T13:00:00.000Z');
    expect(found.position).toBeNull();
    expect(found.replyTo).toBeNull();
  });

  it('REMPLACE au lieu d’empiler : une conversation, une préparation', async () => {
    // Deux lignes rendraient le « oui » de la personne ambigu, alors qu'elle n'en voit qu'une
    // à l'écran. La clé primaire porte cette règle ; la doublure doit la porter aussi.
    await repo.save(preparation());
    await repo.save(preparation({ to: 'autre@exemple.com', candidateName: 'Awa TRAORE' }));

    const found = (await repo.find(CONV))!;
    expect(found.to).toBe('autre@exemple.com');
    expect(found.candidateName).toBe('Awa TRAORE');
  });

  it('LA PRISE : le premier `clear` rend 1, le second rend 0', async () => {
    // ⚠️ C'est LA propriété. Deux « oui » traités par deux instances ne peuvent pas envoyer
    // deux fois — la seconde n'a rien pris, et l'appelant renonce sur ce compte.
    await repo.save(preparation());

    expect(await repo.clear(CONV)).toBe(1);
    expect(await repo.clear(CONV)).toBe(0);
    expect(await repo.find(CONV)).toBeNull();
  });

  it('`clear` sur une conversation inconnue rend 0 sans lever', async () => {
    expect(await repo.clear('D0INCONNU')).toBe(0);
  });

  it('les conversations sont ÉTANCHES', async () => {
    await repo.save(preparation());
    await repo.save(preparation({ conversationId: 'C0HQ:1700000000.000100' }));

    expect(await repo.clear(CONV)).toBe(1);
    expect(await repo.find('C0HQ:1700000000.000100')).not.toBeNull();
  });
});
