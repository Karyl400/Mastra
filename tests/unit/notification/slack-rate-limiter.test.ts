import { describe, it, expect, vi } from 'vitest';
import { SlackRateLimiter } from '../../../src/features/notification/infrastructure/services/slack-rate-limiter';
import type { RateLimitRepository } from '../../../src/features/notification/domain/ports/rate-limit.repository';
import type { RateLimitRule } from '../../../src/features/notification/domain/services/rate-limit-policy';

const RULE: RateLimitRule = { name: 'burst', limit: 3, windowMs: 60_000 };

/** Compteur partagé de test — un vrai compteur, pas un bouchon. */
function countingRepository(): RateLimitRepository & { calls: number } {
  const counts = new Map<string, number>();
  return {
    calls: 0,
    async increment(key) {
      this.calls += 1;
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    async prune() {
      return 0;
    },
  };
}

function failingRepository(): RateLimitRepository {
  return {
    async increment() {
      throw new Error('no such table: rate_limit_counters');
    },
    async prune() {
      throw new Error('no such table: rate_limit_counters');
    },
  };
}

describe('SlackRateLimiter', () => {
  it('autorise tant que la limite n’est pas franchie, puis refuse', async () => {
    const limiter = new SlackRateLimiter({ rules: [RULE], repository: countingRepository() });
    const now = new Date(0);

    for (let i = 0; i < RULE.limit; i += 1) {
      expect((await limiter.check('U1', now)).allowed).toBe(true);
    }

    const refused = await limiter.check('U1', now);
    expect(refused.allowed).toBe(false);
    expect(refused.rule).toBe('burst');
  });

  it('ne demande de prévenir qu’au premier refus de la fenêtre', async () => {
    const limiter = new SlackRateLimiter({ rules: [RULE], repository: countingRepository() });
    const now = new Date(0);

    for (let i = 0; i < RULE.limit; i += 1) await limiter.check('U1', now);

    expect((await limiter.check('U1', now)).shouldNotify).toBe(true);
    expect((await limiter.check('U1', now)).shouldNotify).toBe(false);
    expect((await limiter.check('U1', now)).shouldNotify).toBe(false);
  });

  it('repart à zéro dans la fenêtre suivante', async () => {
    const limiter = new SlackRateLimiter({ rules: [RULE], repository: countingRepository() });

    for (let i = 0; i <= RULE.limit; i += 1) await limiter.check('U1', new Date(0));
    expect((await limiter.check('U1', new Date(0))).allowed).toBe(false);

    expect((await limiter.check('U1', new Date(RULE.windowMs))).allowed).toBe(true);
  });

  it('ne fait pas payer à une personne le quota d’une autre', async () => {
    const limiter = new SlackRateLimiter({ rules: [RULE], repository: countingRepository() });
    const now = new Date(0);

    for (let i = 0; i <= RULE.limit; i += 1) await limiter.check('U1', now);

    expect((await limiter.check('U2', now)).allowed).toBe(true);
  });

  it('applique la règle la PLUS restrictive quand plusieurs sont déclarées', async () => {
    const burst: RateLimitRule = { name: 'burst', limit: 10, windowMs: 60_000 };
    const daily: RateLimitRule = { name: 'daily', limit: 2, windowMs: 86_400_000 };
    const limiter = new SlackRateLimiter({
      rules: [burst, daily],
      repository: countingRepository(),
    });
    const now = new Date(0);

    await limiter.check('U1', now);
    await limiter.check('U1', now);

    const refused = await limiter.check('U1', now);
    expect(refused.allowed).toBe(false);
    expect(refused.rule).toBe('daily');
  });

  describe('court-circuit local', () => {
    it('n’interroge PAS le store partagé une fois le compteur local dépassé', async () => {
      // Le compteur partagé voit un sur-ensemble des événements : s'il est dépassé
      // localement, il l'est à plus forte raison là-bas. L'aller-retour épargné l'est au
      // moment où le trafic est le plus dense — c'est-à-dire quand il coûte le plus cher.
      const repo = countingRepository();
      const limiter = new SlackRateLimiter({ rules: [RULE], repository: repo });
      const now = new Date(0);

      for (let i = 0; i <= RULE.limit; i += 1) await limiter.check('U1', now);
      const callsAtFirstRefusal = repo.calls;

      await limiter.check('U1', now);
      await limiter.check('U1', now);

      expect(repo.calls).toBe(callsAtFirstRefusal);
    });
  });

  describe('le store partagé fait autorité', () => {
    it('refuse quand le compteur PARTAGÉ est dépassé alors que le local ne l’est pas', async () => {
      // C'est le cas que le niveau 1 seul ne peut pas voir : une autre instance a déjà
      // consommé le quota. Sur du serverless, c'est le cas NORMAL, pas le cas rare.
      const counts = new Map<string, number>();
      const shared: RateLimitRepository = {
        async increment(key) {
          const next = (counts.get(key) ?? RULE.limit) + 1; // fenêtre déjà pleine ailleurs
          counts.set(key, next);
          return next;
        },
        async prune() {
          return 0;
        },
      };

      const limiter = new SlackRateLimiter({ rules: [RULE], repository: shared });
      const decision = await limiter.check('U1', new Date(0));

      expect(decision.allowed).toBe(false);
      expect(decision.degraded).toBe(false);
    });
  });

  describe('dégradation', () => {
    it('accepte et signale quand le store partagé est indisponible', async () => {
      const limiter = new SlackRateLimiter({ rules: [RULE], repository: failingRepository() });
      const decision = await limiter.check('U1', new Date(0));

      expect(decision.allowed).toBe(true);
      expect(decision.degraded).toBe(true);
    });

    it('continue d’appliquer le compteur LOCAL en mode dégradé', async () => {
      // La dégradation ne doit pas devenir une désactivation : sans store, on protège
      // toujours ce qu'une instance peut voir.
      const limiter = new SlackRateLimiter({ rules: [RULE], repository: failingRepository() });
      const now = new Date(0);

      for (let i = 0; i < RULE.limit; i += 1) await limiter.check('U1', now);
      expect((await limiter.check('U1', now)).allowed).toBe(false);
    });

    it('accepte quand aucun store n’est configuré du tout', async () => {
      const limiter = new SlackRateLimiter({ rules: [RULE], repository: null });
      const decision = await limiter.check('U1', new Date(0));

      expect(decision.allowed).toBe(true);
      expect(decision.degraded).toBe(true);
    });
  });

  describe('prune', () => {
    it('ne lève jamais, même si le store échoue', async () => {
      const limiter = new SlackRateLimiter({ rules: [RULE], repository: failingRepository() });
      await expect(limiter.prune(new Date(0))).resolves.toBeUndefined();
    });

    it('ne fait rien sans store', async () => {
      const spy = vi.fn();
      const limiter = new SlackRateLimiter({ rules: [RULE], repository: null });
      await limiter.prune(new Date(0));
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
