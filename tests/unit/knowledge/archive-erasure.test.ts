/**
 * ════════════════════════════════════════════════════════════════════════════
 * L'EFFACEMENT DE L'ARCHIVE — implémenté quatre fois, appelé zéro fois
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `forgetUser` et `prune` existent dans les deux ports de la feature `knowledge`, sont
 * implémentées dans les quatre dépôts… et l'audit du 2026-08-21 a mesuré **zéro appelant, dans
 * tout `src/` et tout `scripts/`**. Le port le dit pourtant lui-même : *« `forgetUser` emporte
 * l'archive d'une personne (c'est le droit à l'effacement) »*.
 *
 * C'est la forme exacte de `findPending()` avant le cron du 2026-08-21 : une méthode correcte,
 * sans site d'appel **parce qu'il n'existait personne pour l'appeler**. Sauf qu'ici la
 * conséquence n'est pas un rappel qui ne part pas — c'est un droit annoncé et non exécutable,
 * sur des données qui incluent les **DM** depuis le 2026-08-21.
 *
 * ⚠️ **LA PORTÉE EST LA VRAIE DIFFICULTÉ, et c'est pourquoi elle change de forme ici.**
 *
 * `forgetUser(slackUserId)` efface ce qu'une personne a dit **PARTOUT** : tous les canaux,
 * toutes les périodes. Or « oublie ce que je t'ai dit », tapé dans un DM, ne demande pas cela —
 * il demande d'oublier CETTE conversation. Brancher la version globale sur le court-circuit
 * aurait fait disparaître, sur une phrase, un an de décisions d'équipe qu'une autre personne
 * lira demain.
 *
 * Ce dépôt a déjà tranché ce dilemme une fois, pour `ConversationRepository.forget` : en DM
 * tout part, en fil de canal seuls les tours du demandeur, et **hors DM sans auteur identifié
 * on échoue bruyamment — « une portée indéterminée sur une suppression, c'est le fil entier »**.
 * On applique ici la même règle, ce qui exige un effacement SCOPABLE PAR CANAL.
 *
 * D'où deux gestes distincts, et non un seul élargi :
 *   • le court-circuit conversationnel efface l'archive **du DM où il est prononcé** ;
 *   • l'effacement GLOBAL, lui, est un geste explicite d'administration
 *     (`npm run knowledge:forget`), parce qu'une demande RGPD n'est pas une phrase en passant.
 *
 * ⚠️ **En fil de CANAL, l'archive n'est pas touchée du tout.** Le demandeur y agit sur ses
 * propres tours, pas sur la mémoire collective du canal — et un faux positif y serait
 * irréversible pour tout le monde, pas seulement pour lui.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { InMemoryMessageArchiveRepository } from '../../../src/features/knowledge/infrastructure/repositories/in-memory-message-archive.repository';
import { InMemoryKnowledgeFactRepository } from '../../../src/features/knowledge/infrastructure/repositories/in-memory-knowledge-fact.repository';

const KARYL = 'U_KARYL';
const AWA = 'U_AWA';
const DM = 'D0KARYL';
const CHANNEL = 'C_HQ';

/** Horodatages réalistes : `pendingDistillation` borne par une FENÊTRE, pas par un rang. */
const BASE_TS = Date.now() - 60_000;
const ALL = Number.MAX_SAFE_INTEGER;

describe("l'archive des messages", () => {
  let archive: InMemoryMessageArchiveRepository;

  beforeEach(async () => {
    archive = new InMemoryMessageArchiveRepository();
    let n = 0;
    const add = (channelId: string, slackUserId: string, text: string) =>
      archive.archive({
        id: `m${(n += 1)}`,
        channelId,
        slackUserId,
        text,
        threadTs: null,
        postedAt: BASE_TS + n * 1000,
      });

    // ⚠️ On énumère par `pendingDistillation` et non par `search('')` : la recherche est du
    // FTS, une requête vide n'y matche rien — ce n'est pas un défaut du dépôt, c'est le
    // contrat de FTS5. Un test qui l'ignore mesure sa propre méprise.

    await add(DM, KARYL, 'je te raconte ma vie');
    await add(DM, KARYL, 'et encore autre chose');
    await add(CHANNEL, KARYL, 'on a décidé de partir sur postgres');
    await add(CHANNEL, AWA, 'ok pour moi');
  });

  it("efface ce qu'une personne a dit DANS UN SEUL canal", async () => {
    const removed = await archive.forgetUser({ slackUserId: KARYL, channelId: DM });

    expect(removed).toBe(2);
    const rest = await archive.pendingDistillation(ALL, 100);
    expect(rest.map((r) => r.channelId).sort()).toEqual([CHANNEL, CHANNEL]);
  });

  it("efface PARTOUT quand aucun canal n'est donné — le geste RGPD explicite", async () => {
    const removed = await archive.forgetUser({ slackUserId: KARYL });

    expect(removed).toBe(3);
    const rest = await archive.pendingDistillation(ALL, 100);
    expect(rest).toHaveLength(1);
    expect(rest[0]!.slackUserId).toBe(AWA);
  });

  it("ne touche jamais les messages d'autrui", async () => {
    await archive.forgetUser({ slackUserId: KARYL });
    const rest = await archive.pendingDistillation(ALL, 100);

    expect(rest.every((r) => r.slackUserId === AWA)).toBe(true);
  });

  it('rend 0 quand il n’y avait rien — un compte, jamais un booléen', async () => {
    // Même contrat que `clear()` et `claimForDispatch` : on RENTRE UN COMPTE, parce que
    // « je n'avais rien retenu » et « c'est effacé » sont deux phrases différentes à dire.
    expect(await archive.forgetUser({ slackUserId: 'U_INCONNU' })).toBe(0);
  });

  it('purge par ancienneté — la rétention que rien n’appelait', async () => {
    const removed = await archive.prune(BASE_TS + 2500);

    expect(removed).toBe(2);
    expect(await archive.pendingDistillation(ALL, 100)).toHaveLength(2);
  });
});

describe('les faits distillés', () => {
  let facts: InMemoryKnowledgeFactRepository;

  beforeEach(async () => {
    facts = new InMemoryKnowledgeFactRepository();
    let n = 0;
    const add = (channelId: string, slackUserId: string) =>
      facts.record({
        id: `f${(n += 1)}`,
        channelId,
        slackUserId,
        kind: 'decision',
        summary: `fait ${n}`,
        score: 5,
        postedAt: BASE_TS + n * 1000,
      });

    await add(DM, KARYL);
    await add(CHANNEL, KARYL);
    await add(CHANNEL, AWA);
  });

  it('suit la même portée que l’archive dont ils sont dérivés', async () => {
    // ⚠️ Si les deux divergeaient, un fait distillé d'un DM effacé survivrait à son message
    // source — et `searchKnowledge` le rendrait encore, ce qui est la pire des deux moitiés :
    // la trace disparaît, le résumé reste.
    const removed = await facts.forgetUser({ slackUserId: KARYL, channelId: DM });

    expect(removed).toBe(1);
    expect(await facts.recent({})).toHaveLength(2);
  });

  it('efface partout sans canal', async () => {
    expect(await facts.forgetUser({ slackUserId: KARYL })).toBe(2);
  });
});
