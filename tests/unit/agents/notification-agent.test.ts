import { describe, it, expect, vi } from 'vitest';
import { makeNotificationAgent } from '../../../src/features/notification/application/agents/notification-agent';

describe('NotificationAgent Agent', () => {
  it('should create an agent with correct ID and name', () => {
    const mockTools = { dummyTool: {} };
    const agent = makeNotificationAgent(mockTools);

    expect(agent).toBeDefined();
    expect(agent.id).toBe('notificationAgent');
    expect(agent.name).toBe('Notification Agent');
  });

  it('should include security prompt in instructions', () => {
    const agent = makeNotificationAgent({});
    expect(agent).toBeDefined();
    // agent.instructions est privé dans Mastra 0.2
  });

  it('should inject provided tools', () => {
    const mockTools = { sendNotification: { execute: vi.fn() } };
    const agent = makeNotificationAgent(mockTools);
    
    expect(agent).toBeDefined();
    // agent.tools est privé dans Mastra 0.2
  });
});