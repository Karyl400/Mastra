export const PENDING_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingInterviewEmail {
  readonly conversationId: string;
  readonly requesterUserId: string;
  readonly to: string;
  readonly candidateName?: string | null;
  readonly startsAt: string;
  readonly position?: string | null;
  readonly location?: string | null;
  readonly replyTo?: string | null;
  readonly createdAt: Date;
}

export interface PendingInterviewEmailRepository {
  save(pending: PendingInterviewEmail): Promise<void>;

  find(conversationId: string): Promise<PendingInterviewEmail | null>;

  clear(conversationId: string): Promise<number>;
}
