/**
 * FORME du message entrant — deux court-circuits déterministes, zéro appel LLM.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi ce module existe
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Troisième membre de la famille `greeting.ts` / `distress.ts`, et pour la même raison : il
 * existe des messages dont on sait, SANS modèle, qu'aucun modèle n'en tirera rien. Les
 * envoyer à Groq coûte ≈ 5 000 tokens — ≈ 5 % d'un quota qui se compte à la JOURNÉE
 * (100 000 tokens/jour, ≈ 19 messages) — pour obtenir une reformulation de « que puis-je
 * faire pour toi ? » que ce module rend gratuitement.
 *
 * Deux formes sont traitées ici, et elles n'ont en commun que d'être décidables sur le seul
 * TEXTE, sans contexte, sans état et sans réseau :
 *
 *  1. **Aucun contenu textuel** — emojis seuls, ponctuation seule, kaomoji. Le modèle n'a
 *     rien à traiter ; il redemandera ce que la personne veut, ce que la réponse ci-dessous
 *     fait pour zéro token.
 *  2. **Trop long** — au-delà de `MAX_USER_INPUT_LENGTH`. Voir le long commentaire de
 *     `TOO_LONG_REPLY` : ce cas EXISTAIT déjà, mais il ressortait en refus de sécurité.
 *
 * ⚠️ Le critère du cas 1 est « lettre ou chiffre UNICODE », jamais `[a-z0-9]`. Un filtre
 * latin rendrait le bot muet devant « مرحبا », « привет » ou « 你好 » — il classerait un
 * message parfaitement sensé comme vide, et la personne n'aurait aucune réponse. Le faux
 * positif est ici bien plus coûteux que le faux négatif : manquer un emoji coûte des tokens,
 * manquer une phrase en arabe coûte un utilisateur.
 */

/**
 * Le message ne porte-t-il AUCUNE lettre ni AUCUN chiffre ?
 *
 * `\p{L}` couvre toutes les lettres Unicode (latines, arabes, cyrilliques, han, kana, grec…),
 * `\p{N}` tous les chiffres. Tout le reste — emojis, ponctuation, symboles, espaces — ne
 * porte pas de demande exploitable.
 *
 * ⚠️ Ce motif ne va JAMAIS dans un schéma de tool. Zod est épinglé à `3.25.76` et le parseur
 * de schémas du Vercel AI SDK casse sur les classes Unicode (`\p{L}`) — piège documenté dans
 * `CLAUDE.md`. Ici on est dans du code applicatif ordinaire, la contrainte ne s'applique pas.
 */
const CARRIES_MEANING = /[\p{L}\p{N}]/u;

export function hasNoTextualContent(text: string | undefined | null): boolean {
  return !CARRIES_MEANING.test(text ?? '');
}

/**
 * Réponse à un message sans contenu textuel.
 *
 * Elle ne salue PAS — `GREETING_REPLY` commence par « Bonjour », ce qui serait absurde en
 * réponse à un « 👍 » posé au milieu d'un fil déjà engagé. Elle constate et relance, en une
 * phrase, sans question ouverte : la personne va enchaîner de toute façon, et chaque tour
 * supplémentaire coûte un vrai appel LLM.
 *
 * Elle RÉPOND plutôt que de se taire. Le silence est le pire symptôme de ce produit — il ne
 * se distingue pas d'une panne, et ce dépôt a déjà passé des heures à chercher pourquoi le
 * bot semblait mort. Ici le coût d'une réponse est nul ; il n'y a aucune raison de le payer
 * en ambiguïté.
 */
export const CONTENT_FREE_REPLY =
  "Je n'ai rien à traiter dans ce message. Dis-moi en quelques mots ce dont tu as besoin.";

/**
 * Variantes — voir `shared/reply-variants.ts`. La première est la canonique.
 *
 * Toutes disent la même chose : « il n'y a rien à traiter » puis « dis-moi ce que tu veux ».
 * Ce qui varie est la tournure, jamais le contenu — une variante qui laisserait tomber la
 * seconde moitié transformerait une orientation en constat, et laisserait la personne sans
 * rien à faire.
 */
export const CONTENT_FREE_REPLIES: readonly string[] = [
  CONTENT_FREE_REPLY,
  "Il n'y a rien à lire là-dedans pour moi. Dis-moi en deux mots ce que tu attends.",
  "Je ne vois aucun texte à traiter. Qu'est-ce que je peux faire pour toi ?",
];

/**
 * Réponse à un message qui dépasse `MAX_USER_INPUT_LENGTH`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Le défaut corrigé : un copier-coller n'est pas une attaque
 * ════════════════════════════════════════════════════════════════════════════
 *
 * La borne de 8 000 caractères existait déjà, mais elle vivait dans `wrapUserInput`
 * (`llm-guardrail.ts`) et levait une `SecurityBlockError`. Or `userFacingFailure` traduit
 * TOUTE `SecurityBlockError` en `NEUTRAL_REFUSAL` : « Je ne peux pas répondre à cette
 * demande. Reformule-la autrement. »
 *
 * Ce texte est délibérément MUET sur la règle touchée — c'est le bon contrat pour une
 * tentative d'injection, où nommer la sonde qui a porté renseigne l'attaquant. C'est le
 * mauvais contrat pour quelqu'un qui colle un compte rendu de réunion : il reçoit un refus
 * de POLITIQUE là où le problème est une TAILLE, et « reformule-la autrement » ne lui dit
 * pas que reformuler plus court est précisément la solution. Le comportement observable
 * était donc « le bot refuse mes documents » sans aucun moyen de le savoir.
 *
 * La longueur n'est pas une information adverse : la borne est publique, un attaquant la
 * mesure en trois essais, et la dire épargne à tout le monde la seule vraie victime du
 * silence — la personne de bonne foi.
 *
 * ⚠️ Le contrôle est déplacé EN AMONT, dans le handler, pas dupliqué. La borne de
 * `wrapUserInput` reste en place et reste la garantie de dernier recours : elle protège les
 * appelants qui ne passent pas par le handler Slack (route HTTP, workflow, playground).
 */
export const TOO_LONG_REPLY =
  'Ton message est trop long pour que je le traite en une fois. Résume-le, ou dis-moi ' +
  "seulement ce que tu attends de moi et je m'en occupe.";

/**
 * Variantes — voir `shared/reply-variants.ts`. La première est la canonique.
 *
 * Chacune garde les deux informations qui comptent : c'est la LONGUEUR qui bloque (et non une
 * règle de politique — c'était tout l'objet de ce court-circuit), et raccourcir suffit.
 */
export const TOO_LONG_REPLIES: readonly string[] = [
  TOO_LONG_REPLY,
  "C'est trop long pour moi d'un seul bloc. Garde l'essentiel, ou dis-moi juste ce que tu " +
    'attends et je me débrouille.',
  'Je cale sur la longueur. Envoie-moi la version courte — ce que tu veux obtenir suffit.',
];
