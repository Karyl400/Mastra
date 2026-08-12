/**
 * Lecture de l'HISTORIQUE D'UN CANAL — seconde source de la feature.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DEUX MÉTHODES, ET L'ORDRE ENTRE ELLES EST LA SÉCURITÉ
 * ────────────────────────────────────────────────────────────────────────────
 * `isMember` répond à « le DEMANDEUR a-t-il le droit ? », `fetchRecent` à
 * « qu'y a-t-il dedans ? ». Les deux sont séparées pour que l'appelant ne puisse
 * pas obtenir le contenu sans avoir posé la question d'autorisation : une
 * méthode unique `fetchIfAllowed()` serait plus courte, mais le jour où
 * quelqu'un ajoute un second chemin de lecture, il n'aurait plus de raison
 * structurelle de vérifier quoi que ce soit.
 *
 * ⚠️ `isMember` porte sur le DEMANDEUR, jamais sur le bot. L'appartenance du bot
 * n'est pas un droit : c'est une condition de faisabilité, et elle se manifeste
 * comme une INDISPONIBILITÉ (`bot_not_in_channel`), jamais comme une
 * autorisation. Confondre les deux est exactement le deputy confus de §4.1.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POURQUOI UNE ERREUR TYPÉE PLUTÔT QU'UN `null`
 * ────────────────────────────────────────────────────────────────────────────
 * « Le canal est vide », « le bot n'y est pas » et « Slack est en panne » sont
 * trois situations qui appellent trois phrases différentes de la part de l'agent
 * — et une seule des trois appelle un geste humain. Les fondre dans un `null`
 * reproduirait le défaut corrigé sur `getTaskList`, où `{tasks: []}` était
 * indiscernable d'un employé introuvable et faisait affirmer « aucune tâche en
 * cours » pour un identifiant qui ne désignait personne.
 *
 * TypeScript pur — zéro import.
 */

export interface ChannelMessage {
  /** `U…` de l'auteur, ou `null` (message d'application, message système). */
  readonly authorId: string | null;
  /**
   * Nom d'affichage résolu, ou l'identifiant à défaut.
   *
   * ⚠️ Contrôlé par son porteur — borné et nettoyé par `excerpt-budget.ts`, puis
   * transporté À L'INTÉRIEUR du bloc de données non fiables.
   */
  readonly authorLabel: string;
  readonly text: string;
  readonly at: Date;
  readonly isBot: boolean;
}

export type ChannelUnavailableReason =
  /** Le bot n'est pas membre : `chat`/`history` refusés. Geste humain requis (invitation). */
  | 'bot_not_in_channel'
  /** L'identifiant ne désigne aucun canal — typiquement un nom pris pour un ID. */
  | 'channel_not_found'
  /** Panne, quota, réseau. Réessayer a un sens. */
  | 'unavailable';

/**
 * Indisponibilité de la source, distincte d'un refus d'autorisation.
 *
 * On ne dit JAMAIS à l'utilisateur laquelle des deux s'est produite pour un
 * canal auquel il n'a pas droit : l'autorisation est vérifiée AVANT toute
 * lecture, donc cette erreur ne peut survenir que sur un canal dont il est déjà
 * membre. Sans cet ordre, `channel_not_found` deviendrait un oracle d'existence
 * de canaux privés.
 */
export class ChannelUnavailableError extends Error {
  constructor(
    readonly reason: ChannelUnavailableReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ChannelUnavailableError';
  }
}

export interface ChannelHistoryReadOptions {
  readonly sinceMs: number;
  readonly limit: number;
}

export interface ChannelHistoryPort {
  /**
   * Le DEMANDEUR est-il membre de ce canal ?
   *
   * Rend `false` — jamais une exception — quand le canal est inconnu ou que le
   * bot n'y a pas accès : dans les deux cas le demandeur n'a rien à obtenir, et
   * distinguer les motifs ici renseignerait sur l'existence de canaux privés.
   */
  isMember(channelId: string, slackUserId: string): Promise<boolean>;

  /** Lève `ChannelUnavailableError` si la source est inaccessible. */
  fetchRecent(channelId: string, options: ChannelHistoryReadOptions): Promise<ChannelMessage[]>;
}
