/**
 * L'INVENTAIRE DES CANAUX — ce que le bot observe des canaux où il se trouve.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠️ CE MODÈLE EST UN INVENTAIRE D'OBSERVABILITÉ. IL N'EST JAMAIS UNE SOURCE
 *    D'AUTORISATION. LE LIRE COMME UNE ACL EST UN BUG DE SÉCURITÉ.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * La demande d'origine est de l'inventaire pur : « pour les canaux où le bot est invité, je veux
 * l'ID du canal, le nombre de personnes et les membres ». Le piège est que le résultat
 * RESSEMBLE à une liste d'autorisation — « les membres de #engineer-karyl » se lit sans effort
 * comme « qui a le droit de voir #engineer-karyl ». Or `#engineer-karyl` est PRIVÉ, et servir
 * son contenu à un non-membre sur la foi de ces lignes est exactement le « deputy confus » de
 * `PLAN-ARCHITECTURE.md` §4.1 — que la feature `knowledge` ferme, elle, en interrogeant Slack
 * EN DIRECT à chaque décision de divulgation.
 *
 * L'aggravant est vérifié, pas supposé : **il n'existe aucun chemin d'invalidation**. Les
 * abonnements de l'app sont `app_mention`, `message.im`, `message.channels`, `message.groups` —
 * ni `member_joined_channel`, ni `member_left_channel`. Aucun événement Slack ne viendra jamais
 * démentir une ligne d'ici. Ces données ne sont donc pas « périmées dans trois jours » : elles
 * sont fausses, et silencieuses, dès la première personne qui quitte un canal entre deux
 * synchronisations manuelles. Une donnée fausse et muette employée comme frontière de sécurité
 * est pire que pas de frontière du tout — c'est la leçon d'`emailSent: false` sous
 * `status: 'success'`, transposée à l'autorisation.
 *
 * La règle est rendue EXÉCUTABLE, et non recommandée :
 * `tests/unit/directory/channel-inventory-not-an-acl.test.ts` échoue si `knowledge/**`,
 * `access-policy.ts` ou `access-guard.ts` importent ce modèle ou son repository.
 *
 * ⚠️ TypeScript pur — zéro import de framework. Cette couche est verrouillée par
 * `tests/unit/quality/architecture.test.ts`.
 */

/**
 * Un canal, tel que l'inventaire le connaît à sa dernière synchronisation.
 *
 * `channelId` et non `name` comme identité : un canal se renomme sans que son `C…` bouge.
 */
export interface SlackChannelRecord {
  readonly channelId: string;
  readonly name: string;
  readonly isPrivate: boolean;
  readonly isArchived: boolean;
  /** `true` = le bot est dedans. C'est ce que `chat.postMessage` exige, rien de plus. */
  readonly isMember: boolean;

  /**
   * ⚠️ ASSERTION DE SLACK (`conversations.list` → `num_members`), et non un cache du nombre de
   * lignes de `slack_channel_members`.
   *
   * Les deux chiffres viennent d'appels DISTINCTS, donc d'instants distincts, et divergent
   * normalement. Le vrai compte est celui des membres observés ; l'écart entre les deux est un
   * signal de fraîcheur gratuit. `null` = Slack n'a rien affirmé (fréquent sur les canaux
   * privés) — ce qu'un `0`, indiscernable d'un canal vide, ne dirait pas.
   */
  readonly memberCountReported: number | null;

  readonly syncedAt: Date;
}

/**
 * Ce que Slack affirme d'un canal, indépendamment de ce que la base en sait déjà.
 *
 * Distinct de `SlackChannelRecord` pour la même raison que `DirectoryMemberFacts` l'est de
 * `DirectoryMember` : `syncedAt` est un fait de NOTRE processus, pas du sien.
 */
export interface SlackChannelFacts {
  readonly channelId: string;
  readonly name: string;
  readonly isPrivate: boolean;
  readonly isArchived: boolean;
  readonly isMember: boolean;
  readonly memberCountReported: number | null;
}

/**
 * Une appartenance OBSERVÉE : cette personne était dans ce canal lors de la dernière passe.
 *
 * Le temps passé est la formulation exacte, et il est volontaire. Cet objet ne dit pas
 * « appartient », il dit « a été vu appartenant à l'instant `syncedAt` ».
 */
export interface SlackChannelMembership {
  readonly channelId: string;
  readonly slackUserId: string;
  /** Première observation. SURVIT aux resynchronisations d'une personne toujours présente. */
  readonly firstSeenAt: Date;
  /** Dernière observation. Une valeur ancienne = la personne n'a pas été revue. */
  readonly syncedAt: Date;
}

/**
 * Le compte OBSERVÉ d'un canal, avec l'assertion de Slack à côté — jamais fondus.
 *
 * Les fusionner en un seul nombre détruirait le seul signal de fraîcheur dont dispose une table
 * qu'aucun événement ne viendra jamais démentir.
 */
export interface SlackChannelInventoryEntry {
  readonly channel: SlackChannelRecord;
  /** `COUNT(*)` sur les appartenances observées. LE compte. */
  readonly observedMemberCount: number;
}
