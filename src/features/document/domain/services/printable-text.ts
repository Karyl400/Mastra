/**
 * CE QUE LA POLICE SAIT ÉCRIRE — et ce qu'elle imprimerait en carré.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Le défaut, signalé par le propriétaire : « des caractères indésirables sont
 * apparus dans les documents »
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Roboto est la SEULE police injectée dans le VFS de pdfmake. Tout code point qu'elle ne
 * connaît pas s'imprime en `.notdef` — le carré. Le dépôt s'en protégeait déjà, mais par une
 * LISTE DE PLAGES écrite à la main :
 *
 *     /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]|\u{FE0F}|\u{200D}/gu
 *
 * Question posée à la police elle-même, sur un échantillon de 151 caractères que le modèle
 * écrit réellement en français : **quatre passaient au travers.**
 *
 *   • `→` U+2192, `⇒` U+21D2, `↦` U+21A6 — les flèches. Hors de toutes les plages, et un
 *     modèle en écrit dès qu'il décrit une séquence (« étape 1 → étape 2 »).
 *   • **U+202F, l'espace fine insécable** — et c'est celui qui compte. La typographie
 *     française l'insère devant `!`, `?`, `;`, `:` et à l'intérieur des guillemets ; `Intl`
 *     l'émet dans les nombres et les heures. Elle est INVISIBLE dans un `console.log`, dans un
 *     diff, dans une revue — et elle s'imprime en carré. Un caractère qu'on ne peut pas voir
 *     dans le texte source et qu'on voit dans le PDF : c'est la définition du défaut signalé.
 *
 * ── POURQUOI ON NE RALLONGE PAS LA LISTE ────────────────────────────────────
 * Ce serait la quatrième liste tenue à la main de ce dépôt, et les trois précédentes ont
 * toutes divergé du réel (`WIRING`, `_measure.mts`, les instructions nommant des tools
 * retirés). Une liste de plages ne peut pas suivre le vocabulaire d'un modèle.
 *
 * On INVERSE donc la question : au lieu d'énumérer ce qui casse, on demande à la police ce
 * qu'elle sait rendre. Un caractère exotique de plus dans le vocabulaire du modèle ne peut
 * plus jamais produire un carré — il sera simplement inconnu de la police, donc traité.
 *
 * ── TypeScript PUR ──────────────────────────────────────────────────────────
 * La police est une affaire d'INFRASTRUCTURE : ce module reçoit un prédicat et ne connaît ni
 * pdfmake, ni fontkit, ni Roboto. C'est ce qui le rend éprouvable sans charger 3 Mo de TTF.
 */

/** Ce que la couche de rendu sait dire de sa police. */
export interface GlyphSource {
  hasGlyph(codePoint: number): boolean;
}

/**
 * Remplacements pour les caractères sans glyphe dont l'ABSENCE se verrait.
 *
 * ⚠️ Ce n'est PAS la détection — celle-ci vient de la police. C'est le repli, et il ne porte
 * que sur les cas où supprimer produirait une phrase abîmée :
 *
 *   • une flèche retirée de « étape 1 → étape 2 » donne « étape 1 étape 2 », qui a perdu son
 *     sens ; `->` le garde, et personne ne lit ça comme une trace de filtrage ;
 *   • une espace insécable retirée COLLE les mots (« 12 h » → « 12h », « Karyl : » → « Karyl: »).
 *     L'espace ordinaire est le repli exact : même largeur à l'œil, glyphe garanti.
 *
 * Tout le reste — emojis, symboles décoratifs — est SUPPRIMÉ sans substitution. Le dépôt a
 * déjà tranché ce point pour les emojis : « [emoji] » rendrait visible, dans un document
 * d'accueil, une trace de filtrage, là où l'absence se lit comme une phrase normale.
 */
const FALLBACKS: Readonly<Record<number, string>> = {
  0x2192: '->', // →
  0x21d2: '=>', // ⇒
  0x21a6: '->', // ↦
  0x2190: '<-', // ←
  0x2194: '<->', // ↔
  0x202f: ' ', // espace fine insécable
  0x2007: ' ', // espace chiffre
  0x2009: ' ', // espace fine
  0x200a: ' ', // espace ultra-fine
  0x2060: '', // gluon de mots — invisible, sans largeur
  0xfeff: '', // BOM en milieu de texte
};

export interface PrintableText {
  readonly text: string;
  /**
   * Les code points traités, en `U+XXXX`, DÉDUPLIQUÉS et triés.
   *
   * ⚠️ Journalisés, jamais rendus au modèle. C'est la liste qu'on relit pour savoir ce que le
   * modèle écrit réellement — et le seul moyen d'apprendre qu'un caractère nouveau circule
   * avant qu'un humain ne le voie dans un PDF.
   */
  readonly replaced: readonly string[];
}

/**
 * Rend un texte imprimable par la police donnée.
 *
 * ⚠️ Itère sur les CODE POINTS (`for…of`), jamais sur les unités UTF-16. Un `split('')`
 * couperait les paires de substitution en deux moitiés invalides, et une moitié de surrogate
 * n'a évidemment aucun glyphe : on remplacerait un emoji par deux carrés au lieu d'un.
 *
 * ⚠️ Les caractères de contrôle et les blancs structurels (`\n`, `\t`) sont laissés
 * INTACTS sans consulter la police : ils ne sont pas rendus par un glyphe mais interprétés
 * par la mise en page. Les demander à la police rendrait `false` et détruirait les
 * paragraphes.
 */
export function toPrintableText(raw: string, glyphs: GlyphSource): PrintableText {
  const seen = new Set<string>();
  let out = '';

  for (const char of raw) {
    const cp = char.codePointAt(0)!;

    if (cp < 0x20 || cp === 0x7f) {
      out += char;
      continue;
    }

    if (glyphs.hasGlyph(cp)) {
      out += char;
      continue;
    }

    seen.add(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    out += FALLBACKS[cp] ?? '';
  }

  return { text: out, replaced: [...seen].sort() };
}
