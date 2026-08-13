import type {
  ChannelInviteResult,
  ChannelInviteStatus,
  WelcomeChannelRef,
  WelcomeChannelSource,
} from '../../application/services/welcome-channels.service';

/**
 * Le pont entre `WelcomeChannelsService` (qui ne connaît pas Slack) et `SlackWorkspaceService`
 * (qui ne connaît que lui). Rien d'autre : pas une décision, pas une politique.
 *
 * Il vit en `infrastructure` pour la même raison que `SlackChannelAccess` et
 * `SlackMemberSource` — c'est la seule couche où deux features peuvent se croiser.
 *
 * ⚠️ Les deux méthodes Slack qu'il enveloppe ont des CONVENTIONS D'ÉCHEC OPPOSÉES, et c'est
 * la raison d'être de ce fichier :
 *   - `joinChannel` ne lève jamais : chaque refus est déjà un état nommé (`SlackJoinOutcome`) ;
 *   - `inviteToChannel` rend `void` et LÈVE, le code d'erreur étant enfoui dans l'exception.
 * Les faire remonter sous un vocabulaire unique est exactement ce que le service attend pour
 * n'avoir qu'un seul `switch` à lire.
 */

/**
 * Le strict nécessaire côté Slack.
 *
 * On ne dépend PAS de `SlackWorkspaceProvider` entier : ses sept méthodes n'ont ici aucun
 * usage, et une dépendance large obligerait toute doublure de test à simuler une API dont ce
 * composant n'a que faire. `SlackWorkspaceService` satisfait cette interface structurellement.
 */
export interface SlackInviteClient {
  listChannels(): Promise<readonly { id: string; name: string }[]>;
  inviteToChannel(channelId: string, userId: string): Promise<void>;
  joinChannel(channelId: string): Promise<{ status: string; error?: string }>;
}

/**
 * Codes d'erreur Slack traduits en états NOMMÉS.
 *
 * Liste FERMÉE : tout code absent devient `failed`, message conservé. Une traduction par défaut
 * optimiste ferait passer un refus inconnu pour un succès — exactement le mode d'échec de
 * `status = Sent` posé avant le `try`.
 */
const STATUS_BY_SLACK_ERROR: ReadonlyMap<string, ChannelInviteStatus> = new Map([
  ['already_in_channel', 'already_in_channel'],
  // Slack rend `cant_invite_self` quand la cible est le bot lui-même : le résultat visé
  // (« la personne est dans le canal ») est atteint, donc ce n'est pas un échec.
  ['cant_invite_self', 'already_in_channel'],
  ['not_in_channel', 'bot_not_in_channel'],
  ['channel_not_found', 'channel_not_found'],
  ['missing_scope', 'missing_scope'],
  ['not_allowed_token_type', 'missing_scope'],
]);

/**
 * `SlackJoinOutcome.status` traduit dans le vocabulaire du service.
 *
 * `not_public` et `archived` deviennent `channel_not_found` : du point de vue de l'accueil,
 * un canal que le bot ne peut pas rejoindre et un canal qui n'existe pas produisent le même
 * fait — l'arrivant n'y entrera pas — et le message d'erreur conserve la cause exacte.
 */
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
      // Le contrat dit « ne lève jamais » ; on ne le suppose pas pour autant. Une exception
      // qui traverserait ce point ferait échouer l'accueil entier d'un arrivant.
      return classify(error);
    }
  }
}

/**
 * Le code d'erreur Slack, lu d'abord dans `error.data.error` (forme du SDK), puis dans le
 * message.
 *
 * La seconde lecture n'est pas un luxe : `SlackWorkspaceService` réemballe certaines erreurs en
 * `Error` de prose, et le champ `data` disparaît alors. Sans elle, un `not_in_channel`
 * réemballé compterait pour un échec définitif au lieu de déclencher le rattrapage par `join`.
 */
function classify(error: unknown): ChannelInviteResult {
  const message = error instanceof Error ? error.message : String(error);
  const fromData = (error as { data?: { error?: unknown } } | null)?.data?.error;
  const code = typeof fromData === 'string' ? fromData : undefined;

  if (code) {
    const status = STATUS_BY_SLACK_ERROR.get(code);
    if (status) return { status, error: message };
  }

  for (const [slackError, status] of STATUS_BY_SLACK_ERROR) {
    if (message.includes(slackError)) return { status, error: message };
  }

  return { status: 'failed', error: message };
}
