import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  MIN_RETENTION_DAYS,
  resolveRetentionWindow,
} from '../../../src/features/knowledge/domain/services/knowledge-retention';
import { pruneKnowledge } from '../../../src/features/knowledge/application/services/prune-knowledge';
import { InMemoryMessageArchiveRepository } from '../../../src/features/knowledge/infrastructure/repositories/in-memory-message-archive.repository';
import { InMemoryKnowledgeFactRepository } from '../../../src/features/knowledge/infrastructure/repositories/in-memory-knowledge-fact.repository';
import { logger } from '../../../src/shared/logger';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA RÉTENTION — le SEUL mécanisme qui borne la conservation de données
 * personnelles, et il n'avait AUCUN test (constaté le 2026-08-22)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `resolveRetentionWindow` et `pruneKnowledge` n'étaient nommés nulle part dans `tests/`.
 * Le cron les appelle pourtant tous les matins depuis le 2026-08-21, et depuis la même date
 * les DM sont archivés — donc ce qui n'est pas purgé est conservé indéfiniment, y compris
 * des messages privés que le manager peut relire.
 *
 * ⚠️ LE CAS LE PLUS DANGEREUX N'EST PAS L'ABSENCE, C'EST LE REJET SILENCIEUX.
 * Une variable absente est un choix qu'on n'a pas fait. Une valeur POSÉE puis rejetée —
 * `KNOWLEDGE_RETENTION_DAYS=3`, sous le plancher de 7 — est un choix qu'on croit avoir fait :
 * l'opérateur pense avoir configuré une rétention de trois jours, et tout est gardé pour
 * toujours. Ce cas sortait en `logger.info`, au même niveau qu'une purge réussie.
 */
describe('resolveRetentionWindow — les trois façons de ne rien purger', () => {
  it('variable absente : désactivé, et la raison le dit', () => {
    expect(resolveRetentionWindow(undefined)).toMatchObject({
      enabled: false,
      reason: 'not_configured',
    });
  });

  it('chaîne vide : traitée comme absente — copier `.env.example` ne suffit donc pas', () => {
    expect(resolveRetentionWindow('   ')).toMatchObject({ reason: 'not_configured' });
  });

  it('valeur non numérique : désactivé, raison distincte', () => {
    expect(resolveRetentionWindow('sept')).toMatchObject({
      enabled: false,
      reason: 'not_a_number',
    });
  });

  it('valeur sous le plancher : désactivé, et la valeur voulue est CONSERVÉE dans le rapport', () => {
    // ⚠️ `days` est renseigné alors que `enabled` est faux : c'est ce qui permet à
    // l'exploitant de voir que quelqu'un a voulu 3 jours, pas qu'on n'a rien demandé.
    expect(resolveRetentionWindow(String(MIN_RETENTION_DAYS - 1))).toMatchObject({
      enabled: false,
      days: MIN_RETENTION_DAYS - 1,
      reason: 'below_minimum',
    });
  });

  it('valeur valide : la borne est calculée depuis `now`, jamais depuis l’horloge murale', () => {
    const now = new Date('2026-08-22T00:00:00.000Z');
    const window = resolveRetentionWindow('30', now);

    expect(window.enabled).toBe(true);
    expect(window.before).toBe(now.getTime() - 30 * 86_400_000);
  });
});

describe('pruneKnowledge — ce qui part, ce qui reste, et ce qui se dit', () => {
  const NOW = new Date('2026-08-22T00:00:00.000Z');
  const day = (n: number) => NOW.getTime() - n * 86_400_000;

  let archive: InMemoryMessageArchiveRepository;
  let facts: InMemoryKnowledgeFactRepository;

  beforeEach(async () => {
    archive = new InMemoryMessageArchiveRepository();
    facts = new InMemoryKnowledgeFactRepository();

    for (const [id, age] of [
      ['C1:1', 40],
      ['C1:2', 5],
    ] as const) {
      await archive.archive({
        id,
        channelId: 'C1',
        slackUserId: 'U1',
        text: `message vieux de ${age} jours`,
        threadTs: null,
        postedAt: day(age),
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('purge ce qui dépasse la fenêtre et GARDE le reste', async () => {
    const report = await pruneKnowledge({
      archive,
      facts,
      retentionDays: '30',
      now: () => NOW,
    });

    expect(report).toMatchObject({ enabled: true, days: 30, messages: 1 });
    expect(archive.size).toBe(1);
  });

  it('sans variable : ne purge RIEN, et le dit en `warn` — plus en `info`', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const report = await pruneKnowledge({ archive, facts, now: () => NOW });

    expect(report).toMatchObject({ enabled: false, messages: 0, reason: 'not_configured' });
    expect(archive.size).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toMatch(/SANS BORNE/);
  });

  it('valeur REJETÉE : `error`, parce que quelqu’un a cru configurer une rétention', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const report = await pruneKnowledge({
      archive,
      facts,
      retentionDays: String(MIN_RETENTION_DAYS - 1),
      now: () => NOW,
    });

    expect(report.enabled).toBe(false);
    expect(archive.size).toBe(2);
    expect(error).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ La purge tourne dans la MÊME route que la remise des rappels. Si une panne de purge
   * remontait, elle emporterait les rappels du jour — un dommage sans rapport avec sa cause.
   */
  it('une panne de purge n’est jamais propagée', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const broken = {
      pruneOlderThan: async () => {
        throw new Error('turso indisponible');
      },
    } as never;

    await expect(
      pruneKnowledge({ archive: broken, facts, retentionDays: '30', now: () => NOW }),
    ).resolves.toMatchObject({ enabled: true, messages: 0 });
  });
});
