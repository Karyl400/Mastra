/**
 * Parcours d'accueil : ce que le nouvel arrivant doit accomplir, et sa mise en
 * plan (suivi + tâches + étapes).
 *
 * ── Pourquoi ce module existe ───────────────────────────────────────────────
 * Ce catalogue et sa mise en plan vivaient DANS `employeeOnboardingWorkflow`.
 * Il n'existait donc qu'un seul chemin pour qu'un employé obtienne un suivi
 * d'intégration — et ce n'est pas celui qu'emprunte la production. Vérifié sur
 * la Turso de production le 2026-08-11 : les 2 employés en base ont été créés
 * par le tool `createEmployee`, qui ne fait qu'un `repo.save(employee)`, d'où
 * `onboarding_progress = 0`, `tasks = 0`, `onboarding_steps = 0`.
 *
 * Conséquences directes, toutes observées : `updateOnboardingStatus` échouait
 * sur 100 % des employés, `getTaskList` rendait une liste vide, et le suivi
 * annoncé par l'agent n'avait rien à suivre.
 *
 * Le catalogue est donc remonté ici, en DOMAINE PUR (aucun import framework,
 * aucun port), pour que le workflow ET `scripts/backfill-onboarding.mts`
 * partagent la même logique. Toute recopie réintroduirait la divergence qu'on
 * corrige.
 *
 * ── Ce que ce module ne fait PAS ────────────────────────────────────────────
 * Il ne PERSISTE rien : il construit des entités. Qui les écrit, dans quel
 * ordre et avec quelle tolérance à l'échec reste la décision de l'appelant —
 * le workflow les écrit en best-effort, le script de rattrapage en mode
 * idempotent avec une pré-vérification.
 */

import { createTask, type Task } from '../../../employee/domain/entities/task';
import {
  createProgress,
  createStep,
  type OnboardingProgress,
  type OnboardingStep,
} from '../entities/onboarding-progress';
import { TaskPriority, TaskType, OnboardingStatus } from '../../../../shared/types';

export interface OnboardingTaskTemplate {
  readonly title: string;
  readonly description: string;
  readonly type: TaskType;
  readonly priority: TaskPriority;
  /**
   * Échéance comptée à partir de la DATE DE DÉBUT, pas de la date de création :
   * un profil complété trois semaines avant l'arrivée ne doit pas produire cinq
   * tâches déjà en retard.
   */
  readonly dueInDays: number;
}

export const ONBOARDING_TASKS: ReadonlyArray<OnboardingTaskTemplate> = [
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
export function dueDateFrom(startDate: string, days: number): string {
  const due = new Date(startDate);
  due.setUTCDate(due.getUTCDate() + days);
  return due.toISOString();
}

export interface OnboardingPlan {
  readonly progress: OnboardingProgress;
  readonly tasks: readonly Task[];
  /** Une étape par tâche, dans l'ordre du catalogue, reliée par `taskId`. */
  readonly steps: readonly OnboardingStep[];
}

export interface OnboardingPlanInput {
  readonly employeeId: string;
  /** ISO complet — la date d'arrivée, qui sert de base aux échéances. */
  readonly startDate: string;
  /**
   * Suivi DÉJÀ en base auquel rattacher les étapes. Sans lui, un nouveau suivi
   * est construit. C'est ce qui rend le rattrapage idempotent : on ne recrée
   * jamais un `onboarding_progress` qui existe.
   */
  readonly progressId?: string;
  /** Injectable pour rendre le plan déterministe en test. */
  readonly newId?: () => string;
}

/**
 * Construit le suivi, les tâches et les étapes d'un parcours d'accueil.
 *
 * Le suivi est rendu DÉMARRÉ (`in_progress`, `startedAt` posé) : il n'est
 * construit qu'au moment où le parcours commence réellement, et un
 * `not_started` porteur de cinq tâches échéancées serait un mensonge.
 */
export function buildOnboardingPlan(input: OnboardingPlanInput): OnboardingPlan {
  const newId = input.newId ?? (() => crypto.randomUUID());
  const now = new Date().toISOString();

  const base = createProgress({
    id: input.progressId ?? newId(),
    employeeId: input.employeeId,
    currentStep: 0,
    // Dérivé du catalogue, jamais d'un littéral : un `5` en dur mentirait dès
    // la première tâche ajoutée ou retirée.
    totalSteps: ONBOARDING_TASKS.length,
  });

  const progress: OnboardingProgress = {
    ...base,
    status: OnboardingStatus.InProgress,
    startedAt: now,
    updatedAt: now,
  };

  const tasks = ONBOARDING_TASKS.map((modele) =>
    createTask({
      id: newId(),
      employeeId: input.employeeId,
      assigneeId: input.employeeId,
      reviewerId: null,
      title: modele.title,
      description: modele.description,
      type: modele.type,
      priority: modele.priority,
      dueDate: dueDateFrom(input.startDate, modele.dueInDays),
      tags: ['onboarding'],
      metadata: null,
      estimatedHours: null,
      actualHours: null,
    }),
  );

  const steps = tasks.map((task, index) =>
    createStep({
      id: newId(),
      progressId: progress.id,
      taskId: task.id,
      stepOrder: index + 1,
    }),
  );

  return { progress, tasks, steps };
}
