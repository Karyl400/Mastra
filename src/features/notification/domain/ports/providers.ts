import type { EmailBody } from '../services/email-body';

export interface EmailAttachment {
  filename: string;
  bytes: Uint8Array;
  mimeType: string;
}

export interface EmailProvider {
  sendEmail(
    to: string,
    subject: string,
    body: EmailBody,
    attachments?: EmailAttachment[],
  ): Promise<void>;
}

export interface ChatProvider {
  sendMessage(channelId: string, text: string): Promise<{ channel: string }>;
}

export interface FileUploadInput {
  channel: string;
  threadTs?: string;
  bytes: Uint8Array;
  filename: string;
  title?: string;
  initialComment?: string;
}

export interface FileUploadProvider {
  uploadFile(input: FileUploadInput): Promise<{ permalink?: string }>;
}
