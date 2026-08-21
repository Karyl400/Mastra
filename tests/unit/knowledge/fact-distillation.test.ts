import { describe, expect, it } from 'vitest';

import {
  classifyFact,
  distillFact,
} from '../../../src/features/knowledge/domain/services/fact-distillation';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE FRANÇAIS RÉEL S'ÉCRIT SOUVENT SANS ACCENTS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Trouvé en production le 2026-08-21 par une sonde qui vérifiait tout autre chose : « on a
 * **decide** de partir sur postgres » a été archivé au niveau 1 et n'a produit AUCUN fait au
 * niveau 2. Le motif exigeait `décidé`.
 *
 * Sur un clavier de téléphone, dans la précipitation, en copie d'un outil qui les mange, une
 * bonne part du français s'écrit sans accents. Un classifieur qui échoue en silence sur cette
 * moitié-là est pire qu'absent : il donne l'illusion d'une couverture.
 *
 * Troisième forme du même piège ici, après `\b` en ASCII sur `bloqué` et `matchesKeyword`.
 */
describe('la classification ignore les accents et l’apostrophe typographique', () => {
  it.each([
    ['on a decide de partir sur postgres pour le reporting', 'decision'],
    ['on a décidé de partir sur postgres pour le reporting', 'decision'],
    ['le deploiement est casse depuis ce matin, personne ne peut livrer', 'blocage'],
    ['le déploiement est cassé depuis ce matin, personne ne peut livrer', 'blocage'],
    ['je m’en occupe cet apres-midi et je reviens vers vous', 'engagement'],
    ["je m'en occupe cet après-midi et je reviens vers vous", 'engagement'],
    ['il faut livrer avant le 30, c’est une echeance ferme pour le client', 'echeance'],
  ])('« %s » → %s', (text, kind) => {
    expect(classifyFact(text)).toBe(kind);
  });

  it('le RÉSUMÉ stocké garde ses accents — seule la comparaison les ignore', () => {
    // On ne veut pas d'une base de connaissance écrite en français déquilibré : c'est ce texte
    // qu'un humain relira dans une réponse.
    const fact = distillFact('on a décidé de partir sur postgres pour le reporting mensuel');
    expect(fact?.summary).toContain('décidé');
  });
});
