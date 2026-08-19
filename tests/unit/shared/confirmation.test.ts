import { describe, it, expect } from 'vitest';

import { readsAsNo, readsAsYes } from '../../../src/shared/confirmation';

/**
 * Le seul mot du dépôt qui déclenche un acte IRRÉVERSIBLE : un email part à un candidat, depuis
 * l'adresse de l'entreprise, et rien ne le rattrape.
 *
 * L'asymétrie gouverne les tests comme elle gouverne le code : rater un « oui » fait répéter,
 * en inventer un envoie. Les cas ambigus doivent donc TOUS retomber sur « je ne sais pas ».
 */
describe('readsAsYes — strict par construction', () => {
  it('reconnaît les confirmations qu’un humain écrit vraiment', () => {
    for (const t of ['oui', 'Oui.', 'oui, envoie', 'envoie', 'vas-y', 'je confirme', 'OK envoie']) {
      expect(readsAsYes(t), t).toBe(true);
    }
  });

  it('REFUSE tout ce qui porte une nuance', () => {
    const ambigus = [
      'oui mais avant peux-tu changer la date ?',
      'oui, n’envoie pas tout de suite',
      'oui pour le principe, on en reparle',
      'je crois que oui',
      'oui ?',
      'ouiiii on verra plus tard quand j’aurai relu le texte',
    ];
    for (const t of ambigus) expect(readsAsYes(t), t).toBe(false);
  });

  it('ne prend jamais un refus pour un accord', () => {
    for (const t of ['non', 'non merci', 'annule', 'surtout pas', 'plus tard']) {
      expect(readsAsYes(t), t).toBe(false);
      expect(readsAsNo(t), t).toBe(true);
    }
  });

  it('ne tranche pas sur un message qui parle d’autre chose', () => {
    for (const t of ['génère-moi le guide en PDF', 'qui gère le support ?', '']) {
      expect(readsAsYes(t), t).toBe(false);
      expect(readsAsNo(t), t).toBe(false);
    }
  });

  it('ne se laisse pas noyer — la troncature ne fabrique jamais un accord', () => {
    // ⚠️ La borne de longueur porte sur le texte BRUT. Appliquée après normalisation, elle
    // ne bornait rien : « oui » suivi de cinq mille points d'exclamation se réduisait à trois
    // caractères et passait. Une borne qu'on applique après avoir raccourci ne borne rien.
    expect(readsAsYes('oui'.padEnd(400, ' et surtout pas maintenant'))).toBe(false);
    expect(readsAsYes(`oui${'!'.repeat(5000)}`)).toBe(false);
    expect(readsAsNo(`non${'.'.repeat(5000)}`)).toBe(false);
  });

  it('accepte la ponctuation ORDINAIRE, celle qu’un humain tape vraiment', () => {
    expect(readsAsYes('Oui !')).toBe(true);
    expect(readsAsYes('oui...')).toBe(true);
    expect(readsAsNo('Non.')).toBe(true);
  });

  it('ne confond pas une NÉGATION avec la confirmation qu’elle contient', () => {
    // « n'envoie pas » contient « envoie », qui est un motif d'accord. L'ordre du code — le
    // refus testé EN PREMIER — est ce qui l'empêche, et il doit rester verrouillé.
    expect(readsAsYes('n’envoie pas')).toBe(false);
    expect(readsAsNo('n’envoie pas')).toBe(true);
  });
});
