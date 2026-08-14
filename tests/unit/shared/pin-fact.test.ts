import { describe, it, expect } from 'vitest';

import {
  extractPinnedFact,
  pinnedFactReply,
  MAX_PINNED_FACT_CHARS,
} from '../../../src/shared/pin-fact';
import { requestsErasure } from '../../../src/shared/forget';

/**
 * `TODO.md` du 2026-08-13 : « souviens-toi que… » n'ÉPINGLE rien — le tour est traité comme
 * les autres et peut être évincé par `selectWindow`. Le modèle promet pourtant de s'en
 * souvenir. C'est le défaut central de ce dépôt appliqué à la mémoire.
 */

describe('extractPinnedFact — amorces reconnues', () => {
  const cas: Array<[string, string]> = [
    ['souviens-toi que je préfère les emails le matin', 'je préfère les emails le matin'],
    ['Souviens toi que mon poste est Backend Developer', 'mon poste est Backend Developer'],
    ['retiens que Awa est ma manager', 'Awa est ma manager'],
    ['note que je suis en congé le vendredi', 'je suis en congé le vendredi'],
    ["n'oublie pas que je travaille depuis Dakar", 'je travaille depuis Dakar'],
    ['garde en tête que je préfère le français', 'je préfère le français'],
  ];

  it.each(cas)('« %s » → « %s »', (message, attendu) => {
    expect(extractPinnedFact(message)).toBe(attendu);
  });

  it('conserve accents et majuscules du texte D ORIGINE', () => {
    // Le fait est rendu au modèle à chaque tour : le dégrader trahirait ce qu'on a promis
    // de garder. La normalisation ne sert qu'à reconnaître l'amorce.
    expect(extractPinnedFact('retiens que Frédéric gère les accès')).toBe(
      'Frédéric gère les accès',
    );
  });

  it('tolère une amorce en milieu de phrase', () => {
    expect(extractPinnedFact('au fait, souviens-toi que je change de poste en octobre')).toBe(
      'je change de poste en octobre',
    );
  });
});

describe('extractPinnedFact — ce qui ne demande RIEN', () => {
  const ignores = [
    'bonjour',
    'je me souviens de la réunion',
    'tu te souviens de mon email ?',
    "n'oublie pas de relancer Awa", // « pas de », jamais « pas QUE » : ce n'est pas une note
    'souviens-toi', // amorce sans fait à retenir
    'souviens-toi que', // idem, le reste est vide
    '',
  ];

  it.each(ignores)('« %s »', (message) => {
    expect(extractPinnedFact(message)).toBeNull();
  });

  it('ignore un message trop long pour être une note', () => {
    const pave = `souviens-toi que ${'je te raconte ma semaine en détail. '.repeat(12)}`;
    expect(pave.length).toBeGreaterThan(300);
    expect(extractPinnedFact(pave)).toBeNull();
  });

  it('ne lève pas sur une entrée absente', () => {
    expect(extractPinnedFact(undefined)).toBeNull();
    expect(extractPinnedFact(null)).toBeNull();
  });
});

describe('extractPinnedFact — bornes', () => {
  it('TRONQUE plutôt que de refuser, et le signale', () => {
    // Un fait coupé reste utile ; un fait refusé en silence serait une promesse non tenue
    // de plus. L'ellipse évite que le modèle présente une phrase amputée comme complète.
    // Sous la borne du MESSAGE (300) mais au-dessus de celle du FAIT (120) : c'est la
    // seule fenêtre où la troncature s'observe.
    const long = `retiens que ${'a'.repeat(250)}`;
    const fait = extractPinnedFact(long)!;

    expect(fait.length).toBe(MAX_PINNED_FACT_CHARS);
    expect(fait.endsWith('…')).toBe(true);
  });
});

describe('pin et forget ne se disputent jamais le même message', () => {
  it("« n'oublie pas que… » épingle, et n'efface RIEN", () => {
    // `forget.ts` exige en plus un OBJET désignant la mémoire. Sans lui, aucun conflit.
    const message = "n'oublie pas que je suis en congé vendredi";

    expect(extractPinnedFact(message)).toBe('je suis en congé vendredi');
    expect(requestsErasure(message)).toBe(false);
  });

  it("« oublie ce que je t'ai dit » efface, et n'épingle RIEN", () => {
    const message = "oublie ce que je t'ai dit";

    expect(requestsErasure(message)).toBe(true);
    expect(extractPinnedFact(message)).toBeNull();
  });
});

describe('pinnedFactReply', () => {
  it('CITE le fait retenu', () => {
    // Seule façon pour la personne de vérifier que le découpage déterministe a pris ce
    // qu'elle voulait dire. Une extraction se trompe sans le savoir ; la restitution non.
    expect(pinnedFactReply('je préfère les emails le matin')).toContain(
      'je préfère les emails le matin',
    );
  });
});
