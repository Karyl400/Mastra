export interface ConversationTurn {
  readonly id: string;
  readonly conversationId: string;
  readonly role: ConversationRole;
  readonly content: string;
  readonly agentId: string;
  readonly slackUserId: string | null;
  readonly createdAt: Date;
}

export type ConversationRole = 'user' | 'assistant';

export type NewConversationTurn = Omit<ConversationTurn, 'id' | 'createdAt'>;
