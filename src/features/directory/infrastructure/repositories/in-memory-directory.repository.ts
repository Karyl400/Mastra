import type { DirectoryMember, DirectoryMemberFacts } from '../../domain/entities/directory-member';
import type { DirectoryRepository } from '../../domain/ports/directory.repository';
import { matchesName } from '../../../../shared/name-matching';

/**
 * Doublure de test du `DirectoryRepository`. Même contrat et même sémantique que
 * l'implémentation Drizzle — c'est elle qui sert de doublure aux tests de la politique d'accès
 * et des handlers, on ne mocke jamais Drizzle à la main.
 *
 * ⚠️ Elle doit reproduire EXACTEMENT la non-destruction de `upsertFacts` et de
 * `rememberDmChannel`. Une doublure plus permissive validerait en test un comportement que la
 * production n'a pas, et le défaut qu'elle laisserait passer — l'effacement muet du canal de DM
 * à chaque synchronisation — est précisément celui que ce port existe pour interdire. Les deux
 * implémentations sont donc exercées par la MÊME suite de tests.
 */
export class InMemoryDirectoryRepository implements DirectoryRepository {
  private rows = new Map<string, DirectoryMember>();

  async findBySlackUserId(slackUserId: string): Promise<DirectoryMember | null> {
    return this.rows.get(slackUserId) ?? null;
  }

  /**
   * Égalité stricte d'abord, repli insensible à la casse ensuite — dans cet ORDRE, comme côté
   * SQL. L'ordre est observable dès qu'une base contient deux adresses ne différant que par la
   * casse : l'exacte doit gagner.
   */
  async findByEmail(email: string): Promise<DirectoryMember | null> {
    const needle = email.trim();
    if (!needle) return null;

    for (const member of this.rows.values()) {
      if (member.email === needle) return member;
    }

    const lowered = needle.toLowerCase();
    for (const member of this.rows.values()) {
      if (member.email !== null && member.email.toLowerCase() === lowered) return member;
    }

    return null;
  }

  /**
   * ⚠️ LE POINT CRITIQUE — les trois champs que Slack ignore sont REPRIS de la ligne existante :
   * `dmChannelId`, `employeeId` et `firstSeenAt`. Écrire `{ ...facts, ...}` sans eux les
   * remettrait à leur valeur d'insertion à chaque synchronisation, ce que le port interdit.
   */
  async upsertFacts(facts: DirectoryMemberFacts, now: Date): Promise<void> {
    const previous = this.rows.get(facts.slackUserId);

    this.rows.set(facts.slackUserId, {
      slackUserId: facts.slackUserId,
      teamId: facts.teamId,
      email: facts.email,
      realName: facts.realName,
      displayName: facts.displayName,
      firstName: facts.firstName,
      lastName: facts.lastName,
      title: facts.title,
      isBot: facts.isBot,
      isAdmin: facts.isAdmin,
      isRestricted: facts.isRestricted,
      isUltraRestricted: facts.isUltraRestricted,
      isDeleted: facts.isDeleted,

      // Faits que NOUS accumulons — jamais réécrits par une synchronisation.
      dmChannelId: previous?.dmChannelId ?? null,
      employeeId: previous?.employeeId ?? null,
      firstSeenAt: previous?.firstSeenAt ?? now,

      syncedAt: now,
    });
  }

  /** Non destructif : un `D…` déjà connu n'est pas remplacé. Personne inconnue = sans effet. */
  async rememberDmChannel(slackUserId: string, dmChannelId: string): Promise<void> {
    const existing = this.rows.get(slackUserId);
    if (!existing || existing.dmChannelId !== null) return;

    this.rows.set(slackUserId, { ...existing, dmChannelId });
  }

  /** Destructif à dessein : `null` DÉTACHE. Personne inconnue = sans effet, comme l'`UPDATE`. */
  async linkEmployee(slackUserId: string, employeeId: string | null): Promise<void> {
    const existing = this.rows.get(slackUserId);
    if (!existing) return;

    this.rows.set(slackUserId, { ...existing, employeeId });
  }

  /** Trié sur la clé, comme l'`ORDER BY` de l'implémentation Drizzle. */
  /** Même rapprochement que la production — le module partagé est le seul juge. */
  async findByName(query: string, limit: number): Promise<DirectoryMember[]> {
    if (limit <= 0) return [];

    return Array.from(this.rows.values())
      .sort((a, b) => compareBinary(a.slackUserId, b.slackUserId))
      .filter((m) => matchesName(query, [m.firstName, m.lastName, m.displayName, m.realName]))
      .slice(0, limit);
  }

  async listAll(): Promise<DirectoryMember[]> {
    return Array.from(this.rows.values()).sort((a, b) =>
      compareBinary(a.slackUserId, b.slackUserId),
    );
  }

  /** Confort de test : vide l'annuaire entre deux cas. */
  clear(): void {
    this.rows.clear();
  }
}

/**
 * Comparaison BINAIRE, celle de l'`ORDER BY` de SQLite sur une colonne `text`.
 * `localeCompare` s'en écarterait — et deux implémentations qui trient différemment finiraient
 * par faire diverger un test de la production sur un détail que personne ne relit.
 */
function compareBinary(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
