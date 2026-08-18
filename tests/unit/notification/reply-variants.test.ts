import { describe, it, expect } from 'vitest';

import {
  DETERMINISTIC_REPLIES,
  replyFor,
} from '../../../src/features/notification/domain/services/deterministic-replies';
import { pickVariant } from '../../../src/shared/reply-variants';
import { detectUnsupportedCompletionClaim } from '../../../src/features/notification/domain/services/claim-reconciliation';
import { DISTRESS_REPLY } from '../../../src/shared/distress';

/**
 * Le ton, sans toucher au prompt.
 *
 * Le Conseil a établi que ce qui fait « machine » dans ce produit n'est pas le vocabulaire —
 * il est déjà réglé — mais la RÉPÉTITION LITTÉRALE : un humain ne redit jamais exactement la
 * même phrase la dixième fois qu'on lui dit bonjour. Corriger cela dans le code coûte zéro
 * token et l'effet est garanti, là où une consigne de style serait repayée à chaque étape
 * pour un résultat seulement probable.
 */

describe('pickVariant — déterministe, jamais aléatoire', () => {
  const variants = ['un', 'deux', 'trois'];

  it('rend TOUJOURS la même variante pour la même graine', () => {
    // ⚠️ C'est la propriété qui distingue ce mécanisme de `Math.random()`. Ce dépôt vient de
    // corriger un journal qui tirait au sort les clés qu'il conservait : deux occurrences du
    // même incident produisaient deux lignes différentes, et le champ dont on avait besoin
    // manquait une fois sur deux. Un test ne peut pas verrouiller une réponse aléatoire, et
    // un diagnostic ne peut pas la rejouer.
    const first = pickVariant(variants, '1700000000.000100');
    for (let i = 0; i < 20; i += 1) {
      expect(pickVariant(variants, '1700000000.000100')).toBe(first);
    }
  });

  it('rend la CANONIQUE sans graine — appel hors Slack, workflow, test', () => {
    expect(pickVariant(variants)).toBe('un');
  });

  it('disperse réellement : des horodatages Slack voisins ne donnent pas tous la même', () => {
    // Les `ts` Slack ne diffèrent que par leurs derniers caractères. Un hash qui les
    // disperserait mal rendrait la variation invisible en pratique — le mécanisme serait là
    // et ne servirait à rien.
    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      seen.add(pickVariant(variants, `17000000${String(i).padStart(2, '0')}.000100`));
    }
    expect(seen.size).toBe(variants.length);
  });
});

describe('les variantes ne cassent aucune garantie existante', () => {
  const allVariants = DETERMINISTIC_REPLIES.flatMap((entry) => entry.variants ?? []);

  it('en déclare pour les réponses fréquentes', () => {
    // Sans cette garde, retirer les variantes ne casserait aucun test et le défaut
    // reviendrait en silence.
    expect(allVariants.length).toBeGreaterThan(3);
  });

  /**
   * ⚠️ L'INVARIANT LE PLUS IMPORTANT DE CE FICHIER, et c'est le Conseil qui l'a vu.
   *
   * `claim-reconciliation.ts` détecte une formule d'accompli non appuyée par un appel d'outil
   * au moyen d'une liste FERMÉE de six motifs. C'est l'argument décisif contre le fait de
   * demander au MODÈLE de varier ses formules : il écrirait « voilà, ton document t'attend »,
   * hors motif, donc non requalifié — la variation dégraderait mécaniquement la couverture du
   * seul détecteur de fausses annonces.
   *
   * Ici la variation est du côté du code, donc bornée. Encore faut-il qu'aucune variante ne
   * ressemble elle-même à un accompli : ce sont des réponses postées SANS aucun appel d'outil,
   * et une formule d'accompli y serait un mensonge par construction.
   */
  it('AUCUNE variante ne prend la forme d’un accompli', () => {
    for (const variant of allVariants) {
      expect(detectUnsupportedCompletionClaim(variant), variant).toBeNull();
    }
  });

  it('la DÉTRESSE n’a délibérément aucune variante', () => {
    // Chaque phrase y est pesée — elle nomme une ligne d'écoute, ne diagnostique rien, et
    // promet le silence. Varier n'y apporterait qu'un risque, sur le seul texte du produit
    // dont un défaut peut nuire à une personne.
    const distress = DETERMINISTIC_REPLIES.find((entry) => entry.name === 'distress');
    expect(distress?.variants).toBeUndefined();
    expect(replyFor(distress!, { text: 'peu importe', messageTs: '1700000000.000100' })).toBe(
      DISTRESS_REPLY,
    );
  });

  it('un court-circuit AGISSANT ne rend aucun texte figé', () => {
    const acting = DETERMINISTIC_REPLIES.filter((entry) => entry.reply === null);
    for (const entry of acting) {
      expect(replyFor(entry, { text: '' }), entry.name).toBeNull();
    }
  });
});
