/**
 * Résolution d'une PERSONNE — par email autant que par identifiant Slack.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POURQUOI LES DEUX ENTRÉES, ET POURQUOI C'EST UN CORRECTIF DE CÂBLAGE
 * ────────────────────────────────────────────────────────────────────────────
 * `CLAUDE.md` documente la boucle : « donne-moi son identifiant » → « je ne
 * l'ai pas ». Elle était GARANTIE par le câblage, pas probabiliste — tous les
 * outils exigeaient un UUID, aucun ne savait passer d'un email à un identifiant,
 * et `AGENT_ANTI_INVENTION_BLOCK` interdit d'en deviner un. Le correctif a été
 * d'exposer `findEmployeeByEmail` aux trois agents.
 *
 * Reproduire ici un outil à identifiant Slack obligatoire referait le même bug
 * pour la quatrième fois : un humain ne connaît pas le `U…` de ses collègues, et
 * le modèle non plus. D'où les deux clés, dans le même port.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POURQUOI UN PORT PROPRE PLUTÔT QU'UN IMPORT DE `DirectoryRepository`
 * ────────────────────────────────────────────────────────────────────────────
 * Ce port est délibérément un SOUS-ENSEMBLE STRUCTUREL de
 * `directory/domain/ports/directory.repository.ts` : un `DirectoryRepository`
 * lui est directement assignable, aucun adaptateur n'est nécessaire au câblage.
 * Mais l'inverse n'est pas vrai — et c'est tout l'intérêt. `DirectoryRepository`
 * porte `upsertFacts`, `rememberDmChannel`, `linkEmployee` et `listAll` :
 * quatre capacités d'ÉCRITURE ou de lecture GROUPÉE dont cette feature n'a
 * aucun usage. Un outil de lecture agrégée ne doit pas détenir de quoi écrire
 * dans l'annuaire, ni de quoi l'énumérer en entier.
 *
 * Même raisonnement, et mêmes mots, que `directory/domain/ports/member-source.ts`
 * à propos d'`inviteToChannel()`.
 *
 * TypeScript pur — zéro import.
 */

export interface DirectoryPerson {
  readonly slackUserId: string;
  /** Contrôlé par son porteur — jamais rendu tel quel hors du bloc non fiable. */
  readonly displayName: string;
  readonly email: string | null;

  /**
   * Canal `D…` du message direct, appris au premier DM reçu.
   *
   * `null` signifie « cette personne n'a jamais écrit au bot en direct », JAMAIS
   * « introuvable » : le canal est indécouvrable par balayage
   * (`conversations.list({types:'im'})` répond `missing_scope`, faute d'`im:read`).
   * C'est ce champ, et lui seul, qui relie une personne à sa conversation dans
   * `conversation_turns`.
   */
  readonly dmChannelId: string | null;

  readonly isBot: boolean;
  readonly isRestricted: boolean;
  readonly isUltraRestricted: boolean;
  readonly isDeleted: boolean;
}

export interface PersonDirectoryPort {
  findBySlackUserId(slackUserId: string): Promise<DirectoryPerson | null>;
  findByEmail(email: string): Promise<DirectoryPerson | null>;
}
