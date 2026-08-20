/**
 * LA COURSE SUR LE BUDGET MODÈLE — le garde-fou de coût était contournable par simultanéité.
 *
 * Depuis le 2026-08-15, le budget modèle n'est plus débité à l'ACK mais juste avant
 * `agent.generate()`. La raison est bonne et ne doit pas être défaite : un fil abandonné en
 * tâche de fond ne coûte alors plus rien à personne.
 *
 * Mais la conséquence n'avait pas été traitée : `check()` en mode `reserveOnly` LIT le
 * compteur sans le poser, et `consumeModelBudget()` le débite bien plus tard. Entre les deux,
 * tout le traitement. N messages en vol lisent donc le MÊME compteur, passent tous, puis
 * débitent tous.
 *
 * Sur un système dont la contrainte dominante est un plafond de ≈ 19 messages par JOUR, c'est
 * le garde-fou de coût lui-même qui saute — et sans aucun log de refus pour le signaler.
 *
 * ⚠️ LE CORRECTIF NE DOIT PAS REDEVENIR UN DÉBIT À L'ACK. La prise a lieu au moment du débit,
 * et elle est ATOMIQUE : on incrémente, on regarde ce que l'incrément a rendu, et si l'on
 * vient de dépasser on REND la prise. C'est la même forme que `clear()` sur l'email
 * d'entretien — on prend d'abord, on agit si la prise a réussi — et c'est ce qui distingue
 * une garde d'une supposition.
 */
import { describe, it, expect } from 'vitest';

import { SlackRateLimiter } from '../../../src/features/notification/infrastructure/services/slack-rate-limiter';
import type { RateLimitRepository } from '../../../src/features/notification/domain/ports/rate-limit.repository';

const SUBJECT = 'U0BM123';

/** Dépôt partagé RÉEL en mémoire : c'est l'atomicité de `increment` qui est en jeu. */
function sharedRepository(): RateLimitRepository & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async increment(key, _windowStart, _expiresAt, by) {
      const next = (counts.get(key) ?? 0) + (by ?? 1);
      counts.set(key, next);
      return next;
    },
    async prune() {
      return 0;
    },
  };
}

/** Une seule règle quotidienne, pour isoler le budget modèle de la rafale. */
function limiterWithDailyLimit(limit: number, repository: RateLimitRepository) {
  return new SlackRateLimiter({
    repository,
    rules: [
      {
        name: 'daily',
        limit,
        windowMs: 24 * 60 * 60 * 1000,
        rationsModelBudget: true,
      },
    ],
  });
}

describe('budget modèle — la prise est atomique', () => {
  it('REFUSE le débit qui ferait dépasser le plafond', async () => {
    const repo = sharedRepository();
    const limiter = limiterWithDailyLimit(2, repo);

    expect((await limiter.claimModelBudget(SUBJECT)).allowed).toBe(true);
    expect((await limiter.claimModelBudget(SUBJECT)).allowed).toBe(true);
    expect((await limiter.claimModelBudget(SUBJECT)).allowed).toBe(false);
  });

  it('REND la prise quand elle est refusée — le compteur ne dérive pas', async () => {
    // Sans restitution, chaque refus gonflerait le compteur : la personne serait pénalisée
    // pour des messages qui n'ont jamais atteint le modèle, et le plafond deviendrait un
    // compteur de tentatives plutôt qu'un compteur de dépense.
    const repo = sharedRepository();
    const limiter = limiterWithDailyLimit(1, repo);

    await limiter.claimModelBudget(SUBJECT);
    await limiter.claimModelBudget(SUBJECT);
    await limiter.claimModelBudget(SUBJECT);

    const [count] = [...repo.counts.values()];
    expect(count).toBe(1);
  });

  it('tient sous la course : dix prises simultanées, trois autorisées', async () => {
    // LE test de ce fichier. Dix messages en vol, plafond à trois. Avant correctif, les dix
    // lisaient le même compteur et passaient tous.
    const repo = sharedRepository();
    const limiter = limiterWithDailyLimit(3, repo);

    const verdicts = await Promise.all(
      Array.from({ length: 10 }, () => limiter.claimModelBudget(SUBJECT)),
    );

    expect(verdicts.filter((v) => v.allowed)).toHaveLength(3);
  });

  it('cloisonne par personne — la dépense de l’un ne ferme pas la porte de l’autre', async () => {
    const repo = sharedRepository();
    const limiter = limiterWithDailyLimit(1, repo);

    expect((await limiter.claimModelBudget('U0AAA')).allowed).toBe(true);
    expect((await limiter.claimModelBudget('U0BBB')).allowed).toBe(true);
  });
});

describe('dépôt partagé indisponible', () => {
  it('reste passant, mais le signale à CHAQUE fois', async () => {
    // ⚠️ Le fail-open est délibéré et documenté : un message de trop est visible, un bot muet
    // ne l'est pas. Ce qui ne l'était pas, c'est qu'il ne se journalisait qu'UNE FOIS PAR
    // INSTANCE. Sur des instances serverless éphémères, cela vaut une ligne par démarrage à
    // froid — noyée, donc invisible. Or dans cet état les trois règles se réduisent au
    // compteur local, inopérant sur une instance froide : c'est la protection du quota
    // journalier qui disparaît entièrement.
    const failing: RateLimitRepository = {
      async increment() {
        throw new Error('turso down');
      },
      async prune() {
        return 0;
      },
    };
    const limiter = limiterWithDailyLimit(5, failing);

    const first = await limiter.claimModelBudget(SUBJECT);
    const second = await limiter.claimModelBudget(SUBJECT);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(first.degraded).toBe(true);
    expect(second.degraded).toBe(true);
  });
});
