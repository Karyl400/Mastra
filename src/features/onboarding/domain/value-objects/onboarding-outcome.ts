/**
 * Issue d'un parcours d'intégration — et pourquoi il en faut TROIS, pas deux.
 *
 * ── L'incident ──────────────────────────────────────────────────────────────
 * `employeeOnboardingWorkflow` ne connaissait que « réussi » et « échoué ».
 * L'envoi de l'email de bienvenue étant best-effort (il attrape son erreur), un
 * email jamais parti se rendait par un `emailSent: false` noyé dans un run
 * `status: 'success'`. Trois lecteurs successifs y ont conclu à tort qu'un
 * email avait été envoyé : les rapports humains, `scripts/production-*.ts` et
 * les agents. C'est le piège « l'échec d'email est SILENCIEUX » de CLAUDE.md,
 * et il a produit de faux « PASS ».
 *
 * ── Pourquoi on ne LÈVE pas ─────────────────────────────────────────────────
 * Transformer l'échec d'une étape best-effort en exception avorterait le run et
 * ferait perdre l'employé créé, ses tâches et son invitation Slack — pour une
 * indisponibilité SMTP de trente secondes. Ce serait pire que le défaut qu'on
 * corrige. La bonne réponse n'est pas d'échouer plus fort, c'est de RENDRE le
 * verdict lisible : `Degraded` est un aboutissement, pas un échec.
 *
 * ── Pourquoi un module de domaine ───────────────────────────────────────────
 * Le vocabulaire doit être identique dans le workflow, dans la route qui le
 * journalise et dans les scripts qui l'assertent. Une chaîne recopiée à trois
 * endroits redeviendrait trois vocabulaires. TypeScript pur : aucun import.
 */

export enum OnboardingOutcome {
  /** Toutes les étapes ATTENDUES ont abouti. */
  Completed = 'completed',
  /**
   * L'employé existe, son suivi est en place — mais au moins une étape
   * best-effort a échoué. Le parcours est utilisable et RÉPARABLE, à condition
   * que quelqu'un l'apprenne : c'est tout l'objet de cette valeur.
   */
  Degraded = 'degraded',
  /**
   * Le parcours n'a pas abouti (email en doublon, base indisponible…).
   *
   * Cette valeur ne figure JAMAIS dans le résultat du workflow : un run en
   * échec n'a pas de résultat, Mastra rend `{ status: 'failed', error }`. Elle
   * existe pour que les appelants qui traduisent `run.status` en verdict
   * disposent du même vocabulaire que le workflow lui-même.
   */
  Failed = 'failed',
}

/**
 * Les étapes qui peuvent échouer SANS faire échouer le parcours.
 *
 * L'inventaire est exhaustif et c'est la moitié du correctif : ne traiter que
 * l'email aurait laissé l'invitation Slack et la création des tâches dans le
 * même angle mort, avec exactement le même symptôme.
 */
export enum BestEffortStep {
  /** Écriture des tâches et de leurs étapes de suivi (`initOnboarding`). */
  OnboardingTasks = 'onboardingTasks',
  /** Envoi de l'email de bienvenue (`sendWelcomeEmail`). */
  WelcomeEmail = 'welcomeEmail',
  /** Invitation de l'arrivant dans le canal Slack du département (`inviteToSlack`). */
  SlackInvite = 'slackInvite',
}

/**
 * QUOI a échoué et POURQUOI.
 *
 * Le couple est indissociable : un booléen `emailSent: false` dit qu'il faut
 * réparer, jamais quoi réparer — le diagnostic repartait alors des logs, quand
 * ils existaient encore.
 */
export interface StepFailure {
  readonly step: BestEffortStep;
  readonly reason: string;
}

/**
 * Normalise une cause d'échec en une phrase courte et non vide.
 *
 * On garde `error.message` et non l'objet : la valeur traverse un schéma Zod,
 * est sérialisée dans la réponse HTTP du workflow, et une `Error` n'y survit
 * pas (`JSON.stringify(new Error('x'))` rend `{}`). Une cause vide vaut une
 * cause perdue, d'où le repli explicite.
 */
export function toFailureReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : 'cause inconnue';
}

/** `Degraded` dès la PREMIÈRE étape best-effort en échec. */
export function outcomeOf(failures: readonly StepFailure[]): OnboardingOutcome {
  return failures.length > 0 ? OnboardingOutcome.Degraded : OnboardingOutcome.Completed;
}

/**
 * Résumé d'une ligne, destiné aux logs et aux rapports de test.
 *
 * Nomme TOUTES les étapes en échec, jamais seulement la première : ne rendre
 * que l'email ferait réparer l'email et croire le reste sain.
 */
export function describeDegradation(failures: readonly StepFailure[]): string {
  if (failures.length === 0) return 'aucune';
  return failures.map((failure) => `${failure.step} (${failure.reason})`).join(' ; ');
}
