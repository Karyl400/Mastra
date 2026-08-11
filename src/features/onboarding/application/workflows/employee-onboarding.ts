import { Workflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { logger } from '../../../../shared/logger';
import { createEmployee } from '../../../employee/domain/entities/employee';
import {
  createProgress,
  createStep as createOnboardingStep,
} from '../../domain/entities/onboarding-progress';
import { createTask } from '../../../employee/domain/entities/task';
import type { TaskRepository } from '../../../employee/domain/ports/task.repository';
import type { EmployeeRepository } from '../../../employee/domain/ports/employee.repository';
import type { OnboardingRepository } from '../../domain/ports/onboarding.repository';
import type { NotificationRepository } from '../../../notification/domain/ports/notification.repository';
import type { EmailProvider } from '../../../notification/domain/ports/providers';
import type { SlackWorkspaceProvider } from '../../../notification/domain/ports/slack-workspace.port';
import { createNotification } from '../../../notification/domain/entities/notification';
import {
  TaskType,
  TaskPriority,
  OnboardingStatus,
  NotificationChannel,
  NotificationStatus,
  RecipientType,
  Department,
} from '../../../../shared/types';
import { VALIDATION_CONSTRAINTS } from '../../../../shared/validation';
import { ConflictError } from '../../../../shared/errors';

// ============================================
// SCHEMAS
// ============================================

/**
 * ⚠️ `department` et `position` DOIVENT appliquer ici les mêmes règles que le tool.
 *
 * Ce workflow constitue une SECONDE porte d'entrée vers `employees`, à côté du tool
 * `createEmployee` — et, depuis le flux d'arrivée, la modale Slack en est une
 * troisième. Tant qu'il déclarait `z.string().min(1)`, la validation n'était
 * appliquée que sur le chemin agent : un appel direct à
 * `POST /api/workflows/employeeOnboardingWorkflow/start-async` avec
 * `department: "Wakanda"` renvoyait `status: 'success'` et persistait la valeur.
 *
 * **`department` reste une allowlist, `position` n'en est plus une.** Ce n'est pas
 * une incohérence : le département pilote le routage vers les canaux Slack et les
 * règles métier, donc il doit appartenir à un ensemble fermé. Le poste, lui, est un
 * intitulé rédigé par la personne qui arrive — l'ancienne enum de 24 valeurs ne
 * contenait même pas « Software Engineer » et rejetait des saisies légitimes. Il est
 * désormais validé en FORME (longueur, jeu de caractères), pas en appartenance.
 *
 * On réutilise l'enum `Department` (source unique de vérité) et NON
 * `departmentSchema` / `positionSchema` de `shared/validation` : ces derniers sont
 * bâtis sur `z.preprocess(...)`, dont le type d'ENTRÉE est `unknown`, ce qui casse
 * l'inférence de types entre les étapes du workflow (`.then(createEmployeeStep)`).
 * Les contraintes de `position` sont donc recopiées depuis
 * `VALIDATION_CONSTRAINTS.POSITION`, qui reste la source unique des valeurs.
 *
 * Différence assumée avec le chemin tool : pas de `trim` ici. Le tool en a besoin car un
 * LLM produit des espaces parasites ; ce workflow est appelé par une machine en JSON, où
 * exiger la valeur exacte est plus sain qu'un nettoyage implicite.
 */
const onboardingInputSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  department: z.nativeEnum(Department),
  position: z
    .string()
    .min(VALIDATION_CONSTRAINTS.POSITION.MIN_LENGTH, 'position is too short')
    .max(VALIDATION_CONSTRAINTS.POSITION.MAX_LENGTH, 'position is too long')
    .regex(VALIDATION_CONSTRAINTS.POSITION.PATTERN, VALIDATION_CONSTRAINTS.POSITION.MESSAGE),
  startDate: z.string().datetime(),
  managerId: z.string().uuid().nullable().optional(),
  slackChannelId: z
    .string()
    .nullable()
    .optional()
    .describe('Channel Slack du département (optionnel)'),
});

const employeeCreatedSchema = z.object({
  employeeId: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  department: z.string(),
  position: z.string(),
  startDate: z.string(),
  slackChannelId: z.string().nullable().optional(),
});

const onboardingInitializedSchema = z.object({
  employeeId: z.string().uuid(),
  progressId: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  department: z.string(),
  slackChannelId: z.string().nullable().optional(),
});

const welcomeSentSchema = z.object({
  employeeId: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  department: z.string(),
  emailSent: z.boolean(),
  slackChannelId: z.string().nullable().optional(),
});

/**
 * Parcours d'accueil : ce que le nouvel arrivant doit accomplir.
 *
 * Jusqu'ici, `initOnboarding` posait un compteur `totalSteps: 5` sans jamais
 * créer la moindre tâche ni la moindre étape — `TaskRepository.save()` et
 * `OnboardingRepository.saveStep()` n'étaient appelés par AUCUN code applicatif.
 * Vérifié en production le 2026-08-10 : `tasks = 0`, `onboarding_progress = 0`.
 * Le DM de suivi que porte le nouveau flux d'arrivée n'avait donc rien à suivre.
 *
 * `dueInDays` est compté à partir de la date de début, pas de la date de
 * création : un profil complété trois semaines avant l'arrivée ne doit pas
 * produire cinq tâches déjà en retard.
 */
const ONBOARDING_TASKS: ReadonlyArray<{
  title: string;
  description: string;
  type: TaskType;
  priority: TaskPriority;
  dueInDays: number;
}> = [
  {
    title: 'Configurer tes accès',
    description: 'Activer ton compte email, rejoindre Slack et vérifier tes accès aux outils.',
    type: TaskType.Onboarding,
    priority: TaskPriority.Urgent,
    dueInDays: 1,
  },
  {
    title: 'Lire les guidelines de Kisso',
    description: "Prendre connaissance des règles internes et des pratiques de l'entreprise.",
    type: TaskType.Document,
    priority: TaskPriority.High,
    dueInDays: 3,
  },
  {
    title: 'Rencontrer ton manager',
    description: 'Premier point avec ton manager : objectifs, attentes et organisation.',
    type: TaskType.Meeting,
    priority: TaskPriority.High,
    dueInDays: 3,
  },
  {
    title: 'Découvrir ton équipe',
    description: 'Rencontrer les membres de ton équipe et comprendre qui fait quoi.',
    type: TaskType.Team,
    priority: TaskPriority.Medium,
    dueInDays: 7,
  },
  {
    title: "Compléter le questionnaire d'intégration",
    description: 'Répondre au questionnaire pour valider ta prise de poste.',
    type: TaskType.Questionnaire,
    priority: TaskPriority.Medium,
    dueInDays: 14,
  },
];

/** Échéance dérivée de la date de début. `startDate` est un ISO complet, donc non ambigu. */
function dueDateFrom(startDate: string, days: number): string {
  const due = new Date(startDate);
  due.setUTCDate(due.getUTCDate() + days);
  return due.toISOString();
}

// ============================================
// FACTORY
// ============================================

export function createEmployeeOnboardingWorkflow(deps: {
  employeeRepo: EmployeeRepository;
  onboardingRepo: OnboardingRepository;
  notificationRepo: NotificationRepository;
  taskRepo: TaskRepository;
  emailProvider: EmailProvider;
  slackProvider?: SlackWorkspaceProvider;
}) {
  // ──────────────────────────────────────────
  // Step 1 : créer l'employé en base
  // ──────────────────────────────────────────
  const createEmployeeStep = createStep({
    id: 'createEmployee',
    description: "Crée le profil de l'employé et vérifie l'unicité de l'email",
    inputSchema: onboardingInputSchema,
    outputSchema: employeeCreatedSchema,
    execute: async ({ inputData }) => {
      logger.info('Onboarding — création employé', { email: inputData.email });

      const existing = await deps.employeeRepo.findByEmail(inputData.email);
      if (existing) {
        throw new ConflictError(`Un employé avec l'email ${inputData.email} existe déjà`, {
          email: inputData.email,
          existingId: existing.id,
        });
      }

      // Normaliser les champs optionnels avec null par défaut
      const normalizedInput = {
        ...inputData,
        managerId: inputData.managerId ?? null,
        slackChannelId: inputData.slackChannelId ?? null,
      };

      const employee = createEmployee({
        id: crypto.randomUUID(),
        firstName: normalizedInput.firstName,
        lastName: normalizedInput.lastName,
        email: normalizedInput.email,
        department: normalizedInput.department,
        position: normalizedInput.position,
        startDate: normalizedInput.startDate,
        managerId: normalizedInput.managerId,
      });

      await deps.employeeRepo.save(employee);

      logger.info('Employé créé', { employeeId: employee.id });

      return {
        employeeId: employee.id,
        email: employee.email,
        firstName: employee.firstName,
        lastName: employee.lastName,
        department: employee.department,
        position: employee.position,
        startDate: employee.startDate,
        slackChannelId: normalizedInput.slackChannelId,
      };
    },
  });

  // ──────────────────────────────────────────
  // Step 2 : initialiser l'onboarding progress
  // ──────────────────────────────────────────
  const initOnboardingStep = createStep({
    id: 'initOnboarding',
    description: "Crée le suivi d'onboarding avec les étapes initiales",
    inputSchema: employeeCreatedSchema,
    outputSchema: onboardingInitializedSchema,
    execute: async ({ inputData }) => {
      logger.info('Onboarding — initialisation progress', { employeeId: inputData.employeeId });

      const progress = createProgress({
        id: crypto.randomUUID(),
        employeeId: inputData.employeeId,
        currentStep: 0,
        // Dérivé du catalogue, jamais d'un littéral : un `5` en dur mentirait
        // dès la première tâche ajoutée ou retirée.
        totalSteps: ONBOARDING_TASKS.length,
      });

      const started = {
        ...progress,
        status: OnboardingStatus.InProgress,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await deps.onboardingRepo.save(started);

      // Best-effort assumé : un échec ici ne doit PAS faire échouer le workflow.
      // L'employé est déjà créé ; perdre la création pour un suivi incomplet
      // serait un moins bon compromis que de livrer un parcours dégradé, qui
      // reste réparable. L'erreur est journalisée, jamais avalée en silence.
      try {
        for (const [index, modele] of ONBOARDING_TASKS.entries()) {
          const task = createTask({
            id: crypto.randomUUID(),
            employeeId: inputData.employeeId,
            assigneeId: inputData.employeeId,
            reviewerId: null,
            title: modele.title,
            description: modele.description,
            type: modele.type,
            priority: modele.priority,
            dueDate: dueDateFrom(inputData.startDate, modele.dueInDays),
            tags: ['onboarding'],
            metadata: null,
            estimatedHours: null,
            actualHours: null,
          });
          await deps.taskRepo.save(task);

          await deps.onboardingRepo.saveStep(
            createOnboardingStep({
              id: crypto.randomUUID(),
              progressId: started.id,
              taskId: task.id,
              stepOrder: index + 1,
            }),
          );
        }

        logger.info("Tâches d'intégration créées", {
          progressId: started.id,
          count: ONBOARDING_TASKS.length,
        });
      } catch (error) {
        logger.error("Échec de création des tâches d'intégration", {
          error,
          employeeId: inputData.employeeId,
          progressId: started.id,
        });
      }

      logger.info('Onboarding progress créé', { progressId: started.id });

      return {
        employeeId: inputData.employeeId,
        progressId: started.id,
        email: inputData.email,
        firstName: inputData.firstName,
        lastName: inputData.lastName,
        department: inputData.department,
        slackChannelId: inputData.slackChannelId,
      };
    },
  });

  // ──────────────────────────────────────────
  // Step 3 : envoyer l'email de bienvenue
  // ──────────────────────────────────────────
  const sendWelcomeEmailStep = createStep({
    id: 'sendWelcomeEmail',
    description: "Envoie l'email de bienvenue et persiste la notification",
    inputSchema: onboardingInitializedSchema,
    outputSchema: welcomeSentSchema,
    execute: async ({ inputData }) => {
      logger.info('Onboarding — envoi email de bienvenue', { email: inputData.email });

      const subject = `Bienvenue chez Kisso Industries, ${inputData.firstName} !`;
      const body = [
        `<h1>Bonjour ${inputData.firstName} ${inputData.lastName},</h1>`,
        `<p>Nous sommes ravis de vous accueillir au sein de Kisso Industries, `,
        `dans le département <strong>${inputData.department}</strong>.</p>`,
        `<p>Votre processus d'onboarding vient d'être lancé. Vous recevrez prochainement `,
        `les accès à nos outils ainsi que votre planning de première semaine.</p>`,
        `<p>À très bientôt,</p>`,
        `<p><strong>L'équipe RH — Kisso Industries</strong></p>`,
      ].join('');

      let emailSent = false;

      try {
        await deps.emailProvider.sendEmail(inputData.email, subject, body);
        emailSent = true;
        logger.info('Email de bienvenue envoyé', { email: inputData.email });
      } catch (err) {
        logger.error('Échec envoi email de bienvenue', {
          error: err instanceof Error ? err.message : String(err),
          email: inputData.email,
        });
      }

      const notif = createNotification({
        id: crypto.randomUUID(),
        recipientId: inputData.employeeId,
        recipientType: RecipientType.Employee,
        channel: NotificationChannel.Email,
        subject,
        body,
      });

      const persisted = {
        ...notif,
        status: emailSent ? NotificationStatus.Sent : NotificationStatus.Failed,
        sentAt: emailSent ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString(),
      };

      await deps.notificationRepo.save(persisted);

      return {
        employeeId: inputData.employeeId,
        email: inputData.email,
        firstName: inputData.firstName,
        lastName: inputData.lastName,
        department: inputData.department,
        emailSent,
        slackChannelId: inputData.slackChannelId,
      };
    },
  });

  // ──────────────────────────────────────────
  // Step 4 : inviter sur Slack (best-effort)
  // ──────────────────────────────────────────
  const inviteToSlackStep = createStep({
    id: 'inviteToSlack',
    description: "Trouve l'utilisateur Slack par email et l'invite dans le channel département",
    inputSchema: welcomeSentSchema,
    outputSchema: z.object({
      employeeId: z.string().uuid(),
      emailSent: z.boolean(),
      slackInvited: z.boolean(),
      slackUserId: z.string().optional(),
    }),
    execute: async ({ inputData }) => {
      if (!deps.slackProvider || !inputData.slackChannelId) {
        logger.info('Invitation Slack ignorée (provider ou channel absent)', {
          employeeId: inputData.employeeId,
          hasProvider: !!deps.slackProvider,
          hasChannel: !!inputData.slackChannelId,
        });
        return {
          employeeId: inputData.employeeId,
          emailSent: inputData.emailSent,
          slackInvited: false,
        };
      }

      try {
        const member = await deps.slackProvider.findUserByEmail(inputData.email);

        if (!member) {
          logger.warn('Utilisateur Slack non trouvé', { email: inputData.email });
          return {
            employeeId: inputData.employeeId,
            emailSent: inputData.emailSent,
            slackInvited: false,
          };
        }

        await deps.slackProvider.inviteToChannel(inputData.slackChannelId, member.id);

        logger.info('Employé invité sur Slack', {
          slackUserId: member.id,
          channelId: inputData.slackChannelId,
        });

        return {
          employeeId: inputData.employeeId,
          emailSent: inputData.emailSent,
          slackInvited: true,
          slackUserId: member.id,
        };
      } catch (err) {
        logger.error('Échec invitation Slack (non bloquant)', {
          error: err instanceof Error ? err.message : String(err),
          employeeId: inputData.employeeId,
        });
        return {
          employeeId: inputData.employeeId,
          emailSent: inputData.emailSent,
          slackInvited: false,
        };
      }
    },
  });

  // ──────────────────────────────────────────
  // Assemblage du workflow
  // ──────────────────────────────────────────
  const workflow = new Workflow({
    id: 'employee-onboarding',
    description:
      "Processus complet d'onboarding : création employé → onboarding progress → email de bienvenue → invitation Slack",
    inputSchema: onboardingInputSchema,
    outputSchema: z.object({
      employeeId: z.string().uuid(),
      emailSent: z.boolean(),
      slackInvited: z.boolean(),
      slackUserId: z.string().optional(),
    }),
  });

  workflow
    .then(createEmployeeStep)
    .then(initOnboardingStep)
    .then(sendWelcomeEmailStep)
    .then(inviteToSlackStep)
    .commit();

  return workflow;
}
