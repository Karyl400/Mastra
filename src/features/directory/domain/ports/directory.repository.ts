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
  linkEmployee(slackUserId: string, employeeId: string | null): Promise<void>;

  /** Tout l'annuaire, pour les usages de lecture groupée. */
  listAll(): Promise<DirectoryMember[]>;
}
