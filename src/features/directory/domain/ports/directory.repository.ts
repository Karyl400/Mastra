import type { DirectoryMember, DirectoryMemberFacts } from '../entities/directory-member';

/**
 * Persistance de l'annuaire des personnes.
 *
 * ⚠️ `findBySlackUserId` est appelée sur le chemin de l'ACK Slack, celui qui n'a que 3
 * secondes et qui exécute déjà la prise de clé de déduplication. Une implémentation doit s'y
 * tenir à UN aller-retour dans le cas passant.
 */
export interface DirectoryRepository {
  findBySlackUserId(slackUserId: string): Promise<DirectoryMember | null>;

  /** Sert la question que trois agents posaient à l'utilisateur faute de savoir y répondre. */
  findByEmail(email: string): Promise<DirectoryMember | null>;

  /**
   * Résout une personne par son NOM, accents et casse ignorés.
   *
   * Symétrique de `EmployeeRepository.findByName`, et volontairement identique dans son
   * contrat : une LISTE bornée, jamais un choix arbitraire entre deux homonymes. Le
   * rapprochement vit dans `src/shared/name-matching.ts`, partagé par les deux — deux
   * implémentations divergeraient au premier accent.
   *
   * ⚠️ Les bots et les comptes désactivés ne sont PAS filtrés ici : c'est une décision
   * d'appelant, et `findByEmail` ne les filtre pas davantage. Le tool les écarte.
   */
  findByName(query: string, limit: number): Promise<DirectoryMember[]>;

  /**
   * Enregistre ce que Slack vient de dire, SANS écraser ce que nous avons appris par ailleurs.
   *
   * ⚠️ CONTRAT NON NÉGOCIABLE : `dm_channel_id`, `employee_id` et `first_seen_at` ne figurent
   * pas dans `DirectoryMemberFacts` et ne doivent JAMAIS être touchés ici. Une synchronisation
   * complète repasse sur toutes les lignes ; si elle réécrivait l'enregistrement entier, chaque
   * passage effacerait le canal de DM appris au fil des messages et le rattachement à
   * l'employé — une perte muette, dans la lignée exacte de `documents.content`.
   */
  upsertFacts(facts: DirectoryMemberFacts, now: Date): Promise<void>;

  /**
   * Mémorise le canal de DM d'une personne, appris de son premier message direct.
   *
   * Idempotent, et volontairement NON destructif : un `D…` déjà connu n'est pas remplacé.
   */
  rememberDmChannel(slackUserId: string, dmChannelId: string): Promise<void>;

  /**
   * Existe-t-il au moins un dossier employé portant le rôle `manager` ?
   *
   * ⚠️ Une QUESTION, jamais une liste. La frontière n'a besoin que de savoir si la politique
   * est désignable ; rendre les identifiants exposerait qui décide, ce qui n'est utile à
   * personne sur ce chemin et renseignerait un attaquant sur la cible à viser.
   *
   * Lecture seule. Aucun chemin de ce dépôt n'ÉCRIT le rôle : il se pose délibérément, par
   * `npm run role:set`. Déclarer ici une écriture en ferait une capacité du produit, donc
   * quelque chose qu'un futur câblage pourrait brancher sans le relire.
   */
  hasManager(): Promise<boolean>;

  /**
   * Les personnes VIVANTES qui portent le rôle `manager`.
   *
   * ⚠️ Distinct de `hasManager()`, qui ne rend qu'un booléen. Les deux existent parce qu'ils
   * répondent à deux questions différentes : « la frontière est-elle applicable ? » (une
   * garde, appelée à chaque message) et « à qui écrire ? » (un envoi, rare). Faire porter les
   * deux par la même lecture ferait payer une liste à un chemin qui n'a besoin que d'un oui.
   *
   * Mêmes exclusions que la politique — ni bot, ni compte désactivé : écrire à un compte que
   * `resolveAccess` refuse serait écrire dans le vide.
   */
  findManagers(): Promise<DirectoryMember[]>;

  /** Rattache une personne à un employé enregistré. `null` détache. */
  /**
   * Rattache une ligne d'annuaire à un dossier, et rend le NOMBRE de lignes réellement
   * touchées.
   *
   * ⚠️ Le compte n'est pas un confort de journalisation — même argument que `forget(scope)`,
   * qui le rend pour la même raison. C'est un `UPDATE ... WHERE slack_user_id = ?` : si la
   * ligne n'existe pas, l'ordre réussit sans rien faire. Trouvé EN PRODUCTION le 2026-08-19,
   * en testant le correctif du matin même — il journalisait « Annuaire relié au dossier »
   * alors que zéro ligne avait bougé, ce qui est exactement la famille de défaut qu'il
   * fermait. Sans ce compte, l'appelant ne peut que réciter « c'est fait ».
   */
  linkEmployee(slackUserId: string, employeeId: string | null): Promise<number>;

  /** Tout l'annuaire, pour les usages de lecture groupée. */
  listAll(): Promise<DirectoryMember[]>;
}
