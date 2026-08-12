import type { RateLimitRepository } from '../../domain/ports/rate-limit.repository';

interface CounterRow {
  count: number;
  /** `Date.now()` de la borne de purge. La fenêtre elle-même est portée par la clé. */
  expiresAt: number;
}

/**
 * Doublure de test du `RateLimitRepository`. VRAI compteur — une `Map` — et non un bouchon :
 * c'est elle qui sert de doublure aux tests du contrôle de débit, et une doublure qui ne compte
 * pas ferait passer au vert un limiteur qui ne limite rien.
 *
 * Elle sert aussi de premier niveau LOCAL possible : une instance chaude peut écarter une
 * rafale sans aucune E/S. Mais elle ne remplace pas l'implémentation Drizzle, et le port dit
 * pourquoi — un compteur en mémoire est par instance et disparaît au gel de la fonction
 * serverless, alors que le budget à protéger se mesure sur 24 h.
 *
 * ⚠️ `increment()` ne comporte AUCUN `await` avant sa mutation, et c'est délibéré : en
 * JavaScript, un corps de fonction sans point de suspension est atomique. La doublure reproduit
 * ainsi la garantie que l'implémentation Drizzle obtient de
 * `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`. Y insérer un `await`
 * entre la lecture et l'écriture réintroduirait exactement la fenêtre de concurrence que ce
 * port ferme — et le test de concurrence, qui exige N valeurs DISTINCTES, le verrait.
 */
export class InMemoryRateLimitRepository implements RateLimitRepository {
  private rows = new Map<string, CounterRow>();

  async increment(key: string, _windowStart: Date, expiresAt: Date): Promise<number> {
    const existing = this.rows.get(key);

    if (!existing) {
      this.rows.set(key, { count: 1, expiresAt: expiresAt.getTime() });
      return 1;
    }

    // On n'écrase PAS `expiresAt` : la clé porte le numéro de fenêtre, donc tous les incréments
    // qui atterrissent ici décrivent la même fenêtre. Le repousser à chaque incrément offrirait
    // à une clé très sollicitée une survie indéfinie. Même choix, et même raison, que côté SQL.
    existing.count += 1;
    return existing.count;
  }

  /** `<=` : `expiresAt` inclut déjà la marge de purge de `rate-limit-policy.ts`. */
  async prune(now: Date): Promise<number> {
    const cutoff = now.getTime();
    let removed = 0;

    for (const [key, row] of this.rows) {
      if (row.expiresAt <= cutoff) {
        this.rows.delete(key);
        removed += 1;
      }
    }

    return removed;
  }

  /** Confort de test : vide le dépôt entre deux cas. */
  clear(): void {
    this.rows.clear();
  }
}
