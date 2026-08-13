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

  /**
   * Le contrôle de débit tourne AVANT l'ACK Slack, qui n'a que 3 secondes — et ce dépôt a déjà
   * payé un ACK à 6,7 s d'une double réponse en production (2026-08-11 12:38 UTC). Deux règles
   * enchaînées séquentiellement, c'était deux latences réseau additionnées sur ce chemin-là.
   *
   * Ces tests verrouillent la propriété, pas le chrono : les allers-retours partagés sont EN
   * VOL EN MÊME TEMPS, et le court-circuit local qui les évite tous n'a pas été sacrifié pour
   * l'obtenir.
   */
  describe('coût du chemin pré-ACK', () => {
    const BURST: RateLimitRule = { name: 'burst', limit: 2, windowMs: 60_000 };
    const DAILY: RateLimitRule = { name: 'daily', limit: 100, windowMs: 86_400_000 };

    /** Dépôt qui mesure le PARALLÉLISME réel, pas seulement le nombre d'appels. */
    function tracingRepository(delayMs = 0) {
      const counts = new Map<string, number>();
      const state = { inFlight: 0, peakInFlight: 0, keys: [] as string[] };

      const repository: RateLimitRepository = {
        async increment(key) {
          state.inFlight += 1;
          state.peakInFlight = Math.max(state.peakInFlight, state.inFlight);
          state.keys.push(key);
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          state.inFlight -= 1;
          const next = (counts.get(key) ?? 0) + 1;
          counts.set(key, next);
          return next;
        },
        async prune() {
          return 0;
        },
      };

      return { repository, state };
    }

    it('lance les incréments des deux règles EN PARALLÈLE, pas l’un après l’autre', async () => {
      const { repository, state } = tracingRepository(20);
      const limiter = new SlackRateLimiter({ rules: [BURST, DAILY], repository });

      await limiter.check('U1', new Date(0));

      // TROIS clés depuis le 2026-08-13 : `burst`, `daily`, et la lecture du budget de tokens
      // de l'ÉQUIPE. Cette dernière voyage dans le MÊME lot — c'est ce test qui a rattrapé la
      // première version, où elle était séquentielle et ajoutait donc un aller-retour au
      // chemin de l'ACK Slack, qui n'a que 3 secondes.
      //
      // La propriété n'est pas le NOMBRE de clés (il suivra le câblage) mais le fait qu'elles
      // soient TOUTES en vol simultanément : le contrôle coûte une latence, pas N.
      expect(state.keys).toHaveLength(3);
      expect(state.peakInFlight).toBe(state.keys.length);
    });

    it('coûte une seule latence réseau, pas la somme des deux', async () => {
      const { repository } = tracingRepository(50);
      const limiter = new SlackRateLimiter({ rules: [BURST, DAILY], repository });

      const startedAt = Date.now();
      await limiter.check('U1', new Date(0));
      const elapsed = Date.now() - startedAt;

      // Séquentiel : ≥ 100 ms. Parallèle : ≈ 50 ms. La marge est large à dessein — c'est
      // l'ordre de grandeur qui porte la propriété, pas le chiffre.
      expect(elapsed).toBeLessThan(90);
    });

    it('n’incrémente AUCUN compteur des règles suivantes quand une règle refuse localement', async () => {
      // C'est la sémantique que la parallélisation ne devait pas emporter. Un message refusé
      // ne déclenche aucun appel LLM : il ne consomme pas un token du budget journalier que
      // `daily` existe pour protéger. Le compter ferait brûler ses ≈12 messages du jour à
      // quelqu'un qui n'aura jamais obtenu une seule réponse.
      const { repository, state } = tracingRepository();
      const limiter = new SlackRateLimiter({ rules: [BURST, DAILY], repository });
      const now = new Date(0);

      for (let i = 0; i < BURST.limit; i += 1) await limiter.check('U1', now);
      const callsBeforeRefusal = state.keys.length;

      const refused = await limiter.check('U1', now);
      expect(refused.allowed).toBe(false);
      expect(refused.rule).toBe('burst');

      // Zéro aller-retour supplémentaire — ni pour `burst`, ni surtout pour `daily`.
      expect(state.keys).toHaveLength(callsBeforeRefusal);
      expect(state.keys.filter((key) => key.startsWith('daily:'))).toHaveLength(BURST.limit);
    });

    it('cite la règle par ORDRE DE DÉCLARATION, jamais par ordre d’arrivée des réponses', async () => {
      // En parallèle, les réponses reviennent dans un ordre que le réseau décide. Le nom qui
      // remonte jusqu'au message adressé à l'utilisateur, lui, ne doit pas en dépendre.
      const bothFull: RateLimitRepository = {
        async increment(key) {
          // La règle déclarée en second répond la PREMIÈRE.
          if (key.startsWith('burst:')) await new Promise((resolve) => setTimeout(resolve, 30));
          return 999;
        },
        async prune() {
          return 0;
        },
      };

      const limiter = new SlackRateLimiter({ rules: [BURST, DAILY], repository: bothFull });
      const decision = await limiter.check('U1', new Date(0));

      expect(decision.allowed).toBe(false);
      expect(decision.rule).toBe('burst');
    });

    it('reste dégradé-ouvert quand UNE des règles parallèles échoue', async () => {
      // Fail-open bruyant, doctrine constante : un message de trop est visible et corrigeable,
      // un bot muet ne l'est pas.
      const halfBroken: RateLimitRepository = {
        async increment(key) {
          if (key.startsWith('daily:')) throw new Error('no such table: rate_limit_counters');
          return 1;
        },
        async prune() {
          return 0;
        },
      };

      const limiter = new SlackRateLimiter({ rules: [BURST, DAILY], repository: halfBroken });
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

/**
 * ════════════════════════════════════════════════════════════════════════════
 * RATIONNER CE QUI NE COÛTE RIEN — défaut observé EN PRODUCTION le 2026-08-13
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Relevé par une sonde de production : une personne ayant atteint ses 12 messages du jour
 * écrit « bonjour » et reçoit « J'ai atteint mon quota de messages pour aujourd'hui ». Pour
 * un mot auquel le bot répond SANS appeler de modèle, donc pour zéro token.
 *
 * Et le même refus serait tombé sur « je ne vais pas bien » — soit très exactement le message
 * que `distress.ts` existe pour ne jamais laisser sans réponse. C'est ce cas-là qui rend le
 * correctif nécessaire, pas le confort d'une salutation.
 *
 * La règle JOURNALIÈRE dit d'elle-même sa raison d'être : « 12 < 19 (le plafond réel du
 * fournisseur) ». Elle rationne un budget de MODÈLE. Elle n'a donc rien à dire d'un message
 * qui n'en consomme pas. La règle de RAFALE, elle, contre l'abus — un script qui inonde le
 * bot de « bonjour » reste un script — et continue donc de s'appliquer.
 */
describe('SlackRateLimiter — ce qui ne coûte pas de modèle n’est pas rationné', () => {
  const BUDGET_RULE: RateLimitRule = {
    name: 'daily',
    limit: 2,
    windowMs: 86_400_000,
    rationsModelBudget: true,
  };
  const ABUSE_RULE: RateLimitRule = { name: 'burst', limit: 3, windowMs: 60_000 };

  it('n’oppose PAS un budget épuisé à un message traité sans modèle', async () => {
    const limiter = new SlackRateLimiter({
      rules: [BUDGET_RULE],
      repository: countingRepository(),
    });
    const now = new Date(0);

    // Le budget est consommé jusqu'au refus par de vraies questions.
    await limiter.check('U1', now);
    await limiter.check('U1', now);
    expect((await limiter.check('U1', now)).allowed).toBe(false);

    // …et pourtant une salutation passe encore. C'est tout l'objet du correctif.
    const greeting = await limiter.check('U1', now, { answeredWithoutModel: true });
    expect(greeting.allowed).toBe(true);
  });

  it('ne CONSOMME pas le budget non plus', async () => {
    // Aussi important que ne pas refuser : sans cela, une salutation gratuite retirerait
    // quand même une unité au budget d'une vraie question posée plus tard.
    const limiter = new SlackRateLimiter({
      rules: [BUDGET_RULE],
      repository: countingRepository(),
    });
    const now = new Date(0);

    await limiter.check('U1', now, { answeredWithoutModel: true });
    await limiter.check('U1', now, { answeredWithoutModel: true });
    await limiter.check('U1', now, { answeredWithoutModel: true });

    // Les deux unités du budget sont intactes.
    expect((await limiter.check('U1', now)).allowed).toBe(true);
    expect((await limiter.check('U1', now)).allowed).toBe(true);
    expect((await limiter.check('U1', now)).allowed).toBe(false);
  });

  it('applique TOUJOURS la règle anti-abus, même sans modèle', async () => {
    // L'exemption porte sur le budget, jamais sur l'abus : un script qui inonde le bot de
    // salutations reste un script, et chaque réponse est un appel à l'API Slack.
    const limiter = new SlackRateLimiter({
      rules: [ABUSE_RULE, BUDGET_RULE],
      repository: countingRepository(),
    });
    const now = new Date(0);

    for (let i = 0; i < 3; i += 1) {
      expect((await limiter.check('U1', now, { answeredWithoutModel: true })).allowed).toBe(true);
    }

    const flooded = await limiter.check('U1', now, { answeredWithoutModel: true });
    expect(flooded.allowed).toBe(false);
    expect(flooded.rule).toBe('burst');
  });
});
