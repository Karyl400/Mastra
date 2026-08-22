import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { OnboardingRepository } from '../../domain/ports/onboarding.repository';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { OnboardingStatus } from '../../../../shared/types';
import { canPerformSideEffects } from '../../../../shared/slack-request-context';
import { ESCALATION_CONTACT } from '../../../../shared/escalation';
import { clampToPlan } from '../../domain/services/onboarding-plan';

const NO_PROGRESS_HINT =
  "Cet employé n'a aucun suivi d'intégration en base. Tu n'as aucun outil pour en créer un : " +
  "ne propose pas de le créer et ne dis pas que c'est fait. Signale simplement que le parcours " +
  `n'est pas initialisé et que ${ESCALATION_CONTACT} doit le lancer.`;

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
      if (!canPerformSideEffects(_ctx?.requestContext, data.employeeId)) {
        logger.warn('updateOnboardingStatus refusé : le demandeur n’a pas le niveau requis', {
          employeeId: data.employeeId,
        });
        return {
          updated: false as const,
          reason: 'not_authorized' as const,
          hint: 'Tu ne peux agir que sur ton propre dossier — celui de quelqu’un d’autre est réservé au manager. Dis-le simplement, ne réessaie pas.',
        };
      }

      logger.info('Mise à jour statut onboarding', {
        employeeId: data.employeeId,
        status: data.status,
      });

      const progress = await repo.findByEmployee(data.employeeId);

      if (!progress) {
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
        ...clampToPlan(data.currentStep ?? progress.currentStep),
        status: data.status,
        updatedAt: now,
        startedAt: progress.startedAt ?? (data.status === OnboardingStatus.InProgress ? now : null),
        completedAt: data.status === OnboardingStatus.Completed ? now : null,
      };

      const affected = await repo.update(updated);

      if (affected === 0) {
        logger.warn('Mise à jour du statut sans effet — aucune ligne affectée', {
          employeeId: data.employeeId,
        });
        return {
          updated: false as const,
          reason: 'not_persisted' as const,
          hint: "La mise à jour n'a pas été enregistrée. Ne dis pas qu'elle est faite ; propose de réessayer.",
        };
      }

      return {
        updated: true as const,
        status: updated.status,
        currentStep: updated.currentStep,
        totalSteps: updated.totalSteps,
      };
    },
  });
}
