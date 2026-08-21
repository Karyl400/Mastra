import { describe, expect, it } from 'vitest';

import {
  INTERVIEW_QUESTION_DAILY,
  INTERVIEW_QUESTION_STYLE,
  INTERVIEW_TOO_SHORT_REPLY,
  interviewRetryReply,
  pendingInterviewStep,
} from '../../../src/features/onboarding/domain/services/interview-chat';
import { interviewReplyFor } from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * UNE RÉPONSE TROP COURTE METTAIT SILENCIEUSEMENT FIN À L'ENTRETIEN
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Trouvé par le rejeu d'arrivée en production, le 2026-08-21 — pas par une relecture.
 *
 * `pendingInterviewStep` reconstitue l'état en cherchant la QUESTION dans le dernier tour de
 * l'assistant. La relance disait « il me faut un peu plus que ça » sans jamais redire ce
 * qu'elle demandait : l'état était donc perdu, et la réponse suivante — celle où la personne
 * prend la peine de développer — partait vers le modèle au lieu d'être enregistrée.
 *
 * Le symptôme est le plus discret qui soit : le bot répond quelque chose de sensé, et la table
 * `onboarding_interview` reste vide. Aucune erreur, aucun log.
 *
 * ⚠️ `profileRetryReply` avait cette forme depuis toujours. Deux machines à états qui suivent
 * la même règle sans la partager finissent par diverger, et c'est celle qu'on a oubliée qui
 * perd les données.
 */
describe('la relance de l’entretien repose la question', () => {
  it('pour « ce que tu fais au quotidien »', () => {
    const reply = interviewRetryReply('dailyWork');
    expect(reply).toContain(INTERVIEW_TOO_SHORT_REPLY);
    expect(reply).toContain(INTERVIEW_QUESTION_DAILY);
  });

  it('pour « comment tu préfères travailler »', () => {
    const reply = interviewRetryReply('workStyle');
    expect(reply).toContain(INTERVIEW_QUESTION_STYLE);
  });

  it('L’ÉTAT SURVIT — c’est le seul contrôle qui compte vraiment', () => {
    // Le tour d'après doit encore savoir quelle question attend une réponse. Sans cela, la
    // phrase que la personne écrit ensuite n'est enregistrée nulle part.
    for (const step of ['dailyWork', 'workStyle'] as const) {
      expect(pendingInterviewStep(interviewRetryReply(step)), step).toBe(step);
    }
  });

  it('la relance NUE perdait l’état — la preuve du défaut, gardée', () => {
    // Si un jour quelqu'un « simplifie » en revenant au message seul, ce test dit pourquoi
    // c'est une perte de données et pas un choix de rédaction.
    expect(pendingInterviewStep(INTERVIEW_TOO_SHORT_REPLY)).toBeNull();
  });
});

describe('le handler rend bien la relance qui repose la question', () => {
  it('sur une réponse trop courte à la première question', () => {
    const reply = interviewReplyFor('dailyWork', 'ok', false);
    expect(pendingInterviewStep(reply)).toBe('dailyWork');
  });

  it('sur une réponse trop courte à la seconde', () => {
    const reply = interviewReplyFor('workStyle', 'ok', false);
    expect(pendingInterviewStep(reply)).toBe('workStyle');
  });

  it('n’altère pas le chemin nominal : une vraie réponse fait avancer', () => {
    const reply = interviewReplyFor('dailyWork', 'je prépare les tableaux de bord', false);
    expect(pendingInterviewStep(reply)).toBe('workStyle');
  });
});
