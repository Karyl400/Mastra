import { describe, it, expect } from 'vitest';

import {
  ONBOARDING_TOTAL_STEPS,
  reconcileProgress,
} from '../../../src/features/onboarding/domain/services/onboarding-plan';
import type { OnboardingProgress } from '../../../src/features/onboarding/domain/entities/onboarding-progress';
import { OnboardingStatus } from '../../../src/shared/types';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « INTÉGRATION : EN COURS, ÉTAPE 1 SUR 1. »
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Phrase RÉELLEMENT rendue à quelqu'un le 2026-08-20. Une étape sur une étape est FAITE :
 * « en cours » se contredit dans la même phrase, et personne n'a besoin de connaître le
 * schéma pour le voir.
 *
 * La réconciliation sortait sur `if (totalSteps === ONBOARDING_TOTAL_STEPS) return progress`,
 * c'est-à-dire qu'elle tenait « déjà au bon barème » pour « déjà cohérent ». Le barème peut
 * être juste pendant que le statut ment. Elle porte désormais sur l'INVARIANT :
 *
 *     currentStep >= totalSteps  ⇒  completed
 *
 * C'est la seule formulation qui ne puisse pas se désynchroniser d'elle-même — et c'est le
 * même défaut, sous une autre forme, que celui que le retrait du suivi de tâches disait
 * supprimer : un suivi qui ne bouge jamais est un suivi qui ment.
 */

function progress(overrides: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return {
    id: 'p1',
    employeeId: 'e1',
    status: OnboardingStatus.InProgress,
    currentStep: 1,
    totalSteps: 1,
    startedAt: '2026-08-11T18:02:35.802Z',
    completedAt: null,
    createdAt: '2026-08-11T18:02:35.802Z',
    updatedAt: '2026-08-11T18:02:35.802Z',
    ...overrides,
  };
}

describe('reconcileProgress — le statut ne peut pas contredire les compteurs', () => {
  it('rend COMPLÉTÉ un suivi « en cours » dont toutes les étapes sont faites', () => {
    // LE cas signalé en production, et celui que l'ancienne garde laissait passer : le barème
    // était déjà le bon (1), donc elle rendait la ligne telle quelle, statut compris.
    const result = reconcileProgress(progress());

    expect(result.status).toBe(OnboardingStatus.Completed);
    expect(result.currentStep).toBe(ONBOARDING_TOTAL_STEPS);
    expect(result.totalSteps).toBe(ONBOARDING_TOTAL_STEPS);
  });

  it('pose `completedAt` quand il manquait, sans écraser celui qui existe', () => {
    // Un accompli sans date d'accomplissement est la moitié d'un fait. Mais réécrire une date
    // déjà posée effacerait la seule trace de QUAND — même arbitrage que `first_seen_at`.
    expect(reconcileProgress(progress()).completedAt).toBeTruthy();

    const dejaFini = progress({
      status: OnboardingStatus.Completed,
      completedAt: '2026-08-12T00:00:00.000Z',
    });
    expect(reconcileProgress(dejaFini).completedAt).toBe('2026-08-12T00:00:00.000Z');
  });

  it('ramène AUSSI un barème hérité, comme avant', () => {
    // Non-régression du correctif du 2026-08-18 : « en cours (étape 1 sur 5) », sur une ligne
    // écrite avant le retrait des cinq tâches.
    const herite = reconcileProgress(progress({ currentStep: 1, totalSteps: 5 }));

    expect(herite.totalSteps).toBe(ONBOARDING_TOTAL_STEPS);
    expect(herite.currentStep).toBe(ONBOARDING_TOTAL_STEPS);
    expect(herite.status).toBe(OnboardingStatus.Completed);
  });

  it('ne déclare PAS terminé un parcours réellement en cours', () => {
    // La garantie inverse, et c'est elle qui empêche la correction de devenir un mensonge
    // dans l'autre sens. Aucune valeur de `currentStep` inférieure au total ne doit conclure.
    const enCours = reconcileProgress(progress({ currentStep: 0, totalSteps: 5 }));

    expect(enCours.currentStep).toBe(0);
    expect(enCours.status).toBe(OnboardingStatus.InProgress);
    expect(enCours.completedAt).toBeNull();
  });

  it('rend l’OBJET D’ORIGINE quand tout est déjà cohérent — l’appelant sait ne pas écrire', () => {
    // L'identité référentielle est le signal : une écriture inutile fait bouger `updatedAt`
    // sans raison, et une écriture est toujours une occasion de se tromper.
    const coherent = progress({ status: OnboardingStatus.Completed, completedAt: 'x' });

    expect(reconcileProgress(coherent)).toBe(coherent);
  });
});
