export interface EmailProvider {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

export interface ChatProvider {
  sendMessage(channelId: string, text: string): Promise<void>;
}
