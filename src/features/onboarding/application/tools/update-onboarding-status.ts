import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { OnboardingRepository } from '../../domain/ports/onboarding.repository';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { OnboardingStatus } from '../../../../shared/types';

/**
 * Met à jour l'avancement du parcours d'intégration.
 *
 * ── Pourquoi ce tool ne lève plus ───────────────────────────────────────────
 * Il levait `NotFoundError('OnboardingProgress')` dès que l'employé n'avait pas
 * de ligne `onboarding_progress` — c'est-à-dire, mesuré sur la Turso de
 * production le 2026-08-11, pour 100 % des employés : les deux profils en base
 * ont été créés par le tool `createEmployee` (un simple `repo.save`), et seul
 * `employeeOnboardingWorkflow` écrivait le suivi.
 *
 * Cette exception n'était pas un échec ordinaire. L'AI SDK v7 capture ce que
 * lève un tool et le convertit en part `tool-error` RÉINJECTÉE au modèle : le
 * catch générique du handler Slack n'est jamais atteint. Le modèle reçoit donc
 * « ce suivi n'existe pas », en déduit qu'une étape lui manque, et INVENTE la
 * capacité qui la comblerait — reproduit en conditions réelles : « Souhaites-tu
 * que je crée un enregistrement d'onboarding ? » suivi d'un appel à un tool
 * `createOnboarding` inexistant. C'est la même mécanique que l'over-promise
 * « as-tu besoin de créer un profil ? » observée en production.
 *
 * ── L'arbitrage : résultat structuré, PAS de création implicite ─────────────
 * L'autre option était de créer le suivi manquant à la volée. Elle est écartée
 * pour trois raisons :
 *
 *  1. Un suivi seul ne vaut RIEN. Le parcours, c'est le suivi PLUS les cinq
 *     tâches et leurs étapes (`domain/services/onboarding-plan.ts`). Poser un
 *     compteur `totalSteps: 5` sans tâche derrière, c'est exactement le défaut
 *     déjà corrigé le 2026-08-10. Le faire ici obligerait ce tool à dépendre
 *     aussi de `TaskRepository`.
 *  2. Ce serait une ÉCRITURE MASSIVE déclenchée par un LLM sur un identifiant
 *     qu'il peut avoir halluciné : le tool ne dispose d'aucun `EmployeeRepository`
 *     pour vérifier que la personne existe, et créerait donc volontiers un
 *     parcours orphelin. Un tool nommé « update » qui insère six lignes est de
 *     surcroît un effet de bord que rien n'annonce.
 *  3. Le rattrapage a déjà un propriétaire : `scripts/backfill-onboarding.mts`,
 *     idempotent, en dry-run par défaut, exécuté sciemment par un humain.
 *
 * Reste donc à faire ce que `find-employee-by-email.ts` fait déjà : rendre un
 * résultat qui INSTRUIT le modèle. `hint` lui interdit nommément de proposer
 * une création — c'est cette phrase, et non le silence, qui empêche l'invention.
 */

/** Consigne rendue au modèle quand le suivi n'existe pas. */
const NO_PROGRESS_HINT =
  "Cet employé n'a aucun suivi d'intégration en base. Tu n'as aucun outil pour en créer un : " +
  "ne propose pas de le créer et ne dis pas que c'est fait. Signale simplement que le parcours " +
  "n'est pas initialisé et que l'équipe RH doit le lancer.";

export function makeUpdateOnboardingStatus(repo: OnboardingRepository) {
  return createTool({
    id: 'updateOnboardingStatus',
    description:
      "Met à jour l'avancement de l'onboarding d'un employé. " +
      "Renvoie updated=false (jamais une exception) si aucun suivi n'existe.",
    inputSchema: z.object({
      employeeId: uuidSchema.describe('ID de l employé'),
      status: z.nativeEnum(OnboardingStatus).describe('Nouveau statut'),
      currentStep: z.number().int().min(0).optional().describe('Étape actuelle'),
    }),
    execute: async (data, _ctx) => {
      logger.info('Mise à jour statut onboarding', {
        employeeId: data.employeeId,
        status: data.status,
      });

      const progress = await repo.findByEmployee(data.employeeId);

      if (!progress) {
        // `warn` volontaire : c'est la ligne à chercher quand un agent parle
        // d'un parcours qui n'existe pas. Elle signale aussi les employés à
        // passer au rattrapage.
        logger.warn("Aucun suivi d'intégration pour cet employé — mise à jour impossible", {
          employeeId: data.employeeId,
        });

        return {
          updated: false as const,
          reason: 'no_onboarding_progress' as const,
          hint: NO_PROGRESS_HINT,
        };
      }

      const now = new Date().toISOString();
      const updated = {
        ...progress,
        status: data.status,
        currentStep: data.currentStep ?? progress.currentStep,
        updatedAt: now,
        startedAt: progress.startedAt ?? (data.status === OnboardingStatus.InProgress ? now : null),
        completedAt: data.status === OnboardingStatus.Completed ? now : null,
      };

      await repo.update(updated);

      // Projection : `id`, `employeeId` et les horodatages techniques n'aident
      // en rien le modèle et sont repayés à chaque aller-retour (plafond Groq
      // 12 000 tokens/minute). Même règle que `task-summary.mapper.ts`.
      return {
        updated: true as const,
        status: updated.status,
        currentStep: updated.currentStep,
        totalSteps: updated.totalSteps,
      };
    },
  });
}
