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

/**
 * `ViewsOpenArguments['view']` est l'union `HomeView | ModalView | WorkflowStepView`.
 * On la restreint à la modale : `HomeView` ne porte ni `title` ni `submit`, donc
 * l'union brute rend ces champs inaccessibles au typage alors qu'ils sont
 * obligatoires ici.
 */
export type SlackModalView = Extract<ViewsOpenArguments['view'], { type: 'modal' }>;

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

/**
 * Extrait le permalink du retour de `files.uploadV2` — DÉFENSIVEMENT.
 *
 * Trois raisons de ne jamais y laisser d'accès direct :
 *
 * 1. **La forme n'est pas celle de la v1.** `files.upload` rendait un unique
 *    objet `file`. La v2 est un enrobage client (`WebClient.filesUploadV2` :
 *    `getUploadURLExternal` → PUT → `completeUploadExternal`) qui rend
 *    `{ ok: true, files: [<réponse completeUploadExternal>, …] }`, chaque réponse
 *    portant à son tour son propre tableau `files`. Le permalink est donc
 *    DOUBLEMENT imbriqué : `res.files[0].files[0].permalink`.
 * 2. **Le typage installé ne le dit pas.** `client.files.uploadV2` est déclaré
 *    `MethodWithRequiredArgument<FilesUploadV2Arguments, WebAPICallResult>`
 *    (@slack/web-api 8.0.0, `dist/methods.d.ts`), soit `{ ok, response_metadata? }` :
 *    le champ `files` n'existe pas pour TypeScript. Seule la méthode privée
 *    `WebClient.filesUploadV2()` porte le type riche. On lit donc depuis `unknown`.
 * 3. **Le fichier est livré même sans permalink.** Faire lever ici transformerait
 *    une livraison réussie en échec — le lien est un confort, pas la livraison.
 */
function extractPermalink(response: unknown): string | undefined {
  const completions = (response as { files?: unknown } | null | undefined)?.files;
  if (!Array.isArray(completions)) return undefined;

  for (const completion of completions) {
    // Repli sur un permalink posé à plat, au cas où le SDK aplatirait la réponse
    // dans une version ultérieure.
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

  /**
   * Livre un fichier dans un canal ou dans un fil, et rend son permalink.
   *
   * ⚠️ **Le scope `files:write` n'est PAS accordé au bot aujourd'hui.** Cet appel
   * échoue donc avec `missing_scope` tant qu'un humain n'est pas intervenu — et
   * ajouter le scope dans la console ne suffit pas : le jeton du workspace
   * conserve le jeu de scopes de l'installation en cours, seule une
   * réinstallation le propage. C'est exactement le piège qui a coûté plusieurs
   * heures le 2026-08-08, où le manifeste était conforme mais l'installation
   * périmée. Le message d'erreur nomme donc les DEUX gestes.
   *
   * On ne dégrade pas ici : l'erreur remonte à l'appelant, à qui il revient de
   * choisir un repli (email) ou de rendre `delivery: 'failed'`. Un adaptateur qui
   * avalerait l'échec ferait croire à une livraison qui n'a pas eu lieu.
   */
  async uploadFile(input: FileUploadInput): Promise<{ permalink?: string }> {
    const { channel, threadTs, bytes, filename, title, initialComment } = input;

    // `channel_id` et non `channels` : la v2 a déprécié `channels`, qui ne
    // supporte plus la liste séparée par des virgules et déclenche un warning.
    // Les deux formes de destination sont construites séparément parce que le
    // typage les modélise en union discriminée (`thread_ts?: never` hors fil) :
    // un `thread_ts: undefined` répandu par spread casserait la résolution.
    const destination = threadTs
      ? { channel_id: channel, thread_ts: threadTs }
      : { channel_id: channel };

    const args: FilesUploadV2Arguments = {
      ...destination,
      // Le SDK n'accepte pas un `Uint8Array` nu : `Buffer | Stream | string`, où
      // une chaîne serait interprétée comme un CHEMIN à lire sur le disque —
      // inutilisable sur Vercel, dont le FS est en lecture seule hors `/tmp`.
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
