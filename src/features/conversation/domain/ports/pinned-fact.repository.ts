/**
 * Mémoire LONGUE : les faits qu'une personne a explicitement demandé de retenir.
 *
 * ── Pourquoi un port distinct de `ConversationRepository` ───────────────────
 * Les deux stockent du texte d'une personne, et c'est leur seul point commun. `conversation`
 * est une FENÊTRE : TTL de 60 minutes, éviction par budget de tokens, purge opportuniste —
 * tout y est destiné à disparaître. Ici, rien ne disparaît sans une demande explicite.
 *
 * Fondre les deux derrière un drapeau `pinned` aurait mis deux durées de vie opposées sous
 * la même purge, avec un `WHERE pinned = 0` qu'un futur correctif finirait par oublier une
 * fois. La séparation rend l'invariant structurel plutôt que conventionnel.
 *
 * ── La clé est la PERSONNE, pas la conversation ─────────────────────────────
 * « mon poste est Backend Developer » vaut dans tous les fils. C'est aussi ce qui permet à
 * l'effacement de les emporter par la même clé, quel que soit l'endroit où il est demandé.
 */
export interface PinnedFact {
  readonly id: string;
  readonly slackUserId: string;
  /** Texte D'ORIGINE de la personne, assaini. Jamais normalisé ni reformulé. */
  readonly fact: string;
  readonly createdAt: Date;
}

export interface PinnedFactRepository {
  /** Les faits d'une personne, du plus ancien au plus récent, bornés à `limit`. */
  list(slackUserId: string, limit: number): Promise<PinnedFact[]>;

  /**
   * Épingle un fait, en évinçant le plus ancien si le plafond est atteint.
   *
   * L'éviction fait PARTIE du contrat, elle n'est pas laissée à l'appelant : c'est elle qui
   * garantit que le préambule système ne grossit jamais, et un appelant qui l'oublierait ne
   * s'en apercevrait qu'au sixième fait.
   */
  pin(fact: PinnedFact, max: number): Promise<void>;

  /** Efface tous les faits d'une personne. Rend le nombre de lignes supprimées. */
  forget(slackUserId: string): Promise<number>;
}
