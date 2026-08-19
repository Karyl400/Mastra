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
