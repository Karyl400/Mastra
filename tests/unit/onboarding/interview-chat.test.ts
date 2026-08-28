import { describe, it, expect } from 'vitest';

import {
  isQuestionToBot,
  skipsInterview,
} from '../../../src/features/onboarding/domain/services/interview-chat';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * Une QUESTION posée au bot n'est pas une description de métier — 2026-08-19
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Trouvé EN PRODUCTION, en testant le comportement des agents. Le clic sur « C'est fait »
 * pose la première question d'entretien et ARME la machine à états. Le message suivant —
 * « qui s'occupe du support technique ? », une vraie question adressée au bot — a été capturé
 * comme la réponse à « ce que tu fais au quotidien », et la question suivante comme la réponse
 * à « comment tu préfères travailler ».
 *
 * ⚠️ Ce n'est pas anodin : ce champ est IMPRIMÉ dans un document au nom de la personne, sous
 * « Ton quotidien », et il est restitué à ses collègues par `findExpertise`. La personne verrait
 * sa propre question devenir sa fiche publique.
 *
 * C'est la même famille que « oublie ce que je t'ai dit » enregistré comme un métier, corrigé
 * le matin même par une autre porte : `captureInterviewAnswer` accepte presque n'importe quel
 * texte, PAR CONCEPTION — on demande à quelqu'un de décrire son travail avec ses mots. Le
 * correctif du matin a fait céder le pas aux court-circuits AGISSANTS puis STATIQUES ; une
 * question ordinaire, elle, passait toujours.
 *
 * ⚠️ LE CRITÈRE N'EST PAS UNE LISTE DE MOTS-CLÉS, et `ESCAPE_INTENTS` a été essayé puis écarté :
 * « je fais de la *recherche* » est une réponse d'entretien parfaitement valide, et `recherche`
 * y est un terme d'échappement. Le signal juste est GRAMMATICAL — on décrit son propre métier à
 * la PREMIÈRE PERSONNE ; on interroge sur quelqu'un d'autre sans elle.
 */
describe('une question adressée au bot n’est pas une réponse d’entretien', () => {
  const questions = [
    'qui s’occupe du support technique ?',
    'qui gère les accès AWS ?',
    'à qui je demande pour un badge ?',
    'comment ça marche ici ?',
    'quelqu’un connaît Kubernetes ?',
  ];

  const reponses = [
    'je fais du support technique niveau 2',
    'je m’occupe du recrutement et de la recherche de profils',
    'mon quotidien c’est surtout de la revue de code',
    'support technique et astreinte',
    'je fais de la recherche utilisateur',
    // Une question qui parle bien de SOI reste une réponse : la première personne tranche.
    'je fais quoi au juste ? du support niveau 2, surtout',
  ];

  it('écarte les questions posées AU bot', () => {
    for (const q of questions) {
      expect(isQuestionToBot(q), q).toBe(true);
    }
  });

  it('garde toute description de son propre travail', () => {
    for (const r of reponses) {
      expect(isQuestionToBot(r), r).toBe(false);
    }
  });

  it('ne se laisse pas piéger par un simple point d’interrogation', () => {
    // Le point d'interrogation seul ne suffit pas : c'est la PREMIÈRE PERSONNE qui décide.
    expect(isQuestionToBot('je préfère l’écrit aux réunions, ça te va ?')).toBe(false);
  });
});

describe('un nom de famille n’est pas une question — corpus à deux colonnes', () => {
  const PATRONYMES = [
    'OUATTARA',
    'Ouattara',
    'Ouedraogo',
    'Ouédraogo',
    'Oumar',
    'Ousmane',
    'Ouorou',
    'Quandt',
    'Quenum',
    'Comlan',
    'Quashie',
    'oumar@kisso.com',
    'ousmane.traore@kisso.com',
  ];

  const VRAIES_QUESTIONS = [
    'Qui gère le support ?',
    'Où est mon dossier ?',
    'Quand ça commence ?',
    'Comment je fais ?',
    'à qui je demande ?',
    'Quel est le canal des devs ?',
    'Pourquoi tu me redemandes ça ?',
    'Combien de temps ça prend ?',
    'Est-ce que tu peux le refaire ?',
    'quelqu’un peut m’aider ?',
  ];

  it.each(PATRONYMES)('« %s » est un NOM, pas une question', (mot) => {
    expect(isQuestionToBot(mot)).toBe(false);
  });

  it.each(VRAIES_QUESTIONS)('« %s » reste une question', (phrase) => {
    expect(isQuestionToBot(phrase)).toBe(true);
  });
});

describe('skipsInterview — un refus est TOUT le message, pas son premier mot', () => {
  const VRAIS_REFUS = [
    'passe',
    'Passe',
    'plus tard',
    'pas maintenant',
    'skip',
    'non merci',
    'non',
    'non.',
    'Passe !',
  ];

  const VRAIES_REPONSES = [
    'passe mes journees sur les tickets',
    'passe le plus clair de mon temps en réunion',
    'non stop du support',
    'non je fais surtout du back',
    'plus tard dans la journée je fais les revues',
    'skip les réunions autant que possible',
  ];

  it.each(VRAIS_REFUS)('« %s » reste un refus', (t) => {
    expect(skipsInterview(t)).toBe(true);
  });

  it.each(VRAIES_REPONSES)('« %s » est une RÉPONSE, pas un refus', (t) => {
    expect(skipsInterview(t)).toBe(false);
  });
});
