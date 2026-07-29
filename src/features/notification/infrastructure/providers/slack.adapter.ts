import { WebClient } from '@slack/web-api';
import type { ChatProvider } from '../../domain/ports/providers';
import { config } from '../../../../config/index';

export class SlackAdapter implements ChatProvider {
  private slack: WebClient;

  constructor() {
    this.slack = new WebClient(config.notifications.slack.botToken);
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    await this.slack.chat.postMessage({
      channel: channelId,
      text,
    });
  }
}
