import { describe, it, expect } from 'vitest';

import { isQuestionToBot } from '../../../src/features/onboarding/domain/services/interview-chat';

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
