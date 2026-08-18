/**
 * La forme NORMALISÉE sur laquelle tous les court-circuits déterministes se prononcent.
 *
 * ## Pourquoi un module pour huit lignes
 *
 * Relevé le 2026-08-18 : cette fonction existait en CINQ exemplaires — `greeting.ts`,
 * `pin-fact.ts`, `distress.ts`, `forget.ts`, `profile-request.ts` — identiques au caractère
 * près, à ceci près qu'une seule portait les commentaires qui expliquent ses deux décisions
 * non évidentes. Les quatre autres les avaient perdus en route.
 *
 * Ce n'est pas une duplication anodine : ces cinq détecteurs décident, chacun, si un message
 * est traité SANS aucun appel de modèle. Une divergence entre deux d'entre eux ferait qu'un
 * même message serait reconnu par l'un et pas par l'autre — et `isAnsweredWithoutModel`, qui
 * gouverne le rationnement, est dérivé de tous. Le dépôt a déjà payé ce genre d'écart.
 *
 * ⚠️ Ce qui reste délibérément PROPRE à chaque détecteur : ses mots-clés, ses fenêtres de
 * proximité, ses listes de négations. Elles sont documentées comme indépendantes — les
 * unifier coupleraient des détecteurs qui doivent pouvoir diverger. Seule la mise en forme du
 * texte est commune, parce qu'elle n'a aucune raison de différer.
 */
export function normalizeIntentText(text: string): string {
  return (
    text
      .normalize('NFD')
      .toLowerCase()
      // Les marques combinantes sont retirées SANS rien mettre à la place. Les remplacer
      // par une espace, comme le fait le filtre suivant, couperait le mot en deux :
      // « journée » se décompose en « journe » + accent + « e », et donnait « journe e ».
      .replace(/[̀-ͯ]/g, '')
      // Les CHIFFRES sont conservés : « 123 » est une sonde de vie au même titre que
      // « ping », et un filtre `[^a-z ]` l'aurait réduit à la chaîne vide, donc jamais
      // reconnu. Ils ne créent aucun faux positif — les détecteurs comparent sur des mots.
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
