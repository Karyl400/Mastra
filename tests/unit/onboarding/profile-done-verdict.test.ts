import { describe, it, expect } from 'vitest';

import {
  verifyProfile,
  type ProfileSnapshot,
} from '../../../src/features/onboarding/domain/services/profile-completion';
import { PROFILE_QUESTIONS } from '../../../src/features/onboarding/domain/services/profile-chat';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « J'AI FINI » NE DOIT PAS REDEMANDER CE QU'ON SAIT DÉJÀ
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ Le verdict ne lisait QUE la table `employees`, alors que le parcours conversationnel,
 * lui, part de `knownProfileAnswers` — annuaire Slack PLUS dossier. Deux machines à états qui
 * suivent la même règle sans la partager finissent par diverger, et c'est celle qu'on a
 * oubliée qui fait le mauvais travail : ici, reposer le prénom à quelqu'un qui vient de
 * l'écrire deux messages plus haut.
 *
 * ⚠️ LA SÉPARATION QUI COMPTE : le VERDICT (« complet ») se prononce sur le DOSSIER, jamais
 * sur ce qu'on croit savoir. Ce qui se prononce sur les réponses connues, c'est la QUESTION
 * POSÉE. Confondre les deux ferait dire « ton dossier est complet » d'un dossier vide.
 */

const full: ProfileSnapshot = {
  firstName: 'Awa',
  lastName: 'TRAORE',
  email: 'awa@kissohq.com',
  position: 'Backend Developer',
};

describe('le verdict tient compte de ce qui est DÉJÀ connu', () => {
  it('n’a aucun dossier mais connaît prénom et nom : il demande l’EMAIL, pas le prénom', () => {
    const verdict = verifyProfile(null, { firstName: 'Awa', lastName: 'TRAORE' });

    expect(verdict.complete).toBe(false);
    expect(verdict.reply).toContain(PROFILE_QUESTIONS.email);
    expect(verdict.reply).not.toContain(PROFILE_QUESTIONS.firstName);
  });

  it('ne nomme comme manquant que ce qui manque VRAIMENT', () => {
    const verdict = verifyProfile(null, { firstName: 'Awa', lastName: 'TRAORE' });

    expect(verdict.missing).toEqual(['ton adresse email', 'l’intitulé de ton poste']);
  });

  it('sans rien de connu, il repart du prénom — le comportement d’origine est intact', () => {
    const verdict = verifyProfile(null);

    expect(verdict.reply).toContain(PROFILE_QUESTIONS.firstName);
  });

  it('un dossier partiel plus une réponse déjà donnée : il ne pose que ce qui reste', () => {
    const verdict = verifyProfile({ ...full, position: '' }, { firstName: 'Awa' });

    expect(verdict.complete).toBe(false);
    expect(verdict.reply).toContain(PROFILE_QUESTIONS.position);
  });

  it('⚠️ NE DÉCLARE PAS COMPLET un dossier que seules les réponses connues complètent', () => {
    // C'est la moitié dangereuse : le verdict porte sur le DOSSIER. Le dire complet parce
    // qu'on a entendu les réponses serait exactement `emailSent: false` sous
    // `status: 'success'` — la famille de mensonge que ce dépôt traque.
    const verdict = verifyProfile(null, {
      firstName: 'Awa',
      lastName: 'TRAORE',
      email: 'awa@kissohq.com',
      position: 'Backend Developer',
    });

    expect(verdict.complete).toBe(false);
  });

  it('un dossier réellement complet reste complet, quoi qu’on lui passe', () => {
    expect(verifyProfile(full, {}).complete).toBe(true);
    expect(verifyProfile(full, { firstName: 'Autre' }).complete).toBe(true);
  });
});
