import type { ConversationTurn } from '../entities/conversation-turn';

/**
 * Fenêtrage de l'historique conversationnel, EN TOKENS et jamais en nombre de messages
 * (décision D3 de la spec).
 *
 * Pourquoi pas un plafond en messages : les tours n'ont pas de taille comparable. Un
 * « Par email » pèse 3 tokens, un retour d'outil en pèse 979. Compter les messages, c'est
 * ne rien plafonner du tout — et le plafond Groq de 12 000 tokens/minute est la limite qui
 * casse la production aujourd'hui. Rappel de l'arithmétique : le préfixe est repayé
 * intégralement à CHAQUE aller-retour, donc un run de K étapes facture chaque token de
 * mémoire K fois.
 *
 * TypeScript pur — ZÉRO import de framework.
 */

/**
 * Caractères par token. Ratio calibré sur les mesures réelles du projet et non sur une
 * moyenne générique : l'en-tête `SYSTEM_SECURITY_PROMPT` fait 1308 caractères pour
 * 374 tokens mesurés en production le 2026-08-08, soit 3,497 — arrondi à 3,5.
 * L'incertitude résiduelle est de l'ordre de ±10 %, absorbée par la marge du budget.
 */
export const CHARS_PER_TOKEN = 3.5;

/**
 * Budget par défaut alloué à l'historique.
 *
 * Dimensionné sur `onboardingOrchestrator`, l'agent le plus coûteux, à K=3 étapes — le cas
 * qui touchait le plafond. Deux mesures du 2026-08-11 (`_measure.mts`) fixent la marge :
 *
 *  - FLOOR ramené de 2100 à **1458 tokens** (instructions raccourcies et factorisées,
 *    schémas d'outils allégés) ;
 *  - retour de `getEmployeeProfile` ramené de 2506 à **329 tokens** par appel — c'était le
 *    poste dominant d'un flux à plusieurs étapes, bien avant l'historique.
 *
 * Budget disponible qui en résulte : `(12000 − 3 × 1458) / 3 ≈ 2540` tokens. On retient
 * **1600**, soit ~37 % de marge. Le surdimensionnement de la marge est délibéré : au-delà du
 * plafond Groq l'échec n'est pas une dégradation mais un HTTP 500, et le repli Mistral a lui
 * aussi échoué le 2026-08-08. Mieux vaut une mémoire un peu courte qu'un bot muet.
 *
 * Soit ~10 messages de texte courant, contre 6 avant le dégraissage.
 */
export const CONVERSATION_TOKEN_BUDGET = 1600;

/**
 * Part maximale du budget qu'un tour isolé peut occuper. Au-delà, il est TRONQUÉ et non exclu :
 * un message géant avalerait sinon toute la fenêtre à lui seul, et l'exclure ferait disparaître
 * du contexte le message le plus substantiel de l'échange.
 */
export const MAX_TURN_BUDGET_SHARE = 0.4;

/** Marqueur de troncature. Un seul caractère, donc un coût négligeable. */
const TRUNCATION_SUFFIX = '…';

/** Coût estimé d'un contenu, en tokens. */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

/**
 * Sélectionne les tours les plus récents tenant dans `budgetTokens`.
 *
 * - parcours du plus RÉCENT au plus ancien, accumulation jusqu'au budget ;
 * - **une paire `user`/`assistant` n'est JAMAIS coupée** : si la paire complète n'entre pas
 *   dans le budget restant, on s'arrête là. Un tour `assistant` orphelin répondrait à une
 *   question invisible pour le modèle — c'est pire que pas de mémoire du tout, parce que le
 *   modèle prend cette réponse pour un fait établi sans jamais pouvoir la rattacher ;
 * - un tour dépassant 40 % du budget est tronqué (fin coupée, suffixe « … ») ;
 * - le résultat est rendu en ordre CHRONOLOGIQUE, prêt à être posé tel quel dans les messages.
 *
 * @param turns tours du plus ancien au plus récent (l'ordre rendu par le dépôt).
 */
export function selectWindow(
  turns: readonly ConversationTurn[],
  budgetTokens: number = CONVERSATION_TOKEN_BUDGET,
): ConversationTurn[] {
  if (budgetTokens <= 0 || turns.length === 0) return [];

  const maxTurnTokens = Math.floor(budgetTokens * MAX_TURN_BUDGET_SHARE);
  /** Unités retenues, du plus récent au plus ancien ; remises à l'endroit à la sortie. */
  const units: ConversationTurn[][] = [];
  let remaining = budgetTokens;

  // Parcours à rebours par UNITÉS indivisibles. Une unité vaut soit un tour `user` seul
  // (question encore sans réponse), soit un tour `user` suivi de TOUTE la salve d'`assistant`
  // qui lui répond — le bot poste parfois deux messages pour un seul message utilisateur, et
  // les séparer recréerait exactement l'orphelin qu'on cherche à éviter.
  let index = turns.length - 1;
  while (index >= 0) {
    let start = index;

    if (turns[start].role === 'assistant') {
      while (start >= 0 && turns[start].role === 'assistant') start--;
      // Salve d'assistants sans question en amont : le tour utilisateur est hors fenêtre
      // (purgé par le TTL ou coupé par le `limit`). On s'arrête plutôt que de le rejouer nu.
      if (start < 0 || turns[start].role !== 'user') break;
    }

    const unit = turns.slice(start, index + 1).map((turn) => truncateToBudget(turn, maxTurnTokens));
    const unitCost = unit.reduce((sum, turn) => sum + estimateTokens(turn.content), 0);

    // On s'arrête — on ne saute PAS l'unité pour tenter la suivante : sauter donnerait un
    // historique troué, où deux tours consécutifs en apparence ne le sont pas.
    if (unitCost > remaining) break;

    remaining -= unitCost;
    units.push(unit);
    index = start - 1;
  }

  return units.reverse().flat();
}

/**
 * Tronque un tour au plafond par tour. Renvoie le tour d'origine s'il tient déjà — on ne
 * mute jamais l'entrée, le dépôt peut la réutiliser.
 */
function truncateToBudget(turn: ConversationTurn, maxTurnTokens: number): ConversationTurn {
  if (maxTurnTokens <= 0) return { ...turn, content: '' };
  if (estimateTokens(turn.content) <= maxTurnTokens) return turn;

  const maxChars = Math.floor(maxTurnTokens * CHARS_PER_TOKEN);
  const kept = turn.content.slice(0, Math.max(0, maxChars - TRUNCATION_SUFFIX.length));
  return { ...turn, content: `${kept}${TRUNCATION_SUFFIX}` };
}
