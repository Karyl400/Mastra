import { describe, it, expect } from 'vitest';

import {
  captureProfileAnswer,
  profileRetryReply,
  answersFromDirectory,
  nextProfileStep,
} from '../../../src/features/onboarding/domain/services/profile-chat';

/**
 * DEUX DÉFAUTS SIGNALÉS PAR LE PROPRIÉTAIRE LE 2026-08-20, EN PRODUCTION.
 *
 * ── 1. Le message de relance INVENTAIT une règle ─────────────────────────────
 * « Il me faut une adresse complète, du genre `prenom.nom@kisso.com` ou
 * `prenom.nom@gmail.com` ». Aucune de ces formes n'est vérifiée : `looksLikeEmail` demande un
 * seul `@`, pas d'espace, et un domaine pointé. `k88905177@gmail.com` la satisfait
 * parfaitement.
 *
 * Le refus venait d'ailleurs — Slack encadre les adresses en `<mailto:x|x>`, deux `@` — mais
 * le message envoyait la personne corriger la MAUVAISE chose. Elle a essayé une autre
 * adresse, reçu le même refus, et conclu que le bot exigeait un format `prenom.nom`.
 *
 * C'est la famille de défaut que ce dépôt traque : un texte qui affirme une règle que rien
 * ne calcule. Le message décrit désormais ce qui est RÉELLEMENT exigé.
 *
 * ── 2. On demandait ce que l'on savait déjà ──────────────────────────────────
 * `knownProfileAnswers` ne lisait que `employees`, via une adresse email — donc rien, pour
 * quelqu'un qui n'a pas encore de dossier, c'est-à-dire exactement la personne à qui l'on
 * pose ces questions. Or l'annuaire Slack porte déjà `firstName`, `lastName` et `email`.
 *
 * ⚠️ `title` reste DEMANDÉ et non pré-rempli, et c'est une décision. Le relevé de production
 * du 2026-08-20 montre que ce champ ment : « Product Manager » y désigne quelqu'un qui n'est
 * pas le manager, « Software Engineer » l'administratrice de l'onboarding. C'est un champ
 * déclaratif édité par son porteur, et c'est le seul des quatre qui soit IMPRIMÉ dans les
 * documents. On pré-remplit les faits que Slack maintient, on demande celui qu'il ne
 * maintient pas.
 */

describe('profileRetryReply — ne prescrit plus une règle inexistante', () => {
  it('ne réclame aucun format `prenom.nom`', () => {
    const reply = profileRetryReply('email');

    expect(reply).not.toContain('prenom.nom');
  });

  it('décrit ce qui est réellement exigé, et repose la question', () => {
    const reply = profileRetryReply('email');

    expect(reply).toMatch(/@/);
    expect(reply).toContain('adresse email');
  });
});

describe('l’adresse du propriétaire, refusée en production', () => {
  it('accepte `k88905177@gmail.com`, nue comme encadrée', () => {
    expect(captureProfileAnswer('email', 'k88905177@gmail.com')).toBe('k88905177@gmail.com');
    expect(captureProfileAnswer('email', '<mailto:k88905177@gmail.com|k88905177@gmail.com>')).toBe(
      'k88905177@gmail.com',
    );
  });

  it('accepte les formes que le message d’erreur laissait croire interdites', () => {
    for (const address of ['nazer@kissohq.com', 'a@b.co', 'prenom-nom@sous.domaine.fr']) {
      expect(captureProfileAnswer('email', address), address).toBe(address);
    }
  });
});

describe('answersFromDirectory — ne demande pas ce que Slack sait déjà', () => {
  it('reprend prénom, nom et email de l’annuaire', () => {
    const answers = answersFromDirectory({
      firstName: 'Marcel',
      lastName: 'TESTEUR',
      email: 'marcel.testeur@example.com',
      title: 'Backend Developer',
    });

    expect(answers).toEqual({
      firstName: 'Marcel',
      lastName: 'TESTEUR',
      email: 'marcel.testeur@example.com',
    });
  });

  it('NE reprend PAS le `title` — champ déclaratif, et le seul imprimé dans les documents', () => {
    const answers = answersFromDirectory({ title: 'General Manager' });

    expect(answers.position).toBeUndefined();
  });

  it('laisse le poste à demander quand tout le reste est connu', () => {
    const answers = answersFromDirectory({
      firstName: 'Marcel',
      lastName: 'TESTEUR',
      email: 'marcel.testeur@example.com',
    });

    expect(nextProfileStep(answers)).toBe('position');
  });

  it('ignore les valeurs vides, nulles ou faites d’espaces', () => {
    expect(answersFromDirectory({ firstName: '  ', lastName: null, email: undefined })).toEqual({});
    expect(answersFromDirectory(null)).toEqual({});
  });

  it('déballe une adresse encadrée par Slack, comme partout ailleurs', () => {
    expect(answersFromDirectory({ email: '<mailto:a@b.fr|a@b.fr>' }).email).toBe('a@b.fr');
  });
});
