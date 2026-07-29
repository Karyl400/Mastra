export interface NotificationChannel {
  send(recipient: string, subject: string, body: string): Promise<void>;
}
