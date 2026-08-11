import type { Task } from '../../domain/entities/task';
import type { TaskPriority, TaskStatus } from '../../../../shared/types';

/**
 * Projection des tâches destinée aux TOOL-RESULTS lus par un LLM.
 *
 * Pourquoi une projection ET une borne :
 *
 * 1. COÛT. Le plafond Groq est de 12 000 tokens/minute et l'historique complet
 *    — préfixe système, schémas des tools ET résultats des tools — est réémis à
 *    chaque aller-retour. Un tool-result n'est donc pas payé une fois mais K
 *    fois (K = 2-3 sur un flux avec appel d'outil). Mesuré avant ce lot :
 *    `getEmployeeProfile` rendait `tasks` non borné avec les 19 champs de
 *    l'entité, soit 3 428 caractères ≈ 979 tokens pour UN résultat.
 *
 * 2. CONFIDENTIALITÉ. `DrizzleTaskRepository` fait un `SELECT *` puis un
 *    `as Task` : l'assertion de type est effacée à la compilation et ne retire
 *    RIEN à l'exécution. C'est `JSON.stringify` de l'objet réel qui entre dans
 *    le contexte du modèle. `metadata` (JSON libre) et `description` en
 *    sortiraient tels quels — même raisonnement que la projection du profil
 *    employé (commit 889ab66).
 *
 * On énumère donc ce qu'on expose plutôt que ce qu'on retire : un champ ajouté
 * à l'entité `Task` demain ne fuite pas tout seul.
 */

/**
 * Nombre maximal de tâches rendues dans un tool-result.
 *
 * Cinq suffit à répondre aux questions réelles (« où en est son intégration ? »,
 * « qu'est-ce qui reste ? ») sans faire exploser le budget. Au-delà, le résultat
 * porte `totalTasks` / `shown` pour que le modèle SACHE qu'il n'a pas tout vu —
 * sans ces compteurs il conclurait à tort que la liste est complète.
 */
export const MAX_TASKS_IN_RESULT = 5;

/** Vue minimale d'une tâche, telle qu'exposée au LLM. */
export interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly dueDate: string | null;
}

/** Résultat borné et annoté, commun à `getEmployeeProfile` et `getTaskList`. */
export interface TaskSummaryPage {
  readonly tasks: TaskSummary[];
  /** Nombre total de tâches correspondant à la demande, AVANT troncature. */
  readonly totalTasks: number;
  /** Nombre de tâches réellement présentes dans `tasks`. */
  readonly shown: number;
}

export function toTaskSummary(task: Task): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate ?? null,
  };
}

/**
 * Borne la liste à `MAX_TASKS_IN_RESULT`, projette chaque entrée et conserve le
 * total réel. L'ordre du repository est préservé : la troncature est signalée,
 * jamais silencieuse.
 */
export function summarizeTasks(tasks: readonly Task[]): TaskSummaryPage {
  const shown = tasks.slice(0, MAX_TASKS_IN_RESULT).map(toTaskSummary);
  return { tasks: shown, totalTasks: tasks.length, shown: shown.length };
}
