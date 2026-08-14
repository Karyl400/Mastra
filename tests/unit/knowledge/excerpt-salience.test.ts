import { describe, it, expect } from 'vitest';

import type { ConversationExcerpt } from '../../../src/features/knowledge/domain/entities/conversation-excerpt';
import {
  signalScore,
  selectSalientExcerpts,
} from '../../../src/features/knowledge/domain/services/excerpt-salience';
import {
  MAX_EXCERPTS,
  describeCoverage,
  projectExcerpts,
} from '../../../src/features/knowledge/domain/services/excerpt-budget';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « mets l'attention sur les détails les plus importants »
 * ════════════════════════════════════════════════════════════════════════════
 *
 * La sélection ne triait que par DATE : on rendait les 6 derniers messages. Or les 6 derniers
 * messages d'un canal ne sont presque jamais les 6 importants — ce sont « ok », « merci »,
 * « 👍 ». À « résume ce qui s'est dit », le modèle recevait donc les accusés de réception
 * d'une décision dont il ne voyait pas l'énoncé. Et ce dépôt sait ce qu'un modèle fait devant
 * un vide : il comble.
 */

const T0 = new Date('2026-08-11T09:00:00.000Z');

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

function excerpt(text: string, minutes: number, speaker = 'Karyl'): ConversationExcerpt {
  return { source: 'channel', speaker, text, at: at(minutes) };
}

describe('signalScore — ce qui porte de l’information', () => {
  it('classe une DÉCISION au-dessus d’un accusé de réception', () => {
    expect(signalScore('on part sur Turso pour la prod')).toBeGreaterThan(signalScore('ok'));
    expect(signalScore('c’est validé, on décale la livraison')).toBeGreaterThan(signalScore('👍'));
  });

  it('classe un BLOCAGE et un ENGAGEMENT au-dessus d’un message neutre', () => {
    const neutre = signalScore('je regarde la documentation ce matin tranquillement');
    expect(signalScore('le déploiement est bloqué, la base ne répond plus')).toBeGreaterThan(
      neutre,
    );
    expect(signalScore('je m’en occupe cet après-midi')).toBeGreaterThan(neutre);
  });

  it('PÉNALISE les accusés de réception purs', () => {
    for (const bruit of ['ok', 'merci', 'parfait', 'noté', '👍', 'd’accord']) {
      expect(signalScore(bruit), bruit).toBeLessThan(0);
    }
  });

  it('ne pénalise PAS un « ok » qui porte autre chose', () => {
    // ⚠️ Le motif est ancré des deux bouts pour cette raison exacte : « ok pour moi, mais on
    // décale à jeudi » porte une décision et une échéance. Le pénaliser reviendrait à écarter
    // précisément le genre de message qu'on cherche.
    expect(signalScore('ok pour moi, mais on décale à jeudi')).toBeGreaterThan(0);
  });

  it('remonte une QUESTION — un fil ouvert n’est peut-être pas résolu', () => {
    expect(signalScore('qui reprend le sujet facturation ?')).toBeGreaterThan(
      signalScore('je reprends le sujet facturation'),
    );
  });

  it('BORNE le score : un message truffé de mots-clés ne rafle pas la sélection', () => {
    const bourrage =
      'urgent bloqué problème panne décision validé deadline lundi je m’en occupe https://x.io <@U01> ?';
    const normal = signalScore('on part sur Turso');
    // Il reste au-dessus, mais pas d'un ordre de grandeur.
    expect(signalScore(bourrage)).toBeLessThan(normal * 4);
  });
});

describe('selectSalientExcerpts — le bruit récent ne chasse plus le signal ancien', () => {
  it('garde la DÉCISION ancienne et écarte les « ok » récents', () => {
    // Le scénario exact du défaut : une décision, puis huit accusés de réception.
    const all = [
      excerpt('on part sur Turso pour la production, c’est acté', 0),
      ...Array.from({ length: 8 }, (_, i) => excerpt('ok', 10 + i)),
      excerpt('merci', 30),
    ];

    const selected = selectSalientExcerpts(all, MAX_EXCERPTS);
    const textes = selected.map((e) => e.text);

    expect(textes).toContain('on part sur Turso pour la production, c’est acté');
  });

  it('rend TOUJOURS dans l’ordre chronologique', () => {
    const all = [
      excerpt('ok', 0),
      excerpt('on a décidé de reporter', 5),
      excerpt('le build est cassé', 10),
      excerpt('merci', 15),
      excerpt('je m’en occupe', 20),
      excerpt('qui prend la revue ?', 25),
      excerpt('👍', 30),
      excerpt('deadline vendredi', 35),
    ];

    const selected = selectSalientExcerpts(all, MAX_EXCERPTS);
    const stamps = selected.map((e) => e.at.getTime());
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  it('est DÉTERMINISTE — deux ordres d’entrée rendent la même sélection', () => {
    // `getNotificationHistory` n'avait aucun `ORDER BY` : deux appels identiques pouvaient
    // rendre deux ordres différents.
    const all = Array.from({ length: 20 }, (_, i) => excerpt(`message numéro ${i}`, i));
    const a = selectSalientExcerpts(all, MAX_EXCERPTS).map((e) => e.text);
    const b = selectSalientExcerpts([...all].reverse(), MAX_EXCERPTS).map((e) => e.text);
    expect(b).toEqual(a);
  });

  it('à saillance ÉGALE, préfère le plus récent', () => {
    const all = Array.from({ length: 12 }, (_, i) => excerpt(`point de situation ${i}`, i));
    const selected = selectSalientExcerpts(all, MAX_EXCERPTS);
    expect(selected.at(-1)!.text).toBe('point de situation 11');
  });

  it('ne change NI le nombre NI la taille — la propriété de budget tient', () => {
    // C'est l'invariant central du module voisin : la sortie ne dépend ni du nombre de
    // messages ni de leur longueur. La saillance change QUELS extraits passent, pas COMBIEN.
    const petit = projectExcerpts(Array.from({ length: 10 }, (_, i) => excerpt(`msg ${i}`, i)));
    const grand = projectExcerpts(Array.from({ length: 500 }, (_, i) => excerpt(`msg ${i}`, i)));
    expect(grand.shown).toBe(petit.shown);
    expect(grand.shown).toBe(MAX_EXCERPTS);
  });

  it('rend une liste vide sans lever', () => {
    expect(selectSalientExcerpts([], MAX_EXCERPTS)).toEqual([]);
  });
});

describe('describeCoverage — dire ce qu’on ne montre PAS', () => {
  it('nomme le nombre, la période, et que ce ne sont pas les plus récents', () => {
    const all = Array.from({ length: 40 }, (_, i) => excerpt(`msg ${i}`, i * 60));
    const coverage = describeCoverage(all, 6)!;

    expect(coverage).toContain('6');
    expect(coverage).toContain('40');
    expect(coverage).toContain('2026-08-11');
    // Le point décisif : le modèle doit savoir qu'il regarde un ÉCHANTILLON.
    expect(coverage).toMatch(/PAS les plus récents/i);
    expect(coverage).toMatch(/Ne conclus pas/i);
  });

  it('est ABSENTE quand tout a été montré — un hint inutile se paie à chaque tour', () => {
    const all = Array.from({ length: 3 }, (_, i) => excerpt(`msg ${i}`, i));
    expect(describeCoverage(all, 3)).toBeUndefined();
    expect(describeCoverage([], 0)).toBeUndefined();
  });

  it('gère une période d’un seul jour sans écrire « du X au X »', () => {
    const all = Array.from({ length: 20 }, (_, i) => excerpt(`msg ${i}`, i));
    expect(describeCoverage(all, 6)).toContain('le 2026-08-11');
  });
});
