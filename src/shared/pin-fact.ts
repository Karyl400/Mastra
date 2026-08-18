/**
 * Reconnaissance d'une demande de MÉMORISATION — court-circuit déterministe, zéro appel LLM.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Le défaut : « souviens-toi que… » n'épinglait rien
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `TODO.md` le recense depuis le 2026-08-13 : le tour était traité comme n'importe quel
 * autre, donc soumis au TTL de 60 minutes et évincible par `selectWindow` dès que la
 * fenêtre de 1 600 tokens se remplit. **Le modèle promettait pourtant de s'en souvenir** —
 * c'est le défaut central de ce dépôt appliqué à la mémoire : la même phrase qu'il ait
 * retenu ou non.
 *
 * Et c'est le premier facteur de REDEMANDES inutiles, la chose qui distingue le plus
 * nettement ce bot d'un collègue : redemander une information qu'on vient de donner.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi du code, et pas un tool exposé au modèle
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Mêmes trois raisons que `forget.ts` : un schéma repayé à chaque aller-retour sur un
 * budget de ≈ 19 messages/jour, un comportement PROBABILISTE là où la personne attend une
 * garantie, et une écriture pilotée par un texte arbitraire. Le geste est déterministe.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * L'asymétrie : entre `greeting` et `forget`
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Un faux positif ÉCRIT une ligne bornée, évincible et effaçable — bien moins grave qu'un
 * effacement, plus gênant qu'un simple bouton. On exige donc une AMORCE EXPLICITE (le
 * message doit littéralement contenir « souviens-toi que », « retiens que »…), et rien de
 * plus : pas d'analyse de position, l'amorce EST l'acte de langage.
 *
 * ⚠️ « n'oublie pas que… » est une amorce VALIDE, et ce n'est pas une contradiction avec
 * `forget.ts` : celui-ci exige en plus un OBJET désignant la mémoire (« ce que je t'ai
 * dit », « notre conversation »), qu'une phrase comme « n'oublie pas que je suis en congé
 * vendredi » ne contient pas. Les deux prédicats ne peuvent donc pas se disputer le même
 * message — et si cela arrivait, l'effacement est évalué EN PREMIER dans le handler.
 */

import { normalizeIntentText } from './intent-text';

/**
 * Amorces, sous forme normalisée (minuscules, sans accent, apostrophes en espaces).
 *
 * FERMÉE et courte. Chacune doit être suivie du fait à retenir — c'est ce qui rend
 * l'extraction possible sans modèle : le fait est littéralement le reste de la phrase.
 */
const PIN_MARKERS: readonly string[] = [
  'souviens toi que',
  'souviens toi de',
  'rappelle toi que',
  'retiens que',
  'note que',
  'n oublie pas que',
  'garde en tete que',
  'remember that',
];

/**
 * Nombre maximal de faits conservés par personne.
 *
 * Ils entrent dans le préambule système à CHAQUE tour : cinq faits de 120 caractères
 * plafonnent la dépense à ≈ 170 tokens par aller-retour, ce qui est déjà le poste le plus
 * cher du préambule. Au-delà, on ne mémorise plus, on archive — et ce n'est pas ce que
 * quelqu'un demande en disant « souviens-toi que ».
 */
export const MAX_PINNED_FACTS = 5;

/**
 * Longueur maximale d'un fait, en caractères.
 *
 * Tronqué et non refusé : un fait coupé reste utile, un fait refusé silencieusement serait
 * une promesse non tenue de plus. La troncature est signalée par une ellipse, pour que le
 * modèle ne présente pas une phrase amputée comme complète.
 */
export const MAX_PINNED_FACT_CHARS = 120;

/** Borne du message entier. Au-delà, ce n'est plus une note, c'est un paragraphe. */
const MAX_PIN_MESSAGE_LENGTH = 300;

/**
 * Normalisation D'APPARIEMENT uniquement — jamais de stockage.
 *
 * Le fait est conservé dans son texte D'ORIGINE : c'est ce que la personne a écrit, et le
 * rendre au modèle sans accent ni majuscule dégraderait une information qu'on a
 * précisément promis de garder.
 */

/**
 * Extrait le fait à retenir, ou `null` si le message n'en demande aucun.
 *
 * ── Pourquoi l'extraction est faite sur le texte D'ORIGINE ──────────────────
 * L'appariement se fait sur la forme normalisée (pour tolérer accents et ponctuation),
 * mais le découpage doit rendre le texte tel qu'il a été écrit. On aligne donc les deux en
 * comptant les MOTS : la position de l'amorce en mots normalisés est la même que dans le
 * texte d'origine, parce que la normalisation ne fusionne ni ne supprime aucun mot — elle
 * ne fait que remplacer des caractères par des espaces, puis réduire les espaces.
 *
 * ⚠️ Une exception à cela : l'apostrophe. « n'oublie » devient deux mots (`n oublie`), et
 * un mot d'origine peut donc en valoir deux normalisés. L'alignement se fait pour cette
 * raison sur le texte d'origine RE-DÉCOUPÉ de la même façon, pas sur un simple `split(' ')`.
 */
export function extractPinnedFact(text: string | undefined | null): string | null {
  const raw = (text ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_PIN_MESSAGE_LENGTH) return null;

  const normalized = normalizeIntentText(raw);

  const marker = PIN_MARKERS.find((candidate) => normalized.includes(`${candidate} `));
  if (!marker) return null;

  // Nombre de mots à sauter : ceux de l'amorce, plus tout ce qui la précède.
  const markerWordCount = marker.split(' ').length;
  const before = normalized.slice(0, normalized.indexOf(marker));
  const skip = (before.trim() === '' ? 0 : before.trim().split(' ').length) + markerWordCount;

  // Le texte d'origine découpé SUR LES MÊMES FRONTIÈRES que la normalisation : toute
  // ponctuation est un séparateur, exactement comme dans `normalize`.
  const originalWords = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const fact = originalWords.slice(skip).join(' ').trim();

  if (fact.length === 0) return null;

  return fact.length > MAX_PINNED_FACT_CHARS
    ? `${fact.slice(0, MAX_PINNED_FACT_CHARS - 1).trimEnd()}…`
    : fact;
}

/**
 * Réponse rendue quand le fait est retenu.
 *
 * Elle CITE le fait, et ce n'est pas décoratif : c'est la seule façon pour la personne de
 * vérifier que ce qui a été retenu correspond à ce qu'elle voulait dire. Une extraction
 * déterministe se trompe de découpage sans le savoir ; la restitution le rend visible.
 */
export function pinnedFactReply(fact: string): string {
  return `C'est noté : « ${fact} ». Je m'en souviendrai jusqu'à ce que tu me demandes d'oublier.`;
}

/**
 * Réponse rendue quand la mémoire longue est indisponible.
 *
 * ⚠️ Ne JAMAIS retomber sur `pinnedFactReply` ici — même règle que pour l'effacement.
 * Promettre de se souvenir sans pouvoir écrire, c'est exactement le défaut qu'on corrige.
 */
export const PIN_FAILED_REPLY =
  "Je n'ai pas réussi à noter ça — ma mémoire est indisponible à l'instant. " +
  'Redis-le-moi dans un moment.';
