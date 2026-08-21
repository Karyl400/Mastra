import { describe, it, expect, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import * as schema from '../../../src/infrastructure/database/schema';
import { notifications } from '../../../src/infrastructure/database/schema';
import { DrizzleNotificationRepository } from '../../../src/features/notification/infrastructure/repositories/drizzle-notification.repository';
import { InMemoryNotificationRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-notification.repository';
import type { Notification } from '../../../src/features/notification/domain/entities/notification';
import type { NotificationRepository } from '../../../src/features/notification/domain/ports/notification.repository';
import { NotificationChannel, NotificationStatus, RecipientType } from '../../../src/shared/types';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA PRISE EST L'ÉCRITURE, ET ELLE REND UN COMPTE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Cette suite tourne sur les DEUX implémentations, exactement comme celle des emails
 * d'entretien en attente, et pour la même raison : la doublure in-memory sert de socle à tous
 * les tests du répartiteur, et c'est ELLE qui décide si une seconde exécution du cron remet un
 * second exemplaire du rappel. Une doublure qui rendrait `true` là où SQLite rend `false`
 * ferait passer au vert un code qui écrit deux fois à la même personne.
 *
 * L'implémentation Drizzle est exercée contre une VRAIE base libsql en mémoire : « l'UPDATE n'a
 * touché aucune ligne » ne se démontre que contre du vrai SQL — et c'est précisément ce que lit
 * `readAffectedRows`.
 */

function createTableSql(): string {
  const config = getTableConfig(notifications);
  const columns = config.columns.map((column) => {
    const parts = [`"${column.name}"`, column.getSQLType()];
    if (column.primary) parts.push('PRIMARY KEY');
    else if (column.notNull) parts.push('NOT NULL');
    return parts.join(' ');
  });
  return `CREATE TABLE "${config.name}" (${columns.join(', ')})`;
}

let client: Client | null = null;

async function makeDrizzleRepo(): Promise<NotificationRepository> {
  client = createClient({ url: ':memory:' });
  await client.execute(createTableSql());
  return new DrizzleNotificationRepository(() => drizzle(client!, { schema }));
}

afterEach(() => {
  client?.close();
  client = null;
});

function reminder(over: Partial<Notification> = {}): Notification {
  return {
    id: 'n1',
    recipientId: '11111111-1111-4111-8111-111111111111',
    recipientType: RecipientType.Employee,
    channel: NotificationChannel.Email,
    subject: 'Relire les guidelines',
    body: 'Le corps du rappel.',
    status: NotificationStatus.Scheduled,
    scheduledAt: '2026-08-24T09:00:00.000Z',
    createdAt: '2026-08-21T10:00:00.000Z',
    updatedAt: '2026-08-21T10:00:00.000Z',
    ...over,
  } as Notification;
}

const IMPLEMENTATIONS: Array<[string, () => Promise<NotificationRepository>]> = [
  ['in-memory', async () => new InMemoryNotificationRepository()],
  ['drizzle/libsql', makeDrizzleRepo],
];

describe.each(IMPLEMENTATIONS)('claimForDispatch — %s', (_name, make) => {
  it('la première prise réussit', async () => {
    const repo = await make();
    await repo.save(reminder());
    expect(await repo.claimForDispatch('n1')).toBe(true);
  });

  it('LA SECONDE ÉCHOUE — c’est toute la garantie de non-doublon', async () => {
    const repo = await make();
    await repo.save(reminder());

    expect(await repo.claimForDispatch('n1')).toBe(true);
    expect(await repo.claimForDispatch('n1')).toBe(false);
  });

  it('un rappel déjà envoyé ne se reprend pas', async () => {
    const repo = await make();
    await repo.save(reminder({ status: NotificationStatus.Sent }));
    expect(await repo.claimForDispatch('n1')).toBe(false);
  });

  it('un identifiant inconnu ne se prend pas', async () => {
    const repo = await make();
    expect(await repo.claimForDispatch('jamais-vu')).toBe(false);
  });

  it('la prise sort le rappel de findPending — sinon il serait resélectionné', async () => {
    const repo = await make();
    await repo.save(reminder());

    await repo.claimForDispatch('n1');

    expect(await repo.findPending()).toHaveLength(0);
  });

  it('releaseClaim rend le rappel reprenable — un transport en panne ne le perd pas', async () => {
    const repo = await make();
    await repo.save(reminder());

    await repo.claimForDispatch('n1');
    await repo.releaseClaim('n1');

    expect((await repo.findById('n1'))?.status).toBe(NotificationStatus.Scheduled);
    expect(await repo.claimForDispatch('n1')).toBe(true);
  });

  it('releaseClaim ne ressuscite PAS un rappel envoyé', async () => {
    // Sans cette garde, une remise réussie suivie d'un `release` mal placé renverrait le
    // message — le doublon par le chemin inverse.
    const repo = await make();
    await repo.save(reminder({ status: NotificationStatus.Sent }));

    await repo.releaseClaim('n1');

    expect((await repo.findById('n1'))?.status).toBe(NotificationStatus.Sent);
  });

  it('findPending rend les rappels enregistrés — `scheduled` ET `pending`', async () => {
    // ⚠️ `findPending()` a longtemps filtré `Pending` seul alors que `scheduleReminder` écrit
    // `Scheduled` : le seul lecteur imaginable était incompatible avec le seul écrivain, et un
    // ordonnanceur branché ce jour-là aurait tourné à vide, en silence.
    const repo = await make();
    await repo.save(reminder({ id: 'n1', status: NotificationStatus.Scheduled }));
    await repo.save(reminder({ id: 'n2', status: NotificationStatus.Pending }));
    await repo.save(reminder({ id: 'n3', status: NotificationStatus.Sent }));

    const pending = await repo.findPending();

    expect(pending.map((n) => n.id).sort()).toEqual(['n1', 'n2']);
  });
});
