import { describe, it, expect, vi } from 'vitest';

import { affectedRowsOrFallback, affectedRowsOrThrow } from '../../../src/shared/rows-affected';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « JE N'AI PAS PU COMPTER » N'EST PAS « ZÉRO » — audit du 2026-08-28, § 9bis.1
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le motif `(result as { rowsAffected?: number }).rowsAffected ?? 0` a ONZE occurrences dans ce
 * dépôt. Il est écrit ainsi parce que Drizzle rend `unknown` au point d'appel — le `?? 0` n'est
 * pas une négligence, c'est un repli devant un type absent.
 *
 * ⚠️ **Mais un repli n'est jamais neutre : il a une DIRECTION, et elle diffère par site.** Le
 * dépôt a déjà tranché deux cas, et il a eu raison les deux fois :
 *
 *   — `PendingInterviewEmailRepository.clear()` : `0` signifie « je n'ai pas pris, je n'envoie
 *     pas ». Personne ne reçoit deux convocations ; quelqu'un n'en reçoit aucune. C'est le bon
 *     sens de panne pour un envoi IRRÉVERSIBLE à un candidat. **On n'y touche pas.**
 *   — La déduplication Slack : `0` fait écarter l'événement comme un doublon, donc un bot muet.
 *     Mauvais sens — mais `claimEvent` a un repli DOCUMENTÉ sur le cache local qui ACCEPTE
 *     l'événement, donc une exception y est rattrapée et dégrade correctement.
 *
 * Cette fonction est pour les sites où `0` MENT :
 *
 *   — la prise d'un rappel : chaque prise devient un refus, donc **panne totale des rappels,
 *     rapportée en `200 {ok: true, sent: 0}`** ;
 *   — l'effacement : la suppression RÉUSSIT et Marcel répond « je n'avais rien retenu de nos
 *     échanges ». La personne croit qu'il n'y avait rien à effacer. **Tout vient d'être
 *     détruit**, sur le seul chemin irréversible du produit.
 *
 * Elle LÈVE, parce qu'une panne bruyante est réparable et qu'un mensonge tranquille ne l'est pas.
 */

describe('`affectedRowsOrThrow`', () => {
  it('lit `rowsAffected` — le champ du pilote libsql', () => {
    expect(affectedRowsOrThrow({ rowsAffected: 3 }, 'test')).toBe(3);
  });

  it('lit `changes` — le champ de better-sqlite3', () => {
    expect(affectedRowsOrThrow({ changes: 2 }, 'test')).toBe(2);
  });

  it('accepte ZÉRO, qui est un compte parfaitement valide', () => {
    // La distinction est là, tout entière : « zéro ligne touchée » est un FAIT, et il doit
    // passer. C'est « je n'ai pas pu compter » qui ne doit pas se déguiser en zéro.
    expect(affectedRowsOrThrow({ rowsAffected: 0 }, 'test')).toBe(0);
  });

  it('LÈVE quand le champ est absent, au lieu de rendre 0', () => {
    expect(() => affectedRowsOrThrow({}, 'la prise du rappel')).toThrow(/la prise du rappel/);
  });

  it('LÈVE sur un champ non numérique, jamais coercé en silence', () => {
    expect(() => affectedRowsOrThrow({ rowsAffected: '1' }, 'test')).toThrow();
    expect(() => affectedRowsOrThrow({ rowsAffected: NaN }, 'test')).toThrow();
  });

  it('LÈVE sur `null` et sur `undefined`', () => {
    expect(() => affectedRowsOrThrow(null, 'test')).toThrow();
    expect(() => affectedRowsOrThrow(undefined, 'test')).toThrow();
  });

  it("nomme l'opération — un diagnostic sans sujet envoie chercher partout", () => {
    expect(() => affectedRowsOrThrow({}, "l'effacement des tours de conversation")).toThrow(
      /effacement des tours de conversation/,
    );
  });
});

describe('`affectedRowsOrFallback` — le repli est DÉCLARÉ, jamais muet', () => {
  it('rend le compte réel quand le pilote le donne, sans rien signaler', () => {
    const onUnknown = vi.fn();
    expect(affectedRowsOrFallback({ rowsAffected: 1 }, 'la prise', 0, onUnknown)).toBe(1);
    expect(onUnknown).not.toHaveBeenCalled();
  });

  it('rend le repli ET le signale quand le compte est illisible', () => {
    const onUnknown = vi.fn();
    expect(affectedRowsOrFallback({}, 'la prise d’un email', 0, onUnknown)).toBe(0);
    expect(onUnknown).toHaveBeenCalledWith(
      expect.stringMatching(/prise d’un email.*Repli déclaré : 0/),
    );
  });
});
