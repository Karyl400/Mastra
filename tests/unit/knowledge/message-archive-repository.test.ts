import { describe, it, expect, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import * as schema from '../../../src/infrastructure/database/schema';
import { channelMessages } from '../../../src/infrastructure/database/schema';
import { DrizzleMessageArchiveRepository } from '../../../src/features/knowledge/infrastructure/repositories/drizzle-message-archive.repository';
import type { ArchivedMessage } from '../../../src/features/knowledge/domain/ports/message-archive.repository';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE SECOND RIDEAU N'ENREGISTRAIT JAMAIS RIEN — audit du 2026-08-28, § 1.2
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `findPendingDistillation` passe par le QUERY BUILDER, qui rend les clés en **camelCase** (les
 * noms de propriété du schéma). `interface Row` et `toDomain` lisaient en **snake_case**. Le
 * `as unknown as Row[]` était la CONDITION D'EXISTENCE du bug : sans lui, `tsc` refusait.
 *
 * Résultat mesuré sur une vraie base : `channelId`, `slackUserId` et `threadTs` rendus
 * `undefined`, `postedAt` rendu `NaN`. La chaîne aval rendait le défaut PERMANENT — l'insert
 * violait `knowledge_facts.channel_id NOT NULL`, le `catch` avalait en `warn`, et
 * `markDistilled` s'exécutait **inconditionnellement, hors de la boucle** : les messages étaient
 * marqués traités et ne repassaient plus jamais.
 *
 * ⚠️ **AUCUN test ne pouvait le voir** : les sept appels de `findPendingDistillation` dans
 * `tests/` passent par la doublure in-memory, qui n'a **aucune traduction de nommage à faire**.
 * C'est pourquoi cette suite monte une VRAIE base libsql.
 *
 * ⚠️ Le défaut n'est pas « `as unknown as` sur du Drizzle ». C'est : **un même fichier mélange
 * le SQL brut et le query builder en partageant un mapper.** `search()` est du SQL brut, donc
 * réellement en `snake_case`, et il est JUSTE. Retyper `Row` globalement l'aurait cassé — d'où
 * deux mappers NOMMÉS, pour que la confusion ne soit plus représentable.
 */

function createTableSql(): string {
  const config = getTableConfig(channelMessages);
  const columns = config.columns.map((column) => {
    const parts = [`"${column.name}"`, column.getSQLType()];
    if (column.primary) parts.push('PRIMARY KEY');
    else if (column.notNull) parts.push('NOT NULL');
    return parts.join(' ');
  });
  return `CREATE TABLE "${config.name}" (${columns.join(', ')})`;
}

let client: Client | null = null;

async function makeRepo(): Promise<DrizzleMessageArchiveRepository> {
  client = createClient({ url: ':memory:' });
  await client.execute(createTableSql());
  return new DrizzleMessageArchiveRepository(() => drizzle(client!, { schema }));
}

afterEach(() => {
  client?.close();
  client = null;
});

// ⚠️ Le message doit être RÉCENT : `findPendingDistillation` filtre sur une fenêtre glissante
// (`postedAt >= Date.now() - sinceMs`). Un horodatage figé ferait passer ce test au vert par
// expiration au lieu de le faire passer par le correctif — puis rougir sans raison plus tard.
const message = (over: Partial<ArchivedMessage> = {}): ArchivedMessage => ({
  id: 'CMLKC4S5T:1787323636.317000',
  channelId: 'CMLKC4S5T',
  slackUserId: 'U0KARYL',
  text: 'on a decide de partir sur postgres',
  threadTs: null,
  postedAt: Date.now() - 60 * 1000,
  ...over,
});

const MESSAGE = message();

describe('`findPendingDistillation` rend un message COMPLET', () => {
  it('rend les six champs, contre une vraie base', async () => {
    const repo = await makeRepo();
    await repo.archive(MESSAGE);

    const pending = await repo.findPendingDistillation(24 * 60 * 60 * 1000, 5);

    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(MESSAGE);
  });

  it('le champ qui rendait la perte PERMANENTE est renseigné', async () => {
    // `channel_id` est NOT NULL sur `knowledge_facts`. C'est LUI qui faisait échouer l'insert,
    // donc c'est lui qu'il faut nommer : un test sur `toEqual` seul ne dirait pas pourquoi.
    const repo = await makeRepo();
    await repo.archive(MESSAGE);

    const [first] = await repo.findPendingDistillation(24 * 60 * 60 * 1000, 5);

    expect(first?.channelId).toBe('CMLKC4S5T');
    expect(first?.slackUserId).toBe('U0KARYL');
    expect(Number.isNaN(first?.postedAt)).toBe(false);
  });

  it('un fil est transporté tel quel', async () => {
    const repo = await makeRepo();
    await repo.archive(message({ threadTs: '1787323600.000100' }));

    const [first] = await repo.findPendingDistillation(24 * 60 * 60 * 1000, 5);

    expect(first?.threadTs).toBe('1787323600.000100');
  });

  it('CONTRÔLE — ce qui est DÉJÀ distillé ne ressort pas', async () => {
    const repo = await makeRepo();
    await repo.archive(MESSAGE);
    await repo.markDistilled([MESSAGE.id], Date.now());

    expect(await repo.findPendingDistillation(24 * 60 * 60 * 1000, 5)).toHaveLength(0);
  });

  it('CONTRÔLE — ce qui est hors fenêtre ne ressort pas', async () => {
    const repo = await makeRepo();
    await repo.archive(message({ postedAt: Date.now() - 48 * 60 * 60 * 1000 }));

    expect(await repo.findPendingDistillation(6 * 60 * 60 * 1000, 5)).toHaveLength(0);
  });
});
