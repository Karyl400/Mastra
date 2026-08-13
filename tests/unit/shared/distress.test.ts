import { describe, expect, it } from 'vitest';
import { DISTRESS_REPLY, detectsDistress } from '../../../src/shared/distress';

/**
 * ⚠️ C'est le seul module de ce dépôt où un défaut peut nuire à une PERSONNE, et non au
 * produit. L'arbitrage des tests s'en déduit : un faux négatif est bien plus grave qu'un
 * faux positif, et les deux sont testés séparément pour que personne ne « corrige » l'un en
 * cassant l'autre.
 */
describe('detectsDistress', () => {
  const INTERCEPTED = [
    'je veux mourir',
    "j'ai envie de mourir",
    'je pense à me faire du mal',
    "j'ai des idées noires depuis des semaines",
    'je ne vais pas bien du tout',
    'je suis à bout, je craque',
    'je crois que je fais un burn out',
    'je suis harcelé par mon manager',
    'je subis du harcèlement moral depuis mon arrivée',
    'mon responsable me menace tous les jours',
    "je pense que c'est de la discrimination",
  ];

  for (const text of INTERCEPTED) {
    it(`intercepte : « ${text} »`, () => {
      expect(detectsDistress(text)).toBe(true);
    });
  }

  it('reconnaît une détresse NOYÉE dans une phrase — critère inverse de la salutation', () => {
    // `isBareGreeting` exige une égalité stricte parce qu'une vraie demande commence
    // souvent par « bonjour ». Ici c'est l'inverse : une détresse est presque toujours
    // enfouie, et la manquer coûte infiniment plus cher qu'un faux positif.
    expect(
      detectsDistress(
        'Bonjour, désolé de te déranger avec ça mais je ne vais pas bien et je ne sais pas à qui en parler',
      ),
    ).toBe(true);
  });

  it("fonctionne sans accent ni majuscule — c'est ainsi qu'on écrit quand on va mal", () => {
    expect(detectsDistress('je suis harcele au travail')).toBe(true);
    expect(detectsDistress('JE VEUX MOURIR')).toBe(true);
  });

  const IGNORED = [
    'bonjour',
    "il me faudrait le guide d'accueil en PDF",
    'crée un profil pour Léa Bamba',
    'où en est mon dossier ?',
    'envoie-lui un rappel pour lundi',
    'ça ne marche pas très bien ton truc',
    "j'ai mal compris ta réponse, tu peux reformuler ?",
  ];

  for (const text of IGNORED) {
    it(`laisse passer : « ${text} »`, () => {
      expect(detectsDistress(text)).toBe(false);
    });
  }

  it("ignore un document collé — au-delà de 2000 caractères ce n'est plus une confidence", () => {
    expect(detectsDistress('a'.repeat(2001) + ' je veux mourir')).toBe(false);
  });

  it('ignore le vide', () => {
    expect(detectsDistress('')).toBe(false);
    expect(detectsDistress(undefined)).toBe(false);
    expect(detectsDistress(null)).toBe(false);
  });
});

describe('DISTRESS_REPLY', () => {
  it("NOMME un humain à joindre — c'est tout l'objet du message", () => {
    // `NEUTRAL_REFUSAL` a été réécrit pour ne renvoyer vers personne, à raison pour un refus
    // de sécurité. Cette décision avait supprimé le dernier endroit du système qui
    // mentionnait un être humain. Ici, ne renvoyer vers personne serait une faute.
    expect(DISTRESS_REPLY).toContain('3114');
    expect(DISTRESS_REPLY).toContain('RH');
  });

  it('ne diagnostique rien et ne promet aucune transmission', () => {
    expect(DISTRESS_REPLY).toContain("Je n'ai pas transmis");
  });
});
