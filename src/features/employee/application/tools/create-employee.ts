import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import { createEmployee } from '../../domain/entities/employee';
import { uuidSchema, emailSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { ConflictError } from '../../../../shared/errors';

export function makeCreateEmployee(repo: EmployeeRepository) {
  return createTool({
    id: 'createEmployee',
    description: 'Crée un nouvel employé dans le système d onboarding',
    inputSchema: z.object({
      firstName: z.string().min(1).describe('Prénom de l employé'),
      lastName: z.string().min(1).describe('Nom de l employé'),
      email: emailSchema.describe('Email professionnel'),
      department: z.string().min(1).describe('Département'),
      position: z.string().min(1).describe('Poste'),
      startDate: z.string().datetime().describe('Date de début au format ISO'),
      managerId: uuidSchema.nullish().describe('ID du manager (optionnel)'),
    }),
    execute: async (data, _ctx) => {
      logger.info('Création employé', { email: data.email });
      const existing = await repo.findByEmail(data.email);
      if (existing) {
        throw new ConflictError(`Un employé avec l email ${data.email} existe déjà`);
      }
      const employee = createEmployee({
        id: crypto.randomUUID(),
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        department: data.department,
        position: data.position,
        startDate: data.startDate,
        managerId: data.managerId ?? null,
      });
      await repo.save(employee);
      logger.info('Employé créé', { id: employee.id });
      return employee;
    },
  });
}
