import type { DirectoryMemberFacts } from '../entities/directory-member';

/**
 * Source des faits d'annuaire — ce que le monde extérieur sait des personnes.
 *
 * ⚠️ CE PORT EXISTE POUR NE PAS IMPORTER `notification`. Le fournisseur réel est
 * `SlackWorkspaceProvider`, qui vit dans la feature `notification` : l'y référencer depuis
 * `directory/application` créerait une dépendance entre deux features au niveau applicatif,
 * dans un dépôt dont c'est justement la règle structurante. La feature `document` fait
 * exactement le même choix en dupliquant le port `employee` — CLAUDE.md le documente comme
 * intentionnel : chaque feature possède ses propres ports.
 *
 * L'adaptateur qui relie les deux vit en `infrastructure`, seule couche où le croisement est
 * légitime.
 *
 * Le port est délibérément RÉDUIT à deux méthodes — celles que l'annuaire consomme. Recopier
 * les sept méthodes de `SlackWorkspaceProvider` ferait entrer ici `inviteToChannel()`, une
 * capacité d'ÉCRITURE, dans le port d'un composant dont le rôle est de lire qui est qui.
 */
export interface MemberSource {
  /**
   * Résout une personne par son identifiant Slack.
   *
   * `null` = introuvable. Ne doit PAS lever sur une simple absence : sur le chemin de l'ACK,
   * une exception pour un compte inconnu coûterait le traitement du message entier.
   */
  fetchById(slackUserId: string): Promise<DirectoryMemberFacts | null>;

  /** Balayage complet, pour la synchronisation périodique. */
  fetchAll(): Promise<DirectoryMemberFacts[]>;
}
