/**
 * Rattrapage des parcours d'intégration manquants.
 *
 * ── Le défaut qu'il répare ──────────────────────────────────────────────────
 * Un employé n'obtient un suivi (`onboarding_progress`), des tâches et des
 * étapes QUE s'il a été créé par `employeeOnboardingWorkflow`. Or la production
 * ne passe pas par là : les profils y sont créés par le tool `createEmployee`,
 * qui ne fait qu'un `repo.save(employee)`.
 *
 * État mesuré sur la Turso de production le 2026-08-11 :
 *   employees = 2, onboarding_progress = 0, tasks = 0, onboarding_steps = 0.
 *
 * Trois capacités annoncées par l'orchestrateur en dépendaient directement :
 * `updateOnboardingStatus` échouait sur 100 % des employés, `getTaskList`
 * rendait une liste vide, et `getEmployeeProfile` une coquille sans suivi.
 *
 * ── Ce qu'il NE fait pas ────────────────────────────────────────────────────
 * Il ne duplique aucune règle métier : le catalogue et la mise en plan viennent
 * de `src/features/onboarding/domain/services/onboarding-plan.ts`, le même
 * module qu'utilise le workflow. Un parcours rattrapé est donc identique, tâche
 * pour tâche, à un parcours créé à l'arrivée.
 *
 * ── Sûreté ──────────────────────────────────────────────────────────────────
 *  • DRY-RUN PAR DÉFAUT : sans `--apply`, pas une seule écriture.
 *  • IDEMPOTENT : un suivi déjà présent n'est jamais recréé, une tâche déjà
 *    présente (reconnue à son titre) n'est jamais dupliquée, une étape déjà
 *    reliée n'est jamais réémise. Le relancer ne produit rien.
 *  • RÉPARATEUR PARTIEL : un employé dont le suivi existe mais dont deux tâches
 *    manquent ne reçoit QUE ces deux tâches.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *     npx tsx scripts/backfill-onboarding.mts              # dry-run (défaut)
 *     npx tsx scripts/backfill-onboarding.mts --apply      # écrit réellement
 *
 * La base ciblée est `DATABASE_URL`. `dotenv` ne remplace jamais une variable
 * déjà positionnée, donc viser une base jetable se fait ainsi :
 *
 *     DATABASE_URL=file:/tmp/essai.db npx tsx scripts/backfill-onboarding.mts --apply
 */

import 'dotenv/config';

import { DrizzleEmployeeRepository } from '../src/features/employee/infrastructure/repositories/drizzle-employee.repository';
import { DrizzleTaskRepository } from '../src/features/employee/infrastructure/repositories/drizzle-task.repository';
import { DrizzleOnboardingRepository } from '../src/features/onboarding/infrastructure/repositories/drizzle-onboarding.repository';
import { buildOnboardingPlan } from '../src/features/onboarding/domain/services/onboarding-plan';
import type { Task } from '../src/features/employee/domain/entities/task';
import type {
  OnboardingProgress,
  OnboardingStep,
} from '../src/features/onboarding/domain/entities/onboarding-progress';
import { closeDb } from '../src/infrastructure/database/connection';

// ============================================================================
// ARGUMENTS
// ============================================================================

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const INCONNUS = [...args].filter((a) => a !== '--apply' && a !== '--dry-run');

if (INCONNUS.length > 0) {
  console.error(`Options inconnues : ${INCONNUS.join(', ')}`);
  console.error('Usage : npx tsx scripts/backfill-onboarding.mts [--dry-run|--apply]');
  process.exit(2);
}

/**
 * URL de la base, sans les identifiants éventuels.
 *
 * Un `libsql://` porte parfois un jeton en query string ; on n'imprime jamais
 * autre chose que le schéma et l'hôte.
 */
function cibleLisible(): string {
  const brut = process.env.DATABASE_URL ?? 'file:./data/kisso.db';
  const coupe = brut.indexOf('?');
  return coupe === -1 ? brut : brut.slice(0, coupe);
}

// ============================================================================
// RAPPORT
// ============================================================================

interface ActionsEmploye {
  readonly employeeId: string;
  readonly nom: string;
  readonly progressACreer: OnboardingProgress | null;
  readonly tachesACreer: readonly Task[];
  readonly etapesACreer: readonly OnboardingStep[];
  /** Raison d'un employé écarté sans action possible. */
  readonly ecarte?: string;
}

function estSansEffet(a: ActionsEmploye): boolean {
  return (
    a.progressACreer === null && a.tachesACreer.length === 0 && a.etapesACreer.length === 0
  );
}

// ============================================================================
// CALCUL DU PLAN (aucune écriture)
// ============================================================================

async function planifier(
  employeeRepo: DrizzleEmployeeRepository,
  onboardingRepo: DrizzleOnboardingRepository,
  taskRepo: DrizzleTaskRepository,
): Promise<ActionsEmploye[]> {
  const employes = await employeeRepo.findAll();
  const actions: ActionsEmploye[] = [];

  for (const employe of employes) {
    const nom = `${employe.firstName} ${employe.lastName}`;
    const vide = { employeeId: employe.id, nom, progressACreer: null, tachesACreer: [], etapesACreer: [] };

    // Un employé supprimé (soft delete) n'a pas à recevoir un parcours neuf.
    // `findAll` fait un `SELECT *` sans filtre : la colonne est là même si
    // l'entité ne la déclare pas.
    if ((employe as { deletedAt?: string | null }).deletedAt) {
      actions.push({ ...vide, ecarte: 'employé supprimé' });
      continue;
    }

    // Les échéances sont dérivées de la date d'arrivée. Sans date exploitable,
    // on préfère écarter plutôt que d'inventer un calendrier.
    if (!employe.startDate || Number.isNaN(Date.parse(employe.startDate))) {
      actions.push({ ...vide, ecarte: 'startDate absente ou invalide' });
      continue;
    }

    const progressExistant = await onboardingRepo.findByEmployee(employe.id);
    const plan = buildOnboardingPlan({
      employeeId: employe.id,
      startDate: employe.startDate,
      progressId: progressExistant?.id,
    });

    const tachesExistantes = await taskRepo.findByEmployee(employe.id);
    const parTitre = new Map(tachesExistantes.map((t) => [t.title, t]));

    const etapesExistantes = progressExistant
      ? await onboardingRepo.findSteps(progressExistant.id)
      : [];
    const tachesDejaReliees = new Set(etapesExistantes.map((s) => s.taskId));

    const tachesACreer: Task[] = [];
    const etapesACreer: OnboardingStep[] = [];

    for (const [index, tachePlanifiee] of plan.tasks.entries()) {
      // Reconnaissance par TITRE : les tâches n'ont pas d'autre clé naturelle,
      // et le catalogue est fixe. C'est ce qui rend le script idempotent.
      const existante = parTitre.get(tachePlanifiee.title);
      if (!existante) tachesACreer.push(tachePlanifiee);

      const taskId = existante?.id ?? tachePlanifiee.id;
      if (!tachesDejaReliees.has(taskId)) {
        // L'étape du plan pointe vers la tâche du plan : si la tâche existait
        // déjà, on la relie à SON identifiant plutôt qu'à un doublon.
        etapesACreer.push({ ...plan.steps[index]!, taskId });
      }
    }

    actions.push({
      employeeId: employe.id,
      nom,
      progressACreer: progressExistant ? null : plan.progress,
      tachesACreer,
      etapesACreer,
    });
  }

  return actions;
}

// ============================================================================
// ÉCRITURE
// ============================================================================

async function appliquer(
  onboardingRepo: DrizzleOnboardingRepository,
  taskRepo: DrizzleTaskRepository,
  actions: readonly ActionsEmploye[],
): Promise<void> {
  for (const action of actions) {
    if (action.ecarte || estSansEffet(action)) continue;

    // Le suivi D'ABORD : les étapes le référencent.
    if (action.progressACreer) await onboardingRepo.save(action.progressACreer);
    for (const tache of action.tachesACreer) await taskRepo.save(tache);
    for (const etape of action.etapesACreer) await onboardingRepo.saveStep(etape);

    console.log(
      `  écrit  ${action.nom} — suivi:${action.progressACreer ? 'créé' : 'existant'} ` +
        `tâches:+${action.tachesACreer.length} étapes:+${action.etapesACreer.length}`,
    );
  }
}

// ============================================================================
// SORTIE
// ============================================================================

function afficher(actions: readonly ActionsEmploye[]): void {
  for (const action of actions) {
    if (action.ecarte) {
      console.log(`  ÉCARTÉ  ${action.nom} (${action.employeeId}) — ${action.ecarte}`);
      continue;
    }

    if (estSansEffet(action)) {
      console.log(`  À JOUR  ${action.nom} (${action.employeeId}) — rien à faire`);
      continue;
    }

    console.log(`  À FAIRE ${action.nom} (${action.employeeId})`);
    console.log(
      `          onboarding_progress : ${action.progressACreer ? '1 à créer' : 'déjà présent'}`,
    );
    console.log(`          tasks               : ${action.tachesACreer.length} à créer`);
    for (const tache of action.tachesACreer) {
      console.log(`            · ${tache.title}  (échéance ${tache.dueDate})`);
    }
    console.log(`          onboarding_steps    : ${action.etapesACreer.length} à créer`);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  console.log('='.repeat(78));
  console.log("Rattrapage des parcours d'intégration");
  console.log(`  base   : ${cibleLisible()}`);
  console.log(`  mode   : ${APPLY ? 'APPLY — ÉCRITURE RÉELLE' : 'DRY-RUN (aucune écriture)'}`);
  console.log('='.repeat(78));

  const employeeRepo = new DrizzleEmployeeRepository();
  const onboardingRepo = new DrizzleOnboardingRepository();
  const taskRepo = new DrizzleTaskRepository();

  const actions = await planifier(employeeRepo, onboardingRepo, taskRepo);

  afficher(actions);

  const aTraiter = actions.filter((a) => !a.ecarte && !estSansEffet(a));
  const totaux = aTraiter.reduce(
    (acc, a) => ({
      progress: acc.progress + (a.progressACreer ? 1 : 0),
      taches: acc.taches + a.tachesACreer.length,
      etapes: acc.etapes + a.etapesACreer.length,
    }),
    { progress: 0, taches: 0, etapes: 0 },
  );

  console.log('-'.repeat(78));
  console.log(
    `  ${actions.length} employé(s) examiné(s) · ${aTraiter.length} à rattraper · ` +
      `${actions.filter((a) => a.ecarte).length} écarté(s)`,
  );
  console.log(
    `  À créer : ${totaux.progress} onboarding_progress, ${totaux.taches} tasks, ` +
      `${totaux.etapes} onboarding_steps`,
  );

  if (!APPLY) {
    console.log('-'.repeat(78));
    console.log("  DRY-RUN : rien n'a été écrit. Relancer avec --apply pour appliquer.");
    return;
  }

  if (aTraiter.length === 0) {
    console.log('  Rien à écrire.');
    return;
  }

  console.log('-'.repeat(78));
  await appliquer(onboardingRepo, taskRepo, actions);
  console.log('  Terminé.');
}

try {
  await main();
} catch (error) {
  console.error('Échec du rattrapage :', error);
  process.exitCode = 1;
} finally {
  await closeDb();
}
