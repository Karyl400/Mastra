import type {
  SlackChannelFacts,
  SlackChannelInventoryEntry,
  SlackChannelMembership,
  SlackChannelRecord,
} from '../entities/slack-channel';

/**
 * Persistance de l'INVENTAIRE des canaux et de leurs membres observés.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠️ AUCUNE MÉTHODE DE CE PORT NE RÉPOND À UNE QUESTION D'AUTORISATION.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le nommage EST le garde-fou, et il est délibéré. On ne trouvera ici ni `canRead`, ni
 * `isAllowed`, ni `hasAccess`, ni même `isMemberOf` — pas parce que ces méthodes seraient
 * difficiles à écrire, mais parce qu'un nom qui pose une question d'autorisation obtient une
 * réponse traitée comme telle par le premier appelant venu. Les méthodes disent donc ce
 * qu'elles font : elles LISTENT ce qui a été OBSERVÉ, au passé, à une date que l'appelant peut
 * lire (`syncedAt`) et dont il doit tirer ses propres conclusions.
 *
 * La raison de fond : **aucun événement ne viendra jamais invalider ces lignes**. Les
 * abonnements de l'app N'INCLUENT ni `member_joined_channel`, ni `member_left_channel`
 * (liste faisant foi : `CLAUDE.md`, section « ABONNEMENTS » — ne pas la recopier ici, la
 * copie qui s'y trouvait était fausse). Une décision
 * d'accès prise ici serait prise sur un état que rien ne dément et que personne ne rafraîchit.
 * La feature `knowledge` interroge Slack EN DIRECT pour cette raison exacte ; ce port ne doit
 * pas devenir le raccourci qui la contourne.
 *
 * Verrouillé par `tests/unit/directory/channel-inventory-not-an-acl.test.ts`.
 *
 * ⚠️ TypeScript pur — zéro import de framework.
 */
export interface ChannelInventoryRepository {
  /**
   * Enregistre ce que Slack vient d'affirmer d'un canal.
   *
   * `memberCountReported` est écrit TEL QUEL, `null` compris : le repository ne le dérive
   * jamais du nombre de lignes de la table d'appartenances. Ce sont deux mesures d'instants
   * différents, et leur écart est le seul signal de fraîcheur de cet inventaire.
   */
  upsertChannel(facts: SlackChannelFacts, now: Date): Promise<void>;

  /**
   * REMPLACE l'ensemble des membres observés d'un canal. Ce n'est pas une fusion.
   *
   * Les membres d'un canal à l'instant T forment un ENSEMBLE, pas une accumulation : une
   * personne partie doit DISPARAÎTRE. Une implémentation qui se contenterait d'insérer ferait
   * croître la liste indéfiniment, et le `COUNT(*)` — le seul chiffre que cet inventaire existe
   * pour rendre — deviendrait un cumul historique.
   *
   * ⚠️ CONTRAT NON NÉGOCIABLE, symétrique de celui d'`upsertFacts` : `first_seen_at` SURVIT
   * pour une personne toujours présente. Le réécrire à chaque passage effacerait la seule
   * donnée que cette table accumule et que Slack ne sait pas rendre — une perte muette, dans la
   * lignée exacte de `documents.content`.
   *
   * Un ensemble vide est une valeur LÉGITIME : elle signifie « plus personne d'observé », et
   * doit vider le canal.
   */
  replaceMembers(channelId: string, slackUserIds: readonly string[], now: Date): Promise<void>;

  /** Tout l'inventaire, trié sur `channelId` — pour les rapports et le diagnostic. */
  listChannels(): Promise<SlackChannelRecord[]>;

  /**
   * Les canaux avec leur compte OBSERVÉ (`COUNT(*)`) à côté de l'assertion de Slack.
   *
   * Les deux chiffres restent séparés à dessein : les fondre supprimerait l'écart, qui est
   * l'information.
   */
  listInventory(): Promise<SlackChannelInventoryEntry[]>;

  /**
   * Les appartenances OBSERVÉES d'un canal, triées sur `slackUserId`.
   *
   * Rend les enregistrements complets — `firstSeenAt` et `syncedAt` compris — et non de simples
   * identifiants : un appelant qui ne voit pas la date d'observation ne peut pas savoir qu'il
   * lit un état ancien. C'est le contraire d'une commodité.
   */
  listObservedMembers(channelId: string): Promise<SlackChannelMembership[]>;

  /**
   * « Dans quels canaux cette personne a-t-elle été observée ? » — sert l'index sur
   * `slack_user_id`.
   *
   * ⚠️ Le nom dit « observé », au passé, et il doit le rester. `getChannelsForUser` se lirait
   * comme un droit d'accès ; celui-ci se lit comme ce qu'il est, une trace de balayage.
   */
  listChannelsObservedForUser(slackUserId: string): Promise<SlackChannelMembership[]>;
}
