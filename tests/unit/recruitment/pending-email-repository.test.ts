import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import * as schema from '../../../src/infrastructure/database/schema';
import { pendingInterviewEmail } from '../../../src/infrastructure/database/schema';
import { DrizzlePendingInterviewEmailRepository } from '../../../src/features/recruitment/infrastructure/repositories/drizzle-pending-email.repository';
import { InMemoryPendingInterviewEmailRepository } from '../../../src/features/recruitment/infrastructure/repositories/in-memory-pending-email.repository';
import {
  PENDING_EMAIL_TTL_MS,
  type PendingInterviewEmail,
  type PendingInterviewEmailRepository,
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

  // ══════════════════════════════════════════════════════════════════════════
  // LA RÉTENTION — audit du 2026-08-28, § 3.4
  // ══════════════════════════════════════════════════════════════════════════
  //
  // ⚠️ `CLAUDE.md` a affirmé jusqu'au 2026-08-28 : « AUCUNE écriture en base, et c'est un
  // choix […] stocker l'adresse d'un NON-SALARIÉ créerait des données personnelles sans chemin
  // d'effacement ». Cette table écrit `to`, `candidateName`, `position` et `location` — le trou
  // que la phrase déclarait FERMÉ était ouvert, et `forget()` ne touche pas cette table.
  //
  // Le chemin d'effacement ne pouvait pas être `forget` : le sujet de la donnée est le
  // CANDIDAT, qui n'a aucun compte Slack et ne peut rien demander. C'est donc une EXPIRATION,
  // et la borne existait déjà — `PENDING_EMAIL_TTL_MS`. Au-delà, `confirm-pending-email` refuse
  // déjà d'agir sur la ligne : la garder ne conserve plus qu'une adresse personnelle inerte.

  // La borne est DÉRIVÉE de `PENDING_EMAIL_TTL_MS`, jamais recopiée : c'est la même constante
  // que `confirm-pending-email` consulte pour REFUSER d'agir sur une ligne expirée. Les deux
  // doivent bouger ensemble, sinon la purge emporterait une préparation encore honorable.
  const POSE = new Date('2026-08-19T10:00:00.000Z');
  const cutoffAt = (nowIso: string): Date =>
    new Date(new Date(nowIso).getTime() - PENDING_EMAIL_TTL_MS);

  it('`pruneOlderThan` emporte ce qui a dépassé le TTL, et rend son compte', async () => {
    await repo.save(preparation({ createdAt: POSE }));

    // Un jour et une seconde plus tard : au-delà du TTL, `confirm` refuserait déjà d'agir.
    expect(await repo.pruneOlderThan(cutoffAt('2026-08-20T10:00:01.000Z'))).toBe(1);
    expect(await repo.find(CONV)).toBeNull();
  });

  it('épargne ce qui est ENCORE dans sa fenêtre — une préparation vivante ne disparaît pas', async () => {
    await repo.save(preparation({ createdAt: POSE }));

    // Deux heures plus tard : la personne peut toujours répondre « oui ».
    expect(await repo.pruneOlderThan(cutoffAt('2026-08-19T12:00:00.000Z'))).toBe(0);
    expect(await repo.find(CONV)).not.toBeNull();
  });

  it('rend 0 sur une table vide, sans lever', async () => {
    expect(await repo.pruneOlderThan(cutoffAt('2026-08-20T10:00:00.000Z'))).toBe(0);
  });
});
