/**
 * Lecture de la MÉMOIRE PROPRE DU BOT — première des deux sources de la feature.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * CE QUE CETTE SOURCE EST, ET CE QU'ELLE N'EST PAS
 * ────────────────────────────────────────────────────────────────────────────
 * C'est la table `conversation_turns`, déjà en production sur la Turso :
 * l'historique des échanges bot ↔ humain, déjà ASSAINI à l'écriture (le tour
 * `user` est écrit après `wrapAgentInput`, le tour `assistant` après
 * `sanitizeAgentOutput`). Ce n'est PAS un index, PAS une copie, PAS une
 * ingestion : rien n'est écrit ici, on relit ce que le bot a déjà mémorisé pour
 * son propre fonctionnement.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠️ POURQUOI CE PORT NE SAIT LIRE QU'UNE CONVERSATION EN MESSAGE DIRECT
 * ────────────────────────────────────────────────────────────────────────────
 * `deriveConversationId` vaut `threadTs ? \`${channel}:${threadTs}\` : channel`.
 * La table contient donc DEUX natures de conversations : les DM (`D…`) et les
 * fils de canal (`C…:1734…`). Une méthode « tous les tours de cette personne »
 * ramènerait les deux — et les seconds sont du contenu de CANAL, soumis à l'ACL
 * du canal. Elle rouvrirait le deputy confus de §4.1 par la porte de derrière,
 * en contournant le contrôle d'appartenance qui protège l'autre source.
 *
 * Le port est donc réduit à la lecture d'un canal `D…`, et le contrôle est
 * structurel plutôt que rédactionnel : ce qu'on ne peut pas demander ne fuite
 * pas. Le contenu des fils de canal reste accessible — par `getChannelHistory`,
 * qui vérifie l'appartenance.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POURQUOI ON NE RÉUTILISE PAS `ConversationRepository`
 * ────────────────────────────────────────────────────────────────────────────
 * Il porte `append()` et `prune()` — une capacité d'ÉCRITURE et une capacité de
 * SUPPRESSION — dans le port d'un composant dont le rôle est de lire. C'est
 * l'argument exact de `directory/domain/ports/member-source.ts`, qui réduit
 * `SlackWorkspaceProvider` à deux méthodes pour ne pas faire entrer
 * `inviteToChannel()` dans un annuaire. Chaque feature possède ses ports —
 * `CLAUDE.md` documente cette duplication comme intentionnelle.
 *
 * TypeScript pur — zéro import.
 */

export type BotMemoryRole = 'user' | 'assistant';

export interface BotMemoryTurn {
  readonly role: BotMemoryRole;
  readonly text: string;
  /** `null` sur un tour `assistant`, qui n'émane d'aucun humain. */
  readonly slackUserId: string | null;
  readonly at: Date;
}

export interface BotMemoryReadOptions {
  /** Profondeur : on ignore tout ce qui est plus ancien. Voir `retrieval-window.ts`. */
  readonly sinceMs: number;
  /** Garde-fou de REQUÊTE — jamais un paramètre de schéma de tool. */
  readonly limit: number;
}

export interface BotMemoryReadPort {
  /**
   * Les tours d'une conversation en message direct, du plus ancien au plus
   * récent, dans la fenêtre demandée.
   *
   * ⚠️ CONTRAT : `dmChannelId` DOIT être un canal `D…`. Une implémentation qui
   * accepterait une clé de fil (`C…:1734…`) contournerait la restriction
   * ci-dessus ; le tool le vérifie de son côté, mais un port qui n'énonce pas
   * son invariant finit par être appelé sans lui.
   *
   * Rendre `[]` sur une conversation inconnue — jamais lever. Une mémoire
   * indisponible dégrade en « je n'ai rien retrouvé », elle ne casse pas la
   * réponse (même doctrine que la mémoire conversationnelle elle-même).
   */
  recentDirectTurns(dmChannelId: string, options: BotMemoryReadOptions): Promise<BotMemoryTurn[]>;
}
