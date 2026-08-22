import { errorMessage } from '../../../../shared/errors';
import { slackErrorCode, slackErrorMentions } from '../../../../shared/slack/slack-error';
import type {
  ChannelInviteResult,
  ChannelInviteStatus,
  WelcomeChannelRef,
  WelcomeChannelSource,
} from '../../application/services/welcome-channels.service';

export interface SlackInviteClient {
  listChannels(): Promise<readonly { id: string; name: string }[]>;
  inviteToChannel(channelId: string, userId: string): Promise<void>;
  joinChannel(channelId: string): Promise<{ status: string; error?: string }>;
}

const STATUS_BY_SLACK_ERROR: ReadonlyMap<string, ChannelInviteStatus> = new Map([
  ['already_in_channel', 'already_in_channel'],
  ['cant_invite_self', 'already_in_channel'],
  ['not_in_channel', 'bot_not_in_channel'],
  ['channel_not_found', 'channel_not_found'],
  ['missing_scope', 'missing_scope'],
  ['not_allowed_token_type', 'missing_scope'],
]);

const STATUS_BY_JOIN_OUTCOME: ReadonlyMap<string, ChannelInviteStatus> = new Map([
  ['joined', 'invited'],
  ['already_member', 'already_in_channel'],
  ['not_public', 'channel_not_found'],
  ['archived', 'channel_not_found'],
  ['not_found', 'channel_not_found'],
  ['missing_scope', 'missing_scope'],
]);

export class SlackWelcomeChannelSource implements WelcomeChannelSource {
  constructor(private readonly slack: SlackInviteClient) {}

  async listChannels(): Promise<readonly WelcomeChannelRef[]> {
    const channels = await this.slack.listChannels();
    return channels.map((c) => ({ id: c.id, name: c.name }));
  }

  async invite(channelId: string, slackUserId: string): Promise<ChannelInviteResult> {
    try {
      await this.slack.inviteToChannel(channelId, slackUserId);
      return { status: 'invited' };
    } catch (error) {
      return classify(error);
    }
  }

  async join(channelId: string): Promise<ChannelInviteResult> {
    try {
      const outcome = await this.slack.joinChannel(channelId);
      const status = STATUS_BY_JOIN_OUTCOME.get(outcome.status) ?? 'failed';
      return outcome.error ? { status, error: outcome.error } : { status };
    } catch (error) {
      return classify(error);
    }
  }
}

function classify(error: unknown): ChannelInviteResult {
  const message = errorMessage(error);
  const code = slackErrorCode(error);

  if (code) {
    const status = STATUS_BY_SLACK_ERROR.get(code);
    if (status) return { status, error: message };
  }

  for (const [slackError, status] of STATUS_BY_SLACK_ERROR) {
    if (slackErrorMentions(error, slackError)) return { status, error: message };
  }

  return { status: 'failed', error: message };
}
