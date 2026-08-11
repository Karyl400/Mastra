import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmployeeOnboardingWorkflow } from '../../../src/features/onboarding/application/workflows/employee-onboarding';
import type { EmployeeRepository } from '../../../src/features/employee/domain/ports/employee.repository';
import type { OnboardingRepository } from '../../../src/features/onboarding/domain/ports/onboarding.repository';
import type { NotificationRepository } from '../../../src/features/notification/domain/ports/notification.repository';
import type { TaskRepository } from '../../../src/features/employee/domain/ports/task.repository';
import type { EmailProvider } from '../../../src/features/notification/domain/ports/providers';
import type { SlackWorkspaceProvider } from '../../../src/features/notification/domain/ports/slack-workspace.port';
import {
  BestEffortStep,
  OnboardingOutcome,
} from '../../../src/features/onboarding/domain/value-objects/onboarding-outcome';
import { Department, Position } from '../../../src/shared/types';

const baseInput = {
  firstName: 'Jean',
  lastName: 'Dupont',
  email: 'jean.dupont@kisso.com',
  department: Department.Engineering,
  position: Position.BackendDeveloper,
  startDate: '2026-08-01T09:00:00.000Z',
  slackChannelId: 'C-ENG',
};

function makeDeps(
  overrides: {
    employeeRepo?: Partial<EmployeeRepository>;
    onboardingRepo?: Partial<OnboardingRepository>;
    notificationRepo?: Partial<NotificationRepository>;
    emailProvider?: Partial<EmailProvider>;
    slackProvider?: Partial<SlackWorkspaceProvider> | null;
    taskRepo?: Partial<TaskRepository>;
  } = {},
) {
  const employeeRepo: EmployeeRepository = {
    findById: vi.fn().mockResolvedValue(null),
    findByEmail: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    findAll: vi.fn().mockResolvedValue([]),
    ...overrides.employeeRepo,
  };

  const onboardingRepo: OnboardingRepository = {
    findByEmployee: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    findSteps: vi.fn().mockResolvedValue([]),
    saveStep: vi.fn().mockResolvedValue(undefined),
    updateStep: vi.fn().mockResolvedValue(undefined),
    ...overrides.onboardingRepo,
  };

  const notificationRepo: NotificationRepository = {
    findById: vi.fn().mockResolvedValue(null),
    findByRecipient: vi.fn().mockResolvedValue([]),
    findPending: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    ...overrides.notificationRepo,
  };

  const emailProvider: EmailProvider = {
    sendEmail: vi.fn().mockResolvedValue(undefined),
    ...overrides.emailProvider,
  };

  const taskRepo: TaskRepository = {
    findById: vi.fn().mockResolvedValue(null),
    findByEmployee: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    ...overrides.taskRepo,
  };

  const slackProvider =
    overrides.slackProvider === null
      ? undefined
      : ({
          listChannels: vi.fn(),
          listMembers: vi.fn(),
          findUserByEmail: vi.fn().mockResolvedValue({
            id: 'U01',
            name: 'jean.dupont',
            realName: 'Jean Dupont',
            email: baseInput.email,
            isBot: false,
            isAdmin: false,
            teamId: 'T01',
          }),
          inviteToChannel: vi.fn().mockResolvedValue(undefined),
          getChannelMembers: vi.fn(),
          ...overrides.slackProvider,
        } as SlackWorkspaceProvider);

  return { employeeRepo, onboardingRepo, notificationRepo, emailProvider, slackProvider, taskRepo };
}

describe('Workflow: employee-onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the full happy path with email + Slack invite', async () => {
    const deps = makeDeps();
    const workflow = createEmployeeOnboardingWorkflow(deps);
    const run = await workflow.createRun();
    const result = await run.start({ inputData: baseInput });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;

    expect(result.result.outcome).toBe(OnboardingOutcome.Completed);
    expect(result.result.degradedSteps).toEqual([]);
    expect(result.result.emailSent).toBe(true);
    expect(result.result.slackInvited).toBe(true);
    expect(result.result.slackUserId).toBe('U01');
    expect(deps.employeeRepo.save).toHaveBeenCalledTimes(1);
    expect(deps.onboardingRepo.save).toHaveBeenCalledTimes(1);
    expect(deps.notificationRepo.save).toHaveBeenCalledTimes(1);
    expect(deps.emailProvider.sendEmail).toHaveBeenCalled();
    expect(deps.slackProvider?.inviteToChannel).toHaveBeenCalledWith('C-ENG', 'U01');
  });

  describe("tâches d'intégration", () => {
    it('persiste une tâche ET une étape de suivi pour chaque item du parcours', async () => {
      // Sans cela, `tasks` et `onboarding_progress` restent vides — mesuré en
      // production le 2026-08-10 : `tasks = 0`. Le DM de suivi que porte le
      // nouveau flux d'arrivée n'aurait alors rien à suivre.
      const deps = makeDeps();
      const workflow = createEmployeeOnboardingWorkflow(deps);
      const run = await workflow.createRun();
      const result = await run.start({ inputData: baseInput });

      expect(result.status).toBe('success');
      const nbTaches = (deps.taskRepo.save as ReturnType<typeof vi.fn>).mock.calls.length;
      const nbEtapes = (deps.onboardingRepo.saveStep as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(nbTaches).toBeGreaterThan(0);
      expect(nbEtapes, 'une étape de suivi par tâche').toBe(nbTaches);
    });

    it('déclare un totalSteps égal au nombre réel de tâches créées', async () => {
      // `totalSteps` était le littéral 5, sans qu'aucune étape ne soit créée :
      // un compteur qui aurait menti dès le premier ajout de tâche.
      const deps = makeDeps();
      const workflow = createEmployeeOnboardingWorkflow(deps);
      const run = await workflow.createRun();
      await run.start({ inputData: baseInput });

      const progress = (deps.onboardingRepo.save as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const nbTaches = (deps.taskRepo.save as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(progress.totalSteps).toBe(nbTaches);
    });

    it('rattache chaque tâche à l’employé et chaque étape à la progression', async () => {
      const deps = makeDeps();
      const workflow = createEmployeeOnboardingWorkflow(deps);
      const run = await workflow.createRun();
      await run.start({ inputData: baseInput });

      const progress = (deps.onboardingRepo.save as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const taches = (deps.taskRepo.save as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      const etapes = (deps.onboardingRepo.saveStep as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0],
      );

      // Garde anti test-vert-à-vide : sans elle, les boucles ci-dessous ne
      // s'exécutent pas et le test passe alors qu'AUCUNE tâche n'est créée.
      expect(taches.length, 'aucune tâche créée').toBeGreaterThan(0);
      expect(etapes.length, 'aucune étape créée').toBe(taches.length);

      for (const t of taches) {
        expect(t.employeeId).toBe(progress.employeeId);
        expect(t.status).toBe('pending');
        expect(t.title.length).toBeGreaterThan(0);
      }

      // Les étapes pointent la progression et les tâches réellement créées,
      // dans un ordre stable et sans trou.
      const idsTaches = new Set(taches.map((t) => t.id));
      for (const e of etapes) {
        expect(e.progressId).toBe(progress.id);
        expect(idsTaches.has(e.taskId), 'étape orpheline').toBe(true);
      }
      expect(etapes.map((e) => e.stepOrder).sort((a, b) => a - b)).toEqual(
        taches.map((_, i) => i + 1),
      );
    });

    it("n'échoue pas le workflow si la persistance d'une tâche échoue", async () => {
      // Le parcours reste utilisable même dégradé : l'employé est créé, seul le
      // suivi manque. Échouer ici perdrait aussi la création.
      const deps = makeDeps({
        taskRepo: { save: vi.fn().mockRejectedValue(new Error('db down')) },
      });
      const workflow = createEmployeeOnboardingWorkflow(deps);
      const run = await workflow.createRun();
      const result = await run.start({ inputData: baseInput });

      expect(result.status).toBe('success');
      expect(deps.employeeRepo.save).toHaveBeenCalledTimes(1);
    });
  });

  it('fails when employee email already exists', async () => {
    const deps = makeDeps({
      employeeRepo: {
        findByEmail: vi.fn().mockResolvedValue({ id: 'existing' }),
      },
    });
    const workflow = createEmployeeOnboardingWorkflow(deps);
    const run = await workflow.createRun();
    const result = await run.start({ inputData: baseInput });

    expect(result.status).toBe('failed');
    expect(deps.employeeRepo.save).not.toHaveBeenCalled();
  });

  it('continues when email send fails (best-effort)', async () => {
    const deps = makeDeps({
      emailProvider: {
        sendEmail: vi.fn().mockRejectedValue(new Error('SMTP down')),
      },
    });
    const workflow = createEmployeeOnboardingWorkflow(deps);
    const run = await workflow.createRun();
    const result = await run.start({ inputData: baseInput });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.result.emailSent).toBe(false);
    expect(result.result.slackInvited).toBe(true);
  });

  it('skips Slack invite when channel is missing', async () => {
    const deps = makeDeps();
    const workflow = createEmployeeOnboardingWorkflow(deps);
    const run = await workflow.createRun();
    const { slackChannelId: _ignored, ...withoutChannel } = baseInput;
    const result = await run.start({ inputData: withoutChannel });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.result.slackInvited).toBe(false);
    expect(deps.slackProvider?.inviteToChannel).not.toHaveBeenCalled();
  });

  it('skips Slack invite when user is not found', async () => {
    const deps = makeDeps({
      slackProvider: {
        findUserByEmail: vi.fn().mockResolvedValue(null),
      },
    });
    const workflow = createEmployeeOnboardingWorkflow(deps);
    const run = await workflow.createRun();
    const result = await run.start({ inputData: baseInput });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.result.slackInvited).toBe(false);
  });

  it('does not fail the workflow when Slack invite throws', async () => {
    const deps = makeDeps({
      slackProvider: {
        inviteToChannel: vi.fn().mockRejectedValue(new Error('rate_limited')),
      },
    });
    const workflow = createEmployeeOnboardingWorkflow(deps);
    const run = await workflow.createRun();
    const result = await run.start({ inputData: baseInput });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.result.slackInvited).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Visibilité de la DÉGRADATION.
  //
  // Le piège corrigé ici : un email jamais parti était rendu par un simple
  // `emailSent: false` noyé dans un run `status: 'success'`. Trois lecteurs
  // successifs (rapport humain, `scripts/production-*`, agent) ont conclu à
  // tort qu'un email avait été envoyé. `outcome` porte désormais le verdict et
  // `degradedSteps` nomme l'étape ET la cause.
  //
  // Contrainte inverse, tout aussi importante : ces étapes restent best-effort.
  // Aucune ne doit LEVER, sinon la création de l'employé, ses tâches et son
  // invitation Slack seraient perdues parce que le SMTP est tombé.
  // ──────────────────────────────────────────────────────────────────────────
  describe('issue du parcours (outcome / degradedSteps)', () => {
    it("marque le parcours DÉGRADÉ et nomme l'étape email quand l'envoi échoue", async () => {
      const deps = makeDeps({
        emailProvider: { sendEmail: vi.fn().mockRejectedValue(new Error('SMTP down')) },
      });
      const workflow = createEmployeeOnboardingWorkflow(deps);
      const run = await workflow.createRun();
      const result = await run.start({ inputData: baseInput });

      expect(result.status).toBe('success');
      if (result.status !== 'success') return;

      expect(result.result.outcome).toBe(OnboardingOutcome.Degraded);
      expect(result.result.degradedSteps).toHaveLength(1);
      expect(result.result.degradedSteps[0]?.step).toBe(BestEffortStep.WelcomeEmail);
      // La CAUSE voyage avec l'étape : un booléen ne dit pas quoi réparer.
      expect(result.result.degradedSteps[0]?.reason).toContain('SMTP down');
    });

    it("persiste malgré tout l'employé ET ses tâches quand l'email échoue", async () => {
      // C'est cette garantie qui justifie de ne PAS lever : perdre la création
      // parce que le SMTP est indisponible serait pire que l'échec silencieux.
      const deps = makeDeps({
        emailProvider: { sendEmail: vi.fn().mockRejectedValue(new Error('SMTP down')) },
      });
      const workflow = createEmployeeOnboardingWorkflow(deps);
      const run = await workflow.createRun();
      const result = await run.start({ inputData: baseInput });

      expect(result.status).toBe('success');
      expect(deps.employeeRepo.save).toHaveBeenCalledTimes(1);
      expect(deps.onboardingRepo.save).toHaveBeenCalledTimes(1);
      expect(
        (deps.taskRepo.save as ReturnType<typeof vi.fn>).mock.calls.length,
        'aucune tâche persistée',
      ).toBeGreaterThan(0);
      // La notification reste tracée, en statut d'échec.
      expect(deps.notificationRepo.save).toHaveBeenCalledTimes(1);
    });

    it("marque le parcours DÉGRADÉ et nomme l'étape Slack quand l'invitation lève", async () => {
      const deps = makeDeps({
        slackProvider: { inviteToChannel: vi.fn().mockRejectedValue(new Error('rate_limited')) },
      });
      const workflow = createEmployeeOnboardingWorkflow(deps);
      const run = await workflow.createRun();
      const result = await run.start({ inputData: baseInput });

      expect(result.status).toBe('success');
      if (result.status !== 'success') return;

      expect(result.result.outcome).toBe(OnboardingOutcome.Degraded);
      expect(result.result.degradedSteps.map((f) => f.step)).toEqual([BestEffortStep.SlackInvite]);
      expect(result.result.degradedSteps[0]?.reason).toContain('rate_limited');
      expect(deps.employeeRepo.save).toHaveBeenCalledTimes(1);
    });

    it("marque le parcours DÉGRADÉ quand aucun compte Slack ne répond à l'email", async () => {
      // Le canal EST configuré : l'invitation était donc attendue et n'a pas eu
      // lieu. C'est un trou réel dans l'accueil, pas une étape non applicable.
      const deps = makeDeps({
        slackProvider: { findUserByEmail: vi.fn().mockResolvedValue(null) },
      });
      const workflow = createEmployeeOnboardingWorkflow(deps);
      const run = await workflow.createRun();
      const result = await run.start({ inputData: baseInput });

      expect(result.status).toBe('success');
      if (result.status !== 'success') return;

      expect(result.result.outcome).toBe(OnboardingOutcome.Degraded);
      expect(result.result.degradedSteps.map((f) => f.step)).toEqual([BestEffortStep.SlackInvite]);
    });

    it("reste COMPLET quand l'invitation Slack est simplement hors sujet", async () => {
      // Arbitrage décisif : sans canal de département (le cas de TOUTE
      // soumission de la modale, `slackChannelId: null`), l'étape n'était pas
      // censée s'exécuter. La compter comme dégradation rendrait « dégradé »
      // l'état NORMAL et détruirait le signal qu'on vient de créer.
      const deps = makeDeps();
      const workflow = createEmployeeOnboardingWorkflow(deps);
      const run = await workflow.createRun();
      const { slackChannelId: _ignored, ...withoutChannel } = baseInput;
      const result = await run.start({ inputData: withoutChannel });

      expect(result.status).toBe('success');
      if (result.status !== 'success') return;

      expect(result.result.outcome).toBe(OnboardingOutcome.Completed);
      expect(result.result.degradedSteps).toEqual([]);
      expect(result.result.slackInvited).toBe(false);
    });

    it('marque le parcours DÉGRADÉ quand la persistance des tâches échoue', async () => {
      const deps = makeDeps({
        taskRepo: { save: vi.fn().mockRejectedValue(new Error('db down')) },
      });
      const workflow = createEmployeeOnboardingWorkflow(deps);
      const run = await workflow.createRun();
      const result = await run.start({ inputData: baseInput });

      expect(result.status).toBe('success');
      if (result.status !== 'success') return;

      expect(result.result.outcome).toBe(OnboardingOutcome.Degraded);
      expect(result.result.degradedSteps.map((f) => f.step)).toEqual([
        BestEffortStep.OnboardingTasks,
      ]);
      expect(result.result.degradedSteps[0]?.reason).toContain('db down');
      expect(deps.employeeRepo.save).toHaveBeenCalledTimes(1);
    });

    it('cumule TOUTES les étapes best-effort en échec, sans en masquer aucune', async () => {
      // Ne rendre que la première ferait réparer l'email et croire le reste sain.
      const deps = makeDeps({
        emailProvider: { sendEmail: vi.fn().mockRejectedValue(new Error('SMTP down')) },
        slackProvider: { inviteToChannel: vi.fn().mockRejectedValue(new Error('rate_limited')) },
      });
      const workflow = createEmployeeOnboardingWorkflow(deps);
      const run = await workflow.createRun();
      const result = await run.start({ inputData: baseInput });

      expect(result.status).toBe('success');
      if (result.status !== 'success') return;

      expect(result.result.outcome).toBe(OnboardingOutcome.Degraded);
      expect(result.result.degradedSteps.map((f) => f.step)).toEqual([
        BestEffortStep.WelcomeEmail,
        BestEffortStep.SlackInvite,
      ]);
      expect(result.result.emailSent).toBe(false);
      expect(result.result.slackInvited).toBe(false);
    });
  });

  it('fails with a conflict message for duplicate emails', async () => {
    const deps = makeDeps({
      employeeRepo: {
        findByEmail: vi.fn().mockResolvedValue({ id: 'existing' }),
      },
    });
    const workflow = createEmployeeOnboardingWorkflow(deps);
    const run = await workflow.createRun();
    const result = await run.start({ inputData: baseInput });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(String(result.error?.message ?? result.error)).toContain('existe déjà');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Régression : l'allowlist Department/Position doit s'appliquer AUSSI ici.
  // Le workflow est une seconde porte d'entrée vers `employees`, à côté du tool
  // `createEmployee`. Il a laissé passer `department: "Wakanda"` en production
  // (status: 'success', valeur persistée) parce qu'il déclarait z.string().min(1).
  // ──────────────────────────────────────────────────────────────────────────
  describe('allowlist Department / Position', () => {
    it('rejette un département hors allowlist et ne persiste rien', async () => {
      const deps = makeDeps();
      const workflow = createEmployeeOnboardingWorkflow(deps);
      const run = await workflow.createRun();

      // `as never` : on force volontairement une valeur que le type interdit,
      // pour reproduire un appel HTTP réel qui n'est pas contraint par TypeScript.
      //
      // NB : la validation de l'ENTRÉE du workflow (`Run.#validateSchema`) LÈVE,
      // contrairement à l'échec d'une ÉTAPE qui, lui, retourne { status: 'failed' }.
      // Deux régimes d'erreur distincts — ne pas les confondre.
      await expect(
        run.start({ inputData: { ...baseInput, department: 'Wakanda' as never } }),
      ).rejects.toThrow(/department/i);

      expect(deps.employeeRepo.save).not.toHaveBeenCalled();
    });

    it('accepte un poste absent de l’enum — le poste est un champ libre', async () => {
      // Le workflow reste la seconde porte d'entrée vers `employees`, mais le
      // poste n'est plus une taxonomie : c'est l'arrivant qui le saisit.
      const deps = makeDeps();
      const workflow = createEmployeeOnboardingWorkflow(deps);
      const run = await workflow.createRun();

      const result = await run.start({
        inputData: { ...baseInput, position: 'Software Engineer' as never },
      });

      expect(result.status).toBe('success');
      expect(deps.employeeRepo.save).toHaveBeenCalled();
    });

    it('rejette un poste vide ou porteur de HTML et ne persiste rien', async () => {
      const deps = makeDeps();
      const workflow = createEmployeeOnboardingWorkflow(deps);

      for (const bad of ['', 'Dev <img src=x>']) {
        const run = await workflow.createRun();
        await expect(
          run.start({ inputData: { ...baseInput, position: bad as never } }),
        ).rejects.toThrow(/position/i);
      }

      expect(deps.employeeRepo.save).not.toHaveBeenCalled();
    });

    it("accepte toutes les valeurs légitimes de l'allowlist", async () => {
      const deps = makeDeps();
      const workflow = createEmployeeOnboardingWorkflow(deps);
      const run = await workflow.createRun();

      const result = await run.start({
        inputData: { ...baseInput, department: Department.Finance, position: Position.Director },
      });

      expect(result.status).toBe('success');
    });
  });
});
