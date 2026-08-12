/**
 * Une personne du workspace Slack, telle que l'annuaire la connaît.
 *
 * C'est la réponse à « qui m'écrit ? » — question que le système ne savait pas poser jusqu'ici.
 * `event.user` était une chaîne `U0A1N067JGL` lue pour le journal et l'anti-boucle, puis jetée :
 * ni la politique d'autorisation, ni les agents, ni la moindre trace d'audit ne pouvaient la
 * relier à un email, à un employé, ou à un statut d'invité.
 *
 * ⚠️ TypeScript pur — aucun import de framework. Cette entité traverse la couche `domain`.
 */
export interface DirectoryMember {
  /** Identifiant Slack `U…`. IMMUABLE pour la vie du compte : c'est la clé, pas l'email. */
  readonly slackUserId: string;
  readonly teamId: string;

  /** `null` sur les comptes sans adresse (bots) ou si `users:read.email` venait à manquer. */
  readonly email: string | null;
  readonly realName: string;
  readonly displayName: string;
  /** Voir `DirectoryMemberFacts` : lus dans le profil Slack, jamais dérivés de `realName`. */
  readonly firstName: string | null;
  readonly lastName: string | null;
  /** `profile.title` — le poste DÉCLARÉ dans Slack, distinct de `employees.position`. */
  readonly title: string | null;

  readonly isBot: boolean;
  readonly isAdmin: boolean;
  /** Invité multi-canal. */
  readonly isRestricted: boolean;
  /** Invité mono-canal. */
  readonly isUltraRestricted: boolean;
  readonly isDeleted: boolean;

  /**
   * Canal `D…` du message direct, appris au premier DM reçu.
   *
   * Il ne peut PAS être découvert par balayage : `conversations.list({ types: 'im' })` répond
   * `missing_scope` faute du scope `im:read` (vérifié le 2026-08-12). `null` signifie donc
   * « cette personne ne nous a jamais écrit en direct », jamais « introuvable ».
   */
  readonly dmChannelId: string | null;

  /** `employees.id`, quand la personne est un employé enregistré. */
  readonly employeeId: string | null;

  readonly firstSeenAt: Date;
  /** Dernière confirmation par Slack de ces valeurs. */
  readonly syncedAt: Date;
}

/**
 * Ce que Slack nous apprend d'une personne, indépendamment de ce que la base en sait déjà.
 *
 * Distinct de `DirectoryMember` À DESSEIN : `dmChannelId`, `employeeId` et `firstSeenAt` sont
 * des faits que NOUS accumulons et que Slack ignore. Les fondre dans un seul type ferait
 * qu'une synchronisation, en réécrivant l'enregistrement, effacerait le canal de DM appris et
 * le rattachement à l'employé — une perte silencieuse, exactement le mode d'échec que ce dépôt
 * a déjà payé avec `documents.content`.
 */
export interface DirectoryMemberFacts {
  readonly slackUserId: string;
  readonly teamId: string;
  readonly email: string | null;
  readonly realName: string;
  readonly displayName: string;
  /**
   * Prénom, nom et poste — lus TELS QUELS dans `profile.first_name`, `profile.last_name` et
   * `profile.title`, jamais dérivés de `realName`.
   *
   * C'est le point. Découper « Karyl SOUMAILA » sur l'espace marche ; découper
   * `ridwanenico77` — un profil réel de ce workspace, dont le nom n'est que le pseudo — donne
   * un prénom qui n'en est pas un et un nom vide. Une heuristique qui échoue sur un cas sur
   * cinq n'est pas une heuristique, c'est une invention. Slack porte ces trois champs
   * séparément : on les lit.
   *
   * `null` signifie « Slack ne le précise pas », et c'est une réponse. Slack rend `''` pour un
   * champ non renseigné (le titre de Mistourath IDI, par exemple) ; on normalise en `null`
   * parce que `synced_at` prouve qu'on a bien interrogé — l'absence est donc AVÉRÉE, pas
   * inconnue.
   */
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly title: string | null;
  readonly isBot: boolean;
  readonly isAdmin: boolean;
  readonly isRestricted: boolean;
  readonly isUltraRestricted: boolean;
  readonly isDeleted: boolean;
}
