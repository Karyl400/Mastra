import { describe, it, expect } from 'vitest';

import {
  PROMISED_DELIVERY_NOTICE,
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
    expect(PROMISED_DELIVERY_NOTICE).toMatch(/automate/i);
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
