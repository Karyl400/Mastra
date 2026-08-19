import { createHash } from 'node:crypto';

import { logger } from '../../../../shared/logger';
import {
  PROFILE_SUBMISSION_FAILED_REPLY,
  describeMissingSteps,
  profileSubmissionDegradedReply,
} from '../../domain/services/onboarding-replies';
import {
  OnboardingOutcome,
  describeDegradation,
  type StepFailure,
} from '../../domain/value-objects/onboarding-outcome';

/**
 * Le lancement du workflow d'intégration, à UN SEUL endroit.
 *
 * ## Pourquoi il a été extrait de la route d'interactivité — 2026-08-19
 *
 * Il y a désormais DEUX façons de renseigner un dossier : la soumission d'une modale, et un
 * échange écrit (`profile-chat.ts`), devenu le chemin principal parce qu'une modale ne peut
 * pas s'ouvrir sur ce déploiement — un `trigger_id` expire en 3 s, le démarrage à froid
 * mesuré est de 5,2 s.
 *
 * Deux appelants pour un même geste, c'est exactement la configuration où ce dépôt a déjà
 * payé cher : deux chemins vers le formulaire de profil avaient divergé en un jour, et celui
 * qu'on exerçait le moins était le cassé. La règle vit donc ici, et les appelants ne
 * fournissent que ce qui LEUR est propre — comment parler à la personne, et quoi faire une
 * fois le dossier créé.
 *
 * ⚠️ `getWorkflow()` prend la CLÉ DU REGISTRE (`src/mastra/index.ts`), pas l'`id` interne du
 * workflow — ce dernier ne se résout que via `getWorkflowById`. Une clé erronée rend
 * `undefined` et lève un `TypeError` DANS LA TÂCHE DE FOND, donc invisible.
 */

/** Les quatre champs sans lesquels un dossier n'est pas exploitable. */
export interface OnboardingProfile {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly position: string;
}

interface WorkflowRunResult {
  status: string;
  result?: {
    // ⚠️ `employeeId` est bien dans `onboardingOutputSchema` — il est déclaré ici parce que ce
    // type est écrit à la main : `getWorkflow()` rend `unknown` et Mastra ne publie pas le
    // type de sortie. C'est lui qui relie le dossier créé à l'entretien.
    employeeId?: string;
    outcome?: OnboardingOutcome;
    emailSent?: boolean;
    slackInvited?: boolean;
    degradedSteps?: StepFailure[];
  };
  error?: unknown;
}

interface WorkflowLike {
  createRun(options?: { runId?: string }): Promise<{
    start(args: { inputData: unknown }): Promise<WorkflowRunResult>;
  }>;
}

export interface RunOnboardingDeps {
  /** Le registre Mastra. Typé au plus juste : `getWorkflow` rend `unknown`. */
  readonly getWorkflow: (key: string) => unknown;
  /** Comment parler à la personne. Ne doit jamais lever. */
  readonly notify: (text: string) => Promise<void>;
  /** Appelé quand un dossier EXISTE — succès comme dégradation. */
  readonly onRecordReady: (employeeId: string | undefined) => Promise<void>;
}

/**
 * Identifiant de run dérivé de l'email.
 *
 * Deux soumissions du même profil produisent le même `runId`, donc le même run — y compris
 * depuis deux instances serverless concurrentes. C'est ce qui rend l'idempotence indépendante
 * du cache mémoire de `create-employee.ts`, inopérant hors d'un processus unique.
 */
export function onboardingRunId(email: string): string {
  const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return `onboarding-${digest.slice(0, 32)}`;
}

export async function runOnboarding(
  deps: RunOnboardingDeps,
  profile: OnboardingProfile,
  startDate: string,
): Promise<void> {
  const workflow = deps.getWorkflow('employeeOnboardingWorkflow') as WorkflowLike | undefined;

  if (!workflow) {
    logger.error('Workflow employeeOnboardingWorkflow introuvable dans le registre Mastra');
    await deps.notify(PROFILE_SUBMISSION_FAILED_REPLY);
    return;
  }

  const run = await workflow.createRun({ runId: onboardingRunId(profile.email) });

  const result = await run.start({
    inputData: {
      firstName: profile.firstName,
      lastName: profile.lastName,
      email: profile.email,
      // Plus JAMAIS renseigné : le parcours d'arrivée a cessé de collecter le département le
      // 2026-08-13, et `employees.department` est nullable depuis la même date.
      department: null,
      position: profile.position,
      // Dérivée de l'instant du `team_join`, jamais saisie : voir `startDateFromJoin`.
      startDate,
      // Aucune correspondance département → canal n'existe aujourd'hui : le workflow saute
      // alors l'invitation Slack, sans échouer.
      slackChannelId: null,
    },
  });

  if (result.status !== 'success') {
    logger.error('Onboarding workflow failed', {
      email: profile.email,
      outcome: OnboardingOutcome.Failed,
      error: result.error,
    });
    // ⚠️ Il n'y a PAS de dossier ici : c'est le seul cas où l'on demande de recommencer. La
    // soumission est idempotente, une seconde tentative ne créera pas de doublon.
    await deps.notify(PROFILE_SUBMISSION_FAILED_REPLY);
    return;
  }

  // ⚠️ `result.status === 'success'` ne signifie QUE « le workflow est allé au bout ». Le
  // verdict est `result.result.outcome` : les étapes best-effort avalent leur exception et
  // laissent le run en `success` même quand rien n'est parti. Journaliser le seul `status`
  // reproduirait exactement le faux « PASS » que ce champ existe pour éliminer.
  const degradedSteps = result.result?.degradedSteps ?? [];

  if (result.result?.outcome === OnboardingOutcome.Degraded) {
    logger.error('Onboarding workflow completed in DEGRADED mode', {
      email: profile.email,
      outcome: result.result.outcome,
      degradedSteps: describeDegradation(degradedSteps),
      emailSent: result.result?.emailSent,
      slackInvited: result.result?.slackInvited,
    });

    // ⚠️ Le dossier EXISTE : on ne demande pas de recommencer, on NOMME ce qui manque. La
    // liste vient du verdict réel, jamais devinée — annoncer un email non parti alors qu'il
    // l'est serait le mensonge inverse de celui qu'on corrige. Une liste vide n'envoie rien
    // plutôt qu'un message creux.
    const missing = describeMissingSteps(degradedSteps);
    if (missing.length > 0) {
      await deps.notify(profileSubmissionDegradedReply(missing));
    }
  } else {
    logger.info('Onboarding workflow completed', {
      email: profile.email,
      outcome: result.result?.outcome,
      emailSent: result.result?.emailSent,
      slackInvited: result.result?.slackInvited,
    });
  }

  // ⚠️ Appelé sur `completed` ET sur `degraded`, et cette distinction compte. `degraded`
  // signifie « l'employé EST créé, une étape best-effort a échoué ». C'est un ABOUTISSEMENT :
  // le workflow existe précisément pour ne pas perdre la création sur une indisponibilité SMTP
  // de trente secondes. Le cas `failed` sort plus haut par `return` — là, il n'y a pas de
  // dossier.
  await deps.onRecordReady(result.result?.employeeId);
}
