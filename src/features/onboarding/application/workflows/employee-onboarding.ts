import { Workflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { logger } from '../../../../shared/logger';
import { createEmployee } from '../../../employee/domain/entities/employee';
import { ONBOARDING_TASKS, buildOnboardingPlan } from '../../domain/services/onboarding-plan';
import {
  BestEffortStep,
  OnboardingOutcome,
  describeDegradation,
  outcomeOf,
  toFailureReason,
  type StepFailure,
} from '../../domain/value-objects/onboarding-outcome';
import type { TaskRepository } from '../../../employee/domain/ports/task.repository';
import type { EmployeeRepository } from '../../../employee/domain/ports/employee.repository';
import type { OnboardingRepository } from '../../domain/ports/onboarding.repository';
import type { NotificationRepository } from '../../../notification/domain/ports/notification.repository';
import type { EmailProvider } from '../../../notification/domain/ports/providers';
import type { SlackWorkspaceProvider } from '../../../notification/domain/ports/slack-workspace.port';
import { createNotification } from '../../../notification/domain/entities/notification';
import {
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

/**
 * Une étape best-effort en échec, transportée d'étape en étape jusqu'à la
 * sortie. Le tableau est CUMULATIF : chaque étape recopie ce qu'elle a reçu et
 * y ajoute son propre échec, faute de quoi la dernière écraserait les
 * précédentes et l'email masquerait Slack.
 */
const stepFailureSchema = z.object({
  step: z.nativeEnum(BestEffortStep),
  reason: z.string(),
});

const onboardingInitializedSchema = z.object({
  employeeId: z.string().uuid(),
  progressId: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  department: z.string(),
  slackChannelId: z.string().nullable().optional(),
  degraded: z.array(stepFailureSchema),
});

const welcomeSentSchema = z.object({
  employeeId: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  department: z.string(),
  emailSent: z.boolean(),
  slackChannelId: z.string().nullable().optional(),
  degraded: z.array(stepFailureSchema),
});

/**
 * Sortie du parcours.
 *
 * ⚠️ `outcome` est le champ à lire, PAS le `status` du run Mastra. Ce dernier
 * vaut `'success'` dès que le workflow est allé au bout, y compris quand
 * l'email de bienvenue n'est jamais parti — c'est exactement ce qui a produit
 * de faux « PASS » dans les rapports de test (cf. `onboarding-outcome.ts`).
 *
 * `emailSent` et `slackInvited` sont CONSERVÉS bien que redondants avec
 * `degradedSteps` : les instructions des agents (`AGENT_ANTI_INVENTION_BLOCK`),
 * `scripts/production-scenarios.mjs` et `docs/guides/tests-manuels.md` les
 * nomment explicitement. Les retirer casserait ces trois lecteurs pour un gain
 * cosmétique.
 */
const onboardingOutputSchema = z.object({
  employeeId: z.string().uuid(),
  outcome: z.nativeEnum(OnboardingOutcome),
  emailSent: z.boolean(),
  slackInvited: z.boolean(),
  slackUserId: z.string().optional(),
  degradedSteps: z.array(stepFailureSchema),
});

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

      // Catalogue et mise en plan viennent du DOMAINE
      // (`domain/services/onboarding-plan.ts`), partagés avec
      // `scripts/backfill-onboarding.mts` : une recopie ici ferait diverger le
      // parcours créé à l'arrivée de celui posé par le rattrapage.
      const plan = buildOnboardingPlan({
        employeeId: inputData.employeeId,
        startDate: inputData.startDate,
      });
      const started = plan.progress;

      await deps.onboardingRepo.save(started);

      // Best-effort assumé : un échec ici ne doit PAS faire échouer le workflow.
      // L'employé est déjà créé ; perdre la création pour un suivi incomplet
      // serait un moins bon compromis que de livrer un parcours dégradé, qui
      // reste réparable — `scripts/backfill-onboarding.mts` le répare.
      // L'erreur est journalisée, jamais avalée en silence, et elle est
      // désormais RENDUE à l'appelant : le seul log ne suffisait pas, personne
      // ne lit les logs d'un run qui s'annonce `success`.
      const degraded: StepFailure[] = [];

      try {
        for (const [index, task] of plan.tasks.entries()) {
          await deps.taskRepo.save(task);
          await deps.onboardingRepo.saveStep(plan.steps[index]!);
        }

        logger.info("Tâches d'intégration créées", {
          progressId: started.id,
          count: ONBOARDING_TASKS.length,
        });
      } catch (error) {
        degraded.push({ step: BestEffortStep.OnboardingTasks, reason: toFailureReason(error) });
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
        degraded,
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
      const degraded: StepFailure[] = [...inputData.degraded];

      try {
        await deps.emailProvider.sendEmail(inputData.email, subject, body);
        emailSent = true;
        logger.info('Email de bienvenue envoyé', { email: inputData.email });
      } catch (err) {
        degraded.push({ step: BestEffortStep.WelcomeEmail, reason: toFailureReason(err) });
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
        degraded,
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
    outputSchema: onboardingOutputSchema,
    execute: async ({ inputData }) => {
      const degraded: StepFailure[] = [...inputData.degraded];

      /**
       * Point de sortie UNIQUE de tout le parcours : c'est ici, et nulle part
       * ailleurs, que le verdict est calculé et journalisé. Les quatre `return`
       * précédents de cette étape rendaient chacun sa forme, et rien ne
       * garantissait qu'un cinquième penserait à conclure.
       */
      const conclude = (slack: { slackInvited: boolean; slackUserId?: string }) => {
        const outcome = outcomeOf(degraded);

        if (outcome === OnboardingOutcome.Degraded) {
          // Niveau `error`, et non `warn` comme le marqueur de progression Slack
          // (`slack-progress.ts`). L'arbitrage n'est pas le même : le marqueur
          // n'est qu'un confort dont l'absence saute aux yeux, alors qu'un email
          // de bienvenue jamais parti n'a AUCUN symptôme — l'arrivant ignore
          // qu'il aurait dû le recevoir, et le run se déclare `success`. Réparer
          // exige une action humaine (renvoi, invitation manuelle), donc la
          // ligne doit alerter et rester cherchable. Même raisonnement que la
          // dégradation de `claimEvent()` dans le handler Slack.
          logger.error('Onboarding terminé en mode DÉGRADÉ', {
            employeeId: inputData.employeeId,
            outcome,
            degradedSteps: describeDegradation(degraded),
          });
        } else {
          logger.info('Onboarding terminé', { employeeId: inputData.employeeId, outcome });
        }

        return {
          employeeId: inputData.employeeId,
          outcome,
          emailSent: inputData.emailSent,
          slackInvited: slack.slackInvited,
          slackUserId: slack.slackUserId,
          degradedSteps: degraded,
        };
      };

      // NON APPLICABLE ≠ DÉGRADÉ. Sans provider ni canal de département,
      // l'invitation n'était pas censée avoir lieu — et c'est le cas de TOUTE
      // soumission de la modale Slack, qui passe `slackChannelId: null` faute
      // de correspondance département → canal. La compter comme dégradation
      // rendrait « dégradé » l'état NORMAL et détruirait le signal.
      if (!deps.slackProvider || !inputData.slackChannelId) {
        logger.info('Invitation Slack ignorée (provider ou channel absent)', {
          employeeId: inputData.employeeId,
          hasProvider: !!deps.slackProvider,
          hasChannel: !!inputData.slackChannelId,
        });
        return conclude({ slackInvited: false });
      }

      try {
        const member = await deps.slackProvider.findUserByEmail(inputData.email);

        if (!member) {
          // Ici le canal EST configuré : l'invitation était attendue et n'a pas
          // eu lieu. C'est un trou réel dans l'accueil (l'arrivant n'atterrit
          // dans aucun canal), pas une étape hors sujet.
          logger.warn('Utilisateur Slack non trouvé', { email: inputData.email });
          degraded.push({
            step: BestEffortStep.SlackInvite,
            reason: 'aucun compte Slack ne correspond à cet email',
          });
          return conclude({ slackInvited: false });
        }

        await deps.slackProvider.inviteToChannel(inputData.slackChannelId, member.id);

        logger.info('Employé invité sur Slack', {
          slackUserId: member.id,
          channelId: inputData.slackChannelId,
        });

        return conclude({ slackInvited: true, slackUserId: member.id });
      } catch (err) {
        logger.error('Échec invitation Slack (non bloquant)', {
          error: err instanceof Error ? err.message : String(err),
          employeeId: inputData.employeeId,
        });
        degraded.push({ step: BestEffortStep.SlackInvite, reason: toFailureReason(err) });
        return conclude({ slackInvited: false });
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
    outputSchema: onboardingOutputSchema,
  });

  workflow
    .then(createEmployeeStep)
    .then(initOnboardingStep)
    .then(sendWelcomeEmailStep)
    .then(inviteToSlackStep)
    .commit();

  return workflow;
}
