import { describe, it, expect } from 'vitest';

import {
  toPrintableText,
  type GlyphSource,
} from '../../../src/features/document/domain/services/printable-text';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « DES CARACTÈRES INDÉSIRABLES SONT APPARUS DANS LES DOCUMENTS »
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le dépôt s'en protégeait par une LISTE DE PLAGES écrite à la main. Question posée à Roboto
 * — la seule police du VFS de pdfmake — sur 151 caractères qu'un modèle écrit réellement en
 * français : **quatre passaient au travers**, dont l'espace fine insécable U+202F, que la
 * typographie française insère devant `!`, `?`, `;`, `:` et que `Intl` émet dans les heures.
 *
 * Elle est INVISIBLE dans un `console.log`, dans un diff, dans une revue — et elle s'imprime
 * en carré. Un caractère qu'on ne peut pas voir à la source et qu'on voit dans le PDF : c'est
 * exactement le défaut signalé.
 *
 * ⚠️ Ces tests n'utilisent PAS la vraie police. Ce qu'ils verrouillent est le MÉCANISME —
 * « demander plutôt qu'énumérer » — et les replis. La police, elle, est interrogée pour de
 * vrai par le renderer, et le journal (`Caractères sans glyphe remplacés au rendu PDF`) dit
 * ce qu'elle a répondu.
 */

/** Une police qui connaît le latin de base et rien d'autre. */
const latinOnly: GlyphSource = { hasGlyph: (cp) => cp < 0x0250 };

describe('toPrintableText — la police décide, pas une liste', () => {
  it('laisse intact ce que la police connaît', () => {
    const result = toPrintableText('Bonjour Karyl, ça va ?', latinOnly);

    expect(result.text).toBe('Bonjour Karyl, ça va ?');
    expect(result.replaced).toEqual([]);
  });

  it('remplace une FLÈCHE plutôt que de la supprimer', () => {
    // La supprimer donnerait « étape 1 étape 2 », qui a perdu son sens. Personne ne lit `->`
    // comme une trace de filtrage.
    const result = toPrintableText('étape 1 → étape 2', latinOnly);

    expect(result.text).toBe('étape 1 -> étape 2');
    expect(result.replaced).toEqual(['U+2192']);
  });

  it('remplace l’espace fine insécable par une espace ORDINAIRE — jamais par rien', () => {
    // La supprimer collerait les mots : « 12 h » deviendrait « 12h », « Karyl : » deviendrait
    // « Karyl: ». Le repli a la même largeur à l'œil et un glyphe garanti.
    const result = toPrintableText('12 h 30', latinOnly);

    expect(result.text).toBe('12 h 30');
    expect(result.replaced).toEqual(['U+202F']);
  });

  it('SUPPRIME ce dont l’absence ne se voit pas', () => {
    // Le dépôt a déjà tranché pour les emojis : « [emoji] » rendrait visible, dans un document
    // d'accueil, une trace de filtrage, là où l'absence se lit comme une phrase normale.
    const result = toPrintableText('Bravo ★ Karyl', latinOnly);

    expect(result.text).toBe('Bravo  Karyl');
    expect(result.replaced).toEqual(['U+2605']);
  });

  it('ne coupe JAMAIS une paire de substitution en deux', () => {
    // Un `split('')` rendrait deux demi-surrogates, dont aucune n'a de glyphe : on
    // remplacerait un emoji par DEUX carrés au lieu d'un. L'itération se fait sur les code
    // points, et le répertoire journalisé le prouve — une seule entrée, hors du plan de base.
    const result = toPrintableText('fête 🎉 finie', latinOnly);

    expect(result.replaced).toEqual(['U+1F389']);
    expect(result.text).toBe('fête  finie');
  });

  it('laisse les BLANCS STRUCTURELS sans consulter la police', () => {
    // `\n` et `\t` ne sont pas rendus par un glyphe mais interprétés par la mise en page. Les
    // demander à la police rendrait `false` et détruirait les paragraphes.
    const result = toPrintableText('ligne 1\nligne 2\tsuite', { hasGlyph: () => false });

    expect(result.text).toContain('\n');
    expect(result.text).toContain('\t');
  });

  it('DÉDUPLIQUE et TRIE le répertoire journalisé', () => {
    // C'est le répertoire qui intéresse, pas le nombre d'occurrences : une ligne par caractère
    // ferait du bruit sur un texte qui en contient cinquante.
    const result = toPrintableText('→ ★ → ★ →', latinOnly);

    expect(result.replaced).toEqual(['U+2192', 'U+2605']);
  });

  it('échoue OUVERT : une police qui dit oui à tout ne change rien', () => {
    // Le renderer répond `true` partout quand la police est illisible (fontkit absent,
    // TTF corrompu). On retombe alors exactement sur le comportement d'avant ce correctif —
    // des carrés possibles, jamais un rendu perdu.
    const brut = 'étape 1 → 🎉 ★';
    const result = toPrintableText(brut, { hasGlyph: () => true });

    expect(result.text).toBe(brut);
    expect(result.replaced).toEqual([]);
  });
});
