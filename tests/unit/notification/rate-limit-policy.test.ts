import { describe, it, expect } from 'vitest';
import {
  buildCounterKey,
  evaluateCount,
  windowBounds,
  readRuleLimit,
  BURST_RULE,
  DAILY_RULE,
  type RateLimitRule,
} from '../../../src/features/notification/domain/services/rate-limit-policy';

const RULE: RateLimitRule = { name: 'burst', limit: 3, windowMs: 60_000 };

describe('buildCounterKey', () => {
  it('range dans la même fenêtre deux instants du même intervalle', () => {
    const a = buildCounterKey(RULE, 'U1', new Date(120_000));
    const b = buildCounterKey(RULE, 'U1', new Date(179_999));
    expect(a).toBe(b);
  });

  it('change de fenêtre au franchissement de l’intervalle', () => {
    const a = buildCounterKey(RULE, 'U1', new Date(179_999));
    const b = buildCounterKey(RULE, 'U1', new Date(180_000));
    expect(a).not.toBe(b);
  });

  it('sépare deux sujets dans la même fenêtre', () => {
    expect(buildCounterKey(RULE, 'U1', new Date(0))).not.toBe(
      buildCounterKey(RULE, 'U2', new Date(0)),
    );
  });

  it('sépare deux règles pour le même sujet au même instant', () => {
    const burst = buildCounterKey(BURST_RULE, 'U1', new Date(0));
    const daily = buildCounterKey(DAILY_RULE, 'U1', new Date(0));
    expect(burst).not.toBe(daily);
  });

  it('n’est pas ambigu quand un identifiant contient le séparateur', () => {
    // Sans échappement, `rule:a:b:<fenêtre>` et `rule:a:b:<fenêtre>` pourraient désigner
    // deux sujets différents et partager un compteur — donc un sujet consommerait le quota
    // d’un autre, ou s’en offrirait un second.
    const a = buildCounterKey(RULE, 'a:b', new Date(0));
    const b = buildCounterKey(RULE, 'a', new Date(0));
    expect(a).not.toBe(b);
  });
});

describe('windowBounds', () => {
  it('aligne le début de fenêtre sur un multiple de l’intervalle', () => {
    const { windowStart } = windowBounds(RULE, new Date(150_000));
    expect(windowStart.getTime()).toBe(120_000);
  });

  it('fait expirer la ligne APRÈS la fin de la fenêtre', () => {
    // Purger à l’instant exact de la fin ferait disparaître un compteur encore décisif pour
    // une instance dont l’horloge est légèrement en retard.
    const { windowStart, expiresAt } = windowBounds(RULE, new Date(150_000));
    expect(expiresAt.getTime()).toBeGreaterThan(windowStart.getTime() + RULE.windowMs);
  });
});

describe('evaluateCount', () => {
  it('autorise tant que le compte reste sous la limite', () => {
    expect(evaluateCount(RULE, 1)).toEqual({ allowed: true, shouldNotify: false });
    expect(evaluateCount(RULE, 3)).toEqual({ allowed: true, shouldNotify: false });
  });

  it('refuse au-delà de la limite', () => {
    expect(evaluateCount(RULE, 4).allowed).toBe(false);
  });

  it('propose de prévenir à CHAQUE refus — le rationnement vit ailleurs', () => {
    // ⚠️ CE TEST ATTENDAIT L'INVERSE (`4 → true`, `5 → false`, `99 → false`), et sa raison
    // était juste mais placée à la MAUVAISE COUCHE — corrigé le 2026-08-20.
    //
    // Elle disait : « les suivants ne doivent RIEN poster, sinon la limitation de débit
    // devient elle-même un amplificateur ». C'est vrai, et c'est exactement ce que fait
    // `claimNotification` dans `SlackRateLimiter` : une notification par fenêtre et par
    // règle, la clé portant le numéro de fenêtre. L'égalité stricte était donc un SECOND
    // rationnement, plus faible, qui faisait perdre l'unique occasion de parler.
    //
    // Trois façons de la perdre, toutes réelles : deux messages simultanés portent le
    // compteur de `limit` à `limit + 2` d'un coup ; le seul message à `limit + 1` tombe sur
    // une instance dont la prise a déjà été consommée ; un refus survient après restitution
    // d'une prise. Dans les trois cas la personne n'entend plus jamais parler de son quota,
    // et le silence ne se distingue pas d'un bot en panne.
    //
    // Cette fonction dit « celui-ci mériterait d'être informé », pas « poste maintenant ».
    expect(evaluateCount(RULE, 4).shouldNotify).toBe(true);
    expect(evaluateCount(RULE, 5).shouldNotify).toBe(true);
    expect(evaluateCount(RULE, 99).shouldNotify).toBe(true);
  });

  it('traite un compte non exploitable comme une autorisation', () => {
    // Un compteur illisible n’est pas un dépassement constaté. Sans preuve positive, on
    // laisse passer — même arbitrage que la déduplication partagée.
    expect(evaluateCount(RULE, 0).allowed).toBe(true);
    expect(evaluateCount(RULE, Number.NaN).allowed).toBe(true);
  });
});

describe('readRuleLimit', () => {
  it('retient la valeur d’environnement quand elle est un entier positif', () => {
    expect(readRuleLimit('7', 5)).toBe(7);
  });

  it('retombe sur le défaut sur une valeur absente, vide ou non numérique', () => {
    expect(readRuleLimit(undefined, 5)).toBe(5);
    expect(readRuleLimit('  ', 5)).toBe(5);
    expect(readRuleLimit('beaucoup', 5)).toBe(5);
  });

  it('retombe sur le défaut sur zéro ou une valeur négative', () => {
    // Une limite à 0 couperait 100 % du trafic. Une faute de frappe dans une variable
    // d’environnement ne doit pas pouvoir éteindre le bot en silence.
    expect(readRuleLimit('0', 5)).toBe(5);
    expect(readRuleLimit('-3', 5)).toBe(5);
  });
});

describe('les deux règles livrées', () => {
  it('la rafale est plus courte et plus permissive que le budget journalier', () => {
    expect(BURST_RULE.windowMs).toBeLessThan(DAILY_RULE.windowMs);
    expect(BURST_RULE.limit).toBeLessThan(DAILY_RULE.limit);
  });

  it('le budget journalier reste sous le plafond de tokens du fournisseur', () => {
    // ≈ 19 messages/jour tous canaux confondus (100 000 tokens/jour ÷ 5 168 par message).
    // Un plafond PAR PERSONNE au-dessus de ce chiffre ne protégerait rien.
    expect(DAILY_RULE.limit).toBeLessThan(19);
  });
});
