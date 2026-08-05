import { WebClient } from '@slack/web-api';
import type { ChatProvider } from '../../domain/ports/providers';

export class SlackAdapter implements ChatProvider {
  private slack: WebClient;

  constructor(botToken: string) {
    this.slack = new WebClient(botToken);
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    await this.slack.chat.postMessage({
      channel: channelId,
      text,
    });
  }
}
