/**
 * Faire varier les réponses écrites en dur, sans tirer au sort.
 *
 * ## Pourquoi
 *
 * Le Conseil a tranché la question du ton le 2026-08-18, et son constat est que ce qui fait
 * « machine » dans ce produit n'est PAS le vocabulaire — il est déjà réglé, `AGENT_STYLE_BLOCK`
 * dit « collègue, phrases courtes » et les textes en dur sont écrits à la main. C'est la
 * **répétition littérale** : un humain ne redit jamais exactement la même phrase, mot pour mot,
 * la dixième fois qu'on lui dit bonjour.
 *
 * Corriger cela ici coûte **zéro token** et l'effet est **garanti à 100 %**, là où une consigne
 * de style ajoutée au prompt serait repayée à chaque étape (budget ≈ 3 100 tokens/message,
 * ~100 000/jour) pour un résultat seulement probable.
 *
 * ⚠️ **Et surtout : demander au MODÈLE de varier ses formules dégraderait le garde-fou
 * anti-mensonge.** `claim-reconciliation.ts` détecte l'accompli non appuyé par un appel d'outil
 * au moyen d'une liste FERMÉE de six motifs (« c'est fait », « j'ai envoyé », « je viens de »,
 * voix passive, « est prêt », « est à jour »). Un modèle invité à varier écrirait « voilà, ton
 * document t'attend » — hors motif, donc non requalifié. La variation doit donc rester du CÔTÉ
 * DU CODE, où elle est bornée et vérifiable.
 *
 * ## Pourquoi DÉTERMINISTE et non `Math.random()`
 *
 * Ce dépôt vient de corriger un journal qui tirait au sort les clés qu'il conservait : deux
 * occurrences du même incident produisaient deux lignes différentes, et le champ dont on avait
 * besoin manquait une fois sur deux. Le même piège s'applique ici — un test ne peut pas
 * verrouiller une réponse aléatoire, et un diagnostic ne peut pas la rejouer.
 *
 * La graine est l'horodatage du message Slack (`ts`), qui est unique par message et stable :
 * la même personne voit des formulations différentes d'un message à l'autre, et le même message
 * rejoué donne exactement la même réponse.
 *
 * ## Ce qui ne doit JAMAIS varier
 *
 * - **La détresse.** Sa formulation est le fruit d'un arbitrage explicite, chaque phrase y est
 *   pesée, et la variation n'y apporterait rien qu'un risque.
 * - **Tout texte portant une donnée vérifiable** (« 3 messages effacés ») : ce qui compte y est
 *   le fait, pas la tournure.
 */

/**
 * FNV-1a 32 bits. Choisi pour trois raisons et aucune n'est cryptographique : il tient en cinq
 * lignes, il est stable d'une version de Node à l'autre (contrairement à un hash de bibliothèque
 * qui pourrait changer), et il disperse correctement des chaînes qui ne diffèrent que par leurs
 * derniers caractères — exactement la forme d'un `ts` Slack (`1700000000.000100`).
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Choisit une variante à partir d'une graine.
 *
 * Sans graine — appel hors Slack, test, workflow — on rend la PREMIÈRE : c'est la formulation
 * canonique, celle que les tests et la documentation citent. Un repli aléatoire rendrait le
 * comportement hors Slack imprévisible pour rien.
 */
export function pickVariant(variants: readonly string[], seed?: string): string {
  if (variants.length === 0) throw new Error('pickVariant exige au moins une variante');
  const first = variants[0]!;
  if (!seed || variants.length === 1) return first;
  return variants[fnv1a(seed) % variants.length] ?? first;
}
