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

  /**
   * @param threadTs répond DANS le fil plutôt qu'à la racine du canal.
   *
   * ⚠️ Ajouté le 2026-08-18, sur un commentaire qui mentait. `replyInThread` (route
   * d'interactivité) annonçait « répond dans le fil de la carte — jamais à la racine, la
   * carte y serait orpheline » et appelait cette méthode, qui n'avait aucun moyen de
   * threader. Le `thread_ts` était même déclaré dans le type du payload Slack et lu nulle
   * part. Résultat : « C'est envoyé à … » atterrissait à la racine du canal, détaché de la
   * carte qu'il confirme.
   *
   * Optionnel, et non un second paramètre obligatoire : en DM on ne threade délibérément
   * PAS — threader un DM enfouit le message hors de la conversation principale, ce qui a
   * déjà fait paraître ce bot muet pendant des heures.
   */
  /**
   * ⚠️ Rend le CANAL RÉELLEMENT UTILISÉ, et ce retour porte un correctif du 2026-08-19.
   *
   * Quand `channelId` est un identifiant d'UTILISATEUR (`U…`), Slack ouvre lui-même la
   * conversation directe et le message atterrit dans un canal `D…` que l'appelant ne connaît
   * pas. C'est exactement ce qui a cassé l'entretien conversationnel à sa première mise en
   * production : la route posait la question à `U…`, le handler cherchait l'état dans la
   * mémoire de la conversation `D…`, et les deux ne se rencontraient jamais. Le symptôme est
   * trompeur — la question s'affiche bien, seule la RÉPONSE part chez l'agent.
   *
   * On rend donc ce que Slack a décidé, plutôt que ce qu'on lui a demandé. Sans ce retour, la
   * seule alternative serait un `conversations.open` de plus, payé à chaque envoi.
   */
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

  /**
   * Réécrit un message déjà posté — c'est ce qui NEUTRALISE un bouton après son premier clic.
   *
   * ⚠️ La capacité était décrite depuis l'origine dans le commentaire de `sendBlocks` (« le
   * `ts` permet de mettre le message à jour par la suite ») et n'avait jamais été câblée : la
   * carte d'invitation d'entretien restait entièrement cliquable, y compris après « Annuler »
   * et après un envoi réussi. Sur la seule action irréversible de ce système — un email à un
   * candidat — cela signifiait deux invitations pour deux clics.
   *
   * ⚠️ `blocks` REMPLACE les blocs existants : passer un tableau sans bloc `actions` est ce
   * qui fait disparaître les boutons. Le `text` de repli doit rester non vide pour la même
   * raison que dans `sendBlocks`.
   */
  async updateMessage(
    channelId: string,
    ts: string,
    text: string,
    blocks: SlackBlock[],
  ): Promise<void> {
    await this.slack.chat.update({ channel: channelId, ts, text, blocks });
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
   * Le scope `files:write` **est accordé** — vérifié en production le 2026-08-11, un PDF
   * réellement posté (`hasPermalink: true`). La branche `missing_scope` ci-dessous n'est
   * donc plus le cas nominal, mais elle reste : une réinstallation de l'app peut à tout
   * moment repartir sur un jeu de scopes plus étroit, et son message nomme alors les DEUX
   * gestes requis. Ajouter le scope dans la console ne suffit en effet pas — le jeton du
   * workspace conserve les scopes de l'installation en cours, seule une réinstallation les
   * propage. C'est le piège qui a coûté plusieurs heures le 2026-08-08, manifeste conforme
   * et installation périmée.
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
