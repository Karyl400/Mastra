import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmployeeOnboardingWorkflow } from '../../../src/features/onboarding/application/workflows/employee-onboarding';
import type { EmployeeRepository } from '../../../src/features/employee/domain/ports/employee.repository';
import type { OnboardingRepository } from '../../../src/features/onboarding/domain/ports/onboarding.repository';
import type { NotificationRepository } from '../../../src/features/notification/domain/ports/notification.repository';
import type { EmailProvider } from '../../../src/features/notification/domain/ports/providers';
import type { SlackWorkspaceProvider } from '../../../src/features/notification/domain/ports/slack-workspace.port';

const baseInput = {
  firstName: 'Jean',
  lastName: 'Dupont',
  email: 'jean.dupont@kisso.com',
  department: 'Engineering',
  position: 'Backend Developer',
  startDate: '2026-08-01T09:00:00.000Z',
  slackChannelId: 'C-ENG',
};

function makeDeps(overrides: {
  employeeRepo?: Partial<EmployeeRepository>;
  onboardingRepo?: Partial<OnboardingRepository>;
  notificationRepo?: Partial<NotificationRepository>;
  emailProvider?: Partial<EmailProvider>;
  slackProvider?: Partial<SlackWorkspaceProvider> | null;
} = {}) {
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

    expect(result.result.emailSent).toBe(true);
    expect(result.result.slackInvited).toBe(true);
    expect(result.result.slackUserId).toBe('U01');
    expect(deps.employeeRepo.save).toHaveBeenCalledTimes(1);
    expect(deps.onboardingRepo.save).toHaveBeenCalledTimes(1);
    expect(deps.notificationRepo.save).toHaveBeenCalledTimes(1);
    expect(deps.emailProvider.sendEmail).toHaveBeenCalled();
    expect(deps.slackProvider?.inviteToChannel).toHaveBeenCalledWith('C-ENG', 'U01');
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
});
