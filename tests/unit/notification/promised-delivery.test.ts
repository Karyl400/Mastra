import { describe, it, expect } from 'vitest';

import {
  PROMISED_DELIVERY_NOTICE,
  UNSUPPORTED_CLAIM_NOTICE,
  detectUnsupportedDeliveryPromise,
} from '../../../src/features/notification/domain/services/claim-reconciliation';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * La PROMESSE D'AVENIR — le symétrique de la réconciliation FAIT / NARRATION
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `detectUnsupportedCompletionClaim` guette l'ACCOMPLI non appuyé par un outil. Il ne peut
 * rien contre la faute inverse, mesurée en production le 2026-08-18 :
 *
 *     « Le rappel a été enregistré. **Il sera envoyé à Karyl par email le 20 août 2026
 *       à 09 h 00**, avec le sujet … »
 *
 * Le verbe d'accompli est juste — le rappel EST enregistré, `scheduleReminder` a tourné.
 * C'est la suite qui est fausse : il n'existe ni cron, ni poller, et `findPending()` n'a
 * aucun site d'appel. Rien ne partira, jamais. La réconciliation existante se tait par
 * conception, puisqu'un outil a bien tourné.
 *
 * ⚠️ **Et la consigne de prompt a été ESSAYÉE D'ABORD, puis mesurée en échec.** La ligne
 * « Un rappel est seulement ENREGISTRÉ : aucun automate ne l'enverra, dis-le sans détour »
 * a été ajoutée au `notificationAgent`, déployée, et la réponse suivante en production a été
 * PIRE que celle d'avant — elle a gagné une date et une heure d'envoi précises. C'est la
 * démonstration, sur ce dépôt et sur ce cas, de la doctrine qu'il applique déjà ailleurs :
 * une consigne est PROBABLE, le code est GARANTI. Même issue que le champ `coverage`, ignoré
 * deux fois avant d'être inliné.
 */

describe('la promesse d’envoi automatique est détectée', () => {
  it.each([
    'Il sera envoyé à Karyl par email le 20 août 2026 à 09h00.',
    'Le rappel partira lundi matin.',
    'Je le lui enverrai vendredi.',
    'Elle recevra le message demain.',
    'Le mail sera transmis automatiquement.',
  ])('« %s »', (text) => {
    expect(detectUnsupportedDeliveryPromise(text)).not.toBeNull();
  });
});

/**
 * ⚠️ **LES DEUX FORMES LES PLUS COURANTES N'ÉTAIENT DÉTECTÉES PAR RIEN — 2026-08-21.**
 *
 * Le motif `je … enverrai` énumérait les pronoms `le `, `la `, `lui `, `les `, `leur `, `vous `
 * et l'élidé `t'`. Il lui manquait l'élidé **`l'`**, c'est-à-dire précisément ce que produit
 * l'usage : « je te l'enverrai », « je vous l'enverrai ». Le motif couvrait « je le enverrai »,
 * que personne n'écrit.
 *
 * Trouvé en écrivant un test pour tout autre chose, comme « je veux en finir » dans le
 * détecteur de détresse le même jour. C'est la leçon : un détecteur ne se relit pas, il
 * s'exerce sur des phrases que des gens diraient.
 */
describe('les formes élidées, celles que les gens tapent vraiment', () => {
  it.each([
    "Je te l'enverrai lundi matin.",
    'Je te l’enverrai lundi matin.',
    "Je vous l'enverrai dans la semaine.",
    'Je le lui transmettrai demain.',
    "Je m'en occupe et je te l'adresserai vendredi.",
  ])('« %s »', (text) => {
    expect(detectUnsupportedDeliveryPromise(text)).not.toBeNull();
  });
});

describe('ce qui ne doit PAS déclencher — la liste est FERMÉE, comme celle de l’accompli', () => {
  it.each([
    // Une OFFRE n'est pas une promesse : « je peux » a toujours été hors motif, et c'est le
    // critère qui distingue une contradiction d'une invraisemblance.
    'Je peux le lui envoyer si tu veux.',
    'Veux-tu que je l’envoie maintenant ?',
    // Le passé : c'est le domaine de `detectUnsupportedCompletionClaim`, pas celui-ci.
    'Le message a été envoyé hier.',
    // Un envoi qui dépend d'un CLIC humain est vrai : c'est exactement le contrat de la
    // carte de recrutement, et l'écraser d'une note de démenti serait un défaut de plus.
    'Il ne partira qu’après ton clic sur « Envoyer ».',
    "L'email s'affiche pour relecture et ne sera envoyé qu'après confirmation.",
  ])('« %s »', (text) => {
    expect(detectUnsupportedDeliveryPromise(text)).toBeNull();
  });
});

describe('la note', () => {
  it('nomme ce qui NE se produira pas, sans prétendre que rien n’a eu lieu', () => {
    // ⚠️ Contrat différent de `UNSUPPORTED_CLAIM_NOTICE` : là-bas rien n'a été exécuté, ici
    // l'enregistrement a bel et bien eu lieu. Dire « aucune action n'a été exécutée »
    // serait faux et détruirait la seule partie vraie du message.
    //
    // ⚠️ CETTE ASSERTION DISAIT `toMatch(/automate/i)` jusqu'au 2026-08-21. Elle verrouillait
    // un MOT là où son propre commentaire décrit une PROPRIÉTÉ — et ce mot appartenait à une
    // formulation d'architecte (« aucun automate ne l'enverra — il n'y en a aucun dans ce
    // système ») qu'on retire précisément parce qu'elle ne parle pas comme Marcel. Le test
    // aurait donc interdit la correction du ton en gardant l'apparence de protéger le fond.
    //
    // Les deux moitiés sont désormais nommées : ce qui A eu lieu, et ce qui n'aura pas lieu.
    // ⚠️ **CETTE ASSERTION A ÉTÉ RETOURNÉE LE 2026-08-21.** Elle exigeait « rien ne partira
    // tout seul ». Depuis le cron quotidien, cette phrase est FAUSSE dans le cas nominal —
    // un rappel enregistré part. La note ne s'accole plus que lorsqu'une livraison a été
    // promise SANS aucun enregistrement : ce qu'elle doit dire est donc que rien n'a été
    // NOTÉ, et le geste qui répare.
    expect(PROMISED_DELIVERY_NOTICE, "rien n'a été enregistré").toMatch(/enregistr/i);
    expect(PROMISED_DELIVERY_NOTICE, 'et donc rien ne partira').toMatch(/rien ne partira/i);
    expect(PROMISED_DELIVERY_NOTICE, 'le geste qui répare').toMatch(/redis-le-moi/i);
    expect(PROMISED_DELIVERY_NOTICE).not.toMatch(/aucune action n'a été exécutée/i);
  });

  it('est du mrkdwn Slack, jamais du markdown GitHub', () => {
    // Les textes en dur ne passent par aucun filtre : `sanitizeAgentOutput` n'a qu'un seul
    // site d'appel, `response.text`. Un `**gras**` s'afficherait littéralement — constaté le
    // 2026-08-18 sur le message de détresse.
    expect(PROMISED_DELIVERY_NOTICE).not.toContain('**');
  });
});

/**
 * « RAPPEL PLANIFIÉ » — la promesse relevée en production le 2026-08-19.
 *
 * Réponse littérale de `notificationAgent` : « Rappel planifié : … à 09 h 00 le lundi 22 août
 * 2026 ». `scheduleReminder` rend pourtant `willBeSentAutomatically: false`, sa description dit
 * « enregistre », et il n'existe dans ce dépôt ni cron, ni poller, ni site d'appel de
 * `findPending()`. Le mot que lit la personne est « planifié », et il promet un envoi qui
 * n'aura jamais lieu.
 *
 * ⚠️ Le mot n'est pas ambigu ICI : ce détecteur ne parle que lorsque le seul outil ayant tourné
 * est un enregistreur sans transport.
 */
describe('la promesse de PLANIFICATION, mesurée en production', () => {
  it('reconnaît « Rappel planifié »', () => {
    expect(detectUnsupportedDeliveryPromise('Rappel planifié : relire le guide.')).not.toBeNull();
    expect(detectUnsupportedDeliveryPromise('Le rappel est planifié pour lundi.')).not.toBeNull();
  });

  it('reconnaît « a bien été programmé » — le synonyme où le modèle est allé se loger', () => {
    // ⚠️ Relevé en production le 2026-08-19 au soir, sur le tour SUIVANT le correctif de
    // « planifié » : « Le rappel a bien été programmé pour le samedi 22 août ». Le synonyme
    // avait été écarté au premier passage comme trop polysémique. Une liste fermée ne tient
    // que si on la referme sur la FAMILLE, pas sur un mot.
    expect(
      detectUnsupportedDeliveryPromise('Le rappel a bien été programmé pour samedi.'),
    ).not.toBeNull();
    expect(detectUnsupportedDeliveryPromise('Il est programmé pour lundi.')).not.toBeNull();
  });

  it('ÉPARGNE le NOM « programme » — l’auxiliaire est exigé', () => {
    expect(
      detectUnsupportedDeliveryPromise('Le programme d’intégration tient en trois étapes.'),
    ).toBeNull();
  });

  it('reconnaît la promesse formulée du côté du destinataire', () => {
    expect(detectUnsupportedDeliveryPromise('Tu recevras un rappel lundi matin.')).not.toBeNull();
    expect(detectUnsupportedDeliveryPromise('Tu seras prévenu lundi.')).not.toBeNull();
  });

  it('ÉPARGNE une simple description de l’enregistrement', () => {
    // Le critère reste la CONTRADICTION avec le câblage, jamais l'invraisemblance : dire ce
    // qu'on a réellement fait ne doit pas être requalifié.
    expect(detectUnsupportedDeliveryPromise("C'est noté pour lundi, je te le redirai.")).toBeNull();
    expect(
      detectUnsupportedDeliveryPromise('Je l’ai enregistré. Aucun automate ne l’enverra.'),
    ).toBeNull();
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA PHRASE HONNÊTE DÉCLENCHAIT LE DÉMENTI — relevé en production le 2026-08-21
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Sonde réelle sur `scheduleReminder`. Le modèle a répondu, exactement comme on le lui
 * demande :
 *
 *   « Sache que ce rappel est seulement enregistré. Aucun automate ne l'enverra, rien ne
 *     partira tout seul le moment venu. »
 *
 * C'est le comportement VOULU. Et le motif `partira` s'est déclenché dessus, si bien qu'une
 * note a été accolée pour dire… la même chose, en moins bien. La personne lisait deux fois
 * l'information, dont une sous forme de démenti administratif.
 *
 * ⚠️ Le détecteur cherche une PROMESSE de livraison future. Une phrase qui NIE cette livraison
 * est le contraire d'une promesse. C'est exactement le défaut corrigé dans `forget.ts` le
 * 2026-08-13 — « je ne veux surtout pas que tu oublies » qui effaçait — et il faut le même
 * remède : la négation se lit AVEC le verbe, jamais en l'ignorant.
 */
describe('une phrase qui NIE la livraison n’est pas une promesse de livraison', () => {
  const HONNETES = [
    "Sache que ce rappel est seulement enregistré. Aucun automate ne l'enverra, rien ne partira tout seul le moment venu.",
    "C'est noté, mais rien ne partira automatiquement.",
    'Il ne sera pas envoyé tout seul — reviens me le demander.',
    'Tu ne recevras aucune relance de ma part.',
    "Je ne l'enverrai pas sans que tu me le redemandes.",
    "Ce rappel n'est pas planifié : il est seulement enregistré.",
  ];

  for (const texte of HONNETES) {
    it(`ne requalifie pas « ${texte.slice(0, 46)}… »`, () => {
      expect(detectUnsupportedDeliveryPromise(texte), texte).toBeNull();
    });
  }

  it('attrape toujours la VRAIE promesse — sinon le garde-fou serait mort', () => {
    // ⚠️ Sans ces assertions, désarmer complètement le détecteur ferait passer ce fichier au
    // vert. C'est le défaut qu'ont eu `READ_ONLY_TOOL_NAMES` et `matchesKeyword` avec `\b`.
    expect(detectUnsupportedDeliveryPromise('Ton rappel partira lundi matin.')).not.toBeNull();
    expect(detectUnsupportedDeliveryPromise('Elle recevra le message demain.')).not.toBeNull();
    expect(detectUnsupportedDeliveryPromise('Le rappel est planifié pour lundi.')).not.toBeNull();
  });

  it('juge PHRASE PAR PHRASE, pas sur le message entier', () => {
    // Une négation quelque part ne doit pas blanchir une promesse ailleurs : sinon il
    // suffirait d'ajouter « rien ne part tout seul » pour faire taire le détecteur.
    expect(
      detectUnsupportedDeliveryPromise(
        'Rien ne partira tout seul. Elle recevra le message demain.',
      ),
    ).not.toBeNull();
  });
});

describe('les deux notes parlent comme Marcel', () => {
  it('ne s’ouvrent plus par « Note : » — un collègue n’annote pas sa propre phrase', () => {
    expect(PROMISED_DELIVERY_NOTICE).not.toContain('Note :');
    expect(UNSUPPORTED_CLAIM_NOTICE).not.toContain('Note :');
  });

  it('avouent, sans jargon : rien n’a été enregistré, donc rien ne partira', () => {
    expect(PROMISED_DELIVERY_NOTICE).toMatch(/rien ne partira/i);
    expect(PROMISED_DELIVERY_NOTICE).not.toMatch(/tool|outil|automate/i);
  });

  it('ne parlent plus du « système » — la personne n’a que faire de son architecture', () => {
    for (const note of [PROMISED_DELIVERY_NOTICE, UNSUPPORTED_CLAIM_NOTICE]) {
      expect(note, note).not.toMatch(/dans ce système|aucune action n'a été exécutée/i);
    }
  });
});
