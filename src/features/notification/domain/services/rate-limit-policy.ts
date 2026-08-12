/**
 * LIMITATION DE DÉBIT (P3) — partie PURE : règles, clés de fenêtre, décision.
 *
 * Constat qui a motivé ce fichier : `grep -rni "ratelimit|throttle|bucket"` sur `src/` ne
 * renvoyait rien hors commentaires. N'importe quel membre du workspace pouvait donc, à coût
 * nul pour lui, épuiser en quelques minutes un budget quotidien de ≈ 19 messages partagé par
 * toute l'organisation — et, accessoirement, pousser le compte Gmail expéditeur vers sa limite
 * de 500 envois/jour, dont la sanction est la suspension du compte.
 *
 * ----------------------------------------------------------------------------
 * CE QU'ON PROTÈGE EXACTEMENT, ET POURQUOI ÇA CHANGE LA FORME DU CORRECTIF
 * ----------------------------------------------------------------------------
 * La contrainte qui casse la production n'est PAS le seau Groq par minute (12 000 tokens) mais
 * le quota JOURNALIER : `TPD: Limit 100000, Used 98207` relevé dans les en-têtes de l'incident
 * du 2026-08-11, soit ≈ 19 messages par jour à 5 168 tokens l'un. Une limitation qui ne
 * raisonnerait qu'à la minute laisserait passer 5 × 1 440 = 7 200 messages par jour : elle
 * protégerait le seau et laisserait brûler le budget. D'où DEUX règles, et non une.
 *
 * Le plafond journalier est PAR PERSONNE, pas par workspace. Un plafond global calé sur 19
 * éteindrait le bot pour tout le monde dès qu'une seule personne l'atteindrait — en pratique,
 * la première à travailler ce matin-là. Par personne, il borne le dégât qu'un acteur unique
 * (hostile, ou simplement pris dans une boucle) peut infliger aux autres, et laisse le
 * fournisseur arbitrer le total. C'est ce que `QUOTA_FAILURE` sait déjà annoncer honnêtement.
 *
 * ----------------------------------------------------------------------------
 * FENÊTRE FIXE, ET POURQUOI CE N'EST PAS UN PIS-ALLER
 * ----------------------------------------------------------------------------
 * La clé porte le numéro de fenêtre (`floor(now / windowMs)`), ce qui rend l'incrément
 * ATOMIQUE en un seul aller-retour : `INSERT … ON CONFLICT DO UPDATE SET count = count + 1
 * RETURNING count`. Une fenêtre glissante imposerait de LIRE puis d'ÉCRIRE — donc de rouvrir
 * entre les deux la fenêtre de concurrence que le store partagé existe précisément pour
 * fermer, sur un chemin (l'ACK Slack) qui n'a que 3 secondes.
 *
 * Contrepartie assumée : à cheval sur une frontière de fenêtre, on tolère jusqu'à 2× la
 * limite. Sur un contrôle dont l'objet est d'empêcher l'épuisement d'un budget, un facteur 2
 * transitoire est sans conséquence ; une course entre deux instances, elle, en aurait une.
 */

export interface RateLimitRule {
  /** Entre dans la clé : deux règles ne partagent jamais un compteur. */
  readonly name: string;
  /** Nombre d'événements TOLÉRÉS dans la fenêtre. Le refus commence à `limit + 1`. */
  readonly limit: number;
  readonly windowMs: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rafale : borne le débit instantané d'une personne.
 *
 * 5 messages/minute est le chiffre de `COMPETENCES_ET_ANALYSE.md` P3. Il est très au-dessus de
 * l'usage humain observé (la campagne du 2026-08-11 n'a jamais dépassé 2 messages/minute) et
 * très en dessous de ce qu'un script atteint sans effort : c'est exactement ce qu'on attend
 * d'un seuil dont les faux positifs coûteraient la confiance de l'utilisatrice qui teste.
 */
export const BURST_RULE: RateLimitRule = {
  name: 'burst',
  limit: 5,
  windowMs: MINUTE_MS,
};

/**
 * Budget journalier par personne.
 *
 * 12 < 19 (le plafond réel du fournisseur) : une seule personne ne peut donc pas, à elle
 * seule, consommer la journée entière de l'organisation. Le test verrouille cette inégalité —
 * c'est elle qui porte le sens, pas le chiffre.
 */
export const DAILY_RULE: RateLimitRule = {
  name: 'daily',
  limit: 12,
  windowMs: DAY_MS,
};

/**
 * Marge de purge : une ligne survit à sa fenêtre.
 *
 * Purger à l'instant exact de la fin ferait disparaître un compteur encore décisif pour une
 * instance dont l'horloge est en léger retard — et l'effacer, c'est offrir une fenêtre neuve.
 */
const EXPIRY_MARGIN_MS = 5 * MINUTE_MS;

export interface WindowBounds {
  readonly windowStart: Date;
  readonly expiresAt: Date;
}

/** Borne la fenêtre fixe contenant `now`. */
export function windowBounds(rule: RateLimitRule, now: Date): WindowBounds {
  const index = Math.floor(now.getTime() / rule.windowMs);
  const start = index * rule.windowMs;

  return {
    windowStart: new Date(start),
    expiresAt: new Date(start + rule.windowMs + EXPIRY_MARGIN_MS),
  };
}

/**
 * Clé du compteur : `<règle>:<longueur du sujet>:<sujet>:<numéro de fenêtre>`.
 *
 * La longueur préfixée n'est pas une coquetterie. Un identifiant Slack ne contient pas de
 * `:`, mais cette clé accepte aussi des sujets composés (canal, workspace), et une
 * concaténation nue rend `a:b` et `a` indiscernables une fois le reste accolé — deux personnes
 * partageraient alors un quota, ou l'une s'en offrirait un second. Préfixer par la longueur
 * rend l'encodage injectif sans avoir à interdire un caractère.
 */
export function buildCounterKey(rule: RateLimitRule, subjectId: string, now: Date): string {
  const index = Math.floor(now.getTime() / rule.windowMs);
  return `${rule.name}:${subjectId.length}:${subjectId}:${index}`;
}

export interface RateLimitEvaluation {
  readonly allowed: boolean;
  /**
   * `true` UNIQUEMENT au premier refus de la fenêtre.
   *
   * Un refus muet reproduirait le défaut le plus coûteux de ce dépôt (`emailSent: false` sous
   * `status: 'success'`) : la personne conclurait à une panne et réessaierait, aggravant
   * exactement ce qu'on limite. Mais prévenir à CHAQUE refus ferait de la limitation un
   * amplificateur — un message Slack émis par message rejeté. D'où : une fois, puis silence.
   */
  readonly shouldNotify: boolean;
}

/**
 * Décide à partir du compte APRÈS incrément.
 *
 * Un compte non exploitable (0, `NaN` — compteur illisible, store dégradé) vaut autorisation :
 * ce n'est pas un dépassement CONSTATÉ, et refuser sans preuve positive couperait le service
 * sur une panne de la table. Même arbitrage que la déduplication partagée, qui accepte
 * l'événement quand son store est indisponible.
 */
export function evaluateCount(rule: RateLimitRule, count: number): RateLimitEvaluation {
  if (!Number.isFinite(count) || count <= 0) {
    return { allowed: true, shouldNotify: false };
  }

  return {
    allowed: count <= rule.limit,
    shouldNotify: count === rule.limit + 1,
  };
}

/**
 * Lit une limite depuis l'environnement, en refusant les valeurs qui éteindraient le bot.
 *
 * `0` et les négatifs retombent sur le défaut : une faute de frappe dans une variable Vercel
 * ne doit pas pouvoir couper 100 % du trafic en silence — c'est la classe de panne que
 * `checkTeamId` documente déjà comme la raison de son propre fail-open.
 */
export function readRuleLimit(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
