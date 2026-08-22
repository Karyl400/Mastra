import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { InMemorySlackEventDedupRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-slack-event-dedup.repository';
import type { SlackEventDedupRepository } from '../../../src/features/notification/domain/ports/slack-event-dedup.repository';

const GRACE_MS = 60_000;

/**
 * Contrat du port `SlackEventDedupRepository`, vérifié sur la doublure in-memory — celle-là
 * même qui sert de doublure aux tests du handler. On ne mocke jamais Drizzle à la main ;
 * l'équivalence avec l'implémentation Drizzle est verrouillée plus bas, au niveau de la
 * PROPRIÉTÉ qui compte (l'atomicité de la prise de clé).
 */
describe('SlackEventDedupRepository — contrat de prise de clé', () => {
  let repo: SlackEventDedupRepository;

  beforeEach(() => {
    repo = new InMemorySlackEventDedupRepository();
  });

  it('accorde la première prise et refuse la seconde tant que le traitement est en cours', async () => {
    await expect(repo.claim('ts:D1:1.1', { inFlightGraceMs: GRACE_MS })).resolves.toEqual({
      granted: true,
      reclaimed: false,
    });

    const second = await repo.claim('ts:D1:1.1', { inFlightGraceMs: GRACE_MS });
    expect(second.granted).toBe(false);
    expect(second).toMatchObject({ status: 'in-flight' });
  });

  it('refuse définitivement une clé terminée, même avec une grâce nulle', async () => {
    await repo.claim('ts:D1:1.2', { inFlightGraceMs: GRACE_MS });
    await repo.markDone('ts:D1:1.2');

    // `done` n'est JAMAIS considéré comme abandonné : la grâce ne s'applique qu'à `in-flight`.
    // Sans cette distinction, toute réponse déjà postée serait repostée.
    const retry = await repo.claim('ts:D1:1.2', { inFlightGraceMs: 0 });
    expect(retry.granted).toBe(false);
    expect(retry).toMatchObject({ status: 'done' });
  });

  it('rend rejouable une entrée in-flight plus vieille que la grâce (fonction gelée)', async () => {
    await repo.claim('ts:D1:1.3', { inFlightGraceMs: GRACE_MS });

    // Grâce nulle = l'entrée est déjà « trop vieille ». Sans cette reprise, un événement perdu
    // au gel de la fonction serverless le serait DÉFINITIVEMENT.
    await expect(repo.claim('ts:D1:1.3', { inFlightGraceMs: 0 })).resolves.toEqual({
      granted: true,
      reclaimed: true,
    });
  });

  it('rend la clé reprenable immédiatement après release()', async () => {
    await repo.claim('ts:D1:1.4', { inFlightGraceMs: GRACE_MS });
    await repo.release('ts:D1:1.4');

    await expect(repo.claim('ts:D1:1.4', { inFlightGraceMs: GRACE_MS })).resolves.toEqual({
      granted: true,
      reclaimed: false,
    });
  });

  it('cloisonne deux clés distinctes', async () => {
    expect((await repo.claim('ts:D1:2.1', { inFlightGraceMs: GRACE_MS })).granted).toBe(true);
    expect((await repo.claim('ts:D1:2.2', { inFlightGraceMs: GRACE_MS })).granted).toBe(true);
  });

  it("n'accorde la clé qu'à UNE seule des prises concurrentes", async () => {
    // Deux instances serverless prenant la même clé « en même temps ». C'est le scénario exact
    // du 2026-08-11 : instance A occupée par le waitUntil, rejeu Slack routé vers une instance
    // NEUVE. Une lecture suivie d'une écriture laisserait passer les deux.
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => repo.claim('ts:D1:3.1', { inFlightGraceMs: GRACE_MS })),
    );

    expect(outcomes.filter((outcome) => outcome.granted)).toHaveLength(1);
  });

  it('purge les entrées au-delà de la rétention et laisse les récentes', async () => {
    await repo.claim('ts:D1:4.1', { inFlightGraceMs: GRACE_MS });
    await repo.markDone('ts:D1:4.1');

    expect(await repo.pruneOlderThan(new Date(Date.now() - 10 * 60 * 1000))).toBe(0);
    expect(await repo.pruneOlderThan(new Date(Date.now() + 1))).toBe(1);

    // Purgée, la clé redevient prenable — sans danger : passé la fenêtre de rejeu de Slack
    // (~10 min), plus aucun renvoi n'arrive.
    expect((await repo.claim('ts:D1:4.1', { inFlightGraceMs: GRACE_MS })).granted).toBe(true);
  });
});

/**
 * Garde-fou de SOURCE sur l'implémentation Drizzle.
 *
 * L'atomicité de la prise de clé ne se démontre pas contre une doublure in-memory : en
 * JavaScript, tout corps de fonction sans `await` est déjà atomique. Or c'est LA propriété qui
 * ferme la fenêtre de concurrence multi-instance, et la façon de la perdre est connue et
 * tentante — un `SELECT` d'abord, un `INSERT` ensuite.
 *
 * Ce test verrouille donc la forme du SQL. Les tests d'intégration (`tests/unit/infrastructure/`,
 * rattachés au run d'intégration) sont le seul endroit où l'on peut l'exercer contre une vraie
 * base ; ce garde-fou reste le filet du run unitaire.
 */
describe('DrizzleSlackEventDedupRepository — atomicité de la prise', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const SOURCE = fs.readFileSync(
    path.resolve(
      HERE,
      '../../../src/features/notification/infrastructure/repositories/drizzle-slack-event-dedup.repository.ts',
    ),
    'utf8',
  );

  /** Corps de `claim()`, du `async claim(` jusqu'à la méthode suivante. */
  const claimBody = SOURCE.slice(SOURCE.indexOf('async claim('), SOURCE.indexOf('async markDone('));

  it('prend la clé par INSERT … ON CONFLICT DO NOTHING', () => {
    expect(claimBody).toContain('onConflictDoNothing()');
    expect(claimBody).toContain('.insert(');
  });

  it('ne lit JAMAIS la table avant de tenter la prise', () => {
    const insertAt = claimBody.indexOf('.insert(');
    const selectAt = claimBody.indexOf('.select(');

    // Un `SELECT` puis un `INSERT` rouvrirait exactement la fenêtre de concurrence que ce
    // dépôt existe pour fermer. La relecture n'est permise qu'APRÈS le refus, et seulement
    // pour journaliser.
    expect(insertAt).toBeGreaterThan(-1);
    expect(selectAt === -1 || selectAt > insertAt).toBe(true);
  });

  it('reprend une entrée abandonnée par un UPDATE CONDITIONNEL, jamais par un delete-puis-insert', () => {
    // La reprise doit rester atomique elle aussi : `UPDATE … WHERE status = 'in-flight'
    // AND started_at <= cutoff` ne peut réussir que pour une seule des instances en course.
    expect(claimBody).toContain('.update(');
    expect(claimBody).not.toContain('.delete(');
  });
});
