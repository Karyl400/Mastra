/**
 * Les bornes de PROFONDEUR de la récupération — RGPD et budget, dans le même
 * fichier parce que c'est le même chiffre qui répond aux deux.
 *
 * ── Pourquoi une borne de profondeur, et pas seulement une borne de sortie ──
 * `PLAN-ARCHITECTURE.md` §4.7 refuse « collecter les infos de tous les canaux »
 * avec persistance : surveillance systématique des communications des salariés,
 * AIPD obligatoire, consultation du CSE. Ce que cette feature fait est
 * volontairement l'inverse : lecture À LA DEMANDE, rien de nouveau n'est stocké,
 * et la fenêtre est bornée. La minimisation (art. 5(1)(c)) n'est pas une
 * intention affichée dans une doc — c'est cette constante.
 *
 * 30 jours : au-delà, la question posée n'est plus « qu'est-ce qui s'est dit ? »
 * mais « que sait-on de cette personne ? », qui n'est pas la même demande et
 * n'appelle pas les mêmes garanties.
 *
 * ── Pourquoi une borne de BALAYAGE distincte de la borne de SORTIE ──────────
 * `SCAN_LIMIT` plafonne ce qu'on charge ; `MAX_EXCERPTS` (voir
 * `services/excerpt-budget.ts`) plafonne ce qu'on facture au modèle. Les
 * confondre coûterait soit un tool-result proportionnel au trafic du canal, soit
 * un tri effectué sur un échantillon trop maigre pour être représentatif.
 *
 * ⚠️ Aucune de ces valeurs n'est exposée dans un schéma de tool. Un paramètre
 * `limit` ne sert qu'à laisser le modèle choisir combien on lui facture — c'est
 * la leçon de `getNotificationHistory` (≈ 9 600 tokens → 177).
 *
 * TypeScript pur — zéro import.
 */

/** Profondeur maximale d'une récupération : 30 jours. */
export const KNOWLEDGE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Nombre de messages CHARGÉS avant tri et projection.
 *
 * 40 : assez pour que « les derniers échanges » aient un sens sur un canal actif,
 * assez peu pour qu'un aller-retour reste sub-seconde et qu'aucune pagination
 * Slack ne soit nécessaire (`conversations.history` rend jusqu'à 1 000 messages
 * par page — on n'en demande jamais autant).
 */
export const KNOWLEDGE_SCAN_LIMIT = 40;
