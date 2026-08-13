/**
 * Compteurs de limitation de débit PARTAGÉS entre instances (P3).
 *
 * Pourquoi partagés, et pas un simple LRU en mémoire comme le proposait
 * `COMPETENCES_ET_ANALYSE.md` P3 palier 1 : le budget à protéger est JOURNALIER
 * (100 000 tokens Groq, ≈ 19 messages/jour). Un compteur en mémoire est par instance et
 * disparaît au gel de la fonction serverless — sur 24 h, il ne compte donc pas la même chose
 * que le fournisseur, et un attaquant n'a même pas à le savoir pour le contourner : il suffit
 * que Vercel démarre une instance neuve. C'est exactement la leçon déjà payée par la
 * déduplication, dont le cache par instance a produit la double réponse du 2026-08-11.
 *
 * Le LRU local n'est pas abandonné pour autant : il reste le premier niveau, gratuit, qui
 * écarte sans aucune E/S les rafales retombant sur une instance chaude.
 */
export interface RateLimitRepository {
  /**
   * Incrémente le compteur d'une fenêtre et rend sa valeur APRÈS incrément.
   *
   * ⚠️ CONTRAT NON NÉGOCIABLE : un seul énoncé atomique
   * (`INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`). Un `SELECT`
   * suivi d'un `UPDATE` rouvrirait la fenêtre de concurrence que ce port existe pour fermer —
   * deux instances liraient la même valeur avant que l'une écrive, et la limite serait
   * franchissable par simple parallélisme.
   *
   * La clé porte déjà le numéro de fenêtre (voir `buildCounterKey`) : il n'y a donc jamais de
   * remise à zéro à effectuer, seulement des lignes qui cessent d'être consultées.
   */
  /**
   * @param by Pas d'incrément. Défaut `1` — les appelants qui comptent des MESSAGES ne
   *   changent pas.
   *
   *   Deux autres valeurs ont un sens, et elles sont la raison d'être du paramètre :
   *
   *   - **un nombre de TOKENS**, pour le budget dont la ressource ne se compte pas en
   *     messages. Un « Bonjour » a coûté 13 376 tokens en production — 13 % de la journée —
   *     pour une seule unité sur un compteur de messages. Le compteur ne mesurait pas ce
   *     qu'il prétendait borner.
   *   - **`0`, qui fait de cet appel une LECTURE ATOMIQUE** : la ligne est créée à 0 si elle
   *     manque, et le compte est rendu sans être modifié. C'est ce qui permet de CONSULTER un
   *     budget avant un appel de modèle et de l'INCRÉMENTER après — le coût réel n'étant connu
   *     qu'a posteriori — sans ajouter de méthode au port ni un second aller-retour.
   */
  increment(key: string, windowStart: Date, expiresAt: Date, by?: number): Promise<number>;

  /** Purge les fenêtres expirées. Appelée opportunément — aucun cron ne le fera. */
  prune(now: Date): Promise<number>;
}
