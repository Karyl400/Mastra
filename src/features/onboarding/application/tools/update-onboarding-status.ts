import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { OnboardingRepository } from '../../domain/ports/onboarding.repository';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { NotFoundError } from '../../../../shared/errors';
import { OnboardingStatus } from '../../../../shared/types';

export function makeUpdateOnboardingStatus(repo: OnboardingRepository) {
  return createTool({
    id: 'updateOnboardingStatus',
    description: 'Met à jour le statut d avancement de l onboarding d un employé',
    inputSchema: z.object({
      employeeId: uuidSchema.describe('ID de l employé'),
      status: z.nativeEnum(OnboardingStatus).describe('Nouveau statut'),
      currentStep: z.number().int().min(0).optional().describe('Étape actuelle'),
    }),
    execute: async (data, _ctx) => {
      logger.info('Mise à jour statut onboarding', { employeeId: data.employeeId, status: data.status });
      const progress = await repo.findByEmployee(data.employeeId);
      if (!progress) throw new NotFoundError('OnboardingProgress', data.employeeId);

      const updated = {
        ...progress,
        status: data.status,
        currentStep: data.currentStep ?? progress.currentStep,
        updatedAt: new Date().toISOString(),
        startedAt: progress.startedAt ?? (data.status === OnboardingStatus.InProgress ? new Date().toISOString() : null),
        completedAt: data.status === OnboardingStatus.Completed ? new Date().toISOString() : null,
      };
      await repo.update(updated);
      return updated;
    },
  });
}
