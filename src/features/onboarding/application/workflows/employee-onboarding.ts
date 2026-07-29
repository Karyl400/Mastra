import { Workflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { logger } from '../../../../shared/logger';

const onboardingInputSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().email(),
  department: z.string(),
  position: z.string(),
});

// Étape 1 : Créer l'employé et configurer le profil initial
const setupProfileStep = createStep({
  id: 'setupProfile',
  description: 'Création du profil initial et assignation des premières tâches',
  inputSchema: onboardingInputSchema,
  outputSchema: z.object({
    profileCreated: z.boolean(),
    tasksAssigned: z.number(),
  }),
  execute: async ({ inputData }) => {
    logger.info('Exécution de setupProfileStep', { inputData });
    return { profileCreated: true, tasksAssigned: 5 };
  }
});

// Étape 2 : Envoyer l'e-mail de bienvenue
const sendWelcomeEmailStep = createStep({
  id: 'sendWelcomeEmail',
  description: 'Envoi du message de bienvenue au nouvel employé',
  inputSchema: z.object({
    profileCreated: z.boolean(),
    tasksAssigned: z.number(),
  }),
  outputSchema: z.object({
    emailSent: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    logger.info('Exécution de sendWelcomeEmailStep', { inputData });
    return { emailSent: true };
  }
});

export const employeeOnboardingWorkflow = new Workflow({
  id: 'employee-onboarding',
  description: 'Processus d\'onboarding d\'un nouvel employé',
  inputSchema: onboardingInputSchema,
  outputSchema: z.object({
    emailSent: z.boolean(),
  }),
});

employeeOnboardingWorkflow
  .then(setupProfileStep)
  .then(sendWelcomeEmailStep)
  .commit();
