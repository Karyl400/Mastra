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
  /**
   * Cette règle existe-t-elle pour RATIONNER LE BUDGET DU MODÈLE, ou pour contrer un abus ?
   *
   * La distinction n'est pas cosmétique : elle décide qui la règle doit épargner. Un message
   * auquel le bot répond SANS appeler de modèle (salutation, emoji seul, message trop long,
   * détresse, pièce jointe) ne consomme pas un token — le rationner ne protège donc rien, et
   * coûte une réponse à quelqu'un.
   *
   * ⚠️ Le cas qui a rendu cette distinction nécessaire, observé en production le 2026-08-13 :
   * une personne ayant déjà atteint ses 12 messages du jour écrit « bonjour » et reçoit
   * « J'ai atteint mon quota de messages pour aujourd'hui ». Pour un mot qui ne coûte rien.
   * Et la même chose serait arrivée à « je ne vais pas bien » — soit exactement le message
   * que `distress.ts` existe pour ne jamais laisser sans réponse.
   *
   * Absent ⇒ `false` : une règle qui ne se déclare pas est une règle anti-abus, donc elle
   * s'applique toujours. C'est le défaut sûr.
   */
  readonly rationsModelBudget?: boolean;
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
  // Sa raison d'être est écrite juste au-dessus : elle borne une part du plafond du
  // FOURNISSEUR. Elle n'a donc rien à dire d'un message auquel on répond sans modèle.
  rationsModelBudget: true,
};

/**
 * Sujet du compteur d'ÉQUIPE. Une seule clé pour tout le monde — c'est la portée qui manquait.
 */
export const WORKSPACE_SUBJECT = 'workspace';

/**
 * BUDGET DE TOKENS DE L'ÉQUIPE — la seule règle qui mesure ce qui casse réellement.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi les deux règles ci-dessus ne suffisaient pas
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Elles comptent des MESSAGES ; la ressource se consomme en TOKENS. Deux conséquences, et
 * chacune suffirait :
 *
 *  1. **L'unité est fausse.** Le raisonnement qui justifie `DAILY_RULE.limit = 12`
 *     (« 12 < 19, donc une personne ne peut pas consommer la journée entière ») suppose un
 *     coût moyen de 5 168 tokens par message. La production l'a démenti d'un facteur 2,6 : un
 *     « Bonjour » a coûté **13 376 tokens** en 5 étapes — 13 % du budget quotidien, pour UNE
 *     unité de compteur. À ce tarif, 8 messages épuisent la journée sans jamais approcher le
 *     plafond de 12.
 *  2. **La portée est fausse.** 6 personnes × 12 = **72 messages/jour possibles pour un budget
 *     de ≈ 19**. Il suffit de DEUX personnes en usage normal — sans script, sans malveillance —
 *     pour dépasser le budget du fournisseur. Or c'est exactement la panne survenue le
 *     2026-08-11 (`TPD: Limit 100000, Used 98207`), et rien ne la mesurait : le plafond par
 *     personne ne protège que du cas dégénéré à un seul acteur.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠️ Le comptage est POST-HOC, et ça ne peut pas être autrement
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le coût d'un appel n'est connu qu'APRÈS lui (`usage.inputTokens`). Le message qui fait
 * franchir le seuil passe donc toujours, et le dépassement est constaté au message suivant.
 * C'est assumé : on borne une DÉRIVE, on ne prétend pas à l'exactitude comptable. Toute
 * estimation faite AVANT l'appel serait pire que ce décalage — le coût dominant vient de
 * l'historique, des schémas d'outils et du nombre d'étapes, pas de la taille du message
 * entrant.
 *
 * `rationsModelBudget: true` est **obligatoire ici**. Sans lui, une salutation ou une
 * détresse se heurteraient au budget d'équipe épuisé : ce serait la reproduction exacte du
 * défaut corrigé le 2026-08-13, transposée de l'individu au collectif.
 */
export const WORKSPACE_TOKEN_RULE: RateLimitRule = {
  name: 'workspaceTokens',
  // 90 % du TPD réel (100 000). La marge absorbe l'overshoot ×2 documenté sur les fenêtres
  // fixes et laisse de quoi terminer un run engagé — un plafond calé au ras couperait le
  // service à l'instant précis où quelqu'un attend encore sa réponse.
  limit: 90_000,
  windowMs: DAY_MS,
  rationsModelBudget: true,
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
