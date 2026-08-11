/**
 * Déduplication PARTAGÉE des événements Slack.
 *
 * Le cache LRU du handler est en mémoire, donc **par instance**. Incident de production du
 * 2026-08-11 (12:38 UTC), deux causes conjointes :
 *   1. l'ACK a mis ~6,7 s (démarrage à froid du bundle Mastra) contre 3 s autorisées, donc
 *      Slack a rejoué l'événement ;
 *   2. l'instance A était occupée par le `waitUntil` de l'appel LLM, donc le rejeu a été routé
 *      vers une instance NEUVE, au cache vide — qui a répondu une seconde fois.
 *
 * Le point structurant : un cache par instance est **incapable par construction** de
 * dédupliquer les rejeux qui arrivent PENDANT le traitement, c'est-à-dire exactement ceux qui
 * produisent une double réponse. D'où ce port, implémenté sur la base partagée (Turso).
 *
 * ⚠️ `claim()` tourne AVANT l'ACK HTTP, sur le chemin qui a 3 secondes : une implémentation
 * doit s'y tenir à UN aller-retour dans le cas passant.
 */

/**
 * État d'une clé.
 *  - `in-flight` : le traitement est en cours ; un rejeu concurrent doit être ignoré.
 *  - `done`      : le traitement est allé au bout ; tout rejeu est un doublon définitif.
 *
 * Cette distinction est le fruit d'un bug déjà corrigé : marquer la clé « vue » dès l'ACK
 * perdait DÉFINITIVEMENT l'événement quand la fonction serverless était gelée en plein
 * traitement — le rejeu Slack tombait sur la clé posée et était silencieusement jeté.
 */
export type SlackEventDedupStatus = 'in-flight' | 'done';

export interface SlackEventClaimOptions {
  /**
   * Durée au-delà de laquelle une entrée `in-flight` est réputée abandonnée (fonction gelée
   * ou tuée) et la clé redevient prenable. Sans cette grâce, un événement perdu au gel de la
   * fonction le serait pour toujours.
   */
  readonly inFlightGraceMs: number;
}

/**
 * Résultat d'une prise de clé.
 *
 * `reclaimed` distingue une première prise d'une reprise après abandon : les deux autorisent
 * le traitement, mais la seconde mérite un `warn` — c'est le symptôme d'une invocation tuée
 * en vol.
 *
 * Sur le refus, `status` et `ageMs` ne servent QUE la journalisation ; `unknown` couvre le cas
 * (rare) où la ligne a disparu entre la tentative de prise et sa relecture — purge concurrente.
 */
export type SlackEventClaim =
  | { readonly granted: true; readonly reclaimed: boolean }
  | {
      readonly granted: false;
      readonly status: SlackEventDedupStatus | 'unknown';
      readonly ageMs: number | null;
    };

/**
 * Rétention des clés. La fenêtre de rejeu de Slack est de ~10 minutes (3 renvois espacés
 * de 1 s, 1 min puis 5 min) : au-delà, une entrée ne protège plus de rien et ne fait que
 * grossir la table.
 */
export const SLACK_EVENT_DEDUP_RETENTION_MS = 10 * 60 * 1000;

export interface SlackEventDedupRepository {
  /**
   * Prend la clé de façon **ATOMIQUE**, ou refuse.
   *
   * ⚠️ CONTRAT NON NÉGOCIABLE : la prise doit être une opération atomique unique
   * (`INSERT … ON CONFLICT DO NOTHING`, puis décision d'après le nombre de lignes affectées).
   * Un `SELECT` suivi d'un `INSERT` rouvrirait exactement la fenêtre de concurrence que ce
   * port existe pour fermer — deux instances liraient « absente » avant que l'une écrive.
   */
  claim(key: string, options: SlackEventClaimOptions): Promise<SlackEventClaim>;

  /** Le traitement est allé au bout : tout rejeu ultérieur est un doublon définitif. */
  markDone(key: string): Promise<void>;

  /**
   * Libère la clé après un échec inattendu, pour qu'un rejeu Slack reparte immédiatement
   * au lieu d'être avalé par la déduplication.
   */
  release(key: string): Promise<void>;

  /** Purge les clés au-delà de la rétention. Appelé opportunément, pas par un cron. */
  prune(olderThan: Date): Promise<number>;
}
