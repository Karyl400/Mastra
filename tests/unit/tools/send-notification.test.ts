import { describe, it, expect, vi } from 'vitest';
import { makeSendNotification } from '../../../src/features/notification/application/tools/send-notification';
import type { NotificationRepository } from '../../../src/features/notification/domain/ports/notification.repository';
import type { EmailProvider, ChatProvider } from '../../../src/features/notification/domain/ports/providers';
import { NotificationChannel, RecipientType, NotificationStatus } from '../../../src/shared/types';

describe('SendNotification Tool', () => {
  it('should send an email and save notification when valid data is provided', async () => {
    const mockRepo: NotificationRepository = {
      findById: vi.fn(),
      findByRecipient: vi.fn(),
      findPending: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      update: vi.fn(),
    };

    const mockEmailProvider: EmailProvider = {
      sendEmail: vi.fn().mockResolvedValue(undefined),
    };

    const mockChatProvider: ChatProvider = {
      sendMessage: vi.fn(),
    };

    const tool = makeSendNotification(mockRepo, mockEmailProvider, mockChatProvider);
    const input = {
      recipientId: '123e4567-e89b-12d3-a456-426614174000',
      recipientEmail: 'jean.dupont@kisso.com',
      recipientType: RecipientType.Employee,
      channel: NotificationChannel.Email,
      subject: 'Bienvenue',
      body: 'Voici vos accès.',
    };

    const result = await tool.execute!(input as any, {} as any) as any;
    
    expect(result).toBeDefined();
    expect(result.status).toBe(NotificationStatus.Sent);
    expect(mockEmailProvider.sendEmail).toHaveBeenCalledWith(input.recipientEmail, input.subject, input.body);
    expect(mockRepo.save).toHaveBeenCalled();
  });

  it('should mark as Failed if email provider throws', async () => {
    const mockRepo: NotificationRepository = {
      findById: vi.fn(),
      findByRecipient: vi.fn(),
      findPending: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      update: vi.fn(),
    };

    const mockEmailProvider: EmailProvider = {
      sendEmail: vi.fn().mockRejectedValue(new Error('SMTP error')),
    };

    const mockChatProvider: ChatProvider = {
      sendMessage: vi.fn(),
    };

    const tool = makeSendNotification(mockRepo, mockEmailProvider, mockChatProvider);
    const input = {
      recipientId: '123e4567-e89b-12d3-a456-426614174000',
      recipientEmail: 'jean.dupont@kisso.com',
      recipientType: RecipientType.Employee,
      channel: NotificationChannel.Email,
      subject: 'Bienvenue',
      body: 'Voici vos accès.',
    };

    const result = await tool.execute!(input as any, {} as any) as any;
    
    expect(result.status).toBe(NotificationStatus.Failed);
    expect(mockRepo.save).toHaveBeenCalled();
  });
});
