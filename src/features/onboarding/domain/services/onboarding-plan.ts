/**
 * Parcours d'accueil : la mise en plan du suivi d'intégration.
 *
 * ── Ce que ce module portait, et ne porte plus ──────────────────────────────
 * Jusqu'au 2026-08-14 il portait un CATALOGUE de cinq tâches (`ONBOARDING_TASKS`)
 * et construisait, pour chaque employé, cinq lignes `tasks` plus cinq lignes
 * `onboarding_steps`. Tout cela a été retiré : **le seul suivi du produit est
 * désormais la complétion du profil**.
 *
 * La raison n'est pas cosmétique. Ces cinq tâches étaient un plan qu'aucun
 * mécanisme ne faisait avancer — ni humain, ni automate, ni tool : rien dans le
 * système ne pouvait marquer « Rencontrer ton manager » comme faite. Un suivi
 * qui ne bouge jamais est un suivi qui ment, et ce dépôt a déjà payé trois fois
 * le même défaut (`emailSent: false` sous `status: 'success'`,
 * `documents.content` perdu en silence, `status = Sent` posé avant le `try`).
 * Deux d'entre elles renvoyaient de surcroît vers un questionnaire et un guide
 * qui n'existaient pas sous la forme annoncée.
 *
 * ── Ce qui reste ────────────────────────────────────────────────────────────
 * Le suivi lui-même (`onboarding_progress`), avec UNE étape : le profil. C'est
 * le seul fait que le produit sache réellement observer — la modale
 * « Compléter mon profil » l'écrit, et son absence est vérifiable en base.
 *
 * ── Ce que ce module ne fait PAS ────────────────────────────────────────────
 * Il ne PERSISTE rien : il construit une entité. Qui l'écrit et avec quelle
 * tolérance à l'échec reste la décision de l'appelant.
 */

import { createProgress, type OnboardingProgress } from '../entities/onboarding-progress';
import { OnboardingStatus } from '../../../../shared/types';

/**
 * Le parcours ne compte qu'une étape : la complétion du profil.
 *
 * Constante nommée plutôt que littéral `1` dans `buildOnboardingPlan` — c'est
 * la valeur que `getEmployeeProfile` rend au modèle sous `totalSteps`, et le
 * jour où une seconde étape apparaîtra (l'entretien de personnalité est le
 * candidat), il ne devra y avoir qu'un seul endroit à corriger. L'ancien
 * `totalSteps` était déjà dérivé, jamais écrit en dur, pour cette raison.
 */
export const ONBOARDING_TOTAL_STEPS = 1;

export interface OnboardingPlan {
  readonly progress: OnboardingProgress;
}

export interface OnboardingPlanInput {
  readonly employeeId: string;
  /**
   * Suivi DÉJÀ en base auquel se rattacher. Sans lui, un nouvel identifiant est
   * tiré. C'est ce qui rend un rattrapage idempotent : on ne recrée jamais un
   * `onboarding_progress` qui existe.
   */
  readonly progressId?: string;
  /** Injectable pour rendre le plan déterministe en test. */
  readonly newId?: () => string;
}

/**
 * Construit le suivi d'un parcours d'accueil — et le rend COMPLÉTÉ.
 *
 * ⚠️ Il était rendu `in_progress` avec `currentStep: 0`, ce qui était FAUX depuis le
 * 2026-08-14. `buildOnboardingPlan` n'est appelé que par `initOnboardingStep`, c'est-à-dire
 * APRÈS que `createEmployeeStep` a persisté un profil COMPLET — et l'unique étape du parcours
 * EST la complétion du profil, comme l'en-tête de ce module le dit. On enregistrait donc
 * « 0 sur 1 fait » une étape après avoir constaté que la seule étape était faite.
 *
 * Rien ne l'avançait ensuite : les seuls écrivains de `currentStep` sont ce chemin et
 * `updateOnboardingStatus`, l'outil qu'un MODÈLE appelle sur demande d'un humain.
 * `getEmployeeProfile` remontait fidèlement `in_progress, 0/1` au modèle, qui le remontait à
 * la personne. C'est le défaut `ONBOARDING_TASKS` recréé sous forme réduite — « un suivi qui
 * ne bouge jamais est un suivi qui ment » — dans le fichier dont l'en-tête affirme l'avoir
 * supprimé.
 *
 * ⚠️ Le jour où une seconde étape apparaîtra (l'entretien est le candidat), ce défaut inverse
 * réapparaîtra : il faudra alors poser `currentStep: 1` et `InProgress`, pas recopier ceci.
 */
export function buildOnboardingPlan(input: OnboardingPlanInput): OnboardingPlan {
  const newId = input.newId ?? (() => crypto.randomUUID());
  const now = new Date().toISOString();

  const base = createProgress({
    id: input.progressId ?? newId(),
    employeeId: input.employeeId,
    currentStep: ONBOARDING_TOTAL_STEPS,
    totalSteps: ONBOARDING_TOTAL_STEPS,
  });

  return {
    progress: {
      ...base,
      status: OnboardingStatus.Completed,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    },
  };
}

/**
 * Ramène un suivi HÉRITÉ au barème courant.
 *
 * ⚠️ Constaté en production le 2026-08-18 : « Statut d'onboarding : en cours (étape 1 sur 5) »
 * alors que `ONBOARDING_TOTAL_STEPS` vaut 1 depuis le retrait du suivi de tâches. La ligne
 * datait d'avant ; le workflow, rendu idempotent le 2026-08-17, la RÉUTILISE sans la corriger.
 * Le bot annonçait donc à quelqu'un un parcours en cinq étapes dont quatre n'existent plus.
 *
 * ⚠️ On rend l'OBJET D'ORIGINE quand il est déjà cohérent, et c'est ce qui permet à l'appelant
 * de savoir s'il doit écrire : une écriture inutile fait bouger `updatedAt` sans raison, et
 * une écriture est toujours une occasion de se tromper.
 */
export function reconcileProgress(progress: OnboardingProgress): OnboardingProgress {
  if (progress.totalSteps === ONBOARDING_TOTAL_STEPS) return progress;

  const currentStep = Math.min(progress.currentStep, ONBOARDING_TOTAL_STEPS);
  const done = currentStep >= ONBOARDING_TOTAL_STEPS;
  const now = new Date().toISOString();

  return {
    ...progress,
    currentStep,
    totalSteps: ONBOARDING_TOTAL_STEPS,
    status: done ? OnboardingStatus.Completed : progress.status,
    completedAt: done ? (progress.completedAt ?? now) : progress.completedAt,
    updatedAt: now,
  };
}
