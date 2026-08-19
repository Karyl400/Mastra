import { describe, it, expect } from 'vitest';

import { textMentionsName } from '../../../src/shared/name-matching';

/**
 * L'asymétrie gouverne : un FAUX POSITIF supprime l'avertissement de destinataire — la mesure
 * de visibilité posée le 2026-08-14 contre le document « Bienvenue Awa » enregistré sous
 * l'UUID de Karyl. Un faux négatif ajoute une note redondante. On penche donc vers la note.
 */
describe('textMentionsName', () => {
  it('reconnaît le nom, avec ou sans ponctuation, avec ou sans accent', () => {
    for (const t of [
      'Le guide a été produit pour Karyl SOUMAILA.',
      'Voilà, c’est prêt pour Karyl.',
      'Document remis à karyl soumaila',
      'Préparé pour Awa TRAORÉ — livré dans ce fil.',
    ]) {
      expect(textMentionsName(t, 'Karyl SOUMAILA') || textMentionsName(t, 'Awa TRAORE'), t).toBe(
        true,
      );
    }
  });

  it('ne prend PAS un fragment pour un nom', () => {
    // ⚠️ `matchesName` répondrait `true` ici : elle rapproche par PRÉFIXE, ce qui est juste
    // quand un humain tape un nom incomplet et faux quand on vérifie qu'une machine l'a écrit.
    expect(textMentionsName('Ta carte est prête.', 'Kar Lyne')).toBe(false);
    expect(textMentionsName('Le document est prêt.', 'Karyl SOUMAILA')).toBe(false);
  });

  it('ignore les jetons trop courts, qui feraient conclure à tort', () => {
    // « Li » apparaît dans « livré », « Bo » dans « bonjour ». Conclure « la personne est
    // nommée » ferait DISPARAÎTRE l'avertissement — le sens dangereux.
    expect(textMentionsName('Le document est livré dans ce fil.', 'Li')).toBe(false);
  });

  it('un nom vide ne correspond à rien — jamais à tout', () => {
    expect(textMentionsName('Bonjour', '')).toBe(false);
    expect(textMentionsName('Bonjour', null)).toBe(false);
    expect(textMentionsName('', 'Karyl')).toBe(false);
  });

  it('reconnaît un nom composé par l’une ou l’autre moitié', () => {
    expect(textMentionsName('C’est prêt pour Noël.', 'Frédéric-Noël DUPONT')).toBe(true);
  });
});
