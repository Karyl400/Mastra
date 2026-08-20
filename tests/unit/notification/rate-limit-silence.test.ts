/**
 * LE SILENCE À PARTIR DU 7ᵉ MESSAGE — indiscernable d'une panne.
 *
 * `evaluateCount` posait `shouldNotify: count === rule.limit + 1`. Le message qui suit
 * immédiatement le plafond recevait donc une explication, et les suivants RIEN du tout.
 *
 * Le rationnement lui-même est juste : sans lui, la limitation devient son propre spam —
 * défaut réellement constaté le 2026-08-20, quand un compteur figé rendait
 * `count === limit + 1` vrai à chaque message. Mais l'égalité stricte n'est pas le bon
 * outil : `claimNotification` fait DÉJÀ ce rationnement, par fenêtre, et il le fait mieux.
 *
 * Trois façons dont l'égalité stricte perd son unique occasion de parler :
 *   - deux messages simultanés portent le compteur de `limit` à `limit + 2` d'un coup ;
 *   - le seul message à `limit + 1` tombe sur une instance dont la prise de notification
 *     a déjà été consommée ;
 *   - un refus survient sur une règle dont le compteur a été rendu (restitution de prise).
 * Dans les trois cas, la personne n'entend plus jamais parler de son quota — et le silence
 * ne se distingue pas d'un bot en panne. C'est l'asymétrie que ce dépôt applique partout
 * ailleurs, et qui n'était pas appliquée ici.
 */
import { describe, it, expect } from 'vitest';

import { evaluateCount } from '../../../src/features/notification/domain/services/rate-limit-policy';

const RULE = { name: 'daily', limit: 5, windowMs: 86_400_000 } as const;

describe('evaluateCount — qui mérite une explication', () => {
  it('autorise jusqu’au plafond inclus', () => {
    for (let count = 1; count <= 5; count += 1) {
      expect(evaluateCount(RULE, count).allowed).toBe(true);
    }
    expect(evaluateCount(RULE, 6).allowed).toBe(false);
  });

  it('propose une explication à CHAQUE refus, pas au seul premier', () => {
    // Le rationnement réel vit dans `claimNotification`, qui ne laisse passer qu'une
    // notification par fenêtre. Ici on dit seulement « celui-ci mériterait d'être informé ».
    for (const count of [6, 7, 12, 40]) {
      expect(evaluateCount(RULE, count).shouldNotify, `count=${count}`).toBe(true);
    }
  });

  it('ne propose rien tant que rien n’est refusé', () => {
    for (const count of [1, 5]) {
      expect(evaluateCount(RULE, count).shouldNotify).toBe(false);
    }
  });

  it('reste passant sur un compteur illisible', () => {
    // Un compteur absent ou négatif est une anomalie de lecture, pas un dépassement :
    // refuser dessus couperait quelqu'un sur une panne de base.
    for (const count of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(evaluateCount(RULE, count).allowed).toBe(true);
      expect(evaluateCount(RULE, count).shouldNotify).toBe(false);
    }
  });
});
