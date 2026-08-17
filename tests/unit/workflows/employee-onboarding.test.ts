import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmployeeOnboardingWorkflow } from '../../../src/features/onboarding/application/workflows/employee-onboarding';
import type { EmployeeRepository } from '../../../src/features/employee/domain/ports/employee.repository';
import type { OnboardingRepository } from '../../../src/features/onboarding/domain/ports/onboarding.repository';
import type { NotificationRepository } from '../../../src/features/notification/domain/ports/notification.repository';
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
  } = {},
) {
  const employeeRepo: EmployeeRepository = {
    findById: vi.fn().mockResolvedValue(null),
    findByEmail: vi.fn().mockResolvedValue(null),
    findByName: vi.fn().mockResolvedValue([]),
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

  return { employeeRepo, onboardingRepo, notificationRepo, emailProvider, slackProvider };
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

  it("crée le suivi d'intégration et RIEN d'autre", async () => {
    // ⚠️ Ce test a REMPLACÉ, le 2026-08-14, un bloc entier qui vérifiait la création de
    // cinq tâches et de leurs étapes. Ces tâches ont été retirées : aucun mécanisme du
    // système ne pouvait les faire avancer, donc le suivi qu'elles dessinaient ne bougeait
    // jamais. Le seul suivi du produit est la complétion du profil.
    const deps = makeDeps();
    const workflow = createEmployeeOnboardingWorkflow(deps);
    const run = await workflow.createRun();
    const result = await run.start({ inputData: baseInput });

    expect(result.status).toBe('success');

    const progress = (deps.onboardingRepo.save as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(progress.totalSteps).toBe(1);
    expect(progress.currentStep).toBe(0);
    expect(progress.status).toBe('in_progress');
    // Garde-fou de non-retour : aucune étape ne doit plus être écrite.
    expect(deps.onboardingRepo.saveStep).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ COMPORTEMENT CHANGÉ le 2026-08-15, et c'est un changement de FOND assumé.
   *
   * Ce workflow échouait sur un email connu (`ConflictError`), et deux tests le
   * verrouillaient. C'était défendable quand la création était un geste d'administration.
   *
   * Le point d'entrée a changé : le seul appelant est la soumission de la modale « Compléter
   * mon profil », où le demandeur EST la personne concernée. Un échec y signifie qu'elle
   * remplit le formulaire, valide, et **ne reçoit rien**. Mesuré en production le
   * 2026-08-15 : « Profile submission accepted » puis « Onboarding workflow failed », en
   * silence total pour l'utilisateur.
   */
  const EXISTING = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'alice@kisso.com',
    firstName: 'Alice',
    lastName: 'Martin',
    department: null,
    position: 'Software Engineer',
    startDate: '2026-09-01T00:00:00.000Z',
  };

  it('RÉUTILISE le dossier existant au lieu d’échouer', async () => {
    const deps = makeDeps({
      employeeRepo: {
        findByEmail: vi.fn().mockResolvedValue(EXISTING),
      },
    });
    const workflow = createEmployeeOnboardingWorkflow(deps);
    const run = await workflow.createRun();
    const result = await run.start({ inputData: baseInput });

    expect(result.status).toBe('success');
    // On ne réécrit PAS le dossier : la re-soumission ne doit pas écraser ce que d'autres
    // chemins y ont mis (département, manager), absents de la modale.
    expect(deps.employeeRepo.save).not.toHaveBeenCalled();
    if (result.status !== 'success') return;
    expect(result.result.employeeId).toBe(EXISTING.id);
  });

  it('RÉUTILISE le suivi d’intégration existant, sans le réinitialiser', async () => {
    // `onboarding_progress.employee_id` est UNIQUE : ré-insérer lève `SQLITE_CONSTRAINT` et
    // fait échouer tout le workflow. Mesuré en production juste après avoir rendu la création
    // d'employé idempotente — le défaut s'était simplement déplacé d'une étape.
    const existingProgress = { id: '22222222-2222-4222-8222-222222222222', currentStep: 1 };
    const deps = makeDeps({
      employeeRepo: { findByEmail: vi.fn().mockResolvedValue(EXISTING) },
      onboardingRepo: { findByEmployee: vi.fn().mockResolvedValue(existingProgress) },
    });
    const workflow = createEmployeeOnboardingWorkflow(deps);
    const run = await workflow.createRun();
    const result = await run.start({ inputData: baseInput });

    expect(result.status).toBe('success');
    // Réinitialiser effacerait l'avancement réel de la personne.
    expect(deps.onboardingRepo.save).not.toHaveBeenCalled();
  });

  it('ne RENVOIE PAS l’email de bienvenue à quelqu’un déjà accueilli', async () => {
    // « Non applicable » n'est PAS « dégradé » : compter cette étape comme une dégradation
    // rendrait « dégradé » le cas normal d'une re-soumission et détruirait le signal.
    const deps = makeDeps({
      employeeRepo: {
        findByEmail: vi.fn().mockResolvedValue(EXISTING),
      },
    });
    const workflow = createEmployeeOnboardingWorkflow(deps);
    const run = await workflow.createRun();
    const result = await run.start({ inputData: baseInput });

    expect(deps.emailProvider.sendEmail).not.toHaveBeenCalled();
    if (result.status !== 'success') return;
    expect(result.result.emailSent).toBe(false);
    expect(result.result.degradedSteps ?? []).toEqual([]);
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

    it("persiste malgré tout l'employé ET son suivi quand l'email échoue", async () => {
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

  it('n’échoue plus sur un email déjà connu (voir le changement de fond plus haut)', async () => {
    const deps = makeDeps({
      employeeRepo: {
        findByEmail: vi.fn().mockResolvedValue({
          id: '11111111-1111-4111-8111-111111111111',
          email: 'alice@kisso.com',
          firstName: 'Alice',
          lastName: 'Martin',
          department: null,
          position: 'Software Engineer',
          startDate: '2026-09-01T00:00:00.000Z',
        }),
      },
    });
    const workflow = createEmployeeOnboardingWorkflow(deps);
    const run = await workflow.createRun();
    const result = await run.start({ inputData: baseInput });

    expect(result.status).toBe('success');
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
