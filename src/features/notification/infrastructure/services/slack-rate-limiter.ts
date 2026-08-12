import { LRUCache } from 'lru-cache';
import { logger } from '../../../../shared/logger';
import type { RateLimitRepository } from '../../domain/ports/rate-limit.repository';
import {
  BURST_RULE,
  DAILY_RULE,
  buildCounterKey,
  evaluateCount,
  windowBounds,
  type RateLimitRule,
} from '../../domain/services/rate-limit-policy';

/**
 * LIMITATION DE DÉBIT — assemblage des DEUX niveaux (P3).
 *
 * Exactement la forme de `claimEvent()` pour la déduplication, et pour les mêmes raisons :
 *
 *   1. **Compteur local (LRU).** Gratuit, aucune E/S. Il écarte les rafales qui retombent sur
 *      une instance chaude — le cas fréquent quand quelqu'un martèle le bot.
 *   2. **Store partagé (Turso).** Le seul qui voie ce que font les AUTRES instances, et le
 *      seul qui survive au gel de la fonction serverless. Sur un budget qui se mesure à la
 *      JOURNÉE, c'est lui qui compte réellement : un compteur en mémoire disparaît avec
 *      l'instance, et Vercel en démarre une neuve sans que personne ait à le demander.
 *
 * ----------------------------------------------------------------------------
 * DÉGRADATION — et pourquoi elle penche du même côté que la déduplication
 * ----------------------------------------------------------------------------
 * Store indisponible ⇒ on retombe sur le seul compteur local et on ACCEPTE. Le raisonnement
 * est celui déjà tranché pour `slack_event_dedup` : une panne de la table ne doit pas devenir
 * une panne du produit. Un message de trop est visible et corrigeable ; un bot muet ne l'est
 * pas — et ce dépôt a déjà passé des heures à chercher pourquoi le bot semblait mort.
 *
 * La ligne à chercher dans les logs :
 *     Shared rate limit unavailable — falling back to the per-instance counter
 *
 * ⚠️ Conséquence à assumer : tant que `rate_limit_counters` n'existe pas en base, la
 * protection est présente dans le code mais ne porte que sur une instance. C'est le même
 * avertissement que pour la déduplication, et il vaut la peine d'être lu deux fois.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Nom de la règle qui a refusé. `null` quand l'événement est autorisé. */
  readonly rule: string | null;
  /** Vrai au PREMIER refus d'une fenêtre seulement. Voir `evaluateCount`. */
  readonly shouldNotify: boolean;
  /** Le store partagé n'a pas répondu : la décision ne porte que sur cette instance. */
  readonly degraded: boolean;
}

const ALLOWED: RateLimitDecision = {
  allowed: true,
  rule: null,
  shouldNotify: false,
  degraded: false,
};

export interface SlackRateLimiterOptions {
  /**
   * Ordre significatif, à DEUX titres. Il fixe la priorité de lecture des verdicts — la règle
   * citée à l'utilisateur est la première de ce tableau qui refuse, jamais celle dont la
   * réponse réseau est revenue en premier. Et il fixe l'ordre du court-circuit LOCAL : la règle
   * la moins chère à déclencher d'abord, un abus se manifestant en rafale bien avant d'épuiser
   * un budget journalier. Court-circuiter sur la rafale épargne TOUS les allers-retours de la
   * phase partagée, pas seulement le sien.
   */
  readonly rules?: readonly RateLimitRule[];
  /**
   * `null` désactive explicitement le niveau partagé (tests, environnement sans base).
   * `undefined` laisse l'appelant fournir le dépôt plus tard.
   */
  readonly repository?: RateLimitRepository | null;
  readonly localMax?: number;
}

export class SlackRateLimiter {
  private readonly rules: readonly RateLimitRule[];
  private readonly repository: RateLimitRepository | null;
  /**
   * Compteurs locaux. La clé porte déjà le numéro de fenêtre, donc une entrée ne se remet
   * jamais à zéro : elle cesse simplement d'être consultée. Le TTL est posé par `set()`,
   * par règle — 1 minute et 24 heures n'ont pas à partager une durée de rétention.
   */
  private readonly local: LRUCache<string, number>;
  /** N'inonde pas les logs quand la table manque : un avertissement, pas un par message. */
  private degradationLogged = false;

  constructor(options: SlackRateLimiterOptions = {}) {
    this.rules = options.rules ?? [BURST_RULE, DAILY_RULE];
    this.repository = options.repository ?? null;
    this.local = new LRUCache<string, number>({
      max: options.localMax ?? 5000,
      // TTL de repli ; chaque `set()` pose le sien, calé sur la fenêtre de sa règle.
      ttl: DAILY_RULE.windowMs,
    });
  }

  /**
   * Compte un événement pour `subjectId` et dit s'il peut être traité.
   *
   * ⚠️ Appelée sur le chemin de l'ACK Slack (3 s), qui n'en a que trois. D'où la forme en DEUX
   * PHASES, et non une boucle unique :
   *
   *   1. **Phase locale — séquentielle, court-circuitée, ZÉRO E/S.** L'ordre y est gratuit, et
   *      il porte une sémantique qu'on ne veut surtout pas perdre (voir plus bas).
   *   2. **Phase partagée — PARALLÈLE.** Les clés des règles sont disjointes par construction
   *      (`buildCounterKey` encode le nom de la règle ET le numéro de fenêtre) : les deux
   *      `increment` sont indépendants, aucun ne lit ce que l'autre écrit. Les séquentialiser
   *      ne faisait qu'additionner deux latences réseau sur le chemin le plus contraint du
   *      système. En parallèle, le contrôle coûte UN aller-retour de latence au lieu de N.
   *
   * ----------------------------------------------------------------------------
   * POURQUOI LA PHASE LOCALE RESTE SÉQUENTIELLE — ce n'est pas une inconséquence
   * ----------------------------------------------------------------------------
   * Tout paralléliser reviendrait à incrémenter le compteur JOURNALIER d'un message que la
   * règle de RAFALE vient de refuser. Or un message refusé ne déclenche aucun appel LLM : il
   * ne consomme pas un token du budget Groq que la règle journalière existe pour protéger.
   * Le compter serait doublement nuisible — quelqu'un qui martèle le bot par accident (double
   * clic, boucle de script) brûlerait ses ≈12 messages du jour sans jamais obtenir une seule
   * réponse, et le seul garde-fou qui devait le protéger serait devenu l'instrument de sa
   * punition. La phase locale, qui est gratuite, tranche donc AVANT que quoi que ce soit ne
   * parte vers le store : elle est le filtre le plus fréquent (instance chaude) et le seul qui
   * doive rester strictement ordonné.
   *
   * Reste un écart assumé, étroit : quand le compteur local passe mais que le PARTAGÉ refuse
   * (rafale répartie sur plusieurs instances), les compteurs des autres règles ont déjà été
   * incrémentés. Il est borné par la limite locale la plus basse et par instance — au plus
   * `BURST_RULE.limit` unités par minute et par instance — là où une parallélisation totale
   * l'aurait rendu illimité.
   *
   * ⚠️ À appeler APRÈS la déduplication. Un rejeu Slack n'est pas un nouveau message : le
   * compter consommerait le quota de quelqu'un pour un événement qu'il n'a envoyé qu'une
   * fois, et c'est précisément sur les démarrages à froid — donc quand le bot va déjà mal —
   * que Slack rejoue le plus.
   */
  async check(subjectId: string, now: Date = new Date()): Promise<RateLimitDecision> {
    // Phase 1 — compteurs LOCAUX. Gratuits, donc évalués un par un et court-circuités.
    const pending: { rule: RateLimitRule; key: string }[] = [];

    for (const rule of this.rules) {
      const key = buildCounterKey(rule, subjectId, now);

      const localCount = (this.local.get(key) ?? 0) + 1;
      this.local.set(key, localCount, { ttl: rule.windowMs });

      const localVerdict = evaluateCount(rule, localCount);
      if (!localVerdict.allowed) {
        // Le compteur partagé est nécessairement ≥ au local (il voit un sur-ensemble des
        // événements) : s'il est dépassé ici, il l'est là-bas. Refuser sans l'interroger est
        // donc correct, et épargne un aller-retour au moment précis où le trafic est le plus
        // dense.
        return {
          allowed: false,
          rule: rule.name,
          shouldNotify: localVerdict.shouldNotify,
          degraded: false,
        };
      }

      pending.push({ rule, key });
    }

    if (pending.length === 0) return ALLOWED;

    // Phase 2 — store PARTAGÉ. Le seul qui compte pour un budget journalier, et le seul qui
    // coûte du réseau : il part donc d'un bloc.
    const repository = this.repository;
    if (!repository) return { ...ALLOWED, degraded: true };

    const outcomes = await Promise.all(
      pending.map(async ({ rule, key }) => {
        const { windowStart, expiresAt } = windowBounds(rule, now);
        try {
          return { rule, count: await repository.increment(key, windowStart, expiresAt) };
        } catch (error) {
          // Journalisé ICI, à l'endroit où l'échec est connu : une panne du store ne doit
          // jamais être muette, même quand une autre règle tranche avant qu'on la lise.
          this.logDegradation(rule, error);
          return { rule, count: undefined };
        }
      }),
    );

    // Les verdicts sont relus DANS L'ORDRE DES RÈGLES, pas dans l'ordre d'arrivée des
    // réponses : `rules` est déclaré par priorité (« la règle la moins chère à déclencher
    // d'abord »), et c'est ce nom-là qui remonte jusqu'au message adressé à l'utilisateur.
    // Sans ce tri, la règle citée dépendrait de l'aléa réseau.
    let degraded = false;

    for (const { rule, count } of outcomes) {
      if (count === undefined) {
        degraded = true;
        continue;
      }

      const verdict = evaluateCount(rule, count);
      if (!verdict.allowed) {
        return {
          allowed: false,
          rule: rule.name,
          shouldNotify: verdict.shouldNotify,
          degraded,
        };
      }
    }

    return degraded ? { ...ALLOWED, degraded: true } : ALLOWED;
  }

  /** N'inonde pas les logs : un avertissement pour la vie de l'instance, pas un par message. */
  private logDegradation(rule: RateLimitRule, error: unknown): void {
    if (this.degradationLogged) return;
    this.degradationLogged = true;
    logger.error('Shared rate limit unavailable — falling back to the per-instance counter', {
      error,
      rule: rule.name,
    });
  }

  /** Purge opportuniste des fenêtres expirées. Aucun cron ne le fera. */
  async prune(now: Date = new Date()): Promise<void> {
    if (!this.repository) return;

    try {
      const removed = await this.repository.prune(now);
      if (removed > 0) logger.info('Pruned expired rate limit windows', { removed });
    } catch (error) {
      logger.warn('Rate limit pruning failed', { error });
    }
  }
}
