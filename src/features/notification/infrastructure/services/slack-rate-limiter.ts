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
   * Ordre significatif : la règle la moins chère à déclencher d'abord. Un abus se manifeste
   * en rafale bien avant d'épuiser un budget journalier, et court-circuiter sur la rafale
   * épargne un aller-retour vers la base.
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
   * ⚠️ Appelée sur le chemin de l'ACK Slack (3 s) : au plus un aller-retour par règle, et
   * court-circuit dès le premier refus.
   *
   * ⚠️ À appeler APRÈS la déduplication. Un rejeu Slack n'est pas un nouveau message : le
   * compter consommerait le quota de quelqu'un pour un événement qu'il n'a envoyé qu'une
   * fois, et c'est précisément sur les démarrages à froid — donc quand le bot va déjà mal —
   * que Slack rejoue le plus.
   */
  async check(subjectId: string, now: Date = new Date()): Promise<RateLimitDecision> {
    let degraded = false;

    for (const rule of this.rules) {
      const key = buildCounterKey(rule, subjectId, now);

      // Niveau 1 — local. Gratuit, et suffisant pour trancher une rafale sur instance chaude.
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
          degraded,
        };
      }

      // Niveau 2 — partagé. Le seul qui compte pour un budget journalier.
      if (!this.repository) {
        degraded = true;
        continue;
      }

      const { windowStart, expiresAt } = windowBounds(rule, now);

      try {
        const sharedCount = await this.repository.increment(key, windowStart, expiresAt);
        const sharedVerdict = evaluateCount(rule, sharedCount);

        if (!sharedVerdict.allowed) {
          return {
            allowed: false,
            rule: rule.name,
            shouldNotify: sharedVerdict.shouldNotify,
            degraded,
          };
        }
      } catch (error) {
        degraded = true;
        if (!this.degradationLogged) {
          this.degradationLogged = true;
          logger.error('Shared rate limit unavailable — falling back to the per-instance counter', {
            error,
            rule: rule.name,
          });
        }
      }
    }

    return degraded ? { ...ALLOWED, degraded: true } : ALLOWED;
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
