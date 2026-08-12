import type {
  BotMemoryReadOptions,
  BotMemoryReadPort,
  BotMemoryTurn,
} from '../../domain/ports/bot-memory.repository';

/**
 * Doublure du `BotMemoryReadPort`.
 *
 * ⚠️ Elle reproduit les DEUX invariants de l'implémentation Drizzle, et pas
 * seulement le contrat nominal :
 *
 *   • le refus d'une clé qui n'est pas un `D…` — une doublure plus permissive
 *     validerait en test un comportement que la production n'a pas, et le défaut
 *     qu'elle laisserait passer est précisément celui que ce port existe pour
 *     interdire ;
 *   • la sélection des tours les plus RÉCENTS, rendus du plus ancien au plus
 *     récent. Une doublure qui rendrait tout, dans l'ordre d'insertion, ferait
 *     passer au vert un test de borne que le SQL ne tient pas.
 *
 * C'est la même exigence que celle écrite en tête de
 * `directory/infrastructure/repositories/in-memory-directory.repository.ts` :
 * les deux implémentations doivent être exercées par la même suite.
 */
export class InMemoryBotMemoryRepository implements BotMemoryReadPort {
  private readonly turns = new Map<string, BotMemoryTurn[]>();

  /** Fixture de test — n'existe pas sur le port : rien en production n'écrit ici. */
  seed(dmChannelId: string, turns: readonly BotMemoryTurn[]): void {
    this.turns.set(dmChannelId, [...turns]);
  }

  async recentDirectTurns(
    dmChannelId: string,
    options: BotMemoryReadOptions,
  ): Promise<BotMemoryTurn[]> {
    if (options.limit <= 0) return [];
    if (!dmChannelId.startsWith('D')) return [];

    const cutoff = Date.now() - options.sinceMs;

    const fresh = (this.turns.get(dmChannelId) ?? []).filter((turn) => turn.at.getTime() >= cutoff);

    const newestFirst = [...fresh].sort((a, b) => b.at.getTime() - a.at.getTime());

    return newestFirst.slice(0, options.limit).reverse();
  }
}
