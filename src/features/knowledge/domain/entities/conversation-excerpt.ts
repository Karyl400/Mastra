/**
 * Un extrait de conversation — l'unité que la feature `knowledge` sait rendre.
 *
 * ── Pourquoi un type COMMUN aux deux sources ────────────────────────────────
 * Les deux sources de la feature n'ont rien en commun techniquement : la mémoire
 * propre du bot est une table Turso (`conversation_turns`), l'historique de canal
 * est un appel `conversations.history`. Les laisser voyager sous leurs formes
 * natives jusqu'au tool obligerait à écrire DEUX projections, donc deux budgets,
 * donc deux endroits où la borne de coût peut être oubliée. Ce dépôt a déjà payé
 * trois fois ce défaut (`getEmployeeProfile`, `generateDocument`,
 * `getNotificationHistory`) : la borne doit vivre à UN seul endroit, et cet
 * endroit ne peut exister que si les deux sources se ramènent au même type.
 *
 * ⚠️ TypeScript pur — aucun import, pas même relatif. La couche `domain` ne
 * dépend de rien (verrouillé par `tests/unit/quality/architecture.test.ts`).
 */

export type ExcerptSource = 'bot_memory' | 'channel';

export interface ConversationExcerpt {
  readonly source: ExcerptSource;

  /**
   * Étiquette de l'auteur : nom d'affichage résolu, ou identifiant `U…` à défaut.
   *
   * ⚠️ DONNÉE CONTRÔLÉE PAR SON PORTEUR — un nom d'affichage Slack se change en
   * deux clics, et c'est un vecteur d'injection de premier ordre (le dépôt le
   * traite déjà ainsi via `sanitizeDisplayName` pour le préambule d'identité).
   * Elle est bornée et nettoyée par `excerpt-budget.ts`, puis part à l'intérieur
   * du bloc de données non fiables — jamais dans un champ de tête du tool-result.
   */
  readonly speaker: string;

  /** Texte du message, tel que la source l'a rendu. Borné et nettoyé à la projection. */
  readonly text: string;

  /** Instant du message. Sert le TRI, avant que la projection ne le formate. */
  readonly at: Date;
}
