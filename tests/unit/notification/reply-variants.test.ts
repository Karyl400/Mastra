import { describe, it, expect } from 'vitest';

import {
  DETERMINISTIC_REPLIES,
  replyFor,
} from '../../../src/features/notification/domain/services/deterministic-replies';
import { pickVariant } from '../../../src/shared/reply-variants';
import { detectUnsupportedCompletionClaim } from '../../../src/features/notification/domain/services/claim-reconciliation';
import { DISTRESS_REPLY, DISTRESS_REPLY_EN } from '../../../src/shared/distress';

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

  it('la détresse répond dans la LANGUE de la détresse — même message, même numéros', () => {
    // Une détresse écrite en anglais recevait un message en français. Les numéros sont
    // identiques (SURPIN et le 112 sont des chiffres, ils ne se traduisent pas) ; c'est le
    // texte qui l'entoure qui doit être lisible par la personne qui l'a écrit.
    const distress = DETERMINISTIC_REPLIES.find((entry) => entry.name === 'distress');

    expect(replyFor(distress!, { text: 'je veux mourir' })).toBe(DISTRESS_REPLY);
    expect(replyFor(distress!, { text: 'I want to die' })).toBe(DISTRESS_REPLY_EN);
  });

  it('la détresse est JOURNALISÉE sans son texte — longueur et langue seulement', () => {
    // ⚠️ Le DM au bot est le canal où se disent un salaire, un arrêt maladie ou un litige.
    // On journalise donc qu'une détection a eu lieu, jamais ce qui a été confié.
    const distress = DETERMINISTIC_REPLIES.find((entry) => entry.name === 'distress');
    const text = 'I want to die and I have nobody to talk to';

    const fields = distress!.logFields!({ text, isDirectMessage: true });

    expect(fields).toEqual({
      isDirectMessage: true,
      textLength: text.length,
      distressLanguage: 'en',
    });
    expect(JSON.stringify(fields)).not.toContain('die');
  });

  it('un court-circuit AGISSANT ne rend aucun texte figé', () => {
    const acting = DETERMINISTIC_REPLIES.filter((entry) => entry.reply === null);
    for (const entry of acting) {
      expect(replyFor(entry, { text: '' }), entry.name).toBeNull();
    }
  });
});

describe('les textes écrits en dur sont du mrkdwn Slack, pas du markdown GitHub', () => {
  /**
   * ⚠️ DÉFAUT CONSTATÉ EN PRODUCTION LE 2026-08-18, sur le message de DÉTRESSE — le pire
   * endroit possible. Le numéro d'urgence s'affichait entouré de doubles astérisques :
   * `**0800 0787 746**`. Slack utilise mrkdwn (`*gras*`), pas le markdown GitHub
   * (`**gras**`).
   *
   * La cause est structurelle et vaut pour TOUS les textes en dur : `sanitizeAgentOutput`
   * convertit le markdown en mrkdwn, mais il n'a qu'un seul site d'appel — `response.text`,
   * la réponse d'un MODÈLE. Les réponses déterministes sont postées directement par le
   * handler et ne passent par aucun filtre. Ce qui est écrit ici part tel quel.
   */
  const hardCoded = [
    ...DETERMINISTIC_REPLIES.flatMap((entry) => [entry.reply, ...(entry.variants ?? [])]),
  ].filter((text): text is string => typeof text === 'string');

  it.each(hardCoded)('« %s » n’emploie pas de gras GitHub', (text) => {
    expect(text).not.toContain('**');
  });

  it('vérifie bien quelque chose — la liste n’est pas vide', () => {
    expect(hardCoded.length).toBeGreaterThan(5);
  });
});
