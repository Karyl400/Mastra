import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSendNotification } from '../../../src/features/notification/application/tools/send-notification';
import type { NotificationRepository } from '../../../src/features/notification/domain/ports/notification.repository';
import type {
  EmailProvider,
  ChatProvider,
} from '../../../src/features/notification/domain/ports/providers';
import type {
  SlackWorkspaceProvider,
  SlackMember,
} from '../../../src/features/notification/domain/ports/slack-workspace.port';
import { InMemoryNotificationRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-notification.repository';
import { InMemoryEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/in-memory-employee.repository';
import { createEmployee } from '../../../src/features/employee/domain/entities/employee';
import { NotificationChannel, RecipientType, NotificationStatus } from '../../../src/shared/types';

// ---------------------------------------------------------------------------
// Doublures
// ---------------------------------------------------------------------------

const EMPLOYEE_ID = '123e4567-e89b-12d3-a456-426614174000';
const MANAGER_ID = '223e4567-e89b-12d3-a456-426614174001';
const UNKNOWN_ID = '999e4567-e89b-12d3-a456-4266141749ff';

const EMPLOYEE_EMAIL = 'jean.dupont@kisso.com';
const MANAGER_EMAIL = 'marie.martin@kisso.com';

/** Adresse que seul le LLM propose — elle ne doit JAMAIS être utilisée. */
const ATTACKER_EMAIL = 'victime@example.com';
const ATTACKER_SLACK_ID = 'C0BJGBVB5HP';

function makeSlackMember(id: string, email: string): SlackMember {
  return {
    id,
    name: 'user',
    realName: 'User',
    email,
    firstName: 'User',
    lastName: '',
    isBot: false,
    isAdmin: false,
    teamId: 'TMLKC4EPP',
  };
}

function makeDeps() {
  const notificationRepo: NotificationRepository = new InMemoryNotificationRepository();
  const employeeRepo = new InMemoryEmployeeRepository();

  const emailProvider: EmailProvider = { sendEmail: vi.fn().mockResolvedValue(undefined) };
  const chatProvider: ChatProvider = { sendMessage: vi.fn().mockResolvedValue(undefined) };

  const slackWorkspace: SlackWorkspaceProvider = {
    listChannels: vi.fn().mockResolvedValue([]),
    listMembers: vi.fn().mockResolvedValue([]),
    findUserByEmail: vi.fn().mockResolvedValue(null),
    getUserById: vi.fn().mockResolvedValue(null),
    inviteToChannel: vi.fn().mockResolvedValue(undefined),
    getChannelMembers: vi.fn().mockResolvedValue([]),
  };

  return { notificationRepo, employeeRepo, emailProvider, chatProvider, slackWorkspace };
}

type Deps = ReturnType<typeof makeDeps>;

function makeTool(deps: Deps) {
  return makeSendNotification(
    deps.notificationRepo,
    deps.employeeRepo,
    deps.emailProvider,
    deps.chatProvider,
    deps.slackWorkspace,
  );
}

async function seedDirectory(deps: Deps) {
  await deps.employeeRepo.save(
    createEmployee({
      id: EMPLOYEE_ID,
      firstName: 'Jean',
      lastName: 'Dupont',
      email: EMPLOYEE_EMAIL,
      department: 'Engineering',
      position: 'Backend Developer',
      startDate: '2026-01-05',
      managerId: MANAGER_ID,
    }),
  );
  await deps.employeeRepo.save(
    createEmployee({
      id: MANAGER_ID,
      firstName: 'Marie',
      lastName: 'Martin',
      email: MANAGER_EMAIL,
      department: 'Engineering',
      position: 'Engineering Manager',
      startDate: '2024-03-01',
      managerId: null,
    }),
  );
}

// ---------------------------------------------------------------------------

describe('SendNotification Tool', () => {
  let deps: Deps;

  beforeEach(async () => {
    deps = makeDeps();
    await seedDirectory(deps);
  });

  describe('chemin nominal', () => {
    it('should send an email and save notification when valid data is provided', async () => {
      const tool = makeTool(deps);

      const result = (await tool.execute!(
        {
          recipientId: EMPLOYEE_ID,
          recipientType: RecipientType.Employee,
          channel: NotificationChannel.Email,
          subject: 'Bienvenue',
          body: 'Voici vos accès.',
        } as any,
        {} as any,
      )) as any;

      expect(result).toBeDefined();
      expect(result.status).toBe(NotificationStatus.Sent);
      expect(deps.emailProvider.sendEmail).toHaveBeenCalledWith(
        EMPLOYEE_EMAIL,
        'Bienvenue',
        'Voici vos accès.',
      );
      expect(await deps.notificationRepo.findByRecipient(EMPLOYEE_ID)).toHaveLength(1);
    });

    it('should mark as Failed if email provider throws', async () => {
      deps.emailProvider.sendEmail = vi.fn().mockRejectedValue(new Error('SMTP error'));
      const tool = makeTool(deps);

      const result = (await tool.execute!(
        {
          recipientId: EMPLOYEE_ID,
          recipientType: RecipientType.Employee,
          channel: NotificationChannel.Email,
          subject: 'Bienvenue',
          body: 'Voici vos accès.',
        } as any,
        {} as any,
      )) as any;

      expect(result.status).toBe(NotificationStatus.Failed);
      expect(await deps.notificationRepo.findByRecipient(EMPLOYEE_ID)).toHaveLength(1);
    });

    it('should persist an in-app notification without contacting any provider', async () => {
      const tool = makeTool(deps);

      const result = (await tool.execute!(
        {
          recipientId: EMPLOYEE_ID,
          recipientType: RecipientType.Employee,
          channel: NotificationChannel.InApp,
          subject: 'Rappel',
          body: 'Pensez à signer votre contrat.',
        } as any,
        {} as any,
      )) as any;

      expect(result.status).toBe(NotificationStatus.Sent);
      expect(deps.emailProvider.sendEmail).not.toHaveBeenCalled();
      expect(deps.chatProvider.sendMessage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Régression sécurité : l'adresse vient de la BASE, jamais du LLM.
  // -------------------------------------------------------------------------
  describe('résolution du destinataire (anti prompt-injection)', () => {
    it('should expose no recipientEmail / recipientSlackId field in the input schema', () => {
      const tool = makeTool(deps);
      const shape = (tool.inputSchema as any).shape;

      expect(Object.keys(shape)).not.toContain('recipientEmail');
      expect(Object.keys(shape)).not.toContain('recipientSlackId');
      expect(Object.keys(shape)).toContain('recipientId');
    });

    it('should IGNORE an LLM-supplied recipientEmail and use the address from the repository', async () => {
      const tool = makeTool(deps);

      await tool.execute!(
        {
          recipientId: EMPLOYEE_ID,
          // Injecté par un utilisateur Slack malveillant via le texte du message.
          recipientEmail: ATTACKER_EMAIL,
          recipientType: RecipientType.Employee,
          channel: NotificationChannel.Email,
          subject: 'Réinitialisation de votre compte Kisso',
          body: '<a href="http://evil.example">cliquez ici</a>',
        } as any,
        {} as any,
      );

      expect(deps.emailProvider.sendEmail).toHaveBeenCalledTimes(1);
      expect(deps.emailProvider.sendEmail).toHaveBeenCalledWith(
        EMPLOYEE_EMAIL,
        expect.any(String),
        expect.any(String),
      );
      expect(deps.emailProvider.sendEmail).not.toHaveBeenCalledWith(
        ATTACKER_EMAIL,
        expect.anything(),
        expect.anything(),
      );
    });

    it('should IGNORE an LLM-supplied recipientSlackId and resolve the Slack target from the repository email', async () => {
      (deps.slackWorkspace.findUserByEmail as any).mockResolvedValue(
        makeSlackMember('U0EMPLOYEE', EMPLOYEE_EMAIL),
      );
      const tool = makeTool(deps);

      await tool.execute!(
        {
          recipientId: EMPLOYEE_ID,
          recipientSlackId: ATTACKER_SLACK_ID,
          recipientType: RecipientType.Employee,
          channel: NotificationChannel.Slack,
          subject: 'Urgent',
          body: 'Message',
        } as any,
        {} as any,
      );

      expect(deps.slackWorkspace.findUserByEmail).toHaveBeenCalledWith(EMPLOYEE_EMAIL);
      expect(deps.chatProvider.sendMessage).toHaveBeenCalledTimes(1);
      expect((deps.chatProvider.sendMessage as any).mock.calls[0][0]).toBe('U0EMPLOYEE');
      expect((deps.chatProvider.sendMessage as any).mock.calls[0][0]).not.toBe(ATTACKER_SLACK_ID);
    });

    it('should FAIL LOUDLY (throw) when recipientId is unknown, and send nothing', async () => {
      const tool = makeTool(deps);

      await expect(
        tool.execute!(
          {
            recipientId: UNKNOWN_ID,
            recipientType: RecipientType.Employee,
            channel: NotificationChannel.Email,
            subject: 'Bienvenue',
            body: 'Corps',
          } as any,
          {} as any,
        ),
      ).rejects.toThrow(/introuvable|not found/i);

      expect(deps.emailProvider.sendEmail).not.toHaveBeenCalled();
      expect(deps.chatProvider.sendMessage).not.toHaveBeenCalled();
      expect(await deps.notificationRepo.findByRecipient(UNKNOWN_ID)).toHaveLength(0);
    });

    it('should FAIL LOUDLY when recipientId is unknown even on the in-app channel', async () => {
      const tool = makeTool(deps);

      await expect(
        tool.execute!(
          {
            recipientId: UNKNOWN_ID,
            recipientType: RecipientType.Employee,
            channel: NotificationChannel.InApp,
            subject: 'Bienvenue',
            body: 'Corps',
          } as any,
          {} as any,
        ),
      ).rejects.toThrow(/introuvable|not found/i);
    });

    it('should FAIL LOUDLY when the Slack account cannot be resolved, without falling back', async () => {
      (deps.slackWorkspace.findUserByEmail as any).mockResolvedValue(null);
      const tool = makeTool(deps);

      await expect(
        tool.execute!(
          {
            recipientId: EMPLOYEE_ID,
            recipientSlackId: ATTACKER_SLACK_ID,
            recipientType: RecipientType.Employee,
            channel: NotificationChannel.Slack,
            subject: 'Urgent',
            body: 'Message',
          } as any,
          {} as any,
        ),
      ).rejects.toThrow();

      expect(deps.chatProvider.sendMessage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // recipientType = manager
  // -------------------------------------------------------------------------
  describe('destinataire de type manager', () => {
    it('should resolve a manager address from the repository', async () => {
      const tool = makeTool(deps);

      const result = (await tool.execute!(
        {
          recipientId: MANAGER_ID,
          recipientType: RecipientType.Manager,
          channel: NotificationChannel.Email,
          subject: 'Rapport onboarding',
          body: 'Votre nouvelle recrue a terminé son parcours.',
        } as any,
        {} as any,
      )) as any;

      expect(result.status).toBe(NotificationStatus.Sent);
      expect(deps.emailProvider.sendEmail).toHaveBeenCalledWith(
        MANAGER_EMAIL,
        'Rapport onboarding',
        'Votre nouvelle recrue a terminé son parcours.',
      );
    });

    it('should FAIL LOUDLY for an unresolvable manager instead of falling back to the LLM address', async () => {
      const tool = makeTool(deps);

      await expect(
        tool.execute!(
          {
            recipientId: UNKNOWN_ID,
            recipientEmail: ATTACKER_EMAIL,
            recipientType: RecipientType.Manager,
            channel: NotificationChannel.Email,
            subject: 'Rapport',
            body: 'Corps',
          } as any,
          {} as any,
        ),
      ).rejects.toThrow(/introuvable|not found/i);

      expect(deps.emailProvider.sendEmail).not.toHaveBeenCalled();
    });
  });
});
