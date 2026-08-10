import { WebClient } from '@slack/web-api';
import type { ChatPostMessageArguments, ViewsOpenArguments } from '@slack/web-api';
import type { ChatProvider } from '../../domain/ports/providers';

/**
 * Types Block Kit dérivés des signatures de `WebClient`.
 *
 * Ils vivent ici, en infrastructure, et non dans `domain/` : Block Kit est le
 * format de fil d'un fournisseur externe (clés en snake_case), et le garde-fou
 * d'architecture interdit tout import `@slack/*` dans la couche domaine. Les
 * dériver plutôt que de les réécrire évite une union de plusieurs centaines de
 * lignes qui dériverait à chaque évolution de l'API Slack.
 *
 * On les dérive de `@slack/web-api` et non de `@slack/types` — ce dernier n'est
 * qu'une dépendance transitive, l'importer serait une dépendance fantôme.
 *
 * `ChatPostMessageArguments` est une union (texte | blocs | pièces jointes) :
 * `Extract<…, { blocks: unknown }>` en isole le membre où `blocks` est requis.
 */
type ChatPostMessageWithBlocks = Extract<ChatPostMessageArguments, { blocks: unknown }>;

export type SlackBlock = ChatPostMessageWithBlocks['blocks'][number];
export type SlackModalView = ViewsOpenArguments['view'];

/**
 * Teste le code d'erreur brut d'une réponse Slack.
 *
 * Le SDK lève un `WebAPIPlatformError` dont `.message` est de la prose
 * (« An API error occurred: expired_trigger_id ») et dont `.data.error` porte
 * le code seul. On lit `data.error` en priorité — le message peut changer d'une
 * version du SDK à l'autre — avec repli sur le message pour les erreurs nues.
 */
function isSlackError(err: unknown, code: string): boolean {
  const data = (err as { data?: { error?: unknown } } | null | undefined)?.data;
  if (typeof data?.error === 'string') return data.error === code;
  return err instanceof Error && err.message.includes(code);
}

export class SlackAdapter implements ChatProvider {
  private slack: WebClient;

  /** `client` n'est là que pour les tests — la production ne passe que le jeton. */
  constructor(botToken: string, client?: WebClient) {
    this.slack = client ?? new WebClient(botToken);
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    await this.slack.chat.postMessage({
      channel: channelId,
      text,
    });
  }

  /**
   * Poste un message à blocs et rend son `ts`.
   *
   * Le `ts` permet de mettre le message à jour par la suite — c'est le seul
   * moyen de neutraliser un bouton après son premier clic.
   */
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

  /**
   * Ouvre une modale et rend son `viewId`.
   *
   * ⚠️ À appeler immédiatement après l'interaction : le `trigger_id` expire au
   * bout de 3 secondes. C'est le contre-pied exact du traitement en tâche de
   * fond de la route Events — ne pas « harmoniser » les deux.
   *
   * Le `viewId` retourné est le seul moyen d'enrichir la modale ensuite
   * (`views.update`), une fois ce délai passé.
   */
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
}
