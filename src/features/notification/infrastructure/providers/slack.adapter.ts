import { WebClient } from '@slack/web-api';
import type {
  ChatPostMessageArguments,
  FilesUploadV2Arguments,
  ViewsOpenArguments,
} from '@slack/web-api';
import type {
  ChatProvider,
  FileUploadInput,
  FileUploadProvider,
} from '../../domain/ports/providers';

type ChatPostMessageWithBlocks = Extract<ChatPostMessageArguments, { blocks: unknown }>;

export type SlackBlock = ChatPostMessageWithBlocks['blocks'][number];

export type SlackModalView = Extract<ViewsOpenArguments['view'], { type: 'modal' }>;

function isSlackError(err: unknown, code: string): boolean {
  const data = (err as { data?: { error?: unknown } } | null | undefined)?.data;
  if (typeof data?.error === 'string') return data.error === code;
  return err instanceof Error && err.message.includes(code);
}

function extractPermalink(response: unknown): string | undefined {
  const completions = (response as { files?: unknown } | null | undefined)?.files;
  if (!Array.isArray(completions)) return undefined;

  for (const completion of completions) {
    const flat = (completion as { permalink?: unknown } | null | undefined)?.permalink;
    if (typeof flat === 'string') return flat;

    const files = (completion as { files?: unknown } | null | undefined)?.files;
    if (!Array.isArray(files)) continue;

    for (const file of files) {
      const permalink = (file as { permalink?: unknown } | null | undefined)?.permalink;
      if (typeof permalink === 'string') return permalink;
    }
  }

  return undefined;
}

export class SlackAdapter implements ChatProvider, FileUploadProvider {
  private slack: WebClient;

  constructor(botToken: string, client?: WebClient) {
    this.slack = client ?? new WebClient(botToken);
  }

  async sendMessage(
    channelId: string,
    text: string,
    threadTs?: string,
  ): Promise<{ channel: string }> {
    const response = await this.slack.chat.postMessage({
      channel: channelId,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return { channel: response.channel ?? channelId };
  }

  async updateMessage(
    channelId: string,
    ts: string,
    text: string,
    blocks: SlackBlock[],
  ): Promise<void> {
    await this.slack.chat.update({ channel: channelId, ts, text, blocks });
  }

  async sendBlocks(channelId: string, text: string, blocks: SlackBlock[]): Promise<{ ts: string }> {
    if (!text.trim()) {
      throw new Error(
        "sendBlocks exige un texte de repli non vide : Slack ne s'en sert que pour " +
          'la notification et les lecteurs d’écran, et un message à blocs sans repli ' +
          'arrive comme une notification vide.',
      );
    }

    const response = await this.slack.chat.postMessage({ channel: channelId, text, blocks });
    return { ts: response.ts ?? '' };
  }

  async openModal(triggerId: string, view: SlackModalView): Promise<{ viewId: string }> {
    try {
      const response = await this.slack.views.open({ trigger_id: triggerId, view });
      return { viewId: response.view?.id ?? '' };
    } catch (err: unknown) {
      if (isSlackError(err, 'expired_trigger_id')) {
        throw new Error(
          'Slack a rejeté le trigger_id : il expire 3 secondes après l’interaction. ' +
            'Appeler views.open avant toute E/S lente — jamais après un appel LLM ' +
            'ni depuis une tâche de fond.',
          { cause: err },
        );
      }
      throw err;
    }
  }

  async uploadFile(input: FileUploadInput): Promise<{ permalink?: string }> {
    const { channel, threadTs, bytes, filename, title, initialComment } = input;

    const destination = threadTs
      ? { channel_id: channel, thread_ts: threadTs }
      : { channel_id: channel };

    const args: FilesUploadV2Arguments = {
      ...destination,
      file: Buffer.from(bytes),
      filename,
      ...(title ? { title } : {}),
      ...(initialComment ? { initial_comment: initialComment } : {}),
    };

    try {
      const response = await this.slack.files.uploadV2(args);
      return { permalink: extractPermalink(response) };
    } catch (err: unknown) {
      if (isSlackError(err, 'missing_scope')) {
        throw new Error(
          'Slack refuse l’upload : le scope `files:write` manque au bot. Action HUMAINE ' +
            'requise, en deux temps — ajouter `files:write` dans OAuth & Permissions, PUIS ' +
            'réinstaller l’app dans le workspace (Settings → Install App → Reinstall to ' +
            'Workspace, jusqu’au bouton Allow). L’ajout seul ne suffit pas : le jeton ' +
            'conserve les scopes de l’installation en cours.',
          { cause: err },
        );
      }
      throw err;
    }
  }
}
